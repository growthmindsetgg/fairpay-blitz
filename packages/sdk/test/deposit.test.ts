// depositNotes against an in-memory fake chain and wallet: no Hardhat node or network needed.
// Checks which wallet requests are made (approve once, depositMany per MAX_BATCH notes, one atomic
// EIP-5792 batch when the wallet supports it) and what is refused before anything is sent.
import {
    createPublicClient,
    createWalletClient,
    custom,
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionResult,
    getAddress,
    keccak256,
    toHex,
    type Address,
    type Hex
} from "viem"
import { monadTestnet } from "viem/chains"
import { describe, expect, it } from "vitest"
import { erc20Abi, fairPoolAbi, fairPoolBatcherAbi } from "../src/abi.js"
import type { Clients } from "../src/chain.js"
import type { FairPayDeployment } from "../src/config.js"
import { createNote, depositNotes, type DepositProgress } from "../src/pool.js"

const TOKEN: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
const POOL: Address = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
const BATCHER: Address = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
const USER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const DENOM = 5_000_000n
const deployment: FairPayDeployment = {
    chainId: monadTestnet.id,
    token: TOKEN,
    fairPay: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    pool: POOL,
    poolDeployBlock: 0n,
    batcher: BATCHER
}
const abi = [...erc20Abi, ...fairPoolAbi, ...fairPoolBatcherAbi]

type FakeOptions = {
    /** EIP-5792 atomic status the wallet reports; undefined: the wallet doesn't know wallet_getCapabilities. */
    atomic?: "supported" | "ready" | "unsupported"
    /** wallet_sendCalls fails with this JSON-RPC error. */
    sendCallsError?: { code: number; message: string }
    allowance?: bigint
    maxBatch?: bigint
    maxDeposits?: bigint
    depositCount?: bigint
    paused?: boolean
    batcherPool?: Address
}

/** A chain + wallet that applies approve, deposit and depositMany to a little state and records every write. */
function fake(opts: FakeOptions = {}) {
    let count = opts.depositCount ?? 0n
    const allowance = new Map<string, bigint>([[BATCHER.toLowerCase(), opts.allowance ?? 0n], [POOL.toLowerCase(), opts.allowance ?? 0n]])
    const receipts = new Map<Hex, unknown>()
    const sent: { to: Address; functionName: string; args: readonly unknown[] }[] = []
    const batches: { functionName: string; args: readonly unknown[] }[][] = []
    const requests: string[] = []
    let nonce = 0

    const depositLog = (commitment: bigint, hash: Hex, i: number) => ({
        address: POOL,
        topics: encodeEventTopics({ abi: fairPoolAbi, eventName: "Deposit", args: { commitment } }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [count++, 1n]),
        logIndex: toHex(i),
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256(hash),
        blockNumber: "0x10",
        removed: false
    })

    /** Applies one write and returns its logs. */
    function apply(to: Address, data: Hex, hash: Hex) {
        const call = decodeFunctionData({ abi, data })
        sent.push({ to: getAddress(to), functionName: call.functionName, args: call.args ?? [] })
        if (call.functionName === "approve") {
            const [spender, amount] = call.args as [Address, bigint]
            allowance.set(spender.toLowerCase(), amount)
            return []
        }
        if (call.functionName === "depositMany") {
            const cs = call.args![0] as bigint[]
            allowance.set(BATCHER.toLowerCase(), allowance.get(BATCHER.toLowerCase())! - DENOM * BigInt(cs.length))
            return cs.map((c, i) => depositLog(c, hash, i))
        }
        if (call.functionName === "deposit") {
            allowance.set(POOL.toLowerCase(), allowance.get(POOL.toLowerCase())! - DENOM)
            return [depositLog(call.args![0] as bigint, hash, 0)]
        }
        throw new Error(`unexpected write ${call.functionName}`)
    }

    function read(to: Address, data: Hex): Hex {
        const call = decodeFunctionData({ abi, data })
        const at = getAddress(to)
        const result = (() => {
            switch (call.functionName) {
                case "DENOMINATION":
                    return DENOM
                case "maxDeposits":
                    return opts.maxDeposits ?? 200n
                case "depositCount":
                    return count
                case "paused":
                    return opts.paused ?? false
                case "allowance":
                    return allowance.get((call.args![1] as Address).toLowerCase()) ?? 0n
                case "pool":
                    return opts.batcherPool ?? POOL
                case "token":
                    return TOKEN
                case "MAX_BATCH":
                    return opts.maxBatch ?? 20n
                // Simulations of writes.
                case "approve":
                    return true
                case "deposit":
                case "depositMany":
                    return undefined
            }
            throw new Error(`unexpected read ${call.functionName} at ${at}`)
        })()
        return result === undefined ? "0x" : encodeFunctionResult({ abi, functionName: call.functionName, result } as never)
    }

    const receiptOf = (hash: Hex, logs: unknown[]) => ({
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256(hash),
        blockNumber: "0x10",
        from: USER,
        to: POOL,
        cumulativeGasUsed: "0x1",
        gasUsed: "0x1",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        logs,
        logsBloom: `0x${"00".repeat(256)}`,
        status: "0x1",
        type: "0x2"
    })

    const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
        requests.push(method)
        const p = (params ?? []) as never[]
        switch (method) {
            case "eth_chainId":
                return toHex(monadTestnet.id)
            case "eth_blockNumber":
                return "0x20"
            case "eth_call": {
                const [tx] = p as [{ to: Address; data: Hex }]
                return read(tx.to, tx.data)
            }
            case "eth_estimateGas":
                return "0x186a0"
            case "eth_sendTransaction": {
                const [tx] = p as [{ to: Address; data: Hex }]
                const hash = keccak256(toHex(`tx-${nonce++}`))
                receipts.set(hash, receiptOf(hash, apply(tx.to, tx.data, hash)))
                return hash
            }
            case "eth_getTransactionReceipt":
                return receipts.get((p as [Hex])[0]) ?? null
            case "eth_getTransactionByHash":
                return null
            case "wallet_getCapabilities":
                if (!opts.atomic) throw Object.assign(new Error("method not supported"), { code: -32601 })
                return { [toHex(monadTestnet.id)]: { atomic: { status: opts.atomic } } }
            case "wallet_sendCalls": {
                const [body] = p as [{ calls: { to: Address; data: Hex }[]; atomicRequired: boolean; chainId: Hex }]
                if (opts.sendCallsError) throw Object.assign(new Error(opts.sendCallsError.message), opts.sendCallsError)
                expect(body.atomicRequired).toBe(true)
                expect(body.chainId).toBe(toHex(monadTestnet.id))
                const hash = keccak256(toHex(`batch-${nonce++}`))
                const before = sent.length
                const logs = body.calls.flatMap((c) => apply(c.to, c.data, hash))
                batches.push(sent.splice(before).map(({ functionName, args }) => ({ functionName, args })))
                receipts.set(hash, receiptOf(hash, logs))
                return { id: hash }
            }
            case "wallet_getCallsStatus": {
                const [id] = p as [Hex]
                return { version: "2.0.0", id, chainId: toHex(monadTestnet.id), atomic: true, status: 200, receipts: [receipts.get(id)] }
            }
        }
        throw new Error(`fake chain: unexpected ${method}`)
    }

    const transport = custom({ request })
    const clients: Clients = {
        publicClient: createPublicClient({ chain: monadTestnet, transport, pollingInterval: 5 }),
        walletClient: createWalletClient({ account: USER, chain: monadTestnet, transport, pollingInterval: 5 }) as Clients["walletClient"]
    }
    return { clients, sent, batches, requests }
}

