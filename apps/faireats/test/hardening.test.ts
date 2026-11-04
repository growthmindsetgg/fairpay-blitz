// Security and robustness tests that need no chain: the HTTP layer, the database rules, and the
// deposit indexer against a scripted RPC. The chain-backed flows are in server.test.ts.
import { fairPayAbi, FairPayError } from "@fairpay/sdk"
import { encodeAbiParameters, encodeEventTopics, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { describe, expect, it, vi } from "vitest"
import { createApp, FAUCET_WINDOW_MS, rateLimiter, recentSet, type AppDeps } from "../server/app.js"
import { openDb, tx, type Db } from "../server/db.js"
import { createDepositIndexer } from "../server/indexer.js"
import { clientAddress, ipKey } from "../server/net.js"
import { createService, HttpError } from "../server/service.js"

const deployment = {
    chainId: 31337,
    token: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address,
    fairPay: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address,
    pool: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address,
    poolDeployBlock: 10n,
    denomination: 5_000_000n
}
const merchant = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address
const PIN = "246810"
// Nothing listens on port 1: any RPC call fails the way a dead node does.
const deadRpc = {
    getChainId: async () => {
        throw new Error("fetch failed: connect ECONNREFUSED http://secret-node.internal:8545/?key=abc")
    }
} as unknown as PublicClient

/**
 * A chain that knows a few FairPay payments, enough for verifyPaymentTx. Each one is mined in
 * block 5, well confirmed, and its block is canonical.
 */
function paymentChain() {
    const blockHash = ("0x" + "b5".repeat(32)) as Hash
    const txs = new Map<string, unknown>()
    let n = 0
    const pay = (orderRef: Hex, amount: bigint, payer: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8") => {
        const transactionHash = ("0x" + (++n).toString(16).padStart(64, "0")) as Hash
        txs.set(transactionHash, {
            status: "success",
            blockNumber: 5n,
            blockHash,
            logs: [
                {
                    address: deployment.fairPay,
                    topics: encodeEventTopics({ abi: fairPayAbi, eventName: "PaymentReceived", args: { orderRef, recipient: merchant, payer } }),
                    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
                    logIndex: 0,
                    blockNumber: 5n,
                    blockHash,
                    transactionHash,
                    transactionIndex: 0,
                    removed: false
                }
            ]
        })
        return transactionHash
    }
    const rpc = {
        getChainId: async () => deployment.chainId,
        getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
            const r = txs.get(hash.toLowerCase())
            if (!r) throw new Error("receipt not found")
            return r
        },
        getBlockNumber: async () => 10n,
        getBlock: async () => ({ hash: blockHash })
    } as unknown as PublicClient
    return { rpc, pay }
}

function harness(over: Partial<AppDeps> & { db?: Db; ip?: { value: string }; rpc?: PublicClient } = {}) {
    let clock = 1_000_000
    const now = () => clock
    const db = over.db ?? openDb(":memory:")
    const service = createService(db, { deployment, publicClient: over.rpc ?? deadRpc, merchant, now })
    const ip = over.ip ?? { value: "203.0.113.7" }
    const app = createApp({
        service,
        relay: async () => ({ txHash: ("0x" + "ab".repeat(32)) as Hash }),
        faucet: async () => ({ minted: "50", gasSent: "0" }),
        commitments: () => [],
        kitchenPin: PIN,
        publicConfig: { rpcUrl: "https://rpc.example.org/v1/key" },
        clientIp: () => ip.value,
        now,
        ...over
    })
    const req = async (path: string, init: { method?: string; body?: unknown; raw?: string; pin?: string; type?: string } = {}) => {
        const headers: Record<string, string> = { "content-type": init.type ?? "application/json" }
        if (init.pin !== undefined) headers["x-kitchen-pin"] = init.pin
        const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined)
        const res = await app.request(path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body })
        const text = await res.text()
        let json: any
        try {
            json = JSON.parse(text)
        } catch {
            json = text
        }
        return { status: res.status, body: json, headers: res.headers }
    }
    const order = async (items = [{ id: "chai", qty: 1, guest: 1 }], guests = 1) =>
        (await req("/api/orders", { body: { table: 3, guests, items } })).body
    return { app, db, service, req, order, ip, advance: (ms: number) => (clock += ms) }
}

describe("rate limiter", () => {
    it("counts per key and resets after the window", () => {
        let t = 0
        const rl = rateLimiter(2, 1000, () => t)
        expect([rl.hit("a"), rl.hit("a"), rl.hit("a")]).toEqual([true, true, false])
        expect(rl.hit("b")).toBe(true)
        expect(rl.blocked("a")).toBe(true)
        t = 1000
        expect(rl.blocked("a")).toBe(false)
        expect(rl.hit("a")).toBe(true)
    })

    it("stays within its key budget, dropping expired windows before live ones", () => {
        let t = 0
        const rl = rateLimiter(1, 1000, () => t, 100)
        rl.hit("victim")
        rl.hit("victim")
        t = 1
        for (let i = 0; i < 98; i++) rl.hit(`old${i}`)
        t = 900
        expect(rl.size).toBe(99)
        // Expired ones go first: nothing has expired yet, so the oldest window is evicted.
        for (let i = 0; i < 1000; i++) rl.hit(`spray${i}`)
        expect(rl.size).toBeLessThanOrEqual(100)
        t = 2000
        rl.hit("fresh")
        expect(rl.size).toBeLessThanOrEqual(100)
    })

    it("keeps a live counter when there is room after dropping expired windows", () => {
        let t = 0
        const rl = rateLimiter(1, 1000, () => t, 10)
        for (let i = 0; i < 9; i++) rl.hit(`gone${i}`)
        t = 500
        rl.hit("victim")
        rl.hit("victim")
        t = 1200 // the nine "gone" windows expired, the victim's has not
        rl.hit("new")
        rl.hit("new2")
        expect(rl.blocked("victim")).toBe(true)
    })
})

