import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"

const REF = ethers.id("order-1:participant-1:secret")

describe("FairPay", () => {
    async function fixture() {
        const [owner, payer, merchant, other] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const fairPay = await ethers.deployContract("FairPay", [await usdc.getAddress(), owner.address])
        await usdc.mint(payer.address, 1_000_000_000n)
        await usdc.connect(payer).approve(await fairPay.getAddress(), ethers.MaxUint256)
        return { owner, payer, merchant, other, usdc, fairPay }
    }

    it("moves tokens straight to the recipient and emits the order reference", async () => {
        const { payer, merchant, usdc, fairPay } = await loadFixture(fixture)
        await expect(fairPay.connect(payer).directPay(merchant.address, 12_500_000n, REF))
            .to.emit(fairPay, "PaymentReceived")
            .withArgs(REF, merchant.address, payer.address, 12_500_000n)
        expect(await usdc.balanceOf(merchant.address)).to.equal(12_500_000n)
        expect(await usdc.balanceOf(await fairPay.getAddress())).to.equal(0n)
    })

    it("rejects zero recipient, zero amount, zero reference and itself as recipient", async () => {
        const { payer, merchant, fairPay } = await loadFixture(fixture)
        const p = fairPay.connect(payer)
        await expect(p.directPay(ethers.ZeroAddress, 1n, REF)).to.be.revertedWithCustomError(fairPay, "ZeroAddress")
        await expect(p.directPay(merchant.address, 0n, REF)).to.be.revertedWithCustomError(fairPay, "ZeroAmount")
        await expect(p.directPay(merchant.address, 1n, ethers.ZeroHash)).to.be.revertedWithCustomError(
            fairPay,
            "ZeroOrderRef"
        )
        await expect(p.directPay(await fairPay.getAddress(), 1n, REF)).to.be.revertedWithCustomError(
            fairPay,
            "InvalidRecipient"
        )
    })

    it("cannot spend a payer's allowance on someone else's behalf", async () => {
        const { payer, merchant, other, fairPay } = await loadFixture(fixture)
        // `other` has no tokens; the payer's approval to FairPay must not be usable by `other`.
        await expect(fairPay.connect(other).directPay(merchant.address, 1n, REF)).to.be.reverted
        expect(payer.address).to.not.equal(other.address)
    })

    it("only the owner can pause, and pausing blocks payments", async () => {
        const { owner, payer, merchant, other, fairPay } = await loadFixture(fixture)
        await expect(fairPay.connect(other).pause()).to.be.revertedWithCustomError(fairPay, "OwnableUnauthorizedAccount")
        await fairPay.connect(owner).pause()
        await expect(fairPay.connect(payer).directPay(merchant.address, 1n, REF)).to.be.revertedWithCustomError(
            fairPay,
            "EnforcedPause"
        )
    })

    it("rejects fee-on-transfer tokens so the event always matches what arrived", async () => {
        const [owner, payer, merchant] = await ethers.getSigners()
        const fee = await ethers.deployContract("FeeToken")
        const fairPay = await ethers.deployContract("FairPay", [await fee.getAddress(), owner.address])
        await fee.mint(payer.address, 1_000_000n)
        await fee.connect(payer).approve(await fairPay.getAddress(), ethers.MaxUint256)
        await expect(fairPay.connect(payer).directPay(merchant.address, 1_000n, REF)).to.be.revertedWithCustomError(
            fairPay,
            "AmountMismatch"
        )
    })
})
