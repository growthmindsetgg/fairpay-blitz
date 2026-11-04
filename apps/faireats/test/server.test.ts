// Runs the real API against a local Hardhat node with the real contracts:
//   cd packages/contracts && npx hardhat node
//   MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/deploy.ts --network localhost
//   cd apps/faireats && npm test
// Without the node or the deployment file these tests are skipped, and the rest of the suite still runs.
// The keys below are Hardhat's public development accounts. Never fund them anywhere real.
import { existsSync, readFileSync } from "node:fs"
import {
    createNote,
    createPrivatePayment,
    depositNote,
    groupFromCommitments,
    payPublic,
    type Clients
} from "@fairpay/sdk"
import { createRelayer } from "@fairpay/sdk/relayer"
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { hardhat } from "viem/chains"
import { beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../server/app.js"
import { openDb } from "../server/db.js"
import { createDepositIndexer } from "../server/indexer.js"
import { COOK_MS, createService } from "../server/service.js"

const DEPLOYMENT_FILE = new URL("../../../packages/contracts/deployments/localhost.json", import.meta.url)

type Deployment = {
    chainId: number
    token: Address
    fairPay: Address
    pool: Address
    poolDeployBlock: bigint
    denomination: bigint
}

// Finds the local deployment, or says why these tests can't run. Nothing in here throws.
const findLocalDeployment = async (): Promise<{ deployment: Deployment } | { skip: string }> => {
    const setup =
        "start `npx hardhat node` in packages/contracts, then deploy there with `MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/deploy.ts --network localhost`"
    if (!existsSync(DEPLOYMENT_FILE)) return { skip: `packages/contracts/deployments/localhost.json is missing; ${setup}` }
    let deployment: Deployment
    try {
        const raw = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"))
        deployment = {
            chainId: raw.chainId,
            token: raw.token as Address,
            fairPay: raw.fairPay as Address,
            pool: raw.pool as Address,
            poolDeployBlock: BigInt(raw.poolDeployBlock),
            denomination: BigInt(raw.denomination)
        }
    } catch (e) {
        return { skip: `packages/contracts/deployments/localhost.json is unreadable (${(e as Error).message}); ${setup}` }
    }
    // A fresh node forgets earlier deployments, so check the contract is really there.
    const probe = createPublicClient({ chain: hardhat, transport: http(undefined, { retryCount: 0, timeout: 3_000 }) })
    try {
        const code = await probe.getCode({ address: deployment.fairPay })
        if (!code || code === "0x") return { skip: `no FairPay contract at ${deployment.fairPay} on the local node; ${setup}` }
    } catch {
        return { skip: `no Hardhat node answers at ${hardhat.rpcUrls.default.http[0]}; ${setup}` }
    }
    return { deployment }
}

const local = await findLocalDeployment()
const noNode = "skip" in local
// Vitest drops console output from a file whose tests all skip, so write to stderr directly.
if ("skip" in local) process.stderr.write(`\nSkipping the FairEats node tests in test/server.test.ts: ${local.skip}\n\n`)
const describeOnNode = describe.skipIf(noNode)
// Only read inside tests and hooks, which never run when the node is missing.
const deployment = ("deployment" in local ? local.deployment : undefined) as Deployment

const KEYS = {
    customer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    merchant: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    relayer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
} as const

const publicClient = createPublicClient({ chain: hardhat, transport: http() })
const clientsFor = (key: `0x${string}`): Clients => ({
    publicClient,
    walletClient: createWalletClient({ account: privateKeyToAccount(key), chain: hardhat, transport: http() })
})
const customer = clientsFor(KEYS.customer)
const merchant = privateKeyToAccount(KEYS.merchant).address
const PIN = "246810"

let clock = Date.now()
const now = () => clock
const db = openDb(":memory:")
let indexer: ReturnType<typeof createDepositIndexer>
let app: ReturnType<typeof createApp>

const req = async (path: string, init: { method?: string; body?: unknown; pin?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (init.pin) headers["x-kitchen-pin"] = init.pin
    const res = await app.request(path, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined
    })
    return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
    if (noNode) return
    const service = createService(db, { deployment, publicClient, merchant, now })
    const relayer = createRelayer(deployment, clientsFor(KEYS.relayer))
    // Hardhat mines one block per transaction, so the test reads deposits without waiting for more.
    indexer = createDepositIndexer(db, publicClient, deployment, { confirmations: 0n })
    app = createApp({
        service,
        relay: (b) => relayer.handle(b),
        faucet: async () => ({ minted: "0", gasSent: "0" }),
        commitments: () => indexer.commitments(),
        kitchenPin: PIN,
        publicConfig: {},
        clientIp: () => "test",
        now
    })

    const hash = await customer.walletClient.writeContract({
        address: deployment.token,
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        functionName: "mint",
        chain: hardhat,
        args: [customer.walletClient.account.address, 1_000_000_000n]
    })
    await publicClient.waitForTransactionReceipt({ hash })
})