describe("recent set", () => {
    it("forgets a key ttl after it was last added, and keeps at most maxKeys", () => {
        let t = 0
        const set = recentSet(1000, () => t, 3)
        set.add("a")
        t = 900
        set.add("a") // refreshed: now good until 1900
        t = 1000
        set.add("b")
        t = 1500
        expect(set.has("a")).toBe(true)
        t = 1900
        expect(set.has("a")).toBe(false)
        expect(set.has("b")).toBe(true)
        set.add("c")
        set.add("d")
        set.add("e") // full: "b", refreshed longest ago, goes
        expect(set.size).toBe(3)
        expect(set.has("b")).toBe(false)
        expect([set.has("c"), set.has("d"), set.has("e")]).toEqual([true, true, true])
    })
})

describe("client addresses", () => {
    it("normalises IPv4, mapped IPv6 and groups IPv6 by /64", () => {
        expect(ipKey("198.51.100.4")).toBe("198.51.100.4")
        expect(ipKey("::ffff:198.51.100.4")).toBe("198.51.100.4")
        expect(ipKey("2001:db8:1:2:aaaa::1")).toBe(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff"))
        expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"))
        expect(ipKey("[2001:db8::1]")).toBe("2001:0db8:0000:0000::/64")
        expect(ipKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64")
        expect(ipKey("not an ip")).toBe("unknown")
    })

    it("only believes X-Forwarded-For entries written by trusted proxies", () => {
        expect(clientAddress("10.0.0.1", "6.6.6.6", 0)).toBe("10.0.0.1")
        expect(clientAddress("10.0.0.1", "6.6.6.6, 198.51.100.4", 1)).toBe("198.51.100.4")
        expect(clientAddress("10.0.0.1", "6.6.6.6, 198.51.100.4, 10.0.0.2", 2)).toBe("198.51.100.4")
        expect(clientAddress("10.0.0.1", "198.51.100.4", 2)).toBe("10.0.0.1")
        expect(clientAddress("10.0.0.1", "6.6.6.6, garbage", 1)).toBe("10.0.0.1")
        expect(clientAddress(undefined, undefined, 1)).toBe("unknown")
    })
})

describe("http hardening", () => {
    it("sends a CSP that allows only what the app needs", async () => {
        const { req } = harness()
        const csp = (await req("/api/config")).headers.get("content-security-policy")!
        const d = Object.fromEntries(csp.split(";").map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
        expect(d["default-src"]).toEqual(["'self'"])
        expect(d["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"])
        expect(d["script-src"]).not.toContain("'unsafe-eval'")
        expect(d["script-src"]).not.toContain("'unsafe-inline'")
        expect(d["connect-src"]).toEqual(
            expect.arrayContaining(["'self'", "https://testnet-rpc.monad.xyz", "https://snark-artifacts.pse.dev", "https://rpc.example.org"])
        )
        expect(d["connect-src"].join(" ")).not.toContain("key")
        expect(d["style-src"]).toEqual(["'self'"])
        expect(d["font-src"]).toEqual(["'self'"])
        expect(d["worker-src"]).toContain("blob:")
        expect(d["frame-ancestors"]).toEqual(["'none'"])
        expect(d["object-src"]).toEqual(["'none'"])
    })

    it("tells a caller the address it is rate limited under", async () => {
        const { req, ip } = harness()
        expect((await req("/api/whoami")).body).toEqual({ ip: "203.0.113.7" })
        ip.value = "2001:db8:1:2:3:4:5:6"
        expect((await req("/api/whoami")).body).toEqual({ ip: "2001:0db8:0001:0002::/64" })
    })

    it("rejects non-JSON, oversized and non-object bodies", async () => {
        const { req } = harness()
        const okOrder = { table: 1, guests: 1, items: [{ id: "chai", qty: 1, guest: 1 }] }
        expect((await req("/api/orders", { body: okOrder, type: "text/plain" })).status).toBe(415)
        expect((await req("/api/orders", { body: okOrder, type: "application/x-www-form-urlencoded" })).status).toBe(415)
        expect((await req("/api/orders", { body: okOrder, type: "application/json; charset=utf-8" })).status).toBe(201)
        expect((await req("/api/orders", { raw: "{nope" })).status).toBe(400)
        expect((await req("/api/orders", { raw: "[1,2]" })).status).toBe(400)
        expect((await req("/api/orders", { raw: "null" })).status).toBe(400)
        expect((await req("/api/orders", { raw: JSON.stringify({ pad: "x".repeat(20_000) }) })).status).toBe(413)
        const lines = Array.from({ length: 31 }, () => ({ id: "chai", qty: 1, guest: 1 }))
        expect((await req("/api/orders", { body: { table: 1, guests: 1, items: lines } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1, guests: 1, items: [null] } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1, guests: 1, items: ["chai"] } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1.5, guests: 1, items: [{ id: "chai", qty: 1, guest: 1 }] } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1, guests: 9, items: [{ id: "chai", qty: 1, guest: 1 }] } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1, guests: 1, items: [{ id: "__proto__", qty: 1, guest: 1 }] } })).status).toBe(400)
        expect((await req("/api/orders", { body: { table: 1, guests: 1, items: [{ id: "chai", qty: 21, guest: 1 }] } })).status).toBe(400)
    })

    it("validates ids and hashes before touching the database or the chain", async () => {
        const { req, order } = harness()
        const o = await order()
        expect((await req("/api/orders/not-a-uuid")).status).toBe(404)
        expect((await req(`/api/orders/${o.id.toUpperCase()}`)).status).toBe(404)
        expect((await req(`/api/orders/${"x".repeat(5000)}`)).status).toBe(404)
        const share = o.shares[0].id
        expect((await req(`/api/shares/${share}/payments`, { body: { txHash: "0x1234" } })).status).toBe(400)
        expect((await req(`/api/shares/${share}/payments`, { body: { txHash: 12 } })).status).toBe(400)
        expect((await req(`/api/shares/nope/payments`, { body: { txHash: "0x" + "11".repeat(32) } })).status).toBe(404)
        expect((await req(`/api/shares/${o.id}/payments`, { body: { txHash: "0x" + "11".repeat(32) } })).status).toBe(404)
        expect((await req("/api/nothing-here")).status).toBe(404)
    })

    it("does not leak RPC details when the chain cannot be reached", async () => {
        const { req, order } = harness()
        const o = await order()
        const r = await req(`/api/shares/${o.shares[0].id}/payments`, { body: { txHash: "0x" + "11".repeat(32) } })
        expect(r.status).toBe(502)
        expect(JSON.stringify(r.body)).not.toMatch(/secret-node|ECONNREFUSED|key=/)
    })

    it("answers unexpected errors with a generic message", async () => {
        const { req } = harness({
            commitments: () => {
                throw new Error("SQLITE_CORRUPT at /var/lib/faireats/data.db")
            }
        })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const r = await req("/api/pool/commitments")
        spy.mockRestore()
        expect(r.status).toBe(500)
        expect(JSON.stringify(r.body)).not.toContain("SQLITE")
    })

    it("limits API requests per client, keyed by /64 for IPv6", async () => {
        const { req, ip } = harness()
        ip.value = "2001:db8:5:6::1"
        for (let i = 0; i < 600; i++) await req("/api/menu")
        ip.value = "2001:db8:5:6::9999" // same /64, different address
        expect((await req("/api/menu")).status).toBe(429)
        ip.value = "2001:db8:5:7::1"
        expect((await req("/api/menu")).status).toBe(200)
    })
})

