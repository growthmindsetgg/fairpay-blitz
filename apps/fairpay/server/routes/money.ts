// FairEats: the owner's money view. Totals, the payment log with each payment's on-chain proof, a
// re-check of that proof, the restaurant's invoices and the payments that need a refund. Mounted
// by restaurantRoutes, so the paths sit with the other /restaurants/:id routes.
//
// Owner only. The payout wallet must be the owner's own wallet (routes/restaurants.ts), so its
// balance is the owner's personal balance; refund notes go to the owner alone; and a manager can't
// change the payout wallet. Managers keep what they have today: orders, and invoices with their
// public transactions.
//
// Privacy, the same rules as invoices and activity (SECURITY.md, "FairPay app server controls"):
//  * a confidential payment never names its payer (stored as the pool) or its guest's seat;
//  * a share paid partly in public and partly confidentially gets no transaction, block, log index
//    or orderRef on any of its payments, and no payer: the confidential transaction's orderRef
//    finds the public one on-chain, which names the wallet;
//  * otherwise the owner sees each transaction that paid their own wallet. A confidential one was
//    sent by the relayer and names FairPool as payer, and it is a transfer the owner already sees
//    on the explorer under their wallet; the log only says which order it paid.

import { Hono } from "hono"
import { FairPayError, type VerifyResult } from "@fairpay/sdk"
import { getAddress, type Address, type Hash, type Hex } from "viem"
import type { MoneyInvoice, MoneyNotice, MoneyPayment, MoneySummary, MoneyTotals, RecheckResult, Wallet } from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { getRestaurant, type RestaurantRow } from "../faireats.js"
import { HttpError, limit, rateLimiter } from "../http.js"
import { appUrlOf } from "../origin.js"

const DAY = 86_400_000
/** India time, UTC+5:30, as the dashboard shows times (src/pages/business/ui.tsx). */
export const IST_OFFSET = 330 * 60_000
const PAGE = 25
const MAX_PAGE = 100
const MAX_CSV_ROWS = 10_000
const MAX_NOTICES = 50
const PAYMENT_ID = /^[1-9][0-9]{0,15}$/
const INVOICE_NO = /^[A-Z0-9]{2,6}\/[0-9]{4}-[0-9]{2}\/[0-9]{6,9}$/
const TX_IN_TEXT = /\(tx (0x[0-9a-f]{64})\)/

/** Not found and not the owner get the same answer, so restaurant ids can't be probed. */
async function requireOwner(db: Db, id: string, me: Wallet): Promise<RestaurantRow> {
    const r = await getRestaurant(db, id)
    if (!r || r.owner_wallet !== me) throw new HttpError(404, "No restaurant with that id.")
    return r
}

/** Start of today in India, as unix ms. */
export function startOfDayIst(now: number) {
    const local = now + IST_OFFSET
    return local - (local % DAY) - IST_OFFSET
}

