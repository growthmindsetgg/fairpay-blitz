import path from "node:path"
import { serve } from "@hono/node-server"
import { getConnInfo } from "@hono/node-server/conninfo"
import type { Context } from "hono"
import type { Wallet } from "../shared/types.js"
import { createApp } from "./app.js"
import { authRoutes } from "./auth.js"
import { createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import { createChain, createDepositIndexer, paymentConfirmations } from "./chain.js"
import type { Deps } from "./context.js"
import { openDb } from "./db.js"
import { createPayrollIndexer, createPayrollKeeper, keeperMode, keeperWallet, payrollLogSource } from "./payroll.js"
import { appDir, config, deployment } from "./env.js"
import { clientAddress, PROXY_HEADER, proxiedClientAddress, proxyVerdict, VERCEL_CLIENT_HEADER } from "./http.js"
import { activityRoutes } from "./routes/activity.js"
import { billRoutes } from "./routes/bills.js"
import { chainRoutes } from "./routes/chain.js"
import { friendRoutes } from "./routes/friends.js"
import { imageRoutes } from "./routes/images.js"
import { meRoutes } from "./routes/me.js"
import { orderRoutes } from "./routes/orders.js"
import { payRoutes } from "./routes/pay.js"
import { restaurantRoutes } from "./routes/restaurants.js"
import { refreshDemoOrders, seedDemo } from "./seed.js"

const live = createChain({
    deployment,
    rpcUrl: config.rpcUrl,
    relayerKey: config.relayerKey,
    faucetKey: config.faucetKey,
    keeperKey: config.keeperKey,
    minConfirmations: paymentConfirmations(process.env, deployment.chainId)
})
// /api/config waits for the relayer's balance check (two RPC calls, then cached briefly). After a
// cold start the first request is the visitor's own, so start that check now, alongside the
// database work below, instead of when it arrives. It never throws.
void live.relayerReady?.()
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: path.join(config.dataDir, "pg") })
// Progress is saved in the database, so a restart resumes instead of rescanning the pool.
const indexer = createDepositIndexer(db, live.publicClient, deployment, { confirmations: config.indexerConfirmations })
indexer.start()

// Team pay's payroll escrow, only when the deployment records it: an event indexer for the history
// (progress saved in the database like the deposit indexer's) and, with KEEPER_KEY, the auto-pay
// keeper, which only ever calls claimFor from its own wallet.
const payroll = live.chain.payroll
const payrollIndexer =
    payroll && deployment.payroll
        ? createPayrollIndexer(db, payrollLogSource(live.publicClient, payroll.address), {
              chainId: deployment.chainId,
              contract: payroll.address,
              deployBlock: payroll.deployBlock,
              confirmations: config.indexerConfirmations
          })
        : undefined
payrollIndexer?.start()
let keeper: ReturnType<typeof createPayrollKeeper> | undefined
const keeperOn = keeperMode(config.keeperKey, payroll?.address)
if (keeperOn === "on" && config.keeperKey && payroll && deployment.payroll) {
    const walletClient = createWalletClient({ chain: monadTestnet, transport: http(config.rpcUrl), account: privateKeyToAccount(config.keeperKey) })
    const kw = keeperWallet({ ...deployment, payroll: deployment.payroll }, { publicClient: live.publicClient, walletClient })
    payroll.keeper = kw.address
    keeper = createPayrollKeeper({ db, payroll, wallet: kw })
    keeper.start()
} else if (keeperOn === "no-payroll") {
    console.warn("KEEPER_KEY is set but the deployment has no payroll contract; auto-pay is off.")
}

const deps: Deps = { db, chain: live.chain, now: Date.now, publicOrigin: config.publicOrigin, appPath: config.appPath }

// Behind the website's proxy, X-Forwarded-For has one hop more than for a request straight to the
// host. With PROXY_SECRET set, a request without the proxy's header is read with one hop fewer,
// and one with it takes the visitor's address from Vercel's own header instead (http.ts).
const proxyStatus = (c: Context) => proxyVerdict(config.proxySecret, c.req.header(PROXY_HEADER))
const hopsFor = (c: Context) => (proxyStatus(c) === "no" ? Math.max(0, config.trustProxyHops - 1) : config.trustProxyHops)