describe("kitchen PIN", () => {
    it("lets a kitchen screen poll freely with the right PIN", async () => {
        const { req } = harness()
        for (let i = 0; i < 40; i++) expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
    })

    it("locks an address out after ten wrong PINs, even for the right PIN", async () => {
        const { req, ip, advance } = harness()
        for (let i = 0; i < 10; i++) expect((await req("/api/kitchen", { pin: String(100000 + i) })).status).toBe(401)
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(429)
        expect((await req("/api/kitchen", { pin: "999999" })).status).toBe(429)
        ip.value = "198.51.100.200"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        ip.value = "203.0.113.7"
        advance(15 * 60_000)
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
    })

    it("caps guessing spread across many addresses without locking out the real kitchen", async () => {
        const { req, ip, advance } = harness()
        const kitchen = "192.0.2.10"
        ip.value = kitchen
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        for (let i = 0; i < 60; i++) {
            ip.value = `198.51.100.${i}`
            expect((await req("/api/kitchen", { pin: "000000" })).status).toBe(401)
        }
        // A fresh address learns nothing, not even from the right PIN.
        ip.value = "198.51.100.250"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(429)
        // The kitchen screen that already proved the PIN keeps polling.
        ip.value = kitchen
        for (let i = 0; i < 5; i++) expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        // Trust is not a bypass: a wrong PIN from the trusted address is still refused.
        expect((await req("/api/kitchen", { pin: "000000" })).status).toBe(401)
        // Trust lapses after 12 hours without a right PIN; by then the global window has reset.
        advance(12 * 60 * 60_000)
        ip.value = "198.51.100.250"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
    })

    it("only trusts an address for 12 hours after it last gave the right PIN", async () => {
        const { req, ip, advance } = harness()
        const spray = async () => {
            for (let i = 0; i < 60; i++) {
                ip.value = `198.51.100.${i}`
                expect((await req("/api/kitchen", { pin: "000000" })).status).toBe(401)
            }
        }
        const HOUR = 60 * 60_000
        // Polling refreshes trust: 22.5 hours after the first right PIN it still holds.
        ip.value = "192.0.2.10"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        advance(11 * HOUR)
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        advance(11.5 * HOUR)
        await spray()
        ip.value = "192.0.2.10"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)

        // An address that has not given the right PIN for over 12 hours is not trusted any more.
        advance(2 * HOUR)
        ip.value = "192.0.2.20"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(200)
        advance(11.5 * HOUR)
        await spray()
        advance(HOUR / 2 + 1)
        ip.value = "192.0.2.20"
        expect((await req("/api/kitchen", { pin: PIN })).status).toBe(429)
    })

    it("guards the kitchen actions too, and treats a missing or odd PIN as wrong", async () => {
        const { req, order } = harness()
        const o = await order()
        expect((await req(`/api/kitchen/orders/${o.id}/start`, { body: {} })).status).toBe(401)
        expect((await req(`/api/kitchen/orders/${o.id}/start`, { body: {}, pin: PIN + "0" })).status).toBe(401)
        expect((await req(`/api/kitchen/orders/${o.id}/served`, { body: {}, pin: PIN.slice(0, 5) })).status).toBe(401)
        expect((await req(`/api/kitchen/orders/${o.id}/start`, { body: {}, pin: PIN })).status).toBe(409)
        expect((await req(`/api/kitchen/orders/bad/start`, { body: {}, pin: PIN })).status).toBe(404)
    })
})

