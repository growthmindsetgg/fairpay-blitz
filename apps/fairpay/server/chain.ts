import { readFileSync } from "node:fs"
import { fairPoolAbi, findPayments, verifyPaymentTx, type FairPayDeployment } from "@fairpay/sdk"
import { createRelayer } from "@fairpay/sdk/relayer"
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    getAddress,
    http,
    parseEther,
    parseUnits,
    recoverMessageAddress,
    type Address,
    type Hash,
    type Hex,
    type PublicClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import type { SignatureVerifier } from "./auth.js"
import type { Chain, Db } from "./context.js"
import { assertDistinctKeys, createPayrollChain } from "./payroll.js"
import { verifyTokenTransfer, type TransferReader } from "./transfers.js"

export type Deployment = FairPayDeployment & { denomination: bigint; pool: Address }

/** Reads packages/contracts/deployments/<network>.json. */
export function loadDeployment(file: string): Deployment {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return {
        chainId: raw.chainId,
        token: getAddress(raw.token),
        fairPay: getAddress(raw.fairPay),
        pool: getAddress(raw.pool),
        poolDeployBlock: BigInt(raw.poolDeployBlock),
        denomination: BigInt(raw.denomination),
        // FairPoolBatcher, when deployed: browsers deposit several notes in one transaction.
        ...(raw.batcher ? { batcher: getAddress(raw.batcher) } : {}),
        // FairPayroll (Team pay's escrow), when deployed by scripts/deploy-payroll.ts.
        ...(raw.payroll ? { payroll: getAddress(raw.payroll), payrollDeployBlock: BigInt(raw.payrollDeployBlock ?? 0) } : {})
    }
}

const MERCHANT_CACHE_MS = 60_000
// A relay's gas limit on Monad testnet is about 1.44M (the estimate plus 15%); a little over that
// is one relay's worst case when deciding whether the relayer can still pay.
const RELAY_GAS_LIMIT = 1_500_000n
const READY_CACHE_MS = 30_000
// How far back a relay looks for a payment it couldn't confirm itself: a receipt wait gives up
// after 3 minutes, which is about 450 blocks on Monad. 20 eth_getLogs calls of 100 blocks.
const RECOVERY_BLOCKS = 2_000n

/**
 * Confirmations a payment needs before it is credited, counted as verifyPaymentTx counts them
 * (the payment's own block is 1). A credit can't be undone (the kitchen starts cooking, an
 * invoice number is used), so wait for 2 on Monad testnet. PAYMENT_CONFIRMATIONS overrides it; a
 * local Hardhat chain (31337) needs none, since it only mines when sent a transaction.
 */
export function paymentConfirmations(env: Record<string, string | undefined>, chainId: number): bigint {
    const v = env.PAYMENT_CONFIRMATIONS?.trim()
    if (!v) return chainId === 31337 ? 0n : 2n
    if (!/^[0-9]{1,3}$/.test(v)) throw new Error("PAYMENT_CONFIRMATIONS must be a whole number")
    return BigInt(v)
}

/**
 * The live chain: payment verification, FairPool's merchant allowlist (cached for a minute), and,
 * when their keys are set, the private-payment relayer and the testnet faucet.
 */