const notes = (n: number) => Array.from({ length: n }, () => createNote(deployment))

describe("depositNotes", () => {
    it("approves once, then deposits 11 notes in one depositMany: 2 transactions", async () => {
        const f = fake()
        const progress: DepositProgress[] = []
        const ns = notes(11)
        const r = await depositNotes(deployment, f.clients, ns, { onProgress: (p) => progress.push(p) })
        expect(f.sent.map((s) => [s.to, s.functionName])).toEqual([
            [TOKEN, "approve"],
            [BATCHER, "depositMany"]
        ])
        expect(f.sent[0]!.args).toEqual([BATCHER, DENOM * 11n])
        expect(f.sent[1]!.args[0]).toEqual(ns.map((n) => n.identity.commitment))
        expect(r.transactions).toHaveLength(2)
        expect(r.deposits.map((d) => d.index)).toEqual(ns.map((_, i) => BigInt(i)))
        expect(new Set(r.deposits.map((d) => d.txHash))).toEqual(new Set([r.transactions[1]]))
        expect(progress[0]).toEqual({ step: "plan", approve: true, deposits: 1, atomic: false, confirmations: 2, batched: true })
        expect(progress.slice(1).map((p) => p.step)).toEqual(["approve", "deposit"])
        // The wallet has no EIP-5792, so it was asked and nothing was batched.
        expect(f.requests).toContain("wallet_getCapabilities")
        expect(f.batches).toHaveLength(0)
    })

    it("skips the approval when the allowance already covers the total: 1 transaction", async () => {
        const f = fake({ allowance: DENOM * 3n, atomic: "supported" })
        const r = await depositNotes(deployment, f.clients, notes(3))
        expect(f.sent.map((s) => s.functionName)).toEqual(["depositMany"])
        expect(r.transactions).toHaveLength(1)
        // One call needs no batch, so the wallet isn't even asked about it.
        expect(f.requests).not.toContain("wallet_getCapabilities")
    })

    it("splits more than MAX_BATCH notes into several depositMany calls after one approval", async () => {
        const f = fake({ maxBatch: 4n })
        const onDeposited: number[] = []
        const ns = notes(9)
        const r = await depositNotes(deployment, f.clients, ns, { onDeposited: (d) => onDeposited.push(d.length) })
        expect(f.sent.map((s) => s.functionName)).toEqual(["approve", "depositMany", "depositMany", "depositMany"])
        expect(f.sent.slice(1).map((s) => (s.args[0] as bigint[]).length)).toEqual([4, 4, 1])
        expect(onDeposited).toEqual([4, 4, 1])
        expect(r.deposits.map((d) => d.index)).toEqual(ns.map((_, i) => BigInt(i)))
    })

    it("without a batcher: one approval for the total, then one deposit per note", async () => {
        const f = fake()
        const { batcher: _, ...plain } = deployment
        const r = await depositNotes(plain, f.clients, notes(3))
        expect(f.sent.map((s) => [s.to, s.functionName])).toEqual([
            [TOKEN, "approve"],
            [POOL, "deposit"],
            [POOL, "deposit"],
            [POOL, "deposit"]
        ])
        expect(f.sent[0]!.args).toEqual([POOL, DENOM * 3n])
        expect(r.transactions).toHaveLength(4)
    })

    it("sends approve and every depositMany as one atomic batch when the wallet supports it", async () => {
        const f = fake({ atomic: "supported", maxBatch: 5n })
        const progress: DepositProgress[] = []
        const ns = notes(7)
        const r = await depositNotes(deployment, f.clients, ns, { onProgress: (p) => progress.push(p) })
        expect(f.sent).toHaveLength(0)
        expect(f.batches).toHaveLength(1)
        expect(f.batches[0]!.map((c) => c.functionName)).toEqual(["approve", "depositMany", "depositMany"])
        expect(progress[0]).toMatchObject({ step: "plan", atomic: true, confirmations: 1 })
        expect(r.transactions).toHaveLength(1)
        expect(r.deposits.map((d) => d.index)).toEqual(ns.map((_, i) => BigInt(i)))
    })

    it("uses separate transactions when the wallet would first have to upgrade the account (ready)", async () => {
        const f = fake({ atomic: "ready" })
        await depositNotes(deployment, f.clients, notes(2))
        expect(f.batches).toHaveLength(0)
        expect(f.sent.map((s) => s.functionName)).toEqual(["approve", "depositMany"])
    })

    it("atomic: 'never' skips the wallet's batching", async () => {
        const f = fake({ atomic: "supported" })
        await depositNotes(deployment, f.clients, notes(2), { atomic: "never" })
        expect(f.batches).toHaveLength(0)
        expect(f.sent).toHaveLength(2)
    })

    it("falls back to separate transactions when the wallet can't take the batch, but not when the user declines", async () => {
        const broken = fake({ atomic: "supported", sendCallsError: { code: 5700, message: "unsupported capability" } })
        await depositNotes(deployment, broken.clients, notes(2))
        expect(broken.sent.map((s) => s.functionName)).toEqual(["approve", "depositMany"])

        const declined = fake({ atomic: "supported", sendCallsError: { code: 4001, message: "User rejected the request." } })
        await expect(depositNotes(deployment, declined.clients, notes(2))).rejects.toThrow()
        expect(declined.sent).toHaveLength(0)
    })

    it("refuses before sending anything: full or paused pool, a foreign batcher, duplicates, no notes", async () => {
        const full = fake({ maxDeposits: 200n, depositCount: 195n })
        await expect(depositNotes(deployment, full.clients, notes(6))).rejects.toMatchObject({ code: "POOL_FULL" })
        await depositNotes(deployment, full.clients, notes(5))

        const paused = fake({ paused: true })
        await expect(depositNotes(deployment, paused.clients, notes(1))).rejects.toMatchObject({ code: "POOL_PAUSED" })

        const foreign = fake({ batcherPool: "0x0000000000000000000000000000000000000001" })
        await expect(depositNotes(deployment, foreign.clients, notes(2))).rejects.toMatchObject({ code: "INVALID_INPUT" })

        const f = fake()
        const [a] = notes(1)
        await expect(depositNotes(deployment, f.clients, [a!, a!])).rejects.toMatchObject({ code: "INVALID_INPUT" })
        await expect(depositNotes(deployment, f.clients, [])).rejects.toMatchObject({ code: "INVALID_INPUT" })
        const other = createNote({ ...deployment, pool: "0x0000000000000000000000000000000000000002" })
        await expect(depositNotes(deployment, f.clients, [other])).rejects.toMatchObject({ code: "INVALID_INPUT" })
        for (const x of [paused, foreign, f]) expect(x.sent).toHaveLength(0)
    })
})
