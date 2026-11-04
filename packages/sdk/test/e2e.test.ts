// End-to-end test against a local Hardhat node running the real contracts.
//   cd ../contracts && npx hardhat node
//   MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/deploy.ts --network localhost
//   cd ../sdk && npm test
// The private keys below are Hardhat's public development accounts. Never fund them anywhere real.
import { readFileSync } from "node:fs"
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { hardhat } from "viem/chains"
import { beforeAll, describe, expect, it } from "vitest"
import {
    createNote,
    createOrderRef,
    createPrivatePayment,
    depositNote,
    depositNotes,
    fetchGroup,
    groupFromCommitments,
    findPayments,
    isNoteSpent,
    parseNote,
    payPublic,
    randomSecret,
    serializeNote,
    verifyPaymentTx,
    FairPayError,
    erc20Abi,
    type Clients,
    type FairPayDeployment
} from "../src/index.js"
import { createRelayer } from "../src/relayer.js"

const raw = JSON.parse(readFileSync(new URL("../../contracts/deployments/localhost.json", import.meta.url), "utf8"))
const deployment: FairPayDeployment = {
    chainId: raw.chainId,
    token: raw.token,
    fairPay: raw.fairPay,
    pool: raw.pool,
    poolDeployBlock: BigInt(raw.poolDeployBlock),
    batcher: raw.batcher
}

const KEYS = {
    customer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    merchant: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    relayer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    other: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
} as const

const publicClient = createPublicClient({ chain: hardhat, transport: http() })
const clientsFor = (key: `0x${string}`): Clients => ({
    publicClient,
    walletClient: createWalletClient({ account: privateKeyToAccount(key), chain: hardhat, transport: http() })
})
const customer = clientsFor(KEYS.customer)
const relayerClients = clientsFor(KEYS.relayer)
const merchant = privateKeyToAccount(KEYS.merchant).address as Address
const other = privateKeyToAccount(KEYS.other).address as Address

// A public client whose RPC answers are rewritten, to stand in for a stale, reorged or
// misbehaving node. Every request still reaches the real local chain.
const tamperedClient = (rewrite: (method: string, params: unknown) => Promise<unknown>) =>
    createPublicClient({ chain: hardhat, transport: custom({ request: ({ method, params }) => rewrite(method, params) }) })
const forward = (method: string, params: unknown) => publicClient.request({ method, params } as never) as Promise<unknown>

beforeAll(async () => {
    const hash = await customer.walletClient.writeContract({
        chain: hardhat,
        address: deployment.token,
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        functionName: "mint",
        args: [customer.walletClient.account.address, 1_000_000_000n]
    })
    await publicClient.waitForTransactionReceipt({ hash })
})

describe("order references", () => {
    it("are deterministic per (order, participant, secret) and differ otherwise", () => {
        const secret = randomSecret()
        const a = createOrderRef({ orderId: "FE-001", participantId: "p1", secret })
        expect(createOrderRef({ orderId: "FE-001", participantId: "p1", secret })).toBe(a)
        expect(createOrderRef({ orderId: "FE-001", participantId: "p2", secret })).not.toBe(a)
        expect(createOrderRef({ orderId: "FE-001", participantId: "p1", secret: randomSecret() })).not.toBe(a)
        expect(() => createOrderRef({ orderId: "FE-001", participantId: "p1", secret: "0x1234" })).toThrow(FairPayError)
    })
})