describe("relay endpoint", () => {
    const relayBody = (orderRef: string) => ({
        chainId: deployment.chainId,
        pool: deployment.pool,
        merchant,
        orderRef,
        proof: { merkleTreeDepth: "1", merkleTreeRoot: "1", nullifier: "1", message: "1", scope: "1", points: Array(8).fill("1") }
    })

    it("never relays two notes at once for a share that owes one", async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        const relay = vi.fn(async () => {
            await gate
            return { txHash: ("0x" + "cd".repeat(32)) as Hash }
        })
        const { req, order } = harness({ relay })
        const o = await order() // one chai: 5 USDC, exactly one note
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        const first = req("/api/relay", { body: relayBody(o.shares[0].orderRef) })
        await vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(1))
        const second = await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })
        expect(second.status).toBe(409)
        release()
        expect((await first).status).toBe(200)
        warn.mockRestore()
        error.mockRestore()
        expect(relay).toHaveBeenCalledTimes(1)
    })

    it("allows as many concurrent notes as a share owes, and no more", async () => {
        const gates: (() => void)[] = []
        const relay = vi.fn(
            () => new Promise<{ txHash: Hash }>((r) => gates.push(() => r({ txHash: ("0x" + "ef".repeat(32)) as Hash })))
        )
        const { req, order } = harness({ relay })
        const o = await order([{ id: "burrata", qty: 1, guest: 1 }]) // 10 USDC: two notes
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        const a = req("/api/relay", { body: relayBody(o.shares[0].orderRef) })
        const b = req("/api/relay", { body: relayBody(o.shares[0].orderRef) })
        await vi.waitFor(() => expect(gates).toHaveLength(2))
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(409)
        gates.forEach((g) => g())
        expect((await a).status).toBe(200)
        expect((await b).status).toBe(200)
        warn.mockRestore()
        error.mockRestore()
        expect(relay).toHaveBeenCalledTimes(2)
    })

    it("caps relays in flight across all shares", async () => {
        const gates: (() => void)[] = []
        const relay = () => new Promise<{ txHash: Hash }>((r) => gates.push(() => r({ txHash: ("0x" + "12".repeat(32)) as Hash })))
        const { req, order } = harness({ relay })
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        const orders = await Promise.all([1, 2, 3, 4, 5].map(() => order()))
        const pending = orders.slice(0, 4).map((o) => req("/api/relay", { body: relayBody(o.shares[0].orderRef) }))
        await vi.waitFor(() => expect(gates).toHaveLength(4))
        expect((await req("/api/relay", { body: relayBody(orders[4].shares[0].orderRef) })).status).toBe(503)
        gates.forEach((g) => g())
        for (const p of pending) expect((await p).status).toBe(200)
        warn.mockRestore()
        error.mockRestore()
    })

    it("maps relayer failures to safe messages and frees the share", async () => {
        const errors = [
            [new FairPayError("RELAYER_REJECTED", "NullifierSpent"), 409, /already been spent/],
            [new FairPayError("RELAYER_REJECTED", "InvalidProof"), 400, /not valid/],
            [new FairPayError("INVALID_INPUT", "invalid payment request: proof.points"), 400, /Malformed/],
            [
                new FairPayError("RELAYER_REJECTED", "insufficient funds for gas: address 0xRelayer have 1 want 2 http://node.internal"),
                502,
                /relayer could not/
            ],
            [new Error("socket hang up 10.1.2.3"), 502, /relayer could not/]
        ] as const
        let failWith: unknown
        const relay = vi.fn(async () => {
            if (failWith) throw failWith
            return { txHash: ("0x" + "ab".repeat(32)) as Hash }
        })
        const { req, order } = harness({ relay, relaySettleGraceMs: 20 })
        const o = await order() // owes exactly one note
        const spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})]
        for (const [err, status, msg] of errors) {
            failWith = err
            const r = await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })
            expect(r.status).toBe(status)
            expect(r.body.error).toMatch(msg)
            expect(JSON.stringify(r.body)).not.toMatch(/internal|0xRelayer|10\.1\.2\.3/)
            // A 502 may have broadcast the transaction, so its hold outlives the grace period.
            if (status === 502) await new Promise((r) => setTimeout(r, 50))
        }
        // Every failed attempt released its hold, so the one note the share owes can still go.
        failWith = undefined
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        spies.forEach((s) => s.mockRestore())
        expect(relay).toHaveBeenCalledTimes(errors.length + 1)
    })

    it("holds the share for the grace period when the relayer fails after it may have broadcast", async () => {
        let fail = true
        const relay = vi.fn(async () => {
            if (fail) throw new Error("timed out waiting for receipt")
            return { txHash: ("0x" + "cd".repeat(32)) as Hash }
        })
        const { req, order } = harness({ relay, relaySettleGraceMs: 50 })
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        const o = await order() // owes exactly one note
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(502)
        // The first note may be on-chain: an immediate retry must not spend a second one.
        fail = false
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(409)
        expect(relay).toHaveBeenCalledTimes(1)
        await new Promise((r) => setTimeout(r, 100))
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        error.mockRestore()
    })

    it("rejects malformed relay requests before reserving anything", async () => {
        const relay = vi.fn(async () => ({ txHash: ("0x" + "ab".repeat(32)) as Hash }))
        const { req, order } = harness({ relay })
        const o = await order()
        for (const body of [
            {},
            { merchant: "nope", orderRef: o.shares[0].orderRef },
            { merchant, orderRef: "0x1234" },
            { merchant, orderRef: 5 },
            { merchant: deployment.pool, orderRef: o.shares[0].orderRef }
        ]) {
            expect([400, 409]).toContain((await req("/api/relay", { body })).status)
        }
        expect(relay).not.toHaveBeenCalled()
    })

    it("keeps the hold for a while when a spent note could not be settled", async () => {
        let n = 0
        const relay = vi.fn(async () => ({ txHash: ("0x" + (++n).toString(16).padStart(64, "0")) as Hash }))
        const { req, order, service } = harness({ relay, relaySettleGraceMs: 50 })
        const settle = vi.spyOn(service, "submitPayment").mockRejectedValue(new HttpError(502, "rpc down"))
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const o = await order() // owes exactly one note
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        // The note is spent but not credited: another relay now could spend a second one.
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(409)
        expect(relay).toHaveBeenCalledTimes(1)
        // After the grace period the share is open again, in case the note never landed.
        await new Promise((r) => setTimeout(r, 100))
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        expect(relay).toHaveBeenCalledTimes(2)
        settle.mockRestore()
        warn.mockRestore()
    })

    it("releases the hold at once when the chain refuses to credit the note", async () => {
        const relay = vi.fn(async () => ({ txHash: ("0x" + "ab".repeat(32)) as Hash }))
        const { req, order, service } = harness({ relay, relaySettleGraceMs: 60 * 60_000 })
        const settle = vi.spyOn(service, "submitPayment").mockRejectedValue(new HttpError(409, "Payment not accepted"))
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const o = await order()
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        expect((await req("/api/relay", { body: relayBody(o.shares[0].orderRef) })).status).toBe(200)
        settle.mockRestore()
        warn.mockRestore()
    })

    it("releases a kept hold once that transaction is settled for that share", async () => {
        const chain = paymentChain()
        let next: Hash | undefined
        const relay = vi.fn(async () => ({ txHash: next! }))
        const { req, order, service } = harness({ relay, rpc: chain.rpc, relaySettleGraceMs: 60 * 60_000 })
        // Burrata and chai: 15 USDC, three notes.
        const o = await order([
            { id: "burrata", qty: 1, guest: 1 },
            { id: "chai", qty: 1, guest: 1 }
        ])
        const share = o.shares[0]
        const other = await order()
        const real = service.submitPayment.bind(service)
        const settle = vi.spyOn(service, "submitPayment").mockRejectedValue(new HttpError(502, "rpc down"))
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const h1 = chain.pay(share.orderRef, deployment.denomination, deployment.pool)
        next = h1
        expect((await req("/api/relay", { body: relayBody(share.orderRef) })).status).toBe(200)

        // The client settles h1 itself. Submitting it for another share releases nothing.
        settle.mockImplementation(real)
        expect((await req(`/api/shares/${other.shares[0].id}/payments`, { body: { txHash: h1 } })).status).toBe(409)
        const s = await req(`/api/shares/${share.id}/payments`, { body: { txHash: h1 } })
        expect(s.status).toBe(200)
        expect(s.body.order.shares[0].paid).toBe(5_000_000)

        // The share owes two notes and holds none, so two more relays fit, and no third.
        settle.mockRejectedValue(new HttpError(502, "rpc down"))
        next = chain.pay(share.orderRef, deployment.denomination, deployment.pool)
        expect((await req("/api/relay", { body: relayBody(share.orderRef) })).status).toBe(200)
        next = chain.pay(share.orderRef, deployment.denomination, deployment.pool)
        expect((await req("/api/relay", { body: relayBody(share.orderRef) })).status).toBe(200)
        expect((await req("/api/relay", { body: relayBody(share.orderRef) })).status).toBe(409)
        expect(relay).toHaveBeenCalledTimes(3)
        settle.mockRestore()
        warn.mockRestore()
    })
})

