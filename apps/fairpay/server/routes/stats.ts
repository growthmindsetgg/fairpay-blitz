// FairEats: the dashboard's numbers (Overview). Revenue, orders, covers, top dishes, busy hours,
// how long tables take and cancellations, for today, the last 7 or 30 days, or this month, all
// counted in SQL in India time, like the money view. Mounted by restaurantRoutes.
//
// Who sees what mirrors what each role can already read:
//  * any staff (owner, manager, chef, waiter) reads GET /restaurants/:id/orders, every order's total
//    and items included, so the order numbers here are theirs too; same 401 / 404 / 403 answers;
//  * how the money arrived (public or confidential, and tips) comes from the payments table, which
//    only the owner reads (routes/money.ts), so `money` is null for everyone else.

import { Hono } from "hono"
import type { RestaurantStats, StatsRange } from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { DEMO_ORDER_RE, expireStaleOrders, requireRole, type RestaurantRow } from "../faireats.js"
import { HttpError } from "../http.js"
import { IST_OFFSET, startOfDayIst, TIP_SQL } from "./money.js"

const DAY = 86_400_000
const HOUR = 3_600_000
const RANGES: StatsRange[] = ["today", "7d", "30d", "mtd"]
const TOP_DISHES = 5
/** Money has reached the restaurant for these statuses (as the Overview always counted it). */
const PAID_SQL = "o.status IN ('paid', 'cooking', 'ready', 'served')"

/** First day of this month in India, as unix ms. */
export function startOfMonthIst(now: number) {
    const d = new Date(now + IST_OFFSET)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET
}

/** The instants a range counts: from the start of its first India-time day up to now. */
export function statsWindow(range: StatsRange, now: number): { from: number; to: number } {
    const today = startOfDayIst(now)
    const from =
        range === "today" ? today : range === "7d" ? today - 6 * DAY : range === "30d" ? today - 29 * DAY : startOfMonthIst(now)
    return { from, to: now }
}

export function parseRange(v: string | undefined): StatsRange {
    if (v === undefined || v === "") return "today"
    if (!RANGES.includes(v as StatsRange)) throw new HttpError(400, `range must be one of ${RANGES.join(", ")}.`)
    return v as StatsRange
}

/** India-time day number of an instant (days since 1970-01-01 IST). */
const istDay = (ms: number) => Math.floor((ms + IST_OFFSET) / DAY)