export function createChain(opts: {
    deployment: Deployment
    rpcUrl: string
    relayerKey?: Hex
    faucetKey?: Hex
    /** Auto-pay keeper (Team pay escrow). Only compared here: it must differ from the other two. */
    keeperKey?: Hex
    now?: () => number
    /** See paymentConfirmations. Default 2. */
    minConfirmations?: bigint
}) {
    const now = opts.now ?? Date.now
    const { deployment } = opts
    // The relayer and the faucet each keep their own sends in order. On one wallet they would
    // pick the same nonces and fail each other's transactions. Compared here, never printed.
    // The keeper is the same: its own wallet.
    assertDistinctKeys({ relayerKey: opts.relayerKey, faucetKey: opts.faucetKey, keeperKey: opts.keeperKey })
    const minConfirmations = opts.minConfirmations ?? 2n
    const transport = http(opts.rpcUrl)
    const publicClient = createPublicClient({ chain: monadTestnet, transport }) as PublicClient

    const transferReader: TransferReader = {
        getChainId: () => publicClient.getChainId(),
        getTransactionReceipt: (a) => publicClient.getTransactionReceipt(a),
        getBlockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
        getBlock: (a) => publicClient.getBlock(a)
    }

    const merchants = new Map<string, { value: boolean; until: number }>()
    const merchantLookups = new Map<string, Promise<boolean>>()

    const chain: Chain = {
        deployment,
        // Too few confirmations is "pending": settle answers 202 and the browser asks again.
        verify: (params) => verifyPaymentTx(deployment, publicClient, { ...params, minConfirmations }),
        // Team pay: the same confirmations and canonical-block rule as payments.
        verifyTransfer: (params) => verifyTokenTransfer(deployment, transferReader, { ...params, minConfirmations }),
        // Shift approvals are checked with the same confirmations and canonical-block rule.
        ...(deployment.payroll
            ? { payroll: createPayrollChain({ deployment: { ...deployment, payroll: deployment.payroll }, publicClient, reader: transferReader, minConfirmations }) }
            : {}),
        async isMerchant(addr) {
            const key = addr.toLowerCase()
            const hit = merchants.get(key)
            if (hit && hit.until > now()) return hit.value
            // Concurrent page loads share one RPC call.
            let p = merchantLookups.get(key)
            if (!p) {
                p = publicClient
                    .readContract({ address: deployment.pool, abi: fairPoolAbi, functionName: "isMerchant", args: [getAddress(addr)] })
                    .then((v) => {
                        merchants.set(key, { value: Boolean(v), until: now() + MERCHANT_CACHE_MS })
                        return Boolean(v)
                    })
                    .finally(() => merchantLookups.delete(key))
                merchantLookups.set(key, p)
            }
            return p
        }
    }

    const relayerAccount = opts.relayerKey ? privateKeyToAccount(opts.relayerKey) : undefined
    const relayer = relayerAccount
        ? createRelayer(deployment, {
              publicClient,
              walletClient: createWalletClient({ chain: monadTestnet, transport, account: relayerAccount })
          })
        : undefined

    // Whether the relayer can pay for one more relay: Monad reserves gas limit x max fee up front.
    // Cached so /config doesn't cost two RPC calls per page load; concurrent callers share a lookup.
    // If the RPC can't answer, the last answer stands (true at first): a failed relay says why anyway.
    let ready = { value: true, until: 0 }
    let readyLookup: Promise<boolean> | undefined
    function relayerReady(): Promise<boolean> {
        if (!relayerAccount) return Promise.resolve(false)
        if (ready.until > now()) return Promise.resolve(ready.value)
        readyLookup ??= Promise.all([publicClient.getBalance({ address: relayerAccount.address }), publicClient.estimateFeesPerGas()])
            .then(([balance, fees]) => {
                ready = { value: balance >= RELAY_GAS_LIMIT * (fees.maxFeePerGas ?? 0n), until: now() + READY_CACHE_MS }
                return ready.value
            })
            .catch((err: unknown) => {
                console.warn("relayer balance:", err instanceof Error ? err.message.split("\n")[0] : err)
                return ready.value
            })
            .finally(() => {
                readyLookup = undefined
            })
        return readyLookup
    }

    const faucetWallet = opts.faucetKey
        ? createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(opts.faucetKey) })
        : undefined

    const mintAbi = [
        { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }
    ] as const
    // Testnet demo faucet: test USDC plus a little MON for gas. Faucet transactions are sent one
    // at a time so their nonces never collide.
    let faucetQueue: Promise<unknown> = Promise.resolve()
    const FAUCET_USDC = parseUnits("50", 6)
    // Monad reserves gas limit x max fee up front; a batched top-up of 11 notes needs about
    // 0.28 MON, so give a little more than that.
    const FAUCET_GAS = parseEther("0.3")
    // Monad keeps a 10 MON reserve balance per account: a transfer that takes the sender below it
    // reverts on execution (gas spent, status 0) unless it is the sender's first transaction within
    // the last few blocks. The faucet wallet usually holds less than 10 MON, so the MON transfer goes
    // first and only after the faucet's previous transaction is FAUCET_QUIET_BLOCKS behind.
    // https://docs.monad.xyz/developer-essentials/reserve-balance
    const FAUCET_QUIET_BLOCKS = 4n
    let faucetLastBlock = 0n
    async function faucetSend(send: () => Promise<Hash>, what: string) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: await send() })
        faucetLastBlock = receipt.blockNumber
        if (receipt.status !== "success") throw new Error(`faucet ${what} reverted: ${receipt.transactionHash}`)
    }
    async function faucetQuiet() {
        for (let i = 0; i < 40 && (await publicClient.getBlockNumber()) < faucetLastBlock + FAUCET_QUIET_BLOCKS; i++) {
            await new Promise((r) => setTimeout(r, 250))
        }
    }
    async function faucet(to: Address) {
        const w = faucetWallet
        if (!w) throw new Error("faucet not configured")
        const run = async () => {
            let gasSent = 0n
            if ((await publicClient.getBalance({ address: to })) < parseEther("0.1")) {
                await faucetQuiet()
                await faucetSend(() => w.sendTransaction({ to, value: FAUCET_GAS }), "gas transfer")
                gasSent = FAUCET_GAS
            }
            await faucetSend(() => w.writeContract({ address: deployment.token, abi: mintAbi, functionName: "mint", args: [to, FAUCET_USDC] }), "mint")
            return { minted: "50", gasSent: formatEther(gasSent) }
        }
        const p = faucetQueue.then(run, run)
        faucetQueue = p.catch(() => undefined)
        return p
    }

    /**
     * Sign-in signatures: an EOA signature is recovered locally; anything else (a smart wallet)
     * goes through viem's verifySiweMessage, which checks ERC-1271 / ERC-6492 on-chain.
     */
    const verifySignature: SignatureVerifier = async ({ message, signature, address }) => {
        try {
            const signer = await recoverMessageAddress({ message, signature })
            if (signer.toLowerCase() === address.toLowerCase()) return true
        } catch {
            // Not a plain 65-byte signature; try the contract path.
        }
        return publicClient.verifySiweMessage({ message, signature, address })
    }

    /**
     * Hashes of FairPay payments for `orderRef` to `merchant` in the last RECOVERY_BLOCKS blocks.
     * Only a lead: the pay service verifies each one like any other hash before crediting it.
     */
    async function recentPayments(orderRef: Hex, merchant: Address): Promise<Hash[]> {
        const latest = await publicClient.getBlockNumber({ cacheTime: 0 })
        const floor = deployment.poolDeployBlock ?? 0n
        const fromBlock = latest - floor > RECOVERY_BLOCKS ? latest - RECOVERY_BLOCKS : floor
        const found = await findPayments(deployment, publicClient, { orderRef, merchant, fromBlock })
        return [...new Set(found.map((p) => p.txHash.toLowerCase() as Hash))]
    }

    return {
        chain,
        publicClient,
        verifySignature,
        relay: relayer ? (body: unknown): Promise<{ txHash: Hash }> => relayer.handle(body) : undefined,
        relayerReady: relayer ? relayerReady : undefined,
        findPayments: recentPayments,
        faucet: faucetWallet ? faucet : undefined,
        /** Waits for queued faucet sends (shutdown). */
        drain: () => faucetQueue.catch(() => undefined)
    }
}

