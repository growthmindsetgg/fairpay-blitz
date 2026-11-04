// FairEats helpers shared by the restaurant, order and payment routes: roles, row -> API mappers,
// the wait-time estimate and invoice numbering. Routes import from here so the rules live once.

import type { Address } from "viem"
import type { Db, Deps } from "./context.js"
import { HttpError } from "./http.js"
import { appUrlOf } from "./origin.js"
import { amountInWords, financialYear, stateCode } from "../shared/gst.js"
import type { Chef, Invoice, MenuItem, Order, OrderShare, Restaurant, Role, StaffMember, Table, Wallet } from "../shared/types.js"

/**
 * The kitchen runs itself (advanceKitchen): a paid order starts cooking at once, cooks for its
 * longest prep time kept within these bounds, and is served SERVE_AFTER_READY_MS after it is ready.
 * The guest's expected wait uses the same bounds, so it is never more than COOK_MAX_MINUTES.
 */
export const COOK_MIN_MINUTES = 5
export const COOK_MAX_MINUTES = 10
export const SERVE_AFTER_READY_MS = 60_000
const COOK_MIN_MS = COOK_MIN_MINUTES * 60_000
const COOK_MAX_MS = COOK_MAX_MINUTES * 60_000
/** Used when an ordered item has since been deleted from the menu. */
const DEFAULT_PREP_MINUTES = 15

/** Cook time in whole minutes for a longest prep time, within [COOK_MIN_MINUTES, COOK_MAX_MINUTES]. */
export function cookMinutes(prepMinutes: number): number {
    const m = Number.isFinite(prepMinutes) ? Math.ceil(prepMinutes) : DEFAULT_PREP_MINUTES
    return Math.min(COOK_MAX_MINUTES, Math.max(COOK_MIN_MINUTES, m))
}
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/**
 * Ids of the sample orders seeded with the demo restaurant (server/seed.ts). Real order ids are
 * "o_" plus 16 random base32 characters, so they never match.
 */
export const DEMO_ORDER_RE = /^o_saffrondemo[0-9]{1,2}$/
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

// ------------------------------------------------------------------ rows (schema.sql names)

export type RestaurantRow = {
    id: string
    slug: string
    name: string
    tagline: string | null
    description: string | null
    cuisine: string | null
    address: string | null
    city: string | null
    state: string
    gstin: string | null
    fssai: string | null
    gst_rate_bps: number
    service_charge_bps: number
    owner_wallet: Wallet
    payout_wallet: Wallet
    cover_image: string | null
    hours: string | null
    invoice_prefix: string
    invoice_seq: number
    is_demo: boolean
    created_at: number
}

export type OrderRow = {
    id: string
    restaurant_id: string
    table_id: string | null
    placed_by: Wallet | null
    guests: number
    payment_mode: Order["paymentMode"]
    status: Order["status"]
    subtotal: number
    service_charge: number
    cgst: number
    sgst: number
    igst: number
    round_off: number
    total: number
    gst_rate_bps: number
    chef_id: string | null
    est_ready_at: number | null
    invoice_no: string | null
    /** Pays and splits: only for the guests at the table. Never put it in a staff-facing shape. */
    share_token: string
    /** Read-only invoice link. Null only for rows written before the column existed (schema.sql backfills). */
    invoice_token: string | null
    split_bill_id: string | null
    created_at: number
    paid_at: number | null
    cooking_started_at: number | null
    ready_at: number | null
    served_at: number | null
}

type ChefRow = {
    id: string
    restaurant_id: string
    name: string
    title: string | null
    bio: string | null
    specialty: string | null
    years: number | null
    photo: string | null
    on_duty: boolean
}

type MenuRow = {
    id: string
    name: string
    description: string | null
    category: string
    price: number
    image: string | null
    veg: boolean
    spice: number
    prep_minutes: number
    available: boolean
    sac: string
    sort: number
}

type TableRow = { id: string; label: string; seats: number; status: Table["status"]; order_id: string | null }