if (config.demoOwnerWallet && config.merchant) {
    const { created } = await seedDemo(db, {
        ownerWallet: config.demoOwnerWallet.toLowerCase() as Wallet,
        payoutWallet: config.merchant.toLowerCase() as Wallet,
        now: Date.now()
    })
    if (created) console.log("Seeded the demo restaurant.")
    // The sample orders are never cooked, so restart their clocks rather than show stale estimates.
    else await refreshDemoOrders(db, Date.now())
} else {
    console.warn("MERCHANT_ADDRESS is not set; skipping the demo restaurant.")
}

const app = createApp({
    ...deps,
    rpcUrl: config.rpcUrl,
    staticDir: path.join(appDir, "dist"),
    clientIp: (c) => {
        const byHops = clientAddress(getConnInfo(c).remote.address, c.req.header("x-forwarded-for"), hopsFor(c))
        return proxyStatus(c) === "yes" ? proxiedClientAddress(c.req.header(VERCEL_CLIENT_HEADER), byHops) : byHops
    },
    proxyStatus,
    routes: [
        (d) => authRoutes(d, { verifySignature: live.verifySignature }),
        meRoutes,
        friendRoutes,
        activityRoutes,
        payRoutes,
        (d) =>
            chainRoutes(d, {
                config: {
                    chainId: deployment.chainId,
                    chainName: "Monad Testnet",
                    rpcUrl: config.rpcUrl,
                    explorer: config.explorer,
                    token: deployment.token.toLowerCase() as Wallet,
                    fairPay: deployment.fairPay.toLowerCase() as Wallet,
                    pool: deployment.pool.toLowerCase() as Wallet,
                    poolDeployBlock: String(deployment.poolDeployBlock),
                    ...(deployment.batcher ? { batcher: deployment.batcher.toLowerCase() as Wallet } : {}),
                    ...(payroll ? { payroll: payroll.address.toLowerCase() as Wallet } : {}),
                    ...(payroll?.keeper ? { keeper: payroll.keeper.toLowerCase() as Wallet } : {}),
                    denomination: Number(deployment.denomination),
                    relayer: live.relay ? "/api/relay" : "",
                    faucet: live.faucet !== undefined,
                    storage: db.storage
                },
                relay: live.relay,
                relayerReady: live.relayerReady,
                findPayments: live.findPayments,
                faucet: live.faucet,
                commitments: () => indexer.commitments()
            }),
        billRoutes,
        restaurantRoutes,
        orderRoutes,
        imageRoutes
    ]
})

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`FairPay API on http://${config.host}:${info.port} (database: ${db.storage}, relayer: ${live.relay ? "on" : "off"}, faucet: ${live.faucet ? "on" : "off"}, payroll: ${payroll ? (keeper ? "on, auto-pay on" : "on") : "off"})`)
    // How long a cold start took inside the process (Render's own wake-up comes on top).
    console.log(`Ready ${(performance.now() / 1000).toFixed(1)} s after the process started.`)
    // Sign-in only works from this origin; a wrong PUBLIC_ORIGIN shows up here first.
    console.log(`Public origin: ${config.publicOrigin}${config.appPath ? ` (app at ${config.appPath}/)` : ""}`)
})

// Stop taking requests, let the ones in flight (relays, faucet sends, settlements) finish, then
// close the database so no write is cut off half way.
let closing = false
async function shutdown(signal: string) {
    if (closing) return
    closing = true
    console.log(`${signal}: shutting down`)
    const force = setTimeout(() => {
        console.error("shutdown timed out; exiting")
        process.exit(1)
    }, 15_000)
    force.unref()
    await new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ("closeIdleConnections" in server) server.closeIdleConnections()
    })
    await indexer.stop()
    await payrollIndexer?.stop()
    await keeper?.stop()
    await live.drain()
    await db.close()
    clearTimeout(force)
    process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
