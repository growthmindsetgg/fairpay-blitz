import { randomUUID } from "node:crypto"
import { createOrderRef, FairPayError, randomSecret, verifyPaymentTx, type FairPayDeployment, type VerifiedPayment, type VerifyResult } from "@fairpay/sdk"
import type { Address, Hash, Hex, PublicClient } from "viem"
import { isUniqueViolation, tx, type Db } from "./db.js"
import { menuById, restaurant } from "./menu.js"

export const COOK_MS = 60_000
export const MAX_GUESTS = 8
const MAX_QTY = 20
const MAX_LINES = 30
// verifyPaymentTx's reason when the event's amount differs; the amount is read from the chain.
const AMOUNT_REJECTED = /^amount (\d{1,30}) does not equal required /

export class HttpError extends Error {
    constructor(readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 502 | 503, message: string) {
        super(message)
    }
}

type ShareRow = {
    id: string
    order_id: string
    guest: number
    amount: number
    paid: number
    order_ref: Hex
    status: "requested" | "executed" | "verified"
}

type OrderRow = {
    id: string
    table_no: number
    status: "awaiting_payment" | "paid" | "cooking" | "served"
    total: number
    created_at: number
    paid_at: number | null
    cooking_started_at: number | null
    ready_at: number | null
}

export type CreateOrderInput = {
    table: number
    guests: number
    items: { id: string; qty: number; guest: number }[]
}

export function parseCreateOrder(body: unknown): CreateOrderInput {
    const b = body as Partial<CreateOrderInput> | null
    const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Send a JSON body with table, guests and items.")
    if (!int(b.table, 1, restaurant.tables)) throw new HttpError(400, `Table must be between 1 and ${restaurant.tables}.`)
    if (!int(b.guests, 1, MAX_GUESTS)) throw new HttpError(400, `Guests must be between 1 and ${MAX_GUESTS}.`)
    if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, "Add at least one dish.")
    if (b.items.length > MAX_LINES) throw new HttpError(400, "Too many lines in one order.")
    const items = b.items.map((it) => {
        if (!it || typeof it !== "object" || typeof it.id !== "string" || !menuById.has(it.id)) throw new HttpError(400, "Unknown dish.")
        if (!int(it.qty, 1, MAX_QTY)) throw new HttpError(400, `Quantity must be between 1 and ${MAX_QTY}.`)
        if (!int(it.guest, 1, b.guests!)) throw new HttpError(400, "Each dish must belong to a guest at the table.")
        return { id: it.id, qty: it.qty, guest: it.guest }
    })
    return { table: b.table!, guests: b.guests!, items }
}

