// The demo's whole "server database" and "chain state" in one JSON document. It lives in
// localStorage under one key so a kitchen opened in another tab sees the same orders, and falls
// back to memory when the browser refuses to store site data.

export const DEMO_STORE_KEY = "faireats.demo.v1"

export type DemoPayment = { txHash: string; kind: "public" | "private"; amount: number }

export type DemoShare = {
    id: string
    orderId: string
    guest: number
    amount: number
    paid: number
    orderRef: string
    status: "requested" | "executed" | "verified"
    payments: DemoPayment[]
}

export type DemoOrder = {
    id: string
    table: number
    status: "awaiting_payment" | "paid" | "cooking" | "served"
    total: number
    createdAt: number
    paidAt: number | null
    cookingStartedAt: number | null
    readyAt: number | null
    items: { id: string; name: string; unitPrice: number; qty: number; guest: number }[]
    shareIds: string[]
}

/** A simulated transaction. Nothing here was ever sent to a network. */
export type DemoTx = {
    hash: string
    kind: "public" | "private" | "deposit" | "faucet"
    /** Who signed it: the payer for public and deposit, the relayer for private. */
    from: string
    /** Whose money moved: the payer, or the pool for a private payment. */
    payer: string
    to: string
    amount: number
    orderRef?: string
    at: number
}

export type DemoState = {
    v: 1
    orders: Record<string, DemoOrder>
    shares: Record<string, DemoShare>
    chain: {
        /** Address (lowercase) to balances: usdc in micro-USDC, mon in wei as a decimal string. */
        balances: Record<string, { usdc: number; mon: string }>
        txs: Record<string, DemoTx>
        /** Pool deposits in order, as decimal strings, like the real server's indexer returns them. */
        commitments: string[]
        nullifiers: string[]
    }
    seeded: boolean
}

export const emptyState = (): DemoState => ({
    v: 1,
    orders: {},
    shares: {},
    chain: { balances: {}, txs: {}, commitments: [], nullifiers: [] },
    seeded: false
})

export type DemoStore = {
    read(): DemoState
    /** Reads the latest state (another tab may have written), applies `fn`, and saves it. */
    update<T>(fn: (s: DemoState) => T): T
    reset(): void
    /** False when the browser is not saving site data and the state lives only in this tab. */
    readonly persistent: boolean
}

function valid(raw: unknown): raw is DemoState {
    const s = raw as Partial<DemoState> | null
    return !!s && s.v === 1 && typeof s.orders === "object" && typeof s.shares === "object" && typeof s.chain === "object"
}

/** A store backed by `storage` (localStorage in the browser), or by memory when that is unavailable. */
export function createStore(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): DemoStore {
    let memory: DemoState | null = null
    let persistent = false
    if (storage) {
        try {
            const probe = `${DEMO_STORE_KEY}.probe`
            storage.setItem(probe, "1")
            storage.removeItem(probe)
            persistent = true
        } catch {
            persistent = false
        }
    }

    const read = (): DemoState => {
        if (persistent) {
            try {
                const raw = storage!.getItem(DEMO_STORE_KEY)
                if (raw) {
                    const parsed: unknown = JSON.parse(raw)
                    if (valid(parsed)) return parsed
                }
                return memory ?? emptyState()
            } catch {
                return memory ?? emptyState()
            }
        }
        return memory ? (JSON.parse(JSON.stringify(memory)) as DemoState) : emptyState()
    }

    const write = (s: DemoState) => {
        memory = s
        if (!persistent) return
        try {
            storage!.setItem(DEMO_STORE_KEY, JSON.stringify(s))
        } catch {
            // Quota or a storage policy change: keep going in memory for this tab.
        }
    }

    return {
        read,
        update(fn) {
            const s = read()
            const out = fn(s)
            write(s)
            return out
        },
        reset() {
            memory = null
            if (!persistent) return
            try {
                storage!.removeItem(DEMO_STORE_KEY)
            } catch {
                /* ignore */
            }
        },
        get persistent() {
            return persistent
        }
    }
}

const browserStorage = () => {
    try {
        return typeof localStorage === "undefined" ? null : localStorage
    } catch {
        return null
    }
}

/** The store the demo app uses. */
export const store = createStore(browserStorage())
