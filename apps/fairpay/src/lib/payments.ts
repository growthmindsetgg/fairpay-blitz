import {
    createPrivatePayment,
    depositNotes,
    erc20Abi,
    groupFromCommitments,
    isNoteSpent,
    payPublic,
    withdrawNote,
    type Clients,
    type DepositProgress
} from "@fairpay/sdk"
import { getAddress, isAddress, type Hash, type PublicClient } from "viem"
import type { PayKind, PayTarget } from "../../shared/types"
import { api, ApiError } from "./api"
import { usdc } from "./format"
import { createNote, parseNote, serializeNote } from "./notes"
import { safeStorage, type Deployment } from "./wallet"

// Notes are bearer secrets: nothing in this file logs them or sends them anywhere. Only proofs
// (which reveal nothing about the note) leave the browser.

// ------------------------------------------------------------------ errors the UI acts on

/** The wallet lacks USDC or MON for this payment. The UI offers the faucet. */
export class NeedFundsError extends Error {
    constructor(
        readonly need: "usdc" | "gas",
        message: string
    ) {
        super(message)
        this.name = "NeedFundsError"
    }
}

/** The server looked at the transaction and will not count it. Final: retrying won't help. */
export class PaymentRejectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "PaymentRejectedError"
    }
}

export class NotEnoughNotesError extends Error {
    constructor(
        readonly have: number,
        readonly need: number
    ) {
        super(`You need ${need} unspent ${need === 1 ? "note" : "notes"} and have ${have}.`)
        this.name = "NotEnoughNotesError"
    }
}

// ------------------------------------------------------------------ private notes (this device only)

/** `depositTx` / `spentTx` of "0x" mean the chain confirmed it but the transaction hash is unknown. */
export type StoredNote = { note: string; createdAt: number; depositTx?: Hash; spentTx?: Hash }

const HASH = /^0x([0-9a-fA-F]{64})?$/
const notesKey = (d: Deployment) => `fairpay.notes.${d.chainId}.${d.pool.toLowerCase()}`

function sanitize(raw: unknown): StoredNote | null {
    if (typeof raw !== "object" || raw === null) return null
    const n = raw as Record<string, unknown>
    if (typeof n.note !== "string") return null
    return {
        note: n.note,
        createdAt: typeof n.createdAt === "number" && Number.isFinite(n.createdAt) ? n.createdAt : 0,
        depositTx: typeof n.depositTx === "string" && HASH.test(n.depositTx) ? (n.depositTx as Hash) : undefined,
        spentTx: typeof n.spentTx === "string" && HASH.test(n.spentTx) ? (n.spentTx as Hash) : undefined
    }
}

export function loadNotes(d: Deployment): StoredNote[] {
    try {
        const parsed: unknown = JSON.parse(safeStorage.get(notesKey(d)) ?? "[]")
        return Array.isArray(parsed) ? parsed.map(sanitize).filter((n): n is StoredNote => n !== null) : []
    } catch {
        return []
    }
}

const listeners = new Set<() => void>()

/** Calls `cb` whenever notes change in this tab or in another tab of the same browser. */
export function subscribeNotes(d: Deployment, cb: () => void) {
    const key = notesKey(d)
    const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === key) cb()
    }
    listeners.add(cb)
    window.addEventListener("storage", onStorage)
    return () => {
        listeners.delete(cb)
        window.removeEventListener("storage", onStorage)
    }
}

/**
 * Every write re-reads storage and applies a change to the fresh list, so slow chain checks
 * running in parallel can never overwrite a note that was added in the meantime.
 */
function mutateNotes(d: Deployment, fn: (notes: StoredNote[]) => StoredNote[]) {
    const ok = safeStorage.set(notesKey(d), JSON.stringify(fn(loadNotes(d))))
    for (const l of listeners) l()
    return ok
}

function updateNote(d: Deployment, note: string, patch: Partial<StoredNote>) {
    mutateNotes(d, (notes) => notes.map((n) => (n.note === note ? { ...n, ...patch } : n)))
}

export const unspentNotes = (d: Deployment) => loadNotes(d).filter((n) => n.depositTx && !n.spentTx)

/** Notes saved before a deposit that the chain has not confirmed yet. */
export const unconfirmedNotes = (d: Deployment) => loadNotes(d).filter((n) => !n.depositTx)

