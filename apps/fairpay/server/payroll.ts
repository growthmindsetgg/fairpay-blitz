// Team pay part 2: the payroll escrow (packages/contracts/contracts/FairPayroll.sol). Only when the
// deployment records a `payroll` contract (deployments/<network>.json); without one nothing here
// runs and the escrow endpoints answer 503 "not set up".
//
// The escrow belongs to the restaurant owner's wallet (the contract's "employer"). FairPay never
// holds or moves its money: the owner's browser funds, withdraws, approves shifts and sets
// schedules, staff claim from their own wallets. The server only
//  - reads the contract's views (employerInfo, employeeInfo, scheduleOf, fundingNeeded),
//  - indexes its events into the append-only payroll_events table, for history,
//  - records a shift approval only after checking its ShiftApproved event on-chain, and
//  - with KEEPER_KEY set, runs a keeper that calls claimFor for staff whose owner switched on
//    auto-pay. claimFor always pays the employee; the keeper only spends its own gas.

import { claimPayFor, fairPayrollAbi, FairPayError, readEmployeeInfo, readEmployerInfo, readFundingNeeded, readSchedule } from "@fairpay/sdk"
import type { Clients, EmployeeInfo, EmployerInfo, PaySchedule } from "@fairpay/sdk"
import { getAddress, parseEventLogs, type Address, type Hash, type Hex, type PublicClient } from "viem"
import type { Wallet } from "../shared/types.js"
import type { Db } from "./context.js"
import { fmtUsdc } from "./faireats.js"
import type { TransferReader } from "./transfers.js"
import { addActivity } from "./routes/activity.js"

export type { EmployeeInfo, EmployerInfo, PaySchedule }

/** Reads at one block so a view's numbers agree with each other. */
export type ReadAt = { blockNumber?: bigint }

/** The payroll escrow as the routes see it. Tests pass a fake (test/helpers.ts). */
export interface PayrollChain {
    address: Address
    deployBlock: bigint
    /** The latest block, uncached; pass it to the reads below. */
    latestBlock(): Promise<bigint>
    employerInfo(employer: Address, at?: ReadAt): Promise<EmployerInfo>
    employeeInfo(employer: Address, employee: Address, at?: ReadAt): Promise<EmployeeInfo>
    scheduleOf(employer: Address, employee: Address, at?: ReadAt): Promise<PaySchedule>
    /** Tokens to fund now for every running schedule to be set aside up to `until` (unix seconds). */
    fundingNeeded(employer: Address, until: bigint, at?: ReadAt): Promise<bigint>
    /** The ShiftApproved events of `txHash` by `employer`, checked like a payment. */
    verifyShiftApprovals(params: { txHash: Hash; employer: Address }): Promise<ShiftApprovalResult>
    /** The auto-pay keeper's wallet, set when KEEPER_KEY is (server/index.ts). Owners can turn auto-pay on only then. */
    keeper?: Address
}

export type ApprovedShiftLog = { employee: Address; shiftId: Hex; amount: bigint; logIndex: number }

export type ShiftApprovalResult =
    | { status: "verified"; chainId: number; txHash: Hash; blockNumber: bigint; shifts: ApprovedShiftLog[] }
    | { status: "pending"; confirmations: bigint }
    | { status: "rejected"; reason: string }

/**
 * Checks that `txHash` succeeded on the deployment's chain in a canonical block with at least
 * `minConfirmations`, and returns its ShiftApproved events emitted by the payroll contract itself
 * for `employer`. Events from any other contract are ignored: anyone can emit a look-alike.
 */
