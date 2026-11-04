// FairEats orders: a guest orders at a table, the kitchen moves the order along, and anyone with
// the link can see the invoice. Payment happens in routes/pay.ts, which verifies it on-chain and
// calls onOrderPaid (server/faireats.ts); nothing here marks an order paid.

import { Hono } from "hono"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import {
    ID_RE,
    TOKEN_RE,
    buildInvoice,
    expireStaleOrders,
    fmtUsdc,
    loadOrder,
    loadOrders,
    requireRole,
    roleFor,
    sameToken,
    type OrderRow,
    type RestaurantRow
} from "../faireats.js"
import { clientIp, HttpError, int, limit, optStr, rateLimiter, readJson, str, wallet as walletInput } from "../http.js"
import { newId, newOrderRef, newToken } from "../ids.js"
import { appUrlOf } from "../origin.js"
import { computeBill, splitOrder, type BillTotals } from "../../shared/gst.js"
import type { Bill, BillParticipant, Order, Role, Wallet } from "../../shared/types.js"

const MAX_BODY = 32 * 1024
const MAX_GUESTS = 20
const MAX_LINES = 60
const MAX_QTY = 50
const MAX_BILL_PEOPLE = 20
/**
 * Unpaid orders one guest (a signed-in wallet, or else a client address) may hold at one
 * restaurant at a time. Each holds a table, so without this one address could occupy them all.
 */
export const MAX_UNPAID_ORDERS = 2
const MAX_TRACKED_HOLDERS = 10_000
/**
 * Dine-in orders are always intra-state supply (CGST + SGST, never IGST). The place of supply of
 * restaurant services is where they are actually performed (IGST Act 2017, section 12(4)), which
 * for a table order is the restaurant itself, in the restaurant's own state.
 */
export const DINE_IN_INTRA_STATE = true
const STATUSES: Order["status"][] = ["awaiting_payment", "paid", "cooking", "ready", "served", "cancelled"]
const ACTIVE: Order["status"][] = ["awaiting_payment", "paid", "cooking", "ready"]

/** Who may move an order to each status, and from which status. */
const TRANSITIONS: Record<string, { from: Order["status"]; roles: Role[] }> = {
    cooking: { from: "paid", roles: ["owner", "manager", "chef"] },
    ready: { from: "cooking", roles: ["owner", "manager", "chef"] },
    served: { from: "ready", roles: ["owner", "manager", "waiter"] },
    cancelled: { from: "awaiting_payment", roles: ["owner", "manager"] }
}

type ParsedOrder = {
    tableId: string
    guests: number
    paymentMode: Order["paymentMode"]
    items: { id: string; qty: number; guest: number }[]
    splitBy: "items" | "equal"
    guestNames: (string | null)[]
}

function parseCreateOrder(b: Record<string, unknown>): ParsedOrder {
    if (typeof b.tableId !== "string" || !ID_RE.test(b.tableId)) throw new HttpError(400, "Choose a table.")
    const guests = int(b.guests, { min: 1, max: MAX_GUESTS, name: "Guests" })
    if (b.paymentMode !== "one_pays" && b.paymentMode !== "split") throw new HttpError(400, "Payment mode must be one_pays or split.")
    if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, "Add at least one dish.")
    if (b.items.length > MAX_LINES) throw new HttpError(400, `At most ${MAX_LINES} lines in one order.`)
    const items = b.items.map((raw) => {
        const it = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
        if (typeof it.id !== "string" || !ID_RE.test(it.id)) throw new HttpError(400, "Unknown dish.")
        const qty = int(it.qty, { min: 1, max: MAX_QTY, name: "Quantity" })
        const guest = it.guest === undefined || it.guest === null ? 1 : int(it.guest, { min: 1, max: guests, name: "Guest number" })
        return { id: it.id, qty, guest }
    })
    let splitBy: "items" | "equal"
    if (b.splitBy === "items" || b.splitBy === "equal") splitBy = b.splitBy
    else if (b.splitBy === undefined || b.splitBy === null) splitBy = new Set(items.map((i) => i.guest)).size > 1 ? "items" : "equal"
    else throw new HttpError(400, "splitBy must be items or equal.")
    const guestNames: (string | null)[] = []
    if (b.guestNames !== undefined && b.guestNames !== null) {
        if (!Array.isArray(b.guestNames) || b.guestNames.length > guests) throw new HttpError(400, "Give at most one name per guest.")
        for (const n of b.guestNames) guestNames.push(optStr(n, { max: 60, name: "Guest name" }))
    }
    return { tableId: b.tableId, guests, paymentMode: b.paymentMode, items, splitBy, guestNames }
}

