import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { Group, Identity, generateProof } from "@semaphore-protocol/core"

const DENOM = 5_000_000n // 5 USDC
const REF = ethers.id("order-9:participant-1:secret")

const commitments = (n: number) => Array.from({ length: n }, () => new Identity().commitment)

describe("FairPoolBatcher", () => {
    async function deployPool(tokenAddress: string, owner: string, maxDeposits = 100n) {
        const fairPay = await ethers.deployContract("FairPay", [tokenAddress, owner])
        const verifier = await ethers.deployContract("MonadSemaphoreVerifier")
        const poseidon = await ethers.deployContract("PoseidonT3")
        const Pool = await ethers.getContractFactory("FairPool", {
            libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": await poseidon.getAddress() }
        })
        const pool = await Pool.deploy(tokenAddress, await fairPay.getAddress(), await verifier.getAddress(), DENOM, maxDeposits, owner)
        return { fairPay, pool }
    }

    async function fixture() {
        const [owner, customer, merchant, relayer, other] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const { fairPay, pool } = await deployPool(await usdc.getAddress(), owner.address)
        await pool.setMerchant(merchant.address, true)
        const batcher = await ethers.deployContract("FairPoolBatcher", [await pool.getAddress()])

        await usdc.mint(customer.address, 1_000_000_000n)
        await usdc.connect(customer).approve(await batcher.getAddress(), ethers.MaxUint256)
        const maxBatch = await batcher.MAX_BATCH()
        return { owner, customer, merchant, relayer, other, usdc, fairPay, pool, batcher, maxBatch }
    }

    it("reads the pool's token and denomination at construction", async () => {
        const { usdc, pool, batcher } = await loadFixture(fixture)
        expect(await batcher.pool()).to.equal(await pool.getAddress())
        expect(await batcher.token()).to.equal(await usdc.getAddress())
        expect(await batcher.DENOMINATION()).to.equal(DENOM)
        await expect(ethers.deployContract("FairPoolBatcher", [ethers.ZeroAddress])).to.be.reverted
    })

    describe("depositMany", () => {
        for (const n of [1, 11, "MAX_BATCH"] as const) {
            it(`deposits ${n} note(s) in one call: events, pool balance and tree size`, async () => {
                const { customer, usdc, pool, batcher, maxBatch } = await loadFixture(fixture)
                const count = n === "MAX_BATCH" ? Number(maxBatch) : n
                const cs = commitments(count)
                const poolAddr = await pool.getAddress()
                const batcherAddr = await batcher.getAddress()
                const before = await usdc.balanceOf(customer.address)

                const tx = await batcher.connect(customer).depositMany(cs)
                const receipt = (await tx.wait())!
                const group = new Group(cs)
                const events = receipt.logs
                    .filter((l) => l.address === poolAddr)
                    .map((l) => pool.interface.parseLog(l)!)
                    .filter((e) => e.name === "Deposit")
                expect(events.map((e) => e.args.commitment)).to.deep.equal(cs)
                expect(events.map((e) => e.args.index)).to.deep.equal(cs.map((_, i) => BigInt(i)))
                expect(events.at(-1)!.args.root).to.equal(group.root)

                expect(await pool.depositCount()).to.equal(BigInt(count))
                expect(await pool.merkleRoot()).to.equal(group.root)
                expect(await usdc.balanceOf(poolAddr)).to.equal(DENOM * BigInt(count))
                expect(await usdc.balanceOf(customer.address)).to.equal(before - DENOM * BigInt(count))
                // Nothing stays behind in the batcher: no tokens and no allowance to the pool.
                expect(await usdc.balanceOf(batcherAddr)).to.equal(0n)
                expect(await usdc.allowance(batcherAddr, poolAddr)).to.equal(0n)
                console.log(`      gas for ${count} note(s): ${receipt.gasUsed} (${receipt.gasUsed / BigInt(count)} per note)`)
            })
        }

        it("appends after earlier direct deposits, keeping one tree", async () => {
            const { customer, usdc, pool, batcher } = await loadFixture(fixture)
            const first = new Identity().commitment
            await usdc.connect(customer).approve(await pool.getAddress(), DENOM)
            await pool.connect(customer).deposit(first)
            const cs = commitments(3)
            await expect(batcher.connect(customer).depositMany(cs))
                .to.emit(pool, "Deposit")
                .withArgs(cs[0], 1n, new Group([first, cs[0]]).root)
            expect(await pool.merkleRoot()).to.equal(new Group([first, ...cs]).root)
        })

        it("rejects an empty batch and one larger than MAX_BATCH", async () => {
            const { customer, batcher, maxBatch } = await loadFixture(fixture)
            await expect(batcher.connect(customer).depositMany([])).to.be.revertedWithCustomError(batcher, "EmptyBatch")
            await expect(batcher.connect(customer).depositMany(commitments(Number(maxBatch) + 1))).to.be.revertedWithCustomError(
                batcher,
                "BatchTooLarge"
            )
        })

        it("rejects a short allowance or balance and moves nothing", async () => {
            const { customer, other, usdc, pool, batcher } = await loadFixture(fixture)
            const b = await batcher.getAddress()
            await usdc.connect(customer).approve(b, DENOM * 2n)
            await expect(batcher.connect(customer).depositMany(commitments(3))).to.be.revertedWithCustomError(
                usdc,
                "ERC20InsufficientAllowance"
            )
            await usdc.mint(other.address, DENOM * 2n)
            await usdc.connect(other).approve(b, ethers.MaxUint256)
            await expect(batcher.connect(other).depositMany(commitments(3))).to.be.revertedWithCustomError(usdc, "ERC20InsufficientBalance")
            expect(await pool.depositCount()).to.equal(0n)
            expect(await usdc.balanceOf(other.address)).to.equal(DENOM * 2n)
        })

        it("only ever pulls from the caller, never from someone else's approval", async () => {
            const { customer, other, usdc, batcher } = await loadFixture(fixture)
            // `customer` has approved the batcher for everything; `other` has nothing approved.
            const before = await usdc.balanceOf(customer.address)
            await expect(batcher.connect(other).depositMany(commitments(1))).to.be.revertedWithCustomError(
                usdc,
                "ERC20InsufficientAllowance"
            )
            expect(await usdc.balanceOf(customer.address)).to.equal(before)
        })

        it("reverts the whole batch on a duplicate commitment, in the pool or in the batch", async () => {
            const { customer, usdc, pool, batcher } = await loadFixture(fixture)
            const cs = commitments(2)
            await batcher.connect(customer).depositMany(cs)
            const before = await usdc.balanceOf(customer.address)
            const fresh = new Identity().commitment
            await expect(batcher.connect(customer).depositMany([fresh, cs[1]])).to.be.reverted
            await expect(batcher.connect(customer).depositMany([fresh, fresh])).to.be.reverted
            await expect(batcher.connect(customer).depositMany([0n])).to.be.reverted
            expect(await pool.depositCount()).to.equal(2n)
            expect(await usdc.balanceOf(customer.address)).to.equal(before)
            expect(await usdc.balanceOf(await batcher.getAddress())).to.equal(0n)
        })

        it("reverts while the pool is paused", async () => {
            const { owner, customer, pool, batcher } = await loadFixture(fixture)
            await pool.connect(owner).pause()
            await expect(batcher.connect(customer).depositMany(commitments(2))).to.be.revertedWithCustomError(pool, "EnforcedPause")
        })

        it("reverts the whole batch when it would pass the deposit cap", async () => {
            const { owner, customer, usdc, pool, batcher } = await loadFixture(fixture)
            await batcher.connect(customer).depositMany(commitments(2))
            await pool.connect(owner).setMaxDeposits(4n)
            const before = await usdc.balanceOf(customer.address)
            await expect(batcher.connect(customer).depositMany(commitments(3))).to.be.revertedWithCustomError(pool, "DepositCapReached")
            expect(await pool.depositCount()).to.equal(2n)
            expect(await usdc.balanceOf(customer.address)).to.equal(before)
            // Exactly up to the cap is fine.
            await batcher.connect(customer).depositMany(commitments(2))
            expect(await pool.depositCount()).to.equal(4n)
        })

        it("ignores tokens sent to it directly and still returns to its starting balance", async () => {
            const { customer, other, usdc, pool, batcher } = await loadFixture(fixture)
            const b = await batcher.getAddress()
            await usdc.mint(b, 7n)
            await usdc.mint(other.address, DENOM * 2n)
            // A donation can't pay for someone's deposit: `other` approved nothing.
            await expect(batcher.connect(other).depositMany(commitments(1))).to.be.reverted
            await batcher.connect(customer).depositMany(commitments(2))
            expect(await usdc.balanceOf(b)).to.equal(7n)
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * 2n)
        })

        it("rejects fee-on-transfer tokens", async () => {
            const [owner, payer] = await ethers.getSigners()
            const fee = await ethers.deployContract("FeeToken")
            const { pool } = await deployPool(await fee.getAddress(), owner.address)
            const batcher = await ethers.deployContract("FairPoolBatcher", [await pool.getAddress()])
            await fee.mint(payer.address, DENOM * 10n)
            await fee.connect(payer).approve(await batcher.getAddress(), ethers.MaxUint256)
            await expect(batcher.connect(payer).depositMany(commitments(2))).to.be.revertedWithCustomError(batcher, "AmountMismatch")
        })
    })

    it("a note deposited through the batcher is spent with a proof exactly like a direct deposit", async () => {
        const { customer, merchant, relayer, usdc, fairPay, pool, batcher } = await loadFixture(fixture)
        const direct = new Identity()
        await usdc.connect(customer).approve(await pool.getAddress(), DENOM)
        await pool.connect(customer).deposit(direct.commitment)
        const ids = [new Identity(), new Identity(), new Identity()]
        await batcher.connect(customer).depositMany(ids.map((i) => i.commitment))

        const group = new Group([direct.commitment, ...ids.map((i) => i.commitment)])
        expect(await pool.merkleRoot()).to.equal(group.root)
        const scope = await pool.SCOPE()
        for (const [k, id] of [ids[1], direct].entries()) {
            const ref = ethers.id(`${REF}-${k}`)
            const proof = await generateProof(id, group, await pool.messageFor(merchant.address, ref), scope)
            await expect(
                pool.connect(relayer).pay(merchant.address, ref, {
                    merkleTreeDepth: proof.merkleTreeDepth,
                    merkleTreeRoot: proof.merkleTreeRoot,
                    nullifier: proof.nullifier,
                    message: proof.message,
                    scope: proof.scope,
                    points: proof.points
                })
            )
                .to.emit(fairPay, "PaymentReceived")
                .withArgs(ref, merchant.address, await pool.getAddress(), DENOM)
            expect(await pool.nullifierSpent(proof.nullifier)).to.equal(true)
        }
        expect(await usdc.balanceOf(merchant.address)).to.equal(DENOM * 2n)
        expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * 2n)
        expect(await usdc.balanceOf(await batcher.getAddress())).to.equal(0n)
    })
})