describe("uncredited payments", () => {
    const rows = (db: Db) =>
        db.prepare("SELECT share_id, tx_hash, kind, amount, reason FROM uncredited_payments ORDER BY id").all() as {
            share_id: string
            tx_hash: string
            kind: string
            amount: string
            reason: string
        }[]

    it("records a valid payment that a share could not take, so staff can refund it", async () => {
        const chain = paymentChain()
        const { req, order, db } = harness({ rpc: chain.rpc })
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const o = await order() // 5 USDC
        const share = o.shares[0]
        const first = chain.pay(share.orderRef, 5_000_000n)
        const second = chain.pay(share.orderRef, 5_000_000n)
        const note = chain.pay(share.orderRef, 5_000_000n, deployment.pool)
        expect((await req(`/api/shares/${share.id}/payments`, { body: { txHash: first } })).status).toBe(200)
        // Paying a settled share again is refused, but the money is on record, once.
        const again = await req(`/api/shares/${share.id}/payments`, { body: { txHash: second } })
        expect(again.status).toBe(409)
        expect(again.body.error).toMatch(/already paid/)
        expect((await req(`/api/shares/${share.id}/payments`, { body: { txHash: second } })).status).toBe(409)
        expect((await req(`/api/shares/${share.id}/payments`, { body: { txHash: note } })).status).toBe(409)
        const view = (await req(`/api/orders/${o.id}`)).body
        expect(view.shares[0].paid).toBe(5_000_000)
        expect(view.shares[0].payments).toHaveLength(1)

        // A wrong amount on an open share is refused and recorded too.
        const o2 = await order()
        const short = chain.pay(o2.shares[0].orderRef, 1_000_000n)
        const r = await req(`/api/shares/${o2.shares[0].id}/payments`, { body: { txHash: short } })
        expect(r.status).toBe(409)
        expect(r.body.error).toMatch(/amount/)
        expect((await req(`/api/orders/${o2.id}`)).body.shares[0].paid).toBe(0)

        expect(rows(db)).toEqual([
            { share_id: share.id, tx_hash: second, kind: "public", amount: "5000000", reason: "share already paid" },
            { share_id: share.id, tx_hash: note, kind: "private", amount: "5000000", reason: "share already paid" },
            { share_id: o2.shares[0].id, tx_hash: short, kind: "public", amount: "1000000", reason: "amount does not match what is owed" }
        ])
        warn.mockRestore()
    })

    it("records nothing for payments that are not for this share or not on-chain", async () => {
        const chain = paymentChain()
        const { req, order, db } = harness({ rpc: chain.rpc })
        const [a, b] = [await order(), await order()]
        const forA = chain.pay(a.shares[0].orderRef, 5_000_000n)
        expect((await req(`/api/shares/${a.shares[0].id}/payments`, { body: { txHash: forA } })).status).toBe(200)
        // Another share's payment, offered to an open share and to a paid one.
        expect((await req(`/api/shares/${b.shares[0].id}/payments`, { body: { txHash: forA } })).status).toBe(409)
        const forB = chain.pay(b.shares[0].orderRef, 5_000_000n)
        expect((await req(`/api/shares/${a.shares[0].id}/payments`, { body: { txHash: forB } })).status).toBe(409)
        // A transaction the chain has never seen.
        expect((await req(`/api/shares/${a.shares[0].id}/payments`, { body: { txHash: "0x" + "77".repeat(32) } })).status).toBe(409)
        expect(rows(db)).toEqual([])
    })

    it("still answers 409 for a paid share when the chain cannot be reached", async () => {
        const chain = paymentChain()
        const { req, order, service } = harness({ rpc: chain.rpc })
        const o = await order()
        expect((await service.submitPayment(o.shares[0].id, chain.pay(o.shares[0].orderRef, 5_000_000n))).status).toBe("verified")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const down = vi.spyOn(chain.rpc, "getChainId").mockRejectedValue(new Error("ECONNREFUSED http://secret-node.internal"))
        const r = await req(`/api/shares/${o.shares[0].id}/payments`, { body: { txHash: "0x" + "99".repeat(32) } })
        expect(r.status).toBe(409)
        expect(JSON.stringify(r.body)).not.toMatch(/internal/)
        down.mockRestore()
        warn.mockRestore()
    })
})