function totalsOf(o: OrderRow): BillTotals {
    return {
        subtotal: Number(o.subtotal),
        serviceCharge: Number(o.service_charge),
        taxable: Number(o.subtotal) + Number(o.service_charge),
        cgst: Number(o.cgst),
        sgst: Number(o.sgst),
        igst: Number(o.igst),
        roundOff: Number(o.round_off),
        total: Number(o.total)
    }
}

/** splitOrder, with a split that can't be made answered as a 409 rather than a server error. */
function safeSplit(...args: Parameters<typeof splitOrder>): number[] {
    try {
        return splitOrder(...args)
    } catch (err) {
        if (err instanceof RangeError) throw new HttpError(409, "This order can't be split that way. Try splitting it equally.")
        throw err
    }
}

function shortAddress(w: string) {
    return `${w.slice(0, 6)}…${w.slice(-4)}`
}

async function activity(
    q: Db,
    w: Wallet,
    kind: "order_placed" | "order_update" | "bill_request" | "bill_created",
    title: string,
    detail: string | null,
    link: string,
    now: number,
    maxDetail = 400
) {
    await q.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        w,
        kind,
        title.slice(0, 200),
        detail === null ? null : detail.slice(0, maxDetail),
        link,
        now
    ])
}

/**
 * Tells the owner what a cancelled order had already received, one line per verified payment, so
 * they can send it back. A public payment names its wallet (it is public on-chain anyway); a
 * confidential one names neither the payer nor the seat, only the amount and transaction.
 */
async function noteRefunds(q: Db, o: OrderRow, r: RestaurantRow, total: number, now: number) {
    const rows = await q.query<{ label: string; kind: "public" | "private"; payer: string; amount: number; tx_hash: string }>(
        `SELECT s.label, p.kind, p.payer, p.amount, p.tx_hash FROM payments p
         JOIN order_shares s ON s.id = p.target_id
         WHERE p.target_kind = 'order' AND s.order_id = $1 ORDER BY p.id`,
        [o.id]
    )
    const lines = rows.map((p) =>
        p.kind === "private"
            ? `${fmtUsdc(Number(p.amount))} USDC paid confidentially (tx ${p.tx_hash}); refund whoever shows this payment`
            : `${p.label}: ${fmtUsdc(Number(p.amount))} USDC from ${p.payer} (tx ${p.tx_hash})`
    )
    const table = o.table_id ? (await q.one<{ label: string }>("SELECT label FROM restaurant_tables WHERE id = $1", [o.table_id]))?.label : undefined
    const where = table ? `Table ${table}` : "An order"
    const detail = `${where} was cancelled after paying ${fmtUsdc(total)} USDC. Refund: ${lines.length > 0 ? lines.join("; ") : "see the order's shares"}.`
    await activity(q, r.owner_wallet, "order_update", `Refund ${fmtUsdc(total)} USDC for a cancelled order`, detail, `/business/faireats/manage/${r.id}`, now, 4000)
}