type StaffRow = { wallet: Wallet; role: StaffMember["role"]; display_name: string; added_at: number }

type ItemRow = { order_id: string; item_id: string; name: string; unit_price: number; qty: number; guest: number; sac: string }

type ShareRow = {
    id: string
    order_id: string
    guest: number
    label: string
    amount: number
    tip: number
    paid: number
    status: OrderShare["status"]
    paid_at: number | null
    paid_privately: boolean
}

// ------------------------------------------------------------------ mappers

export function toChef(r: ChefRow): Chef {
    return {
        id: r.id,
        name: r.name,
        title: r.title,
        bio: r.bio,
        specialty: r.specialty,
        years: r.years === null ? null : Number(r.years),
        photo: r.photo,
        onDuty: Boolean(r.on_duty)
    }
}

export function toMenuItem(r: MenuRow): MenuItem {
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        price: Number(r.price),
        image: r.image,
        veg: Boolean(r.veg),
        spice: Number(r.spice),
        prepMinutes: Number(r.prep_minutes),
        available: Boolean(r.available),
        sac: r.sac,
        sort: Number(r.sort)
    }
}

/** `publicView` hides which order sits at a table (the storefront shows status only). */
export function toTable(r: TableRow, publicView = false): Table {
    return { id: r.id, label: r.label, seats: Number(r.seats), status: r.status, orderId: publicView ? null : r.order_id }
}

export function toStaff(r: StaffRow): StaffMember {
    return { wallet: r.wallet, role: r.role, displayName: r.display_name, addedAt: Number(r.added_at) }
}

async function isMerchantSafe(deps: Deps, wallet: Wallet): Promise<boolean> {
    try {
        return await deps.chain.isMerchant(wallet as Address)
    } catch {
        // An RPC hiccup must not break the directory; private payments just show as unavailable.
        return false
    }
}

/** Restaurant rows -> API shape, with table counts and whether guests can pay privately. */
export async function toRestaurants(deps: Deps, rows: RestaurantRow[]): Promise<Restaurant[]> {
    if (rows.length === 0) return []
    const counts = new Map<string, { total: number; available: number }>()
    // One grouped query for the page rather than one per restaurant.
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ")
    const tableRows = await deps.db.query<{ restaurant_id: string; total: number; available: number }>(
        `SELECT restaurant_id, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'available')::int AS available
         FROM restaurant_tables WHERE restaurant_id IN (${placeholders}) GROUP BY restaurant_id`,
        ids
    )
    for (const t of tableRows) counts.set(t.restaurant_id, { total: Number(t.total), available: Number(t.available) })
    const payouts = [...new Set(rows.map((r) => r.payout_wallet))]
    const merchant = new Map<string, boolean>()
    await Promise.all(payouts.map(async (w) => merchant.set(w, await isMerchantSafe(deps, w))))
    return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        description: r.description,
        cuisine: r.cuisine,
        address: r.address,
        city: r.city,
        state: r.state,
        gstin: r.gstin,
        fssai: r.fssai,
        gstRateBps: Number(r.gst_rate_bps),
        serviceChargeBps: Number(r.service_charge_bps),
        payoutWallet: r.payout_wallet,
        coverImage: r.cover_image,
        hours: r.hours,
        isDemo: Boolean(r.is_demo),
        privatePayments: merchant.get(r.payout_wallet) ?? false,
        tables: counts.get(r.id) ?? { total: 0, available: 0 }
    }))
}

export async function toRestaurant(deps: Deps, row: RestaurantRow): Promise<Restaurant> {
    return (await toRestaurants(deps, [row]))[0]
}

// ------------------------------------------------------------------ lookups and roles

export async function getRestaurant(db: Db, id: string): Promise<RestaurantRow | undefined> {
    if (!ID_RE.test(id)) return undefined
    return db.one<RestaurantRow>("SELECT * FROM restaurants WHERE id = $1", [id])
}