describe("faucet", () => {
    const addr = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

    it("pays an address once per window, remembered across restarts", async () => {
        const db = openDb(":memory:")
        const faucet = vi.fn(async () => ({ minted: "50", gasSent: "0" }))
        const a = harness({ db, faucet })
        expect((await a.req("/api/faucet", { body: { address: addr } })).status).toBe(200)
        a.ip.value = "198.51.100.77"
        expect((await a.req("/api/faucet", { body: { address: addr.toLowerCase() } })).status).toBe(429)
        // A new process on the same database still knows about the claim.
        const b = harness({ db, faucet })
        expect((await b.req("/api/faucet", { body: { address: addr } })).status).toBe(429)
        expect(faucet).toHaveBeenCalledTimes(1)
        b.advance(FAUCET_WINDOW_MS)
        expect((await b.req("/api/faucet", { body: { address: addr } })).status).toBe(200)
    })

    it("limits each client address and refuses junk", async () => {
        const { req } = harness()
        expect((await req("/api/faucet", { body: { address: "0x0000000000000000000000000000000000000000" } })).status).toBe(400)
        expect((await req("/api/faucet", { body: { address: "0x123" } })).status).toBe(400)
        expect((await req("/api/faucet", { body: {} })).status).toBe(400)
        const addrs = ["0x" + "1".repeat(40), "0x" + "2".repeat(40), "0x" + "3".repeat(40), "0x" + "4".repeat(40)]
        const codes = []
        for (const a of addrs) codes.push((await req("/api/faucet", { body: { address: a } })).status)
        expect(codes).toEqual([200, 200, 200, 429])
    })

    it("releases the claim and hides the cause when sending fails", async () => {
        let fail = true
        const faucet = async () => {
            if (fail) throw new Error("nonce too low for 0xFaucetKeyOwner at http://rpc.internal")
            return { minted: "50", gasSent: "0.15" }
        }
        const { req } = harness({ faucet })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const r = await req("/api/faucet", { body: { address: addr } })
        spy.mockRestore()
        expect(r.status).toBe(502)
        expect(JSON.stringify(r.body)).not.toMatch(/nonce|rpc\.internal|0xFaucet/)
        fail = false
        expect((await req("/api/faucet", { body: { address: addr } })).status).toBe(200)
    })

    it("does not queue unbounded faucet sends", async () => {
        const gates: (() => void)[] = []
        const faucet = () => new Promise<{ minted: string; gasSent: string }>((r) => gates.push(() => r({ minted: "50", gasSent: "0" })))
        const { req, ip } = harness({ faucet })
        const pending = []
        for (let i = 0; i < 3; i++) {
            ip.value = `198.51.100.${i}`
            pending.push(req("/api/faucet", { body: { address: "0x" + String(i + 5).repeat(40) } }))
        }
        await vi.waitFor(() => expect(gates).toHaveLength(3))
        ip.value = "198.51.100.99"
        expect((await req("/api/faucet", { body: { address: "0x" + "9".repeat(40) } })).status).toBe(503)
        gates.forEach((g) => g())
        for (const p of pending) expect((await p).status).toBe(200)
        // The busy refusal did not burn that wallet's claim.
        const last = req("/api/faucet", { body: { address: "0x" + "9".repeat(40) } })
        await vi.waitFor(() => expect(gates).toHaveLength(4))
        gates[3]!()
        expect((await last).status).toBe(200)
    })
})

