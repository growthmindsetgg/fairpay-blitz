// The restaurant's server, simulated in the browser. Same routes, rules, messages and response
// shapes as server/app.ts and server/service.ts, but payments are checked against the simulated
// chain instead of Monad. No route here makes a network call.

import { createOrderRef, randomSecret } from "@fairpay/sdk"
import { getAddress, isAddress, zeroAddress, type Address } from "viem"
import { chain as defaultChain, uuid, type DemoChain } from "./chain"
import {
    DEMO_COOK_MS,
    DEMO_KITCHEN_PIN,
    DEMO_MERCHANT,
    DENOMINATION,
    MAX_GUESTS,
    demoConfig,
    menu,
    menuById,
    restaurant
} from "./config"
import type { DemoOrder, DemoShare, DemoState } from "./store"

const MAX_QTY = 20
const MAX_LINES = 30
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/

export class DemoHttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

export type DemoResponse = { status: number; data: unknown }

type CreateOrderInput = { table: number; guests: number; items: { id: string; qty: number; guest: number }[] }

function parseCreateOrder(body: unknown): CreateOrderInput {
    const b = body as Partial<CreateOrderInput> | null
    const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new DemoHttpError(400, "Send a JSON body with table, guests and items.")
    if (!int(b.table, 1, restaurant.tables)) throw new DemoHttpError(400, `Table must be between 1 and ${restaurant.tables}.`)
    if (!int(b.guests, 1, MAX_GUESTS)) throw new DemoHttpError(400, `Guests must be between 1 and ${MAX_GUESTS}.`)
    if (!Array.isArray(b.items) || b.items.length === 0) throw new DemoHttpError(400, "Add at least one dish.")
    if (b.items.length > MAX_LINES) throw new DemoHttpError(400, "Too many lines in one order.")
    const items = b.items.map((it) => {
        if (!it || typeof it !== "object" || typeof it.id !== "string" || !menuById.has(it.id)) throw new DemoHttpError(400, "Unknown dish.")
        if (!int(it.qty, 1, MAX_QTY)) throw new DemoHttpError(400, `Quantity must be between 1 and ${MAX_QTY}.`)
        if (!int(it.guest, 1, b.guests!)) throw new DemoHttpError(400, "Each dish must belong to a guest at the table.")
        return { id: it.id, qty: it.qty, guest: it.guest }
    })
    return { table: b.table!, guests: b.guests!, items }
}

export type DemoServerOptions = {
    chain?: DemoChain
    now?: () => number
    baseUrl?: string
}

