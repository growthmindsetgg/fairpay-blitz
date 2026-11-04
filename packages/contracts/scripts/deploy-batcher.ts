import { ethers, network } from "hardhat"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Deploys FairPoolBatcher for the pool already recorded in deployments/<network>.json and adds its
// address there as `batcher`. The pool itself is not touched. Re-running deploys a new batcher.
//   npx hardhat run scripts/deploy-batcher.ts --network monadTestnet
// Needs DEPLOYER_KEY in the environment (any funded testnet key: the batcher has no owner).
async function main() {
    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`)
    const out = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | number>
    const pool = String(out.pool)
    const token = String(out.token)
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    if (chainId !== Number(out.chainId)) throw new Error(`${file} is for chain ${out.chainId}, connected to ${chainId}`)

    const [deployer] = await ethers.getSigners()
    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("deployer", deployer.address, "balance", ethers.formatEther(balance), "MON")
    const Batcher = await ethers.getContractFactory("FairPoolBatcher")
    const deployTx = await Batcher.getDeployTransaction(pool)
    const gas = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address })
    const fees = await ethers.provider.getFeeData()
    const need = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n)
    if (balance < need) throw new Error(`deployer needs about ${ethers.formatEther(need)} MON for gas`)

    // Monad charges the full gas limit, so keep it close to the estimate.
    const batcher = await Batcher.deploy(pool, { gasLimit: (gas * 115n) / 100n })
    const receipt = await batcher.deploymentTransaction()!.wait(2)
    const address = await batcher.getAddress()
    console.log("FairPoolBatcher", address, "tx", receipt!.hash)

    // Check what was deployed before anything points at it.
    const code = await ethers.provider.getCode(address)
    if (code === "0x") throw new Error("no code at the batcher address")
    if ((await batcher.pool()).toLowerCase() !== pool.toLowerCase()) throw new Error("batcher.pool() is not the deployment's pool")
    if ((await batcher.token()).toLowerCase() !== token.toLowerCase()) throw new Error("batcher.token() is not the deployment's token")
    if ((await batcher.DENOMINATION()).toString() !== String(out.denomination)) throw new Error("batcher denomination differs")
    console.log(`verified: pool ${pool}, token ${token}, code ${(code.length - 2) / 2} bytes, MAX_BATCH ${await batcher.MAX_BATCH()}`)

    out.batcher = address
    out.batcherDeployBlock = String(receipt!.blockNumber)
    writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
    console.log("updated", path.relative(process.cwd(), file))
}

main()
    .then(() => process.exit())
    .catch((err) => {
        console.error(err)
        process.exitCode = 1
    })
