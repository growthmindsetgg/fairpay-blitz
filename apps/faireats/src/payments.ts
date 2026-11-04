import {
    createPrivatePayment,
    depositNote,
    groupFromCommitments,
    isNoteSpent,
    payPublic,
    submitToRelayer,
    type Clients,
    type FairPayDeployment
} from "@fairpay/sdk"
import { getAddress, isAddress, type Address, type Hash, type PublicClient } from "viem"
import { api, API_BASE, ApiError, settle, type Share } from "./api"
import { createNote, parseNote, serializeNote } from "./notes"
import { safeStorage } from "./wallet"

// The static demo build (VITE_DEMO=1) swaps the chain, prover and relayer for simulated ones with
// the same shapes, so everything below runs its real code path. Constant `undefined` in the real
// build, where the SDK functions are used and no demo code is bundled.
const sim = import.meta.env.VITE_DEMO === "1" ? (await import("./demo")).sim : undefined
// Each choice tests the build-time constant directly, so the minifier can drop the unused side:
// in the demo build that removes the prover (and its proving-file URLs) from the bundle.
const chain = {
    depositNote: import.meta.env.VITE_DEMO === "1" ? sim!.depositNote : depositNote,
    groupFromCommitments: import.meta.env.VITE_DEMO === "1" ? sim!.groupFromCommitments : groupFromCommitments,
    isNoteSpent: import.meta.env.VITE_DEMO === "1" ? sim!.isNoteSpent : isNoteSpent,
    createPrivatePayment: import.meta.env.VITE_DEMO === "1" ? sim!.createPrivatePayment : createPrivatePayment,
    submitToRelayer:
        import.meta.env.VITE_DEMO === "1"
            ? (_url: string, request: Parameters<typeof submitToRelayer>[1]) => api.relay(request).then((r) => ({ txHash: r.txHash }))
            : submitToRelayer,
    payPublic: (d: FairPayDeployment, clients: Clients, params: Parameters<typeof payPublic>[2], onStep: (s: string) => void) =>
        import.meta.env.VITE_DEMO === "1" ? sim!.payPublic(d, clients, params, onStep) : payPublic(d, clients, params)
}
/** Lets a simulated step stay on screen long enough to read. No-op in the real build. */
const simPause = (ms: number) => (sim ? sim.pause(ms) : Promise.resolve())

// Notes are bearer secrets: nothing in this file logs them or sends them anywhere. Only proofs
// (which reveal nothing about the note) leave the browser.

// ------------------------------------------------------------------ private notes (this device only)

/** `depositTx` / `spentTx` of "0x" mean the chain confirmed it but the transaction hash is unknown. */
export type StoredNote = { note: string; createdAt: number; depositTx?: Hash; spentTx?: Hash }

const HASH = /^0x([0-9a-fA-F]{64})?$/
const notesKey = (d: FairPayDeployment) => `faireats.notes.${d.chainId}.${d.pool!.toLowerCase()}`

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

export function loadNotes(d: FairPayDeployment): StoredNote[] {
    try {
        const parsed: unknown = JSON.parse(safeStorage.get(notesKey(d)) ?? "[]")
        return Array.isArray(parsed) ? parsed.map(sanitize).filter((n): n is StoredNote => n !== null) : []
    } catch {
        return []
    }
}

const listeners = new Set<() => void>()

/** Calls `cb` whenever notes change in this tab or in another tab of the same browser. */
export function subscribeNotes(d: FairPayDeployment, cb: () => void) {
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
function mutateNotes(d: FairPayDeployment, fn: (notes: StoredNote[]) => StoredNote[]) {
    const ok = safeStorage.set(notesKey(d), JSON.stringify(fn(loadNotes(d))))
    for (const l of listeners) l()
    return ok
}

function updateNote(d: FairPayDeployment, note: string, patch: Partial<StoredNote>) {
    mutateNotes(d, (notes) => notes.map((n) => (n.note === note ? { ...n, ...patch } : n)))
}

export const unspentNotes = (d: FairPayDeployment) => loadNotes(d).filter((n) => n.depositTx && !n.spentTx)

/** Notes saved before a deposit that the chain has not confirmed yet. */
export const unconfirmedNotes = (d: FairPayDeployment) => loadNotes(d).filter((n) => !n.depositTx)

// One note operation at a time, across tabs where the browser supports it, so two payments
// never pick the same note.
let localQueue: Promise<unknown> = Promise.resolve()
function withNoteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request("faireats-notes", fn) as Promise<T>
    const run = localQueue.then(fn, fn)
    localQueue = run.catch(() => undefined)
    return run
}