// One note operation at a time, across tabs where the browser supports it, so two payments
// never pick the same note.
let localQueue: Promise<unknown> = Promise.resolve()
function withNoteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request("fairpay-notes", fn) as Promise<T>
    const run = localQueue.then(fn, fn)
    localQueue = run.catch(() => undefined)
    return run
}

export const commitmentOf = (note: string) => {
    try {
        return String(parseNote(note).identity.commitment)
    } catch {
        return null
    }
}

/**
 * Finds which unconfirmed notes are in the pool. The commitment list comes from the FairPay
 * server, so it is only trusted once it rebuilds a Merkle root the pool recorded on-chain.
 */
async function confirmDeposits(d: Deployment, publicClient: PublicClient, notes: StoredNote[]) {
    const list = await api.commitments()
    const have = new Set(list)
    const found = notes.filter((n) => {
        const c = commitmentOf(n.note)
        return c !== null && have.has(c)
    })
    if (found.length === 0) return new Set<string>()
    await groupFromCommitments(d, publicClient, list)
    return new Set(found.map((n) => n.note))
}

/** Re-checks local notes against the chain: confirms deposits and marks spent notes. Never deletes. */
export async function reconcileNotes(d: Deployment, publicClient: PublicClient) {
    const notes = loadNotes(d)
    const pending = notes.filter((n) => !n.depositTx)
    const deposited = pending.length ? await confirmDeposits(d, publicClient, pending).catch(() => new Set<string>()) : new Set<string>()

    const spent = new Set<string>()
    await Promise.all(
        notes
            .filter((n) => (n.depositTx || deposited.has(n.note)) && !n.spentTx)
            .map(async (n) => {
                try {
                    if (await isNoteSpent(d, publicClient, parseNote(n.note))) spent.add(n.note)
                } catch {
                    /* unreadable note or RPC hiccup: checked again next time */
                }
            })
    )
    if (deposited.size || spent.size) {
        mutateNotes(d, (cur) =>
            cur.map((n) => ({
                ...n,
                depositTx: n.depositTx ?? (deposited.has(n.note) ? ("0x" as Hash) : undefined),
                spentTx: n.spentTx ?? (spent.has(n.note) ? ("0x" as Hash) : undefined)
            }))
        )
    }
    return loadNotes(d)
}

export function isUserRejection(err: unknown) {
    for (let e = err as { code?: unknown; name?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
        if (e.code === 4001 || e.name === "UserRejectedRequestError") return true
    }
    return false
}

async function assertFunds(d: Deployment, clients: Clients, amount: bigint, what: string) {
    const address = clients.walletClient.account.address
    const [mon, bal] = await Promise.all([
        clients.publicClient.getBalance({ address }),
        clients.publicClient.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [address] })
    ])
    if (bal < amount) {
        throw new NeedFundsError("usdc", `Your wallet has ${usdc(Number(bal))}, and ${what} needs ${usdc(Number(amount))}. Get test USDC, then try again.`)
    }
    if (mon === 0n) throw new NeedFundsError("gas", "Your wallet needs a little MON for gas. Get test funds, then try again.")
}

// Gas for adding notes on Monad testnet, which charges the full gas limit (the SDK's estimate plus
// 15%). Typical limits: approve 61k, depositMany of 3 notes 736k, one plain deposit 385k.
// Slightly generous, so the check below only stops a wallet that would fail anyway.
const APPROVE_GAS = 70_000n
const BATCH_GAS = 120_000n
const BATCH_NOTE_GAS = 230_000n
const SINGLE_DEPOSIT_GAS = 400_000n
const MAX_BATCH = 20

/** Gas limit to expect for adding `count` notes, approval included. */
export function topUpGas(d: Deployment, count: number) {
    if (!d.batcher) return APPROVE_GAS + SINGLE_DEPOSIT_GAS * BigInt(count)
    return APPROVE_GAS + BATCH_GAS * BigInt(Math.ceil(count / MAX_BATCH)) + BATCH_NOTE_GAS * BigInt(count)
}

const mon3 = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toFixed(3)

async function assertGas(d: Deployment, clients: Clients, count: number) {
    const address = clients.walletClient.account.address
    const [mon, fees] = await Promise.all([clients.publicClient.getBalance({ address }), clients.publicClient.estimateFeesPerGas()])
    const need = topUpGas(d, count) * (fees.maxFeePerGas ?? 0n)
    if (mon < need) {
        const notes = count === 1 ? "one note" : `${count} notes`
        throw new NeedFundsError(
            "gas",
            `Adding ${notes} needs about ${mon3(need)} MON for gas, and your wallet has ${mon3(mon)}. Get test funds or add fewer notes, then try again.`
        )
    }
}

