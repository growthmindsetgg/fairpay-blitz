import { expect } from "chai"
import { ethers, network } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deployPayroll } from "../scripts/deploy-payroll"

const U = 1_000_000n // 1 USDC (6 decimals)
const DAY = 86_400
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const SCALE = 1_000_000_000n

const shiftId = (s: string) => ethers.id(`shift:${s}`)
/** Pay for `worked` seconds of a schedule, as settled on end or change. */
const proRata = (amount: bigint, period: number, worked: number) => (BigInt(worked) * amount) / BigInt(period)

/** Sends `send()` in a block with exactly timestamp `t`. */
async function at<T>(t: number, send: () => Promise<T>): Promise<T> {
    await time.setNextBlockTimestamp(t)
    return send()
}

async function gasOf(tx: Promise<{ wait: () => Promise<unknown> }>) {
    const receipt = (await (await tx).wait()) as { gasUsed: bigint }
    return receipt.gasUsed
}

describe("FairPayroll", () => {
    async function fixture() {
        const [boss, boss2, alice, bob, carol, keeper, other] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const payroll = await ethers.deployContract("FairPayroll", [await usdc.getAddress()])
        const addr = await payroll.getAddress()
        for (const s of [boss, boss2]) {
            await usdc.mint(s.address, 1_000_000n * U)
            await usdc.connect(s).approve(addr, ethers.MaxUint256)
        }
        const t0 = (await time.latest()) + 100
        return { boss, boss2, alice, bob, carol, keeper, other, usdc, payroll, addr, t0 }
    }

    it("is deployed for one token on one chain, with no owner", async () => {
        const { usdc, payroll } = await loadFixture(fixture)
        expect(await payroll.token()).to.equal(await usdc.getAddress())
        expect(await payroll.deployChainId()).to.equal(31337n)
        expect(await payroll.DAY()).to.equal(BigInt(DAY))
        expect(await payroll.WEEK()).to.equal(BigInt(WEEK))
        expect(await payroll.MONTH()).to.equal(BigInt(MONTH))
        expect(await payroll.MAX_SHIFTS()).to.equal(50n)
        const names = payroll.interface.fragments.map((f) => ("name" in f ? f.name : ""))
        for (const admin of ["owner", "pause", "upgradeTo", "rescue", "transferOwnership"]) expect(names).to.not.include(admin)
        await expect(ethers.deployContract("FairPayroll", [ethers.ZeroAddress])).to.be.revertedWithCustomError(payroll, "ZeroAddress")
    })

    // ------------------------------------------------------------ escrow

    describe("fund and withdraw", () => {
        it("fund pulls the tokens and credits the caller; withdraw sends them back", async () => {
            const { boss, usdc, payroll, addr } = await loadFixture(fixture)
            const before = await usdc.balanceOf(boss.address)
            await expect(payroll.connect(boss).fund(500n * U)).to.emit(payroll, "Funded").withArgs(boss.address, 500n * U)
            expect(await usdc.balanceOf(addr)).to.equal(500n * U)
            const info = await payroll.employerInfo(boss.address)
            expect(info.balance).to.equal(500n * U)
            expect(info.available).to.equal(500n * U)
            expect(info.owed).to.equal(0n)
            expect(info.shortfall).to.equal(0n)

            await expect(payroll.connect(boss).withdraw(200n * U)).to.emit(payroll, "Withdrawn").withArgs(boss.address, 200n * U)
            expect(await payroll.available(boss.address)).to.equal(300n * U)
            await payroll.connect(boss).withdraw(300n * U)
            expect(await usdc.balanceOf(boss.address)).to.equal(before)
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })

        it("rejects zero amounts and withdrawing more than is available", async () => {
            const { boss, payroll } = await loadFixture(fixture)
            await expect(payroll.connect(boss).fund(0n)).to.be.revertedWithCustomError(payroll, "ZeroAmount")
            await expect(payroll.connect(boss).withdraw(0n)).to.be.revertedWithCustomError(payroll, "ZeroAmount")
            await payroll.connect(boss).fund(10n * U)
            await expect(payroll.connect(boss).withdraw(10n * U + 1n))
                .to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
                .withArgs(10n * U, 10n * U + 1n)
        })

        it("an employer cannot withdraw approved shift pay", async () => {
            const { boss, alice, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            await payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("a1"), amount: 60n * U }])
            expect(await payroll.available(boss.address)).to.equal(40n * U)
            await expect(payroll.connect(boss).withdraw(41n * U)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await payroll.connect(boss).withdraw(40n * U)
            const info = await payroll.employerInfo(boss.address)
            expect(info.balance).to.equal(60n * U)
            expect(info.owed).to.equal(60n * U)
            await expect(payroll.connect(boss).withdraw(1n)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await payroll.connect(alice).claim(boss.address)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })

        it("an employer cannot withdraw earned schedule pay, nor the pay for the period in progress", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            // 2.5 days in: 200 earned (2 periods), half a period in progress, both set aside.
            await time.increaseTo(t0 + 1 + 2.5 * DAY)
            const avail = await payroll.available(boss.address)
            expect(avail).to.be.closeTo(750n * U, 50_000n)
            await expect(payroll.connect(boss).withdraw(751n * U)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(200n * U)

            await at(t0 + 1 + 2.5 * DAY + 10, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(200n * U)
            // Ending the schedule mid-period pays the half day worked, pro rata to the second.
            const half = proRata(100n * U, DAY, 2.5 * DAY + 20) - 200n * U
            await expect(at(t0 + 1 + 2.5 * DAY + 20, () => payroll.connect(boss).endSchedule(alice.address)))
                .to.emit(payroll, "ScheduleEnded")
                .withArgs(boss.address, alice.address, half, 0n)
            expect(await payroll.available(boss.address)).to.equal(800n * U - half)
            await expect(payroll.connect(boss).withdraw(800n * U - half + 1n)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            // type(uint256).max withdraws exactly what is available.
            await expect(payroll.connect(boss).withdraw(ethers.MaxUint256)).to.emit(payroll, "Withdrawn").withArgs(boss.address, 800n * U - half)
            await expect(payroll.connect(boss).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(payroll, "ZeroAmount")
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(200n * U + half)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })

        it("keeps each employer's escrow separate", async () => {
            const { boss, boss2, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            expect(await payroll.available(boss2.address)).to.equal(0n)
            await expect(payroll.connect(boss2).withdraw(1n)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await payroll.connect(boss2).fund(5n * U)
            expect(await payroll.available(boss.address)).to.equal(100n * U)
            expect(await payroll.available(boss2.address)).to.equal(5n * U)
        })

        it("rejects fee-on-transfer tokens", async () => {
            const [boss] = await ethers.getSigners()
            const fee = await ethers.deployContract("FeeToken")
            const payroll = await ethers.deployContract("FairPayroll", [await fee.getAddress()])
            await fee.mint(boss.address, 1000n * U)
            await fee.approve(await payroll.getAddress(), ethers.MaxUint256)
            await expect(payroll.fund(100n * U)).to.be.revertedWithCustomError(payroll, "AmountMismatch")
            expect(await fee.balanceOf(await payroll.getAddress())).to.equal(0n)
        })

        it("refuses a balance too large for its accounting, and tokens sent directly are credited to nobody", async () => {
            const { boss, other, usdc, payroll, addr } = await loadFixture(fixture)
            const huge = 2n ** 128n / SCALE + 1n
            await usdc.mint(boss.address, huge)
            await expect(payroll.connect(boss).fund(huge)).to.be.revertedWithCustomError(payroll, "BalanceTooLarge")
            await usdc.mint(addr, 7n)
            expect(await payroll.available(other.address)).to.equal(0n)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })
    })

    // ------------------------------------------------------------ shifts

    describe("approveShifts", () => {
        it("moves each shift's pay from available to the employee, with one event per shift", async () => {
            const { boss, alice, bob, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            const shifts = [
                { employee: alice.address, shiftId: shiftId("mon-alice"), amount: 30n * U },
                { employee: bob.address, shiftId: shiftId("mon-bob"), amount: 25n * U },
                { employee: alice.address, shiftId: shiftId("tue-alice"), amount: 15n * U }
            ]
            const tx = payroll.connect(boss).approveShifts(shifts)
            for (const s of shifts) {
                await expect(tx).to.emit(payroll, "ShiftApproved").withArgs(boss.address, s.employee, s.shiftId, s.amount)
            }
            expect(await payroll.available(boss.address)).to.equal(30n * U)
            const a = await payroll.employeeInfo(boss.address, alice.address)
            expect(a.claimable).to.equal(45n * U)
            expect(a.earned).to.equal(45n * U)
            expect(a.settled).to.equal(45n * U)
            expect(a.shortfall).to.equal(0n)
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(25n * U)
            expect(await payroll.shiftApproved(boss.address, shiftId("mon-bob"))).to.equal(true)
            expect(await payroll.shiftApproved(boss.address, shiftId("wed-bob"))).to.equal(false)
            expect((await payroll.employerInfo(boss.address)).owed).to.equal(70n * U)
        })

        it("approves a shiftId at most once per employer, and a failed batch changes nothing", async () => {
            const { boss, boss2, alice, bob, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            await payroll.connect(boss2).fund(100n * U)
            const s1 = { employee: alice.address, shiftId: shiftId("1"), amount: 10n * U }
            await payroll.connect(boss).approveShifts([s1])
            // Again, even for another employee or amount.
            await expect(payroll.connect(boss).approveShifts([{ ...s1, employee: bob.address, amount: 1n }]))
                .to.be.revertedWithCustomError(payroll, "ShiftAlreadyApproved")
                .withArgs(s1.shiftId)
            // Twice in one batch: the whole batch reverts, including the new shift before it.
            const s2 = { employee: bob.address, shiftId: shiftId("2"), amount: 5n * U }
            await expect(payroll.connect(boss).approveShifts([s2, s2])).to.be.revertedWithCustomError(payroll, "ShiftAlreadyApproved")
            expect(await payroll.shiftApproved(boss.address, s2.shiftId)).to.equal(false)
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(0n)
            expect(await payroll.available(boss.address)).to.equal(90n * U)
            // The same id is a different shift at another employer.
            await payroll.connect(boss2).approveShifts([s1])
            expect((await payroll.employeeInfo(boss2.address, alice.address)).claimable).to.equal(10n * U)
        })

        it("caps the batch at MAX_SHIFTS and rejects an empty one", async () => {
            const { boss, alice, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(1000n * U)
            const batch = (n: number, tag: string) =>
                Array.from({ length: n }, (_, i) => ({ employee: alice.address, shiftId: shiftId(`${tag}-${i}`), amount: U }))
            await expect(payroll.connect(boss).approveShifts([])).to.be.revertedWithCustomError(payroll, "EmptyBatch")
            await expect(payroll.connect(boss).approveShifts(batch(51, "x"))).to.be.revertedWithCustomError(payroll, "BatchTooLarge")
            await payroll.connect(boss).approveShifts(batch(50, "y"))
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(50n * U)
        })

        it("validates every shift", async () => {
            const { boss, alice, payroll, addr } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            const ok = { employee: alice.address, shiftId: shiftId("v"), amount: U }
            const p = payroll.connect(boss)
            await expect(p.approveShifts([{ ...ok, employee: ethers.ZeroAddress }])).to.be.revertedWithCustomError(payroll, "ZeroAddress")
            await expect(p.approveShifts([{ ...ok, employee: addr }])).to.be.revertedWithCustomError(payroll, "InvalidEmployee")
            await expect(p.approveShifts([{ ...ok, shiftId: ethers.ZeroHash }])).to.be.revertedWithCustomError(payroll, "ZeroShiftId")
            await expect(p.approveShifts([{ ...ok, amount: 0n }])).to.be.revertedWithCustomError(payroll, "ZeroAmount")
        })

        it("needs the whole batch to be available", async () => {
            const { boss, alice, bob, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(50n * U)
            await expect(
                payroll.connect(boss).approveShifts([
                    { employee: alice.address, shiftId: shiftId("1"), amount: 30n * U },
                    { employee: bob.address, shiftId: shiftId("2"), amount: 30n * U }
                ])
            )
                .to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
                .withArgs(50n * U, 60n * U)
            expect(await payroll.available(boss.address)).to.equal(50n * U)
            expect(await payroll.shiftApproved(boss.address, shiftId("1"))).to.equal(false)
        })

        it("gas for 1, 10 and 50 shifts", async () => {
            const { boss, alice, bob, carol, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(10_000n * U)
            const staff = [alice, bob, carol]
            for (const n of [1, 10, 50]) {
                const shifts = Array.from({ length: n }, (_, i) => ({
                    employee: staff[i % 3].address,
                    shiftId: shiftId(`gas-${n}-${i}`),
                    amount: 12n * U
                }))
                const gas = await gasOf(payroll.connect(boss).approveShifts(shifts))
                console.log(`      approveShifts(${n}): ${gas} gas (${gas / BigInt(n)} per shift)`)
                expect(gas).to.be.lessThan(3_000_000n)
            }
        })
    })

    // ------------------------------------------------------------ schedules

    describe("schedules", () => {
        it("validates employee, amount, period and start", async () => {
            const { boss, alice, payroll, addr } = await loadFixture(fixture)
            const now = (await time.latest()) + 1
            const p = payroll.connect(boss)
            await expect(p.setSchedule(ethers.ZeroAddress, U, DAY, now)).to.be.revertedWithCustomError(payroll, "ZeroAddress")
            await expect(p.setSchedule(addr, U, DAY, now)).to.be.revertedWithCustomError(payroll, "InvalidEmployee")
            await expect(p.setSchedule(alice.address, 0n, DAY, now)).to.be.revertedWithCustomError(payroll, "ZeroAmount")
            await expect(p.setSchedule(alice.address, 2n ** 96n, DAY, now)).to.be.revertedWithCustomError(payroll, "AmountTooLarge")
            for (const bad of [0, 3600, 2 * DAY, 31 * DAY]) {
                await expect(p.setSchedule(alice.address, U, bad, now)).to.be.revertedWithCustomError(payroll, "InvalidPeriod")
            }
            // More than 30 days ahead or behind, or a millisecond timestamp by mistake.
            await expect(p.setSchedule(alice.address, U, DAY, now + 31 * DAY)).to.be.revertedWithCustomError(payroll, "InvalidStart")
            await expect(p.setSchedule(alice.address, U, DAY, now - 31 * DAY)).to.be.revertedWithCustomError(payroll, "InvalidStart")
            await expect(p.setSchedule(alice.address, U, DAY, now * 1000)).to.be.revertedWithCustomError(payroll, "InvalidStart")
            await expect(p.endSchedule(alice.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
        })

        it("daily pay accrues per completed day", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            const gas = await gasOf(at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1)))
            console.log(`      setSchedule (new): ${gas} gas`)
            const s = await payroll.scheduleOf(boss.address, alice.address)
            expect([s.amountPerPeriod, s.period, s.start, s.paid]).to.deep.equal([100n * U, BigInt(DAY), BigInt(t0 + 1), 0n])
            const info = await payroll.employerInfo(boss.address)
            expect(info.payPerDay).to.be.closeTo(100n * U, 1n)
            expect(info.runwayUntil).to.be.closeTo(BigInt(t0 + 1 + 10 * DAY), 2n)

            await time.increaseTo(t0 + DAY - 100)
            let e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned]).to.deep.equal([0n, 0n])
            expect(e.nextPeriodEnd).to.equal(BigInt(t0 + 1 + DAY))
            await expect(payroll.connect(alice).claim(boss.address)).to.be.revertedWithCustomError(payroll, "NothingToClaim")

            await time.increaseTo(t0 + 1 + DAY + 100)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(100n * U)
            await time.increaseTo(t0 + 1 + 3 * DAY + 100)
            e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned, e.scheduleEarned, e.shortfall]).to.deep.equal([300n * U, 300n * U, 300n * U, 0n])

            const tx = at(t0 + 1 + 3 * DAY + 200, () => payroll.connect(alice).claim(boss.address))
            await expect(tx).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, alice.address, 300n * U, 300n * U, 0n)
            await expect(tx).to.not.emit(payroll, "Shortfall")
            console.log(`      claim (schedule only): ${await gasOf(tx)} gas`)
            expect(await usdc.balanceOf(alice.address)).to.equal(300n * U)
            expect((await payroll.scheduleOf(boss.address, alice.address)).paid).to.equal(300n * U)
            // Nothing more until the 4th day completes.
            await expect(payroll.connect(alice).claim(boss.address)).to.be.revertedWithCustomError(payroll, "NothingToClaim")
            await time.increaseTo(t0 + 1 + 4 * DAY)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(400n * U)
        })

        it("weekly pay and 30-day 'monthly' pay", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 700n * U, WEEK, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 3000n * U, MONTH, t0 + 2))
            await time.increaseTo(t0 + 6 * DAY)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(0n)
            await time.increaseTo(t0 + 15 * DAY)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(1400n * U)
            await time.increaseTo(t0 + 29 * DAY)
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(0n)
            await time.increaseTo(t0 + 2 + 30 * DAY + 60)
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(3000n * U)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(2800n * U)
        })

        it("endSchedule stops future pay but everything earned stays claimable", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            // 2.5 days worked: 2 full days plus half a day, pro rata.
            const end = at(t0 + 1 + 2.5 * DAY, () => payroll.connect(boss).endSchedule(alice.address))
            await expect(end).to.emit(payroll, "ScheduleEnded").withArgs(boss.address, alice.address, 250n * U, 0n)
            console.log(`      endSchedule: ${await gasOf(end)} gas`)
            const sch = await payroll.scheduleOf(boss.address, alice.address)
            expect([sch.amountPerPeriod, sch.endedAt]).to.deep.equal([0n, BigInt(t0 + 1 + 2.5 * DAY)])
            expect(await payroll.available(boss.address)).to.equal(750n * U)
            await time.increaseTo(t0 + 20 * DAY)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned, e.settled, e.nextPeriodEnd]).to.deep.equal([250n * U, 250n * U, 250n * U, 0n])
            // The employer still cannot take it.
            await expect(payroll.connect(boss).withdraw(751n * U)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(250n * U)
            await expect(payroll.connect(boss).endSchedule(alice.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
        })

        it("an employee can resign: settled pro rata exactly like endSchedule, and only for their own schedule", async () => {
            const { boss, alice, bob, keeper, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            // Nobody else can end alice's schedule through resign: it always ends the caller's own.
            for (const who of [boss, bob, keeper]) {
                await expect(payroll.connect(who).resign(boss.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            }
            const r = at(t0 + 1 + 1.5 * DAY, () => payroll.connect(alice).resign(boss.address))
            await expect(r).to.emit(payroll, "Resigned").withArgs(boss.address, alice.address)
            await expect(r).to.emit(payroll, "ScheduleEnded").withArgs(boss.address, alice.address, 150n * U, 0n)
            console.log(`      resign: ${await gasOf(r)} gas`)
            expect((await payroll.scheduleOf(boss.address, alice.address)).endedAt).to.equal(BigInt(t0 + 1 + 1.5 * DAY))
            expect(await payroll.available(boss.address)).to.equal(850n * U)
            await expect(payroll.connect(alice).resign(boss.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(150n * U)
        })

        it("resigning while unfunded turns the pay into debt shared pro rata with other leavers", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            // Both hired in one block with nothing funded (a second later the account is underfunded).
            await network.provider.send("evm_setAutomine", [false])
            await time.setNextBlockTimestamp(t0)
            await payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, { gasLimit: 300_000 })
            await payroll.connect(boss).setSchedule(bob.address, 300n * U, DAY, t0 + 1, { gasLimit: 300_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            await at(t0 + 2 * DAY + 1, () => payroll.connect(boss).endSchedule(bob.address)) // bob: 600 debt
            await at(t0 + 2 * DAY + 2, () => payroll.connect(alice).resign(boss.address)) // alice: 200 + 2 s
            const ad = (100n * U * BigInt(2 * DAY + 2)) / BigInt(DAY)
            await expect(payroll.connect(boss).fund(400n * U)).to.emit(payroll, "DebtBacked")
            const a = await payroll.employeeInfo(boss.address, alice.address)
            expect(a.claimable).to.be.closeTo((400n * U * ad) / (ad + 600n * U), 2n)
            const c = payroll.connect(alice).claim(boss.address)
            await expect(c).to.emit(payroll, "DebtRepaid").withArgs(boss.address, alice.address, a.claimable)
            await expect(c).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, alice.address, a.claimable, 0n, a.claimable)
            expect(await usdc.balanceOf(alice.address)).to.equal(a.claimable)
        })

        it("changing a schedule settles what was earned under the old terms first", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(5000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const t1 = t0 + 1 + 2.5 * DAY
            // start 0 = now. The 2.5 days worked are settled at the old rate (pro rata), new terms from now.
            const change = at(t1, () => payroll.connect(boss).setSchedule(alice.address, 200n * U, DAY, 0))
            await expect(change).to.emit(payroll, "ScheduleEnded").withArgs(boss.address, alice.address, 250n * U, 0n)
            await expect(change).to.emit(payroll, "ScheduleSet").withArgs(boss.address, alice.address, 200n * U, DAY, t1, t1, 0n)
            console.log(`      setSchedule (change): ${await gasOf(change)} gas`)
            await at(t1 + 2 * DAY + 5, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(250n * U + 400n * U)
        })

        it("a change can never start in the past, and a new schedule never before the previous one ended", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(5000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const t1 = t0 + 1 + 2.5 * DAY
            await time.increaseTo(t1)
            for (const start of [t0 + 1, t0 + 1 + 2 * DAY, t1 - 1]) {
                await expect(payroll.connect(boss).setSchedule(alice.address, 200n * U, DAY, start)).to.be.revertedWithCustomError(
                    payroll,
                    "InvalidStart"
                )
            }
            // A future start is fine: the old schedule is settled now and the gap is unpaid.
            const tc = t1 + 10
            await at(tc, () => payroll.connect(boss).setSchedule(alice.address, 200n * U, DAY, tc + DAY))
            // Ending and re-creating with a back-dated start cannot pay ended time again.
            const t2 = tc + 3 * DAY
            await at(t2, () => payroll.connect(boss).endSchedule(alice.address))
            await time.increaseTo(t2 + 10)
            await expect(payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t2 - 1)).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            await at(t2 + 20, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t2)) // from the end: 20 s of back pay
            await at(t2 + DAY + 30, () => payroll.connect(alice).claim(boss.address))
            // Old terms pro rata + 2 days at 200 after the unpaid gap day + one day from t2. Nothing twice.
            const old = proRata(100n * U, DAY, tc - (t0 + 1))
            expect(await usdc.balanceOf(alice.address)).to.equal(old + 400n * U + 100n * U)
        })

        it("a start in the past sets the back pay aside at once and needs the funds", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            const back = t0 + 1 - 3 * DAY
            await expect(at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, back))).to.be.revertedWithCustomError(
                payroll,
                "InsufficientAvailable"
            )
            await at(t0 + 2, () => payroll.connect(boss).fund(250n * U))
            await expect(at(t0 + 3, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, back))).to.be.revertedWithCustomError(
                payroll,
                "InsufficientAvailable"
            )
            await at(t0 + 4, () => payroll.connect(boss).fund(100n * U))
            const set = at(t0 + 5, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, back))
            const rate = (100n * U * SCALE + BigInt(DAY) - 1n) / BigInt(DAY)
            const upfront = (rate * BigInt(t0 + 5 - back) + SCALE - 1n) / SCALE
            await expect(set).to.emit(payroll, "ScheduleSet").withArgs(boss.address, alice.address, 100n * U, DAY, back, back, upfront)
            expect(await payroll.available(boss.address)).to.be.closeTo(50n * U, 50_000n)
            await at(t0 + 6, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(300n * U)
        })

        it("a future start pays nothing before it; pay is set aside from when it was set", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            const start = t0 + 1 + 5 * DAY
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, start))
            await time.increaseTo(start + DAY - 60)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned]).to.deep.equal([0n, 0n])
            expect(e.nextPeriodEnd).to.equal(BigInt(start + DAY))
            expect(await payroll.available(boss.address)).to.be.closeTo(400n * U, 100_000n)
            // Ending pays the time worked since the start pro rata and returns the reservation made ahead.
            const worked = proRata(100n * U, DAY, DAY - 50)
            await expect(at(start + DAY - 50, () => payroll.connect(boss).endSchedule(alice.address)))
                .to.emit(payroll, "ScheduleEnded")
                .withArgs(boss.address, alice.address, worked, 0n)
            expect(await payroll.available(boss.address)).to.equal(1000n * U - worked)
        })
    })

    // ------------------------------------------------------------ claims

    describe("claim and claimFor", () => {
        it("claim pays shift pay and schedule pay in one transfer", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("s"), amount: 40n * U }]))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 2))
            const tx = at(t0 + 2 + DAY, () => payroll.connect(alice).claim(boss.address))
            await expect(tx).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, alice.address, 140n * U, 100n * U, 0n)
            expect(await usdc.balanceOf(alice.address)).to.equal(140n * U)
        })

        it("claimFor lets anyone trigger the payout, and the money only goes to the employee", async () => {
            const { boss, alice, keeper, usdc, payroll } = await loadFixture(fixture)
            await payroll.connect(boss).fund(100n * U)
            await payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("k"), amount: 70n * U }])
            const keeperBefore = await usdc.balanceOf(keeper.address)
            const tx = payroll.connect(keeper).claimFor(boss.address, alice.address)
            await expect(tx).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, keeper.address, 70n * U, 0n, 0n)
            console.log(`      claimFor (shift pay only): ${await gasOf(tx)} gas`)
            expect(await usdc.balanceOf(alice.address)).to.equal(70n * U)
            expect(await usdc.balanceOf(keeper.address)).to.equal(keeperBefore)
            // There is no parameter a keeper could use to redirect: claimFor(employer, employee) only.
            expect(payroll.interface.getFunction("claimFor")!.inputs.map((i) => i.name)).to.deep.equal(["employer", "employee"])
            await expect(payroll.connect(keeper).claimFor(boss.address, alice.address)).to.be.revertedWithCustomError(payroll, "NothingToClaim")
            await expect(payroll.connect(keeper).claimFor(boss.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(payroll, "ZeroAddress")
            // The employer's free money is not reachable through claims either.
            await expect(payroll.connect(keeper).claimFor(boss.address, keeper.address)).to.be.revertedWithCustomError(payroll, "NothingToClaim")
            await expect(payroll.connect(boss).claim(boss.address)).to.be.revertedWithCustomError(payroll, "NothingToClaim")
            expect(await payroll.available(boss.address)).to.equal(30n * U)
        })

        it("one person can work for several employers, each paid separately", async () => {
            const { boss, boss2, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(500n * U))
            await at(t0 + 1, () => payroll.connect(boss2).fund(500n * U))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 2))
            await at(t0 + 3, () => payroll.connect(boss2).approveShifts([{ employee: alice.address, shiftId: shiftId("x"), amount: 25n * U }]))
            // boss2 uses the same shift id space independently and a schedule of its own.
            await at(t0 + 4, () => payroll.connect(boss2).setSchedule(alice.address, 10n * U, DAY, t0 + 4))
            await time.increaseTo(t0 + 2 * DAY + 100)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(200n * U)
            expect((await payroll.employeeInfo(boss2.address, alice.address)).claimable).to.equal(45n * U)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(200n * U)
            expect((await payroll.employeeInfo(boss2.address, alice.address)).claimable).to.equal(45n * U)
            await payroll.connect(alice).claim(boss2.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(245n * U)
            // Ending at one employer leaves the other untouched.
            await payroll.connect(boss).endSchedule(alice.address)
            expect((await payroll.scheduleOf(boss2.address, alice.address)).amountPerPeriod).to.equal(10n * U)
        })
    })

    // ------------------------------------------------------------ underfunding

    describe("underfunded schedules", () => {
        it("pays what is set aside, reports the shortfall, and pays the rest once funded", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(150n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            await time.increaseTo(t0 + 1 + 2 * DAY + 3600)
            const info = await payroll.employerInfo(boss.address)
            expect(info.available).to.equal(0n) // the sub-second rounding dust left in free is not withdrawable
            expect(info.fundedUntil).to.be.closeTo(BigInt(t0 + 1 + 1.5 * DAY), 2n)
            expect(info.shortfall).to.be.closeTo(50n * U + (100n * U * 3600n) / BigInt(DAY), 10_000n)
            const before = await payroll.employeeInfo(boss.address, alice.address)
            expect(before.earned).to.equal(200n * U)
            expect(before.claimable + before.shortfall).to.equal(200n * U)
            expect(before.claimable).to.be.closeTo(150n * U, 2000n)

            const tx = at(t0 + 1 + 2 * DAY + 3700, () => payroll.connect(alice).claim(boss.address))
            const receipt = (await (await tx).wait())!
            const logs = receipt.logs.map((l) => payroll.interface.parseLog(l)).filter((l) => l !== null)
            const claimed = logs.find((l) => l!.name === "Claimed")!.args.amount as bigint
            const unpaid = logs.find((l) => l!.name === "Shortfall")!.args.unpaid as bigint
            expect(logs.some((l) => l!.name === "Underfunded")).to.equal(true)
            expect(claimed + unpaid).to.equal(200n * U)
            expect(claimed).to.be.closeTo(150n * U, 2000n)
            expect(await usdc.balanceOf(alice.address)).to.equal(claimed)
            // Underfunded: no new commitments, no withdrawals, no shifts.
            await expect(payroll.connect(boss).setSchedule(alice.address, U, DAY, 0)).to.be.revertedWithCustomError(payroll, "AccountUnderfunded")
            await expect(payroll.connect(boss).withdraw(1n)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await expect(
                payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("u"), amount: U }])
            ).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")

            // Funding again first pays for the time that was not set aside, oldest first.
            await at(t0 + 1 + 2 * DAY + 7200, () => payroll.connect(boss).fund(100n * U))
            const after = await payroll.employerInfo(boss.address)
            expect(after.shortfall).to.equal(0n)
            await at(t0 + 1 + 2 * DAY + 7300, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(200n * U)
        })

        it("approved shift pay is always paid in full, even when schedule pay is short", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(50n * U))
            await at(t0 + 1, () => payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("f"), amount: 50n * U }]))
            // Nothing free is left, but the account is not in debt, so a schedule can still be set.
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 2))
            const tx = at(t0 + 2 + 1.5 * DAY, () => payroll.connect(alice).claim(boss.address))
            await expect(tx).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, alice.address, 50n * U, 0n, 0n)
            await expect(tx).to.emit(payroll, "Shortfall").withArgs(boss.address, alice.address, 100n * U)
            expect(await usdc.balanceOf(alice.address)).to.equal(50n * U)
        })

        it("a claim with nothing funded still records the shortfall instead of reverting", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0))
            const tx = at(t0 + DAY + 10, () => payroll.connect(alice).claim(boss.address))
            await expect(tx).to.emit(payroll, "Shortfall").withArgs(boss.address, alice.address, 100n * U)
            await expect(tx).to.not.emit(payroll, "Claimed")
        })

        it("ending a schedule while underfunded keeps the unfunded pay as debt, paid first from new funds", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0))
            // 3.5 days worked, nothing funded: all of it (pro rata) becomes debt.
            const end = at(t0 + 3.5 * DAY, () => payroll.connect(boss).endSchedule(alice.address))
            await expect(end).to.emit(payroll, "ScheduleEnded").withArgs(boss.address, alice.address, 0n, 350n * U)
            await expect(end).to.emit(payroll, "Underfunded").withArgs(boss.address, t0 + 3.5 * DAY, 350n * U)
            let e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned, e.debt, e.shortfall]).to.deep.equal([0n, 350n * U, 350n * U, 350n * U])
            expect((await payroll.employerInfo(boss.address)).shortfall).to.equal(350n * U)
            expect(await payroll.fundingNeeded(boss.address, 0)).to.equal(350n * U)
            await expect(payroll.connect(boss).setSchedule(alice.address, U, DAY, t0 + 4 * DAY)).to.be.revertedWithCustomError(
                payroll,
                "AccountUnderfunded"
            )

            await expect(payroll.connect(boss).fund(120n * U)).to.emit(payroll, "DebtBacked").withArgs(boss.address, 120n * U, 230n * U)
            e = await payroll.employeeInfo(boss.address, alice.address)
            // The pro-rata debt index rounds the remaining debt up, so a share can be a unit short until
            // all debt is backed; then the remainder is exact.
            expect(e.claimable).to.be.closeTo(120n * U, 1n)
            expect(e.claimable + e.shortfall).to.equal(350n * U)
            expect(await payroll.available(boss.address)).to.equal(0n)
            const c = payroll.connect(alice).claim(boss.address)
            await expect(c).to.emit(payroll, "Shortfall").withArgs(boss.address, alice.address, 350n * U - e.claimable)
            await expect(c).to.emit(payroll, "Claimed").withArgs(boss.address, alice.address, alice.address, e.claimable, 0n, e.claimable)
            await payroll.connect(boss).fund(500n * U)
            expect(await payroll.available(boss.address)).to.equal(270n * U)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(350n * U)
            expect((await payroll.employerInfo(boss.address)).owed).to.equal(0n)
        })

        it("a schedule added later (e.g. to the employer's own second wallet) cannot take pay already set aside", async () => {
            const { boss, alice, other, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            // After 5 days alice has earned 500. The employer adds a huge schedule for another wallet.
            await at(t0 + 1 + 5 * DAY, () => payroll.connect(boss).setSchedule(other.address, 100_000n * U, DAY, t0 + 1 + 5 * DAY))
            await at(t0 + 1 + 6 * DAY + 10, () => payroll.connect(other).claim(boss.address))
            await at(t0 + 1 + 6 * DAY + 20, () => payroll.connect(alice).claim(boss.address))
            const a = await usdc.balanceOf(alice.address)
            const o = await usdc.balanceOf(other.address)
            // Alice keeps the 500 earned before, plus her share of the free money after; the rest of
            // her 6th day is a shortfall, still owed.
            expect(a).to.be.greaterThanOrEqual(500n * U)
            expect(a + o).to.be.lessThanOrEqual(1000n * U)
            expect(o).to.be.lessThan(500n * U)
            expect((await payroll.employeeInfo(boss.address, alice.address)).shortfall).to.equal(600n * U - a)
        })
    })

    // ------------------------------------------------------------ reentrancy

    describe("reentrancy", () => {
        async function hookFixture() {
            const [boss, alice] = await ethers.getSigners()
            const hook = await ethers.deployContract("HookToken")
            const payroll = await ethers.deployContract("FairPayroll", [await hook.getAddress()])
            await hook.mint(boss.address, 1000n * U)
            await hook.connect(boss).approve(await payroll.getAddress(), ethers.MaxUint256)
            return { boss, alice, hook, payroll }
        }

        it("a token callback cannot re-enter during a claim", async () => {
            const { boss, alice, hook, payroll } = await loadFixture(hookFixture)
            await payroll.connect(boss).fund(100n * U)
            await payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: shiftId("r"), amount: 10n * U }])
            for (const data of [
                payroll.interface.encodeFunctionData("claim", [boss.address]),
                payroll.interface.encodeFunctionData("claimFor", [boss.address, alice.address]),
                payroll.interface.encodeFunctionData("withdraw", [1n])
            ]) {
                await hook.arm(await payroll.getAddress(), data)
                await expect(payroll.connect(alice).claim(boss.address)).to.be.revertedWithCustomError(payroll, "ReentrancyGuardReentrantCall")
            }
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(10n * U)
        })

        it("a token callback cannot re-enter during fund or withdraw", async () => {
            const { boss, hook, payroll } = await loadFixture(hookFixture)
            const target = await payroll.getAddress()
            await hook.arm(target, payroll.interface.encodeFunctionData("withdraw", [1n]))
            await expect(payroll.connect(boss).fund(100n * U)).to.be.revertedWithCustomError(payroll, "ReentrancyGuardReentrantCall")
            // The revert also undid the hook reset, so re-arm it with a harmless view call.
            await hook.arm(target, payroll.interface.encodeFunctionData("available", [boss.address]))
            await payroll.connect(boss).fund(100n * U)
            await hook.arm(target, payroll.interface.encodeFunctionData("withdraw", [1n]))
            await expect(payroll.connect(boss).withdraw(50n * U)).to.be.revertedWithCustomError(payroll, "ReentrancyGuardReentrantCall")
            expect(await payroll.available(boss.address)).to.equal(100n * U)
        })
    })

    // ------------------------------------------------------------ invariants

    it("random operations keep the books balanced and leave nothing stuck", async () => {
        const { boss, boss2, alice, bob, carol, keeper, usdc, payroll, addr } = await loadFixture(fixture)
        let seed = Number(process.env.PAYROLL_SEED ?? 0x5eed)
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            return seed / 0x7fffffff
        }
        const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
        const employers = [boss, boss2]
        const staff = [alice, bob, carol]
        const periods = [DAY, WEEK, MONTH]
        const done: Record<string, number> = {}
        let shiftN = 0

        const check = async () => {
            let sum = 0n
            for (const e of employers) {
                const info = await payroll.employerInfo(e.address)
                let claimables = 0n
                expect(info.available).to.be.lessThanOrEqual(info.balance)
                if (info.shortfall > 0n) expect(info.available).to.equal(0n)
                sum += info.balance
                for (const s of staff) {
                    const p = await payroll.employeeInfo(e.address, s.address)
                    expect(p.claimable).to.be.lessThanOrEqual(p.earned)
                    expect(p.claimable + p.shortfall).to.equal(p.earned)
                    claimables += p.claimable
                }
                // Everyone could be paid at once, and the employer could withdraw, at the same time.
                expect(claimables + info.available).to.be.lessThanOrEqual(info.balance)
            }
            // Every token the contract holds belongs to exactly one employer's escrow.
            expect(await usdc.balanceOf(addr)).to.equal(sum)
        }

        for (let step = 0; step < 120; step++) {
            const e = pick(employers)
            const s = pick(staff)
            const r = rand()
            let op = ""
            try {
                if (r < 0.15) {
                    op = "fund"
                    await payroll.connect(e).fund(BigInt(Math.floor(rand() * 500) + 1) * U)
                } else if (r < 0.25) {
                    op = "withdraw"
                    const avail = await payroll.available(e.address)
                    if (avail > 10n) await payroll.connect(e).withdraw(avail / 2n)
                } else if (r < 0.4) {
                    op = "shifts"
                    const n = Math.floor(rand() * 5) + 1
                    await payroll.connect(e).approveShifts(
                        Array.from({ length: n }, () => ({ employee: pick(staff).address, shiftId: shiftId(`r${shiftN++}`), amount: BigInt(Math.floor(rand() * 40) + 1) * U }))
                    )
                } else if (r < 0.52) {
                    op = "setSchedule"
                    const now = (await time.latest()) + 1
                    const start = rand() < 0.3 ? 0 : now + Math.floor((rand() - 0.6) * 5 * DAY)
                    await payroll.connect(e).setSchedule(s.address, BigInt(Math.floor(rand() * 300) + 1) * U + 123n, pick(periods), start)
                } else if (r < 0.6) {
                    op = rand() < 0.5 ? "endSchedule" : "resign"
                    if (op === "resign") await payroll.connect(s).resign(e.address)
                    else await payroll.connect(e).endSchedule(s.address)
                } else if (r < 0.8) {
                    op = "claim"
                    if (rand() < 0.5) await payroll.connect(s).claim(e.address)
                    else await payroll.connect(keeper).claimFor(e.address, s.address)
                } else {
                    op = "time"
                    await time.increase(Math.floor(rand() * 3 * DAY) + 1)
                }
                done[op] = (done[op] ?? 0) + 1
            } catch (err) {
                const msg = String((err as Error).message)
                // Only expected business-rule reverts.
                expect(msg).to.match(/InsufficientAvailable|AccountUnderfunded|NoSchedule|NothingToClaim|InvalidStart/, `${op}: ${msg}`)
                done[`${op} (reverted)`] = (done[`${op} (reverted)`] ?? 0) + 1
            }
            await check()
        }
        console.log("      ops:", JSON.stringify(done))

        // Wind everything down: end all schedules, clear debts, pay everyone, withdraw the rest.
        await time.increase(40 * DAY)
        for (const e of employers) {
            for (const s of staff) {
                if ((await payroll.scheduleOf(e.address, s.address)).amountPerPeriod !== 0n) await payroll.connect(e).endSchedule(s.address)
            }
            const short = (await payroll.employerInfo(e.address)).shortfall
            if (short > 0n) await payroll.connect(e).fund(short)
            expect((await payroll.employerInfo(e.address)).shortfall).to.equal(0n)
            for (const s of staff) {
                const p = await payroll.employeeInfo(e.address, s.address)
                expect(p.shortfall).to.equal(0n)
                if (p.claimable > 0n) await payroll.connect(keeper).claimFor(e.address, s.address)
            }
            const avail = await payroll.available(e.address)
            if (avail > 0n) await payroll.connect(e).withdraw(avail)
            const info = await payroll.employerInfo(e.address)
            expect([info.balance, info.available, info.owed]).to.deep.equal([0n, 0n, 0n])
        }
        expect(await usdc.balanceOf(addr)).to.equal(0n)
    })

    // ------------------------------------------------------------ deploy script

    it("deploy-payroll.ts deploys for the deployment's token and records it", async () => {
        const { usdc } = await loadFixture(fixture)
        const dir = mkdtempSync(path.join(os.tmpdir(), "payroll-deploy-"))
        try {
            const file = path.join(dir, "hardhat.json")
            writeFileSync(file, JSON.stringify({ chainId: 31337, token: await usdc.getAddress(), pool: "0xkept" }))
            const { address, blockNumber } = await deployPayroll({ file, confirmations: 1 })
            const out = JSON.parse(readFileSync(file, "utf8"))
            expect(out.payroll).to.equal(address)
            expect(out.payrollDeployBlock).to.equal(String(blockNumber))
            expect(out.pool).to.equal("0xkept")
            const payroll = await ethers.getContractAt("FairPayroll", address)
            expect(await payroll.token()).to.equal(await usdc.getAddress())

            writeFileSync(file, JSON.stringify({ chainId: 10143, token: await usdc.getAddress() }))
            await expect(deployPayroll({ file, confirmations: 1 })).to.be.rejectedWith(/is for chain 10143/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
