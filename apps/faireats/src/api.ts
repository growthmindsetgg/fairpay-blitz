import type { Address, Hash, Hex } from "viem"

// The static demo build (VITE_DEMO=1) answers every request from a server simulated in the
// browser. In the real build this is a constant `undefined` and the demo code is not bundled.
const demo = import.meta.env.VITE_DEMO === "1" ? await import("./demo") : undefined

/** Where API requests go. The demo uses a non-URL prefix, so nothing can reach a network. */
export const API_BASE: string = demo ? demo.DEMO_API_BASE : "/api"

export type PublicConfig = {
    chainId: number
    rpcUrl: string
    explorer: string
    token: Address
    fairPay: Address
    pool: Address
    poolDeployBlock: string
    denomination: string
    merchant: Address
    maxGuests: number
    restaurant: { name: string; tagline: string; tables: number }
}

export type MenuItem = {
    id: string
    name: string
    description: string
    category: string
    price: number
}

export type Share = {
    id: string
    guest: number
    amount: number
    paid: number
    status: "requested" | "executed" | "verified"
    orderRef: Hex
    payments: { txHash: Hash; kind: "public" | "private"; amount: number }[]
}

export type Order = {
    id: string
    table: number
    status: "awaiting_payment" | "paid" | "cooking" | "ready" | "served"
    total: number
    createdAt: number
    paidAt: number | null
    readyAt: number | null
    serverTime: number
    items: { id: string; name: string; unitPrice: number; qty: number; guest: number }[]
    shares: Share[]
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

async function call<T>(path: string, init?: RequestInit & { pin?: string }): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (init?.pin) headers["x-kitchen-pin"] = init.pin
    if (demo) {
        const r = await demo.demoCall(path, { method: init?.method, body: init?.body, pin: init?.pin })
        if (r.status >= 400) throw new ApiError(r.status, (r.data as { error?: string }).error ?? `Request failed (${r.status}).`)
        return { status: r.status, data: r.data as T }
    }
    const res = await fetch(path, { ...init, headers })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status}).`)
    return { status: res.status, data: data as T }
}

const post = (body: unknown, pin?: string): RequestInit & { pin?: string } => ({
    method: "POST",
    body: JSON.stringify(body),
    pin
})

export const api = {
    config: () => call<PublicConfig>(`${API_BASE}/config`).then((r) => r.data),
    menu: () => call<{ items: MenuItem[] }>(`${API_BASE}/menu`).then((r) => r.data.items),
    createOrder: (body: { table: number; guests: number; items: { id: string; qty: number; guest: number }[] }) =>
        call<Order>(`${API_BASE}/orders`, post(body)).then((r) => r.data),
    order: (id: string) => call<Order>(`${API_BASE}/orders/${encodeURIComponent(id)}`).then((r) => r.data),
    submitPayment: (shareId: string, txHash: Hash) =>
        call<{ status: "pending" | Share["status"]; order?: Order }>(
            `${API_BASE}/shares/${encodeURIComponent(shareId)}/payments`,
            post({ txHash })
        ),
    /** Hands a private payment to the restaurant's relayer (the SDK's submitToRelayer does the same with fetch). */
    relay: (request: unknown) => call<{ txHash: Hash }>(`${API_BASE}/relay`, post(request)).then((r) => r.data),
    commitments: () => call<{ commitments: string[] }>(`${API_BASE}/pool/commitments`).then((r) => r.data.commitments),
    faucet: (address: Address) => call<{ minted: string; gasSent: string }>(`${API_BASE}/faucet`, post({ address })).then((r) => r.data),
    kitchen: (pin: string) =>
        call<{ serverTime: number; cookMs: number; orders: Order[] }>(`${API_BASE}/kitchen`, { pin }).then((r) => r.data),
    startCooking: (id: string, pin: string) =>
        call<Order>(`${API_BASE}/kitchen/orders/${encodeURIComponent(id)}/start`, post({}, pin)).then((r) => r.data),
    markServed: (id: string, pin: string) =>
        call<Order>(`${API_BASE}/kitchen/orders/${encodeURIComponent(id)}/served`, post({}, pin)).then((r) => r.data)
}

/** Settles a payment on the server, retrying while the transaction is still unconfirmed. */
export async function settle(shareId: string, txHash: Hash) {
    for (let i = 0; i < 30; i++) {
        const r = await api.submitPayment(shareId, txHash)
        if (r.status !== 202) return r.data
        await new Promise((res) => setTimeout(res, 1500))
    }
    throw new ApiError(504, "The payment was sent but is taking longer than usual to confirm.")
}

export const usdc = (micro: number | bigint) => {
    const n = Number(micro) / 1_000_000
    return `${Number.isInteger(n) ? n : n.toFixed(2)} USDC`
}