/** What topUp shows while it runs. The steps depend on the wallet and the allowance, so they arrive with the plan. */
export type TopUpProgress = {
    steps: string[]
    /** Index into `steps`. */
    current: number
    /** How many confirmations to expect, e.g. "Approve once, then confirm one deposit." Empty until known. */
    summary: string
    /** What to do right now, e.g. "Transaction 1 of 2: allow 55.00 USDC. Confirm in your wallet." */
    detail: string
}

const CHECK_STEP = "Check your balance"

function planText(p: Extract<DepositProgress, { step: "plan" }>, count: number) {
    const notes = count === 1 ? "1 note" : `${count} notes`
    if (p.atomic) return { steps: [CHECK_STEP, `Approve and deposit ${notes}`], summary: "Confirm once in your wallet: it approves and deposits together." }
    const deposit = p.deposits === 1 ? `Deposit ${notes}` : `Deposit ${notes} (${p.deposits} transactions)`
    const steps = [CHECK_STEP, ...(p.approve ? ["Approve USDC"] : []), deposit]
    const deposits = p.deposits === 1 ? "one deposit" : `${p.deposits} deposits`
    const summary = p.approve ? `Approve once, then confirm ${deposits}.` : `Confirm ${deposits} in your wallet.`
    return { steps, summary }
}

/**
 * Adds `count` notes to the private balance with as few wallet confirmations as the deployment and
 * wallet allow: one approval and one deposit per 20 notes through the batcher, or a single atomic
 * batch on a wallet that supports EIP-5792. Every note is saved in this browser before the
 * transaction that deposits it is sent; all of them are saved before the first prompt.
 */
export function topUp(d: Deployment, clients: Clients, count: number, onProgress: (p: TopUpProgress) => void) {
    return withNoteLock(async () => {
        let view: TopUpProgress = { steps: [CHECK_STEP, "Deposit from your wallet"], current: 0, summary: "", detail: "" }
        const show = (patch: Partial<TopUpProgress>) => onProgress((view = { ...view, ...patch }))
        show({})
        await assertFunds(d, clients, d.denomination * BigInt(count), count === 1 ? "one note" : `${count} notes`)
        await assertGas(d, clients, count)

        const notes = Array.from({ length: count }, () => createNote(d))
        const serialized = new Map(notes.map((n) => [n.identity.commitment, serializeNote(n)]))
        const mine = new Set(serialized.values())
        const createdAt = Date.now()
        mutateNotes(d, (stored) => [...stored, ...[...mine].map((note) => ({ note, createdAt }))])
        // Without a stored copy a deposit would be unspendable, so refuse to send anything.
        const saved = new Set(loadNotes(d).map((n) => n.note))
        if (![...mine].every((n) => saved.has(n))) {
            mutateNotes(d, (stored) => stored.filter((n) => !mine.has(n.note)))
            throw new Error("This browser is not saving data for this site, so new notes could be lost. Allow site data, then try again.")
        }

        let prompted = false
        let total = 0
        let sent = 0
        try {
            await depositNotes(d, clients, notes, {
                onProgress: (p) => {
                    if (p.step === "plan") {
                        const { steps, summary } = planText(p, count)
                        total = p.confirmations
                        sent = 0
                        show({ steps, summary, current: 1, detail: summary })
                        return
                    }
                    prompted = true
                    sent++
                    const of = total > 1 ? `Transaction ${sent} of ${total}: ` : ""
                    if (p.step === "atomic") show({ current: 1, detail: "Confirm once in your wallet." })
                    else if (p.step === "approve") show({ current: 1, detail: `${of}allow ${usdc(Number(p.amount))}. Confirm in your wallet.` })
                    else show({ current: view.steps.length - 1, detail: `${of}deposit ${p.notes === 1 ? "1 note" : `${p.notes} notes`}. Confirm in your wallet.` })
                },
                onDeposited: (done) => {
                    for (const n of done) updateNote(d, serialized.get(n.note.identity.commitment)!, { depositTx: n.txHash })
                }
            })
        } catch (err) {
            // Nothing is sent before the first wallet prompt, and a declined prompt sends nothing; every
            // earlier transaction was confirmed (and its notes marked) before the next prompt. In those
            // cases the notes still without a deposit can never hold funds, so drop them. Otherwise a
            // transaction may be out there: keep the notes, and reconcileNotes confirms them later.
            if (!prompted || isUserRejection(err)) {
                mutateNotes(d, (stored) => stored.filter((n) => !(mine.has(n.note) && !n.depositTx)))
            }
            throw err
        }
    })
}

