import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PublicClient } from "viem"
import { createChain, createDepositIndexer, type Deployment } from "../server/chain.js"
import { memoryDb, type OpenDb } from "../server/db.js"

// The deposit indexer saves its progress in the app's database, so a restart (or a free-plan
// instance that lost its disk) resumes where it stopped. A "restart" here is a new indexer on the
// same database; the fake RPC below stands in for the chain.

const DEPLOY_BLOCK = 1000n
const DEPLOYMENT: Deployment = {
    chainId: 10143,
    token: "0x00000000000000000000000000000000000000a1",
    fairPay: "0x00000000000000000000000000000000000000a2",
    pool: "0x00000000000000000000000000000000000000A3",
    poolDeployBlock: DEPLOY_BLOCK,
    denomination: 5_000_000n
}
const CONFIRMATIONS = 2n

type ChainDeposit = { index: bigint; commitment: bigint; block: bigint }
type FakeRpc = { head: bigint; deposits: ChainDeposit[] }

/** An RPC that serves `rpc` (mutable) and records every eth_getLogs range it was asked for. */
function fakeClient(rpc: FakeRpc) {
    const ranges: [bigint, bigint][] = []
    const client = {
        async getBlockNumber() {
            return rpc.head
        },
        async getContractEvents({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
            ranges.push([fromBlock, toBlock])
            return rpc.deposits
                .filter((d) => d.block >= fromBlock && d.block <= toBlock)
                .map((d) => ({ args: { index: d.index, commitment: d.commitment }, blockNumber: d.block, removed: false }))
        },
        async readContract({ blockNumber }: { blockNumber: bigint }) {
            return BigInt(rpc.deposits.filter((d) => d.block <= blockNumber).length)
        }
    }
    return { client: client as unknown as PublicClient, ranges }
}

const deposit = (index: number, block: number): ChainDeposit => ({ index: BigInt(index), commitment: 1000n + BigInt(index), block: BigInt(block) })

describe("deposit indexer persistence", () => {
    let db: OpenDb
    let clock: number
    const logs: string[] = []
    const indexer = (client: PublicClient) =>
        createDepositIndexer(db, client, DEPLOYMENT, { confirmations: CONFIRMATIONS, log: (m) => logs.push(m), now: () => clock })

    async function saved() {
        const state = await db.one<{ last_block: number | null }>("SELECT last_block FROM pool_indexer_state WHERE chain_id = $1 AND pool = $2", [
            DEPLOYMENT.chainId,
            DEPLOYMENT.pool.toLowerCase()
        ])
        const rows = await db.query<{ idx: number; commitment: string }>("SELECT idx, commitment FROM pool_deposits ORDER BY idx")
        return { last: state?.last_block ?? null, commitments: rows.map((r) => r.commitment) }
    }

    beforeEach(async () => {
        db = await memoryDb()
        clock = 1_000_000
        logs.length = 0
    })
    afterEach(async () => {
        await db.close()
    })

    it("survives a restart and resumes from the saved block instead of the deploy block", async () => {
        const rpc: FakeRpc = { head: 1500n, deposits: [deposit(0, 1010), deposit(1, 1200), deposit(2, 1400)] }
        const first = fakeClient(rpc)
        const a = indexer(first.client)
        await a.syncOnce()
        expect(a.commitments()).toEqual(["1000", "1001", "1002"])
        expect(first.ranges[0]![0]).toBe(DEPLOY_BLOCK)
        await a.stop()
        expect(await saved()).toEqual({ last: 1498, commitments: ["1000", "1001", "1002"] })

        // Restart: a new process with nothing in memory, and the chain has moved on.
        rpc.head = 1700n
        rpc.deposits.push(deposit(3, 1650))
        const second = fakeClient(rpc)
        const b = indexer(second.client)
        expect(b.commitments()).toEqual([])
        await b.syncOnce()
        expect(b.commitments()).toEqual(["1000", "1001", "1002", "1003"])
        // Only the new blocks were scanned.
        expect(second.ranges[0]![0]).toBe(1499n)
        expect(second.ranges.reduce((n, [f, t]) => n + Number(t - f + 1n), 0)).toBe(1698 - 1498)
        expect(await saved()).toEqual({ last: 1698, commitments: ["1000", "1001", "1002", "1003"] })
        await b.stop()
        expect(logs).toEqual([])
    })

    it("never moves the saved block backwards when two scans race", async () => {
        const deposits = [deposit(0, 1010), deposit(1, 1100), deposit(2, 1900)]
        // A is up to date; B's RPC lags behind (an older instance during a redeploy, say).
        const ahead = fakeClient({ head: 2000n, deposits })
        const behind = fakeClient({ head: 1200n, deposits })
        const a = indexer(ahead.client)
        const b = indexer(behind.client)
        await Promise.all([a.syncOnce(), b.syncOnce()])
        expect(await saved()).toEqual({ last: 1998, commitments: ["1000", "1001", "1002"] })

        // B saves again after A, with its lower block: the saved block stays put.
        clock += 120_000
        await b.syncOnce()
        await b.stop()
        expect(await saved()).toEqual({ last: 1998, commitments: ["1000", "1001", "1002"] })
        await a.stop()

        // A restart picks up everything A saw, not just what B saw.
        const next = fakeClient({ head: 2000n, deposits })
        const c = indexer(next.client)
        await c.syncOnce()
        expect(c.commitments()).toEqual(["1000", "1001", "1002"])
        expect(next.ranges).toEqual([])
    })

    it("waits for an RPC that lags behind the saved block instead of rewinding it", async () => {
        const deposits = [deposit(0, 1010), deposit(1, 1100), deposit(2, 1900)]
        const a = indexer(fakeClient({ head: 2000n, deposits }).client)
        await a.syncOnce()
        await a.stop()

        // A restart whose RPC node is a few blocks behind what was saved.
        const lagging = fakeClient({ head: 1950n, deposits })
        const b = indexer(lagging.client)
        await b.syncOnce()
        expect(b.commitments()).toEqual(["1000", "1001", "1002"])
        expect(lagging.ranges).toEqual([])
        await b.stop()
        expect(await saved()).toEqual({ last: 1998, commitments: ["1000", "1001", "1002"] })
        expect(logs).toEqual([])
    })

    it("saves a deliberate rewind when a reorg removes a deposit", async () => {
        const rpc: FakeRpc = { head: 1500n, deposits: [deposit(0, 1010), deposit(1, 1200), deposit(2, 1400)] }
        const a = indexer(fakeClient(rpc).client)
        await a.syncOnce()
        expect((await saved()).commitments).toHaveLength(3)

        // Deposit 2 was reorged away: the pool now counts 2 at the indexed head.
        rpc.deposits.pop()
        await a.syncOnce()
        expect(a.commitments()).toEqual(["1000", "1001"])
        // Rescans from the block of the last good deposit.
        expect(await saved()).toEqual({ last: 1199, commitments: ["1000", "1001"] })
        expect(logs.some((m) => m.includes("dropping the extra"))).toBe(true)

        // The rescan finds the deposit that took index 2 and saves it in place of the old one.
        rpc.deposits.push({ index: 2n, commitment: 777n, block: 1450n })
        await a.syncOnce()
        expect(await saved()).toEqual({ last: 1498, commitments: ["1000", "1001", "777"] })
        await a.stop()
    })

    it("keeps the indexer tables closed to Supabase's public API", async () => {
        const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
            "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('pool_indexer_state', 'pool_deposits') ORDER BY relname"
        )
        expect(rls).toEqual([
            { relname: "pool_deposits", relrowsecurity: true },
            { relname: "pool_indexer_state", relrowsecurity: true }
        ])
        const policies = await db.query("SELECT 1 FROM pg_policies WHERE tablename IN ('pool_indexer_state', 'pool_deposits')")
        expect(policies).toEqual([])
    })
})

describe("createChain", () => {
    // Hardhat's public development keys; nothing is sent (the RPC is never called).
    const A = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
    const B = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
    const rpcUrl = "http://127.0.0.1:1"

    it("refuses one key for both the relayer and the faucet, without printing it", () => {
        let message = ""
        try {
            createChain({ deployment: DEPLOYMENT, rpcUrl, relayerKey: A, faucetKey: A.toUpperCase().replace("0X", "0x") as `0x${string}` })
        } catch (err) {
            message = (err as Error).message
        }
        expect(message).toMatch(/same key/)
        expect(message).not.toContain(A.slice(2, 10))
    })

    it("accepts separate keys, or either one alone", () => {
        expect(createChain({ deployment: DEPLOYMENT, rpcUrl, relayerKey: A, faucetKey: B }).relay).toBeDefined()
        expect(createChain({ deployment: DEPLOYMENT, rpcUrl, relayerKey: A }).faucet).toBeUndefined()
        expect(createChain({ deployment: DEPLOYMENT, rpcUrl, faucetKey: A }).relay).toBeUndefined()
    })
})
