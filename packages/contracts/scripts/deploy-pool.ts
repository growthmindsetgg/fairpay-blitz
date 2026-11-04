import { ethers, network } from "hardhat"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Replaces only FairPool (and its FairPoolBatcher) in deployments/<network>.json, keeping the
// token, FairPay router, verifier, PoseidonT3 and FairPayroll already recorded there.
//   npx hardhat run scripts/deploy-pool.ts --network monadTestnet
// Needs DEPLOYER_KEY in the environment.
//
// The new pool copies the current pool's settings, read on-chain: denomination, deposit cap,
// owner, and the merchant allowlist given in MERCHANTS (comma-separated; defaults to the two
// merchants allowlisted on the current testnet pool). The deployer owns the pool while it
// allowlists merchants; if the current owner is another address, ownership is then offered to it
// with Ownable2Step and must be accepted. Only pool, poolDeployBlock, batcher and
// batcherDeployBlock change in the deployments file. Notes deposited in the old pool stay there.
const DEFAULT_MERCHANTS = ["0x20835c231a5AB47e0a19591EA23F20CAC1556d25", "0xAC84A0eDa131997849C51b0A1f815f730e7b6a20"]

async function main() {
    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`)
    const out = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | number>
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    if (chainId !== Number(out.chainId)) throw new Error(`${file} is for chain ${out.chainId}, connected to ${chainId}`)

    const token = String(out.token)
    const fairPay = String(out.fairPay)
    const verifier = String(out.verifier)
    const poseidon = String(out.poseidonT3)
    for (const [name, a] of Object.entries({ token, fairPay, verifier, poseidon })) {
        if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`no ${name} contract at ${a}`)
    }

    // Copy the current pool's settings from the chain.
    const old = await ethers.getContractAt("FairPool", String(out.pool))
    const denomination = await old.DENOMINATION()
    const maxDeposits = await old.maxDeposits()
    const oldOwner = await old.owner()
    if ((await old.token()).toLowerCase() !== token.toLowerCase()) throw new Error("current pool's token differs from the file")
    if ((await old.fairPay()).toLowerCase() !== fairPay.toLowerCase()) throw new Error("current pool's fairPay differs")
    if ((await old.verifier()).toLowerCase() !== verifier.toLowerCase()) throw new Error("current pool's verifier differs")
    if (denomination.toString() !== String(out.denomination)) throw new Error("current pool's denomination differs from the file")
    const merchants = (process.env.MERCHANTS ? process.env.MERCHANTS.split(",") : DEFAULT_MERCHANTS)
        .map((m) => ethers.getAddress(m.trim()))
        .filter(Boolean)
    console.log(`copying: denomination ${denomination}, maxDeposits ${maxDeposits}, owner ${oldOwner}, merchants ${merchants.join(", ")}`)

    const [deployer] = await ethers.getSigners()
    const startBalance = await ethers.provider.getBalance(deployer.address)
    console.log("deployer", deployer.address, "balance", ethers.formatEther(startBalance), "MON")
    const fees = await ethers.provider.getFeeData()
    const price = fees.maxFeePerGas ?? fees.gasPrice ?? 0n

    // Monad charges the full gas limit, so keep every limit close to its estimate.
    const limit = (gas: bigint) => (gas * 115n) / 100n

    const Pool = await ethers.getContractFactory("FairPool", {
        libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": poseidon }
    })
    const args = [token, fairPay, verifier, denomination, maxDeposits, deployer.address] as const
    const poolGas = await ethers.provider.estimateGas({ ...(await Pool.getDeployTransaction(...args)), from: deployer.address })
    if (startBalance < poolGas * price) throw new Error(`deployer needs about ${ethers.formatEther(poolGas * price)} MON for the pool`)
    const pool = await Pool.deploy(...args, { gasLimit: limit(poolGas) })
    const poolReceipt = await pool.deploymentTransaction()!.wait(2)
    const poolAddress = await pool.getAddress()
    console.log("FairPool", poolAddress, "tx", poolReceipt!.hash, "block", poolReceipt!.blockNumber)

    for (const m of merchants) {
        const gas = await pool.setMerchant.estimateGas(m, true)
        const r = await (await pool.setMerchant(m, true, { gasLimit: limit(gas) })).wait(2)
        console.log("merchant allowlisted", m, "tx", r!.hash)
    }

    const Batcher = await ethers.getContractFactory("FairPoolBatcher")
    const batcherGas = await ethers.provider.estimateGas({ ...(await Batcher.getDeployTransaction(poolAddress)), from: deployer.address })
    const batcher = await Batcher.deploy(poolAddress, { gasLimit: limit(batcherGas) })
    const batcherReceipt = await batcher.deploymentTransaction()!.wait(2)
    const batcherAddress = await batcher.getAddress()
    console.log("FairPoolBatcher", batcherAddress, "tx", batcherReceipt!.hash, "block", batcherReceipt!.blockNumber)

    if (oldOwner.toLowerCase() !== deployer.address.toLowerCase()) {
        const gas = await pool.transferOwnership.estimateGas(oldOwner)
        const r = await (await pool.transferOwnership(oldOwner, { gasLimit: limit(gas) })).wait(2)
        console.log("ownership offered to", oldOwner, "tx", r!.hash, "(must call acceptOwnership())")
    }

    // Re-read everything from the chain before the file points at it.
    const fail = (what: string) => {
        throw new Error(`check failed: ${what}`)
    }
    if ((await ethers.provider.getCode(poolAddress)) === "0x") fail("no code at the pool")
    if ((await ethers.provider.getCode(batcherAddress)) === "0x") fail("no code at the batcher")
    if ((await pool.token()).toLowerCase() !== token.toLowerCase()) fail("pool.token")
    if ((await pool.fairPay()).toLowerCase() !== fairPay.toLowerCase()) fail("pool.fairPay")
    if ((await pool.verifier()).toLowerCase() !== verifier.toLowerCase()) fail("pool.verifier")
    if ((await pool.DENOMINATION()) !== denomination) fail("pool.DENOMINATION")
    if ((await pool.maxDeposits()) !== maxDeposits) fail("pool.maxDeposits")
    if ((await pool.WITHDRAW_REF()) !== ethers.id("FairPool.withdraw")) fail("pool.WITHDRAW_REF")
    for (const m of merchants) if (!(await pool.isMerchant(m))) fail(`isMerchant(${m})`)
    if ((await batcher.pool()).toLowerCase() !== poolAddress.toLowerCase()) fail("batcher.pool")
    if ((await batcher.token()).toLowerCase() !== token.toLowerCase()) fail("batcher.token")
    if ((await batcher.DENOMINATION()) !== denomination) fail("batcher.DENOMINATION")
    console.log(
        `verified on-chain: token ${token}, fairPay ${fairPay}, verifier ${verifier}, denomination ${denomination}, ` +
            `maxDeposits ${maxDeposits}, owner ${await pool.owner()}, WITHDRAW_REF ${await pool.WITHDRAW_REF()}, ` +
            `merchants ${merchants.length}, batcher pool/token/denomination match`
    )

    out.pool = poolAddress
    out.poolDeployBlock = String(poolReceipt!.blockNumber)
    out.batcher = batcherAddress
    out.batcherDeployBlock = String(batcherReceipt!.blockNumber)
    writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
    console.log("updated", path.relative(process.cwd(), file))

    const spent = startBalance - (await ethers.provider.getBalance(deployer.address))
    console.log("MON spent", ethers.formatEther(spent))
    console.log(`verify: npx hardhat verify --network ${network.name} --contract contracts/FairPool.sol:FairPool ${poolAddress} ${args.join(" ")}`)
    console.log(`verify: npx hardhat verify --network ${network.name} --contract contracts/FairPoolBatcher.sol:FairPoolBatcher ${batcherAddress} ${poolAddress}`)
}

main()
    .then(() => process.exit())
    .catch((err) => {
        console.error(err)
        process.exitCode = 1
    })