const BACKUP_FORMAT = "fairpay-notes-v1"
// FairEats used the same note format and pool, so its backups restore here too.
const ACCEPTED_FORMATS = new Set([BACKUP_FORMAT, "faireats-notes-v1"])

export function exportNotes(d: Deployment) {
    return JSON.stringify({ format: BACKUP_FORMAT, chainId: d.chainId, pool: d.pool, notes: loadNotes(d) }, null, 2)
}

const MAX_BACKUP_BYTES = 1_000_000
const MAX_BACKUP_NOTES = 2_000

export class BackupError extends Error {}

/**
 * Restores notes from a backup file made by exportNotes. The file is only parsed as JSON and
 * checked; deposit and spent status always come from the chain, never from the file.
 */
export async function restoreNotes(d: Deployment, publicClient: PublicClient, text: string) {
    if (text.length > MAX_BACKUP_BYTES) throw new BackupError("That file is too large to be a notes backup.")
    let data: unknown
    try {
        data = JSON.parse(text)
    } catch {
        throw new BackupError("That file is not a FairPay notes backup.")
    }
    const b = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
    if (typeof b.format !== "string" || !ACCEPTED_FORMATS.has(b.format) || !Array.isArray(b.notes)) {
        throw new BackupError("That file is not a FairPay notes backup.")
    }
    if (b.chainId !== d.chainId) throw new BackupError(`This backup is for another network (chain ${String(b.chainId).slice(0, 12)}).`)
    const pool = getAddress(d.pool)
    if (typeof b.pool !== "string" || !isAddress(b.pool) || getAddress(b.pool) !== pool) {
        throw new BackupError("This backup belongs to a different privacy pool.")
    }
    if (b.notes.length > MAX_BACKUP_NOTES) throw new BackupError("That backup has more notes than this app accepts.")

    const known = new Set(loadNotes(d).map((n) => commitmentOf(n.note)))
    const fresh: StoredNote[] = []
    let duplicates = 0
    let skipped = 0
    for (const raw of b.notes) {
        const entry = sanitize(raw)
        let commitment: string
        try {
            if (!entry || entry.note.length > 4096) throw new Error()
            const parsed = parseNote(entry.note)
            if (parsed.chainId !== d.chainId || getAddress(parsed.pool) !== pool) throw new Error()
            commitment = String(parsed.identity.commitment)
        } catch {
            skipped++
            continue
        }
        if (known.has(commitment)) {
            duplicates++
            continue
        }
        known.add(commitment)
        fresh.push({ note: entry!.note, createdAt: entry!.createdAt || Date.now() })
    }
    if (fresh.length) {
        const ok = mutateNotes(d, (notes) => {
            const have = new Set(notes.map((n) => n.note))
            return [...notes, ...fresh.filter((n) => !have.has(n.note))]
        })
        if (!ok) throw new BackupError("This browser is not saving data for this site. Allow site data, then try again.")
        await reconcileNotes(d, publicClient).catch(() => undefined)
    }
    return { added: fresh.length, duplicates, skipped }
}

// ------------------------------------------------------------------ payments waiting for confirmation

// A sent payment is remembered until the server counts it, so a lost connection or a reload
// leads to "check again" instead of paying a second time.
export type Pending = { txHash: Hash; mode: "public" | "private"; at: number }
const pendingKey = (d: Deployment) => `fairpay.pending.${d.chainId}`
const targetKey = (kind: PayKind, id: string) => `${kind}:${id}`

function loadPending(d: Deployment): Record<string, Pending> {
    try {
        const raw: unknown = JSON.parse(safeStorage.get(pendingKey(d)) ?? "{}")
        const out: Record<string, Pending> = {}
        if (typeof raw !== "object" || raw === null) return out
        for (const [id, p] of Object.entries(raw as Record<string, Partial<Pending>>)) {
            if (p && typeof p.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(p.txHash) && (p.mode === "public" || p.mode === "private")) {
                out[id] = { txHash: p.txHash as Hash, mode: p.mode, at: typeof p.at === "number" ? p.at : 0 }
            }
        }
        return out
    } catch {
        return {}
    }
}

