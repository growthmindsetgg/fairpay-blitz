// Relayer nonce handling against an in-memory fake node: no Hardhat node or network needed.
// The key below is Hardhat's public development account #3. Never fund it anywhere real.
import {
    createPublicClient,
    createWalletClient,
    custom,
    decodeFunctionData,
    keccak256,
    parseTransaction,
    toHex,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import { describe, expect, it } from "vitest"
import { fairPoolAbi } from "../src/abi.js"
import { sendSimulated, waitForSent, type Clients } from "../src/chain.js"
import type { FairPayDeployment } from "../src/config.js"
import { createRelayer } from "../src/relayer.js"

const KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
const deployment: FairPayDeployment = {
    chainId: monadTestnet.id,
    token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    fairPay: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    pool: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    poolDeployBlock: 0n
}
const MERCHANT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

type NodeOptions = {
    /** `pending` answers like `latest`: the node doesn't count its own mempool (a lagging RPC). */
    pendingIsLatest?: boolean
    /** Simulation reverts for these nullifiers. */
    revert?: Set<bigint>
    /** The next N eth_sendRawTransaction calls fail without the node keeping the transaction. */
    failSends?: number
    /** The JSON-RPC error those sends fail with. Default: a bare error with no code. */
    sendError?: { code: number; message: string }
    /** The next N accepted transactions are silently dropped: never mined, not counted as pending. */
    drop?: number
}

/**
 * A minimal JSON-RPC node for one sender. Every answer is delayed a little at random so concurrent
 * calls interleave. It mines only a contiguous run of nonces, like a real node, and rejects a nonce
 * that is already mined or already waiting.
 */
function fakeNode(opts: NodeOptions = {}) {
    let mined = 0
    let block = 1n
    let failSends = opts.failSends ?? 0
    let drop = opts.drop ?? 0
    const mempool = new Map<number, Hex>()
    const receipts = new Map<Hex, { blockNumber: bigint; nonce: number }>()
    const accepted: number[] = []
    const rejected: { nonce: number; why: string }[] = []

    const mine = () => {
        let advanced = false
        for (let h = mempool.get(mined); h !== undefined; h = mempool.get(mined)) {
            receipts.set(h, { blockNumber: block, nonce: mined })
            mempool.delete(mined)
            mined += 1
            advanced = true
        }
        if (advanced) block += 1n
    }
    const pause = () => new Promise((r) => setTimeout(r, Math.random() * 4))

    async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
        await pause()
        const p = (params ?? []) as unknown[]
        switch (method) {
            case "eth_chainId":
                return toHex(monadTestnet.id)
            case "eth_blockNumber":
                mine()
                return toHex(block)
            case "eth_getBlockByNumber":
                return {
                    number: toHex(block),
                    hash: keccak256(toHex(block)),
                    parentHash: keccak256(toHex(block - 1n)),
                    timestamp: toHex(1_700_000_000n + block),
                    baseFeePerGas: "0x1",
                    gasLimit: "0x1c9c380",
                    gasUsed: "0x0",
                    transactions: []
                }
            case "eth_maxPriorityFeePerGas":
            case "eth_gasPrice":
                return "0x1"
            case "eth_estimateGas":
                return "0x30d40"
            case "eth_call": {
                const { data } = p[0] as { data: Hex }
                const { args } = decodeFunctionData({ abi: fairPoolAbi, data })
                const proof = (args as readonly unknown[])[2] as { nullifier: bigint }
                if (opts.revert?.has(proof.nullifier)) throw new Error("execution reverted: NullifierSpent()")
                return "0x"
            }
            case "eth_getTransactionCount":
                return toHex(p[1] === "pending" && !opts.pendingIsLatest ? mined + mempool.size : mined)
            case "eth_sendRawTransaction": {
                const raw = p[0] as Hex
                const { nonce = 0 } = parseTransaction(raw as never)
                if (failSends > 0) {
                    failSends -= 1
                    rejected.push({ nonce, why: "rpc error" })
                    throw opts.sendError ? Object.assign(new Error(opts.sendError.message), opts.sendError) : new Error("upstream connect error")
                }
                if (nonce < mined || mempool.has(nonce)) {
                    rejected.push({ nonce, why: "nonce too low" })
                    throw new Error("nonce too low")
                }
                const hash = keccak256(raw)
                accepted.push(nonce)
                if (drop > 0) drop -= 1
                else mempool.set(nonce, hash)
                return hash
            }
            case "eth_getTransactionReceipt": {
                mine()
                const r = receipts.get(p[0] as Hex)
                if (!r) return null
                return {
                    transactionHash: p[0],
                    transactionIndex: "0x0",
                    blockHash: keccak256(toHex(r.blockNumber)),
                    blockNumber: toHex(r.blockNumber),
                    from: privateKeyToAccount(KEY).address,
                    to: deployment.pool,
                    cumulativeGasUsed: "0x30d40",
                    gasUsed: "0x30d40",
                    effectiveGasPrice: "0x1",
                    contractAddress: null,
                    logs: [],
                    logsBloom: `0x${"0".repeat(512)}`,
                    status: "0x1",
                    type: "0x2"
                }
            }
            case "eth_getTransactionByHash":
                return null
            default:
                throw Object.assign(new Error(`fake node: ${method} not supported`), { code: -32601 })
        }
    }

    // A fresh account per node, so tests don't share a send queue or nonce counter.
    const clients: Clients = {
        publicClient: createPublicClient({ chain: monadTestnet, transport: custom({ request }, { retryCount: 0 }), pollingInterval: 5 }) as Clients["publicClient"],
        walletClient: createWalletClient({ chain: monadTestnet, transport: custom({ request }, { retryCount: 0 }), account: freshAccount() })
    }
    return { clients, accepted, rejected, mined: () => mined, waiting: () => mempool.size }
}