export async function verifyShiftApprovals(
    deployment: { chainId: number; payroll: Address },
    client: TransferReader,
    params: { txHash: Hash; employer: Address; minConfirmations?: bigint }
): Promise<ShiftApprovalResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) throw new FairPayError("INVALID_INPUT", "bad txHash")
    const employer = getAddress(params.employer)
    const id = await client.getChainId()
    if (id !== deployment.chainId) throw new FairPayError("WRONG_CHAIN", `RPC is on chain ${id}, deployment is on ${deployment.chainId}`)

    const receipt = await client.getTransactionReceipt({ hash: params.txHash }).catch(() => null)
    if (!receipt) return { status: "pending", confirmations: 0n }
    if (receipt.status !== "success") return { status: "rejected", reason: "transaction reverted" }
    const latest = await client.getBlockNumber()
    const confirmations = latest - receipt.blockNumber + 1n
    if (confirmations < (params.minConfirmations ?? 1n)) return { status: "pending", confirmations }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null)
    if (!block || block.hash !== receipt.blockHash) return { status: "pending", confirmations: 0n }

    const payroll = getAddress(deployment.payroll)
    const logs = parseEventLogs({ abi: fairPayrollAbi, eventName: "ShiftApproved", logs: receipt.logs }).filter(
        (l) => !l.removed && getAddress(l.address) === payroll && getAddress(l.args.employer) === employer
    )
    if (logs.length === 0) return { status: "rejected", reason: "no shift approval by this restaurant's owner in this transaction" }
    if (logs.some((l) => l.logIndex === null)) return { status: "pending", confirmations: 0n }
    return {
        status: "verified",
        chainId: deployment.chainId,
        txHash: params.txHash.toLowerCase() as Hash,
        blockNumber: receipt.blockNumber,
        shifts: logs.map((l) => ({ employee: getAddress(l.args.employee), shiftId: l.args.shiftId.toLowerCase() as Hex, amount: l.args.amount, logIndex: l.logIndex! }))
    }
}

/** The live escrow: the SDK's reads over viem, and the shift check over the same reader as Team pay. */
export function createPayrollChain(opts: {
    deployment: { chainId: number; payroll: Address; payrollDeployBlock?: bigint }
    publicClient: PublicClient
    reader: TransferReader
    minConfirmations: bigint
}): PayrollChain {
    const { deployment, publicClient, reader } = opts
    return {
        address: getAddress(deployment.payroll),
        deployBlock: deployment.payrollDeployBlock ?? 0n,
        latestBlock: () => publicClient.getBlockNumber({ cacheTime: 0 }),
        employerInfo: (employer, at) => readEmployerInfo(deployment, publicClient, employer, at),
        employeeInfo: (employer, employee, at) => readEmployeeInfo(deployment, publicClient, employer, employee, at),
        scheduleOf: (employer, employee, at) => readSchedule(deployment, publicClient, employer, employee, at),
        fundingNeeded: (employer, until, at) => readFundingNeeded(deployment, publicClient, employer, until, at),
        verifyShiftApprovals: (p) => verifyShiftApprovals(deployment, reader, { ...p, minConfirmations: opts.minConfirmations })
    }
}

// ------------------------------------------------------------------ keys

/**
 * Each server wallet keeps its own nonces in order (relayer, faucet, keeper). Two of them on one
 * key would pick the same nonces and fail each other's transactions. Compared, never printed.
 */
export function assertDistinctKeys(keys: { relayerKey?: Hex; faucetKey?: Hex; keeperKey?: Hex }) {
    const same = (a?: Hex, b?: Hex) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
    if (same(keys.relayerKey, keys.faucetKey)) {
        throw new Error("RELAYER_KEY and FAUCET_KEY are the same key. Give the faucet its own testnet wallet (see DEPLOY.md).")
    }
    if (same(keys.keeperKey, keys.relayerKey)) throw new Error("KEEPER_KEY and RELAYER_KEY are the same key. Give the keeper its own testnet wallet.")
    if (same(keys.keeperKey, keys.faucetKey)) throw new Error("KEEPER_KEY and FAUCET_KEY are the same key. Give the keeper its own testnet wallet.")
}

// ------------------------------------------------------------------ event indexer

export const PAYROLL_EVENTS = ["Funded", "Withdrawn", "ShiftApproved", "ScheduleSet", "ScheduleEnded", "Claimed", "Shortfall", "Underfunded", "DebtBacked", "DebtRepaid", "Resigned"] as const
export type PayrollEventName = (typeof PAYROLL_EVENTS)[number]

