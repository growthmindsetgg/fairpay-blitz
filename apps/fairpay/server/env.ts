import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import { getAddress, isAddress, type Address, type Hex } from "viem"
import { loadDeployment } from "./chain.js"
import { appPathFrom, publicOriginFrom } from "./origin.js"

const root = path.dirname(fileURLToPath(import.meta.url))
export const appDir = path.join(root, "..")

// apps/fairpay/.env first. Then the FairEats keys (relayer, faucet, merchant) from
// apps/faireats/.env, without overriding anything already set. Values are never printed.
const envFile = path.join(appDir, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)
const faireatsEnv = path.join(appDir, "..", "faireats", ".env")
const FALLBACK_KEYS = ["RELAYER_KEY", "FAUCET_KEY", "MERCHANT_ADDRESS"] as const
if (existsSync(faireatsEnv)) {
    const values = parseEnv(readFileSync(faireatsEnv, "utf8"))
    for (const k of FALLBACK_KEYS) {
        const v = values[k]
        if (!process.env[k] && v) process.env[k] = v
    }
}

function optional(name: string): string | undefined {
    const v = process.env[name]?.trim()
    return v ? v : undefined
}

function key(name: string): Hex | undefined {
    const v = optional(name)
    if (v === undefined) return undefined
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be a 32-byte hex private key`)
    return v as Hex
}

function address(name: string): Address | undefined {
    const v = optional(name)
    if (v === undefined) return undefined
    if (!isAddress(v, { strict: false })) throw new Error(`${name} is not an address`)
    return getAddress(v)
}

function count(name: string, fallback: number): number {
    const v = optional(name)
    if (v === undefined) return fallback
    if (!/^[0-9]{1,5}$/.test(v)) throw new Error(`${name} must be a whole number`)
    return Number(v)
}

// In the image the data folder isn't writable and the disk is wiped on restart, so local PGlite
// would fail with a bare permissions error or lose every bill. Say what's missing instead.
function databaseUrl(): string | undefined {
    const v = optional("DATABASE_URL")
    if (v === undefined && process.env.NODE_ENV?.trim() === "production") {
        throw new Error("DATABASE_URL is not set. Set it to your Supabase Session pooler connection string; see DEPLOY.md.")
    }
    return v
}

const deploymentFile = optional("DEPLOYMENT_FILE") ?? path.join(appDir, "..", "..", "packages", "contracts", "deployments", "monadTestnet.json")
export const deployment = loadDeployment(deploymentFile)

const merchant = address("MERCHANT_ADDRESS")

export const config = {
    port: count("PORT", 8788),
    /** Loopback by default so a local run is never reachable from the network. */
    host: optional("HOST") ?? "127.0.0.1",
    /** Required when NODE_ENV=production (the Dockerfile); http://localhost:5174 otherwise. */
    publicOrigin: publicOriginFrom(process.env),
    /** "/pay" when the website serves the app at PUBLIC_ORIGIN/pay/; "" (the root) by default. */
    appPath: appPathFrom(process.env),
    /**
     * Shared with the website's proxy, which sends it in x-fairpay-proxy on every /api request.
     * Optional; when set, a request without it is read as one that skipped the proxy (DEPLOY.md).
     */
    proxySecret: optional("PROXY_SECRET"),
    rpcUrl: optional("RPC_URL") ?? "https://testnet-rpc.monad.xyz",
    explorer: optional("EXPLORER_URL") ?? "https://testnet.monadexplorer.com",
    /** Supabase connection string. Required in production; unset elsewhere: local PGlite in data/pg. */
    databaseUrl: databaseUrl(),
    relayerKey: key("RELAYER_KEY"),
    /** Pays gas for the demo faucet. Testnet only. */
    faucetKey: key("FAUCET_KEY"),
    /**
     * Optional. Pays gas for Team pay's auto-pay keeper (claimFor on the payroll escrow for staff
     * whose owner turned auto-pay on). Its own testnet wallet: never RELAYER_KEY or FAUCET_KEY.
     */
    keeperKey: key("KEEPER_KEY"),
    merchant,
    /** Owner of the demo restaurant. Defaults to MERCHANT_ADDRESS. */
    demoOwnerWallet: address("DEMO_OWNER_WALLET") ?? merchant,
    /**
     * Reverse proxies in front of this server that append to X-Forwarded-For. 0 (the default)
     * trusts no header and uses the socket address; never set it higher than the real count.
     * The deployed setup, the website (Vercel) proxying /api to Render, needs 4: Vercel's hops plus
     * Cloudflare and Render's load balancer. Check with /api/whoami.
     */
    trustProxyHops: count("TRUST_PROXY_HOPS", 0),
    /** Blocks a deposit needs on top of it before the indexer serves it. */
    indexerConfirmations: BigInt(count("INDEXER_CONFIRMATIONS", deployment.chainId === 31337 ? 0 : 2)),
    /** Local PGlite only (no DATABASE_URL). Nothing else writes to disk. */
    dataDir: path.join(appDir, "data")
}
