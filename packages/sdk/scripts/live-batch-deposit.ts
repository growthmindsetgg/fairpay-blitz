// Live check on Monad Testnet: a throwaway wallet deposits several notes through FairPoolBatcher
// with depositNotes (one approval, one depositMany), then the deposits are re-read on-chain and the
// wallet's leftovers go back to the faucet.
//   FAUCET_KEY=<testnet faucet key> npx tsx scripts/live-batch-deposit.ts [notes=3]
// FAUCET_KEY must come from the environment (never commit it); it sends the throwaway wallet a
// little MON and mints it MockUSDC. The throwaway key only ever exists in this process.
import { readFileSync } from "node:fs"
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import { createNote, depositNotes, fairPoolAbi, isNoteSpent, type Clients, type FairPayDeployment } from "../src/index.js"

const count = Number(process.argv[2] ?? 3)
const raw = JSON.parse(readFileSync(new URL("../../contracts/deployments/monadTestnet.json", import.meta.url), "utf8"))
if (!raw.batcher) throw new Error("monadTestnet.json has no batcher; run packages/contracts/scripts/deploy-batcher.ts first")
const deployment: FairPayDeployment = {
    chainId: raw.chainId,
    token: raw.token,
    fairPay: raw.fairPay,
    pool: raw.pool,
    poolDeployBlock: BigInt(raw.poolDeployBlock),
    batcher: raw.batcher
}
const faucetKey = process.env.FAUCET_KEY as Hex | undefined
if (!faucetKey) throw new Error("set FAUCET_KEY")

const transport = http(process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz")
const publicClient = createPublicClient({ chain: monadTestnet, transport })
const faucet = createWalletClient({ account: privateKeyToAccount(faucetKey), chain: monadTestnet, transport })
const throwaway: Clients = {
    publicClient,
    walletClient: createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: monadTestnet, transport })
}
const user = throwaway.walletClient.account.address
const token = parseAbi(["function mint(address to, uint256 amount)", "function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"])
const link = (hash: string) => `${monadTestnet.blockExplorers.default.url}/tx/${hash}`
const read = <T>(functionName: string) => publicClient.readContract({ address: deployment.pool!, abi: fairPoolAbi, functionName } as never) as Promise<T>

async function main() {
    console.log("throwaway wallet", user, "faucet", faucet.account.address)
    const [maxDeposits, before] = await Promise.all([read<bigint>("maxDeposits"), read<bigint>("depositCount")])
    console.log(`pool deposits before: ${before} of ${maxDeposits}`)

    // Fund: MockUSDC for the notes, MON for an approval plus one depositMany.
    const mint = await faucet.writeContract({ address: deployment.token, abi: token, functionName: "mint", args: [user, 5_000_000n * BigInt(count)] })
    await publicClient.waitForTransactionReceipt({ hash: mint })
    const fund = await faucet.sendTransaction({ to: user, value: parseEther("0.5") })
    await publicClient.waitForTransactionReceipt({ hash: fund })
    console.log("funded:", link(mint), link(fund))

    const notes = Array.from({ length: count }, () => createNote(deployment))
    const nonceBefore = await publicClient.getTransactionCount({ address: user })
    const result = await depositNotes(deployment, throwaway, notes, { onProgress: (p) => console.log("progress", JSON.stringify(p, (_, v) => (typeof v === "bigint" ? String(v) : v))) })
    const nonceAfter = await publicClient.getTransactionCount({ address: user })
    console.log(`wallet transactions for ${count} notes: ${nonceAfter - nonceBefore}`)
    for (const hash of result.transactions) {
        const [r, tx] = await Promise.all([publicClient.getTransactionReceipt({ hash }), publicClient.getTransaction({ hash })])
        console.log(`  ${r.status} gasUsed ${r.gasUsed} gasLimit ${tx.gas} to ${tx.to} ${link(hash)}`)
    }
    console.log("note indexes:", result.deposits.map((d) => String(d.index)).join(", "))

    // Re-read on-chain: the tree grew by `count`, the last Deposit's root is the pool's current or a
    // known root, and none of the notes is spent.
    const after = await read<bigint>("depositCount")
    const logs = await publicClient.getContractEvents({
        address: deployment.pool!,
        abi: fairPoolAbi,
        eventName: "Deposit",
        fromBlock: (await publicClient.getTransactionReceipt({ hash: result.transactions.at(-1)! })).blockNumber,
        toBlock: (await publicClient.getTransactionReceipt({ hash: result.transactions.at(-1)! })).blockNumber
    })
    const ours = logs.filter((l) => notes.some((n) => n.identity.commitment === l.args.commitment))
    const lastRoot = ours.at(-1)!.args.root!
    const known = await publicClient.readContract({ address: deployment.pool!, abi: fairPoolAbi, functionName: "knownRoots", args: [lastRoot] })
    const spent = await Promise.all(notes.map((n) => isNoteSpent(deployment, publicClient, n)))
    console.log(`pool deposits after: ${after} of ${maxDeposits} (grew by ${after - before}); events found ${ours.length}; root known ${known}; any spent ${spent.some(Boolean)}`)
    if (after - before < BigInt(count) || ours.length !== count || !known || spent.some(Boolean)) throw new Error("on-chain check failed")
    const batcherBalance = await publicClient.readContract({ address: deployment.token, abi: token, functionName: "balanceOf", args: [deployment.batcher!] })
    console.log(`batcher token balance after: ${batcherBalance}`)

    // Sweep leftovers back to the faucet.
    const usdcLeft = await publicClient.readContract({ address: deployment.token, abi: token, functionName: "balanceOf", args: [user] })
    if (usdcLeft > 0n) {
        const h = await throwaway.walletClient.writeContract({ address: deployment.token, abi: token, functionName: "transfer", args: [faucet.account.address, usdcLeft] })
        await publicClient.waitForTransactionReceipt({ hash: h })
    }
    const fees = await publicClient.estimateFeesPerGas()
    const maxFee = fees.maxFeePerGas! * 2n
    const mon = await publicClient.getBalance({ address: user })
    const value = mon - 21_000n * maxFee
    if (value > 0n) {
        const h = await throwaway.walletClient.sendTransaction({ to: faucet.account.address, value, gas: 21_000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
        await publicClient.waitForTransactionReceipt({ hash: h })
        console.log(`swept ${formatEther(value)} MON back: ${link(h)}`)
    }
    console.log(`throwaway left with ${formatEther(await publicClient.getBalance({ address: user }))} MON`)
}

main().catch((err) => {
    console.error(err)
    process.exitCode = 1
})
