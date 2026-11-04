import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getAddress, isAddress, type Address, type Hex } from "viem"
import type { FairPayDeployment } from "@fairpay/sdk"

const root = path.dirname(fileURLToPath(import.meta.url))
export const appDir = path.join(root, "..")

const envFile = path.join(appDir, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

function required(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`)
    return v
}

function key(name: string): Hex {
    const v = required(name)
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be a 32-byte hex private key`)
    return v as Hex
}

function address(name: string): Address {
    const v = required(name)
    if (!isAddress(v)) throw new Error(`${name} is not an address`)
    return getAddress(v)
}

function count(name: string, fallback: number): number {
    const v = process.env[name]
    if (v === undefined || v === "") return fallback
    if (!/^[0-9]{1,3}$/.test(v)) throw new Error(`${name} must be a small whole number`)
    return Number(v)
}

const deploymentFile =
    process.env.DEPLOYMENT_FILE ?? path.join(appDir, "..", "..", "packages", "contracts", "deployments", "monadTestnet.json")
const raw = JSON.parse(readFileSync(deploymentFile, "utf8"))

export const deployment: FairPayDeployment & { denomination: bigint } = {
    chainId: raw.chainId,
    token: getAddress(raw.token),
    fairPay: getAddress(raw.fairPay),
    pool: getAddress(raw.pool),
    poolDeployBlock: BigInt(raw.poolDeployBlock),
    denomination: BigInt(raw.denomination)
}

export const config = {
    port: Number(process.env.PORT ?? 8787),
    /**
     * Address to listen on. Loopback by default so a local run is never reachable from the
     * network; the container image sets 0.0.0.0 because the host's proxy connects from outside.
     */
    host: process.env.HOST ?? "127.0.0.1",
    rpcUrl: process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz",
    relayerKey: key("RELAYER_KEY"),
    /** Pays gas for the demo faucet. Testnet only. */
    faucetKey: key("FAUCET_KEY"),
    merchant: address("MERCHANT_ADDRESS"),
    kitchenPin: required("KITCHEN_PIN"),
    dbFile: process.env.DB_FILE ?? path.join(appDir, "data", "faireats.db"),
    /**
     * Reverse proxies in front of this server that append to X-Forwarded-For. 0 (the default)
     * trusts no header and uses the socket address; never set it higher than the real count, or
     * clients can pick their own rate-limit key.
     */
    trustProxyHops: count("TRUST_PROXY_HOPS", 0),
    /**
     * Blocks a deposit needs on top of it before the indexer serves it. A local Hardhat node
     * (chain 31337) mines one block per transaction, so waiting there would hold back the latest
     * deposit until two more transactions happen; it has no reorgs to wait out anyway.
     */
    indexerConfirmations: BigInt(count("INDEXER_CONFIRMATIONS", deployment.chainId === 31337 ? 0 : 2))
}

if (config.kitchenPin.length < 6) throw new Error("KITCHEN_PIN must be at least 6 characters")