describe("database rules", () => {
    it("enforces foreign keys", () => {
        const db = openDb(":memory:")
        expect(() =>
            db
                .prepare("INSERT INTO shares (id, order_id, guest, amount, secret, order_ref, status) VALUES ('s', 'missing', 1, 1, 'x', 'r', 'requested')")
                .run()
        ).toThrow(/FOREIGN KEY/)
    })

    it("never lets a share be credited past its amount or backwards, and keeps payments append-only", async () => {
        const { db, order } = harness()
        const o = await order()
        const id = o.shares[0].id
        expect(() => db.prepare("UPDATE shares SET paid = amount + 1 WHERE id = ?").run(id)).toThrow(/out of range/)
        db.prepare("UPDATE shares SET paid = amount WHERE id = ?").run(id)
        expect(() => db.prepare("UPDATE shares SET paid = 0 WHERE id = ?").run(id)).toThrow(/out of range/)
        db.prepare(
            `INSERT INTO payments (share_id, chain_id, tx_hash, log_index, kind, payer, amount, block_number, verified_at)
             VALUES (?, 1, '0xaa', 0, 'public', '0xp', 5, 1, 1)`
        ).run(id)
        expect(() => db.prepare("UPDATE payments SET share_id = share_id").run()).toThrow(/append-only/)
        expect(() => db.prepare("DELETE FROM payments").run()).toThrow(/append-only/)
    })

    it("rolls a failed transaction back completely", () => {
        const db = openDb(":memory:")
        expect(() =>
            tx(db, () => {
                db.prepare("INSERT INTO faucet_claims (address, claimed_at) VALUES ('a', 1)").run()
                throw new Error("boom")
            })
        ).toThrow("boom")
        expect(db.isTransaction).toBe(false)
        expect(db.prepare("SELECT COUNT(*) AS n FROM faucet_claims").get()).toEqual({ n: 0 })
    })
})

// ------------------------------------------------------------------ indexer

type FakeDeposit = { index: number; commitment: bigint; block: number; removed?: boolean }

/** A scripted RPC: a list of deposits, a head, and hooks to make it misbehave. */
function fakeChain() {
    const state = {
        head: 100,
        deposits: [] as FakeDeposit[],
        failLogs: 0,
        dropOnce: new Set<number>(),
        countAt: undefined as undefined | ((block: number) => number),
        readContractFails: false,
        logCalls: 0
    }
    const client = {
        getBlockNumber: async () => BigInt(state.head),
        getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
            state.logCalls++
            if (state.failLogs > 0) {
                state.failLogs--
                throw new Error("HTTP request failed. URL: https://rpc.internal")
            }
            return state.deposits
                .filter((d) => d.block >= Number(fromBlock) && d.block <= Number(toBlock))
                .filter((d) => {
                    if (state.dropOnce.has(d.index)) {
                        state.dropOnce.delete(d.index)
                        return false
                    }
                    return true
                })
                .map((d) => ({
                    removed: d.removed ?? false,
                    blockNumber: BigInt(d.block),
                    args: { index: BigInt(d.index), commitment: d.commitment, root: 0n }
                }))
        },
        readContract: async ({ blockNumber }: { blockNumber: bigint }) => {
            if (state.readContractFails) throw new Error("state not available")
            if (state.countAt) return BigInt(state.countAt(Number(blockNumber)))
            return BigInt(state.deposits.filter((d) => !d.removed && d.block <= Number(blockNumber)).length)
        }
    }
    return { state, client: client as unknown as PublicClient }
}

