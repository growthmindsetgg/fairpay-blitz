// The demo build's simulated server and chain (src/demo). No network, no chain, no proofs.
import type { Clients } from "@fairpay/sdk"
import type { Address, Hash, Hex } from "viem"
import { describe, expect, it } from "vitest"
import * as sim from "../src/demo/chain"
import { createChain, demoClients, demoNullifier } from "../src/demo/chain"
import { DEMO_COOK_MS, DEMO_KITCHEN_PIN, DEMO_MERCHANT, DEMO_WALLET, DENOMINATION, REAL, START_USDC } from "../src/demo/config"
import { createNote, parseNote, serializeNote } from "../src/demo/notes"
import { createDemoServer } from "../src/demo/server"
import { createStore, DEMO_STORE_KEY } from "../src/demo/store"

const USDC = 1_000_000
const deployment = { chainId: REAL.chainId, token: REAL.token, fairPay: REAL.fairPay, pool: REAL.pool }

type OrderView = {
    id: string
    status: string
    readyAt: number | null
    shares: { id: string; guest: number; amount: number; paid: number; status: string; orderRef: Hex; payments: { kind: string }[] }[]
}

function setup() {
    let t = 1_000_000
    const clock = { now: () => t, advance: (ms: number) => (t += ms) }
    const store = createStore(null)
    const chain = createChain(store, clock.now)
    const server = createDemoServer({ chain, now: clock.now })
    const call = (method: string, path: string, body?: unknown, pin?: string) => server.handle(method, path, body, { "x-kitchen-pin": pin })
    return { clock, store, chain, server, call }
}

/** Table 4: guest 1 has biryani (15 USDC), guest 2 burrata (10 USDC). */
function order(env: ReturnType<typeof setup>) {
    const r = env.call("POST", "/api/orders", {
        table: 4,
        guests: 2,
        items: [
            { id: "biryani", qty: 1, guest: 1 },
            { id: "burrata", qty: 1, guest: 2 }
        ]
    })
    expect(r.status).toBe(201)
    return r.data as OrderView
}

function payPrivately(env: ReturnType<typeof setup>, orderRef: Hex) {
    const note = createNote(deployment)
    const commitment = String(note.identity.commitment)
    env.chain.deposit(DEMO_WALLET, commitment)
    const request = {
        chainId: deployment.chainId,
        pool: deployment.pool,
        merchant: DEMO_MERCHANT,
        orderRef,
        proof: { merkleTreeDepth: "0", merkleTreeRoot: "0", nullifier: demoNullifier(commitment), message: "0", scope: "0", points: [] }
    }
    return { request, relay: () => env.call("POST", "/api/relay", request) }
}