// privateKeyToAccount returns a new object each time, but the queue is per address; give every
// node its own address by deriving a key from a counter.
let accounts = 0
function freshAccount() {
    accounts += 1
    return privateKeyToAccount(keccak256(toHex(`nonce-test-${accounts}`)))
}

function relayBody(nullifier: number) {
    return {
        chainId: deployment.chainId,
        pool: deployment.pool,
        merchant: MERCHANT,
        orderRef: keccak256(toHex(`order-${nullifier}`)),
        proof: {
            merkleTreeDepth: "1",
            merkleTreeRoot: "1",
            nullifier: String(nullifier),
            message: "1",
            scope: "1",
            points: Array(8).fill("1")
        }
    }
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)

describe("relayer nonces", () => {
    it("gives concurrent relays distinct, sequential nonces", async () => {
        const node = fakeNode()
        const relayer = createRelayer(deployment, node.clients)
        const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => relayer.handle(relayBody(n))))
        expect(results.map((r) => r.status)).toEqual(Array(6).fill("fulfilled"))
        expect(node.rejected).toEqual([])
        expect(sorted(node.accepted)).toEqual([0, 1, 2, 3, 4, 5])
        expect(node.mined()).toBe(6)
    })

    it("keeps nonces apart when the RPC's pending count lags behind its mempool", async () => {
        const node = fakeNode({ pendingIsLatest: true })
        const relayer = createRelayer(deployment, node.clients)
        const results = await Promise.allSettled([1, 2, 3, 4].map((n) => relayer.handle(relayBody(n))))
        expect(results.map((r) => r.status)).toEqual(Array(4).fill("fulfilled"))
        expect(node.rejected).toEqual([])
        expect(sorted(node.accepted)).toEqual([0, 1, 2, 3])
    })

    it("a relay whose simulation reverts doesn't block the others or leave a gap", async () => {
        const node = fakeNode({ revert: new Set([3n]) })
        const relayer = createRelayer(deployment, node.clients)
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => relayer.handle(relayBody(n))))
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"])
        expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ code: "RELAYER_REJECTED" })
        expect(sorted(node.accepted)).toEqual([0, 1, 2, 3])
        expect(node.mined()).toBe(4)
    })

    it("a failed broadcast doesn't use up its nonce", async () => {
        const node = fakeNode({ failSends: 1, pendingIsLatest: true })
        const relayer = createRelayer(deployment, node.clients)
        const results = await Promise.allSettled([1, 2, 3].map((n) => relayer.handle(relayBody(n))))
        // The first send fails; the next two take nonces 0 and 1, so nothing waits on a gap.
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
        expect(node.rejected).toEqual([{ nonce: 0, why: "rpc error" }])
        expect(sorted(node.accepted)).toEqual([0, 1])
        expect(node.mined()).toBe(2)
        // And the relayer still works afterwards.
        await relayer.handle(relayBody(4))
        expect(node.mined()).toBe(3)
    })

    it("after a dropped transaction times out, the next send fills its nonce", async () => {
        const node = fakeNode({ drop: 1, pendingIsLatest: true })
        const send = () =>
            sendSimulated(node.clients, { ...payCall(1) }).then((hash) => waitForSent(node.clients, hash, { timeout: 200 }))
        await expect(send()).rejects.toThrow()
        // Without the reset this would take nonce 1 and wait behind the missing nonce 0 for ever.
        await send()
        expect(node.accepted).toEqual([0, 0])
        expect(node.mined()).toBe(1)
    })
})

