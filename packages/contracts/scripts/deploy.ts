import { ethers, network } from "hardhat"
import { Group, Identity, generateProof } from "@semaphore-protocol/core"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

// Configuration via environment:
//   TOKEN_ADDRESS   existing USDC address. If unset on a test network, a MockUSDC is deployed.
//   OWNER_ADDRESS   final owner (use a Safe or hardware wallet). Defaults to the deployer.
//   DENOMINATION    pool note size in token units. Default 5_000_000 (5 USDC).
//   MAX_DEPOSITS    pool deposit cap. Default 200.
//   MERCHANTS       comma-separated merchant payout addresses to allowlist.
async function main() {
    const [deployer] = await ethers.getSigners()
    const isLive = network.name === "monad"
    const owner = process.env.OWNER_ADDRESS ?? deployer.address
    const denomination = BigInt(process.env.DENOMINATION ?? "5000000")
    const maxDeposits = BigInt(process.env.MAX_DEPOSITS ?? "200")

    let token = process.env.TOKEN_ADDRESS
    if (!token) {
        if (isLive) throw new Error("TOKEN_ADDRESS is required on mainnet")
        const mock = await ethers.deployContract("MockUSDC")
        await mock.waitForDeployment()
        token = await mock.getAddress()
        console.log("MockUSDC", token, "tx", mock.deploymentTransaction()!.hash)
    }

    // Deploy with the deployer as owner so it can configure merchants, then hand over.
    const fairPay = await ethers.deployContract("FairPay", [token, deployer.address])
    await fairPay.waitForDeployment()
    console.log("FairPay", await fairPay.getAddress(), "tx", fairPay.deploymentTransaction()!.hash)
    const verifier = await ethers.deployContract("MonadSemaphoreVerifier")
    await verifier.waitForDeployment()
    console.log("MonadSemaphoreVerifier", await verifier.getAddress(), "tx", verifier.deploymentTransaction()!.hash)
    await assertVerifierWorks(await verifier.getAddress())
    const poseidon = await ethers.deployContract("PoseidonT3")
    await poseidon.waitForDeployment()
    console.log("PoseidonT3", await poseidon.getAddress(), "tx", poseidon.deploymentTransaction()!.hash)
    const Pool = await ethers.getContractFactory("FairPool", {
        libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": await poseidon.getAddress() }
    })
    const pool = await Pool.deploy(
        token,
        await fairPay.getAddress(),
        await verifier.getAddress(),
        denomination,
        maxDeposits,
        deployer.address
    )
    const poolReceipt = await pool.deploymentTransaction()!.wait()
    console.log("FairPool", await pool.getAddress(), "tx", poolReceipt!.hash)
    // Lets a customer deposit several notes with one approval and one transaction.
    const batcher = await ethers.deployContract("FairPoolBatcher", [await pool.getAddress()])
    const batcherReceipt = await batcher.deploymentTransaction()!.wait()
    console.log("FairPoolBatcher", await batcher.getAddress(), "tx", batcherReceipt!.hash)

    for (const m of (process.env.MERCHANTS ?? "").split(",").filter(Boolean)) {
        const r = await (await pool.setMerchant(m.trim(), true)).wait()
        console.log("merchant allowlisted", m.trim(), "tx", r!.hash)
    }

    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
        // Ownable2Step: the new owner must call acceptOwnership() to finish the transfer.
        await (await fairPay.transferOwnership(owner)).wait()
        await (await pool.transferOwnership(owner)).wait()
        console.log("ownership transfer started; new owner must call acceptOwnership() on both contracts")
    }

    const out = {
        chainId: Number((await ethers.provider.getNetwork()).chainId),
        token,
        fairPay: await fairPay.getAddress(),
        pool: await pool.getAddress(),
        poolDeployBlock: String(poolReceipt!.blockNumber),
        verifier: await verifier.getAddress(),
        poseidonT3: await poseidon.getAddress(),
        denomination: String(denomination),
        batcher: await batcher.getAddress(),
        batcherDeployBlock: String(batcherReceipt!.blockNumber)
    }
    const dir = path.join(__dirname, "..", "deployments")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2) + "\n")
    console.log(JSON.stringify(out, null, 2))
}

// Verifies a real proof against the deployed verifier on the target chain before anything
// depends on it. Chains can price precompiles differently from Ethereum; a verifier that
// silently returns false would make every private payment fail.
async function assertVerifierWorks(address: string) {
    const ids = [new Identity(), new Identity(), new Identity()]
    const proof = await generateProof(ids[0], new Group(ids.map((i) => i.commitment)), 1n, 2n)
    const h = (v: string) => BigInt(ethers.keccak256(ethers.solidityPacked(["uint256"], [v]))) >> 8n
    const p = proof.points.map(BigInt)
    const verifier = await ethers.getContractAt("MonadSemaphoreVerifier", address)
    const ok = await verifier.verifyProof(
        [p[0], p[1]],
        [[p[2], p[3]], [p[4], p[5]]],
        [p[6], p[7]],
        [proof.merkleTreeRoot, proof.nullifier, h(proof.message), h(proof.scope)],
        proof.merkleTreeDepth
    )
    if (!ok) throw new Error("verifier rejected a valid proof on this chain; aborting deployment")
    console.log("verifier self-check passed")
}

main()
    .then(() => process.exit())
    .catch((err) => {
    console.error(err)
    process.exitCode = 1
})