const commitmentOf = (note: string) => {
    try {
        return String(parseNote(note).identity.commitment)
    } catch {
        return null
    }
}

/**
 * Finds which unconfirmed notes are in the pool. The commitment list comes from the restaurant's
 * server, so it is only trusted once it rebuilds a Merkle root the pool recorded on-chain.
 */
async function confirmDeposits(d: FairPayDeployment, publicClient: PublicClient, notes: StoredNote[]) {
    const list = await api.commitments()
    const have = new Set(list)
    const found = notes.filter((n) => {
        const c = commitmentOf(n.note)
        return c !== null && have.has(c)
    })
    if (found.length === 0) return new Set<string>()
    await chain.groupFromCommitments(d, publicClient, list)
    return new Set(found.map((n) => n.note))
}

/** Re-checks local notes against the chain: confirms deposits and marks spent notes. Never deletes. */
export async function reconcileNotes(d: FairPayDeployment, publicClient: PublicClient) {
    const notes = loadNotes(d)
    const pending = notes.filter((n) => !n.depositTx)
    const deposited = pending.length ? await confirmDeposits(d, publicClient, pending).catch(() => new Set<string>()) : new Set<string>()

    const spent = new Set<string>()
    await Promise.all(
        notes
            .filter((n) => (n.depositTx || deposited.has(n.note)) && !n.spentTx)
            .map(async (n) => {
                try {
                    if (await chain.isNoteSpent(d, publicClient, parseNote(n.note))) spent.add(n.note)
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

function isUserRejection(err: unknown) {
    for (let e = err as { code?: unknown; name?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
        if (e.code === 4001 || e.name === "UserRejectedRequestError") return true
    }
    return false
}

/** Adds `count` notes to the private balance. Each note is saved before its deposit is sent. */
export function topUp(d: FairPayDeployment, clients: Clients, count: number, onStep: (s: string) => void) {
    return withNoteLock(async () => {
        for (let i = 0; i < count; i++) {
            const note = createNote(d)
            const serialized = serializeNote(note)
            mutateNotes(d, (notes) => [...notes, { note: serialized, createdAt: Date.now() }])
            // Without a stored copy the deposit would be unspendable, so refuse to send it.
            if (!loadNotes(d).some((n) => n.note === serialized)) {
                throw new Error("This browser is not saving data for this site, so a new note could be lost. Allow site data, then try again.")
            }
            onStep(count > 1 ? `Adding note ${i + 1} of ${count}…` : "Adding a note…")
            let txHash: Hash
            try {
                ;({ txHash } = await chain.depositNote(d, clients, note))
            } catch (err) {
                // A rejected signature means nothing was broadcast, so this note can never hold funds.
                if (isUserRejection(err)) mutateNotes(d, (notes) => notes.filter((n) => n.note !== serialized))
                throw err
            }
            updateNote(d, serialized, { depositTx: txHash })
        }
    })
}

export function exportNotes(d: FairPayDeployment) {
    return JSON.stringify({ format: "faireats-notes-v1", chainId: d.chainId, pool: d.pool, notes: loadNotes(d) }, null, 2)
}

const MAX_BACKUP_BYTES = 1_000_000
const MAX_BACKUP_NOTES = 2_000

export class BackupError extends Error {}

/**
 * Restores notes from a backup file made by exportNotes. The file is only parsed as JSON and
 * checked; deposit and spent status always come from the chain, never from the file.
 */
export async function restoreNotes(d: FairPayDeployment, publicClient: PublicClient, text: string) {
    if (text.length > MAX_BACKUP_BYTES) throw new BackupError("That file is too large to be a notes backup.")
    let data: unknown
    try {
        data = JSON.parse(text)
    } catch {
        throw new BackupError("That file is not a FairEats notes backup.")
    }
    const b = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
    if (b.format !== "faireats-notes-v1" || !Array.isArray(b.notes)) throw new BackupError("That file is not a FairEats notes backup.")
    if (b.chainId !== d.chainId) throw new BackupError(`This backup is for another network (chain ${String(b.chainId).slice(0, 12)}).`)
    const pool = getAddress(d.pool!)
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
type Pending = { txHash: Hash; kind: "public" | "private"; at: number }
const pendingKey = (d: FairPayDeployment) => `faireats.pending.${d.chainId}`

function loadPending(d: FairPayDeployment): Record<string, Pending> {
    try {
        const raw: unknown = JSON.parse(safeStorage.get(pendingKey(d)) ?? "{}")
        const out: Record<string, Pending> = {}
        if (typeof raw !== "object" || raw === null) return out
        for (const [id, p] of Object.entries(raw as Record<string, Partial<Pending>>)) {
            if (p && typeof p.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(p.txHash) && (p.kind === "public" || p.kind === "private")) {
                out[id] = { txHash: p.txHash as Hash, kind: p.kind, at: typeof p.at === "number" ? p.at : 0 }
            }
        }
        return out
    } catch {
        return {}
    }
}

function setPending(d: FairPayDeployment, shareId: string, p: Pending | null) {
    const all = loadPending(d)
    if (p) all[shareId] = p
    else delete all[shareId]
    safeStorage.set(pendingKey(d), JSON.stringify(all))
}

export const pendingPayment = (d: FairPayDeployment, shareId: string): Pending | undefined => loadPending(d)[shareId]
export const forgetPending = (d: FairPayDeployment, shareId: string) => setPending(d, shareId, null)

async function settleTracked(d: FairPayDeployment, shareId: string, txHash: Hash, kind: Pending["kind"]) {
    setPending(d, shareId, { txHash, kind, at: Date.now() })
    try {
        const r = await settle(shareId, txHash)
        setPending(d, shareId, null)
        return r
    } catch (err) {
        // The server gave a final answer about this transaction; a retry would not change it.
        if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 400)) setPending(d, shareId, null)
        throw err
    }
}

/** Asks the server again about a payment that was sent but not confirmed. */
export async function retryPending(d: FairPayDeployment, shareId: string) {
    const p = pendingPayment(d, shareId)
    if (!p) return undefined
    try {
        return await settleTracked(d, shareId, p.txHash, p.kind)
    } catch (err) {
        // Already counted (for example by another tab) is a success for the customer.
        if (err instanceof ApiError && err.status === 409 && /already been counted/i.test(err.message)) return undefined
        throw err
    }
}

// ------------------------------------------------------------------ paying a share

export async function payShareInPublic(
    d: FairPayDeployment,
    clients: Clients,
    merchant: Address,
    share: Share,
    onStep: (s: string) => void
) {
    onStep("Confirm the payment in your wallet…")
    const params = { merchant, amount: BigInt(share.amount - share.paid), orderRef: share.orderRef }
    const { txHash } = await chain.payPublic(d, clients, params, onStep)
    onStep("Checking the payment on-chain…")
    await simPause(700)
    return settleTracked(d, share.id, txHash, "public")
}

/**
 * Pays a share with notes. The proof is built here in the browser; only the proof goes to the
 * relayer, so the note never leaves this device and the wallet that deposited it stays hidden.
 */
export function payShareInPrivate(
    d: FairPayDeployment & { denomination: bigint },
    publicClient: PublicClient,
    merchant: Address,
    share: Share,
    onStep: (s: string) => void
) {
    return withNoteLock(async () => {
        const needed = Math.ceil((share.amount - share.paid) / Number(d.denomination))
        onStep("Checking your notes…")
        await simPause(500)
        await reconcileNotes(d, publicClient)
        const notes = unspentNotes(d).slice(0, needed)
        if (notes.length < needed) throw new Error(`You need ${needed} unspent notes and have ${notes.length}.`)

        onStep("Loading the pool…")
        const group = await loadGroupContaining(d, publicClient, notes.map((n) => parseNote(n.note).identity.commitment))

        let last: Awaited<ReturnType<typeof settle>> | undefined
        for (const [i, stored] of notes.entries()) {
            const label = needed > 1 ? ` ${i + 1} of ${needed}` : ""
            onStep(`Building your private proof${label}…`)
            const request = await chain.createPrivatePayment(d, publicClient, { note: parseNote(stored.note), merchant, orderRef: share.orderRef, group })
            onStep(`Sending through the relayer${label}…`)
            // The relayer answers only after the payment succeeded on-chain, so the note is spent from here on.
            await simPause(600)
            const { txHash } = await chain.submitToRelayer(`${API_BASE}/relay`, request)
            updateNote(d, stored.note, { spentTx: txHash })
            onStep("Checking the payment on-chain…")
            await simPause(500)
            last = await settleTracked(d, share.id, txHash, "private")
        }
        return last!
    })
}

/** Waits briefly for the server's indexer to catch up with a deposit made moments ago. */
async function loadGroupContaining(d: FairPayDeployment, publicClient: PublicClient, commitments: bigint[]) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const list = await api.commitments()
        const have = new Set(list)
        if (commitments.every((c) => have.has(String(c)))) return chain.groupFromCommitments(d, publicClient, list)
        await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error("The pool has not picked up your latest deposit yet. Try again in a few seconds.")
}
