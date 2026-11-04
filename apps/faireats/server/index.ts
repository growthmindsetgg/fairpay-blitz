import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { serve } from "@hono/node-server"
import { getConnInfo } from "@hono/node-server/conninfo"
import { serveStatic } from "@hono/node-server/serve-static"
import { createRelayer } from "@fairpay/sdk/relayer"
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, type Address, type Hash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import { createApp } from "./app.js"
import { openDb } from "./db.js"
import { appDir, config, deployment } from "./env.js"
import { createDepositIndexer } from "./indexer.js"
import { clientAddress } from "./net.js"
import { createService } from "./service.js"

const transport = http(config.rpcUrl)
const publicClient = createPublicClient({ chain: monadTestnet, transport })
const relayerWallet = createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(config.relayerKey) })
const faucetWallet = createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(config.faucetKey) })

const db = openDb(config.dbFile)
const service = createService(db, { deployment, publicClient, merchant: config.merchant })
const relayer = createRelayer(deployment, { publicClient, walletClient: relayerWallet })
const indexer = createDepositIndexer(db, publicClient, deployment, { confirmations: config.indexerConfirmations })
indexer.start()

const mintAbi = [
    { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }
] as const

// Testnet demo faucet: test USDC plus a little MON for gas. Faucet transactions are sent one at a
// time so their nonces never collide.
let faucetQueue: Promise<unknown> = Promise.resolve()
const FAUCET_USDC = parseUnits("50", 6)
// Monad reserves gas limit x max fee up front; a batched top-up of 11 notes needs about 0.28 MON,
// so give a little more than that.
const FAUCET_GAS = parseEther("0.3")
// Monad keeps a 10 MON reserve balance per account: a transfer that takes the sender below it
// reverts on execution unless it is the sender's first transaction within the last few blocks. The
// faucet usually holds less than 10 MON, so the MON transfer goes first, after a quiet gap.
// https://docs.monad.xyz/developer-essentials/reserve-balance
const FAUCET_QUIET_BLOCKS = 4n
let faucetLastBlock = 0n
async function faucetSend(send: () => Promise<Hash>, what: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await send() })
    faucetLastBlock = receipt.blockNumber
    if (receipt.status !== "success") throw new Error(`faucet ${what} reverted: ${receipt.transactionHash}`)
}
async function faucet(to: Address) {
    const run = async () => {
        let gasSent = 0n
        if ((await publicClient.getBalance({ address: to })) < parseEther("0.1")) {
            for (let i = 0; i < 40 && (await publicClient.getBlockNumber()) < faucetLastBlock + FAUCET_QUIET_BLOCKS; i++) {
                await new Promise((r) => setTimeout(r, 250))
            }
            await faucetSend(() => faucetWallet.sendTransaction({ to, value: FAUCET_GAS }), "gas transfer")
            gasSent = FAUCET_GAS
        }
        await faucetSend(() => faucetWallet.writeContract({ address: deployment.token, abi: mintAbi, functionName: "mint", args: [to, FAUCET_USDC] }), "mint")
        return { minted: "50", gasSent: formatEther(gasSent) }
    }
    const p = faucetQueue.then(run, run)
    faucetQueue = p.catch(() => undefined)
    return p
}

const app = createApp({
    service,
    relay: (body) => relayer.handle(body),
    faucet,
    commitments: () => indexer.commitments(),
    kitchenPin: config.kitchenPin,
    publicConfig: {
        chainId: deployment.chainId,
        rpcUrl: config.rpcUrl,
        explorer: "https://testnet.monadexplorer.com",
        token: deployment.token,
        fairPay: deployment.fairPay,
        pool: deployment.pool,
        poolDeployBlock: String(deployment.poolDeployBlock),
        denomination: String(deployment.denomination),
        merchant: config.merchant
    },
    clientIp: (c) => clientAddress(getConnInfo(c).remote.address, c.req.header("x-forwarded-for"), config.trustProxyHops)
})

// Serves the built frontend when it exists (npm start). In development Vite serves it instead.
const dist = path.join(appDir, "dist")
if (existsSync(dist)) {
    const index = readFileSync(path.join(dist, "index.html"), "utf8")
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) }))
    app.get("*", (c) => c.html(index))
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`FairEats API on http://${config.host}:${info.port}`)
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
    await faucetQueue.catch(() => undefined)
    db.close()
    clearTimeout(force)
    process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