// ------------------------------------------------------------------ deposit indexer

const CHUNK = 100n // Monad's public RPC rejects larger eth_getLogs ranges.
const PARALLEL = 8n
const MAX_BACKOFF_MS = 60_000
// With nothing new to write, the cursor is saved at most this often. Losing a minute of scanning on
// a restart costs a couple of eth_getLogs calls; a write every 4 seconds would cost the database.
const SAVE_EVERY_MS = 60_000
// Rows per INSERT when saving deposits, well under Postgres's 65535 parameters.
const SAVE_BATCH = 500
// An RPC node may lag behind the block this indexer (or another instance sharing the database)
// already reached. Up to this many blocks is lag to wait out; more means the chain really is
// shorter (a local node restarted) and the index starts over.
const LAG_BLOCKS = 1000n

type Deposit = { idx: number; commitment: string; block: number }

/**
 * Keeps a copy of every pool deposit so browsers don't scan logs from the deploy block.
 *
 * Browsers don't trust this list: the SDK's groupFromCommitments checks the resulting root
 * against the pool on-chain. A wrong list can't steal anything, but it stops private payments,
 * so the indexer repairs itself: it only reads blocks with enough confirmations, replaces deposits
 * a reorg rewrote, and rescans when its count disagrees with the pool's depositCount.
 *
 * Ported from FairEats. Deposits are served from memory and saved to the app's database
 * (pool_indexer_state, pool_deposits), so a restart, or a free-plan instance waking up with an
 * empty disk, resumes where it stopped instead of rescanning from the deploy block.
 *
 * Several processes may share one database (a redeploy overlaps the old and new instance). Each
 * save locks the pool's state row, and the saved cursor only moves forward unless this indexer
 * deliberately rewound it (reorg, missing deposit). The saved deposits always cover every block up
 * to the saved cursor, because both are written in the same transaction; anything a racing writer
 * gets wrong is caught by reconcile() on the next start.
 */
