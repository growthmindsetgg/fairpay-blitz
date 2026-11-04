import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { FairPayError, type VerifiedPayment, type VerifyResult } from "@fairpay/sdk"
import { getAddress, type Address, type Hash, type Hex } from "viem"
import { formatUsdc } from "../../shared/money.js"
import type { PayKind, PayTarget, SettleResult, Wallet } from "../../shared/types.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { HttpError, limit, rateLimiter, readJson } from "../http.js"
import { advanceKitchen, assignInvoiceNo, estimateReadyAt } from "../faireats.js"
import { addActivity } from "./activity.js"

const HASH32 = /^0x[0-9a-fA-F]{64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** One payable share, either kind, with what settling and access checks need. */
type Target = {
    kind: PayKind
    id: string
    /** Bill id or order id. */
    parentId: string
    recipient: Wallet
    recipientName: string
    amount: number
    tip: number
    paid: number
    status: "owed" | "paid" | "covered"
    orderRef: Hex
    expectedPayer: Wallet | null
    /** The bill is open / the order is awaiting payment. */
    open: boolean
    /** Bill status / order status, as stored. */
    parentStatus: string
    shareToken: string
    /** Who this share belongs to: participant name or order share label. */
    label: string
    /** Bill title, or "<restaurant>, table 4". */
    title: string
    creator: Wallet | null
    restaurant: { id: string; ownerWallet: Wallet; placedBy: Wallet | null } | null
}

type BillRow = {
    id: string
    bill_id: string
    wallet: Wallet | null
    display_name: string
    amount: number
    tip: number
    paid: number
    status: "owed" | "paid" | "covered"
    order_ref: Hex
    creator: Wallet
    recipient: Wallet
    title: string
    bill_status: string
    share_token: string
    recipient_name: string | null
}

type OrderRow = {
    id: string
    order_id: string
    label: string
    amount: number
    tip: number
    paid: number
    status: "owed" | "paid"
    order_ref: Hex
    order_status: string
    share_token: string
    placed_by: Wallet | null
    restaurant_id: string
    restaurant_name: string
    payout_wallet: Wallet
    owner_wallet: Wallet
    table_label: string | null
}

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
const usd = (micro: number) => formatUsdc(micro, { symbol: true })

function sameString(a: string, b: string) {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

// With lock, the parent (bill / order) is locked first and then the share with it, the same
// order every other writer uses (cancel, expiry, invoice numbering), so they can't deadlock. A
// locked read sees the latest committed parent status, so a cancel can't slip between the check
// and the credit.
async function loadBill(q: Db, where: "id" | "order_ref", value: string, lock: boolean): Promise<Target | undefined> {
    if (lock) await q.query(`SELECT 1 FROM bills WHERE id = (SELECT bill_id FROM bill_participants WHERE ${where} = $1) FOR UPDATE`, [value])
    const r = await q.one<BillRow>(
        `SELECT p.id, p.bill_id, p.wallet, p.display_name, p.amount, p.tip, p.paid, p.status, p.order_ref,
                b.creator, b.recipient, b.title, b.status AS bill_status, b.share_token, pr.display_name AS recipient_name
         FROM bill_participants p
         JOIN bills b ON b.id = p.bill_id
         LEFT JOIN profiles pr ON pr.wallet = b.recipient
         WHERE p.${where} = $1${lock ? " FOR UPDATE OF p, b" : ""}`,
        [value]
    )
    if (!r) return undefined
    return {
        kind: "bill",
        id: r.id,
        parentId: r.bill_id,
        recipient: r.recipient,
        recipientName: r.recipient_name ?? short(r.recipient),
        amount: r.amount,
        tip: r.tip,
        paid: r.paid,
        status: r.status,
        orderRef: r.order_ref,
        expectedPayer: r.wallet,
        open: r.bill_status === "open",
        parentStatus: r.bill_status,
        shareToken: r.share_token,
        label: r.display_name,
        title: r.title,
        creator: r.creator,
        restaurant: null
    }
}

async function loadOrder(q: Db, where: "id" | "order_ref", value: string, lock: boolean): Promise<Target | undefined> {
    if (lock) await q.query(`SELECT 1 FROM orders WHERE id = (SELECT order_id FROM order_shares WHERE ${where} = $1) FOR UPDATE`, [value])
    const r = await q.one<OrderRow>(
        `SELECT s.id, s.order_id, s.label, s.amount, s.tip, s.paid, s.status, s.order_ref,
                o.status AS order_status, o.share_token, o.placed_by, o.restaurant_id,
                r.name AS restaurant_name, r.owner_wallet, t.label AS table_label,
                -- The payout wallet when the order was placed (orders from before that column: today's).
                COALESCE(o.payout_wallet, r.payout_wallet) AS payout_wallet
         FROM order_shares s
         JOIN orders o ON o.id = s.order_id
         JOIN restaurants r ON r.id = o.restaurant_id
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
         WHERE s.${where} = $1${lock ? " FOR UPDATE OF s, o" : ""}`,
        [value]
    )
    if (!r) return undefined
    return {
        kind: "order",
        id: r.id,
        parentId: r.order_id,
        recipient: r.payout_wallet,
        recipientName: r.restaurant_name,
        amount: r.amount,
        tip: r.tip,
        paid: r.paid,
        status: r.status,
        orderRef: r.order_ref,
        expectedPayer: null,
        open: r.order_status === "awaiting_payment",
        parentStatus: r.order_status,
        shareToken: r.share_token,
        label: r.label,
        title: r.table_label ? `${r.restaurant_name}, table ${r.table_label}` : r.restaurant_name,
        creator: null,
        restaurant: { id: r.restaurant_id, ownerWallet: r.owner_wallet, placedBy: r.placed_by }
    }
}

function loadTarget(q: Db, kind: PayKind, id: string, lock = false) {
    return kind === "bill" ? loadBill(q, "id", id, lock) : loadOrder(q, "id", id, lock)
}

const dueOf = (t: Target) => (t.status === "covered" ? 0 : Math.max(0, t.amount + t.tip - t.paid))

export type RelayHold = { kind: PayKind; id: string; release: () => void }

/**
 * Viewing, rounding up and settling payable shares. One instance per database, shared by the pay
 * routes and the relayer (routes/chain.ts) so they use the same per-target locks.
 */
function createPayService(deps: Deps) {
    const denom = Number(deps.chain.deployment.denomination)
    const chainId = deps.chain.deployment.chainId

    // Settling is check, verify on-chain, write, with awaits in between. Work on one target runs
    // one at a time so what is still owed is never read stale. The row lock inside the write
    // transaction covers other server processes.
    const locks = new Map<string, Promise<unknown>>()
    async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = locks.get(key) ?? Promise.resolve()
        const run = prev.then(fn, fn)
        const tail = run.catch(() => undefined)
        locks.set(key, tail)
        try {
            return await run
        } finally {
            if (locks.get(key) === tail) locks.delete(key)
        }
    }

    // Notes the relayer is submitting right now, per target. They are not in `paid` yet, so
    // without this two concurrent relays could spend two notes on a share that owes one.
    const relaying = new Map<string, number>()
    // Relay holds kept after the relayer could not settle its note itself, by transaction hash.
    const unsettledHolds = new Map<string, RelayHold[]>()
    function releaseUnsettled(txHash: string, targetId: string) {
        const key = txHash.toLowerCase()
        const holds = unsettledHolds.get(key)
        if (!holds) return
        for (const h of holds) if (h.id === targetId) h.release()
        const rest = holds.filter((h) => h.id !== targetId)
        if (rest.length > 0) unsettledHolds.set(key, rest)
        else unsettledHolds.delete(key)
    }

    async function isMerchant(w: Wallet): Promise<boolean | null> {
        try {
            return await deps.chain.isMerchant(getAddress(w))
        } catch (err) {
            console.warn("isMerchant:", err instanceof Error ? err.message.split("\n")[0] : err)
            return null
        }
    }

    /** `viewer` decides whether the bound payer wallet is shown (see PayTarget.expectedPayer). */
    async function view(t: Target, viewer: Wallet | null): Promise<PayTarget> {
        const due = dueOf(t)
        let priv: PayTarget["private"]
        if (t.status !== "owed" || due <= 0) {
            priv = { possible: false, reason: "Nothing is left to pay." }
        } else if (!t.open) {
            priv = { possible: false, reason: t.kind === "bill" ? "This bill is no longer open." : "This order is no longer taking payments." }
        } else {
            const merchant = await isMerchant(t.recipient)
            if (merchant === null) {
                priv = { possible: false, reason: "Couldn't check confidential payments right now. Try again shortly." }
            } else if (!merchant) {
                priv = {
                    possible: false,
                    reason:
                        t.kind === "bill"
                            ? "Confidential payments are for verified businesses today, so shares between friends are paid publicly."
                            : "This restaurant isn't verified for confidential payments yet."
                }
            } else {
                // Whole notes only: the last note may cover more than is due, and the difference
                // is recorded as a tip when that note is verified (settleLocked), never before.
                const notes = Math.ceil(due / denom)
                priv = { possible: true, notes, tip: notes * denom - due }
            }
        }
        // Who a share is bound to is for that person, the bill's creator and its recipient. A
        // link holder only learns that it is bound.
        const showPayer = t.expectedPayer !== null && viewer !== null && (viewer === t.expectedPayer || viewer === t.creator || viewer === t.recipient)
        // The orderRef finds this share's payments on-chain, and a public payment names the payer's
        // wallet. So only someone who may pay the share now gets it: anyone while it isn't bound to
        // a wallet, that wallet once it is, or anyone when it can be paid confidentially (the pool
        // hides who pays). Nothing to pay means nobody needs it.
        const mayPay = t.status === "owed" && due > 0 && t.open && (t.expectedPayer === null || viewer === t.expectedPayer || priv.possible)
        return {
            kind: t.kind,
            id: t.id,
            recipient: t.recipient,
            recipientName: t.recipientName,
            amount: t.amount,
            tip: t.tip,
            paid: t.paid,
            due,
            orderRef: mayPay ? t.orderRef : null,
            status: t.status,
            private: priv,
            expectedPayer: showPayer ? t.expectedPayer : null,
            payerLocked: t.expectedPayer !== null
        }
    }

    /**
     * Bill shares: the creator, the recipient, a participant, or whoever holds the bill's link.
     * Order shares: whoever holds the order's link, or restaurant staff.
     */
    async function canAccess(t: Target, viewer: Wallet | null, token: string | undefined): Promise<boolean> {
        if (token && sameString(token, t.shareToken)) return true
        if (!viewer) return false
        if (t.kind === "bill") {
            if (viewer === t.creator || viewer === t.recipient) return true
            return !!(await deps.db.one("SELECT 1 FROM bill_participants WHERE bill_id = $1 AND wallet = $2", [t.parentId, viewer]))
        }
        if (viewer === t.restaurant!.ownerWallet) return true
        return !!(await deps.db.one("SELECT 1 FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2", [t.restaurant!.id, viewer]))
    }

    async function load(kind: PayKind, id: string, viewer: Wallet | null, token: string | undefined): Promise<Target> {
        const t = ID.test(id) ? await loadTarget(deps.db, kind, id) : undefined
        // The same answer for "doesn't exist" and "not yours", so ids can't be probed.
        if (!t || !(await canAccess(t, viewer, token))) throw new HttpError(404, "No payment with that id.")
        return t
    }

    async function verify(params: Parameters<Deps["chain"]["verify"]>[0]): Promise<VerifyResult> {
        try {
            return await deps.chain.verify(params)
        } catch (err) {
            if (err instanceof FairPayError && err.code === "INVALID_INPUT") throw new HttpError(400, "Malformed payment.")
            console.error("payment verification:", err instanceof Error ? err.message.split("\n")[0] : err)
            throw new HttpError(502, "Could not check the payment on-chain right now. Try again shortly.")
        }
    }

    async function settleLocked(kind: PayKind, id: string, txHash: Hash, viewer: Wallet | null): Promise<SettleResult> {
        const t = await loadTarget(deps.db, kind, id)
        if (!t) throw new HttpError(404, "No payment with that id.")

        // A transaction that already counts for this target: answer with the current state, so a
        // retried request (or the relayer having settled it) is not an error.
        const seen = await deps.db.one(
            "SELECT 1 FROM payments WHERE target_kind = $1 AND target_id = $2 AND chain_id = $3 AND tx_hash = $4",
            [kind, id, chainId, txHash]
        )
        if (seen) return { status: "credited", target: await view(t, viewer) }
        if (t.status === "covered") return settleClosed(t, txHash, "This share doesn't need paying in FairPay.")
        if (t.status === "paid") return settleClosed(t, txHash, "This share is already paid.")
        if (!t.open) return settleClosed(t, txHash, t.kind === "bill" ? "This bill is no longer open." : "This order is no longer taking payments.")

        const due = dueOf(t)
        const base = {
            txHash,
            orderRef: t.orderRef,
            merchant: getAddress(t.recipient) as Address,
            ...(t.expectedPayer ? { expectedPayer: getAddress(t.expectedPayer) as Address } : {})
        }
        // A public payment is exactly what is due. A confidential one is exactly one note: several
        // notes pay a larger share, one transaction each, and the last may cover more than is due.
        let result = await verify({ ...base, amount: BigInt(due) })
        if (result.status === "rejected" && due !== denom && result.reason.startsWith("amount")) {
            const note = await verify({ ...base, amount: BigInt(denom) })
            if (note.status === "verified" && note.payment.kind === "private") result = note
        }
        if (result.status === "pending") return { status: "pending", reason: "Waiting for the transaction to be confirmed." }
        if (result.status === "rejected") {
            // A seat bound to a wallet, paid from another one: the money still reached the
            // recipient, so tell them (it isn't credited, because the seat belongs to its wallet).
            if (t.expectedPayer && result.reason.startsWith("paid from a different wallet")) {
                const stray = await verify({ txHash, orderRef: t.orderRef, merchant: base.merchant, amount: BigInt(due) }).catch(() => null)
                if (stray?.status === "verified") {
                    await deps.db.tx((q) => flagUncredited(q, t, stray.payment, Number(stray.payment.amount), "it came from a different wallet than the one on this seat", deps.now()))
                }
            }
            return { status: "rejected", reason: `Payment not accepted: ${result.reason}.` }
        }

        const p = result.payment
        if (p.chainId !== chainId) return { status: "rejected", reason: "Payment not accepted: wrong chain." }
        const amount = Number(p.amount)
        if (!Number.isSafeInteger(amount) || amount <= 0) return { status: "rejected", reason: "Payment not accepted: bad amount." }
        const now = deps.now()

        const outcome = await deps.db.tx(async (q): Promise<{ rejected: string } | { target: Target }> => {
            // Re-read under row locks on the share and its bill / order. The checks above ran
            // before an await and only chose which on-chain facts to look for; these decide what
            // gets credited, against the parent's current status.
            const fresh = (await loadTarget(q, kind, id, true))!
            const freshDue = dueOf(fresh)
            if (fresh.status !== "owed" || !fresh.open || freshDue <= 0) {
                await flagUncredited(q, fresh, p, amount, whyClosed(fresh), now)
                return { rejected: "This share is already paid or closed." }
            }
            // The last confidential note pays more than is left: the difference is a tip to the
            // recipient, recorded in the same update, so paid always equals amount + tip at the end.
            const extra = p.kind === "private" && amount === denom && amount > freshDue ? amount - freshDue : 0
            const credit = extra > 0 ? amount : Math.min(amount, freshDue)
            const inserted = await q.one(
                `INSERT INTO payments (target_kind, target_id, chain_id, tx_hash, log_index, kind, payer, recipient, amount, block_number, verified_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING RETURNING id`,
                [kind, id, p.chainId, p.txHash.toLowerCase(), p.logIndex, p.kind, p.payer.toLowerCase(), fresh.recipient, amount, Number(p.blockNumber), now]
            )
            if (!inserted) return { rejected: "This payment has already been counted." }

            const paid = fresh.paid + credit
            const tip = fresh.tip + extra
            const done = paid >= fresh.amount + tip
            const table = kind === "bill" ? "bill_participants" : "order_shares"
            await q.query(`UPDATE ${table} SET paid = $2, tip = $3, status = $4, paid_at = $5 WHERE id = $1`, [
                id,
                paid,
                tip,
                done ? "paid" : "owed",
                done ? now : null
            ])
            const after: Target = { ...fresh, paid, tip, status: done ? "paid" : "owed" }
            await notifyPayment(q, after, p.kind, p.kind === "public" ? (p.payer.toLowerCase() as Wallet) : null, credit, extra, now)
            // Paid more than was left (another payment landed first): the rest isn't credited.
            const over = amount - credit
            if (over > 0) await flagUncredited(q, after, p, over, "it was more than was left to pay", now)
            if (done && kind === "bill") await maybeSettleBill(q, after, now)
            if (done && kind === "order") await maybeMarkOrderPaid(q, after, now)
            return { target: after }
        })
        if ("rejected" in outcome) {
            // The money moved on-chain but isn't credited here; log it so staff can refund.
            console.warn("uncredited payment:", JSON.stringify({ kind, id, txHash, logIndex: p.logIndex, amount: String(p.amount), reason: outcome.rejected }))
            return { status: "rejected", reason: outcome.rejected }
        }
        return { status: "credited", target: await view(outcome.target, viewer) }
    }

    /**
     * Money reached the restaurant for an order that was cancelled (by staff or by expiry) after
     * the guest paid on-chain. Nothing is credited, so tell the owner what to refund.
     */
    async function notifyRefund(q: Db, t: Target, p: VerifiedPayment, now: number) {
        const r = t.restaurant!
        const tx = p.txHash.toLowerCase()
        // The browser and the relayer may both settle the same transaction: one note per tx.
        const already = await q.one("SELECT 1 FROM activity WHERE wallet = $1 AND kind = 'order_update' AND title LIKE 'Refund needed%' AND detail LIKE $2", [
            r.ownerWallet,
            `%${tx}%`
        ])
        if (already) return
        const amount = Number(p.amount)
        const detail =
            p.kind === "private"
                ? `${usd(amount)} paid confidentially for ${t.title} after the order was cancelled (tx ${tx}). The payer can't be identified; refund them if they show this payment.`
                : `${usd(amount)} from ${p.payer.toLowerCase()} for ${t.title} after the order was cancelled (tx ${tx}). Send it back to that wallet.`
        await addActivity(q, { wallet: r.ownerWallet, kind: "order_update", title: `Refund needed: ${usd(amount)}`, detail, link: `/business/faireats/manage/${r.id}` }, now)
    }

    /** Why a share that isn't open for payment can't take this one, for the recipient's note. */
    function whyClosed(t: Target): string {
        if (t.status === "covered") return "the share was already settled outside FairPay"
        if (t.status === "paid" || dueOf(t) <= 0) return "the share was already paid"
        if (t.kind === "bill") return `the bill is ${t.parentStatus}`
        return `the order is ${t.parentStatus.replace("_", " ")}`
    }

    /**
     * A share that is paid, covered or closed (bill cancelled or settled, order no longer awaiting
     * payment): nothing is credited. The transaction is still checked, because money can land
     * after a share closed (two tabs, a cancel or an expiry in between). If it is a real payment
     * for this share, its recipient is told, so they can refund it.
     */
    async function settleClosed(t: Target, txHash: Hash, reason: string): Promise<SettleResult> {
        let found: VerifiedPayment | "pending" | null = null
        try {
            found = await findLatePayment(t, txHash)
        } catch {
            // The RPC is down: the answer is still no.
        }
        if (found === "pending") return { status: "pending", reason: "Waiting for the transaction to be confirmed." }
        if (found) {
            const p = found
            await deps.db.tx((q) => flagUncredited(q, t, p, Number(p.amount), whyClosed(t), deps.now()))
            console.warn("uncredited payment:", JSON.stringify({ kind: t.kind, id: t.id, txHash, logIndex: p.logIndex, amount: String(p.amount), reason }))
            const to = t.kind === "bill" ? t.recipientName : "the restaurant"
            return { status: "rejected", reason: `${reason} Your payment wasn't counted; ${to} has been told, so they can refund it.` }
        }
        return { status: "rejected", reason }
    }

    /**
     * The payment this transaction made to a closed share, if any. What was due when it was sent
     * isn't known any more, so try the likely amounts: what is left, the whole share, one note.
     * Any payer counts here: this only decides whether to tell the recipient, never what to credit.
     */
    async function findLatePayment(t: Target, txHash: Hash): Promise<VerifiedPayment | "pending" | null> {
        const amounts = [...new Set([t.amount + t.tip - t.paid, t.amount + t.tip, t.amount, denom])].filter((a) => a > 0)
        for (const amount of amounts) {
            const r = await verify({ txHash, orderRef: t.orderRef, merchant: getAddress(t.recipient) as Address, amount: BigInt(amount) })
            if (r.status === "verified") return r.payment.chainId === chainId ? r.payment : null
            // Mined but not confirmed enough yet: worth asking again. Not found at all: give up.
            if (r.status === "pending") return r.confirmations > 0n ? "pending" : null
            if (!r.reason.startsWith("amount")) return null
        }
        return null
    }

    /**
     * Tells a share's recipient (the bill's recipient, or the restaurant owner) about money that
     * arrived on-chain but wasn't credited: `amount` of payment `p`, not counted because `why`. A
     * cancelled order gets the refund note. One note per transaction. Like every activity row, a
     * confidential payment's never names the payer or the seat.
     */
    async function flagUncredited(q: Db, t: Target, p: VerifiedPayment, amount: number, why: string, now: number) {
        if (t.kind === "order" && t.parentStatus === "cancelled") return notifyRefund(q, t, p, now)
        const to = t.kind === "bill" ? t.recipient : t.restaurant!.ownerWallet
        const tx = p.txHash.toLowerCase()
        const already = await q.one("SELECT 1 FROM activity WHERE wallet = $1 AND title LIKE 'Payment not counted%' AND detail LIKE $2", [to, `%${tx}%`])
        if (already) return
        const detail =
            p.kind === "private"
                ? `${usd(amount)} paid confidentially for ${t.title} wasn't counted because ${why} (tx ${tx}). The payer can't be identified; refund them if they show this payment.`
                : `${usd(amount)} from ${p.payer.toLowerCase()} for ${t.title} (${t.label}) wasn't counted because ${why} (tx ${tx}). Send it back to that wallet if it isn't owed to you.`
        const link = t.kind === "bill" ? `/bills/${t.parentId}` : `/business/faireats/manage/${t.restaurant!.id}`
        // Orders use the owner's order feed (as refunds do); bills the payment feed.
        const kind = t.kind === "bill" ? "payment_received" : "order_update"
        await addActivity(q, { wallet: to, kind, title: `Payment not counted: ${usd(amount)}`, detail, link }, now)
    }

    async function notifyPayment(q: Db, t: Target, kind: "public" | "private", payer: Wallet | null, credit: number, tip: number, now: number) {
        const to = t.kind === "bill" ? t.recipient : t.restaurant!.ownerWallet
        const link = t.kind === "bill" ? `/bills/${t.parentId}` : `/business/faireats/manage/${t.restaurant!.id}`
        // A confidential payment's text never says who paid: not the wallet, not the seat's name.
        if (kind === "private") {
            const withTip = tip > 0 ? ` (includes a ${usd(tip)} tip)` : ""
            await addActivity(q, { wallet: to, kind: "payment_received", title: "Confidential payment received", detail: `${usd(credit)} for ${t.title}${withTip}`, link }, now)
            return
        }
        await addActivity(q, { wallet: to, kind: "payment_received", title: `${t.label} paid ${usd(credit)}`, detail: t.title, link }, now)
        if (payer && payer !== to) {
            const mine = t.kind === "bill" ? `/bills/${t.parentId}` : null
            await addActivity(q, { wallet: payer, kind: "payment_sent", title: `You paid ${usd(credit)}`, detail: `${t.title} (to ${t.recipientName})`, link: mine }, now)
        }
    }

    async function maybeSettleBill(q: Db, t: Target, now: number) {
        const open = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM bill_participants WHERE bill_id = $1 AND status = 'owed'", [t.parentId])
        if ((open?.n ?? 1) > 0) return
        const settled = await q.one<{ creator: Wallet; recipient: Wallet }>(
            "UPDATE bills SET status = 'settled', settled_at = $2 WHERE id = $1 AND status = 'open' RETURNING creator, recipient",
            [t.parentId, now]
        )
        if (!settled) return
        const link = `/bills/${t.parentId}`
        for (const w of new Set([settled.creator, settled.recipient])) {
            await addActivity(q, { wallet: w, kind: "bill_settled", title: `${t.title} is settled`, detail: "Everyone has paid.", link }, now)
        }
    }

    async function maybeMarkOrderPaid(q: Db, t: Target, now: number) {
        const open = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM order_shares WHERE order_id = $1 AND status <> 'paid'", [t.parentId])
        if ((open?.n ?? 1) > 0) return
        // Wait-time rule and invoice numbers belong to server/faireats.ts (Builder C).
        const est = await estimateReadyAt(q, t.parentId, now)
        const paid = await q.one<{ share_token: string }>(
            "UPDATE orders SET status = 'paid', paid_at = $2, est_ready_at = $3 WHERE id = $1 AND status = 'awaiting_payment' RETURNING share_token",
            [t.parentId, now, Math.round(est)]
        )
        if (!paid) return
        // Same transaction, so an invoice number is never skipped or given twice.
        await assignInvoiceNo(q, t.parentId, now)
        // Paid and verified: the kitchen starts it straight away (server/faireats.ts).
        await advanceKitchen(q, { orderId: t.parentId }, now)
        const r = t.restaurant!
        const minutes = Math.max(0, Math.ceil((est - now) / 60_000))
        await addActivity(
            q,
            { wallet: r.ownerWallet, kind: "order_update", title: `Order paid: ${t.title}`, detail: `Cooking now, ready in about ${minutes} min.`, link: `/business/faireats/manage/${r.id}` },
            now
        )
        if (r.placedBy && r.placedBy !== r.ownerWallet) {
            await addActivity(
                q,
                {
                    wallet: r.placedBy,
                    kind: "order_update",
                    title: "Your order is paid",
                    detail: `${t.title}. Ready in about ${minutes} min.`,
                    link: `/o/${t.parentId}?t=${encodeURIComponent(paid.share_token)}`
                },
                now
            )
        }
    }

    return {
        load,
        view,
        /**
         * Settles a target from an on-chain transaction. Every fact comes from the chain. `viewer`
         * only shapes the PayTarget in the answer (whether the bound payer is shown).
         */
        async settle(kind: PayKind, id: string, txHash: Hash, viewer: Wallet | null = null): Promise<SettleResult> {
            const hash = txHash.toLowerCase() as Hash
            const result = await withLock(`${kind}:${id}`, () => settleLocked(kind, id, hash, viewer))
            if (result.status !== "pending") releaseUnsettled(hash, id)
            return result
        },

        /**
         * Keeps a relay hold after its note was spent on-chain but not credited yet, so another
         * relay can't spend one note too many. Released when that transaction is settled, or
         * after `graceMs`.
         */
        keepHold(txHash: Hash, hold: RelayHold, graceMs: number) {
            const key = txHash.toLowerCase()
            const timer = setTimeout(() => releaseUnsettled(key, hold.id), graceMs)
            timer.unref?.()
            const entry: RelayHold = {
                ...hold,
                release: () => {
                    clearTimeout(timer)
                    hold.release()
                }
            }
            unsettledHolds.set(key, [...(unsettledHolds.get(key) ?? []), entry])
        },

        /**
         * Holds one note's worth of a share while the relayer submits it. Null when the reference
         * isn't an open, privately payable share for this merchant with a note still owed;
         * "in-flight" when every note it still owes is already being relayed or confirmed.
         */
        async reserveRelay(orderRef: string, merchant: Address): Promise<RelayHold | "in-flight" | null> {
            if (!HASH32.test(orderRef)) return null
            const ref = orderRef.toLowerCase()
            const t = (await loadBill(deps.db, "order_ref", ref, false)) ?? (await loadOrder(deps.db, "order_ref", ref, false))
            if (!t || t.status !== "owed" || !t.open) return null
            if (getAddress(merchant) !== getAddress(t.recipient)) return null
            if ((await isMerchant(t.recipient)) !== true) return null
            const key = `${t.kind}:${t.id}`
            // No await from here on: check and count together, so concurrent relays can't both pass.
            // A due that isn't whole notes needs one more note; its extra is a tip at settle time.
            const notes = Math.ceil(dueOf(t) / denom)
            const inFlight = relaying.get(key) ?? 0
            if (inFlight >= notes) return "in-flight"
            relaying.set(key, inFlight + 1)
            let released = false
            return {
                kind: t.kind,
                id: t.id,
                release() {
                    if (released) return
                    released = true
                    const n = (relaying.get(key) ?? 1) - 1
                    if (n <= 0) relaying.delete(key)
                    else relaying.set(key, n)
                }
            }
        }
    }
}

export type PayService = ReturnType<typeof createPayService>

const services = new WeakMap<Db, PayService>()
/** The pay service for this database (one per Db, so locks are shared across route modules). */
export function payService(deps: Deps): PayService {
    let s = services.get(deps.db)
    if (!s) {
        s = createPayService(deps)
        services.set(deps.db, s)
    }
    return s
}

function parseKind(v: string): PayKind {
    if (v !== "bill" && v !== "order") throw new HttpError(404, "Not found.")
    return v
}

export const ROUND_UP_GONE = "Round-up is automatic now: the last private note covers the difference as a tip."

/** GET /pay/:kind/:id, POST /pay/:kind/:id/settle {txHash}. POST .../round-up is gone (410). */
export function payRoutes(deps: Deps) {
    const app = new Hono<AppEnv>()
    const svc = payService(deps)
    const limits = {
        settle: rateLimiter(60, 60_000, deps.now)
    }

    // The share link token comes as ?t= (or `t` in a POST body).
    const tokenOf = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : undefined)

    app.get("/pay/:kind/:id", async (c) => {
        const viewer = c.get("wallet")
        const t = await svc.load(parseKind(c.req.param("kind")), c.req.param("id"), viewer, tokenOf(c.req.query("t")))
        return c.json(await svc.view(t, viewer))
    })

    // Tips aren't stored up front: the last confidential note settles any difference, so this
    // endpoint only answers 410.
    app.post("/pay/:kind/:id/round-up", () => {
        throw new HttpError(410, ROUND_UP_GONE)
    })

    app.post("/pay/:kind/:id/settle", async (c) => {
        limit(c, limits.settle)
        const body = await readJson(c, 4 * 1024)
        const kind = parseKind(c.req.param("kind"))
        const viewer = c.get("wallet")
        const t = await svc.load(kind, c.req.param("id"), viewer, tokenOf(c.req.query("t")) ?? tokenOf(body.t))
        if (typeof body.txHash !== "string" || !HASH32.test(body.txHash)) throw new HttpError(400, "txHash must be a transaction hash.")
        const result = await svc.settle(kind, t.id, body.txHash as Hash, viewer)
        return c.json(result, result.status === "pending" ? 202 : 200)
    })

    return app
}
