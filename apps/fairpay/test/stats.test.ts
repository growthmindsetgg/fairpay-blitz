// The dashboard's stats (server/routes/stats.ts): who may read them and which fields, the maths
// (revenue, average order, covers, tips, top dishes, hours, days, turnover, cancellations), India-time
// day boundaries and the ranges.

import { beforeEach, describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { Restaurant, RestaurantStats, SettleResult, StatsRange, Wallet } from "../shared/types.js"
import { newOrderRef, newToken } from "../server/ids.js"
import { startOfDayIst } from "../server/routes/money.js"
import { parseRange, startOfMonthIst, statsWindow } from "../server/routes/stats.js"
import { DENOMINATION, fakeChain, makeTestApp, paidOnChain, txHash, type TestApp } from "./helpers.js"

const U = 1_000_000
const MIN = 60_000
const DAY = 86_400_000
const OWNER = "0x1111111111111111111111111111111111111111" as Wallet
const MANAGER = "0x2222222222222222222222222222222222222222" as Wallet
const CHEF = "0x3333333333333333333333333333333333333333" as Wallet
const WAITER = "0x4444444444444444444444444444444444444444" as Wallet
const GUEST = "0x5555555555555555555555555555555555555555" as Wallet
const OUTSIDER = "0x6666666666666666666666666666666666666666" as Wallet
/** The fixed test clock: Saturday 31 Oct 2026, 12:00 in India. */
const T0 = Date.parse("2026-10-31T12:00:00+05:30")

type Ctx = TestApp & { clock: { t: number }; cookies: Record<string, string>; r: Restaurant; tables: string[] }

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    const body = await r.json()
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`)
    return body as T
}

async function setup(): Promise<Ctx> {
    const clock = { t: T0 }
    const t = await makeTestApp({ chain: fakeChain({ merchants: [OWNER] }), now: () => clock.t })
    const cookies: Record<string, string> = {}
    for (const [name, w] of Object.entries({ OWNER, MANAGER, CHEF, WAITER, GUEST, OUTSIDER })) cookies[name] = await t.signIn(w)
    const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: cookies.OWNER, body: { name: "Spice Route", state: "Karnataka", tables: 4 } }), 201)
    for (const [w, role] of [[MANAGER, "manager"], [CHEF, "chef"], [WAITER, "waiter"]] as const) {
        await json(t.call("POST", `/api/restaurants/${r.id}/staff`, { cookie: cookies.OWNER, body: { wallet: w, role, displayName: role } }), 201)
    }
    const tables = (await t.deps.db.query<{ id: string; label: string }>("SELECT id, label FROM restaurant_tables WHERE restaurant_id = $1", [r.id]))
        .sort((a, b) => Number(a.label) - Number(b.label))
        .map((x) => x.id)
    return { ...t, clock, cookies, r, tables }
}

let seq = 0

type OrderSpec = {
    at: number
    status: "awaiting_payment" | "paid" | "cooking" | "ready" | "served" | "cancelled"
    total?: number
    guests?: number
    table?: number | null
    paidAfter?: number
    servedAfter?: number
    items?: { id: string; name: string; price: number; qty: number }[]
    id?: string
}

/**
 * An order straight into the database. Its total is the items' sum unless `total` is given (then
 * one item at that price), so subtotal = total and no GST, which keeps the maths easy to read.
 */
async function makeOrder(t: Ctx, o: OrderSpec) {
    const id = o.id ?? `o_stats${++seq}`
    const items = o.items ?? [{ id: "m_plain", name: "Plain", price: o.total ?? 10 * U, qty: 1 }]
    const total = items.reduce((s, i) => s + i.price * i.qty, 0)
    const table = o.table === null ? null : t.tables[(o.table ?? 1) - 1]
    await t.deps.db.query(
        `INSERT INTO orders (id, restaurant_id, table_id, guests, payment_mode, status, subtotal, total, gst_rate_bps, share_token, invoice_token,
                             created_at, paid_at, served_at, payout_wallet)
         VALUES ($1, $2, $3, $4, 'one_pays', $5, $6, $6, 0, $7, $8, $9, $10, $11, $12)`,
        [
            id,
            t.r.id,
            table,
            o.guests ?? 2,
            o.status,
            total,
            newToken(),
            newToken(),
            o.at,
            o.paidAfter === undefined ? null : o.at + o.paidAfter,
            o.servedAfter === undefined ? null : o.at + o.servedAfter,
            OWNER
        ]
    )
    for (const i of items) {
        await t.deps.db.query("INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest, sac) VALUES ($1, $2, $3, $4, $5, 1, '996331')", [
            id,
            i.id,
            i.name,
            i.price,
            i.qty
        ])
    }
    return id
}

/** An order awaiting payment with one share, to be paid through the real settle route. */
async function makeOwedOrder(t: Ctx, amount: number) {
    const orderId = `o_stats${++seq}`
    const token = newToken()
    await t.deps.db.query(
        `INSERT INTO orders (id, restaurant_id, table_id, guests, payment_mode, status, subtotal, total, gst_rate_bps, share_token, invoice_token, created_at, payout_wallet)
         VALUES ($1, $2, $3, 3, 'one_pays', 'awaiting_payment', $4, $4, 0, $5, $6, $7, $8)`,
        [orderId, t.r.id, t.tables[1], amount, token, newToken(), t.clock.t, OWNER]
    )
    await t.deps.db.query("INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest, sac) VALUES ($1, 'm_thali', 'Thali', $2, 1, 1, '996331')", [
        orderId,
        amount
    ])
    const shareId = `s_stats${++seq}`
    const { orderRef, secret } = newOrderRef(orderId, shareId)
    await t.deps.db.query(
        "INSERT INTO order_shares (id, order_id, guest, label, amount, status, order_ref, secret) VALUES ($1, $2, 1, 'Whole table', $3, 'owed', $4, $5)",
        [shareId, orderId, amount, orderRef, secret]
    )
    return { orderId, token, share: { id: shareId, orderRef } }
}

async function pay(t: Ctx, o: { token: string; share: { id: string; orderRef: Hex } }, amount: number, payer?: Wallet) {
    const h = txHash()
    t.chain.verifyResult = paidOnChain({ txHash: h, amount, payer, orderRef: o.share.orderRef, recipient: OWNER })
    const res = await json<SettleResult>(t.call("POST", `/api/pay/order/${o.share.id}/settle?t=${o.token}`, { body: { txHash: h } }))
    expect(res.status).toBe("credited")
}

const stats = (t: Ctx, range?: StatsRange | string, cookie = t.cookies.OWNER) =>
    json<RestaurantStats>(t.call("GET", `/api/restaurants/${t.r.id}/stats${range ? `?range=${range}` : ""}`, { cookie }))

let t: Ctx
beforeEach(async () => {
    t = await setup()
})

describe("ranges in India time", () => {
    it("starts today at midnight in India, and the 7- and 30-day ranges include today", () => {
        const today = Date.parse("2026-10-31T00:00:00+05:30")
        expect(statsWindow("today", T0)).toEqual({ from: today, to: T0 })
        expect(statsWindow("7d", T0).from).toBe(Date.parse("2026-10-25T00:00:00+05:30"))
        expect(statsWindow("30d", T0).from).toBe(Date.parse("2026-10-02T00:00:00+05:30"))
        expect(statsWindow("mtd", T0).from).toBe(Date.parse("2026-10-01T00:00:00+05:30"))
    })

    it("uses India's date, not UTC's, around midnight and month ends", () => {
        // 1 Nov 00:10 in India is still 31 Oct in UTC.
        const early = Date.parse("2026-11-01T00:10:00+05:30")
        expect(startOfDayIst(early)).toBe(Date.parse("2026-11-01T00:00:00+05:30"))
        expect(startOfMonthIst(early)).toBe(Date.parse("2026-11-01T00:00:00+05:30"))
        // 31 Oct 23:50 in India is 18:20 UTC: still October.
        expect(startOfMonthIst(Date.parse("2026-10-31T23:50:00+05:30"))).toBe(Date.parse("2026-10-01T00:00:00+05:30"))
        // A month that starts today: the range is one day.
        expect(statsWindow("mtd", early).from).toBe(statsWindow("today", early).from)
        // Across a year end.
        expect(startOfMonthIst(Date.parse("2027-01-01T03:00:00+05:30"))).toBe(Date.parse("2027-01-01T00:00:00+05:30"))
    })

    it("accepts only the four ranges, today by default", () => {
        expect(parseRange(undefined)).toBe("today")
        expect(parseRange("")).toBe("today")
        for (const r of ["today", "7d", "30d", "mtd"]) expect(parseRange(r)).toBe(r)
        for (const bad of ["1d", "90d", "TODAY", "all", "7d;drop"]) expect(() => parseRange(bad)).toThrow(/range must be/)
    })
})

describe("who can read the stats", () => {
    it("answers any staff, like the orders list: 401 signed out, 403 for others, 404 for an unknown id", async () => {
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/stats`)).status).toBe(401)
        for (const who of ["GUEST", "OUTSIDER"]) {
            const res = await t.call("GET", `/api/restaurants/${t.r.id}/stats`, { cookie: t.cookies[who] })
            expect(res.status, who).toBe(403)
            // The same answer the orders list gives them.
            const orders = await t.call("GET", `/api/restaurants/${t.r.id}/orders`, { cookie: t.cookies[who] })
            expect(orders.status).toBe(403)
        }
        expect((await t.call("GET", "/api/restaurants/r_nope/stats", { cookie: t.cookies.OWNER })).status).toBe(404)
        for (const who of ["OWNER", "MANAGER", "CHEF", "WAITER"]) expect((await t.call("GET", `/api/restaurants/${t.r.id}/stats`, { cookie: t.cookies[who] })).status, who).toBe(200)
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/stats?range=forever`, { cookie: t.cookies.OWNER })).status).toBe(400)
    })

    it("gives how the money arrived (public, confidential, tips) to the owner only", async () => {
        const o = await makeOwedOrder(t, 12_600_000)
        for (let i = 0; i < 3; i++) await pay(t, o, DENOMINATION)

        const owner = await stats(t)
        expect(owner.money).toEqual({ public: 0, confidential: 15 * U, tips: 2_400_000, payments: 3 })
        for (const who of ["MANAGER", "CHEF", "WAITER"]) {
            const s = await stats(t, "today", t.cookies[who])
            expect(s.money, who).toBeNull()
            // Everything else is the same as the owner's.
            expect({ ...s, money: owner.money }).toEqual(owner)
        }
    })
})

describe("the numbers", () => {
    it("counts revenue, orders, average order and covers from paid orders only", async () => {
        await makeOrder(t, { at: T0 - 60 * MIN, status: "served", total: 20 * U, guests: 4, paidAfter: 5 * MIN, servedAfter: 50 * MIN })
        await makeOrder(t, { at: T0 - 30 * MIN, status: "cooking", total: 10 * U, guests: 2, paidAfter: 3 * MIN })
        await makeOrder(t, { at: T0 - 20 * MIN, status: "ready", total: 5 * U, guests: 1, paidAfter: 1 * MIN })
        await makeOrder(t, { at: T0 - 10 * MIN, status: "paid", total: 10_000_001, guests: 2, paidAfter: 3 * MIN })
        // Not money: awaiting payment and cancelled.
        await makeOrder(t, { at: T0 - 5 * MIN, status: "awaiting_payment", total: 50 * U, guests: 6 })
        await makeOrder(t, { at: T0 - 40 * MIN, status: "cancelled", total: 8 * U, guests: 3 })

        const s = await stats(t)
        expect(s.range).toBe("today")
        expect(s.revenue).toBe(45_000_001)
        expect(s.orders).toBe(4)
        expect(s.placed).toBe(6)
        expect(s.awaitingPayment).toBe(1)
        // 45.000001 / 4 = 11.25000025, rounded to a micro-USDC.
        expect(s.averageOrder).toBe(11_250_000)
        expect(s.guests).toBe(9)
        expect(s.cancelled).toEqual({ count: 1, value: 8 * U })
        // (5 + 3 + 1 + 3) / 4 = 3 minutes to pay. The kitchen runs by the clock, so reading the
        // stats served the cooking order (paid 3 min after placing, cooked 10, served 1 later: 14)
        // and the ready one (paid after 1, served a minute later: 2) as well: (50 + 14 + 2) / 3 = 22.
        expect(s.turnover).toEqual({ toPaidMinutes: 3, toServedMinutes: 22, served: 3, turnsPerTable: 1 })
    })

    it("is all zeros, with 24 empty hours and one day, for a quiet day", async () => {
        const s = await stats(t)
        expect(s).toMatchObject({ revenue: 0, orders: 0, placed: 0, averageOrder: 0, guests: 0, cancelled: { count: 0, value: 0 }, topDishes: [] })
        expect(s.hours).toEqual(Array.from({ length: 24 }, () => 0))
        expect(s.days).toEqual([{ day: "2026-10-31", start: Date.parse("2026-10-31T00:00:00+05:30"), revenue: 0, orders: 0 }])
        expect(s.turnover).toEqual({ toPaidMinutes: null, toServedMinutes: null, served: 0, turnsPerTable: 0 })
        expect(s.money).toEqual({ public: 0, confidential: 0, tips: 0, payments: 0 })
    })

    it("splits public and confidential payments and keeps tips apart from revenue", async () => {
        const pub = await makeOwedOrder(t, 7 * U)
        await pay(t, pub, 7 * U, GUEST)
        const priv = await makeOwedOrder(t, 12_600_000)
        for (let i = 0; i < 3; i++) await pay(t, priv, DENOMINATION)

        const s = await stats(t)
        // Revenue is what the orders cost; the 2.40 tip on the last note is not revenue.
        expect(s.revenue).toBe(19_600_000)
        expect(s.orders).toBe(2)
        expect(s.averageOrder).toBe(9_800_000)
        expect(s.money).toEqual({ public: 7 * U, confidential: 15 * U, tips: 2_400_000, payments: 4 })
    })

    it("puts an order in the India-time day and hour it was placed", async () => {
        const today = startOfDayIst(T0)
        // Yesterday 23:59 India time: not today, but in the last 7 days.
        await makeOrder(t, { at: today - MIN, status: "paid", total: 3 * U, paidAfter: 0 })
        // Today 00:00 exactly, and 09:15.
        await makeOrder(t, { at: today, status: "paid", total: 4 * U, paidAfter: 0 })
        await makeOrder(t, { at: today + 9 * 60 * MIN + 15 * MIN, status: "paid", total: 5 * U, paidAfter: 0 })
        // 7 days ago: outside the 7-day range, inside 30 days.
        await makeOrder(t, { at: today - 7 * DAY + 13 * 60 * MIN, status: "served", total: 6 * U, paidAfter: 0, servedAfter: 30 * MIN })

        const d = await stats(t, "today")
        expect(d.revenue).toBe(9 * U)
        expect(d.hours[0]).toBe(1)
        expect(d.hours[9]).toBe(1)
        expect(d.hours.reduce((a, b) => a + b, 0)).toBe(2)

        const w = await stats(t, "7d")
        expect(w.revenue).toBe(12 * U)
        expect(w.hours[23]).toBe(1)
        expect(w.days.map((x) => x.day)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"])
        expect(w.days.at(-2)).toEqual({ day: "2026-10-30", start: today - DAY, revenue: 3 * U, orders: 1 })
        expect(w.days.at(-1)).toEqual({ day: "2026-10-31", start: today, revenue: 9 * U, orders: 2 })

        const m = await stats(t, "30d")
        expect(m.revenue).toBe(18 * U)
        expect(m.days).toHaveLength(30)
        expect(m.days.find((x) => x.day === "2026-10-24")).toMatchObject({ revenue: 6 * U, orders: 1 })
        expect(m.hours[13]).toBe(1)

        // This month: 1 to 31 October, the same orders as the 30 days here.
        const mtd = await stats(t, "mtd")
        expect(mtd.days).toHaveLength(31)
        expect(mtd.revenue).toBe(18 * U)
    })

    it("ranks top dishes by quantity, then revenue, with the menu's current name", async () => {
        const dal = { id: "m_dal", name: "Dal", price: 2 * U }
        const naan = { id: "m_naan", name: "Naan", price: 1 * U }
        const kulfi = { id: "m_kulfi", name: "Kulfi", price: 3 * U }
        await makeOrder(t, { at: T0 - 50 * MIN, status: "served", items: [{ ...dal, qty: 2 }, { ...naan, qty: 4 }], paidAfter: 0 })
        await makeOrder(t, { at: T0 - 40 * MIN, status: "paid", items: [{ ...kulfi, qty: 2 }, { ...dal, qty: 2 }], paidAfter: 0 })
        // Unpaid and cancelled orders don't count.
        await makeOrder(t, { at: T0 - 30 * MIN, status: "awaiting_payment", items: [{ ...kulfi, qty: 9 }] })
        await makeOrder(t, { at: T0 - 20 * MIN, status: "cancelled", items: [{ ...kulfi, qty: 9 }] })
        // The dish was renamed on the menu since.
        await t.deps.db.query(
            "INSERT INTO menu_items (id, restaurant_id, name, category, price) VALUES ('m_dal', $1, 'Dal makhani', 'Mains', 2000000)",
            [t.r.id]
        )

        const s = await stats(t)
        expect(s.topDishes).toEqual([
            { itemId: "m_dal", name: "Dal makhani", qty: 4, revenue: 8 * U },
            { itemId: "m_naan", name: "Naan", qty: 4, revenue: 4 * U },
            { itemId: "m_kulfi", name: "Kulfi", qty: 2, revenue: 6 * U }
        ])
    })

    it("keeps at most 5 top dishes", async () => {
        const items = Array.from({ length: 7 }, (_, i) => ({ id: `m_${i}`, name: `Dish ${i}`, price: U, qty: i + 1 }))
        await makeOrder(t, { at: T0 - MIN, status: "paid", items, paidAfter: 0 })
        const s = await stats(t)
        expect(s.topDishes.map((d) => d.itemId)).toEqual(["m_6", "m_5", "m_4", "m_3", "m_2"])
    })

    it("counts table turns over the restaurant's tables, and orders without a table don't turn one", async () => {
        for (let i = 0; i < 6; i++) await makeOrder(t, { at: T0 - (i + 1) * MIN, status: "paid", table: (i % 4) + 1, paidAfter: 0 })
        await makeOrder(t, { at: T0 - 10 * MIN, status: "paid", table: null, paidAfter: 0 })
        // 6 seated paid orders over 4 tables.
        expect((await stats(t)).turnover.turnsPerTable).toBe(1.5)
    })

    it("counts an order given up unpaid as cancelled at once", async () => {
        await makeOrder(t, { at: T0 - 20 * MIN, status: "awaiting_payment", total: 9 * U })
        const s = await stats(t)
        expect(s.awaitingPayment).toBe(0)
        expect(s.cancelled).toEqual({ count: 1, value: 9 * U })
    })

    it("leaves out the demo restaurant's sample orders, which were marked paid without a payment", async () => {
        await t.deps.db.query("UPDATE restaurants SET is_demo = TRUE WHERE id = $1", [t.r.id])
        await makeOrder(t, { id: "o_saffrondemo1", at: T0 - 5 * MIN, status: "cooking", total: 30 * U, paidAfter: 0 })
        await makeOrder(t, { at: T0 - 5 * MIN, status: "paid", total: 4 * U, paidAfter: 0 })
        const s = await stats(t)
        expect(s.revenue).toBe(4 * U)
        expect(s.orders).toBe(1)
        // A real restaurant's order with that id would count (ids are random, so it never has one).
        await t.deps.db.query("UPDATE restaurants SET is_demo = FALSE WHERE id = $1", [t.r.id])
        expect((await stats(t)).revenue).toBe(34 * U)
    })

    it("doesn't count another restaurant's orders", async () => {
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Other Place", state: "Karnataka", tables: 1 } }), 201)
        await t.deps.db.query(
            `INSERT INTO orders (id, restaurant_id, guests, payment_mode, status, subtotal, total, gst_rate_bps, share_token, invoice_token, created_at, paid_at)
             VALUES ('o_elsewhere', $1, 2, 'one_pays', 'paid', $2, $2, 0, $3, $4, $5, $5)`,
            [other.id, 50 * U, newToken(), newToken(), T0 - MIN]
        )
        await makeOrder(t, { at: T0 - MIN, status: "paid", total: 2 * U, paidAfter: 0 })
        expect((await stats(t)).revenue).toBe(2 * U)
    })
})
