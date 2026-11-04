// Contract addresses come from the deployment record the contracts package writes, so the site
// always shows the live deployment. Vite inlines the JSON at build time.
import deployment from "../../../packages/contracts/deployments/monadTestnet.json"

export const EXPLORER = "https://testnet.monadexplorer.com"
export const CHAIN_ID = 10143
export const SITE_URL = "https://fairpay-blitz.vercel.app"

export type ProofTx = {
    kind: "Public" | "Private"
    hash: string
    note: string
    /** Sender, read from the chain with eth_getTransactionByHash. */
    from: string
    fromLabel: "Guest wallet" | "Restaurant relayer"
    to: string
    toLabel: "FairPay router" | "Privacy pool"
    block: number
}

/**
 * Real payments against the contracts below, shown on the landing page and in the guide. Add
 * entries once payments have been made on this deployment (hash, sender and block read from the
 * chain). While the list is empty, the pages link to the contracts on the explorer instead.
 */
export const PROOF_TXS: ProofTx[] = []

export const POOL_ADDRESS: string = deployment.pool

export const CONTRACTS = [
    { name: "FairPay router", address: deployment.fairPay },
    { name: "FairPool (privacy pool, 5 USDC notes)", address: deployment.pool },
    { name: "Test USDC (MockUSDC, anyone can mint)", address: deployment.token },
    { name: "Semaphore verifier for Monad", address: deployment.verifier }
]

/** The rest of the deployed contracts, listed on /about. Ones not in the deployment record are left out. */
export const MORE_CONTRACTS = (
    [
        { name: "FairPoolBatcher (adds several notes in one go)", address: (deployment as Record<string, unknown>).batcher },
        { name: "FairPayroll (payroll escrow for restaurant staff)", address: (deployment as Record<string, unknown>).payroll },
        { name: "PoseidonT3 (hash library used by the pool)", address: (deployment as Record<string, unknown>).poseidonT3 }
    ] as { name: string; address: unknown }[]
).filter((c): c is { name: string; address: string } => typeof c.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(c.address))

export const short = (h: string, head = 6, tail = 4) => `${h.slice(0, head)}…${h.slice(-tail)}`
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`

/**
 * The real FairPay app (bill splitting plus FairEats). This website serves it at /pay/ (a separate
 * static build, so links to it are full page loads) and forwards /api to its server on Render's
 * free plan. After a quiet spell the server takes up to a minute to wake; the app says so itself.
 */
export const APP_URL = "/pay/"
/** Shown in the screenshot frames' address bar. */
export const APP_HOST = "fairpay-blitz.vercel.app/pay"

// The demo lives at /app/ as a separate static build, so links to it are full page loads.
// FairEats reads ?table= from the menu URL, so the demo opens at table 4.
export const DEMO_URL = "/app/"
export const DEMO_TABLE_URL = "/app/?table=4"
