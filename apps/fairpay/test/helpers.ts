// Test harness shared by every server test: an in-memory database, a fake chain the test
// controls, and the full app with every route module that exists so far.

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Hono } from "hono"
import { fairPayrollAbi, type EmployeeInfo, type EmployerInfo, type PaySchedule, type VerifiedPayment, type VerifyResult } from "@fairpay/sdk"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address, type Hash, type Hex, type Log } from "viem"
import type { PublicConfig, Wallet } from "../shared/types.js"
import { createApp } from "../server/app.js"
import { authRoutes, createSession, SESSION_COOKIE } from "../server/auth.js"
import type { AppEnv, Chain, Deps, RouteModule } from "../server/context.js"
import { memoryDb, type OpenDb } from "../server/db.js"
import { activityRoutes } from "../server/routes/activity.js"
import { chainRoutes, type ChainServices } from "../server/routes/chain.js"
import { friendRoutes } from "../server/routes/friends.js"
import { meRoutes } from "../server/routes/me.js"
import { payRoutes } from "../server/routes/pay.js"
import { verifyShiftApprovals, type PayrollChain } from "../server/payroll.js"
import { verifyTokenTransfer, type TransferParams, type TransferReader } from "../server/transfers.js"

export const TEST_ORIGIN = "http://localhost:5174"
export const DENOMINATION = 5_000_000

export const TEST_DEPLOYMENT: Chain["deployment"] = {
    chainId: 10143,
    token: "0x00000000000000000000000000000000000000a1",
    fairPay: "0x00000000000000000000000000000000000000a2",
    pool: "0x00000000000000000000000000000000000000a3",
    poolDeployBlock: 1n,
    denomination: BigInt(DENOMINATION)
}

/** Where the fake payroll escrow lives, when a test turns it on (fakeChain({ payroll: true })). */
export const TEST_PAYROLL = "0x00000000000000000000000000000000000000a4" as Address

export type VerifyParams = Parameters<Chain["verify"]>[0]

/**
 * A chain the test controls.
 *  - `merchants`: lowercase wallets FairPool allowlists (isMerchant).
 *  - `verifyResult`: what verify() answers; a value, or a function of the params. Default:
 *    "pending" (nothing was paid).
 *  - `calls`: every verify() call, for assertions.
 */
export type FakeChain = Chain & {
    merchants: Set<string>
    verifyResult: VerifyResult | ((p: VerifyParams) => VerifyResult | Promise<VerifyResult>)
    calls: VerifyParams[]
    /**
     * Team pay's verifyTransfer runs the real check (server/transfers.ts) over these: receipts by
     * lowercase hash, the latest block, the confirmations it asks for (2, like the live server),
     * and block numbers whose canonical block is another one (a reorg).
     */
    receipts: Map<string, FakeReceipt>
    head: bigint
    transferConfirmations: bigint
    reorged: Set<bigint>
    transferCalls: TransferParams[]
    /** Present with fakeChain({ payroll: true }): the escrow's views come from these maps. */
    payroll?: FakePayroll
}

/**
 * The payroll escrow's views, set by the test: employer and (employer:employee) keys are lowercase.
 * Missing entries read as an empty account. Shift approvals run the real check over the receipts.
 */
export type FakePayroll = PayrollChain & {
    employers: Map<string, Partial<EmployerInfo>>
    employees: Map<string, Partial<EmployeeInfo>>
    schedules: Map<string, Partial<PaySchedule>>
    funding: (employer: Address, until: bigint) => bigint
    /** Every employeeInfo read, as "employer:employee". */
    employeeReads: string[]
    /** Throw from every read (an RPC outage). */
    failReads: boolean
}

const ZERO_EMPLOYER: EmployerInfo = { balance: 0n, available: 0n, owed: 0n, shortfall: 0n, fundedUntil: 0n, runwayUntil: 0n, payPerDay: 0n }
const ZERO_EMPLOYEE: EmployeeInfo = { claimable: 0n, earned: 0n, shortfall: 0n, settled: 0n, debt: 0n, scheduleEarned: 0n, nextPeriodEnd: 0n }
const ZERO_SCHEDULE: PaySchedule = { amountPerPeriod: 0n, period: 0n, start: 0n, origin: 0n, endedAt: 0n, paid: 0n }
const pairKey = (a: string, b: string) => `${a.toLowerCase()}:${b.toLowerCase()}`

export type FakeReceipt = { status: "success" | "reverted"; blockNumber: bigint; blockHash: Hash; logs: Log[] }