/** NUMERIC and BIGINT arrive as strings from postgres.js. */
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export async function loadStats(db: Db, r: RestaurantRow, range: StatsRange, now: number, withMoney: boolean): Promise<RestaurantStats> {
    const { from, to } = statsWindow(range, now)
    // Sample orders were marked paid without a payment (server/seed.ts): not takings.
    const demo = r.is_demo ? ` AND o.id !~ '${DEMO_ORDER_RE.source.replace(/'/g, "''")}'` : ""
    const where = `o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at <= $3${demo}`
    const params = [r.id, from, to]
    // Integer maths on BIGINT: shift to India time, then whole days and hours.
    const dayOf = `((o.created_at + ${IST_OFFSET}) / ${DAY})`
    const hourOf = `(((o.created_at + ${IST_OFFSET}) % ${DAY}) / ${HOUR})`

    const [totals, dishes, hours, days, tables, money] = await Promise.all([
        db.one<Record<string, unknown>>(
            `SELECT COUNT(*)::int AS placed,
                    COUNT(*) FILTER (WHERE ${PAID_SQL})::int AS orders,
                    COALESCE(SUM(o.total) FILTER (WHERE ${PAID_SQL}), 0)::bigint AS revenue,
                    COALESCE(ROUND(SUM(o.total) FILTER (WHERE ${PAID_SQL})::numeric / NULLIF(COUNT(*) FILTER (WHERE ${PAID_SQL}), 0)), 0)::bigint AS average,
                    COALESCE(SUM(o.guests) FILTER (WHERE ${PAID_SQL}), 0)::int AS guests,
                    COUNT(*) FILTER (WHERE o.status = 'awaiting_payment')::int AS awaiting,
                    COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
                    COALESCE(SUM(o.total) FILTER (WHERE o.status = 'cancelled'), 0)::bigint AS cancelled_value,
                    ROUND(AVG((o.paid_at - o.created_at) / 60000.0) FILTER (WHERE ${PAID_SQL} AND o.paid_at >= o.created_at))::int AS to_paid,
                    ROUND(AVG((o.served_at - o.created_at) / 60000.0) FILTER (WHERE o.status = 'served' AND o.served_at >= o.created_at))::int AS to_served,
                    COUNT(*) FILTER (WHERE o.status = 'served')::int AS served,
                    COUNT(*) FILTER (WHERE ${PAID_SQL} AND o.table_id IS NOT NULL)::int AS seated
             FROM orders o WHERE ${where}`,
            params
        ),
        // The menu's current name when the dish still exists; the name on the order otherwise.
        db.query<{ item_id: string; name: string; qty: number; revenue: number }>(
            `SELECT i.item_id, COALESCE(MAX(m.name), MAX(i.name)) AS name, SUM(i.qty)::int AS qty, SUM(i.unit_price * i.qty)::bigint AS revenue
             FROM order_items i JOIN orders o ON o.id = i.order_id
             LEFT JOIN menu_items m ON m.id = i.item_id AND m.restaurant_id = o.restaurant_id
             WHERE ${where} AND ${PAID_SQL}
             GROUP BY i.item_id ORDER BY qty DESC, revenue DESC, name LIMIT ${TOP_DISHES}`,
            params
        ),
        db.query<{ h: number; n: number }>(`SELECT ${hourOf}::int AS h, COUNT(*)::int AS n FROM orders o WHERE ${where} AND ${PAID_SQL} GROUP BY 1`, params),
        db.query<{ d: number; n: number; revenue: number }>(
            `SELECT ${dayOf}::int AS d, COUNT(*)::int AS n, SUM(o.total)::bigint AS revenue FROM orders o WHERE ${where} AND ${PAID_SQL} GROUP BY 1`,
            params
        ),
        db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurant_tables WHERE restaurant_id = $1", [r.id]),
        withMoney
            ? db.one<Record<string, unknown>>(
                  `WITH x AS (
                       SELECT p.kind, p.amount, ${TIP_SQL} AS tip
                       FROM payments p JOIN order_shares s ON s.id = p.target_id JOIN orders o ON o.id = s.order_id
                       WHERE p.target_kind = 'order' AND ${where} AND ${PAID_SQL})
                   SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'public'), 0)::bigint AS public,
                          COALESCE(SUM(amount) FILTER (WHERE kind = 'private'), 0)::bigint AS private,
                          COALESCE(SUM(tip), 0)::bigint AS tips,
                          COUNT(*)::int AS payments
                   FROM x`,
                  params
              )
            : Promise.resolve(undefined)
    ])

    const t = totals ?? {}
    const byHour = Array.from({ length: 24 }, () => 0)
    for (const h of hours) byHour[Number(h.h)] = Number(h.n)
    const byDay = new Map(days.map((d) => [Number(d.d), d]))
    const dayList: RestaurantStats["days"] = []
    for (let d = istDay(from); d <= istDay(to); d++) {
        const start = d * DAY - IST_OFFSET
        const row = byDay.get(d)
        dayList.push({ day: new Date(d * DAY).toISOString().slice(0, 10), start, revenue: num(row?.revenue), orders: num(row?.n) })
    }
    const tableCount = num(tables?.n)

    return {
        range,
        from,
        to,
        revenue: num(t.revenue),
        orders: num(t.orders),
        placed: num(t.placed),
        awaitingPayment: num(t.awaiting),
        averageOrder: num(t.average),
        guests: num(t.guests),
        cancelled: { count: num(t.cancelled), value: num(t.cancelled_value) },
        topDishes: dishes.map((d) => ({ itemId: d.item_id, name: d.name, qty: Number(d.qty), revenue: Number(d.revenue) })),
        hours: byHour,
        days: dayList,
        turnover: {
            toPaidMinutes: numOrNull(t.to_paid),
            toServedMinutes: numOrNull(t.to_served),
            served: num(t.served),
            turnsPerTable: tableCount > 0 ? Math.round((num(t.seated) / tableCount) * 10) / 10 : null
        },
        money: money
            ? { public: num(money.public), confidential: num(money.private), tips: num(money.tips), payments: num(money.payments) }
            : null
    }
}

export function statsRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()

    app.get("/restaurants/:id/stats", async (c) => {
        const me = requireWallet(c)
        const { restaurant, role } = await requireRole(db, c.req.param("id"), me, ["owner", "manager", "chef", "waiter"])
        const range = parseRange(c.req.query("range"))
        const now = deps.now()
        // As the orders list does, so an order given up unpaid counts as cancelled straight away.
        await expireStaleOrders(db, restaurant.id, now)
        return c.json(await loadStats(db, restaurant, range, now, role === "owner"))
    })

    return app
}