function setPending(d: Deployment, key: string, p: Pending | null) {
    const all = loadPending(d)
    if (p) all[key] = p
    else delete all[key]
    safeStorage.set(pendingKey(d), JSON.stringify(all))
}

export const pendingPayment = (d: Deployment, kind: PayKind, id: string): Pending | undefined => loadPending(d)[targetKey(kind, id)]
export const forgetPending = (d: Deployment, kind: PayKind, id: string) => setPending(d, targetKey(kind, id), null)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Asks the server to count a transaction, retrying while the chain hasn't confirmed it yet. */
async function settleLoop(kind: PayKind, id: string, txHash: Hash, token: string | null | undefined): Promise<PayTarget> {
    for (let i = 0; i < 40; i++) {
        let r: Awaited<ReturnType<typeof api.settle>> | null = null
        try {
            r = await api.settle(kind, id, txHash, token)
        } catch (err) {
            // The server couldn't reach the chain, or we couldn't reach the server: the payment is
            // still out there, so keep asking rather than give up (it is remembered as pending).
            const transient = err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504)
            if (!transient || i === 39) throw err
        }
        if (r?.status === "credited") return r.target
        if (r?.status === "rejected") throw new PaymentRejectedError(r.reason)
        // "pending": the server waits for enough confirmations before it counts a payment.
        await sleep(1500)
    }
    throw new ApiError(504, "The payment was sent but is taking longer than usual to confirm.")
}

async function settleTracked(d: Deployment, kind: PayKind, id: string, txHash: Hash, mode: Pending["mode"], token?: string | null) {
    const key = targetKey(kind, id)
    setPending(d, key, { txHash, mode, at: Date.now() })
    try {
        const t = await settleLoop(kind, id, txHash, token)
        setPending(d, key, null)
        return t
    } catch (err) {
        // The server gave a final answer about this transaction; a retry would not change it.
        if (err instanceof PaymentRejectedError) setPending(d, key, null)
        if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 400)) setPending(d, key, null)
        throw err
    }
}

/** Asks the server again about a payment that was sent but not confirmed. Undefined when nothing is pending. */
export async function retryPending(d: Deployment, kind: PayKind, id: string, token?: string | null) {
    const p = pendingPayment(d, kind, id)
    if (!p) return undefined
    return settleTracked(d, kind, id, p.txHash, p.mode, token)
}

// ------------------------------------------------------------------ paying a target

/** Steps shown while paying. `onStep(index, detail?)` reports progress against these. */
export const PUBLIC_STEPS = ["Check your balance", "Confirm in your wallet", "Verify on Monad"]
export const PRIVATE_STEPS = ["Check your notes", "Build the proof in this browser", "Relayer sends the payment", "Verify on Monad"]

export type OnStep = (index: number, detail?: string) => void

/** Public payment from the connected wallet: approve the exact amount, then pay through FairPay. */
export async function payTargetPublic(d: Deployment, clients: Clients, target: PayTarget, token: string | null | undefined, onStep: OnStep) {
    if (target.due <= 0) throw new Error("Nothing is due on this share.")
    // The server only hands the reference to someone who may pay this share (see PayTarget).
    const orderRef = target.orderRef
    if (!orderRef) throw new Error("This share is tied to another wallet, so it can't be paid publicly from this one.")
    onStep(0)
    const amount = BigInt(target.due)
    await assertFunds(d, clients, amount, "this payment")
    onStep(1, "Your wallet may ask twice: once to allow the exact amount, once to pay.")
    const { txHash } = await payPublic(d, clients, { merchant: target.recipient, amount, orderRef })
    onStep(2)
    const paid = await settleTracked(d, target.kind, target.id, txHash, "public", token)
    return { target: paid, txHash }
}

/**
 * Pays with notes. The proof is built here in the browser; only the proof goes to the relayer,
 * so the note never leaves this device and the wallet that deposited it is not linked to the payment.
 */