/** A decoded FairPayroll log, as viem's getContractEvents returns it. */
export type PayrollLog = {
    eventName: string
    args: Record<string, unknown>
    blockNumber: bigint | null
    transactionHash: Hash | null
    logIndex: number | null
    removed?: boolean
}

/** What the indexer reads. Live: viem over the RPC; tests: a fake. */
export interface PayrollLogSource {
    getBlockNumber(): Promise<bigint>
    /** Every FairPayroll event in [fromBlock, toBlock]. */
    getLogs(fromBlock: bigint, toBlock: bigint): Promise<PayrollLog[]>
    /** The block's timestamp in unix seconds. */
    getBlockTime(blockNumber: bigint): Promise<bigint>
}

export function payrollLogSource(publicClient: PublicClient, payroll: Address): PayrollLogSource {
    return {
        getBlockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
        getLogs: async (fromBlock, toBlock) =>
            (await publicClient.getContractEvents({ address: payroll, abi: fairPayrollAbi, fromBlock, toBlock })) as unknown as PayrollLog[],
        getBlockTime: async (blockNumber) => (await publicClient.getBlock({ blockNumber })).timestamp
    }
}

const CHUNK = 100n // Monad's public RPC rejects larger eth_getLogs ranges.
const PARALLEL = 8n
const MAX_BACKOFF_MS = 60_000
const SAVE_EVERY_MS = 60_000
const LAG_BLOCKS = 1000n

const lower = (v: unknown) => String(v).toLowerCase()
const dec = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v ?? "0"))

/** The columns one event is stored with: who it is about and its main amount. The rest goes in args. */
function eventRow(l: PayrollLog) {
    const a = l.args
    // Resigned carries no amount (its ScheduleEnded right after has the settlement): stored as 0.
    const amountKey: Record<Exclude<PayrollEventName, "Resigned">, string> = {
        Funded: "amount",
        Withdrawn: "amount",
        ShiftApproved: "amount",
        ScheduleSet: "amountPerPeriod",
        ScheduleEnded: "settled",
        Claimed: "amount",
        Shortfall: "unpaid",
        Underfunded: "shortfall",
        DebtBacked: "amount",
        DebtRepaid: "amount"
    }
    const name = l.eventName as PayrollEventName
    const args: Record<string, string> = {}
    for (const [k, v] of Object.entries(a)) args[k] = typeof v === "bigint" ? v.toString() : lower(v)
    return {
        event: name,
        employer: lower(a.employer),
        employee: a.employee === undefined ? null : lower(a.employee),
        caller: a.caller === undefined ? null : lower(a.caller),
        shiftId: a.shiftId === undefined ? null : lower(a.shiftId),
        amount: name === "Resigned" ? "0" : dec(a[amountKey[name]]),
        args
    }
}

/**
 * Keeps a copy of every FairPayroll event for the history views. Like the deposit indexer it reads
 * only blocks with `confirmations` on top, saves its progress in Postgres (payroll_indexer_state)
 * and resumes from there, starting at the contract's deploy block. Events are appended to
 * payroll_events under UNIQUE(chain_id, contract, tx_hash, log_index), so a rescan, a restart or a
 * second instance never stores one twice; events and the cursor are written in one transaction.
 *
 * Every event is stored, not only restaurant owners': on a public chain anyone can use the escrow
 * (each event costs its sender gas). The views filter by employer.
 *
 * A ShiftApproved event also marks the matching pending shift approved (same employer, shiftId,
 * employee and amount), so a browser that lost the transaction hash still ends up recorded.
 */