export function createService(
    db: Db,
    deps: {
        deployment: FairPayDeployment & { denomination: bigint }
        publicClient: PublicClient
        merchant: Address
        now?: () => number
    }
) {
    const now = deps.now ?? Date.now
    const denom = Number(deps.deployment.denomination)
    const chainId = deps.deployment.chainId

    const q = {
        order: db.prepare("SELECT * FROM orders WHERE id = ?"),
        items: db.prepare("SELECT item_id, name, unit_price, qty, guest FROM order_items WHERE order_id = ? ORDER BY id"),
        shares: db.prepare(
            "SELECT id, order_id, guest, amount, paid, order_ref, status FROM shares WHERE order_id = ? ORDER BY guest"
        ),
        share: db.prepare("SELECT id, order_id, guest, amount, paid, order_ref, status FROM shares WHERE id = ?"),
        shareByRef: db.prepare("SELECT id, order_id, guest, amount, paid, order_ref, status FROM shares WHERE order_ref = ?"),
        payments: db.prepare(
            "SELECT tx_hash, kind, amount FROM payments WHERE share_id = ? ORDER BY id"
        ),
        paymentForShare: db.prepare("SELECT 1 AS hit FROM payments WHERE chain_id = ? AND tx_hash = ? AND share_id = ? LIMIT 1"),
        insertUncredited: db.prepare(
            `INSERT INTO uncredited_payments (share_id, chain_id, tx_hash, log_index, kind, payer, amount, block_number, reason, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`
        )
    }

    // Settling a share is check, verify on-chain, write, with an await in the middle. Submissions
    // for one share run one at a time so the amount still owed is never read stale.
    const shareLocks = new Map<string, Promise<unknown>>()
    async function withShareLock<T>(shareId: string, fn: () => Promise<T>): Promise<T> {
        const prev = shareLocks.get(shareId) ?? Promise.resolve()
        const run = prev.then(fn, fn)
        const tail = run.catch(() => undefined)
        shareLocks.set(shareId, tail)
        try {
            return await run
        } finally {
            if (shareLocks.get(shareId) === tail) shareLocks.delete(shareId)
        }
    }

    // Notes the relayer is submitting right now, per share. They are not in `paid` yet, so
    // without this two concurrent relays could spend two notes on a share that owes one.
    const relaying = new Map<string, number>()

    async function verify(params: Parameters<typeof verifyPaymentTx>[2]): Promise<VerifyResult> {
        try {
            return await verifyPaymentTx(deps.deployment, deps.publicClient, params)
        } catch (err) {
            if (err instanceof FairPayError && err.code === "INVALID_INPUT") throw new HttpError(400, "Malformed payment.")
            console.error("payment verification:", err)
            throw new HttpError(502, "Could not check the payment on-chain right now. Try again shortly.")
        }
    }

    function orderStatus(o: OrderRow) {
        if (o.status === "cooking" && o.ready_at !== null && now() >= o.ready_at) return "ready" as const
        return o.status
    }

    function viewOrder(id: string) {
        const o = q.order.get(id) as OrderRow | undefined
        if (!o) throw new HttpError(404, "No order with that id.")
        const shares = (q.shares.all(id) as ShareRow[]).map((s) => ({
            id: s.id,
            guest: s.guest,
            amount: s.amount,
            paid: s.paid,
            status: s.status,
            orderRef: s.order_ref,
            payments: (q.payments.all(s.id) as { tx_hash: string; kind: string; amount: number }[]).map((p) => ({
                txHash: p.tx_hash,
                kind: p.kind,
                amount: p.amount
            }))
        }))
        return {
            id: o.id,
            table: o.table_no,
            status: orderStatus(o),
            total: o.total,
            createdAt: o.created_at,
            paidAt: o.paid_at,
            readyAt: o.ready_at,
            serverTime: now(),
            items: (q.items.all(id) as { item_id: string; name: string; unit_price: number; qty: number; guest: number }[]).map(
                (i) => ({ id: i.item_id, name: i.name, unitPrice: i.unit_price, qty: i.qty, guest: i.guest })
            ),
            shares
        }
    }

    function canRelay(orderRef: string, merchant: Address) {
        if (merchant !== deps.merchant || !/^0x[0-9a-fA-F]{64}$/.test(orderRef)) return false
        const s = q.shareByRef.get(orderRef.toLowerCase()) as ShareRow | undefined
        if (!s || s.status === "verified") return false
        if (s.amount - s.paid - (relaying.get(s.id) ?? 0) * denom < denom) return false
        const o = q.order.get(s.order_id) as OrderRow
        return o.status === "awaiting_payment"
    }

    /**
     * A payment that is valid on-chain for a share but is not credited (the share was already
     * paid, or the amount is not what it owed) still moved the customer's money to the merchant.
     * It is kept so staff can refund it. Only payments the chain verified are recorded.
     */
    function recordUncredited(shareId: string, p: VerifiedPayment, reason: string) {
        try {
            const r = q.insertUncredited.run(
                shareId,
                p.chainId,
                p.txHash.toLowerCase(),
                p.logIndex,
                p.kind,
                p.payer,
                p.amount.toString(),
                Number(p.blockNumber),
                reason,
                now()
            )
            if (r.changes > 0) {
                const { txHash, logIndex, kind, payer } = p
                console.warn("uncredited payment:", JSON.stringify({ shareId, txHash, logIndex, kind, payer, amount: p.amount.toString(), reason }))
            }
        } catch (err) {
            console.error("could not record uncredited payment", p.txHash, err)
        }
    }

    /**
     * Checks on-chain whether txHash pays `amount` to this share and, if so, records it as
     * uncredited. Never changes the answer the caller gives: a failure here is only logged.
     */
    async function noteUncreditedTx(share: ShareRow, txHash: Hash, amount: number | bigint, reason: string) {
        try {
            const r = await verifyPaymentTx(deps.deployment, deps.publicClient, {
                txHash,
                orderRef: share.order_ref,
                merchant: deps.merchant,
                amount: BigInt(amount)
            })
            if (r.status === "verified") recordUncredited(share.id, r.payment, reason)
            else if (r.status === "rejected") {
                // A different amount than expected, for example one note on a share that was paid.
                const paidAmount = AMOUNT_REJECTED.exec(r.reason)?.[1]
                if (paidAmount === undefined) return
                const again = await verifyPaymentTx(deps.deployment, deps.publicClient, {
                    txHash,
                    orderRef: share.order_ref,
                    merchant: deps.merchant,
                    amount: BigInt(paidAmount)
                })
                if (again.status === "verified") recordUncredited(share.id, again.payment, reason)
            }
        } catch (err) {
            console.warn("could not check an uncredited payment", txHash, err instanceof Error ? err.message.split("\n")[0] : err)
        }
    }

    async function settle(shareId: string, txHash: Hash) {
        const share = q.share.get(shareId) as ShareRow | undefined
        if (!share) throw new HttpError(404, "No share with that id.")
        // Re-submitting a payment that already counts for this share is harmless: answer with the
        // current state so a retried request (or the relayer having settled it) is not an error.
        if (q.paymentForShare.get(chainId, txHash, shareId)) return { status: share.status, order: viewOrder(share.order_id) }
        // Another transaction for a share that is already settled is not counted; say so instead
        // of answering "verified" as if it had been.
        if (share.status === "verified") {
            await noteUncreditedTx(share, txHash, share.amount, "share already paid")
            throw new HttpError(409, "This share is already paid.")
        }

        const remaining = BigInt(share.amount - share.paid)
        const base = { txHash, orderRef: share.order_ref, merchant: deps.merchant }
        let result = await verify({ ...base, amount: remaining })
        // A private share larger than one note is paid with several notes, one transaction each.
        if (result.status === "rejected" && remaining > deps.deployment.denomination && result.reason.startsWith("amount")) {
            const partial = await verify({ ...base, amount: deps.deployment.denomination })
            if (partial.status === "verified" && partial.payment.kind === "private") result = partial
        }
        if (result.status === "pending") return { status: "pending" as const }
        if (result.status === "rejected") {
            const paidAmount = AMOUNT_REJECTED.exec(result.reason)?.[1]
            if (paidAmount !== undefined) await noteUncreditedTx(share, txHash, BigInt(paidAmount), "amount does not match what is owed")
            throw new HttpError(409, `Payment not accepted: ${result.reason}.`)
        }

        const p = result.payment
        const refused = tx(db, () => {
            // Re-read inside the write transaction. The checks above ran before an await and only
            // chose which on-chain facts to look for; these decide what gets credited.
            const fresh = q.share.get(shareId) as ShareRow
            const order = q.order.get(fresh.order_id) as OrderRow
            const owed = fresh.amount - fresh.paid
            const amount = Number(p.amount)
            if (p.chainId !== chainId) throw new HttpError(409, "Payment not accepted: wrong chain.")
            if (fresh.status === "verified" || order.status !== "awaiting_payment") {
                return { message: "This share is already paid.", reason: "share already paid" }
            }
            const exact = amount === owed
            const oneNote = p.kind === "private" && amount === denom && owed > denom
            if (!exact && !oneNote) {
                return {
                    message: "Payment not accepted: amount does not match what is still owed.",
                    reason: "amount does not match what is owed"
                }
            }
            try {
                db.prepare(
                    `INSERT INTO payments (share_id, chain_id, tx_hash, log_index, kind, payer, amount, block_number, verified_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(shareId, p.chainId, p.txHash.toLowerCase(), p.logIndex, p.kind, p.payer, amount, Number(p.blockNumber), now())
            } catch (err) {
                if (isUniqueViolation(err)) throw new HttpError(409, "This payment has already been counted.")
                throw err
            }
            const paid = fresh.paid + amount
            db.prepare("UPDATE shares SET paid = ?, status = ? WHERE id = ?").run(
                paid,
                paid >= fresh.amount ? "verified" : "executed",
                shareId
            )
            const open = db
                .prepare("SELECT COUNT(*) AS n FROM shares WHERE order_id = ? AND status != 'verified'")
                .get(fresh.order_id) as { n: number }
            if (open.n === 0) {
                db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'awaiting_payment'").run(
                    now(),
                    fresh.order_id
                )
            }
            return undefined
        })
        if (refused) {
            recordUncredited(shareId, p, refused.reason)
            throw new HttpError(409, refused.message)
        }
        const after = q.share.get(shareId) as ShareRow
        return { status: after.status, order: viewOrder(share.order_id) }
    }

    return {
        viewOrder,

        createOrder(input: CreateOrderInput) {
            const orderId = randomUUID()
            const perGuest = new Map<number, number>()
            for (const it of input.items) {
                const price = menuById.get(it.id)!.price
                perGuest.set(it.guest, (perGuest.get(it.guest) ?? 0) + price * it.qty)
            }
            const total = [...perGuest.values()].reduce((a, b) => a + b, 0)
            tx(db, () => {
                db.prepare("INSERT INTO orders (id, table_no, status, total, created_at) VALUES (?, ?, 'awaiting_payment', ?, ?)").run(
                    orderId,
                    input.table,
                    total,
                    now()
                )
                const insItem = db.prepare(
                    "INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest) VALUES (?, ?, ?, ?, ?, ?)"
                )
                for (const it of input.items) {
                    const m = menuById.get(it.id)!
                    insItem.run(orderId, m.id, m.name, m.price, it.qty, it.guest)
                }
                const insShare = db.prepare(
                    "INSERT INTO shares (id, order_id, guest, amount, secret, order_ref, status) VALUES (?, ?, ?, ?, ?, ?, 'requested')"
                )
                for (const [guest, amount] of [...perGuest.entries()].sort((a, b) => a[0] - b[0])) {
                    const shareId = randomUUID()
                    const secret = randomSecret()
                    const ref = createOrderRef({ orderId, participantId: shareId, secret })
                    insShare.run(shareId, orderId, guest, amount, secret, ref.toLowerCase())
                }
            })
            return viewOrder(orderId)
        },

        /** True when the relayer should spend gas on a private payment for this reference. */
        canRelay,

        /**
         * Holds one note's worth of a share while the relayer submits it. Returns null when the
         * share has nothing left for another note; otherwise call release() once settled.
         */
        reserveRelay(orderRef: string, merchant: Address) {
            if (!canRelay(orderRef, merchant)) return null
            const s = q.shareByRef.get(orderRef.toLowerCase()) as ShareRow
            relaying.set(s.id, (relaying.get(s.id) ?? 0) + 1)
            let released = false
            return {
                shareId: s.id,
                release() {
                    if (released) return
                    released = true
                    const n = (relaying.get(s.id) ?? 1) - 1
                    if (n <= 0) relaying.delete(s.id)
                    else relaying.set(s.id, n)
                }
            }
        },

        /**
         * Settles a share from an on-chain transaction. The client only supplies a hash; every
         * fact (reference, merchant, amount, success) comes from the chain.
         */
        submitPayment(shareId: string, txHash: Hash) {
            return withShareLock(shareId, () => settle(shareId, txHash.toLowerCase() as Hash))
        },

        kitchenQueue() {
            const since = now() - 6 * 60 * 60 * 1000
            const rows = db
                .prepare(
                    "SELECT * FROM orders WHERE status IN ('paid', 'cooking') AND created_at > ? ORDER BY paid_at, created_at"
                )
                .all(since) as OrderRow[]
            return { serverTime: now(), cookMs: COOK_MS, orders: rows.map((o) => viewOrder(o.id)) }
        },

        startCooking(id: string) {
            const r = db
                .prepare("UPDATE orders SET status = 'cooking', cooking_started_at = ?, ready_at = ? WHERE id = ? AND status = 'paid'")
                .run(now(), now() + COOK_MS, id)
            if (r.changes === 0) throw new HttpError(409, "Only paid orders that are not cooking yet can be started.")
            return viewOrder(id)
        },

        markServed(id: string) {
            const r = db
                .prepare("UPDATE orders SET status = 'served' WHERE id = ? AND status = 'cooking' AND ready_at IS NOT NULL AND ready_at <= ?")
                .run(id, now())
            if (r.changes === 0) throw new HttpError(409, "Only ready orders can be marked served.")
            return viewOrder(id)
        },

        /**
         * Records a faucet claim unless this address claimed within the window. It lives in the
         * database so a restart does not reset it. Returns a function that undoes the claim when
         * the faucet could not pay out, or null when the address must wait.
         */
        claimFaucet(address: Address, windowMs: number) {
            const key = address.toLowerCase()
            const at = now()
            const r = db
                .prepare(
                    `INSERT INTO faucet_claims (address, claimed_at) VALUES (?, ?)
                     ON CONFLICT(address) DO UPDATE SET claimed_at = excluded.claimed_at WHERE claimed_at <= ?`
                )
                .run(key, at, at - windowMs)
            if (r.changes === 0) return null
            return () => {
                db.prepare("DELETE FROM faucet_claims WHERE address = ? AND claimed_at = ?").run(key, at)
            }
        }
    }
}

export type Service = ReturnType<typeof createService>