export function createDepositIndexer(
    db: Db,
    publicClient: PublicClient,
    deployment: Deployment,
    options: { confirmations?: bigint; log?: (msg: string) => void; now?: () => number } = {}
) {
    const confirmations = options.confirmations ?? 2n
    const log = options.log ?? ((msg: string) => console.warn("deposit indexer:", msg))
    const now = options.now ?? Date.now
    const pool = deployment.pool
    const key = [deployment.chainId, pool.toLowerCase()] as const
    const startBlock = deployment.poolDeployBlock ?? 0n

    // idx → deposit. `last` is the last block fully scanned, undefined before the first scan.
    const byIdx = new Map<number, Deposit>()
    const byCommitment = new Map<string, number>()
    let last: bigint | undefined

    // What changed since the last save: deposits stored, the lowest index dropped, and whether the
    // cursor went backwards on purpose.
    const dirty = new Set<number>()
    let droppedFrom: number | undefined
    let rewound = false
    let savedAt = 0

    let loaded: Promise<void> | undefined
    /** Reads the saved state once, before the first sync. A failed read is retried next sync. */
    function load() {
        loaded ??= (async () => {
            // The cursor first, then the deposits: a save landing in between then at worst leaves
            // deposits past the cursor, which the next scan confirms or reconcile() drops.
            const state = await db.one<{ last_block: number | null }>(
                "SELECT last_block FROM pool_indexer_state WHERE chain_id = $1 AND pool = $2",
                [...key]
            )
            const saved = await db.query<{ idx: number; commitment: string; block_number: number }>(
                "SELECT idx, commitment, block_number FROM pool_deposits WHERE chain_id = $1 AND pool = $2 ORDER BY idx",
                [...key]
            )
            for (const r of saved) {
                byIdx.set(r.idx, { idx: r.idx, commitment: r.commitment, block: Number(r.block_number) })
                byCommitment.set(r.commitment, r.idx)
            }
            last = state?.last_block == null ? undefined : BigInt(state.last_block)
        })().catch((err) => {
            loaded = undefined
            throw err
        })
        return loaded
    }

    async function save() {
        // Take what is pending now; changes made while the write is in flight wait for the next save.
        const ids = [...dirty]
        const from = droppedFrom
        const rewind = rewound
        const cursor = last === undefined ? null : String(last)
        dirty.clear()
        droppedFrom = undefined
        rewound = false
        // A deposit stored and then dropped is gone from byIdx; the DELETE below covers it.
        const deposits = ids.flatMap((i) => byIdx.get(i) ?? []).sort((a, b) => a.idx - b.idx)
        try {
            await db.tx(async (q) => {
                const at = now()
                await q.query(
                    "INSERT INTO pool_indexer_state (chain_id, pool, last_block, updated_at) VALUES ($1, $2, NULL, $3) ON CONFLICT (chain_id, pool) DO NOTHING",
                    [...key, at]
                )
                // One writer per pool at a time.
                await q.query("SELECT last_block FROM pool_indexer_state WHERE chain_id = $1 AND pool = $2 FOR UPDATE", [...key])
                if (from !== undefined) {
                    await q.query("DELETE FROM pool_deposits WHERE chain_id = $1 AND pool = $2 AND idx >= $3", [...key, from])
                }
                for (let i = 0; i < deposits.length; i += SAVE_BATCH) {
                    const batch = deposits.slice(i, i + SAVE_BATCH)
                    const params: unknown[] = [...key]
                    const values = batch.map((d) => {
                        params.push(d.idx, d.commitment, String(d.block))
                        const n = params.length
                        return `($1, $2, $${n - 2}, $${n - 1}, $${n})`
                    })
                    await q.query(
                        `INSERT INTO pool_deposits (chain_id, pool, idx, commitment, block_number) VALUES ${values.join(", ")}
                         ON CONFLICT (chain_id, pool, idx) DO UPDATE SET commitment = excluded.commitment, block_number = excluded.block_number`,
                        params
                    )
                }
                // GREATEST ignores NULL, so a writer that is behind never pulls the cursor back.
                // Only a deliberate rewind (reorg, missing deposit, shorter chain) may.
                await q.query(
                    rewind
                        ? "UPDATE pool_indexer_state SET last_block = $3, updated_at = $4 WHERE chain_id = $1 AND pool = $2"
                        : "UPDATE pool_indexer_state SET last_block = GREATEST(last_block, $3::bigint), updated_at = $4 WHERE chain_id = $1 AND pool = $2",
                    [...key, cursor, at]
                )
            })
            savedAt = now()
        } catch (err) {
            // Keep the changes for the next save.
            for (const i of ids) dirty.add(i)
            if (from !== undefined) droppedFrom = Math.min(droppedFrom ?? from, from)
            rewound ||= rewind
            log(`could not save progress: ${err instanceof Error ? err.message.split("\n")[0] : err}`)
        }
    }

    const rows = () => [...byIdx.values()].sort((a, b) => a.idx - b.idx)

    function truncate(from: number) {
        for (const [idx, d] of byIdx) {
            if (idx >= from) {
                byIdx.delete(idx)
                byCommitment.delete(d.commitment)
            }
        }
        droppedFrom = Math.min(droppedFrom ?? from, from)
    }

    /** Length of the run of deposits 0, 1, 2, ... with no hole. */
    function contiguous(all: Deposit[]) {
        let n = 0
        for (const r of all) {
            if (r.idx !== n) break
            n++
        }
        return n
    }

    /** Rewinds the cursor so the next sync scans again from `block`. */
    const rescanFrom = (block: bigint) => {
        last = block <= startBlock ? undefined : block - 1n
        rewound = true
    }

    function store(idx: number, commitment: string, block: number) {
        const at = byIdx.get(idx)
        if (at?.commitment === commitment) return
        // A different commitment at this index, or this commitment at another index, means a
        // reorg replaced history. Everything from the first disagreement on is suspect.
        const elsewhere = byCommitment.get(commitment)
        const from = Math.min(at ? idx : Infinity, elsewhere !== undefined ? elsewhere : Infinity)
        if (Number.isFinite(from)) {
            log(`deposit ${from} changed on-chain; dropping it and everything after`)
            truncate(from)
        }
        byIdx.set(idx, { idx, commitment, block })
        byCommitment.set(commitment, idx)
        dirty.add(idx)
    }

    let running: Promise<void> | undefined

    async function sync() {
        await load()
        const latest = await publicClient.getBlockNumber({ cacheTime: 0 })
        const head = latest - confirmations
        // A local node has one view of the chain, so any gap there is a restart.
        const lag = deployment.chainId === 31337 ? 0n : LAG_BLOCKS
        if (last !== undefined && last > latest + lag) {
            // The chain is shorter than what was indexed: start over rather than serve deposits
            // that may not exist.
            log(`indexed up to block ${last} but the chain is at ${latest}; reindexing`)
            truncate(0)
            last = undefined
            rewound = true
        }
        // The RPC is behind what was already indexed. Checking deposits against its older block
        // would wrongly drop the newer ones (and rewind the saved state), so wait for it.
        if (last !== undefined && last > head) return
        let from = last !== undefined ? last + 1n : startBlock
        let rounds = 0
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
            for (const l of logs) store(Number(l.args.index!), String(l.args.commitment!), Number(l.blockNumber))
            last = ranges[ranges.length - 1]![1]
            // A first scan can take a while; save progress now and then so a restart resumes.
            if (++rounds % 25 === 0) await save()
        }
        await reconcile(head)
        if (dirty.size > 0 || droppedFrom !== undefined || rewound || now() - savedAt >= SAVE_EVERY_MS) await save()
    }

    /**
     * Compares what was indexed with the pool's own count at the indexed head. Missing deposits
     * trigger a rescan from the last deposit known to be good; extra ones (reorged away) are dropped.
     */
    async function reconcile(head: bigint): Promise<boolean> {
        if (head < startBlock || last === undefined) return false
        let onChain: number
        try {
            onChain = Number(await publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "depositCount", blockNumber: head }))
        } catch {
            // Not every RPC serves state at a past block; the hole check below still runs.
            onChain = -1
        }
        const all = rows()
        const run = contiguous(all)
        if (onChain >= 0 && run > onChain) {
            log(`indexed ${run} deposits but the pool has ${onChain}; dropping the extra`)
            truncate(onChain)
            rescanFrom(onChain > 0 ? BigInt(all[onChain - 1]!.block) : startBlock)
            return true
        }
        if (run < all.length || (onChain >= 0 && run < onChain)) {
            const resume = run > 0 ? BigInt(all[run - 1]!.block) : startBlock
            log(`deposit ${run} is missing; rescanning from block ${resume}`)
            rescanFrom(resume)
            return true
        }
        return false
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

    /** Stops polling, waits for a sync in progress to finish, and saves progress. */
    async function stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        await running?.catch(() => undefined)
        // Only once the saved state has been read, so this can never overwrite it with nothing.
        if (loaded) await save()
    }

    return { syncOnce, commitments, start, stop }
}