/** The wallet's role at a restaurant, or null when it isn't staff. */
export async function roleFor(db: Db, restaurantId: string, wallet: Wallet | null | undefined): Promise<Role | null> {
    if (!wallet) return null
    const w = wallet.toLowerCase()
    const row = await db.one<{ owner_wallet: string; role: StaffMember["role"] | null }>(
        `SELECT r.owner_wallet, s.role FROM restaurants r
         LEFT JOIN restaurant_staff s ON s.restaurant_id = r.id AND s.wallet = $2
         WHERE r.id = $1`,
        [restaurantId, w]
    )
    if (!row) return null
    if (row.owner_wallet === w) return "owner"
    return row.role ?? null
}

/** Loads the restaurant and checks the wallet holds one of `roles`. 404 / 403 otherwise. */
export async function requireRole(db: Db, restaurantId: string, wallet: Wallet, roles: readonly Role[]): Promise<{ restaurant: RestaurantRow; role: Role }> {
    const restaurant = await getRestaurant(db, restaurantId)
    if (!restaurant) throw new HttpError(404, "No restaurant with that id.")
    const role = await roleFor(db, restaurantId, wallet)
    if (!role) throw new HttpError(403, "You don't work at this restaurant.")
    if (!roles.includes(role)) throw new HttpError(403, `A ${role} can't do that here.`)
    return { restaurant, role }
}

export async function loadMenu(db: Db, restaurantId: string): Promise<MenuItem[]> {
    const rows = await db.query<MenuRow>("SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort, category, name, id", [restaurantId])
    return rows.map(toMenuItem)
}

export async function loadChefs(db: Db, restaurantId: string): Promise<Chef[]> {
    const rows = await db.query<ChefRow>("SELECT * FROM chefs WHERE restaurant_id = $1 ORDER BY name, id", [restaurantId])
    return rows.map(toChef)
}

/** Natural label order, so "2" comes before "10". */
export async function loadTables(db: Db, restaurantId: string, publicView = false): Promise<Table[]> {
    const rows = await db.query<TableRow>("SELECT id, label, seats, status, order_id FROM restaurant_tables WHERE restaurant_id = $1", [restaurantId])
    rows.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }))
    return rows.map((r) => toTable(r, publicView))
}

export async function loadStaff(db: Db, restaurantId: string): Promise<StaffMember[]> {
    const rows = await db.query<StaffRow>("SELECT wallet, role, display_name, added_at FROM restaurant_staff WHERE restaurant_id = $1 ORDER BY added_at, wallet", [restaurantId])
    return rows.map(toStaff)
}

// ------------------------------------------------------------------ orders

/** Minutes until the food should be ready; 0 once it is, null before payment or after cancel. */
export function waitMinutes(estReadyAt: number | null, status: Order["status"], now: number): number | null {
    if (status === "cancelled" || status === "awaiting_payment") return null
    if (status === "ready" || status === "served") return 0
    if (estReadyAt === null) return null
    return Math.max(0, Math.ceil((estReadyAt - now) / 60_000))
}

/**
 * Loads orders matching `where` (SQL over the `orders` alias o, with $1.. params) and maps them,
 * newest first. Items, shares and chefs come from three batched queries, not one per order.
 */
