import { ethers, network } from "hardhat"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Deploys FairPayroll for the token already recorded in deployments/<network>.json and adds its
// address there as `payroll` (and `payrollDeployBlock` for indexers). Nothing else is touched.
// Re-running deploys a new, empty payroll.
//   npx hardhat run scripts/deploy-payroll.ts --network monadTestnet
// Needs DEPLOYER_KEY in the environment (any funded testnet key: the payroll has no owner).
export async function deployPayroll(opts: { file?: string; confirmations?: number } = {}) {
    const file = opts.file ?? path.join(__dirname, "..", "deployments", `${network.name}.json`)
    const confirmations = opts.confirmations ?? 2
    const out = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | number>
    const token = String(out.token)
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    if (chainId !== Number(out.chainId)) throw new Error(`${file} is for chain ${out.chainId}, connected to ${chainId}`)
    if ((await ethers.provider.getCode(token)) === "0x") throw new Error(`no token contract at ${token}`)

    const [deployer] = await ethers.getSigners()
    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("deployer", deployer.address, "balance", ethers.formatEther(balance), "MON")
    const Payroll = await ethers.getContractFactory("FairPayroll")
    const deployTx = await Payroll.getDeployTransaction(token)
    const gas = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address })
    const fees = await ethers.provider.getFeeData()
    const need = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n)
    if (balance < need) throw new Error(`deployer needs about ${ethers.formatEther(need)} MON for gas`)

    // Monad charges the full gas limit, so keep it close to the estimate.
    const payroll = await Payroll.deploy(token, { gasLimit: (gas * 115n) / 100n })
    const receipt = await payroll.deploymentTransaction()!.wait(confirmations)
    const address = await payroll.getAddress()
    console.log("FairPayroll", address, "tx", receipt!.hash)

    // Check what was deployed before anything points at it.
    const code = await ethers.provider.getCode(address)
    if (code === "0x") throw new Error("no code at the payroll address")
    if ((await payroll.token()).toLowerCase() !== token.toLowerCase()) throw new Error("payroll.token() is not the deployment's token")
    if (Number(await payroll.deployChainId()) !== chainId) throw new Error("payroll.deployChainId() differs from the chain")
    console.log(`verified: token ${token}, code ${(code.length - 2) / 2} bytes, MAX_SHIFTS ${await payroll.MAX_SHIFTS()}`)

    out.payroll = address
    out.payrollDeployBlock = String(receipt!.blockNumber)
    writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
    console.log("updated", path.relative(process.cwd(), file))
    return { address, blockNumber: receipt!.blockNumber }
}

if (require.main === module) {
    deployPayroll()
        .then(() => process.exit())
        .catch((err) => {
            console.error(err)
            process.exitCode = 1
        })
}