describeOnNode("orders", () => {
    it("prices on the server and splits by guest", async () => {
        const r = await req("/api/orders", {
            body: { table: 4, guests: 2, items: [{ id: "biryani", qty: 1, guest: 1 }, { id: "chai", qty: 2, guest: 2 }] }
        })
        expect(r.status).toBe(201)
        expect(r.body.total).toBe(25_000_000)
        expect(r.body.shares.map((s: any) => [s.guest, s.amount])).toEqual([
            [1, 15_000_000],
            [2, 10_000_000]
        ])
        expect(JSON.stringify(r.body)).not.toContain("secret")
        expect(new Set(r.body.shares.map((s: any) => s.orderRef)).size).toBe(2)
    })

    it("rejects unknown dishes, bad guests, smuggled prices and bad tables", async () => {
        const bad = [
            { table: 4, guests: 1, items: [{ id: "caviar", qty: 1, guest: 1 }] },
            { table: 4, guests: 1, items: [{ id: "chai", qty: 1, guest: 2 }] },
            { table: 99, guests: 1, items: [{ id: "chai", qty: 1, guest: 1 }] },
            { table: 4, guests: 1, items: [{ id: "chai", qty: 0, guest: 1 }] },
            { table: 4, guests: 1, items: [] }
        ]
        for (const body of bad) expect((await req("/api/orders", { body })).status).toBe(400)
        const priced = await req("/api/orders", {
            body: { table: 4, guests: 1, items: [{ id: "chai", qty: 1, guest: 1, price: 1 }] }
        })
        expect(priced.body.total).toBe(5_000_000)
    })
})

describeOnNode("paying and the kitchen", () => {
    let order: any

    beforeAll(async () => {
        order = (
            await req("/api/orders", {
                body: { table: 7, guests: 2, items: [{ id: "ramen", qty: 1, guest: 1 }, { id: "tacos", qty: 1, guest: 2 }] }
            })
        ).body
    })

    it("does not accept a payment for the wrong amount", async () => {
        const share = order.shares[0]
        const { txHash } = await payPublic(deployment, customer, { merchant, amount: 1_000_000n, orderRef: share.orderRef })
        await publicClient.waitForTransactionReceipt({ hash: txHash })
        const r = await req(`/api/shares/${share.id}/payments`, { body: { txHash } })
        expect(r.status).toBe(409)
        expect(r.body.error).toMatch(/amount/)
    })

    it("verifies a public payment and refuses to count it twice or for another share", async () => {
        const [g1, g2] = order.shares
        const { txHash } = await payPublic(deployment, customer, { merchant, amount: BigInt(g1.amount), orderRef: g1.orderRef })
        await publicClient.waitForTransactionReceipt({ hash: txHash })

        const ok = await req(`/api/shares/${g1.id}/payments`, { body: { txHash } })
        expect(ok.status).toBe(200)
        expect(ok.body.status).toBe("verified")

        const again = await req(`/api/shares/${g1.id}/payments`, { body: { txHash } })
        expect(again.body.status).toBe("verified")
        expect(again.body.order.shares[0].payments).toHaveLength(1)

        const stolen = await req(`/api/shares/${g2.id}/payments`, { body: { txHash } })
        expect(stolen.status).toBe(409)
    })

    it("kitchen needs the PIN and sees nothing until every share is paid", async () => {
        expect((await req("/api/kitchen")).status).toBe(401)
        expect((await req("/api/kitchen", { pin: "000000" })).status).toBe(401)
        const q = await req("/api/kitchen", { pin: PIN })
        expect(q.status).toBe(200)
        expect(q.body.orders.find((o: any) => o.id === order.id)).toBeUndefined()
        expect((await req(`/api/kitchen/orders/${order.id}/start`, { body: {}, pin: PIN })).status).toBe(409)
    })

    it("relayer only spends gas on open shares at this restaurant", async () => {
        expect((await req("/api/relay", { body: { merchant, orderRef: order.shares[0].orderRef } })).status).toBe(409)
        expect((await req("/api/relay", { body: { merchant: customer.walletClient.account.address, orderRef: order.shares[1].orderRef } })).status).toBe(409)
        expect((await req("/api/relay", { body: { merchant, orderRef: "0x" + "11".repeat(32) } })).status).toBe(409)
    })

    it("pays a 10 USDC share privately with two notes through the API", async () => {
        const g2 = order.shares[1]
        const notes = [createNote(deployment), createNote(deployment), createNote(deployment)]
        for (const n of notes) await depositNote(deployment, customer, n)
        await indexer.syncOnce()

        const group = await groupFromCommitments(deployment, publicClient, (await req("/api/pool/commitments")).body.commitments)
        const txs: Hash[] = []
        for (const note of notes.slice(0, 2)) {
            const request = await createPrivatePayment(deployment, publicClient, { note, merchant, orderRef: g2.orderRef, group })
            const r = await req("/api/relay", { body: request })
            expect(r.status).toBe(200)
            txs.push(r.body.txHash)
            // The server credits a relayed note itself; the client's own submission is a no-op.
            const credited = (await req(`/api/orders/${order.id}`)).body.shares[1].payments
            expect(credited.map((p: any) => p.txHash)).toContain(r.body.txHash.toLowerCase())
            const s = await req(`/api/shares/${g2.id}/payments`, { body: { txHash: r.body.txHash } })
            expect(s.status).toBe(200)
        }
        const view = (await req(`/api/orders/${order.id}`)).body
        const share = view.shares[1]
        expect(share.status).toBe("verified")
        expect(share.payments.map((p: any) => p.kind)).toEqual(["private", "private"])
        expect(view.status).toBe("paid")

        // The share is closed: the relayer refuses further notes for it.
        const extra = await createPrivatePayment(deployment, publicClient, { note: notes[2]!, merchant, orderRef: g2.orderRef, group })
        expect((await req("/api/relay", { body: extra })).status).toBe(409)
    })

    it("runs a one-minute countdown, then the order is ready and can be served", async () => {
        const start = await req(`/api/kitchen/orders/${order.id}/start`, { body: {}, pin: PIN })
        expect(start.body.status).toBe("cooking")
        expect(start.body.readyAt - start.body.serverTime).toBe(COOK_MS)
        expect((await req(`/api/kitchen/orders/${order.id}/served`, { body: {}, pin: PIN })).status).toBe(409)

        clock += COOK_MS
        expect((await req(`/api/orders/${order.id}`)).body.status).toBe("ready")
        expect((await req(`/api/kitchen/orders/${order.id}/served`, { body: {}, pin: PIN })).body.status).toBe("served")
    })
})