describe("demo server", () => {
    it("serves the config, menu and pool like the real API", () => {
        const env = setup()
        const cfg = env.call("GET", "demo:/config").data as { merchant: Address; denomination: string; maxGuests: number }
        expect(cfg.merchant).toBe(DEMO_MERCHANT)
        expect(cfg.denomination).toBe(String(5 * USDC))
        expect(cfg.maxGuests).toBe(8)
        const menu = env.call("GET", "/api/menu").data as { items: { price: number }[] }
        expect(menu.items.length).toBe(9)
        expect(menu.items.every((m) => m.price % DENOMINATION === 0)).toBe(true)
        expect(env.call("GET", "/api/pool/commitments").data).toEqual({ commitments: [] })
        expect(env.call("GET", "/api/nope").status).toBe(404)
    })

    it("validates orders with the real server's messages", () => {
        const env = setup()
        expect(env.call("POST", "/api/orders", { table: 0, guests: 1, items: [] }).data).toEqual({ error: "Table must be between 1 and 12." })
        expect(env.call("POST", "/api/orders", { table: 1, guests: 1, items: [{ id: "x", qty: 1, guest: 1 }] }).data).toEqual({
            error: "Unknown dish."
        })
        expect(env.call("GET", "/api/orders/not-an-id").status).toBe(404)
    })

    it("creates an order with one share per guest", () => {
        const env = setup()
        const o = order(env)
        expect(o.status).toBe("awaiting_payment")
        expect(o.shares.map((s) => [s.guest, s.amount, s.status])).toEqual([
            [1, 15 * USDC, "requested"],
            [2, 10 * USDC, "requested"]
        ])
        expect(new Set(o.shares.map((s) => s.orderRef)).size).toBe(2)
        expect((env.call("GET", `/api/orders/${o.id}`).data as OrderView).id).toBe(o.id)
    })

    it("pays a share publicly, then refuses the same or a wrong payment", () => {
        const env = setup()
        const o = order(env)
        const [g1, g2] = o.shares
        const tx = env.chain.payPublic(DEMO_WALLET, DEMO_MERCHANT, g1!.amount, g1!.orderRef)
        const r = env.call("POST", `/api/shares/${g1!.id}/payments`, { txHash: tx })
        expect(r.status).toBe(200)
        const paid = r.data as { status: string; order: OrderView }
        expect(paid.status).toBe("verified")
        expect(paid.order.shares[0]!.payments).toEqual([{ txHash: tx, kind: "public", amount: 15 * USDC }])
        expect(env.chain.balances(DEMO_WALLET).usdc).toBe(BigInt(START_USDC - 15 * USDC))
        // Submitting the same hash again is harmless.
        expect(env.call("POST", `/api/shares/${g1!.id}/payments`, { txHash: tx }).status).toBe(200)
        // The same transaction cannot pay another guest's share.
        expect(env.call("POST", `/api/shares/${g2!.id}/payments`, { txHash: tx }).status).toBe(409)
        // A made-up hash is not a payment.
        const fake = `0x${"ab".repeat(32)}`
        expect(env.call("POST", `/api/shares/${g2!.id}/payments`, { txHash: fake }).status).toBe(409)
        // The wrong amount is refused.
        const wrong = env.chain.payPublic(DEMO_WALLET, DEMO_MERCHANT, 5 * USDC, g2!.orderRef)
        expect(env.call("POST", `/api/shares/${g2!.id}/payments`, { txHash: wrong }).data).toEqual({
            error: "Payment not accepted: amount does not match what is still owed."
        })
    })

    it("pays a share privately, one note at a time, and never spends a note twice", () => {
        const env = setup()
        const o = order(env)
        const g2 = o.shares[1]!
        const first = payPrivately(env, g2.orderRef)
        const r1 = first.relay()
        expect(r1.status).toBe(200)
        const tx1 = (r1.data as { txHash: Hash }).txHash
        // The relayer already credited the note; the client's own settle call is idempotent.
        const s1 = env.call("POST", `/api/shares/${g2.id}/payments`, { txHash: tx1 }).data as { status: string }
        expect(s1.status).toBe("executed")
        // The payer's wallet is not in the private transaction.
        const t = env.chain.tx(tx1)!
        expect(t.kind).toBe("private")
        expect(t.from).not.toBe(DEMO_WALLET)
        expect(t.payer).toBe("pool")
        // The same note again is refused by the pool.
        expect(first.relay().data).toEqual({ error: "This note has already been spent." })

        const r2 = payPrivately(env, g2.orderRef).relay()
        expect(r2.status).toBe(200)
        const view = env.call("GET", `/api/orders/${o.id}`).data as OrderView
        expect(view.shares[1]!.status).toBe("verified")
        expect(view.shares[1]!.payments.map((p) => p.kind)).toEqual(["private", "private"])
        // A paid share takes no more notes.
        expect(payPrivately(env, g2.orderRef).relay().status).toBe(409)
        expect(env.call("POST", "/api/relay", { merchant: "nope", orderRef: g2.orderRef }).status).toBe(400)
    })

    it("sends the order to the kitchen only when every share is paid, then cooks and serves it", () => {
        const env = setup()
        const o = order(env)
        const [g1, g2] = o.shares
        const kitchen = () => env.call("GET", "/api/kitchen", undefined, DEMO_KITCHEN_PIN).data as { cookMs: number; orders: OrderView[]; awaiting: OrderView[] }

        expect(env.call("GET", "/api/kitchen", undefined, "wrong-pin").status).toBe(401)
        expect(env.call("GET", "/api/kitchen").status).toBe(401)
        expect(kitchen().orders).toEqual([])
        expect(kitchen().awaiting.map((x) => x.id)).toEqual([o.id])
        expect(env.call("POST", `/api/kitchen/orders/${o.id}/start`, {}, DEMO_KITCHEN_PIN).status).toBe(409)

        env.call("POST", `/api/shares/${g1!.id}/payments`, { txHash: env.chain.payPublic(DEMO_WALLET, DEMO_MERCHANT, g1!.amount, g1!.orderRef) })
        expect(kitchen().orders).toEqual([])
        payPrivately(env, g2!.orderRef).relay()
        expect(kitchen().orders).toEqual([])
        payPrivately(env, g2!.orderRef).relay()

        const q = kitchen()
        expect(q.cookMs).toBe(DEMO_COOK_MS)
        expect(q.orders.map((x) => [x.id, x.status])).toEqual([[o.id, "paid"]])
        expect(q.awaiting).toEqual([])

        const started = env.call("POST", `/api/kitchen/orders/${o.id}/start`, {}, DEMO_KITCHEN_PIN).data as OrderView
        expect(started.status).toBe("cooking")
        expect(env.call("POST", `/api/kitchen/orders/${o.id}/start`, {}, DEMO_KITCHEN_PIN).status).toBe(409)
        expect(env.call("POST", `/api/kitchen/orders/${o.id}/served`, {}, DEMO_KITCHEN_PIN).data).toEqual({
            error: "Only ready orders can be marked served."
        })
        env.clock.advance(DEMO_COOK_MS)
        expect((env.call("GET", `/api/orders/${o.id}`).data as OrderView).status).toBe("ready")
        const served = env.call("POST", `/api/kitchen/orders/${o.id}/served`, {}, DEMO_KITCHEN_PIN).data as OrderView
        expect(served.status).toBe("served")
        expect(kitchen().orders).toEqual([])
    })

    it("tops up a demo wallet from the simulated faucet", () => {
        const env = setup()
        env.chain.payPublic(DEMO_WALLET, DEMO_MERCHANT, 45 * USDC, `0x${"01".repeat(32)}`)
        const r = env.call("POST", "/api/faucet", { address: DEMO_WALLET })
        expect(r.data).toMatchObject({ minted: "45" })
        expect(env.chain.balances(DEMO_WALLET).usdc).toBe(BigInt(START_USDC))
        expect(env.call("POST", "/api/faucet", { address: "0x0" }).status).toBe(400)
    })

    it("resets to an empty demo", () => {
        const env = setup()
        const o = order(env)
        env.chain.deposit(DEMO_WALLET, "123")
        env.store.reset()
        expect(env.call("GET", `/api/orders/${o.id}`).status).toBe(404)
        expect(env.call("GET", "/api/pool/commitments").data).toEqual({ commitments: [] })
        expect(env.chain.balances(DEMO_WALLET).usdc).toBe(BigInt(START_USDC))
    })
})