function pageSize(v: string | undefined) {
    if (v === undefined || v === "") return PAGE
    if (!/^[0-9]{1,3}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PAGE) throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE}.`)
    return Number(v)
}

/**
 * The tip in a payment: a share's tip (the last confidential note's extra over the price, see
 * settleLocked in routes/pay.ts) belongs to the payment that completed the share, its latest.
 */
export const TIP_SQL = `CASE WHEN s.status = 'paid' AND s.tip > 0
        AND p.id = (SELECT MAX(y.id) FROM payments y WHERE y.target_kind = 'order' AND y.target_id = p.target_id)
    THEN LEAST(s.tip, p.amount) ELSE 0 END`

/** Payments credited to this restaurant's order shares, as `p` with its share `s` and order `o`. */
const FROM_SQL = `FROM payments p
    JOIN order_shares s ON s.id = p.target_id
    JOIN orders o ON o.id = s.order_id
    WHERE p.target_kind = 'order' AND o.restaurant_id = $1`

type LogRow = {
    id: number
    kind: "public" | "private"
    amount: number
    tip: number
    verified_at: number
    chain_id: number
    tx_hash: Hash
    log_index: number
    block_number: number
    payer: string
    recipient: Wallet
    share_label: string
    order_ref: Hex
    order_id: string
    invoice_no: string | null
    table_label: string | null
    /** The share also has a payment of the other kind. */
    mixed: boolean
}

const LOG_SQL = `SELECT p.id, p.kind, p.amount, p.verified_at, p.chain_id, p.tx_hash, p.log_index, p.block_number, p.payer, p.recipient,
        s.label AS share_label, s.order_ref, o.id AS order_id, o.invoice_no, t.label AS table_label,
        EXISTS (SELECT 1 FROM payments y WHERE y.target_kind = 'order' AND y.target_id = p.target_id AND y.kind <> p.kind) AS mixed,
        ${TIP_SQL} AS tip
    FROM payments p
    JOIN order_shares s ON s.id = p.target_id
    JOIN orders o ON o.id = s.order_id
    LEFT JOIN restaurant_tables t ON t.id = o.table_id
    WHERE p.target_kind = 'order' AND o.restaurant_id = $1`

/** The one place a payment row becomes something the owner sees. See the privacy rules above. */
function toMoneyPayment(r: LogRow): MoneyPayment {
    const priv = r.kind === "private"
    const withheld = Boolean(r.mixed)
    return {
        id: Number(r.id),
        at: Number(r.verified_at),
        kind: r.kind,
        amount: Number(r.amount),
        tip: Number(r.tip),
        order: { id: r.order_id, invoiceNo: r.invoice_no, table: r.table_label },
        share: priv ? null : r.share_label,
        payer: priv || withheld ? null : (r.payer as Wallet),
        recipient: r.recipient,
        proof: withheld
            ? null
            : { chainId: Number(r.chain_id), txHash: r.tx_hash, logIndex: Number(r.log_index), blockNumber: Number(r.block_number), orderRef: r.order_ref }
    }
}

const emptyTotals = (): MoneyTotals => ({ received: 0, public: 0, private: 0, tips: 0, count: 0 })

async function loadTotals(db: Db, restaurantId: string, now: number): Promise<MoneySummary["totals"]> {
    const today = startOfDayIst(now)
    const windows = [
        ["today", today],
        // The last 7 days, today included.
        ["week", today - 6 * DAY],
        ["all", null]
    ] as const
    const cols = windows.flatMap(([name, since], i) => {
        const f = since === null ? "" : ` FILTER (WHERE verified_at >= $${i + 2})`
        const fk = (kind: string) => ` FILTER (WHERE kind = '${kind}'${since === null ? "" : ` AND verified_at >= $${i + 2}`})`
        return [
            `COUNT(*)${f}::int AS ${name}_count`,
            `COALESCE(SUM(amount)${f}, 0)::bigint AS ${name}_received`,
            `COALESCE(SUM(amount)${fk("public")}, 0)::bigint AS ${name}_public`,
            `COALESCE(SUM(amount)${fk("private")}, 0)::bigint AS ${name}_private`,
            `COALESCE(SUM(tip)${f}, 0)::bigint AS ${name}_tips`
        ]
    })
    const row = await db.one<Record<string, number>>(
        `WITH x AS (SELECT p.kind, p.amount, p.verified_at, ${TIP_SQL} AS tip ${FROM_SQL}) SELECT ${cols.join(", ")} FROM x`,
        [restaurantId, today, today - 6 * DAY]
    )
    const pick = (name: string): MoneyTotals =>
        row
            ? {
                  received: Number(row[`${name}_received`]),
                  public: Number(row[`${name}_public`]),
                  private: Number(row[`${name}_private`]),
                  tips: Number(row[`${name}_tips`]),
                  count: Number(row[`${name}_count`])
              }
            : emptyTotals()
    return { today: pick("today"), week: pick("week"), all: pick("all") }
}

/**
 * Money that arrived but wasn't credited: the "Payment not counted" and "Refund needed" notes
 * routes/pay.ts writes to the owner (flagUncredited, notifyRefund). Only rows the server wrote for
 * this restaurant: order updates linking to its dashboard.
 */
async function loadNotices(db: Db, r: RestaurantRow): Promise<MoneyNotice[]> {
    const rows = await db.query<{ id: number; title: string; detail: string | null; created_at: number }>(
        `SELECT id, title, detail, created_at FROM activity
         WHERE wallet = $1 AND kind = 'order_update' AND link = $2 AND (title LIKE 'Payment not counted%' OR title LIKE 'Refund needed%')
         ORDER BY created_at DESC, id DESC LIMIT ${MAX_NOTICES}`,
        [r.owner_wallet, `/business/faireats/manage/${r.id}`]
    )
    return rows.map((n) => ({
        id: Number(n.id),
        kind: n.title.startsWith("Refund needed") ? "refund" : "not_counted",
        title: n.title,
        detail: n.detail,
        txHash: (n.detail?.match(TX_IN_TEXT)?.[1] as `0x${string}` | undefined) ?? null,
        at: Number(n.created_at)
    }))
}

async function isMerchant(deps: Deps, w: Wallet): Promise<boolean | null> {
    try {
        return await deps.chain.isMerchant(getAddress(w))
    } catch (err) {
        console.warn("isMerchant:", err instanceof Error ? err.message.split("\n")[0] : err)
        return null
    }
}

/** micro-USDC as a plain decimal for spreadsheets: 5000000 -> "5.000000". */
const usdcCell = (micro: number) => `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`

/** A CSV cell. Text that a spreadsheet would run as a formula gets a leading apostrophe. */
function csvCell(v: string | number | null) {
    let s = v === null ? "" : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** What the re-check tells the owner, from the SDK's answer for the stored payment. */
export function recheckOutcome(stored: { kind: "public" | "private"; logIndex: number; blockNumber: number }, v: VerifyResult): Omit<RecheckResult, "checkedAt"> {
    if (v.status === "pending") {
        return v.confirmations > 0n
            ? { status: "pending", reason: `On-chain, waiting for confirmations (${v.confirmations} so far).` }
            : { status: "pending", reason: "The chain doesn't show this transaction right now: not found, or its block was replaced. Try again in a minute." }
    }
    if (v.status === "rejected") return { status: "rejected", reason: `The chain doesn't confirm this payment: ${v.reason}.` }
    const p = v.payment
    if (p.kind !== stored.kind || p.logIndex !== stored.logIndex) return { status: "rejected", reason: "The transaction no longer matches the payment FairPay recorded." }
    const moved = Number(p.blockNumber) !== stored.blockNumber
    return { status: "verified", reason: moved ? `Confirmed, now in block ${p.blockNumber} (recorded in block ${stored.blockNumber}).` : null }
}

