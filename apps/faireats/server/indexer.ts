import { fairPoolAbi, type FairPayDeployment } from "@fairpay/sdk"
import type { PublicClient } from "viem"
import { tx, type Db } from "./db.js"

// Keeps a copy of every pool deposit so browsers do not scan logs from the deploy block.
// Browsers do not trust this list: the SDK's groupFromCommitments checks the resulting root
// against the pool on-chain. A wrong list cannot steal anything, but it stops private payments,
// so the indexer repairs itself: it only reads blocks with enough confirmations, replaces
// deposits a reorg rewrote, and rescans when its count disagrees with the pool's depositCount.

const CHUNK = 100n // Monad's public RPC rejects larger eth_getLogs ranges.
const PARALLEL = 8n
const MAX_BACKOFF_MS = 60_000

type Row = { idx: number; commitment: string; block_number: number }

export function createDepositIndexer(
    db: Db,
    publicClient: PublicClient,
    deployment: FairPayDeployment,
    options: { confirmations?: bigint; log?: (msg: string) => void } = {}
) {
    const confirmations = options.confirmations ?? 2n
    const log = options.log ?? ((msg: string) => console.warn("deposit indexer:", msg))
    const pool = deployment.pool!
    const startBlock = deployment.poolDeployBlock ?? 0n

    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_deposits (
            idx          INTEGER PRIMARY KEY,
            commitment   TEXT NOT NULL UNIQUE,
            block_number INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const lastKey = `deposits:${deployment.chainId}:${pool.toLowerCase()}`
    const q = {
        get: db.prepare("SELECT value FROM kv WHERE key = ?"),
        set: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
        unset: db.prepare("DELETE FROM kv WHERE key = ?"),
        byIdx: db.prepare("SELECT idx, commitment, block_number FROM pool_deposits WHERE idx = ?"),
        byCommitment: db.prepare("SELECT idx, commitment, block_number FROM pool_deposits WHERE commitment = ?"),
        insert: db.prepare("INSERT INTO pool_deposits (idx, commitment, block_number) VALUES (?, ?, ?)"),
        truncate: db.prepare("DELETE FROM pool_deposits WHERE idx >= ?"),
        all: db.prepare("SELECT idx, commitment, block_number FROM pool_deposits ORDER BY idx")
    }

    // pool_deposits holds one pool. If the deployment changed, the old pool's rows are wrong.
    const owner = (q.get.get("deposits:owner") as { value: string } | undefined)?.value
    // Databases from before this marker existed only ever indexed the current pool: keep them.
    if (owner !== undefined && owner !== lastKey) {
        log(`deployment changed from ${owner}; reindexing`)
        tx(db, () => {
            db.exec("DELETE FROM pool_deposits")
            q.unset.run(owner)
            q.unset.run(lastKey)
            q.set.run("deposits:owner", lastKey)
        })
    } else if (owner === undefined) {
        q.set.run("deposits:owner", lastKey)
    }

    const getLast = () => {
        const v = (q.get.get(lastKey) as { value: string } | undefined)?.value
        return v === undefined ? undefined : BigInt(v)
    }

    /** Rewinds the cursor so the next sync scans again from `block`. */
    const rescanFrom = (block: bigint) => {
        if (block <= startBlock) q.unset.run(lastKey)
        else q.set.run(lastKey, String(block - 1n))
    }

    function rows() {
        return q.all.all() as Row[]
    }

    /** Length of the run of deposits 0, 1, 2, ... with no hole. */
    function contiguous(all: Row[]) {
        let n = 0
        for (const r of all) {
            if (r.idx !== n) break
            n++
        }
        return n
    }

    function store(idx: number, commitment: string, block: number) {
        const at = q.byIdx.get(idx) as Row | undefined
        if (at?.commitment === commitment) return
        // A different commitment at this index, or this commitment at another index, means a
        // reorg replaced history. Everything from the first disagreement on is suspect.
        const elsewhere = q.byCommitment.get(commitment) as Row | undefined
        const from = Math.min(at ? idx : Infinity, elsewhere ? elsewhere.idx : Infinity)
        if (Number.isFinite(from)) {
            log(`deposit ${from} changed on-chain; dropping it and everything after`)
            q.truncate.run(from)
        }
        q.insert.run(idx, commitment, block)
    }

    let running: Promise<void> | undefined

    async function sync() {
        const latest = await publicClient.getBlockNumber({ cacheTime: 0 })
        const head = latest - confirmations
        let last = getLast()
        if (last !== undefined && last > latest) {
            // The chain is shorter than what was indexed: a local node restarted, or the RPC
            // points somewhere else. Start over rather than serve deposits that may not exist.
            log(`indexed up to block ${last} but the chain is at ${latest}; reindexing`)
            tx(db, () => {
                db.exec("DELETE FROM pool_deposits")
                q.unset.run(lastKey)
            })
            last = undefined
        }
        let from = last !== undefined ? last + 1n : startBlock
        while (from <= head) {
            const ranges: [bigint, bigint][] = []
            for (let i = 0n; i < PARALLEL && from <= head; i++) {
                const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n
                ranges.push([from, to])
                from = to + 1n
            }
            const results = await Promise.all(
                ranges.map(([f, t]) =>
                    publicClient.getContractEvents({ address: pool, abi: fairPoolAbi, eventName: "Deposit", fromBlock: f, toBlock: t })
                )
            )
            const logs = results
                .flat()
                .filter((l) => !l.removed)
                .sort((a, b) => Number(a.args.index! - b.args.index!))
            tx(db, () => {
                for (const l of logs) store(Number(l.args.index!), String(l.args.commitment!), Number(l.blockNumber))
                q.set.run(lastKey, String(ranges[ranges.length - 1]![1]))
            })
        }
        await reconcile(head)
    }

    /**
     * Compares what was indexed with the pool's own count at the indexed head. Missing deposits
     * (an RPC that silently returned fewer logs) trigger a rescan from the last deposit known to
     * be good; extra ones (reorged away) are dropped.
     */
    async function reconcile(head: bigint) {
        if (head < startBlock || getLast() === undefined) return
        let onChain: number
        try {
            onChain = Number(
                await publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "depositCount", blockNumber: head })
            )
        } catch {
            // Not every RPC serves state at a past block; the hole check below still runs.
            onChain = -1
        }
        const all = rows()
        const run = contiguous(all)
        const hasHole = run < all.length
        if (onChain >= 0 && run > onChain) {
            log(`indexed ${run} deposits but the pool has ${onChain}; dropping the extra`)
            tx(db, () => {
                q.truncate.run(onChain)
                rescanFrom(onChain > 0 ? BigInt(all[onChain - 1]!.block_number) : startBlock)
            })
            return
        }
        if (hasHole || (onChain >= 0 && run < onChain)) {
            const resume = run > 0 ? BigInt(all[run - 1]!.block_number) : startBlock
            log(`deposit ${run} is missing; rescanning from block ${resume}`)
            rescanFrom(resume)
        }
    }

    /** Runs one sync. Concurrent callers share the sync already in progress. */
    function syncOnce(): Promise<void> {
        if (!running) running = sync().finally(() => (running = undefined))
        return running
    }

    /** The contiguous run of deposits from index 0, in insertion order. */
    function commitments(): string[] {
        const all = rows()
        return all.slice(0, contiguous(all)).map((r) => r.commitment)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = true

    function start(intervalMs = 4000) {
        if (!stopped) return
        stopped = false
        let failures = 0
        const tick = async () => {
            try {
                await syncOnce()
                failures = 0
            } catch (err) {
                failures++
                log((err as Error).message.split("\n")[0]!)
            }
            const wait = failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS)
            if (!stopped) timer = setTimeout(tick, wait)
        }
        void tick()
    }

    /** Stops polling and waits for a sync in progress to finish writing. */
    async function stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        await running?.catch(() => undefined)
    }

    return { syncOnce, commitments, start, stop }
}