export function fakeChain(init: { merchants?: string[]; verifyResult?: FakeChain["verifyResult"]; payroll?: boolean } = {}): FakeChain {
    const reader: TransferReader = {
        getChainId: async () => TEST_DEPLOYMENT.chainId,
        getTransactionReceipt: async ({ hash }) => chain.receipts.get(hash.toLowerCase()) ?? null,
        getBlockNumber: async () => chain.head,
        getBlock: async ({ blockNumber }) => ({ hash: chain.reorged.has(blockNumber) ? blockHashOf(blockNumber + 1_000_000n) : blockHashOf(blockNumber) })
    }
    const chain: FakeChain = {
        deployment: TEST_DEPLOYMENT,
        merchants: new Set((init.merchants ?? []).map((m) => m.toLowerCase())),
        verifyResult: init.verifyResult ?? { status: "pending", confirmations: 0n },
        calls: [],
        receipts: new Map(),
        head: 100n,
        transferConfirmations: 2n,
        reorged: new Set(),
        transferCalls: [],
        async verify(p) {
            chain.calls.push(p)
            return typeof chain.verifyResult === "function" ? chain.verifyResult(p) : chain.verifyResult
        },
        async isMerchant(addr: Address) {
            return chain.merchants.has(addr.toLowerCase())
        },
        async verifyTransfer(p) {
            chain.transferCalls.push(p)
            return verifyTokenTransfer(TEST_DEPLOYMENT, reader, { ...p, minConfirmations: chain.transferConfirmations })
        }
    }
    if (init.payroll) {
        const fail = () => {
            if (payroll.failReads) throw new Error("rpc down")
        }
        const payroll: FakePayroll = {
            address: TEST_PAYROLL,
            deployBlock: 1n,
            employers: new Map(),
            employees: new Map(),
            schedules: new Map(),
            funding: () => 0n,
            employeeReads: [],
            failReads: false,
            latestBlock: async () => chain.head,
            async employerInfo(employer) {
                fail()
                return { ...ZERO_EMPLOYER, ...payroll.employers.get(employer.toLowerCase()) }
            },
            async employeeInfo(employer, employee) {
                fail()
                payroll.employeeReads.push(pairKey(employer, employee))
                return { ...ZERO_EMPLOYEE, ...payroll.employees.get(pairKey(employer, employee)) }
            },
            async scheduleOf(employer, employee) {
                fail()
                return { ...ZERO_SCHEDULE, ...payroll.schedules.get(pairKey(employer, employee)) }
            },
            async fundingNeeded(employer, until) {
                fail()
                return payroll.funding(employer, until)
            },
            verifyShiftApprovals: (p) =>
                verifyShiftApprovals({ chainId: TEST_DEPLOYMENT.chainId, payroll: TEST_PAYROLL }, reader, { ...p, minConfirmations: chain.transferConfirmations })
        }
        chain.payroll = payroll
    }
    return chain
}

const blockHashOf = (n: bigint) => `0x${n.toString(16).padStart(64, "b")}` as Hash

/** An ERC-20 Transfer log, from the deployment's token unless `token` says otherwise. */
export function transferLog(t: { from: string; to: string; value: number | bigint; token?: string }): Omit<Log, "blockHash" | "blockNumber" | "transactionHash" | "logIndex"> {
    return {
        address: getAddress(t.token ?? TEST_DEPLOYMENT.token),
        topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: getAddress(t.from), to: getAddress(t.to) } }) as Log["topics"],
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(t.value)]),
        transactionIndex: 0,
        removed: false
    }
}

/** A FairPayroll ShiftApproved log, from the fake payroll contract unless `contract` says otherwise. */
export function shiftApprovedLog(s: { employer: string; employee: string; shiftId: Hex; amount: number | bigint; contract?: string }): ReturnType<typeof transferLog> {
    return {
        address: getAddress(s.contract ?? TEST_PAYROLL),
        topics: encodeEventTopics({
            abi: fairPayrollAbi,
            eventName: "ShiftApproved",
            args: { employer: getAddress(s.employer), employee: getAddress(s.employee), shiftId: s.shiftId }
        }) as Log["topics"],
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(s.amount)]),
        transactionIndex: 0,
        removed: false
    }
}

/**
 * Puts a mined transaction on the fake chain. By default it has exactly the confirmations Team
 * pay needs (its block is head - 1). Returns its hash.
 */
export function mineTransfer(
    chain: FakeChain,
    opts: { logs: ReturnType<typeof transferLog>[]; status?: "success" | "reverted"; blockNumber?: bigint; txHash?: Hash }
): Hash {
    const h = opts.txHash ?? txHash()
    const blockNumber = opts.blockNumber ?? chain.head - chain.transferConfirmations + 1n
    const blockHash = blockHashOf(blockNumber)
    chain.receipts.set(h.toLowerCase(), {
        status: opts.status ?? "success",
        blockNumber,
        blockHash,
        // Log indexes are each log's position in the transaction.
        logs: opts.logs.map((l, i) => ({ ...l, logIndex: i, blockHash, blockNumber, transactionHash: h }) as Log)
    })
    return h
}

let txCounter = 0
/** A fresh, unique transaction hash. */
export function txHash(): Hash {
    txCounter += 1
    return `0x${txCounter.toString(16).padStart(64, "0")}` as Hash
}

/**
 * A verify() answer the real SDK would give for a matching payment. Use it from a verifyResult
 * function to answer "verified" only when the params match what the chain "saw":
 *
 *     chain.verifyResult = paidOnChain({ txHash: h, amount: 15_000_000, payer: alice })
 */