export function createDemoServer(opts: DemoServerOptions = {}) {
    const chain = opts.chain ?? defaultChain
    const store = chain.store
    const now = opts.now ?? Date.now
    const publicConfig = demoConfig(opts.baseUrl ?? "/")
    // Notes the relayer is submitting right now, per share (see reserveRelay in service.ts).
    const relaying = new Map<string, number>()

    const orderStatus = (o: DemoOrder) =>
        o.status === "cooking" && o.readyAt !== null && now() >= o.readyAt ? ("ready" as const) : o.status

    function view(s: DemoState, id: string) {
        const o = s.orders[id]
        if (!o) throw new DemoHttpError(404, "No order with that id.")
        return {
            id: o.id,
            table: o.table,
            status: orderStatus(o),
            total: o.total,
            createdAt: o.createdAt,
            paidAt: o.paidAt,
            readyAt: o.readyAt,
            serverTime: now(),
            items: o.items.map((i) => ({ ...i })),
            shares: o.shareIds
                .map((sid) => s.shares[sid]!)
                .sort((a, b) => a.guest - b.guest)
                .map((sh) => ({
                    id: sh.id,
                    guest: sh.guest,
                    amount: sh.amount,
                    paid: sh.paid,
                    status: sh.status,
                    orderRef: sh.orderRef,
                    payments: sh.payments.map((p) => ({ ...p }))
                }))
        }
    }

    const shareByRef = (s: DemoState, ref: string) => Object.values(s.shares).find((x) => x.orderRef === ref.toLowerCase())

    function createOrder(input: CreateOrderInput) {
        return store.update((s) => {
            const orderId = uuid()
            const perGuest = new Map<number, number>()
            for (const it of input.items) perGuest.set(it.guest, (perGuest.get(it.guest) ?? 0) + menuById.get(it.id)!.price * it.qty)
            const total = [...perGuest.values()].reduce((a, b) => a + b, 0)
            const shareIds: string[] = []
            for (const [guest, amount] of [...perGuest.entries()].sort((a, b) => a[0] - b[0])) {
                const id = uuid()
                const ref = createOrderRef({ orderId, participantId: id, secret: randomSecret() }).toLowerCase()
                s.shares[id] = { id, orderId, guest, amount, paid: 0, orderRef: ref, status: "requested", payments: [] }
                shareIds.push(id)
            }
            s.orders[orderId] = {
                id: orderId,
                table: input.table,
                status: "awaiting_payment",
                total,
                createdAt: now(),
                paidAt: null,
                cookingStartedAt: null,
                readyAt: null,
                items: input.items.map((it) => {
                    const m = menuById.get(it.id)!
                    return { id: m.id, name: m.name, unitPrice: m.price, qty: it.qty, guest: it.guest }
                }),
                shareIds
            }
            return view(s, orderId)
        })
    }

    /** Settles a share from a simulated transaction, with the same checks as service.ts settle(). */
    function submitPayment(shareId: string, rawHash: string) {
        const txHash = rawHash.toLowerCase()
        return store.update((s) => {
            const share = s.shares[shareId]
            if (!share) throw new DemoHttpError(404, "No share with that id.")
            if (share.payments.some((p) => p.txHash === txHash)) return { status: share.status, order: view(s, share.orderId) }
            if (share.status === "verified") throw new DemoHttpError(409, "This share is already paid.")
            const tx = s.chain.txs[txHash]
            if (!tx || (tx.kind !== "public" && tx.kind !== "private")) {
                throw new DemoHttpError(409, "Payment not accepted: no FairPay payment in this transaction.")
            }
            if (tx.orderRef !== share.orderRef) throw new DemoHttpError(409, "Payment not accepted: the payment is for a different order.")
            if (getAddress(tx.to) !== DEMO_MERCHANT) throw new DemoHttpError(409, "Payment not accepted: the payment went to a different merchant.")
            const order = s.orders[share.orderId]!
            if (order.status !== "awaiting_payment") throw new DemoHttpError(409, "This share is already paid.")
            const owed = share.amount - share.paid
            const exact = tx.amount === owed
            const oneNote = tx.kind === "private" && tx.amount === DENOMINATION && owed > DENOMINATION
            if (!exact && !oneNote) throw new DemoHttpError(409, "Payment not accepted: amount does not match what is still owed.")
            if (Object.values(s.shares).some((x) => x.payments.some((p) => p.txHash === txHash))) {
                throw new DemoHttpError(409, "This payment has already been counted.")
            }
            share.payments.push({ txHash, kind: tx.kind, amount: tx.amount })
            share.paid += tx.amount
            share.status = share.paid >= share.amount ? "verified" : "executed"
            const open = order.shareIds.filter((id) => s.shares[id]!.status !== "verified").length
            if (open === 0) {
                order.status = "paid"
                order.paidAt = now()
            }
            return { status: share.status, order: view(s, share.orderId) }
        })
    }

    function canRelay(orderRef: string, merchant: Address) {
        if (merchant !== DEMO_MERCHANT || !HASH32.test(orderRef)) return null
        const s = store.read()
        const share = shareByRef(s, orderRef)
        if (!share || share.status === "verified") return null
        if (share.amount - share.paid - (relaying.get(share.id) ?? 0) * DENOMINATION < DENOMINATION) return null
        return s.orders[share.orderId]!.status === "awaiting_payment" ? share : null
    }

    function relay(body: Record<string, unknown>) {
        if (typeof body.merchant !== "string" || !isAddress(body.merchant) || typeof body.orderRef !== "string" || !HASH32.test(body.orderRef)) {
            throw new DemoHttpError(400, "Malformed private payment.")
        }
        const proof = body.proof as { nullifier?: unknown } | undefined
        if (!proof || typeof proof.nullifier !== "string") throw new DemoHttpError(400, "Malformed private payment.")
        const share = canRelay(body.orderRef, getAddress(body.merchant))
        if (!share) throw new DemoHttpError(409, "This share is already paid or is not open for private payment.")
        relaying.set(share.id, (relaying.get(share.id) ?? 0) + 1)
        try {
            let txHash: string
            try {
                txHash = chain.payPrivate(body as never)
            } catch (err) {
                const msg = err instanceof Error ? err.message : ""
                if (/NullifierSpent/.test(msg)) throw new DemoHttpError(409, "This note has already been spent.")
                if (/UnknownRoot/.test(msg)) throw new DemoHttpError(409, "The pool changed while your proof was built. Try again.")
                throw new DemoHttpError(502, "The relayer could not submit this payment. Try again shortly.")
            }
            // Credit the note before answering, like the real relayer route.
            try {
                submitPayment(share.id, txHash)
            } catch {
                /* the client's own settle call reports the outcome */
            }
            return { txHash }
        } finally {
            const n = (relaying.get(share.id) ?? 1) - 1
            if (n <= 0) relaying.delete(share.id)
            else relaying.set(share.id, n)
        }
    }

    function requireKitchen(pin: string | undefined) {
        if (pin !== DEMO_KITCHEN_PIN) throw new DemoHttpError(401, "Wrong kitchen PIN.")
    }

    function kitchenQueue() {
        const s = store.read()
        const since = now() - 6 * 60 * 60 * 1000
        const recent = Object.values(s.orders).filter((o) => o.createdAt > since)
        const orders = recent
            .filter((o) => o.status === "paid" || o.status === "cooking")
            .sort((a, b) => (a.paidAt ?? 0) - (b.paidAt ?? 0) || a.createdAt - b.createdAt)
            .map((o) => view(s, o.id))
        // Demo only: tables still paying, so the board can show them dimmed. The real API has no such list.
        const awaiting = recent
            .filter((o) => o.status === "awaiting_payment")
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((o) => view(s, o.id))
        return { serverTime: now(), cookMs: DEMO_COOK_MS, orders, awaiting }
    }

    function startCooking(id: string) {
        return store.update((s) => {
            const o = s.orders[id]
            if (!o || o.status !== "paid") throw new DemoHttpError(409, "Only paid orders that are not cooking yet can be started.")
            o.status = "cooking"
            o.cookingStartedAt = now()
            o.readyAt = now() + DEMO_COOK_MS
            return view(s, id)
        })
    }

    function markServed(id: string) {
        return store.update((s) => {
            const o = s.orders[id]
            if (!o || o.status !== "cooking" || o.readyAt === null || o.readyAt > now()) {
                throw new DemoHttpError(409, "Only ready orders can be marked served.")
            }
            o.status = "served"
            return view(s, id)
        })
    }

    function faucet(body: Record<string, unknown>) {
        if (typeof body.address !== "string" || !isAddress(body.address)) throw new DemoHttpError(400, "Send a wallet address.")
        const to = getAddress(body.address)
        if (to === zeroAddress) throw new DemoHttpError(400, "Send a wallet address.")
        return chain.faucet(to)
    }

    const idParam = (id: string, what: string) => {
        if (!ID.test(id)) throw new DemoHttpError(404, `No ${what} with that id.`)
        return id
    }

    /** One simulated HTTP request. `path` may start with "/api" or the demo prefix "demo:". */
    function handle(method: string, rawPath: string, body?: unknown, headers: Record<string, string | undefined> = {}): DemoResponse {
        const path = rawPath.replace(/^(demo:|\/api)/, "").split("?")[0]!
        const json = (): Record<string, unknown> => {
            if (typeof body !== "object" || body === null || Array.isArray(body)) throw new DemoHttpError(400, "Send a JSON object.")
            return body as Record<string, unknown>
        }
        try {
            let m: RegExpExecArray | null
            if (method === "GET") {
                if (path === "/config") return { status: 200, data: publicConfig }
                if (path === "/menu") return { status: 200, data: { restaurant, items: menu } }
                if (path === "/pool/commitments") return { status: 200, data: { commitments: chain.commitments() } }
                if ((m = /^\/orders\/([^/]+)$/.exec(path))) return { status: 200, data: view(store.read(), idParam(decodeURIComponent(m[1]!), "order")) }
                if (path === "/kitchen") {
                    requireKitchen(headers["x-kitchen-pin"])
                    return { status: 200, data: kitchenQueue() }
                }
            }
            if (method === "POST") {
                if (path === "/orders") return { status: 201, data: createOrder(parseCreateOrder(json())) }
                if ((m = /^\/shares\/([^/]+)\/payments$/.exec(path))) {
                    const id = idParam(decodeURIComponent(m[1]!), "share")
                    const b = json()
                    if (typeof b.txHash !== "string" || !HASH32.test(b.txHash)) throw new DemoHttpError(400, "txHash must be a transaction hash.")
                    return { status: 200, data: submitPayment(id, b.txHash) }
                }
                if (path === "/relay") return { status: 200, data: relay(json()) }
                if (path === "/faucet") return { status: 200, data: faucet(json()) }
                if ((m = /^\/kitchen\/orders\/([^/]+)\/(start|served)$/.exec(path))) {
                    requireKitchen(headers["x-kitchen-pin"])
                    const id = idParam(decodeURIComponent(m[1]!), "order")
                    return { status: 200, data: m[2] === "start" ? startCooking(id) : markServed(id) }
                }
            }
            return { status: 404, data: { error: "Not found." } }
        } catch (err) {
            if (err instanceof DemoHttpError) return { status: err.status, data: { error: err.message } }
            console.error("demo server:", err)
            return { status: 500, data: { error: "Something went wrong on the server. Try again." } }
        }
    }

    return { handle, createOrder, submitPayment, relay, kitchenQueue, startCooking, markServed, faucet, view: (id: string) => view(store.read(), id) }
}

export type DemoServer = ReturnType<typeof createDemoServer>

let server: DemoServer | null = null
const defaultServer = () => (server ??= createDemoServer({ baseUrl: import.meta.env.BASE_URL ?? "/" }))

/**
 * What api.ts calls instead of fetch() in the demo build. Answers on the next tick, like a very
 * fast server, so the pages keep their real async code paths.
 */
export async function demoCall(path: string, init?: { method?: string; body?: unknown; pin?: string }): Promise<DemoResponse> {
    await Promise.resolve()
    let body: unknown
    if (typeof init?.body === "string") {
        try {
            body = JSON.parse(init.body)
        } catch {
            return { status: 400, data: { error: "Send a JSON body." } }
        }
    }
    return defaultServer().handle(init?.method ?? "GET", path, body, { "x-kitchen-pin": init?.pin })
}
