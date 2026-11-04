import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { Group, Identity, generateProof } from "@semaphore-protocol/core"

const DENOM = 5_000_000n // 5 USDC
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const REF = ethers.id("order-7:participant-2:secret")

type Proof = Awaited<ReturnType<typeof generateProof>>

function toCall(p: Proof) {
    return {
        merkleTreeDepth: p.merkleTreeDepth,
        merkleTreeRoot: p.merkleTreeRoot,
        nullifier: p.nullifier,
        message: p.message,
        scope: p.scope,
        points: p.points
    }
}

describe("FairPool", () => {
    async function fixture() {
        const [owner, customer, merchant, merchant2, relayer, attacker] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const fairPay = await ethers.deployContract("FairPay", [await usdc.getAddress(), owner.address])
        const verifier = await ethers.deployContract("MonadSemaphoreVerifier")
        const poseidon = await ethers.deployContract("PoseidonT3")
        const Pool = await ethers.getContractFactory("FairPool", {
            libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": await poseidon.getAddress() }
        })
        const pool = await Pool.deploy(
            await usdc.getAddress(),
            await fairPay.getAddress(),
            await verifier.getAddress(),
            DENOM,
            100n,
            owner.address
        )
        await pool.setMerchant(merchant.address, true)
        await pool.setMerchant(merchant2.address, true)

        await usdc.mint(customer.address, 1_000_000_000n)
        await usdc.connect(customer).approve(await pool.getAddress(), ethers.MaxUint256)

        // Three depositors so the payer is hidden in a set larger than one.
        const ids = [new Identity(), new Identity(), new Identity()]
        const group = new Group()
        for (const id of ids) {
            await pool.connect(customer).deposit(id.commitment)
            group.addMember(id.commitment)
        }
        const scope = await pool.SCOPE()
        return { owner, customer, merchant, merchant2, relayer, attacker, usdc, fairPay, pool, ids, group, scope }
    }

    async function proofFor(
        pool: Awaited<ReturnType<typeof fixture>>["pool"],
        id: Identity,
        group: Group,
        merchant: string,
        ref: string,
        scope: bigint
    ) {
        const message = await pool.messageFor(merchant, ref)
        return generateProof(id, group, message, scope)
    }

    describe("deposit", () => {
        it("takes exactly one denomination and records a known root that matches the off-chain group", async () => {
            const { usdc, pool, group } = await loadFixture(fixture)
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * 3n)
            expect(await pool.depositCount()).to.equal(3n)
            expect(await pool.merkleRoot()).to.equal(group.root)
            expect(await pool.knownRoots(group.root)).to.equal(true)
        })

        it("rejects a duplicate, zero or out-of-field commitment", async () => {
            const { customer, pool, ids } = await loadFixture(fixture)
            const c = pool.connect(customer)
            await expect(c.deposit(ids[0].commitment)).to.be.reverted
            await expect(c.deposit(0n)).to.be.reverted
            await expect(c.deposit(SNARK_FIELD)).to.be.reverted
        })

        it("enforces the deposit cap and pause", async () => {
            const { owner, customer, pool } = await loadFixture(fixture)
            await pool.connect(owner).setMaxDeposits(3n)
            await expect(pool.connect(customer).deposit(new Identity().commitment)).to.be.revertedWithCustomError(
                pool,
                "DepositCapReached"
            )
            await pool.connect(owner).setMaxDeposits(100n)
            await pool.connect(owner).pause()
            await expect(pool.connect(customer).deposit(new Identity().commitment)).to.be.revertedWithCustomError(
                pool,
                "EnforcedPause"
            )
        })

        it("only the owner can change merchants, the cap or pause", async () => {
            const { attacker, pool } = await loadFixture(fixture)
            const a = pool.connect(attacker)
            await expect(a.setMerchant(attacker.address, true)).to.be.revertedWithCustomError(
                pool,
                "OwnableUnauthorizedAccount"
            )
            await expect(a.setMaxDeposits(0n)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount")
            await expect(a.pause()).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount")
        })
    })

    describe("pay", () => {
        it("pays the merchant through FairPay without revealing the depositor", async () => {
            const { merchant, relayer, usdc, fairPay, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[1], group, merchant.address, REF, scope)

            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(proof)))
                .to.emit(fairPay, "PaymentReceived")
                .withArgs(REF, merchant.address, await pool.getAddress(), DENOM)
                .and.to.emit(pool, "PrivatePayment")
                .withArgs(proof.nullifier, merchant.address, REF)

            expect(await usdc.balanceOf(merchant.address)).to.equal(DENOM)
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * 2n)
            expect(await pool.nullifierSpent(proof.nullifier)).to.equal(true)
            expect(await usdc.allowance(await pool.getAddress(), await fairPay.getAddress())).to.equal(0n)
        })

        it("rejects spending the same note twice, even for a different order", async () => {
            const { merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const p1 = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await pool.connect(relayer).pay(merchant.address, REF, toCall(p1))

            const otherRef = ethers.id("another-order")
            const p2 = await proofFor(pool, ids[0], group, merchant.address, otherRef, scope)
            expect(p2.nullifier).to.equal(p1.nullifier)
            await expect(pool.connect(relayer).pay(merchant.address, otherRef, toCall(p2))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
        })

        it("cannot be redirected to another merchant or another order", async () => {
            const { merchant, merchant2, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await expect(pool.connect(relayer).pay(merchant2.address, REF, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "WrongMessage"
            )
            await expect(
                pool.connect(relayer).pay(merchant.address, ethers.id("other"), toCall(proof))
            ).to.be.revertedWithCustomError(pool, "WrongMessage")
        })

        it("rejects a proof made for another scope (stops one identity creating many nullifiers)", async () => {
            const { merchant, relayer, pool, ids, group } = await loadFixture(fixture)
            const message = await pool.messageFor(merchant.address, REF)
            const proof = await generateProof(ids[0], group, message, 12345n)
            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "WrongScope"
            )
        })

        it("rejects tampered proofs, including nullifier + field modulus", async () => {
            const { merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[2], group, merchant.address, REF, scope)

            const badPoints = toCall(proof)
            badPoints.points = [...proof.points] as typeof proof.points
            badPoints.points[0] = (BigInt(badPoints.points[0]) + 1n).toString() as (typeof proof.points)[0]
            await expect(pool.connect(relayer).pay(merchant.address, REF, badPoints)).to.be.reverted

            const badNullifier = { ...toCall(proof), nullifier: (BigInt(proof.nullifier) + 1n).toString() }
            await expect(
                pool.connect(relayer).pay(merchant.address, REF, badNullifier)
            ).to.be.revertedWithCustomError(pool, "InvalidProof")

            const aliased = { ...toCall(proof), nullifier: (BigInt(proof.nullifier) + SNARK_FIELD).toString() }
            await expect(pool.connect(relayer).pay(merchant.address, REF, aliased)).to.be.revertedWithCustomError(
                pool,
                "InvalidProof"
            )

            // The genuine proof still works afterwards: failed attempts burned nothing.
            await pool.connect(relayer).pay(merchant.address, REF, toCall(proof))
        })

        it("rejects unknown roots and unsupported depths", async () => {
            const { merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await expect(
                pool.connect(relayer).pay(merchant.address, REF, { ...toCall(proof), merkleTreeRoot: 42n })
            ).to.be.revertedWithCustomError(pool, "UnknownRoot")
            await expect(
                pool.connect(relayer).pay(merchant.address, REF, { ...toCall(proof), merkleTreeDepth: 33 })
            ).to.be.revertedWithCustomError(pool, "UnsupportedDepth")
        })

        it("only pays allowlisted merchants", async () => {
            const { attacker, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, attacker.address, REF, scope)
            await expect(pool.connect(relayer).pay(attacker.address, REF, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "NotMerchant"
            )
        })

        it("still accepts a proof against an older root after new deposits", async () => {
            const { customer, merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await pool.connect(customer).deposit(new Identity().commitment)
            expect(await pool.merkleRoot()).to.not.equal(proof.merkleTreeRoot)
            await pool.connect(relayer).pay(merchant.address, REF, toCall(proof))
        })

        it("a front-runner replaying the proof can only pay the same merchant for the same order", async () => {
            const { merchant, relayer, attacker, usdc, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await pool.connect(attacker).pay(merchant.address, REF, toCall(proof))
            expect(await usdc.balanceOf(merchant.address)).to.equal(DENOM)
            expect(await usdc.balanceOf(attacker.address)).to.equal(0n)
            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
        })

        it("stays solvent: balance always equals denomination x unspent notes", async () => {
            const { merchant, relayer, usdc, pool, ids, group, scope } = await loadFixture(fixture)
            for (const [i, id] of ids.entries()) {
                const ref = ethers.id(`order-${i}`)
                await pool.connect(relayer).pay(merchant.address, ref, toCall(await proofFor(pool, id, group, merchant.address, ref, scope)))
                const unspent = 3n - BigInt(i + 1)
                expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * unspent)
            }
        })

        it("is blocked while paused", async () => {
            const { owner, merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await pool.connect(owner).pause()
            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "EnforcedPause"
            )
        })
    })

    describe("withdraw", () => {
        async function withdrawProof(
            pool: Awaited<ReturnType<typeof fixture>>["pool"],
            id: Identity,
            group: Group,
            recipient: string,
            scope: bigint
        ) {
            return generateProof(id, group, await pool.withdrawMessage(recipient), scope)
        }

        it("binds the message to the recipient and WITHDRAW_REF", async () => {
            const { attacker, pool } = await loadFixture(fixture)
            expect(await pool.WITHDRAW_REF()).to.equal(ethers.id("FairPool.withdraw"))
            expect(await pool.withdrawMessage(attacker.address)).to.equal(
                await pool.messageFor(attacker.address, ethers.id("FairPool.withdraw"))
            )
        })

        it("sends exactly one denomination to the recipient, nothing to merchants or the router", async () => {
            const { merchant, relayer, attacker, usdc, fairPay, pool, ids, group, scope } = await loadFixture(fixture)
            const recipient = attacker.address // any address, not allowlisted
            const proof = await withdrawProof(pool, ids[1], group, recipient, scope)

            const tx = pool.connect(relayer).withdraw(recipient, toCall(proof))
            await expect(tx).to.emit(pool, "Withdrawal").withArgs(proof.nullifier, recipient)
            await expect(tx).to.not.emit(fairPay, "PaymentReceived")
            await expect(tx).to.not.emit(pool, "PrivatePayment")
            await expect(tx).to.changeTokenBalances(
                usdc,
                [recipient, await pool.getAddress(), merchant.address, await fairPay.getAddress(), relayer.address],
                [DENOM, -DENOM, 0n, 0n, 0n]
            )
            expect(await pool.nullifierSpent(proof.nullifier)).to.equal(true)
            expect(await usdc.allowance(await pool.getAddress(), await fairPay.getAddress())).to.equal(0n)
        })

        it("cannot be redirected: a proof for recipient A submitted for B reverts WrongMessage", async () => {
            const { customer, relayer, attacker, usdc, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await withdrawProof(pool, ids[0], group, customer.address, scope)
            await expect(pool.connect(attacker).withdraw(attacker.address, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "WrongMessage"
            )
            // A front-runner submitting it unchanged only pays the intended recipient.
            const before = await usdc.balanceOf(customer.address)
            await pool.connect(attacker).withdraw(customer.address, toCall(proof))
            expect(await usdc.balanceOf(customer.address)).to.equal(before + DENOM)
            expect(await usdc.balanceOf(attacker.address)).to.equal(0n)
            await expect(pool.connect(relayer).withdraw(customer.address, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
        })

        it("a payment proof cannot be used to withdraw, and a withdrawal proof cannot pay", async () => {
            const { merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const payProof = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await expect(pool.connect(relayer).withdraw(merchant.address, toCall(payProof))).to.be.revertedWithCustomError(
                pool,
                "WrongMessage"
            )
            const wProof = await withdrawProof(pool, ids[1], group, merchant.address, scope)
            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(wProof))).to.be.revertedWithCustomError(
                pool,
                "WrongMessage"
            )
        })

        it("rejects reuse of a withdrawn note, for another withdrawal or a payment", async () => {
            const { customer, merchant, relayer, attacker, pool, ids, group, scope } = await loadFixture(fixture)
            const p1 = await withdrawProof(pool, ids[0], group, customer.address, scope)
            await pool.connect(relayer).withdraw(customer.address, toCall(p1))

            const p2 = await withdrawProof(pool, ids[0], group, attacker.address, scope)
            expect(p2.nullifier).to.equal(p1.nullifier)
            await expect(pool.connect(relayer).withdraw(attacker.address, toCall(p2))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
            const p3 = await proofFor(pool, ids[0], group, merchant.address, REF, scope)
            await expect(pool.connect(relayer).pay(merchant.address, REF, toCall(p3))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
        })

        it("a note that already paid cannot be withdrawn", async () => {
            const { customer, merchant, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            await pool
                .connect(relayer)
                .pay(merchant.address, REF, toCall(await proofFor(pool, ids[2], group, merchant.address, REF, scope)))
            const w = await withdrawProof(pool, ids[2], group, customer.address, scope)
            await expect(pool.connect(relayer).withdraw(customer.address, toCall(w))).to.be.revertedWithCustomError(
                pool,
                "NullifierSpent"
            )
        })

        it("works while paused, with no merchants listed and after ownership is renounced", async () => {
            const { owner, customer, merchant, merchant2, relayer, usdc, pool, ids, group, scope } = await loadFixture(fixture)
            await pool.connect(owner).pause()
            await pool.connect(owner).setMerchant(merchant.address, false)
            await pool.connect(owner).setMerchant(merchant2.address, false)
            await pool.connect(owner).renounceOwnership()
            expect(await pool.paused()).to.equal(true)

            const before = await usdc.balanceOf(customer.address)
            for (const id of ids) {
                await pool.connect(relayer).withdraw(customer.address, toCall(await withdrawProof(pool, id, group, customer.address, scope)))
            }
            expect(await usdc.balanceOf(customer.address)).to.equal(before + DENOM * 3n)
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(0n)
        })

        it("rejects the zero recipient", async () => {
            const { relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const proof = await withdrawProof(pool, ids[0], group, ethers.ZeroAddress, scope)
            await expect(pool.connect(relayer).withdraw(ethers.ZeroAddress, toCall(proof))).to.be.revertedWithCustomError(
                pool,
                "ZeroRecipient"
            )
        })

        it("rejects another scope, unknown roots, unsupported depths and tampered proofs", async () => {
            const { customer, relayer, pool, ids, group, scope } = await loadFixture(fixture)
            const message = await pool.withdrawMessage(customer.address)
            const otherScope = await generateProof(ids[0], group, message, 12345n)
            await expect(pool.connect(relayer).withdraw(customer.address, toCall(otherScope))).to.be.revertedWithCustomError(
                pool,
                "WrongScope"
            )

            const proof = await withdrawProof(pool, ids[0], group, customer.address, scope)
            await expect(
                pool.connect(relayer).withdraw(customer.address, { ...toCall(proof), merkleTreeRoot: 42n })
            ).to.be.revertedWithCustomError(pool, "UnknownRoot")
            await expect(
                pool.connect(relayer).withdraw(customer.address, { ...toCall(proof), merkleTreeDepth: 33 })
            ).to.be.revertedWithCustomError(pool, "UnsupportedDepth")
            const badNullifier = { ...toCall(proof), nullifier: (BigInt(proof.nullifier) + 1n).toString() }
            await expect(pool.connect(relayer).withdraw(customer.address, badNullifier)).to.be.revertedWithCustomError(
                pool,
                "InvalidProof"
            )
            const aliased = { ...toCall(proof), nullifier: (BigInt(proof.nullifier) + SNARK_FIELD).toString() }
            await expect(pool.connect(relayer).withdraw(customer.address, aliased)).to.be.revertedWithCustomError(
                pool,
                "InvalidProof"
            )

            // Failed attempts burned nothing: the genuine proof still works.
            await pool.connect(relayer).withdraw(customer.address, toCall(proof))
        })

        it("keeps the pool solvent across mixed payments and withdrawals", async () => {
            const { customer, merchant, relayer, usdc, pool, ids, group, scope } = await loadFixture(fixture)
            await pool
                .connect(relayer)
                .pay(merchant.address, REF, toCall(await proofFor(pool, ids[0], group, merchant.address, REF, scope)))
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM * 2n)
            await pool.connect(relayer).withdraw(customer.address, toCall(await withdrawProof(pool, ids[1], group, customer.address, scope)))
            expect(await usdc.balanceOf(await pool.getAddress())).to.equal(DENOM)
            expect(await usdc.balanceOf(merchant.address)).to.equal(DENOM)
        })
    })
})