export function moneyRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    // A re-check costs several RPC calls; the export reads up to 10,000 rows.
    const limits = {
        recheck: rateLimiter(20, 60_000, deps.now),
        recheckWallet: rateLimiter(20, 60_000, deps.now),
        csv: rateLimiter(10, 60_000, deps.now)
    }

    app.get("/restaurants/:id/money", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        const [totals, attention, privatePayments] = await Promise.all([loadTotals(db, r.id, deps.now()), loadNotices(db, r), isMerchant(deps, r.payout_wallet)])
        const body: MoneySummary = { payout: { wallet: r.payout_wallet, privatePayments }, totals, attention }
        return c.json(body)
    })

    app.get("/restaurants/:id/money/payments", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        const size = pageSize(c.req.query("limit"))
        const before = c.req.query("before")
        if (before !== undefined && !PAYMENT_ID.test(before)) throw new HttpError(400, "before must be a payment id.")
        const rows = await db.query<LogRow>(
            `${LOG_SQL}${before ? " AND p.id < $2" : ""} ORDER BY p.id DESC LIMIT ${size + 1}`,
            before ? [r.id, Number(before)] : [r.id]
        )
        const page = rows.slice(0, size).map(toMoneyPayment)
        return c.json({ payments: page, next: rows.length > size ? String(page[page.length - 1]!.id) : null })
    })

    app.get("/restaurants/:id/money/payments.csv", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.csv, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const rows = await db.query<LogRow>(`${LOG_SQL} ORDER BY p.id DESC LIMIT ${MAX_CSV_ROWS}`, [r.id])
        const head = ["verified_at_utc", "order", "invoice", "table", "share", "kind", "amount_usdc", "tip_usdc", "payer", "recipient", "chain_id", "tx_hash", "log_index", "block"]
        const lines = rows.map(toMoneyPayment).map((p) =>
            [
                new Date(p.at).toISOString(),
                p.order.id,
                p.order.invoiceNo,
                p.order.table,
                p.share ?? (p.kind === "private" ? "Confidential" : null),
                p.kind === "private" ? "confidential" : "public",
                usdcCell(p.amount),
                usdcCell(p.tip),
                p.payer ?? (p.kind === "private" ? "FairPool" : "withheld"),
                p.recipient,
                p.proof?.chainId ?? null,
                p.proof?.txHash ?? null,
                p.proof?.logIndex ?? null,
                p.proof?.blockNumber ?? null
            ]
                .map(csvCell)
                .join(",")
        )
        const day = new Date(startOfDayIst(deps.now()) + IST_OFFSET).toISOString().slice(0, 10)
        c.header("Content-Type", "text/csv; charset=utf-8")
        c.header("Content-Disposition", `attachment; filename="${r.slug}-payments-${day}.csv"`)
        return c.body([head.join(","), ...lines].join("\r\n") + "\r\n")
    })

    app.post("/restaurants/:id/money/payments/:paymentId/recheck", async (c) => {
        limit(c, limits.recheck)
        const me = requireWallet(c)
        limit(c, limits.recheckWallet, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const pid = c.req.param("paymentId")
        const row = PAYMENT_ID.test(pid)
            ? await db.one<LogRow>(`${LOG_SQL} AND p.id = $2`, [r.id, Number(pid)])
            : undefined
        if (!row) throw new HttpError(404, "No payment with that id.")
        const stored = { kind: row.kind, logIndex: Number(row.log_index), blockNumber: Number(row.block_number) }
        let outcome: Omit<RecheckResult, "checkedAt">
        if (Number(row.chain_id) !== deps.chain.deployment.chainId) {
            outcome = { status: "rejected", reason: "This payment was recorded on another chain." }
        } else {
            let v: VerifyResult
            try {
                // The same check settle ran: this share's orderRef, the wallet it paid, the amount
                // that arrived and, for a public payment, the wallet that sent it.
                v = await deps.chain.verify({
                    txHash: row.tx_hash,
                    orderRef: row.order_ref,
                    merchant: getAddress(row.recipient) as Address,
                    amount: BigInt(row.amount),
                    ...(row.kind === "public" ? { expectedPayer: getAddress(row.payer) as Address } : {})
                })
            } catch (err) {
                if (err instanceof FairPayError && err.code === "INVALID_INPUT") throw new HttpError(400, "Malformed payment.")
                console.error("payment re-check:", err instanceof Error ? err.message.split("\n")[0] : err)
                throw new HttpError(502, "Could not check the payment on-chain right now. Try again shortly.")
            }
            outcome = recheckOutcome(stored, v)
        }
        const body: RecheckResult = { ...outcome, checkedAt: deps.now() }
        return c.json(body)
    })

    app.get("/restaurants/:id/money/invoices", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        const size = pageSize(c.req.query("limit"))
        const before = c.req.query("before")
        if (before !== undefined && !INVOICE_NO.test(before)) throw new HttpError(400, "before must be an invoice number.")
        // Invoice numbers count up per restaurant and are zero-padded, so their order is issue order.
        const rows = await db.query<{
            id: string
            invoice_no: string
            paid_at: number | null
            created_at: number
            total: number
            gst_rate_bps: number
            invoice_token: string | null
            table_label: string | null
        }>(
            `SELECT o.id, o.invoice_no, o.paid_at, o.created_at, o.total, o.gst_rate_bps, o.invoice_token, t.label AS table_label
             FROM orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id
             WHERE o.restaurant_id = $1 AND o.invoice_no IS NOT NULL${before ? " AND o.invoice_no < $2" : ""}
             ORDER BY o.invoice_no DESC LIMIT ${size + 1}`,
            before ? [r.id, before] : [r.id]
        )
        const base = appUrlOf(deps)
        const invoices: MoneyInvoice[] = rows.slice(0, size).map((o) => ({
            orderId: o.id,
            invoiceNo: o.invoice_no,
            issuedAt: Number(o.paid_at ?? o.created_at),
            table: o.table_label,
            total: Number(o.total),
            // As buildInvoice decides it (server/faireats.ts).
            kind: r.gstin !== null && Number(o.gst_rate_bps) > 0 ? "tax_invoice" : "bill_of_supply",
            url: o.invoice_token ? `${base}/i/${o.invoice_token}` : ""
        }))
        return c.json({ invoices, next: rows.length > size ? invoices[invoices.length - 1]!.invoiceNo : null })
    })

    return app
}