const indexerFor = (db: Db, client: PublicClient, confirmations = 0n, pool = deployment.pool) =>
    createDepositIndexer(db, client, { ...deployment, pool }, { confirmations, log: () => {} })

describe("deposit indexer", () => {
    it("serves deposits only once they have enough confirmations", async () => {
        const { state, client } = fakeChain()
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 99 }
        ]
        const idx = indexerFor(openDb(":memory:"), client, 2n)
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11"])
        state.head = 101
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22"])
    })

    it("ignores removed logs", async () => {
        const { state, client } = fakeChain()
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 99n, block: 30, removed: true },
            { index: 1, commitment: 22n, block: 31 }
        ]
        const idx = indexerFor(openDb(":memory:"), client)
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22"])
    })

    it("replaces deposits that a reorg rewrote", async () => {
        const { state, client } = fakeChain()
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 90 },
            { index: 2, commitment: 33n, block: 95 }
        ]
        const db = openDb(":memory:")
        const idx = indexerFor(db, client)
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22", "33"])
        // Blocks 90+ were replaced: index 1 is now a different deposit and 33 is gone.
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 44n, block: 92 },
            { index: 2, commitment: 22n, block: 101 }
        ]
        state.head = 110
        await idx.syncOnce() // sees the count mismatch at the head and rewinds
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "44", "22"])
    })

    it("repairs a gap left by an RPC that silently dropped a log", async () => {
        const { state, client } = fakeChain()
        state.head = 400
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 150 },
            { index: 2, commitment: 33n, block: 300 }
        ]
        state.dropOnce.add(1)
        const idx = indexerFor(openDb(":memory:"), client)
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11"]) // stops at the hole, never skips past it
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22", "33"])
    })

    it("repairs a missing tail using the pool's depositCount", async () => {
        const { state, client } = fakeChain()
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 50 }
        ]
        state.dropOnce.add(1)
        const idx = indexerFor(openDb(":memory:"), client)
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11"])
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22"])
    })

    it("still finds holes when the RPC cannot read past state", async () => {
        const { state, client } = fakeChain()
        state.readContractFails = true
        state.head = 300
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 150 },
            { index: 2, commitment: 33n, block: 250 }
        ]
        state.dropOnce.add(1)
        const idx = indexerFor(openDb(":memory:"), client)
        await idx.syncOnce()
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22", "33"])
    })

    it("does not move its cursor past a range whose logs failed to load", async () => {
        const { state, client } = fakeChain()
        state.head = 2000
        state.deposits = [
            { index: 0, commitment: 11n, block: 20 },
            { index: 1, commitment: 22n, block: 1500 }
        ]
        state.failLogs = 1
        const db = openDb(":memory:")
        const idx = indexerFor(db, client)
        await expect(idx.syncOnce()).rejects.toThrow()
        expect(idx.commitments()).toEqual([])
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["11", "22"])
    })

    it("starts over when the chain is shorter than what it indexed", async () => {
        const { state, client } = fakeChain()
        state.deposits = [{ index: 0, commitment: 11n, block: 20 }]
        const db = openDb(":memory:")
        const idx = indexerFor(db, client)
        await idx.syncOnce()
        state.head = 15 // a local node restarted from scratch
        state.deposits = []
        await idx.syncOnce()
        expect(idx.commitments()).toEqual([])
        state.head = 40
        state.deposits = [{ index: 0, commitment: 77n, block: 30 }]
        await idx.syncOnce()
        expect(idx.commitments()).toEqual(["77"])
    })

    it("drops another pool's deposits when the deployment changes", async () => {
        const { state, client } = fakeChain()
        state.deposits = [{ index: 0, commitment: 11n, block: 20 }]
        const db = openDb(":memory:")
        await indexerFor(db, client).syncOnce()
        const other = indexerFor(db, client, 0n, "0x0000000000000000000000000000000000000abc")
        expect(other.commitments()).toEqual([])
    })

    it("shares one sync between concurrent callers", async () => {
        const { state, client } = fakeChain()
        state.deposits = [{ index: 0, commitment: 11n, block: 20 }]
        const idx = indexerFor(openDb(":memory:"), client)
        await Promise.all([idx.syncOnce(), idx.syncOnce(), idx.syncOnce()])
        expect(state.logCalls).toBe(1)
        expect(idx.commitments()).toEqual(["11"])
    })

    it("keeps polling through RPC errors and stops cleanly", async () => {
        const { state, client } = fakeChain()
        state.deposits = [{ index: 0, commitment: 11n, block: 20 }]
        state.failLogs = 2
        const idx = indexerFor(openDb(":memory:"), client)
        idx.start(5)
        await vi.waitFor(() => expect(idx.commitments()).toEqual(["11"]), { timeout: 2000 })
        await idx.stop()
        const calls = state.logCalls
        await new Promise((r) => setTimeout(r, 50))
        expect(state.logCalls).toBe(calls)
    })
})