describe("public payment", () => {
    const amount = 12_500_000n
    const orderRef = createOrderRef({ orderId: "FE-001", participantId: "alice", secret: randomSecret() })
    let txHash: `0x${string}`

    it("pays and verifies against the chain", async () => {
        ;({ txHash } = await payPublic(deployment, customer, { merchant, amount, orderRef }))
        await publicClient.waitForTransactionReceipt({ hash: txHash })
        const result = await verifyPaymentTx(deployment, publicClient, {
            txHash,
            orderRef,
            merchant,
            amount,
            expectedPayer: customer.walletClient.account.address
        })
        expect(result.status).toBe("verified")
        if (result.status === "verified") expect(result.payment.kind).toBe("public")
    })

    it("rejects a wrong amount, merchant, reference or payer", async () => {
        const base = { txHash, orderRef, merchant, amount }
        expect((await verifyPaymentTx(deployment, publicClient, { ...base, amount: amount + 1n })).status).toBe("rejected")
        expect((await verifyPaymentTx(deployment, publicClient, { ...base, merchant: other })).status).toBe("rejected")
        expect(
            (await verifyPaymentTx(deployment, publicClient, { ...base, orderRef: createOrderRef({ orderId: "x", participantId: "y", secret: randomSecret() }) })).status
        ).toBe("rejected")
        expect((await verifyPaymentTx(deployment, publicClient, { ...base, expectedPayer: other })).status).toBe("rejected")
    })

    it("does not count a receipt from a block that is no longer canonical", async () => {
        // Same transaction, but the node answering eth_getTransactionReceipt is on an orphaned fork.
        const stale = tamperedClient(async (method, params) => {
            const result = await forward(method, params)
            if (method === "eth_getTransactionReceipt" && result) {
                return { ...(result as object), blockHash: `0x${"ab".repeat(32)}` }
            }
            return result
        })
        const result = await verifyPaymentTx(deployment, stale, { txHash, orderRef, merchant, amount })
        expect(result.status).toBe("pending")
        expect((await verifyPaymentTx(deployment, publicClient, { txHash, orderRef, merchant, amount })).status).toBe("verified")
    })

    it("findPayments ignores logs the RPC returns from other contracts or for other orders", async () => {
        // An RPC that drops the address and topic filters and also serves a copy of each
        // PaymentReceived log as if another contract had emitted it.
        const sloppy = tamperedClient(async (method, params) => {
            if (method !== "eth_getLogs") return forward(method, params)
            const [filter] = params as [{ fromBlock: Hex; toBlock: Hex }]
            const logs = (await forward(method, [{ fromBlock: filter.fromBlock, toBlock: filter.toBlock }])) as {
                address: string
                logIndex: Hex
            }[]
            const forged = logs
                .filter((l) => l.address.toLowerCase() === deployment.fairPay.toLowerCase())
                .map((l) => ({ ...l, address: deployment.token, logIndex: "0x3e7" }))
            return [...logs, ...forged]
        })
        const found = await findPayments(deployment, sloppy, { orderRef, merchant, fromBlock: 0n })
        expect(found).toHaveLength(1)
        expect(found[0]!.txHash).toBe(txHash)
        expect(found[0]!.amount).toBe(amount)
    })

    it("rejects malformed order references before touching the chain", async () => {
        await expect(payPublic(deployment, customer, { merchant, amount, orderRef: `0x${"00".repeat(32)}` })).rejects.toMatchObject({
            code: "INVALID_INPUT"
        })
        await expect(payPublic(deployment, customer, { merchant, amount, orderRef: "0x1234" })).rejects.toMatchObject({
            code: "INVALID_INPUT"
        })
        await expect(payPublic(deployment, customer, { merchant: deployment.fairPay, amount, orderRef })).rejects.toMatchObject({
            code: "INVALID_INPUT"
        })
        await expect(verifyPaymentTx(deployment, publicClient, { txHash, orderRef: "0x1234", merchant, amount })).rejects.toMatchObject({
            code: "INVALID_INPUT"
        })
        await expect(findPayments(deployment, publicClient, { orderRef: "0x1234", fromBlock: 0n })).rejects.toMatchObject({
            code: "INVALID_INPUT"
        })
    })
})

