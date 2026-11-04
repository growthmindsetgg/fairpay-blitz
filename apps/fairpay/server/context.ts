// The seams between server modules. Route modules (bills, restaurants, ...) are written against
// these types only, so each can be built and tested on its own. server/app.ts wires them up.

import type { Hono } from "hono"
import type { FairPayDeployment, VerifyResult } from "@fairpay/sdk"
import type { Address, Hash, Hex } from "viem"
import type { Wallet } from "../shared/types.js"
import type { PayrollChain } from "./payroll.js"
import type { TransferParams, TransferResult } from "./transfers.js"

/**
 * Database access. Same interface over PGlite (local, tests) and postgres.js (Supabase).
 * Parameters are $1, $2, ... BIGINT columns come back as JS numbers. Rows use the column names
 * as written in schema.sql (snake_case); map them to API shapes in the route module.
 */
export interface Db {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
    one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
    /** Runs fn in one transaction (BEGIN ... COMMIT, ROLLBACK on throw). Use the q passed in. */
    tx<T>(fn: (q: Db) => Promise<T>): Promise<T>
}

/** Chain access the routes need. Tests pass a fake. */
export interface Chain {
    deployment: FairPayDeployment & { denomination: bigint; pool: Address }
    /** SDK verifyPaymentTx bound to the deployment and RPC client. */
    verify(params: { txHash: Hash; orderRef: Hex; merchant: Address; amount: bigint; expectedPayer?: Address }): Promise<VerifyResult>
    /** FairPool.isMerchant(addr), cached for a minute. */
    isMerchant(addr: Address): Promise<boolean>
    /** A plain transfer of the deployment's token (Team pay), checked like verify. See server/transfers.ts. */
    verifyTransfer(params: TransferParams): Promise<TransferResult>
    /**
     * Team pay's payroll escrow (FairPayroll), only when the deployment records `payroll`.
     * Absent: the escrow endpoints answer 503 and the app keeps its "coming soon" card.
     */
    payroll?: PayrollChain
}

export type Deps = {
    db: Db
    chain: Chain
    now: () => number
    /** e.g. "http://localhost:5174". Sign-in checks it; share links start with it. */
    publicOrigin: string
    /** The app's path on publicOrigin ("" for the root, "/pay" on the website). See origin.ts. */
    appPath?: string
}

/** Hono variables set by the auth middleware (server/auth.ts). */
export type AppEnv = { Variables: { wallet: Wallet | null } }

/** A route module: `export function billRoutes(deps: Deps): Hono<AppEnv>`, mounted under /api. */
export type RouteModule = (deps: Deps) => Hono<AppEnv>