describe("demo store", () => {
    const memoryStorage = () => {
        const m = new Map<string, string>()
        return {
            getItem: (k: string) => m.get(k) ?? null,
            setItem: (k: string, v: string) => void m.set(k, v),
            removeItem: (k: string) => void m.delete(k),
            m
        }
    }

    it("shares state between two tabs through storage", () => {
        const storage = memoryStorage()
        const tabA = createDemoServer({ chain: createChain(createStore(storage)) })
        const tabB = createDemoServer({ chain: createChain(createStore(storage)) })
        const r = tabA.handle("POST", "/api/orders", { table: 2, guests: 1, items: [{ id: "chai", qty: 1, guest: 1 }] })
        const id = (r.data as OrderView).id
        expect(tabB.handle("GET", `/api/orders/${id}`).status).toBe(200)
        expect(storage.m.has(DEMO_STORE_KEY)).toBe(true)
    })

    it("falls back to memory when the browser refuses to store data", () => {
        const blocked = {
            getItem: () => {
                throw new Error("SecurityError")
            },
            setItem: () => {
                throw new Error("SecurityError")
            },
            removeItem: () => {
                throw new Error("SecurityError")
            }
        }
        const store = createStore(blocked)
        expect(store.persistent).toBe(false)
        const server = createDemoServer({ chain: createChain(store) })
        const r = server.handle("POST", "/api/orders", { table: 2, guests: 1, items: [{ id: "chai", qty: 1, guest: 1 }] })
        expect(server.handle("GET", `/api/orders/${(r.data as OrderView).id}`).status).toBe(200)
    })
})