export async function loadOrders(deps: Deps, where: string, params: unknown[], limit = 200): Promise<Order[]> {
    const db = deps.db
    const rows = await db.query<OrderRow & { r_slug: string; r_name: string; r_demo: boolean; t_label: string | null }>(
        `SELECT o.*, r.slug AS r_slug, r.name AS r_name, r.is_demo AS r_demo, t.label AS t_label
         FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
         WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
        params
    )
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const ph = ids.map((_, i) => `$${i + 1}`).join(", ")
    const awaiting = rows.filter((r) => r.status === "awaiting_payment").map((r) => r.id)
    const [items, shares, chefs, expected] = await Promise.all([
        db.query<ItemRow>(`SELECT order_id, item_id, name, unit_price, qty, guest, sac FROM order_items WHERE order_id IN (${ph}) ORDER BY id`, ids),
        db.query<ShareRow>(
            `SELECT s.id, s.order_id, s.guest, s.label, s.amount, s.tip, s.paid, s.status, s.paid_at,
                    EXISTS (SELECT 1 FROM payments y WHERE y.target_kind = 'order' AND y.target_id = s.id AND y.kind = 'private') AS paid_privately
             FROM order_shares s WHERE s.order_id IN (${ph}) ORDER BY s.guest`,
            ids
        ),
        db.query<ChefRow>(`SELECT c.* FROM chefs c WHERE c.id IN (SELECT chef_id FROM orders WHERE id IN (${ph}) AND chef_id IS NOT NULL)`, ids),
        // Unpaid orders get the wait they'd have if paid now, so guests know before they pay.
        waitRuleMinutes(db, awaiting)
    ])
    const now = deps.now()
    const chefById = new Map(chefs.map((c) => [c.id, toChef(c)]))
    return rows.map((o) => ({
        id: o.id,
        restaurant: { id: o.restaurant_id, slug: o.r_slug, name: o.r_name },
        table: o.table_id && o.t_label !== null ? { id: o.table_id, label: o.t_label } : null,
        guests: Number(o.guests),
        paymentMode: o.payment_mode,
        status: o.status,
        items: items
            .filter((i) => i.order_id === o.id)
            .map((i) => ({ itemId: i.item_id, name: i.name, unitPrice: Number(i.unit_price), qty: Number(i.qty), guest: Number(i.guest), sac: i.sac })),
        subtotal: Number(o.subtotal),
        serviceCharge: Number(o.service_charge),
        cgst: Number(o.cgst),
        sgst: Number(o.sgst),
        igst: Number(o.igst),
        roundOff: Number(o.round_off),
        total: Number(o.total),
        gstRateBps: Number(o.gst_rate_bps),
        shares: shares
            .filter((s) => s.order_id === o.id)
            .map((s) => ({
                id: s.id,
                guest: Number(s.guest),
                label: s.label,
                amount: Number(s.amount),
                tip: Number(s.tip),
                paid: Number(s.paid),
                status: s.status,
                paidPrivately: Boolean(s.paid_privately)
            })),
        chef: o.chef_id ? (chefById.get(o.chef_id) ?? null) : null,
        estReadyAt: o.est_ready_at === null ? null : Number(o.est_ready_at),
        waitMinutes: waitMinutes(o.est_ready_at === null ? null : Number(o.est_ready_at), o.status, now),
        ...(o.status === "awaiting_payment" && expected.has(o.id) ? { expectedWaitMinutes: expected.get(o.id)! } : {}),
        ...(isDemoOrder(o.id, o.r_demo) ? { demo: true } : {}),
        invoiceNo: o.invoice_no,
        // The invoice has its own token: staff see this URL, and the share token can pay and split.
        invoiceUrl: o.invoice_token ? `${appUrlOf(deps)}/i/${o.invoice_token}` : "",
        splitBillId: o.split_bill_id,
        createdAt: Number(o.created_at),
        paidAt: o.paid_at === null ? null : Number(o.paid_at),
        cookingStartedAt: o.cooking_started_at === null ? null : Number(o.cooking_started_at),
        readyAt: o.ready_at === null ? null : Number(o.ready_at),
        servedAt: o.served_at === null ? null : Number(o.served_at)
    }))
}

export async function loadOrder(deps: Deps, orderId: string): Promise<Order | undefined> {
    if (!ID_RE.test(orderId)) return undefined
    return (await loadOrders(deps, "o.id = $1", [orderId], 1))[0]
}

/**
 * An order nobody has paid anything towards gives its table back after this long. Short, because
 * an unpaid order needs no sign-in and holds a table (see MAX_UNPAID_ORDERS in routes/orders.ts).
 */
export const ORDER_EXPIRY_MS = 15 * 60_000

/**
 * Cancels this restaurant's orders that have waited for payment longer than ORDER_EXPIRY_MS with
 * nothing paid on any share, and frees their tables; then moves the kitchen along by the clock
 * (advanceKitchen). Idempotent and cheap when there is nothing to do (one indexed SELECT and three
 * guarded UPDATEs), so routes call it on every read of the restaurant's tables or orders.
 *
 * Locks the candidate orders first, then re-checks the shares in a later statement: settle
 * (routes/pay.ts) locks an order before crediting its share, so that statement either sees the
 * payment and skips the order, or the payment waits and then finds the order cancelled.
 */
export async function expireStaleOrders(db: Db, restaurantId: string, now: number): Promise<string[]> {
    const expired = await expireUnpaidOrders(db, restaurantId, now)
    // Every read that sweeps unpaid orders also brings the kitchen up to date (advanceKitchen).
    await advanceKitchen(db, { restaurantId }, now)
    return expired
}

async function expireUnpaidOrders(db: Db, restaurantId: string, now: number): Promise<string[]> {
    const cutoff = now - ORDER_EXPIRY_MS
    const stale = await db.query<{ id: string }>(
        "SELECT id FROM orders WHERE restaurant_id = $1 AND status = 'awaiting_payment' AND created_at < $2 LIMIT 200",
        [restaurantId, cutoff]
    )
    if (stale.length === 0) return []
    const ids = stale.map((s) => s.id)
    // $1 and $2 are taken; the ids follow.
    const list = (from: number, n: number) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(", ")
    return db.tx(async (q) => {
        await q.query(`SELECT id FROM orders WHERE id IN (${list(1, ids.length)}) AND status = 'awaiting_payment' ORDER BY id FOR UPDATE`, ids)
        const expired = await q.query<{ id: string }>(
            `UPDATE orders o SET status = 'cancelled'
             WHERE o.restaurant_id = $1 AND o.created_at < $2 AND o.status = 'awaiting_payment' AND o.id IN (${list(3, ids.length)})
               AND NOT EXISTS (SELECT 1 FROM order_shares s WHERE s.order_id = o.id AND s.paid > 0)
             RETURNING o.id`,
            [restaurantId, cutoff, ...ids]
        )
        if (expired.length === 0) return []
        const gone = expired.map((e) => e.id)
        await q.query(
            `UPDATE restaurant_tables SET status = 'available', order_id = NULL, updated_at = $1 WHERE order_id IN (${list(2, gone.length)})`,
            [now, ...gone]
        )
        return gone
    })
}

/** A sample order seeded with the demo restaurant: its shares were marked paid without a payment. */
export function isDemoOrder(orderId: string, restaurantIsDemo: boolean): boolean {
    return Boolean(restaurantIsDemo) && DEMO_ORDER_RE.test(orderId)
}

/**
 * Wait-time rule, in minutes per order: the longest prep time among the order's items, kept within
 * [COOK_MIN_MINUTES, COOK_MAX_MINUTES] (cookMinutes). Orders already in the kitchen don't add to it:
 * every order cooks at once. Orders that don't exist are left out of the map.
 */
export async function waitRuleMinutes(db: Db, orderIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (orderIds.length === 0) return out
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ")
    const rows = await db.query<{ id: string; base: number | null }>(
        `SELECT o.id,
            (SELECT MAX(COALESCE(m.prep_minutes, ${DEFAULT_PREP_MINUTES})) FROM order_items oi
               LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = o.id) AS base
         FROM orders o WHERE o.id IN (${ph})`,
        orderIds
    )
    for (const r of rows) {
        const base = r.base === null || r.base === undefined ? DEFAULT_PREP_MINUTES : Number(r.base)
        out.set(r.id, cookMinutes(base))
    }
    return out
}

/** When the order should be ready if the kitchen gets it at `now` (see waitRuleMinutes). */
export async function estimateReadyAt(db: Db, orderId: string, now: number): Promise<number> {
    const minutes = (await waitRuleMinutes(db, [orderId])).get(orderId) ?? COOK_MAX_MINUTES
    return now + minutes * 60_000
}

/** SQL: an order's cook time in ms from its stored estimate relative to `fromCol`, clamped. */
const cookMsSql = (fromCol: string) => `LEAST(${COOK_MAX_MS}::bigint, GREATEST(${COOK_MIN_MS}::bigint, COALESCE(est_ready_at - ${fromCol}, ${COOK_MAX_MS}::bigint)))`
const COOK_START_SQL = "COALESCE(cooking_started_at, paid_at, created_at)"
const READY_DUE_SQL = `(${COOK_START_SQL} + ${cookMsSql(COOK_START_SQL)})`
const READY_AT_SQL = `COALESCE(ready_at, ${COOK_START_SQL})`

export type KitchenScope = { restaurantId: string } | { orderId: string }

/**
 * Moves orders along the kitchen by the clock: paid -> cooking at once (cooking_started_at =
 * paid_at, an on-duty chef as the manual "Start cooking" picks), cooking -> ready when the cook
 * time is up (cooking_started_at + the estimate, kept within [COOK_MIN_MINUTES,
 * COOK_MAX_MINUTES]), ready -> served SERVE_AFTER_READY_MS later, which frees the table.
 *
 * Runs lazily on reads, so a server that slept catches up on the next request. Each step is one
 * UPDATE guarded by status and time, so concurrent calls can't move an order twice, and each
 * records the time the step was due, not "now", so a stuck order's history stays truthful.
 * Never touches an unpaid or cancelled order, and never moves one backwards.
 */
export async function advanceKitchen(db: Db, scope: KitchenScope, now: number): Promise<{ cooking: string[]; ready: string[]; served: string[] }> {
    const col = "restaurantId" in scope ? "restaurant_id" : "id"
    const key = "restaurantId" in scope ? scope.restaurantId : scope.orderId
    if (!ID_RE.test(key)) return { cooking: [], ready: [], served: [] }
    const at = Math.floor(now)
    type Moved = { id: string; placed_by: Wallet | null; share_token: string; table_id: string | null; at: number; r_name: string }
    const back = (atCol: string) =>
        `RETURNING id, placed_by, share_token, table_id, ${atCol} AS at, (SELECT r.name FROM restaurants r WHERE r.id = orders.restaurant_id) AS r_name`
    return db.tx(async (q) => {
        const cooking = await q.query<Moved>(
            `UPDATE orders SET status = 'cooking', cooking_started_at = paid_at,
                est_ready_at = paid_at + ${cookMsSql("paid_at")},
                chef_id = COALESCE(chef_id, (SELECT c.id FROM chefs c WHERE c.restaurant_id = orders.restaurant_id AND c.on_duty
                    ORDER BY (SELECT COUNT(*) FROM orders x WHERE x.chef_id = c.id AND x.status = 'cooking'), c.name, c.id LIMIT 1))
             WHERE ${col} = $1 AND status = 'paid' AND paid_at IS NOT NULL AND paid_at <= $2::bigint
             ${back("cooking_started_at")}`,
            [key, at]
        )
        const ready = await q.query<Moved>(
            `UPDATE orders SET status = 'ready', ready_at = ${READY_DUE_SQL}, est_ready_at = ${READY_DUE_SQL}
             WHERE ${col} = $1 AND status = 'cooking' AND ${READY_DUE_SQL} <= $2::bigint
             ${back("ready_at")}`,
            [key, at]
        )
        const served = await q.query<Moved>(
            `UPDATE orders SET status = 'served', served_at = ${READY_AT_SQL} + ${SERVE_AFTER_READY_MS}::bigint
             WHERE ${col} = $1 AND status = 'ready' AND ${READY_AT_SQL} + ${SERVE_AFTER_READY_MS}::bigint <= $2::bigint
             ${back("served_at")}`,
            [key, at]
        )
        // Served frees the table, as the waiter's "Mark served" does.
        for (const o of served) {
            if (o.table_id) {
                await q.query("UPDATE restaurant_tables SET status = 'available', order_id = NULL, updated_at = $3 WHERE id = $1 AND order_id = $2", [
                    o.table_id,
                    o.id,
                    Number(o.at)
                ])
            }
        }
        // The guest who placed it hears about ready and served (paying already told them the wait).
        const tell = async (rows: Moved[], title: string) => {
            for (const o of rows) {
                if (!o.placed_by) continue
                await q.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, 'order_update', $2, $3, $4, $5)", [
                    o.placed_by,
                    title,
                    o.r_name,
                    `/o/${o.id}?t=${o.share_token}`,
                    Number(o.at)
                ])
            }
        }
        await tell(ready, "Your order is ready")
        await tell(served, "Your order has been served")
        return { cooking: cooking.map((o) => o.id), ready: ready.map((o) => o.id), served: served.map((o) => o.id) }
    })
}

/**
 * Gives a fully paid order its invoice number, "PREFIX/FY/000123", taking the next value of the
 * restaurant's counter. Idempotent: an order that already has a number keeps it. Call inside the
 * transaction that marks the order paid; the counter row's UPDATE lock serialises concurrent calls.
 */
export async function assignInvoiceNo(q: Db, orderId: string, now?: number): Promise<string> {
    const order = await q.one<{ restaurant_id: string; invoice_no: string | null; paid_at: number | null; created_at: number }>(
        "SELECT restaurant_id, invoice_no, paid_at, created_at FROM orders WHERE id = $1 FOR UPDATE",
        [orderId]
    )
    if (!order) throw new Error(`assignInvoiceNo: no order ${orderId}`)
    if (order.invoice_no) return order.invoice_no
    const seq = await q.one<{ invoice_seq: number; invoice_prefix: string }>(
        "UPDATE restaurants SET invoice_seq = invoice_seq + 1 WHERE id = $1 RETURNING invoice_seq, invoice_prefix",
        [order.restaurant_id]
    )
    if (!seq) throw new Error(`assignInvoiceNo: no restaurant for order ${orderId}`)
    const at = order.paid_at !== null ? Number(order.paid_at) : (now ?? Date.now())
    const invoiceNo = `${seq.invoice_prefix}/${financialYear(at)}/${String(seq.invoice_seq).padStart(6, "0")}`
    await q.query("UPDATE orders SET invoice_no = $2 WHERE id = $1", [orderId, invoiceNo])
    return invoiceNo
}

/**
 * Everything that happens when an order becomes fully paid. Payment settle (routes/pay.ts) calls
 * this inside its transaction once every share is paid. Idempotent and safe whether or not the
 * caller already set status/paid_at: moves awaiting_payment -> paid, sets paid_at and est_ready_at
 * if missing, assigns the invoice number, and starts cooking at once (advanceKitchen).
 */
export async function onOrderPaid(q: Db, orderId: string, now: number): Promise<{ invoiceNo: string; estReadyAt: number }> {
    const est = await estimateReadyAt(q, orderId, now)
    const row = await q.one<{ est_ready_at: number }>(
        `UPDATE orders SET
            status = CASE WHEN status = 'awaiting_payment' THEN 'paid' ELSE status END,
            paid_at = COALESCE(paid_at, $2),
            est_ready_at = COALESCE(est_ready_at, $3)
         WHERE id = $1 RETURNING est_ready_at`,
        [orderId, now, est]
    )
    if (!row) throw new Error(`onOrderPaid: no order ${orderId}`)
    const invoiceNo = await assignInvoiceNo(q, orderId, now)
    await advanceKitchen(q, { orderId }, now)
    return { invoiceNo, estReadyAt: Number(row.est_ready_at) }
}

// ------------------------------------------------------------------ invoice

/**
 * The GST invoice. Anyone with the invoice link can read it, so payer details follow the bills
 * rule: a public transaction (which names the payer's wallet) only for the restaurant's staff and
 * the wallet that placed the order, never for a share that also had a confidential payment (its
 * public tx would tie the payer to the private part too), and a confidential payment never names
 * its guest.
 */
export async function buildInvoice(deps: Deps, orderRow: OrderRow, viewer: Wallet | null = null): Promise<Invoice> {
    const db = deps.db
    const order = await loadOrder(deps, orderRow.id)
    const restaurant = await getRestaurant(db, orderRow.restaurant_id)
    if (!order || !restaurant) throw new HttpError(404, "This invoice link is not valid.")
    const payments = await db.query<{ share_id: string; label: string; amount: number; kind: "public" | "private"; tx_hash: string; verified_at: number }>(
        `SELECT s.id AS share_id, s.label, p.amount, p.kind, p.tx_hash, p.verified_at FROM payments p
         JOIN order_shares s ON s.id = p.target_id
         WHERE p.target_kind = 'order' AND s.order_id = $1 ORDER BY p.verified_at, p.id`,
        [orderRow.id]
    )
    const full = viewer !== null && (orderRow.placed_by === viewer || (await roleFor(db, orderRow.restaurant_id, viewer)) !== null)
    const partlyPrivate = new Set(payments.filter((p) => p.kind === "private").map((p) => p.share_id))
    // One line per dish and price, whichever guest ordered it.
    const lines = new Map<string, { name: string; sac: string; qty: number; rate: number; taxable: number }>()
    for (const i of order.items) {
        const key = `${i.itemId}\u0000${i.unitPrice}`
        const l = lines.get(key)
        if (l) {
            l.qty += i.qty
            l.taxable += i.unitPrice * i.qty
        } else {
            lines.set(key, { name: i.name, sac: i.sac, qty: i.qty, rate: i.unitPrice, taxable: i.unitPrice * i.qty })
        }
    }
    const half = Math.floor(order.gstRateBps / 2)
    const isTax = restaurant.gstin !== null && order.gstRateBps > 0
    return {
        kind: isTax ? "tax_invoice" : "bill_of_supply",
        invoiceNo: order.invoiceNo,
        issuedAt: order.paidAt ?? order.createdAt,
        supplier: {
            name: restaurant.name,
            address: restaurant.address,
            city: restaurant.city,
            state: restaurant.state,
            stateCode: stateCode(restaurant.state),
            gstin: restaurant.gstin,
            fssai: restaurant.fssai
        },
        placeOfSupply: restaurant.state,
        table: order.table?.label ?? null,
        lines: [...lines.values()],
        subtotal: order.subtotal,
        serviceCharge: order.serviceCharge,
        serviceChargeBps: Number(restaurant.service_charge_bps),
        taxableValue: order.subtotal + order.serviceCharge,
        cgst: { rateBps: order.igst > 0 ? 0 : half, amount: order.cgst },
        sgst: { rateBps: order.igst > 0 ? 0 : half, amount: order.sgst },
        igst: { rateBps: order.igst > 0 ? order.gstRateBps : 0, amount: order.igst },
        roundOff: order.roundOff,
        total: order.total,
        amountInWords: amountInWords(order.total),
        paymentMode: order.paymentMode,
        payments: payments.map((p) => ({
            label: p.kind === "private" ? "Confidential payment" : p.label,
            amount: Number(p.amount),
            private: p.kind === "private",
            txHash: full && p.kind === "public" && !partlyPrivate.has(p.share_id) ? p.tx_hash : null,
            at: Number(p.verified_at)
        })),
        status: order.status,
        orderId: order.id,
        shareUrl: order.invoiceUrl,
        ...(order.demo ? { demo: true } : {})
    }
}

// ------------------------------------------------------------------ small shared checks

/** Image references we serve ourselves: an upload or bundled menu art. Never an outside URL. */
export const IMAGE_REF_RE = /^(\/api\/images\/[A-Za-z0-9_-]{1,64}|\/menu\/[a-z0-9-]{1,40}\.svg)$/

/** "1,234.50" from micro-USDC, for activity text. */
export function fmtUsdc(micro: number): string {
    const cents = Math.round(micro / 10_000)
    return `${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`
}

/** Constant-time string compare for share tokens. */
export function sameToken(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}