describeOnNode("settlement races", () => {
    const newOrder = async () =>
        (
            await req("/api/orders", {
                body: { table: 2, guests: 2, items: [{ id: "chai", qty: 1, guest: 1 }, { id: "lassi", qty: 1, guest: 2 }] }
            })
        ).body
    const pay = async (share: any) => {
        const { txHash } = await payPublic(deployment, customer, { merchant, amount: BigInt(share.amount), orderRef: share.orderRef })
        await publicClient.waitForTransactionReceipt({ hash: txHash })
        return txHash
    }

    it("counts one transaction once when it is submitted twice at the same time", async () => {
        const order = await newOrder()
        const share = order.shares[0]
        const txHash = await pay(share)
        const results = await Promise.all([1, 2, 3].map(() => req(`/api/shares/${share.id}/payments`, { body: { txHash } })))
        expect(results.map((r) => r.status)).toEqual([200, 200, 200])
        const view = (await req(`/api/orders/${order.id}`)).body
        expect(view.shares[0].payments).toHaveLength(1)
        expect(view.shares[0].paid).toBe(share.amount)
        // Upper-case hex is the same transaction.
        const upper = await req(`/api/shares/${share.id}/payments`, { body: { txHash: "0x" + txHash.slice(2).toUpperCase() } })
        expect(upper.status).toBe(200)
        expect((await req(`/api/orders/${order.id}`)).body.shares[0].payments).toHaveLength(1)
    })

    it("credits only one of two payments racing for the same share", async () => {
        const order = await newOrder()
        const share = order.shares[0]
        const [a, b] = [await pay(share), await pay(share)]
        const results = await Promise.all([a, b].map((txHash) => req(`/api/shares/${share.id}/payments`, { body: { txHash } })))
        expect(results.map((r) => r.status).sort()).toEqual([200, 409])
        const view = (await req(`/api/orders/${order.id}`)).body
        expect(view.shares[0].paid).toBe(share.amount)
        expect(view.shares[0].payments).toHaveLength(1)
        // The losing payment is real money at the merchant: it is kept for a refund.
        const credited = view.shares[0].payments[0].txHash
        const uncredited = db.prepare("SELECT tx_hash, amount FROM uncredited_payments WHERE share_id = ?").all(share.id)
        expect(uncredited).toEqual([{ tx_hash: [a, b].map((h) => h.toLowerCase()).find((h) => h !== credited), amount: String(share.amount) }])
    })

    it("never lets one transaction settle two shares, even concurrently", async () => {
        const order = await newOrder()
        const [g1, g2] = order.shares
        const txHash = await pay(g1)
        const [r1, r2] = await Promise.all([
            req(`/api/shares/${g1.id}/payments`, { body: { txHash } }),
            req(`/api/shares/${g2.id}/payments`, { body: { txHash } })
        ])
        expect(r1.status).toBe(200)
        expect(r2.status).toBe(409)
        const view = (await req(`/api/orders/${order.id}`)).body
        expect(view.shares[1].paid).toBe(0)
        expect(view.status).toBe("awaiting_payment")
    })

    it("answers 202 for a transaction the chain has not seen", async () => {
        const order = await newOrder()
        const r = await req(`/api/shares/${order.shares[0].id}/payments`, { body: { txHash: "0x" + "42".repeat(32) } })
        expect(r.status).toBe(202)
        expect(r.body.status).toBe("pending")
    })
})
