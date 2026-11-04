import { ethers, network } from "hardhat"
import { readFileSync } from "node:fs"
import path from "node:path"

// Allowlists (or removes) a business payout wallet on the FairPool in deployments/<network>.json,
// so confidential payments can pay it. Only the pool's owner can do this.
//   MERCHANT=0x... npx hardhat run scripts/set-merchant.ts --network monadTestnet
//   MERCHANT=0x... ALLOWED=false npx hardhat run scripts/set-merchant.ts --network monadTestnet
// Needs DEPLOYER_KEY in the environment: the key that owns the pool.
async function main() {
    const merchant = process.env.MERCHANT ?? ""
    if (!ethers.isAddress(merchant)) throw new Error("set MERCHANT to the payout wallet address")
    const allowed = process.env.ALLOWED !== "false"

    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`)
    const out = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | number>
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    if (chainId !== Number(out.chainId)) throw new Error(`${file} is for chain ${out.chainId}, connected to ${chainId}`)

    const [signer] = await ethers.getSigners()
    const pool = await ethers.getContractAt("FairPool", String(out.pool), signer)
    const owner = await pool.owner()
    if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`the pool's owner is ${owner}, not this key (${signer.address})`)

    const target = ethers.getAddress(merchant)
    if ((await pool.isMerchant(target)) === allowed) {
        console.log(`${target} is already ${allowed ? "allowlisted" : "not allowlisted"}; nothing sent`)
        return
    }
    // Monad charges the full gas limit, so keep it close to the estimate.
    const gas = await pool.setMerchant.estimateGas(target, allowed)
    const tx = await pool.setMerchant(target, allowed, { gasLimit: (gas * 115n) / 100n })
    const receipt = await tx.wait(2)
    console.log(`setMerchant(${target}, ${allowed}) tx ${receipt!.hash} block ${receipt!.blockNumber}`)
    if ((await pool.isMerchant(target)) !== allowed) throw new Error("isMerchant did not change")
    console.log(`verified: isMerchant(${target}) = ${allowed}`)
}

main()
    .then(() => process.exit())
    .catch((err) => {
        console.error(err)
        process.exitCode = 1
    })