describe("simulated SDK functions", () => {
    it("deposit, private payment and spent check behave like the SDK's, with no network", async () => {
        const clients: Clients = demoClients(DEMO_WALLET)
        const note = createNote(deployment)
        const before = sim.chain.balances(DEMO_WALLET).usdc
        const { txHash } = await sim.depositNote(deployment, clients, note)
        expect(sim.chain.tx(txHash)?.kind).toBe("deposit")
        expect(sim.chain.balances(DEMO_WALLET).usdc).toBe(before - BigInt(DENOMINATION))
        expect(await sim.isNoteSpent(deployment, clients.publicClient, note)).toBe(false)

        const orderRef = `0x${"02".repeat(32)}` as Hex
        const req = await sim.createPrivatePayment(deployment, clients.publicClient, { note, merchant: DEMO_MERCHANT, orderRef })
        expect(req.proof.nullifier).toBe(demoNullifier(note.identity.commitment))
        sim.chain.payPrivate(req)
        expect(await sim.isNoteSpent(deployment, clients.publicClient, note)).toBe(true)
        await expect(sim.createPrivatePayment(deployment, clients.publicClient, { note, merchant: DEMO_MERCHANT, orderRef })).rejects.toThrow(
            /already been spent/
        )
        // A note that was never deposited cannot pay.
        await expect(
            sim.createPrivatePayment(deployment, clients.publicClient, { note: createNote(deployment), merchant: DEMO_MERCHANT, orderRef })
        ).rejects.toThrow(/never deposited/)
        // Reads the pages make are answered locally; anything else fails instead of calling an RPC.
        expect(await clients.publicClient.getBalance({ address: DEMO_WALLET })).toBeGreaterThan(0n)
        await expect(clients.publicClient.readContract({ address: REAL.pool, abi: [], functionName: "SCOPE" } as never)).rejects.toThrow()
    })
})

describe("demo notes", () => {
    it("round-trip in the SDK's text format without loading Semaphore", () => {
        const note = createNote(deployment)
        const text = serializeNote(note)
        expect(text.startsWith("fairpay-note-v1:")).toBe(true)
        const back = parseNote(text)
        expect(back.chainId).toBe(REAL.chainId)
        expect(back.pool.toLowerCase()).toBe(REAL.pool.toLowerCase())
        expect(String(back.identity.commitment)).toBe(String(note.identity.commitment))
        expect(String(createNote(deployment).identity.commitment)).not.toBe(String(note.identity.commitment))
        expect(() => parseNote("fairpay-note-v1:" + btoa(JSON.stringify({ chainId: 1, pool: REAL.pool, key: "" })))).toThrow()
        expect(() => parseNote("nope")).toThrow()
    })
})