export function createPayrollIndexer(
    db: Db,
    source: PayrollLogSource,
    opts: { chainId: number; contract: Address; deployBlock: bigint; confirmations?: bigint; log?: (msg: string) => void; now?: () => number }
) {
    const confirmations = opts.confirmations ?? 2n
    const log = opts.log ?? ((msg: string) => console.warn("payroll indexer:", msg))
    const now = opts.now ?? Date.now
    const key = [opts.chainId, opts.contract.toLowerCase()] as const
    const startBlock = opts.deployBlock

    let last: bigint | undefined
    let loaded = false
    let savedAt = 0

    async function load() {
        if (loaded) return
        const state = await db.one<{ last_block: number | null }>("SELECT last_block FROM payroll_indexer_state WHERE chain_id = $1 AND contract = $2", [...key])
        last = state?.last_block == null ? undefined : BigInt(state.last_block)
        loaded = true
    }

    /** Saves the events of one round and the cursor after them, in one transaction. */
    async function save(logs: PayrollLog[], cursor: bigint, times: Map<bigint, bigint>, rewind = false) {
        await db.tx(async (q) => {
            const at = now()
            await q.query(
                "INSERT INTO payroll_indexer_state (chain_id, contract, last_block, updated_at) VALUES ($1, $2, NULL, $3) ON CONFLICT (chain_id, contract) DO NOTHING",
                [...key, at]
            )
            await q.query("SELECT last_block FROM payroll_indexer_state WHERE chain_id = $1 AND contract = $2 FOR UPDATE", [...key])
            for (const l of logs) {
                const r = eventRow(l)
                const blockTime = Number(times.get(l.blockNumber!) ?? 0n) * 1000
                const inserted = await q.one<{ id: number }>(
                    `INSERT INTO payroll_events (chain_id, contract, block_number, block_time, tx_hash, log_index, event, employer, employee, caller, shift_id, amount, args)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                     ON CONFLICT (chain_id, contract, tx_hash, log_index) DO NOTHING RETURNING id`,
                    [...key, String(l.blockNumber), blockTime, lower(l.transactionHash), l.logIndex, r.event, r.employer, r.employee, r.caller, r.shiftId, r.amount, JSON.stringify(r.args)]
                )
                if (inserted && r.event === "ShiftApproved") {
                    await q.query(
                        `UPDATE payroll_shifts SET status = 'approved', approved_tx = $5, approved_block = $6, approved_log_index = $7, approved_at = $8
                         WHERE chain_id = $1 AND contract = $2 AND employer = $3 AND shift_id = $4 AND employee = $9 AND amount::text = $10 AND status = 'pending'`,
                        [...key, r.employer, r.shiftId, lower(l.transactionHash), String(l.blockNumber), l.logIndex, blockTime || at, r.employee, r.amount]
                    )
                }
            }
            await q.query(
                rewind
                    ? "UPDATE payroll_indexer_state SET last_block = $3, updated_at = $4 WHERE chain_id = $1 AND contract = $2"
                    : "UPDATE payroll_indexer_state SET last_block = GREATEST(last_block, $3::bigint), updated_at = $4 WHERE chain_id = $1 AND contract = $2",
                [...key, String(cursor), at]
            )
        })
        savedAt = now()
    }

    let running: Promise<void> | undefined

    async function sync() {
        await load()
        const latest = await source.getBlockNumber()
        const head = latest - confirmations
        const lag = opts.chainId === 31337 ? 0n : LAG_BLOCKS
        let rewind = false
        if (last !== undefined && last > latest + lag) {
            // A shorter chain (a local node restarted). Stored events stay (the table is append-only);
            // scanning again only adds what is new.
            log(`indexed up to block ${last} but the chain is at ${latest}; scanning again from the deploy block`)
            last = undefined
            rewind = true
        }
        if (last !== undefined && last > head) return
        let from = last !== undefined ? last + 1n : startBlock
        let unsaved = false
        while (from <= head) {
            const ranges: [bigint, bigint][] = []
            for (let i = 0n; i < PARALLEL && from <= head; i++) {
                const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n
                ranges.push([from, to])
                from = to + 1n
            }
            const results = await Promise.all(ranges.map(([f, t]) => source.getLogs(f, t)))
            const logs = results
                .flat()
                .filter((l) => !l.removed && l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null && (PAYROLL_EVENTS as readonly string[]).includes(l.eventName))
                .sort((a, b) => (a.blockNumber! === b.blockNumber! ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1))
            const cursor = ranges[ranges.length - 1]![1]
            if (logs.length > 0 || rewind) {
                const blocks = [...new Set(logs.map((l) => l.blockNumber!))]
                const times = new Map<bigint, bigint>()
                await Promise.all(blocks.map(async (b) => times.set(b, await source.getBlockTime(b))))
                await save(logs, cursor, times, rewind)
                rewind = false
                unsaved = false
            } else {
                unsaved = true
            }
            last = cursor
        }
        if ((unsaved || rewind) && last !== undefined && now() - savedAt >= SAVE_EVERY_MS) await save([], last, new Map(), rewind)
    }

    function syncOnce(): Promise<void> {
        if (!running) running = sync().finally(() => (running = undefined))
        return running
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = true

    function start(intervalMs = 5000) {
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

    async function stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        await running?.catch(() => undefined)
        if (loaded && last !== undefined) await save([], last, new Map()).catch(() => undefined)
    }

    return { syncOnce, start, stop }
}

// ------------------------------------------------------------------ keeper (auto-pay)

/**
 * Whether the auto-pay keeper runs: only with its own KEEPER_KEY and a payroll contract. Without
 * the key it never starts and owners can't turn auto-pay on.
 */
export function keeperMode(keeperKey: Hex | undefined, payroll: Address | undefined): "on" | "off" | "no-payroll" {
    if (!keeperKey) return "off"
    return payroll ? "on" : "no-payroll"
}

/** What the keeper sends with: its own wallet, never the relayer's or the faucet's. */
export interface KeeperWallet {
    address: Address
    /** Whether the keeper's MON covers one more claimFor's gas reservation. */
    canPay(): Promise<boolean>
    /** Simulates, then sends claimFor(employer, employee). Throws when the simulation reverts. */
    claimFor(employer: Address, employee: Address): Promise<Hash>
    /** Waits for the receipt; `amount` is what the Claimed event paid (null if none). */
    wait(hash: Hash): Promise<{ status: "success" | "reverted"; amount: bigint | null }>
}

/** Gas limit one claimFor can need, with room; Monad reserves gas limit x max fee up front. */
const CLAIM_GAS = 250_000n

export function keeperWallet(deployment: { chainId: number; token: Address; fairPay: Address; payroll: Address }, clients: Clients): KeeperWallet {
    const address = clients.walletClient.account.address
    return {
        address,
        async canPay() {
            const [balance, fees] = await Promise.all([clients.publicClient.getBalance({ address }), clients.publicClient.estimateFeesPerGas()])
            return balance >= CLAIM_GAS * (fees.maxFeePerGas ?? 0n) * 2n
        },
        claimFor: async (employer, employee) => (await claimPayFor(deployment, clients, employer, employee)).txHash,
        async wait(hash) {
            const r = await clients.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
            const claimed = parseEventLogs({ abi: fairPayrollAbi, eventName: "Claimed", logs: r.logs }).find((l) => getAddress(l.address) === getAddress(deployment.payroll))
            return { status: r.status, amount: claimed?.args.amount ?? null }
        }
    }
}

export type KeeperOptions = {
    db: Db
    payroll: Pick<PayrollChain, "employeeInfo">
    wallet: KeeperWallet
    now?: () => number
    log?: (msg: string) => void
    /** How often it runs. Default 5 minutes. */
    intervalMs?: number
    /** Most claimFor calls in one run. Default 10. */
    maxPerRun?: number
    /** Most claimFor calls in any hour. Default 60. */
    maxPerHour?: number
    /** A pair is paid at most once in this time. Default 1 hour. */
    pairCooldownMs?: number
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Auto-pay: every few minutes, for each staff member whose restaurant owner switched auto-pay on
 * (payroll_settings.auto_pay, still on the staff, the restaurant's owner as employer), reads
 * employeeInfo and calls claimFor when something is claimable. Nobody else is ever claimed for.
 * claimFor pays only the employee, so the keeper can't move anyone's money anywhere else; it only
 * spends its own gas, bounded by maxPerRun, maxPerHour and a cooldown per pair, and it stops while
 * its wallet can't cover a claim's gas. Logs name short wallets and transaction hashes, never keys.
 */
export function createPayrollKeeper(opts: KeeperOptions) {
    const now = opts.now ?? Date.now
    const log = opts.log ?? ((msg: string) => console.log("payroll keeper:", msg))
    const maxPerRun = opts.maxPerRun ?? 10
    const maxPerHour = opts.maxPerHour ?? 60
    const cooldown = opts.pairCooldownMs ?? 60 * 60_000
    const lastPaid = new Map<string, number>()
    let sent: number[] = []

    /** The opted-in pairs: one row per (employer, employee), with a restaurant to name. */
    async function pairs() {
        return opts.db.query<{ employer: Wallet; employee: Wallet; restaurant_id: string; restaurant_name: string }>(
            `SELECT DISTINCT ON (r.owner_wallet, s.wallet) r.owner_wallet AS employer, s.wallet AS employee, r.id AS restaurant_id, r.name AS restaurant_name
             FROM payroll_settings p
             JOIN restaurants r ON r.id = p.restaurant_id
             JOIN restaurant_staff s ON s.restaurant_id = p.restaurant_id AND s.wallet = p.wallet
             WHERE p.auto_pay AND s.wallet <> r.owner_wallet
             ORDER BY r.owner_wallet, s.wallet, r.created_at`
        )
    }

    let running: Promise<{ claimed: number; skipped: number }> | undefined

    async function run() {
        let claimed = 0
        let skipped = 0
        const t = now()
        sent = sent.filter((x) => x > t - 3_600_000)
        for (const p of await pairs()) {
            if (claimed >= maxPerRun || sent.length >= maxPerHour) {
                skipped++
                continue
            }
            const k = `${p.employer}:${p.employee}`
            if ((lastPaid.get(k) ?? -Infinity) > t - cooldown) {
                skipped++
                continue
            }
            const employer = getAddress(p.employer)
            const employee = getAddress(p.employee)
            let claimable: bigint
            try {
                claimable = (await opts.payroll.employeeInfo(employer, employee)).claimable
            } catch (err) {
                log(`could not read ${short(p.employee)}: ${err instanceof Error ? err.message.split("\n")[0] : err}`)
                continue
            }
            if (claimable <= 0n) continue
            if (!(await opts.wallet.canPay().catch(() => false))) {
                log("the keeper wallet is low on MON; auto-pay paused until it is topped up")
                break
            }
            lastPaid.set(k, t)
            sent.push(t)
            claimed++
            try {
                const hash = await opts.wallet.claimFor(employer, employee)
                const r = await opts.wallet.wait(hash)
                if (r.status !== "success") {
                    log(`claimFor ${short(p.employee)} reverted: ${hash}`)
                    continue
                }
                const amount = r.amount ?? claimable
                log(`auto-paid ${fmtUsdc(Number(amount))} USDC to ${short(p.employee)} from ${short(p.employer)}: ${hash}`)
                await addActivity(
                    opts.db,
                    {
                        wallet: p.employee,
                        kind: "payment_received",
                        title: `You were auto-paid ${fmtUsdc(Number(amount))} USDC by ${p.restaurant_name}`,
                        detail: "From the payroll escrow, straight to your wallet.",
                        link: `/business/faireats/manage/${p.restaurant_id}?tab=mypay`
                    },
                    now()
                ).catch(() => undefined)
            } catch (err) {
                // A simulation revert (claimed meanwhile, NothingToClaim) or an RPC error. Short text only.
                log(`claimFor ${short(p.employee)} failed: ${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 160) : "error"}`)
            }
        }
        return { claimed, skipped }
    }

    function runOnce() {
        if (!running) running = run().finally(() => (running = undefined))
        return running
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = true
    function start() {
        if (!stopped) return
        stopped = false
        const tick = async () => {
            try {
                await runOnce()
            } catch (err) {
                log(err instanceof Error ? err.message.split("\n")[0]! : "run failed")
            }
            if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 5 * 60_000)
        }
        // The first run waits one interval, so a restart loop can't spend gas quickly.
        timer = setTimeout(tick, opts.intervalMs ?? 5 * 60_000)
    }
    async function stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        await running?.catch(() => undefined)
    }
    return { runOnce, start, stop, address: opts.wallet.address }
}