export function paidOnChain(paid: {
    txHash: Hash
    amount: number
    /** The payer wallet for a public payment; omit for a private one (payer = the pool). */
    payer?: Wallet
    orderRef?: Hex
    recipient?: Wallet
    logIndex?: number
}): (p: VerifyParams) => VerifyResult {
    return (p) => {
        if (p.txHash.toLowerCase() !== paid.txHash.toLowerCase()) return { status: "pending", confirmations: 0n }
        if (paid.orderRef && p.orderRef.toLowerCase() !== paid.orderRef.toLowerCase()) return { status: "rejected", reason: "no matching PaymentReceived event" }
        if (paid.recipient && p.merchant.toLowerCase() !== paid.recipient.toLowerCase()) return { status: "rejected", reason: "no matching PaymentReceived event" }
        if (BigInt(paid.amount) !== p.amount) return { status: "rejected", reason: `amount ${paid.amount} does not equal required ${p.amount}` }
        const kind = paid.payer ? "public" : "private"
        const payer = paid.payer ? getAddress(paid.payer) : getAddress(TEST_DEPLOYMENT.pool)
        if (kind === "public" && p.expectedPayer && getAddress(p.expectedPayer) !== payer) {
            return { status: "rejected", reason: "paid from a different wallet than the participant" }
        }
        const payment: VerifiedPayment = {
            chainId: TEST_DEPLOYMENT.chainId,
            txHash: paid.txHash,
            logIndex: paid.logIndex ?? 0,
            blockNumber: 100n,
            payer,
            amount: BigInt(paid.amount),
            kind
        }
        return { status: "verified", payment }
    }
}

export const TEST_CONFIG: PublicConfig = {
    chainId: 10143,
    chainName: "Monad Testnet",
    rpcUrl: "http://127.0.0.1:1",
    explorer: "https://testnet.monadexplorer.com",
    token: TEST_DEPLOYMENT.token.toLowerCase() as Wallet,
    fairPay: TEST_DEPLOYMENT.fairPay.toLowerCase() as Wallet,
    pool: TEST_DEPLOYMENT.pool.toLowerCase() as Wallet,
    poolDeployBlock: "1",
    denomination: DENOMINATION,
    relayer: "/api/relay",
    faucet: false,
    storage: "local"
}

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Other builders' route modules, loaded only if their file exists yet, so this harness works
 * while they are still being written. A module that exists but fails to load is an error.
 */
async function optionalRoutes(): Promise<RouteModule[]> {
    const wanted: [string, string][] = [
        ["bills", "billRoutes"],
        ["restaurants", "restaurantRoutes"],
        ["orders", "orderRoutes"],
        ["images", "imageRoutes"]
    ]
    const routes: RouteModule[] = []
    for (const [file, name] of wanted) {
        const full = path.join(here, "..", "server", "routes", `${file}.ts`)
        if (!existsSync(full)) continue
        const mod = (await import(/* @vite-ignore */ pathToFileURL(full).href)) as Record<string, unknown>
        if (typeof mod[name] !== "function") throw new Error(`server/routes/${file}.ts does not export ${name}`)
        routes.push(mod[name] as RouteModule)
    }
    return routes
}

export type TestApp = {
    app: Hono<AppEnv>
    deps: Deps & { db: OpenDb }
    chain: FakeChain
    /** Inserts a session (and profile) for this wallet directly; returns the Cookie header value. */
    signIn(wallet: string): Promise<string>
    /**
     * app.request with JSON and the x-fairpay header filled in.
     * `cookie` is what signIn returned.
     */
    call(method: string, path: string, opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }): Promise<Response>
}

export async function makeTestApp(
    opts: { chain?: FakeChain; now?: () => number; services?: Partial<ChainServices>; appPath?: string } = {}
): Promise<TestApp> {
    const db = await memoryDb()
    const chain = opts.chain ?? fakeChain()
    const deps = { db, chain, now: opts.now ?? Date.now, publicOrigin: TEST_ORIGIN, appPath: opts.appPath }
    const services: ChainServices = { config: TEST_CONFIG, commitments: () => [], ...opts.services }
    const routes: RouteModule[] = [
        (d) => authRoutes(d),
        meRoutes,
        friendRoutes,
        activityRoutes,
        payRoutes,
        (d) => chainRoutes(d, services),
        ...(await optionalRoutes())
    ]
    // Tests pick the client address with an x-test-ip header (one address by default).
    const app = createApp({ ...deps, routes, clientIp: (c) => c.req.header("x-test-ip") ?? "127.0.0.1" })

    return {
        app,
        deps,
        chain,
        async signIn(wallet: string) {
            const token = await createSession(db, wallet.toLowerCase() as Wallet, deps.now())
            return `${SESSION_COOKIE}=${token}`
        },
        call(method, p, o = {}) {
            const headers: Record<string, string> = { "x-fairpay": "1", ...o.headers }
            if (o.cookie) headers.cookie = o.cookie
            let body: string | undefined
            if (o.body !== undefined) {
                body = JSON.stringify(o.body)
                headers["content-type"] ??= "application/json"
            }
            return Promise.resolve(app.request(p, { method, headers, body }))
        }
    }
}