export function payTargetPrivate(d: Deployment, publicClient: PublicClient, target: PayTarget, token: string | null | undefined, onStep: OnStep) {
    return withNoteLock(async () => {
        if (!target.private.possible) throw new Error(target.private.reason)
        const orderRef = target.orderRef
        if (!orderRef) throw new Error("This share can't be paid from here. Reload the page and try again.")
        const needed = target.private.notes
        onStep(0)
        await reconcileNotes(d, publicClient)
        const notes = unspentNotes(d).slice(0, needed)
        if (notes.length < needed) throw new NotEnoughNotesError(unspentNotes(d).length, needed)

        onStep(0, "Loading the pool")
        const group = await loadGroupContaining(d, publicClient, notes.map((n) => parseNote(n.note).identity.commitment))

        let last: { target: PayTarget; txHash: Hash } | undefined
        for (const [i, stored] of notes.entries()) {
            const label = needed > 1 ? `Note ${i + 1} of ${needed}` : undefined
            onStep(1, label)
            const request = await createPrivatePayment(d, publicClient, {
                note: parseNote(stored.note),
                merchant: target.recipient,
                orderRef,
                group
            })
            onStep(2, label)
            // The relayer answers only after the payment succeeded on-chain, so the note is spent from here on.
            const { txHash } = await api.relay(request)
            updateNote(d, stored.note, { spentTx: txHash })
            onStep(3, label)
            last = { target: await settleTracked(d, target.kind, target.id, txHash, "private", token), txHash }
        }
        return last!
    })
}

/** Waits briefly for the server's indexer to catch up with a deposit made moments ago. */
async function loadGroupContaining(d: Deployment, publicClient: PublicClient, commitments: bigint[]) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const list = await api.commitments()
        const have = new Set(list)
        if (commitments.every((c) => have.has(String(c)))) return groupFromCommitments(d, publicClient, list)
        await sleep(2000)
    }
    throw new Error("The pool has not picked up your latest deposit yet. Try again in a few seconds.")
}

/** Counts pool deposits and how many are this device's, for the "who you blend in with" line. */
export async function poolSize(d: Deployment) {
    const list = new Set(await api.commitments())
    const mine = loadNotes(d).filter((n) => {
        const c = commitmentOf(n.note)
        return c !== null && list.has(c)
    }).length
    return { deposits: list.size, mine }
}

// ------------------------------------------------------------------ withdrawing a note

/** Steps shown while withdrawing one note. */
export const WITHDRAW_STEPS = ["Check your notes", "Build the proof in this browser", "Confirm in your wallet", "Withdraw on Monad"]

// Gas limit for one FairPool.withdraw on Monad testnet, which charges the full limit (the SDK's
// estimate plus 15%; a relayed payment, which does a little more, is about 1.44M). Slightly
// generous, so the check below only stops a wallet that would fail anyway.
export const WITHDRAW_GAS = 1_500_000n

/**
 * Withdraws the oldest unspent note to the connected wallet. This is a normal transaction from
 * that wallet (it pays the gas), so it is public. The proof is built here; the note never leaves
 * the browser. On success the note is marked spent locally; the chain (nullifierSpent) stays the
 * source of truth, and reconcileNotes marks it if the receipt was lost.
 */
export function withdrawOne(d: Deployment, clients: Clients, onStep: OnStep) {
    return withNoteLock(async () => {
        const { publicClient, walletClient } = clients
        const recipient = walletClient.account.address
        onStep(0)
        await reconcileNotes(d, publicClient)
        const stored = unspentNotes(d)[0]
        if (!stored) throw new NotEnoughNotesError(0, 1)

        const [mon, fees] = await Promise.all([publicClient.getBalance({ address: recipient }), publicClient.estimateFeesPerGas()])
        const need = WITHDRAW_GAS * (fees.maxFeePerGas ?? 0n)
        if (mon < need) {
            throw new NeedFundsError("gas", `Withdrawing needs about ${mon3(need)} MON for gas, and your wallet has ${mon3(mon)}. Get test funds, then try again.`)
        }

        onStep(0, "Loading the pool")
        const note = parseNote(stored.note)
        const group = await loadGroupContaining(d, publicClient, [note.identity.commitment])
        let sent = false
        try {
            const txHash = await withdrawNote({
                walletClient,
                publicClient,
                deployment: d,
                note,
                recipient,
                group,
                onProgress: (p) => {
                    if (p.step === "prove") onStep(1, "Usually 5-15 seconds.")
                    else if (p.step === "confirm") onStep(2, "Your wallet asks once.")
                    else {
                        sent = true
                        onStep(3)
                    }
                }
            })
            updateNote(d, stored.note, { spentTx: txHash })
            return { txHash, recipient }
        } catch (err) {
            // Once sent, the chain decides: if the withdrawal landed after all, mark the note spent.
            if (sent) await reconcileNotes(d, publicClient).catch(() => undefined)
            throw err
        }
    })
}