describe("relayer errors", () => {
    it("says when the relayer can't pay for gas", async () => {
        const node = fakeNode({ failSends: 1, sendError: { code: -32000, message: "insufficient funds for gas * price + value" } })
        const relayer = createRelayer(deployment, node.clients)
        await expect(relayer.handle(relayBody(1))).rejects.toMatchObject({ code: "RELAYER_UNFUNDED", txHash: undefined })
    })

    it("says busy when the node refuses the nonce", async () => {
        // Monad's answer to a reused nonce reaches viem as a bare -32000.
        const node = fakeNode({ failSends: 1, sendError: { code: -32000, message: "nonce already used" } })
        const relayer = createRelayer(deployment, node.clients)
        await expect(relayer.handle(relayBody(1))).rejects.toMatchObject({ code: "RELAYER_BUSY", txHash: undefined })
        // Nothing was sent, so the retry takes the same nonce.
        await relayer.handle(relayBody(1))
        expect(node.accepted).toEqual([0])
    })

    it("names the revert when simulation fails", async () => {
        const node = fakeNode({ revert: new Set([1n]) })
        const relayer = createRelayer(deployment, node.clients)
        await expect(relayer.handle(relayBody(1))).rejects.toMatchObject({ code: "RELAYER_REJECTED", txHash: undefined })
        expect(node.accepted).toEqual([])
    })

    it("gives the hash when the receipt doesn't come", async () => {
        const node = fakeNode({ drop: 1 })
        const clients = { ...node.clients, publicClient: withReceiptTimeout(node.clients.publicClient, 200) }
        const relayer = createRelayer(deployment, clients)
        const err = await relayer.handle(relayBody(1)).catch((e: unknown) => e)
        expect(err).toMatchObject({ code: "RELAYER_TIMEOUT", txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
    })
})

// The relayer waits with viem's default 3-minute timeout; shorten it for a test.
function withReceiptTimeout(client: Clients["publicClient"], timeout: number): Clients["publicClient"] {
    return new Proxy(client, {
        get(target, prop, receiver) {
            if (prop === "waitForTransactionReceipt") {
                return (args: Parameters<Clients["publicClient"]["waitForTransactionReceipt"]>[0]) => target.waitForTransactionReceipt({ ...args, timeout })
            }
            return Reflect.get(target, prop, receiver)
        }
    })
}

function payCall(nullifier: number) {
    const b = relayBody(nullifier)
    return {
        address: deployment.pool!,
        abi: fairPoolAbi,
        functionName: "pay" as const,
        args: [
            b.merchant,
            b.orderRef,
            {
                merkleTreeDepth: 1n,
                merkleTreeRoot: 1n,
                nullifier: BigInt(nullifier),
                message: 1n,
                scope: 1n,
                points: [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n] as const
            }
        ] as const
    }
}