describe("private payment", () => {
    const orderRef = createOrderRef({ orderId: "FE-002", participantId: "bob", secret: randomSecret() })
    const note = createNote(deployment)
    const relayer = createRelayer(deployment, relayerClients)

    it("round-trips a serialized note", () => {
        const restored = parseNote(serializeNote(note))
        expect(restored.identity.commitment).toBe(note.identity.commitment)
        expect(() => parseNote("garbage")).toThrow(FairPayError)
    })

    it("refuses notes whose key is not exactly 32 bytes", () => {
        // Identity.import("") succeeds and yields an identity anyone can recompute.
        const forge = (data: object) => `fairpay-note-v1:${btoa(JSON.stringify(data))}`
        const good = JSON.parse(atob(serializeNote(note).slice("fairpay-note-v1:".length)))
        expect(parseNote(forge(good)).identity.commitment).toBe(note.identity.commitment)
        for (const key of ["", "AA==", "not base64 at all", good.key.slice(0, -4), `${good.key}AAAA`, 42]) {
            expect(() => parseNote(forge({ ...good, key }))).toThrow(FairPayError)
        }
        for (const chainId of [0, -1, 1.5, "31337", null]) {
            expect(() => parseNote(forge({ ...good, chainId }))).toThrow(FairPayError)
        }
        expect(() => parseNote(`fairpay-note-v1:${btoa("null")}`)).toThrow(FairPayError)
    })

    it("deposits notes and rebuilds a tree that matches the on-chain root", async () => {
        await depositNote(deployment, customer, note)
        // Two decoy deposits so the payer is one of several.
        await depositNote(deployment, customer, createNote(deployment))
        await depositNote(deployment, customer, createNote(deployment))
        const group = await fetchGroup(deployment, publicClient, { chunkSize: 3n })
        expect(group.indexOf(note.identity.commitment)).toBeGreaterThanOrEqual(0)
        expect(await isNoteSpent(deployment, publicClient, note)).toBe(false)
    })

    it("accepts indexer-supplied commitments only when they produce an on-chain root", async () => {
        const truth = await fetchGroup(deployment, publicClient, { chunkSize: 3n })
        const members = truth.members.map(String)
        const group = await groupFromCommitments(deployment, publicClient, members)
        expect(group.root).toBe(truth.root)
        // An older prefix is still a root the pool recorded.
        await expect(groupFromCommitments(deployment, publicClient, members.slice(0, -1))).resolves.toBeDefined()
        // Reordered, injected or dropped-from-the-middle lists are rejected.
        await expect(groupFromCommitments(deployment, publicClient, [...members].reverse())).rejects.toMatchObject({
            code: "GROUP_MISMATCH"
        })
        await expect(groupFromCommitments(deployment, publicClient, [...members, "12345"])).rejects.toMatchObject({
            code: "GROUP_MISMATCH"
        })
        await expect(groupFromCommitments(deployment, publicClient, members.filter((_, i) => i !== 1))).rejects.toMatchObject({
            code: "GROUP_MISMATCH"
        })
    })

    it("pays through the relayer and the merchant verifies it as private", async () => {
        const request = await createPrivatePayment(deployment, publicClient, { note, merchant, orderRef })
        expect(JSON.stringify(request)).not.toContain(note.identity.export())

        const { txHash } = await relayer.handle(JSON.parse(JSON.stringify(request)))
        const result = await verifyPaymentTx(deployment, publicClient, { txHash, orderRef, merchant, amount: 5_000_000n })
        expect(result.status).toBe("verified")
        if (result.status === "verified") {
            expect(result.payment.kind).toBe("private")
            expect(result.payment.payer.toLowerCase()).toBe(deployment.pool!.toLowerCase())
        }
        expect(await isNoteSpent(deployment, publicClient, note)).toBe(true)

        const found = await findPayments(deployment, publicClient, { orderRef, merchant, fromBlock: 0n })
        expect(found).toHaveLength(1)
    })

    it("refuses to build a proof for a spent note", async () => {
        await expect(createPrivatePayment(deployment, publicClient, { note, merchant, orderRef })).rejects.toMatchObject({
            code: "NOTE_SPENT"
        })
    })

    it("relayer only accepts canonical uint256 decimals", async () => {
        const body = {
            chainId: deployment.chainId,
            pool: deployment.pool,
            merchant,
            orderRef,
            proof: { merkleTreeDepth: "1", merkleTreeRoot: "1", nullifier: "1", message: "1", scope: "1", points: Array(8).fill("1") }
        }
        // Leading zeros would give one nullifier several in-flight keys, letting copies of one
        // proof be sent concurrently with all but one reverting at the relayer's cost.
        for (const nullifier of ["01", "0007", "", "-1", "1e3", " 1", (1n << 256n).toString()]) {
            await expect(relayer.handle({ ...body, proof: { ...body.proof, nullifier } })).rejects.toMatchObject({
                code: "INVALID_INPUT"
            })
        }
        await expect(
            relayer.handle({ ...body, proof: { ...body.proof, points: [...Array(7).fill("1"), "00"] } })
        ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    })

    it("relayer rejects malformed bodies, other deployments and unregistered merchants", async () => {
        await expect(relayer.handle({ hello: "world" })).rejects.toMatchObject({ code: "INVALID_INPUT" })
        const fresh = createNote(deployment)
        await depositNote(deployment, customer, fresh)
        const request = await createPrivatePayment(deployment, publicClient, { note: fresh, merchant, orderRef })
        await expect(relayer.handle({ ...request, chainId: 1 })).rejects.toMatchObject({ code: "RELAYER_REJECTED" })
        await expect(relayer.handle({ ...request, merchant: other })).rejects.toMatchObject({ code: "RELAYER_REJECTED" })
        await expect(createPrivatePayment(deployment, publicClient, { note: fresh, merchant: other, orderRef })).rejects.toMatchObject({
            code: "NOT_MERCHANT"
        })
        // The untouched request still works: rejected attempts spent nothing.
        await relayer.handle(request)
        await expect(relayer.handle(request)).rejects.toMatchObject({ code: "RELAYER_REJECTED", message: "NullifierSpent" })
    })
})

describe("depositing several notes", () => {
    const relayer = createRelayer(deployment, relayerClients)
    const address = customer.walletClient.account.address
    const nonce = () => publicClient.getTransactionCount({ address })
    const allowanceTo = (spender: Address) =>
        publicClient.readContract({ address: deployment.token, abi: erc20Abi, functionName: "allowance", args: [address, spender] })

    it("deposits 11 notes with one approval and one depositMany: 2 transactions instead of 22", async () => {
        expect(deployment.batcher).toBeDefined()
        expect(await allowanceTo(deployment.batcher!)).toBe(0n)
        const notes = Array.from({ length: 11 }, () => createNote(deployment))
        const before = await nonce()
        const steps: string[] = []
        const { deposits, transactions } = await depositNotes(deployment, customer, notes, { onProgress: (p) => steps.push(p.step) })
        expect(await nonce()).toBe(before + 2)
        expect(transactions).toHaveLength(2)
        expect(steps).toEqual(["plan", "approve", "deposit"])
        expect(await allowanceTo(deployment.batcher!)).toBe(0n)

        const group = await fetchGroup(deployment, publicClient, { chunkSize: 50n })
        notes.forEach((n, i) => expect(BigInt(group.indexOf(n.identity.commitment))).toBe(deposits[i]!.index))
        expect(deposits[10]!.index - deposits[0]!.index).toBe(10n)
    })

    it("needs no approval when the allowance already covers it: 1 transaction", async () => {
        const hash = await customer.walletClient.writeContract({
            chain: hardhat,
            address: deployment.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployment.batcher!, 10_000_000n]
        })
        await publicClient.waitForTransactionReceipt({ hash })
        const before = await nonce()
        const { transactions } = await depositNotes(deployment, customer, [createNote(deployment), createNote(deployment)])
        expect(transactions).toHaveLength(1)
        expect(await nonce()).toBe(before + 1)
    })

    it("splits more than MAX_BATCH (20) notes into several depositMany calls", async () => {
        const notes = Array.from({ length: 21 }, () => createNote(deployment))
        const before = await nonce()
        const seen: number[] = []
        const { deposits } = await depositNotes(deployment, customer, notes, { onDeposited: (d) => seen.push(d.length) })
        expect(seen).toEqual([20, 1])
        expect(await nonce()).toBe(before + 3)
        expect(new Set(deposits.map((d) => d.index)).size).toBe(21)
    })

    it("without a batcher, approves once and then deposits one note per transaction", async () => {
        const { batcher: _, ...plain } = deployment
        const notes = [createNote(deployment), createNote(deployment), createNote(deployment)]
        const approve = (await allowanceTo(deployment.pool!)) < 15_000_000n ? 1 : 0
        const before = await nonce()
        await depositNotes(plain, customer, notes)
        expect(await nonce()).toBe(before + approve + 3)
    })

    it("refuses more notes than the pool's deposit cap leaves, before sending anything", async () => {
        const before = await nonce()
        const notes = Array.from({ length: 1_000 }, () => createNote(deployment))
        await expect(depositNotes(deployment, customer, notes)).rejects.toMatchObject({ code: "POOL_FULL" })
        expect(await nonce()).toBe(before)
    })

    it("a note deposited through the batcher pays through the relayer like any other", async () => {
        const note = createNote(deployment)
        await depositNotes(deployment, customer, [note, createNote(deployment)])
        const orderRef = createOrderRef({ orderId: "FE-003", participantId: "carol", secret: randomSecret() })
        const request = await createPrivatePayment(deployment, publicClient, { note, merchant, orderRef })
        const { txHash } = await relayer.handle(JSON.parse(JSON.stringify(request)))
        const result = await verifyPaymentTx(deployment, publicClient, { txHash, orderRef, merchant, amount: 5_000_000n })
        expect(result.status).toBe("verified")
        if (result.status === "verified") expect(result.payment.kind).toBe("private")
        expect(await isNoteSpent(deployment, publicClient, note)).toBe(true)
    })
})