export function orderRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    // Ordering needs no sign-in and holds a table, so cap how fast one address can take tables.
    const placeLimit = rateLimiter(6, 10 * 60_000, deps.now)
    // ...and how many it holds at once. Orders placed signed in are counted from placed_by. Orders
    // placed without signing in are remembered here per restaurant and client address. In memory,
    // like the rate limits: a restart forgets them, and expiry frees their tables anyway.
    const anonymousOrders = new Map<string, string[]>()
    // Placements under way per holder, counted before the first await so two at once can't both pass.
    const placing = new Map<string, number>()

    async function unpaidHeld(restaurantId: string, holder: string, me: Wallet | null): Promise<number> {
        if (me) {
            // Staff may take orders for several tables at once.
            if ((await roleFor(db, restaurantId, me)) !== null) return 0
            const row = await db.one<{ n: number }>(
                "SELECT COUNT(*)::int AS n FROM orders WHERE restaurant_id = $1 AND placed_by = $2 AND status = 'awaiting_payment'",
                [restaurantId, me]
            )
            return Number(row?.n ?? 0)
        }
        const ids = anonymousOrders.get(holder) ?? []
        if (ids.length === 0) return 0
        const open = await db.query<{ id: string }>(
            `SELECT id FROM orders WHERE status = 'awaiting_payment' AND id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`,
            ids
        )
        const still = ids.filter((id) => open.some((o) => o.id === id))
        if (still.length > 0) anonymousOrders.set(holder, still)
        else anonymousOrders.delete(holder)
        return still.length
    }

    function rememberAnonymous(holder: string, orderId: string) {
        const before = anonymousOrders.get(holder) ?? []
        // Re-inserted at the end, so Map order stays oldest first.
        anonymousOrders.delete(holder)
        if (anonymousOrders.size >= MAX_TRACKED_HOLDERS) {
            // Its orders have most likely expired by now.
            const oldest = anonymousOrders.keys().next().value
            if (oldest !== undefined) anonymousOrders.delete(oldest)
        }
        anonymousOrders.set(holder, [...before, orderId])
    }

    // ------------------------------------------------------------------ place an order

    app.post("/orders", async (c) => {
        const me = c.get("wallet") ?? null
        const input = parseCreateOrder(await readJson(c, MAX_BODY))
        limit(c, placeLimit)
        const now = deps.now()
        const token = newToken()
        const invoiceToken = newToken()
        const orderId = newId("o")
        // Give back tables held by unpaid, expired orders first, so this guest can take one.
        const where = await db.one<{ restaurant_id: string }>("SELECT restaurant_id FROM restaurant_tables WHERE id = $1", [input.tableId])
        if (!where) throw new HttpError(404, "No such table.")
        await expireStaleOrders(db, where.restaurant_id, now)

        // Unpaid orders held at this restaurant by the signed-in wallet, or else the client address.
        const holder = `${where.restaurant_id} ${me ?? `ip:${clientIp(c)}`}`
        placing.set(holder, (placing.get(holder) ?? 0) + 1)
        try {
            const held = await unpaidHeld(where.restaurant_id, holder, me)
            if (held + placing.get(holder)! > MAX_UNPAID_ORDERS) {
                throw new HttpError(
                    429,
                    me
                        ? `You already have ${MAX_UNPAID_ORDERS} unpaid orders here. Pay for one, or ask the staff to cancel it, before taking another table.`
                        : `This device already has ${MAX_UNPAID_ORDERS} unpaid orders here. Pay for one first, or sign in to order for another table.`
                )
            }
            await db.tx(async (q) => {
                // Lock the table row so two guests can't both take it.
                const table = await q.one<{ id: string; restaurant_id: string; label: string; status: string }>(
                    "SELECT id, restaurant_id, label, status FROM restaurant_tables WHERE id = $1 FOR UPDATE",
                    [input.tableId]
                )
                if (!table) throw new HttpError(404, "No such table.")
                if (table.status !== "available") throw new HttpError(409, `Table ${table.label} is not free right now. Choose another table.`)
                const r = (await q.one<RestaurantRow>("SELECT * FROM restaurants WHERE id = $1", [table.restaurant_id]))!
                const menu = new Map(
                    (
                        await q.query<{ id: string; name: string; price: number; available: boolean; sac: string }>(
                            "SELECT id, name, price, available, sac FROM menu_items WHERE restaurant_id = $1",
                            [r.id]
                        )
                    ).map((m) => [m.id, m])
                )
                // Prices come from the database, never from the client.
                const lines = input.items.map((it) => {
                    const m = menu.get(it.id)
                    if (!m) throw new HttpError(400, "One of the dishes isn't on this menu.")
                    if (!m.available) throw new HttpError(409, `${m.name} is not available right now.`)
                    return { itemId: m.id, name: m.name, sac: m.sac, unitPrice: Number(m.price), qty: it.qty, guest: it.guest }
                })
                // Without a GSTIN the restaurant may not charge GST (bill of supply).
                const gstRateBps = r.gstin ? Number(r.gst_rate_bps) : 0
                const totals = computeBill({ lines, gstRateBps, serviceChargeBps: Number(r.service_charge_bps), intraState: DINE_IN_INTRA_STATE })
                const shares =
                    input.paymentMode === "one_pays"
                        ? [{ guest: 1, label: "Whole table", amount: totals.total }]
                        : safeSplit(lines, input.guests, totals, input.splitBy)
                              .map((amount, i) => ({ guest: i + 1, label: input.guestNames[i] ?? `Guest ${i + 1}`, amount }))
                              // A guest who ordered nothing (split by items) has nothing to pay.
                              .filter((s) => s.amount > 0)

                await q.query(
                    `INSERT INTO orders (id, restaurant_id, table_id, placed_by, guests, payment_mode, status, subtotal, service_charge,
                        cgst, sgst, igst, round_off, total, gst_rate_bps, share_token, invoice_token, created_at, payout_wallet)
                     VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
                    [
                        orderId,
                        r.id,
                        table.id,
                        me,
                        input.guests,
                        input.paymentMode,
                        totals.subtotal,
                        totals.serviceCharge,
                        totals.cgst,
                        totals.sgst,
                        totals.igst,
                        totals.roundOff,
                        totals.total,
                        gstRateBps,
                        token,
                        invoiceToken,
                        now,
                        // Guests pay the wallet they are shown now, even if the owner changes it later.
                        r.payout_wallet
                    ]
                )
                for (const l of lines) {
                    await q.query("INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest, sac) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
                        orderId,
                        l.itemId,
                        l.name,
                        l.unitPrice,
                        l.qty,
                        l.guest,
                        l.sac
                    ])
                }
                for (const s of shares) {
                    const shareId = newId("s")
                    const ref = newOrderRef(orderId, shareId)
                    await q.query("INSERT INTO order_shares (id, order_id, guest, label, amount, status, order_ref, secret) VALUES ($1, $2, $3, $4, $5, 'owed', $6, $7)", [
                        shareId,
                        orderId,
                        s.guest,
                        s.label,
                        s.amount,
                        ref.orderRef,
                        ref.secret
                    ])
                }
                await q.query("UPDATE restaurant_tables SET status = 'occupied', order_id = $2, updated_at = $3 WHERE id = $1", [table.id, orderId, now])
                await activity(q, r.owner_wallet, "order_placed", `New order at table ${table.label}`, `${fmtUsdc(totals.total)} USDC, awaiting payment`, `/business/faireats/manage/${r.id}`, now)
            })
            if (!me) rememberAnonymous(holder, orderId)
        } finally {
            const n = (placing.get(holder) ?? 1) - 1
            if (n <= 0) placing.delete(holder)
            else placing.set(holder, n)
        }
        return c.json({ order: (await loadOrder(deps, orderId))!, token }, 201)
    })

    // ------------------------------------------------------------------ read

    /** Token holder, the wallet that placed it, or restaurant staff. */
    async function canView(row: OrderRow, t: string | undefined, me: Wallet | null) {
        if (t && TOKEN_RE.test(t) && sameToken(t, row.share_token)) return true
        if (me && row.placed_by === me) return true
        return (await roleFor(db, row.restaurant_id, me)) !== null
    }

    app.get("/orders/:id", async (c) => {
        const id = c.req.param("id")
        const row = ID_RE.test(id) ? await db.one<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]) : undefined
        // Same answer whether the order is missing or the link is wrong, so ids can't be probed.
        if (!row || !(await canView(row, c.req.query("t"), c.get("wallet") ?? null))) throw new HttpError(404, "No order found. Open it from its link.")
        return c.json((await loadOrder(deps, id))!)
    })

    app.get("/restaurants/:id/orders", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, ["owner", "manager", "chef", "waiter"])
        await expireStaleOrders(db, restaurant.id, deps.now())
        const q = c.req.query("status")
        let statuses: Order["status"][] | null = null
        if (q && q !== "all") {
            const parts = q === "active" ? ACTIVE : q.split(",").map((s) => s.trim())
            if (parts.length > STATUSES.length || !parts.every((s) => STATUSES.includes(s as Order["status"]))) {
                throw new HttpError(400, `Status must be one or more of ${STATUSES.join(", ")}, or active.`)
            }
            statuses = parts as Order["status"][]
        }
        const params: unknown[] = [restaurant.id]
        let where = "o.restaurant_id = $1"
        if (statuses) {
            where += ` AND o.status IN (${statuses.map((s) => {
                params.push(s)
                return `$${params.length}`
            }).join(", ")})`
        }
        return c.json(await loadOrders(deps, where, params, 200))
    })

    app.get("/i/:token", async (c) => {
        const token = c.req.param("token")
        // The invoice token only reads; the share token (which can pay and split) never opens this.
        const row = TOKEN_RE.test(token) ? await db.one<OrderRow>("SELECT * FROM orders WHERE invoice_token = $1", [token]) : undefined
        if (!row) throw new HttpError(404, "This invoice link is not valid.")
        // Staff and the wallet that placed the order also see public transactions; others don't.
        return c.json(await buildInvoice(deps, row, c.get("wallet") ?? null))
    })

    // ------------------------------------------------------------------ kitchen

    app.post("/orders/:id/status", async (c) => {
        const me = requireWallet(c)
        const id = c.req.param("id")
        const b = await readJson(c, MAX_BODY)
        const status = typeof b.status === "string" ? b.status : ""
        const rule = TRANSITIONS[status]
        if (!rule) throw new HttpError(400, "Status must be cooking, ready, served or cancelled.")
        const found = ID_RE.test(id) ? await db.one<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]) : undefined
        if (!found) throw new HttpError(404, "No such order.")
        const { restaurant, role } = await requireRole(db, found.restaurant_id, me, ["owner", "manager", "chef", "waiter"])
        if (!rule.roles.includes(role)) throw new HttpError(403, `A ${role} can't mark an order ${status}.`)
        let chefId: string | null = null
        if (status === "cooking" && b.chefId !== undefined && b.chefId !== null) {
            if (typeof b.chefId !== "string" || !ID_RE.test(b.chefId)) throw new HttpError(400, "Unknown chef.")
            chefId = b.chefId
        }
        const now = deps.now()

        await db.tx(async (q) => {
            const o = (await q.one<OrderRow>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]))!
            if (o.status !== rule.from) throw new HttpError(409, `The order is ${o.status.replace("_", " ")}; it can't be marked ${status} now.`)
            let refunded = 0
            if (status === "cooking") {
                let chef = o.chef_id
                if (chefId) {
                    const ok = await q.one("SELECT 1 FROM chefs WHERE id = $1 AND restaurant_id = $2", [chefId, restaurant.id])
                    if (!ok) throw new HttpError(400, "That chef doesn't work here.")
                    chef = chefId
                }
                if (!chef) {
                    // The on-duty chef with the fewest dishes on the stove.
                    const pick = await q.one<{ id: string }>(
                        `SELECT c.id FROM chefs c WHERE c.restaurant_id = $1 AND c.on_duty
                         ORDER BY (SELECT COUNT(*) FROM orders x WHERE x.chef_id = c.id AND x.status = 'cooking'), c.name, c.id LIMIT 1`,
                        [restaurant.id]
                    )
                    chef = pick?.id ?? null
                }
                await q.query("UPDATE orders SET status = 'cooking', cooking_started_at = $2, chef_id = $3 WHERE id = $1", [id, now, chef])
            } else if (status === "ready") {
                await q.query("UPDATE orders SET status = 'ready', ready_at = $2 WHERE id = $1", [id, now])
            } else if (status === "served") {
                await q.query("UPDATE orders SET status = 'served', served_at = $2 WHERE id = $1", [id, now])
            } else {
                // Lock the shares (after the order, the same order settle uses) so no payment is
                // credited between this sum and the cancel.
                const shares = await q.query<{ id: string; paid: number }>("SELECT id, paid FROM order_shares WHERE order_id = $1 ORDER BY guest FOR UPDATE", [id])
                refunded = shares.reduce((a, s) => a + Number(s.paid), 0)
                await q.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id])
                // A table that half paid and left mustn't hold the table forever. The money is
                // already with the restaurant on-chain, so tell the owner exactly what to send back.
                if (refunded > 0) await noteRefunds(q, o, restaurant, refunded, now)
            }
            // Serving or cancelling frees the table for the next guests.
            if ((status === "served" || status === "cancelled") && o.table_id) {
                await q.query("UPDATE restaurant_tables SET status = 'available', order_id = NULL, updated_at = $3 WHERE id = $1 AND order_id = $2", [o.table_id, id, now])
            }
            if (o.placed_by) {
                const text: Record<string, string> = {
                    cooking: "Your order is being cooked",
                    ready: "Your order is ready",
                    served: "Your order has been served",
                    cancelled: "Your order was cancelled"
                }
                const detail = refunded > 0 ? `${restaurant.name}. The restaurant will refund the ${fmtUsdc(refunded)} USDC already paid.` : restaurant.name
                await activity(q, o.placed_by, "order_update", text[status], detail, `/o/${id}?t=${o.share_token}`, now)
            }
        })
        return c.json((await loadOrder(deps, id))!)
    })

    // ------------------------------------------------------------------ split a paid order with friends

    /**
     * The bill makes friends pay the caller back, so the caller must be who actually paid the
     * table's one share. Holding the order link proves nothing (everyone at the table has it).
     *  - public payments: the paying wallet is on-chain, so it must be the caller;
     *  - private payments: the pool hides the payer, so only the signed-in wallet that placed the
     *    order is believed, and with nobody signed in nobody can claim it.
     */
    async function requirePayer(o: OrderRow, me: Wallet) {
        const pays = await db.query<{ kind: "public" | "private"; payer: string }>(
            `SELECT p.kind, p.payer FROM payments p JOIN order_shares s ON s.id = p.target_id
             WHERE p.target_kind = 'order' AND s.order_id = $1`,
            [o.id]
        )
        if (pays.length === 0) throw new HttpError(409, "FairPay has no record of who paid this order, so it can't be split here.")
        const notPayer = new HttpError(403, "Only the person who paid for the table can split it with friends.")
        if (pays.some((p) => p.kind === "public" && p.payer !== me)) throw notPayer
        if (pays.some((p) => p.kind === "private")) {
            if (o.placed_by === null) {
                throw new HttpError(403, "This order was paid privately without signing in, so FairPay can't tell who paid. Sign in before ordering to split later.")
            }
            if (o.placed_by !== me) throw notPayer
        }
    }

    app.post("/orders/:id/split-bill", async (c) => {
        const me = requireWallet(c)
        const id = c.req.param("id")
        const b = await readJson(c, MAX_BODY)
        const splitType = b.splitType === undefined || b.splitType === null ? "equal" : b.splitType
        if (splitType !== "equal" && splitType !== "items") throw new HttpError(400, "Split type must be equal or items.")
        const found = ID_RE.test(id) ? await db.one<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]) : undefined
        if (!found) throw new HttpError(404, "No such order.")
        if (found.payment_mode !== "one_pays") throw new HttpError(409, "Each guest already pays their own share of this order.")
        if (found.paid_at === null || found.status === "awaiting_payment" || found.status === "cancelled") throw new HttpError(409, "Pay for the order first, then split it.")
        if (found.split_bill_id) throw new HttpError(409, "This order has already been split.")
        await requirePayer(found, me)

        if (!Array.isArray(b.participants) || b.participants.length === 0) throw new HttpError(400, "Add at least one friend to split with.")
        if (b.participants.length > MAX_BILL_PEOPLE - 1) throw new HttpError(400, `A bill can have at most ${MAX_BILL_PEOPLE} people, including you.`)
        const seen = new Set<string>()
        const usedGuests = new Set<number>()
        const people = b.participants.map((raw, i) => {
            const p = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
            let w: Wallet | null = null
            if (p.wallet !== undefined && p.wallet !== null && p.wallet !== "") {
                w = walletInput(p.wallet)
                if (w === me) throw new HttpError(400, "You're already in the bill. Leave your own wallet out.")
                if (seen.has(w)) throw new HttpError(400, `${shortAddress(w)} is in the bill twice.`)
                seen.add(w)
            }
            const named = optStr(p.displayName, { max: 60, name: "Name" })
            if (!named && !w) throw new HttpError(400, `Give person ${i + 1} a name or a wallet address.`)
            let guest: number | null = null
            if (splitType === "items") {
                guest = int(p.guest, { min: 1, max: Number(found.guests), name: "Guest number" })
                if (usedGuests.has(guest)) throw new HttpError(400, `Guest ${guest} is assigned twice.`)
                usedGuests.add(guest)
            }
            return { wallet: w, displayName: named ?? shortAddress(w!), guest }
        })

        const total = Number(found.total)
        let amounts: number[]
        if (splitType === "equal") {
            // Whole cents each; leftover cents go one at a time from the first person (you), as in bills.
            amounts = safeSplit([], people.length + 1, totalsOf(found), "equal")
        } else {
            const items = await db.query<{ unit_price: number; qty: number; guest: number }>("SELECT unit_price, qty, guest FROM order_items WHERE order_id = $1", [id])
            const byGuest = safeSplit(
                items.map((i) => ({ unitPrice: Number(i.unit_price), qty: Number(i.qty), guest: Number(i.guest) })),
                Number(found.guests),
                totalsOf(found),
                "items"
            )
            const theirs = people.map((p) => byGuest[p.guest! - 1])
            // Guests nobody was assigned to stay with the payer.
            amounts = [total - theirs.reduce((a, x) => a + x, 0), ...theirs]
        }
        // splitOrder never hands out a negative share; check the payer's remainder the same way.
        if (amounts.some((a) => !Number.isSafeInteger(a) || a < 0) || amounts.reduce((a, x) => a + x, 0) !== total) {
            throw new HttpError(409, "This order can't be split that way. Try splitting it equally.")
        }
        if (amounts.slice(1).every((a) => a === 0)) throw new HttpError(400, "Nobody else would owe anything. Assign guests who ordered.")

        const now = deps.now()
        const billId = newId("b")
        const shareToken = newToken()
        const myName = (await db.one<{ display_name: string | null }>("SELECT display_name FROM profiles WHERE wallet = $1", [me]))?.display_name ?? null
        const tableLabel = found.table_id ? (await db.one<{ label: string }>("SELECT label FROM restaurant_tables WHERE id = $1", [found.table_id]))?.label : undefined
        const rName = (await db.one<{ name: string }>("SELECT name FROM restaurants WHERE id = $1", [found.restaurant_id]))?.name ?? "Restaurant"
        const title = (b.title !== undefined && b.title !== null ? str(b.title, { max: 80, name: "Title" }) : `${rName}${tableLabel ? `, table ${tableLabel}` : ""}`).slice(0, 80)
        // Random ids, sorted, then handed out in entry order: bills list people ORDER BY id, so this
        // keeps you first and the rest as entered (the same trick as POST /bills).
        const seatIds = Array.from({ length: people.length + 1 }, () => newId("p")).sort()
        const seats = [
            { id: seatIds[0]!, wallet: me as Wallet | null, displayName: myName ?? shortAddress(me), amount: amounts[0], status: "covered" as const },
            ...people.map((p, i) => ({
                id: seatIds[i + 1]!,
                wallet: p.wallet,
                displayName: p.displayName,
                amount: amounts[i + 1],
                status: amounts[i + 1] === 0 ? ("covered" as const) : ("owed" as const)
            }))
        ]

        await db.tx(async (q) => {
            const o = (await q.one<OrderRow>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]))!
            if (o.split_bill_id) throw new HttpError(409, "This order has already been split.")
            await q.query(
                `INSERT INTO bills (id, creator, recipient, title, note, total, split_type, status, share_token, source, order_id, created_at)
                 VALUES ($1, $2, $2, $3, NULL, $4, $5, 'open', $6, 'restaurant_order', $7, $8)`,
                [billId, me, title, total, splitType, shareToken, id, now]
            )
            for (const s of seats) {
                const ref = newOrderRef(billId, s.id)
                await q.query(
                    "INSERT INTO bill_participants (id, bill_id, wallet, display_name, amount, status, order_ref, secret) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    [s.id, billId, s.wallet, s.displayName, s.amount, s.status, ref.orderRef, ref.secret]
                )
            }
            await q.query("UPDATE orders SET split_bill_id = $2 WHERE id = $1", [id, billId])
            const from = myName ?? shortAddress(me)
            await activity(q, me, "bill_created", `You split "${title}"`, `${fmtUsdc(total)} USDC between ${seats.length} people`, `/bills/${billId}`, now)
            for (const s of seats.slice(1)) {
                if (!s.wallet) continue
                const what = s.status === "covered" ? "Nothing to pay in FairPay." : title
                await activity(q, s.wallet, "bill_request", s.status === "covered" ? `${from} added you to "${title}"` : `${from} requested ${fmtUsdc(s.amount)} USDC`, what, `/bills/${billId}`, now)
            }
        })

        const participants: BillParticipant[] = seats.map((s) => ({
            id: s.id,
            wallet: s.wallet,
            displayName: s.displayName,
            amount: s.amount,
            tip: 0,
            paid: 0,
            status: s.status,
            paidPrivately: false,
            paidAt: null,
            // A name-only seat can be claimed from the share link by whoever signs in.
            claimable: s.wallet === null && s.status === "owed"
        }))
        const bill: Bill = {
            id: billId,
            creator: me,
            recipient: me,
            recipientName: myName ?? shortAddress(me),
            title,
            note: null,
            total,
            splitType,
            status: "open",
            source: "restaurant_order",
            orderId: id,
            shareUrl: `${appUrlOf(deps)}/b/${shareToken}`,
            createdAt: now,
            settledAt: null,
            participants,
            myParticipantId: seats[0].id
        }
        return c.json(bill, 201)
    })

    return app
}
