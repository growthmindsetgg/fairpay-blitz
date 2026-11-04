// Live check on Monad Testnet: one public and one private payment, each verified on-chain.
// Reads testnet-only keys from packages/contracts/.env and the deployment from
// packages/contracts/deployments/monadTestnet.json.
//   npx tsx scripts/live-check.ts
import { readFileSync } from "node:fs"
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import {
    createNote,
    createOrderRef,
    createPrivatePayment,
    depositNote,
    payPublic,
    randomSecret,
    verifyPaymentTx,
    type Clients,
    type FairPayDeployment
} from "../src/index.js"
import { createRelayer } from "../src/relayer.js"

const env = Object.fromEntries(
    readFileSync(new URL("../../contracts/.env", import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => l.split("=") as [string, string])
)
const raw = JSON.parse(readFileSync(new URL("../../contracts/deployments/monadTestnet.json", import.meta.url), "utf8"))
const deployment: FairPayDeployment = {
    chainId: raw.chainId,
    token: raw.token,
    fairPay: raw.fairPay,
    pool: raw.pool,
    poolDeployBlock: BigInt(raw.poolDeployBlock)
}

const transport = http(process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz")
const publicClient = createPublicClient({ chain: monadTestnet, transport })
const clientsFor = (key: string): Clients => ({
    publicClient,
    walletClient: createWalletClient({ account: privateKeyToAccount(key as Hex), chain: monadTestnet, transport })
})
const deployer = clientsFor(env.DEPLOYER_KEY!)
const customer = clientsFor(env.CUSTOMER_KEY!)
const relayer = createRelayer(deployment, clientsFor(env.RELAYER_KEY!))
const merchant = env.MERCHANT_ADDRESS as Hex
const explorer = monadTestnet.blockExplorers?.default.url
const link = (hash: string) => `${explorer}/tx/${hash}`
const scan = { chunkSize: 100n }

async function topUpGas(to: Hex, min: bigint) {
    const bal = await publicClient.getBalance({ address: to })
    if (bal >= min) return
    const hash = await deployer.walletClient.sendTransaction({ to, value: min - bal })
    await publicClient.waitForTransactionReceipt({ hash })
}

async function waitVerified(args: Parameters<typeof verifyPaymentTx>[2]) {
    for (let i = 0; i < 20; i++) {
        const r = await verifyPaymentTx(deployment, publicClient, args)
        if (r.status !== "pending") return r
        await new Promise((res) => setTimeout(res, 1500))
    }
    return verifyPaymentTx(deployment, publicClient, args)
}

const PRIVATE_ONLY = process.argv.includes("--private-only")

async function main() {
    if (PRIVATE_ONLY) return privatePath()
    console.log("funding customer and relayer with gas")
    await topUpGas(customer.walletClient.account.address, parseEther("0.6"))
    await topUpGas(clientsFor(env.RELAYER_KEY!).walletClient.account.address, parseEther("0.6"))

    console.log("minting 100 mUSDC to customer")
    const mint = await deployer.walletClient.writeContract({
        address: deployment.token,
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        functionName: "mint",
        args: [customer.walletClient.account.address, 100_000_000n]
    })
    await publicClient.waitForTransactionReceipt({ hash: mint })

    // ---- public
    const pubRef = createOrderRef({ orderId: "FE-LIVE-001", participantId: "alice", secret: randomSecret() })
    const pub = await payPublic(deployment, customer, { merchant, amount: 12_500_000n, orderRef: pubRef })
    await publicClient.waitForTransactionReceipt({ hash: pub.txHash })
    const pubResult = await waitVerified({
        txHash: pub.txHash,
        orderRef: pubRef,
        merchant,
        amount: 12_500_000n,
        expectedPayer: customer.walletClient.account.address
    })
    console.log("PUBLIC ", pubResult.status, link(pub.txHash))
    if (pubResult.status !== "verified") process.exitCode = 1
    await privatePath()
}

async function privatePath() {
    // ---- private: three deposits so the payer is one of several, then pay with the first
    const notes = [createNote(deployment), createNote(deployment), createNote(deployment)]
    for (const n of notes) {
        const d = await depositNote(deployment, customer, n)
        console.log("deposit", d.index, link(d.txHash))
    }
    const privRef = createOrderRef({ orderId: "FE-LIVE-001", participantId: "bob", secret: randomSecret() })
    console.log("building proof (scanning deposits + proving)")
    const t0 = Date.now()
    const request = await createPrivatePayment(deployment, publicClient, { note: notes[0]!, merchant, orderRef: privRef }, scan)
    console.log(`proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s, submitting via relayer`)
    const priv = await relayer.handle(JSON.parse(JSON.stringify(request)))
    const privResult = await waitVerified({ txHash: priv.txHash, orderRef: privRef, merchant, amount: 5_000_000n })
    console.log("PRIVATE", privResult.status, privResult.status === "verified" ? privResult.payment.kind : "", link(priv.txHash))

    const bal = await publicClient.readContract({
        address: deployment.token,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [merchant]
    })
    console.log("merchant mUSDC balance", Number(bal) / 1e6)
    if (privResult.status !== "verified") process.exitCode = 1
}

// The prover keeps worker threads alive, so exit explicitly.
main()
    .catch((e) => {
        console.error(e)
        process.exitCode = 1
    })
    .finally(() => process.exit())
