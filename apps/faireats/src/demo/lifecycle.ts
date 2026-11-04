// Demo setup and teardown: first-visit seed, the simulated wallet, and "Reset demo".

import { toHex, type Address } from "viem"
import { createNote, serializeNote } from "./notes"
import { chain, demoClients, demoPublicClient, fakeHash, randomBytes } from "./chain"
import { DEMO_KITCHEN_PIN, DEMO_MARKER, DEMO_WALLET, OTHER_DEPOSITS, REAL, SEED_NOTES } from "./config"
import { DEMO_STORE_KEY, store } from "./store"

/** Prefix api.ts uses instead of "/api" in the demo, so no request path looks like a URL. */
export const DEMO_API_BASE = "demo:"

export const publicClient = demoPublicClient(chain)

/** The simulated wallet: a fixed fake address, no key. */
export const demoWallet = () => ({ kind: "demo" as const, address: DEMO_WALLET as Address, clients: demoClients(DEMO_WALLET, chain) })

export const BROWSER_WALLET_OFF = "The demo uses a simulated wallet only. Connect your own wallet in the real app."

const notesKey = `faireats.notes.${REAL.chainId}.${REAL.pool.toLowerCase()}`
const pendingKey = `faireats.pending.${REAL.chainId}`
const RESET_FLAG = "faireats.demo.justReset"
const KITCHEN_PIN_KEY = "faireats.kitchenPin"

const local = {
    get(k: string) {
        try {
            return localStorage.getItem(k)
        } catch {
            return null
        }
    },
    set(k: string, v: string) {
        try {
            localStorage.setItem(k, v)
        } catch {
            /* storage blocked: the demo runs in memory for this tab */
        }
    },
    remove(k: string) {
        try {
            localStorage.removeItem(k)
        } catch {
            /* ignore */
        }
    }
}

/** A random field element as a decimal string, standing in for other people's pool deposits. */
const otherCommitment = () => (BigInt(toHex(randomBytes(31))) || 1n).toString()

/**
 * First visit: two notes "added earlier" plus 23 deposits by other (simulated) people, so a
 * private payment works straight away and the crowd is not empty.
 */
function seed() {
    if (store.read().seeded) return
    const deployment = { chainId: REAL.chainId, token: REAL.token, fairPay: REAL.fairPay, pool: REAL.pool }
    const mine = Array.from({ length: SEED_NOTES }, () => createNote(deployment))
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    const stored = mine.map((n, i) => ({ note: serializeNote(n), createdAt: twoDaysAgo + i * 3_600_000, depositTx: fakeHash() }))
    store.update((s) => {
        const others = Array.from({ length: OTHER_DEPOSITS }, otherCommitment)
        // Ours sit in the middle of the list, among other people's deposits.
        const at = Math.floor(others.length / 2)
        s.chain.commitments = [...others.slice(0, at), ...mine.map((n) => String(n.identity.commitment)), ...others.slice(at)]
        s.seeded = true
    })
    let existing: unknown[] = []
    try {
        const parsed: unknown = JSON.parse(local.get(notesKey) ?? "[]")
        if (Array.isArray(parsed)) existing = parsed
    } catch {
        /* unreadable: replaced below */
    }
    local.set(notesKey, JSON.stringify([...existing, ...stored]))
}

/** Runs once before the first render of the demo build. */
export function installDemo() {
    seed()
    // The kitchen screen opens straight away with the demo PIN; the banner shows the PIN too.
    try {
        if (!sessionStorage.getItem(KITCHEN_PIN_KEY)) sessionStorage.setItem(KITCHEN_PIN_KEY, DEMO_KITCHEN_PIN)
    } catch {
        /* ignore */
    }
    document.documentElement.dataset.demo = DEMO_MARKER
}

/** True when the browser is not saving site data, so other tabs cannot see this tab's demo. */
export const demoStorageBlocked = () => !store.persistent

/** Clears the simulated orders, wallet and notes from this browser, then reloads the demo. */
export function resetDemo(baseUrl = "/") {
    store.reset()
    for (const k of [DEMO_STORE_KEY, notesKey, pendingKey, "faireats.walletMode", "faireats.demoKey"]) local.remove(k)
    try {
        sessionStorage.setItem(RESET_FLAG, "1")
    } catch {
        /* the status line is skipped */
    }
    location.assign(baseUrl)
}

/** True once after a reset, so the banner can say so. */
export function consumeResetFlag() {
    try {
        const was = sessionStorage.getItem(RESET_FLAG) === "1"
        sessionStorage.removeItem(RESET_FLAG)
        return was
    } catch {
        return false
    }
}

/** A simulated transaction, for receipts. Undefined when it is not in this browser's demo. */
export const simulatedTx = (hash: string) => chain.tx(hash)
