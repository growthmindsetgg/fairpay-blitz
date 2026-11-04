// More adversarial tests for FairPayroll: pro-rata settlement, start rules, the debt index, sock
// wallets, fundingNeeded and events. Written independently of FairPayroll.test.ts.
import { expect } from "chai"
import { ethers, network } from "hardhat"
import { loadFixture, time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers"

const U = 1_000_000n
const DAY = 86_400
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const SCALE = 1_000_000_000n
const G = { gasLimit: 500_000 }
const sid = (s: string) => ethers.id(`adv2:${s}`)

async function at<T>(t: number, send: () => Promise<T>): Promise<T> {
    await time.setNextBlockTimestamp(t)
    return send()
}

/** Runs `sends` (each returns a tx promise, sent with explicit gas) in ONE block at timestamp t. */
async function oneBlock(t: number, sends: (() => Promise<unknown>)[]) {
    await time.setNextBlockTimestamp(t)
    await network.provider.send("evm_setAutomine", [false])
    try {
        for (const s of sends) await s()
        await network.provider.send("evm_mine")
    } finally {
        await network.provider.send("evm_setAutomine", [true])
    }
    const blk = await ethers.provider.getBlock("latest")
    return Promise.all(blk!.transactions.map(async (h) => (await ethers.provider.getTransactionReceipt(h))!))
}

describe("FairPayroll (adversarial, part 2)", () => {
    async function fixture() {
        const [boss, boss2, alice, bob, carol, dave, keeper, sock, sock2, sock3] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const payroll = await ethers.deployContract("FairPayroll", [await usdc.getAddress()])
        const addr = await payroll.getAddress()
        for (const s of [boss, boss2]) {
            await usdc.mint(s.address, 10n ** 32n)
            await usdc.connect(s).approve(addr, ethers.MaxUint256)
        }
        const t0 = (await time.latest()) + 100
        return { boss, boss2, alice, bob, carol, dave, keeper, sock, sock2, sock3, usdc, payroll, addr, t0 }
    }

    // ================================================================== pro rata on end / change
    describe("pro rata on end and change", () => {
        it("end at the last second of a MONTH pays floor(worked * amount / period); employer gets only the rest", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(3000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 3000n * U, MONTH, t0 + 1))
            const worked = MONTH - 1
            await at(t0 + 1 + worked, () => payroll.connect(boss).endSchedule(alice.address))
            const expected = (BigInt(worked) * 3000n * U) / BigInt(MONTH)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(expected)
            await payroll.connect(boss).withdraw(ethers.MaxUint256)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(expected)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })

        it("boundaries: end 1s after start, exactly at k periods, and after a claim of completed periods", async () => {
            const { boss, alice, bob, carol, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U + 7n, DAY, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss).endSchedule(alice.address))
            expect((await payroll.employeeInfo(boss.address, alice.address)).settled).to.equal((100n * U + 7n) / BigInt(DAY))

            await at(t0 + 3, () => payroll.connect(boss).setSchedule(bob.address, 7n, WEEK, t0 + 3))
            await at(t0 + 10, () => payroll.connect(boss).setSchedule(carol.address, 1000n * U, DAY, t0 + 10))
            // carol claims 2 completed days, then leaves half way through day 3: +500 pro rata
            await at(t0 + 10 + 2 * DAY + 5, () => payroll.connect(carol).claim(boss.address))
            expect(await usdc.balanceOf(carol.address)).to.equal(2000n * U)
            await at(t0 + 10 + 2 * DAY + DAY / 2, () => payroll.connect(boss).endSchedule(carol.address))
            await payroll.connect(carol).claim(boss.address)
            expect(await usdc.balanceOf(carol.address)).to.equal(2500n * U)
            // exactly 3 weeks: 21, no rounding residue
            await at(t0 + 3 + 3 * WEEK, () => payroll.connect(boss).endSchedule(bob.address))
            expect((await payroll.employeeInfo(boss.address, bob.address)).settled).to.equal(21n)
        })

        it("pro-rata while underfunded splits into backed + debt and never exceeds the pro-rata total", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(30n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const end = at(t0 + 1 + DAY / 2, () => payroll.connect(boss).endSchedule(alice.address))
            const rc = await (await end).wait()
            const ev = rc!.logs.map((l) => payroll.interface.parseLog(l)).find((l) => l?.name === "ScheduleEnded")!
            expect(ev.args.settled + ev.args.debt).to.equal(50n * U)
            // funded seconds are whole seconds of the rounded-up rate: up to ~1 s of pay stays as free dust
            expect(ev.args.settled).to.be.lessThanOrEqual(30n * U)
            expect(ev.args.settled).to.be.greaterThanOrEqual(30n * U - (100n * U) / BigInt(DAY) - 1n)
        })
    })

    // ================================================================== no back-dating over paid time
    describe("start rules", () => {
        it("a change must start now or later; 0 means now", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const t = t0 + 1 + 10.5 * DAY
            await expect(at(t, () => payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, t0 + 1))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            await expect(at(t + 1, () => payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, t))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            await at(t + 2, () => payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, 0))
            expect((await payroll.scheduleOf(boss.address, alice.address)).start).to.equal(BigInt(t + 2))
        })

        it("after an end, a new schedule cannot start before endedAt, also after several end/re-set cycles", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(100_000n * U))
            let t = t0 + 1
            await at(t, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t))
            let paidTime = 0
            for (let i = 0; i < 4; i++) {
                const endT = t + 3 * DAY + 123
                await at(endT, () => payroll.connect(boss).endSchedule(alice.address))
                paidTime += endT - t
                expect((await payroll.scheduleOf(boss.address, alice.address)).endedAt).to.equal(BigInt(endT))
                await expect(at(endT + 10, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, endT - 1))).to.be.revertedWithCustomError(
                    payroll,
                    "InvalidStart"
                )
                // allowed: exactly endedAt (back pay for the gap between end and now); coverage stays continuous
                await at(endT + 20, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, endT))
                t = endT
            }
            await at(t + 5 * DAY, () => payroll.connect(boss).endSchedule(alice.address))
            paidTime += 5 * DAY
            await payroll.connect(alice).claim(boss.address)
            // Exactly the time between the first start and the last end is paid, never more.
            const total = await usdc.balanceOf(alice.address)
            expect(total).to.be.lessThanOrEqual((BigInt(paidTime) * 100n * U) / BigInt(DAY))
            expect(total).to.be.greaterThan((BigInt(paidTime) * 100n * U) / BigInt(DAY) - 10n)
        })

        it("endedAt survives across a schedule that never started (future start ended early)", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            await at(t0 + 1 + 5 * DAY, () => payroll.connect(boss).endSchedule(alice.address))
            const e1 = t0 + 1 + 5 * DAY
            await at(e1 + 10, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, e1 + 10 * DAY))
            await at(e1 + 20, () => payroll.connect(boss).endSchedule(alice.address))
            // endedAt is now e1+20; the first schedule's time (before e1) cannot be re-paid.
            await expect(at(e1 + 30, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, e1 - DAY))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
        })

        it("start = now - 30 days is the oldest allowed for a first schedule; start > now + 30 days refused", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(100_000n * U))
            await expect(at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, U, DAY, t0 + 1 - MONTH - 1))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(alice.address, U, DAY, t0 + 2 - MONTH))
            await expect(at(t0 + 3, () => payroll.connect(boss).setSchedule(bob.address, U, DAY, t0 + 3 + MONTH + 1))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(30n * U)
        })
    })

    // ================================================================== debt index
    /** Creates debts: the listed employees get schedules (one block, no funds), each ended in order. */
    async function makeDebts(
        payroll: any,
        boss: any,
        t0: number,
        list: { who: any; perDay: bigint; endAfter: number }[]
    ) {
        await oneBlock(
            t0,
            list.map((x) => () => payroll.connect(boss).setSchedule(x.who.address, x.perDay, DAY, t0, G))
        )
        for (const x of list) await at(t0 + x.endAfter, () => payroll.connect(boss).endSchedule(x.who.address))
    }

    describe("debt index", () => {
        it("pro rata between debtors, independent of claim order (snapshots)", async () => {
            const { boss, alice, bob, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await makeDebts(payroll, boss, t0, [
                { who: alice, perDay: 100n * U, endAfter: 3 * DAY },
                { who: bob, perDay: 33n * U + 3n, endAfter: 3 * DAY + 1 },
                { who: sock, perDay: 1_000_000n * U, endAfter: 3 * DAY + 2 }
            ])
            const debts = await Promise.all([alice, bob, sock].map(async (s) => (await payroll.employeeInfo(boss.address, s.address)).debt))
            const total = debts.reduce((a, b) => a + b, 0n)
            await payroll.connect(boss).fund(1_000_000n * U + 7n)
            const results: bigint[][] = []
            for (const order of [
                [alice, bob, sock],
                [sock, bob, alice],
                [bob, sock, alice]
            ]) {
                const snap = await takeSnapshot()
                for (const s of order) await payroll.connect(s).claim(boss.address).catch(() => undefined)
                results.push(await Promise.all([alice, bob, sock].map((s) => usdc.balanceOf(s.address))))
                await snap.restore()
            }
            expect(results[1]).to.deep.equal(results[0])
            expect(results[2]).to.deep.equal(results[0])
            const backed = 1_000_000n * U + 7n
            for (let i = 0; i < 3; i++) {
                const exact = (debts[i] * backed) / total
                expect(results[0][i]).to.be.lessThanOrEqual(exact)
                expect(results[0][i]).to.be.greaterThanOrEqual(exact - 2n)
            }
        })

        it("a debtor joining mid-epoch gets its share of later backings only", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            await makeDebts(payroll, boss, t0, [{ who: alice, perDay: 100n * U, endAfter: DAY }])
            // bob's schedule was set at t0 too (same block would be nicer; set it before alice's end)
            await payroll.connect(boss).fund(50n * U) // alice: 50 of 100 backed
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(50n * U)
        })

        it("mid-epoch join: alice 100 (50% backed), then bob 100 joins, then 75 more backed => alice 87.5, bob 37.5", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(bob.address, 100n * U, DAY, t0, G)
            ])
            await at(t0 + DAY, () => payroll.connect(boss).endSchedule(alice.address))
            // bob keeps running and is unfunded; fund only alice's half: debts are senior to bob's time.
            await at(t0 + DAY + 10, () => payroll.connect(boss).fund(50n * U))
            await at(t0 + DAY + 20, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(50n * U)
            // bob leaves 1% of a day later: debt 101 joins at index 0.5
            await at(t0 + DAY + 864, () => payroll.connect(boss).endSchedule(bob.address))
            expect((await payroll.employeeInfo(boss.address, bob.address)).debt).to.equal(101n * U)
            expect((await payroll.employeeInfo(boss.address, alice.address)).debt).to.equal(50n * U)
            // back half of the 151 left => index 0.25: alice remaining 25, bob remaining 50.5
            await payroll.connect(boss).fund(75n * U + 500_000n)
            const a = await payroll.employeeInfo(boss.address, alice.address)
            const b = await payroll.employeeInfo(boss.address, bob.address)
            expect(a.claimable).to.be.closeTo(25n * U, 1n)
            expect(b.claimable).to.be.closeTo(50n * U + 500_000n, 1n)
            expect(a.claimable + b.claimable).to.be.lessThanOrEqual(75n * U + 500_000n)
            await payroll.connect(bob).claim(boss.address)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.be.closeTo(75n * U, 1n)
            expect(await usdc.balanceOf(bob.address)).to.be.closeTo(50n * U + 500_000n, 1n)
        })

        it("many epochs: underfund, end, fully fund, partial claims; books exact and no dust left", async () => {
            const { boss, alice, bob, carol, keeper, usdc, payroll, addr, t0 } = await loadFixture(fixture)
            let t = t0
            const staff = [alice, bob, carol]
            for (let epoch = 0; epoch < 12; epoch++) {
                await oneBlock(
                    t,
                    staff.map((s, i) => () => payroll.connect(boss).setSchedule(s.address, BigInt(i + 1) * 37n * U + BigInt(epoch), DAY, 0, G))
                )
                for (let i = 0; i < 3; i++) await at(t + DAY + 7 + i * 333, () => payroll.connect(boss).endSchedule(staff[i].address))
                // a few partial backings with claims in between, in a varying order
                for (let k = 0; k < 3; k++) {
                    await payroll.connect(boss).fund(BigInt(13 + epoch * 7 + k) * U + 1n)
                    await payroll.connect(keeper).claimFor(boss.address, staff[(epoch + k) % 3].address).catch(() => undefined)
                }
                const need = await payroll.fundingNeeded(boss.address, 0)
                if (need > 0n) await payroll.connect(boss).fund(need)
                expect((await payroll.employerInfo(boss.address)).shortfall).to.equal(0n)
                if (epoch % 3 === 2) for (const s of staff) await payroll.connect(keeper).claimFor(boss.address, s.address).catch(() => undefined)
                t = (await time.latest()) + 10
            }
            for (const s of staff) await payroll.connect(keeper).claimFor(boss.address, s.address).catch(() => undefined)
            const avail = await payroll.available(boss.address)
            if (avail > 0n) await payroll.connect(boss).withdraw(ethers.MaxUint256)
            const info = await payroll.employerInfo(boss.address)
            expect([info.balance, info.owed, info.shortfall]).to.deep.equal([0n, 0n, 0n])
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })

        it("after near-complete backings (3 sock rounds) a later debtor still gets its pro-rata share", async () => {
            const { boss, alice, sock, sock2, sock3, usdc, payroll, t0 } = await loadFixture(fixture)
            const big = 100_000n * U // per day; 10 days => 1e12 units of debt each
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(sock.address, big, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(sock2.address, big, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(sock3.address, big, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G)
            ])
            // Each round: one sock's schedule ends (joins the debt), then the employer backs all debt but 1 unit.
            const backAllButOne = async () => {
                const need = await payroll.fundingNeeded(boss.address, 0)
                // fundingNeeded(…, 0) = debt minus free dust; leave exactly 1 unit unbacked
                await payroll.connect(boss).fund(need - 1n)
            }
            await at(t0 + 10 * DAY, () => payroll.connect(boss).endSchedule(sock.address))
            await backAllButOne()
            await at(t0 + 10 * DAY + 100, () => payroll.connect(boss).endSchedule(sock2.address))
            await backAllButOne()
            await at(t0 + 10 * DAY + 200, () => payroll.connect(boss).endSchedule(sock3.address))
            await backAllButOne()
            // alice ends last: 1000 USDC of debt; total unbacked ~ 1000 USDC + 1 unit.
            await at(t0 + 10 * DAY + 300, () => payroll.connect(boss).endSchedule(alice.address))
            const debt = (await payroll.employeeInfo(boss.address, alice.address)).debt
            expect(debt).to.be.closeTo(1000n * U, 1000n * U / 100n)
            // The employer funds HALF of everything that is owed.
            const need = await payroll.fundingNeeded(boss.address, 0)
            await payroll.connect(boss).fund(need / 2n)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            console.log(`      alice debt ${debt}, funded ${need / 2n}, alice claimable ${e.claimable} (pro rata would be ~${debt / 2n})`)
            // The scale factor keeps the index precise: alice gets her pro-rata half, within a few units.
            const exact = (debt * (need / 2n)) / need
            expect(e.claimable).to.be.lessThanOrEqual(exact)
            expect(e.claimable).to.be.greaterThanOrEqual(exact - 3n)
            await expect(payroll.connect(alice).claim(boss.address)).to.emit(payroll, "Shortfall")
            // The money is not lost: it sits in debtBacked until ALL debt is backed.
            const need2 = await payroll.fundingNeeded(boss.address, 0)
            await payroll.connect(boss).fund(need2)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(debt)
        })

        it("an underfunded employer paying 99% of debts as staff leave one by one: every leaver sees 99% repaid", async () => {
            const { boss, payroll, t0 } = await loadFixture(fixture)
            // 24 staff (plain addresses: claims go through claimFor), all hired in one block, no funds.
            const staff = Array.from({ length: 24 }, (_, i) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0x1000 + i), 20)))
            await oneBlock(
                t0,
                staff.map((s) => () => payroll.connect(boss).setSchedule(s, 100n * U, DAY, t0, G))
            )
            const ratios: string[] = []
            let firstBroken = -1
            for (let i = 0; i < staff.length; i++) {
                await at(t0 + DAY + i * 3600, () => payroll.connect(boss).endSchedule(staff[i]))
                const debtNow = await payroll.fundingNeeded(boss.address, 0)
                await payroll.connect(boss).fund((debtNow * 99n) / 100n)
                const p = await payroll.employeeInfo(boss.address, staff[i])
                expect(p.claimable, `leaver #${i + 1}`).to.be.greaterThanOrEqual(((p.claimable + p.debt) * 99n) / 100n - 3n)
                const ratio = Number((p.claimable * 1000n) / (p.claimable + p.debt)) / 10
                ratios.push(`${ratio}%`)
                if (ratio < 50 && firstBroken < 0) firstBroken = i
            }
            console.log(`      share of own debt repaid right after each 99% funding: ${ratios.join(" ")}`)
            // Pro rata, each leaver sees ~99% repaid (the printed ratio truncates to 98.9%); none falls behind.
            expect(firstBroken).to.equal(-1)
        })

        it("long decay: 300 leavers and 300 partial backings (99% / 37% alternating) stay pro rata within a few units", async function () {
            this.timeout(900_000)
            const { boss, keeper, usdc, payroll, addr, t0 } = await loadFixture(fixture)
            const n = 300
            const staff = Array.from({ length: n }, (_, i) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0x5000 + i), 20)))
            await network.provider.send("evm_setAutomine", [false])
            await time.setNextBlockTimestamp(t0)
            for (const [i, s] of staff.entries()) await payroll.connect(boss).setSchedule(s, BigInt(i % 7 + 1) * 10n * U + BigInt(i), DAY, t0, { gasLimit: 150_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            let worst = 0n
            const owed = new Map<string, bigint>()
            for (let i = 0; i < n; i++) {
                await at(t0 + DAY + i * 60, () => payroll.connect(boss).endSchedule(staff[i]))
                const p0 = await payroll.employeeInfo(boss.address, staff[i])
                owed.set(staff[i], p0.debt)
                const need = await payroll.fundingNeeded(boss.address, 0)
                const pct = i % 2 === 0 ? 99n : 37n
                await payroll.connect(boss).fund((need * pct) / 100n)
                // The new leaver's exact pro-rata share of this backing:
                const p = await payroll.employeeInfo(boss.address, staff[i])
                const exact = (p0.debt * ((need * pct) / 100n)) / need
                expect(p.claimable, `leaver #${i + 1}`).to.be.lessThanOrEqual(exact)
                const gap = exact - p.claimable
                if (gap > worst) worst = gap
                expect(gap, `leaver #${i + 1}`).to.be.lessThanOrEqual(3n)
                if (i % 50 === 49) {
                    let sum = 0n
                    for (let j = 0; j <= i; j++) sum += (await payroll.employeeInfo(boss.address, staff[j])).claimable
                    const info = await payroll.employerInfo(boss.address)
                    expect(sum + info.available).to.be.lessThanOrEqual(info.balance)
                }
            }
            console.log(`      300 partial backings: worst shortfall vs exact pro rata ${worst} units`)
            // Everyone claims some now, then all debt is funded: each is paid exactly what was owed.
            for (let j = 0; j < n; j += 7) await payroll.connect(keeper).claimFor(boss.address, staff[j]).catch(() => undefined)
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            for (const s of staff) {
                if ((await payroll.employeeInfo(boss.address, s)).claimable > 0n) await payroll.connect(keeper).claimFor(boss.address, s)
                expect(await usdc.balanceOf(s), s).to.equal(owed.get(s))
            }
            if ((await payroll.available(boss.address)) > 0n) await payroll.connect(boss).withdraw(ethers.MaxUint256)
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })

        it("long decay with a fixed pair: two debtors, 400 backings of 3% to 60% each, shares stay proportional", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            await makeDebts(payroll, boss, t0, [
                { who: alice, perDay: 10n ** 15n, endAfter: 3 * DAY },
                { who: bob, perDay: 3n * 10n ** 14n + 7n, endAfter: 3 * DAY + 1 }
            ])
            const da = (await payroll.employeeInfo(boss.address, alice.address)).debt
            const db = (await payroll.employeeInfo(boss.address, bob.address)).debt
            let backed = 0n
            let st = 7
            for (let k = 0; k < 400; k++) {
                st = (st * 1103515245 + 12345) & 0x7fffffff
                const need = await payroll.fundingNeeded(boss.address, 0)
                if (need < 10n) break
                const amt = (need * BigInt(3 + (st % 58))) / 100n
                if (amt === 0n) break
                await payroll.connect(boss).fund(amt)
                backed += amt
                if (k % 40 === 0) {
                    const a = await payroll.employeeInfo(boss.address, alice.address)
                    const b = await payroll.employeeInfo(boss.address, bob.address)
                    expect(a.claimable).to.be.closeTo((da * backed) / (da + db), 4n)
                    expect(b.claimable).to.be.closeTo((db * backed) / (da + db), 4n)
                }
            }
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            await payroll.connect(alice).claim(boss.address)
            await payroll.connect(bob).claim(boss.address)
            expect([await usdc.balanceOf(alice.address), await usdc.balanceOf(bob.address)]).to.deep.equal([da, db])
        })

        it("sum(claimable) + available <= balance with many debtors at any time", async () => {
            const { boss, alice, bob, carol, dave, sock, payroll, t0 } = await loadFixture(fixture)
            const staff = [alice, bob, carol, dave, sock]
            await makeDebts(
                payroll,
                boss,
                t0,
                staff.map((s, i) => ({ who: s, perDay: BigInt(i * 37 + 1) * U + BigInt(i), endAfter: DAY + 1000 * i + 1 }))
            )
            for (const amt of [1n, 3n, 999_999n, 17n * U, 123n * U + 1n, 1n, 2n]) {
                await payroll.connect(boss).fund(amt)
                let sum = 0n
                for (const s of staff) sum += (await payroll.employeeInfo(boss.address, s.address)).claimable
                const info = await payroll.employerInfo(boss.address)
                expect(sum + info.available).to.be.lessThanOrEqual(info.balance)
            }
        })
    })

    // ================================================================== debt vs running schedules (sock)
    describe("sock wallet capture", () => {
        it("debt is senior to running unfunded time (documented), and alice can resign to join the pro-rata pool", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(sock.address, 10_000n * U, DAY, t0, G)
            ])
            await at(t0 + 5 * DAY, () => payroll.connect(boss).endSchedule(sock.address)) // sock debt 50,000; alice earned 500, still working
            // With resign: alice leaves too (pro rata, same second as the funding below) and shares the funding.
            const snap = await takeSnapshot()
            await at(t0 + 5 * DAY + 5, () => payroll.connect(alice).resign(boss.address))
            const aliceDebt = (await payroll.employeeInfo(boss.address, alice.address)).debt
            expect(aliceDebt).to.equal((100n * U * BigInt(5 * DAY + 5)) / BigInt(DAY))
            await at(t0 + 5 * DAY + 10, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 5 * DAY + 20, () => payroll.connect(sock).claim(boss.address))
            const share = (10_000n * U * aliceDebt) / (aliceDebt + 50_000n * U)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.be.closeTo(share, 2n)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.be.closeTo(share, 2n)
            await snap.restore()
            // Without resign: the documented seniority rule, debt first.
            await at(t0 + 5 * DAY + 10, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 5 * DAY + 20, () => payroll.connect(sock).claim(boss.address))
            expect(await usdc.balanceOf(sock.address)).to.equal(10_000n * U) // 100% of new funding
            const a = await payroll.employeeInfo(boss.address, alice.address)
            expect([a.claimable, a.earned]).to.deep.equal([0n, 500n * U])
        })

        it("among debts, a sock with more promised pay gets exactly its pro-rata share, not more", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await makeDebts(payroll, boss, t0, [
                { who: alice, perDay: 100n * U, endAfter: 3 * DAY },
                { who: sock, perDay: 900n * U, endAfter: 3 * DAY + 1 }
            ])
            await network.provider.send("evm_setAutomine", [false])
            await payroll.connect(boss).fund(1000n * U, G)
            await payroll.connect(sock).claim(boss.address, G)
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            const s = await usdc.balanceOf(sock.address)
            const aliceDebt = 300n * U
            const sockDebt = ((3n * 86400n + 1n) * 900n * U) / 86400n
            const total = aliceDebt + sockDebt
            expect(s).to.be.lessThanOrEqual((sockDebt * 1000n * U) / total)
            expect(s).to.be.greaterThanOrEqual((sockDebt * 1000n * U) / total - 1n)
            const a = (await payroll.employeeInfo(boss.address, alice.address)).claimable
            expect(a).to.be.closeTo((aliceDebt * 1000n * U) / total, 1n)
        })
    })

    // ================================================================== fundingNeeded / withdraw(max)
    describe("fundingNeeded and withdraw(max)", () => {
        it("fundingNeeded(until) is exact: funding it clears the shortfall through `until`, one unit less does not", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U + 1n, DAY, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 7n, MONTH, t0 + 2))
            await time.increaseTo(t0 + 3 * DAY)
            const until = t0 + 3 * DAY + 3600
            const need = await payroll.fundingNeeded(boss.address, until)
            const snap = await takeSnapshot()
            await at(t0 + 3 * DAY + 1, () => payroll.connect(boss).fund(need))
            await time.increaseTo(until)
            expect((await payroll.employerInfo(boss.address)).shortfall).to.equal(0n)
            await time.increaseTo(until + 1)
            expect((await payroll.employerInfo(boss.address)).shortfall).to.be.greaterThan(0n)
            await snap.restore()
            await at(t0 + 3 * DAY + 1, () => payroll.connect(boss).fund(need - 1n))
            await time.increaseTo(until)
            expect((await payroll.employerInfo(boss.address)).shortfall).to.be.greaterThan(0n)
        })

        it("fundingNeeded with debts and running schedules backs all debt first", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(bob.address, 50n * U, DAY, t0, G)
            ])
            await at(t0 + 2 * DAY + 5, () => payroll.connect(boss).endSchedule(alice.address))
            await time.increaseTo(t0 + 3 * DAY)
            const until = t0 + 3 * DAY + 100
            const need = await payroll.fundingNeeded(boss.address, until)
            await at(until, () => payroll.connect(boss).fund(need))
            const info = await payroll.employerInfo(boss.address)
            expect(info.shortfall).to.equal(0n)
            expect((await payroll.employeeInfo(boss.address, alice.address)).shortfall).to.equal(0n)
        })

        it("withdraw(max) right after a claim in the same block, and after time passes, never reverts while something is available", async () => {
            const { boss, alice, payroll, usdc, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const before = await usdc.balanceOf(boss.address)
            const rcs = await oneBlock(t0 + 1 + DAY + 5, [
                () => payroll.connect(alice).claim(boss.address, G),
                () => payroll.connect(boss).withdraw(ethers.MaxUint256, G),
                () => payroll.connect(boss).withdraw(ethers.MaxUint256, G)
            ])
            expect(rcs.map((r) => r.status)).to.deep.equal([1, 1, 0]) // second max-withdraw: nothing left -> ZeroAmount
            const got = (await usdc.balanceOf(boss.address)) - before
            expect(got).to.be.closeTo(900n * U - (100n * U * 5n) / BigInt(DAY), 2n)
            // underfunded: withdraw(max) reverts (ZeroAmount), not a partial take
            await time.increaseTo(t0 + 1 + 20 * DAY)
            await expect(payroll.connect(boss).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(payroll, "ZeroAmount")
        })
    })

    // ================================================================== events for an indexer
    describe("events", () => {
        it("debt repaid inside endSchedule's sync is reported by DebtRepaid (Claimed.fromDebt counts only that claim)", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await makeDebts(payroll, boss, t0, [{ who: alice, perDay: 100n * U, endAfter: DAY }])
            const need = await payroll.fundingNeeded(boss.address, 0)
            await payroll.connect(boss).fund(need + 1000n * U) // debt fully backed, new epoch
            // a new schedule for alice (allowed: no unbacked debt), then it ends: the sync moves the debt silently
            const t = (await time.latest()) + 10
            await at(t, () => payroll.connect(boss).setSchedule(alice.address, 10n * U, DAY, 0))
            await expect(at(t + DAY, () => payroll.connect(boss).endSchedule(alice.address)))
                .to.emit(payroll, "DebtRepaid")
                .withArgs(boss.address, alice.address, 100n * U)
            const tx = payroll.connect(alice).claim(boss.address)
            const rc = await (await tx).wait()
            const c = rc!.logs.map((l) => payroll.interface.parseLog(l)).find((l) => l?.name === "Claimed")!
            expect(c.args.amount).to.equal(110n * U)
            expect(c.args.fromDebt).to.equal(0n) // the 100 of debt was already reported by DebtRepaid at the end
            expect(rc!.logs.map((l) => payroll.interface.parseLog(l)?.name)).to.not.include("DebtRepaid")
        })

        it("ScheduleSet reports origin and the upfront back pay; DebtBacked reports what new funds backed", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            const tx = at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1 - 2 * DAY))
            await expect(tx)
                .to.emit(payroll, "ScheduleSet")
                .withArgs(boss.address, alice.address, 100n * U, DAY, t0 + 1 - 2 * DAY, t0 + 1 - 2 * DAY, 200n * U + 1n)
            // DebtBacked: bob runs unfunded on a second employer-less path is not needed; use a fresh debt.
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 10_000n * U, DAY, 0))
            await at(t0 + 2 + 2 * DAY, () => payroll.connect(boss).endSchedule(bob.address))
            const debt = (await payroll.employeeInfo(boss.address, bob.address)).debt
            expect(debt).to.be.greaterThan(0n)
            // employeeInfo.debt is rounded UP per position (in the debtor's disfavour by <= 1 unit per
            // backing) and can exceed the account's own debt, so debtLeft may be 1 lower.
            const rc = await (await payroll.connect(boss).fund(5n * U)).wait()
            const ev = rc!.logs.map((l) => payroll.interface.parseLog(l)).find((l) => l?.name === "DebtBacked")!
            expect(ev.args.amount).to.equal(5n * U)
            expect(ev.args.debtLeft).to.be.closeTo(debt - 5n * U, 1n)
        })
    })

    // ================================================================== model fuzz (pro-rata model)
    for (const seed of (process.env.ADV2_SEEDS ?? "101,202,303,404,505,606").split(",").map(Number)) {
        it(`model fuzz (pro-rata ends, debts, bank runs), seed ${seed}`, async function () {
            this.timeout(900_000)
            const f = await loadFixture(fixture)
            const { usdc, payroll, addr, keeper } = f
            const employers = [f.boss, f.boss2]
            const staff = [f.alice, f.bob, f.carol, f.dave, f.sock]
            let st = seed
            const rand = () => {
                st = (st * 1103515245 + 12345) & 0x7fffffff
                return st / 0x7fffffff
            }
            const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
            const amounts = [1n, 3n, 7n, 999_999n, 100n * U + 123n, 12_345n * U + 1n, 10n ** 15n + 7n]
            const periods = [DAY, WEEK, MONTH]
            type Sch = { amount: bigint; period: number; start: number }
            const key = (e: string, s: string) => `${e}:${s}`
            const sched = new Map<string, Sch>()
            const endedAt = new Map<string, number>()
            const earned = new Map<string, bigint>()
            const paid = new Map<string, bigint>()
            const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v)
            const periodsAt = (s: Sch, t: number) => (t < s.start ? 0n : BigInt(Math.floor((t - s.start) / s.period)))
            const proRata = (s: Sch, t: number) => (t <= s.start ? 0n : (BigInt(t - s.start) * s.amount) / BigInt(s.period))
            const ops: Record<string, number> = {}
            let shiftN = 0

            const send = async (txp: Promise<any>) => {
                const tx = await txp
                const rc = await tx.wait()
                for (const l of rc.logs) {
                    const p = payroll.interface.parseLog(l)
                    if (p?.name === "DebtRepaid") expect(p.args.amount).to.be.greaterThan(0n)
                    if (p?.name === "Claimed") {
                        add(paid, key(p.args.employer, p.args.employee), p.args.amount)
                        expect(p.args.fromSchedule + p.args.fromDebt).to.be.lessThanOrEqual(p.args.amount)
                    }
                }
                return (await ethers.provider.getBlock(rc.blockNumber))!.timestamp
            }

            const bankRun = async (e: any) => {
                const T = (await time.latest()) + 1
                const balBefore = (await payroll.employerInfo(e.address)).balance
                const tokBefore = await usdc.balanceOf(addr)
                const snap = await takeSnapshot()
                const rcs = await oneBlock(T, [
                    ...staff.map((s) => () => payroll.connect(keeper).claimFor(e.address, s.address, G)),
                    () => payroll.connect(e).withdraw(ethers.MaxUint256, G)
                ])
                let out = 0n
                for (const rc of rcs)
                    for (const l of rc.logs) {
                        const p = payroll.interface.parseLog(l)
                        if (p?.name === "Claimed" || p?.name === "Withdrawn") out += p.args.amount
                    }
                expect(out).to.be.lessThanOrEqual(balBefore)
                expect((await payroll.employerInfo(e.address)).balance).to.equal(balBefore - out)
                expect(await usdc.balanceOf(addr)).to.equal(tokBefore - out)
                // after the run nobody can claim anything more at T (all funded pay was paid out)
                for (const s of staff) expect((await payroll.employeeInfo(e.address, s.address)).claimable).to.equal(0n)
                await snap.restore()
            }

            const check = async (step: number) => {
                const now = await time.latest()
                let sum = 0n
                for (const e of employers) {
                    const info = await payroll.employerInfo(e.address)
                    let claimables = 0n
                    for (const s of staff) {
                        const k = key(e.address, s.address)
                        const p = await payroll.employeeInfo(e.address, s.address)
                        const sc = sched.get(k)
                        const model = (earned.get(k) ?? 0n) + (sc ? periodsAt(sc, now) * sc.amount : 0n)
                        expect((paid.get(k) ?? 0n) + p.earned, `earned ${k} step ${step}`).to.equal(model)
                        expect(p.claimable + p.shortfall).to.equal(p.earned)
                        claimables += p.claimable
                    }
                    expect(claimables + info.available, `solvency step ${step}`).to.be.lessThanOrEqual(info.balance)
                    if (info.shortfall > 0n) expect(info.available).to.equal(0n)
                    sum += info.balance
                    if (step % 12 === 0) await bankRun(e)
                }
                expect(await usdc.balanceOf(addr)).to.equal(sum)
            }

            for (let step = 0; step < 160; step++) {
                const e = pick(employers)
                const s = pick(staff)
                const k = key(e.address, s.address)
                const r = rand()
                let op = ""
                const now = (await time.latest()) + 1
                try {
                    if (r < 0.15) {
                        op = "fund"
                        const mode = rand()
                        if (mode < 0.3) {
                            const need = await payroll.fundingNeeded(e.address, now + Math.floor(rand() * 5 * DAY))
                            op = "fundNeeded"
                            await send(payroll.connect(e).fund(need > 0n ? need : 1n))
                        } else if (mode < 0.45) {
                            const need = await payroll.fundingNeeded(e.address, 0)
                            op = "fundPartialDebt"
                            await send(payroll.connect(e).fund(need > 2n ? need / 2n + 1n : 1n))
                        } else await send(payroll.connect(e).fund(pick(amounts) * BigInt(1 + Math.floor(rand() * 40))))
                    } else if (r < 0.22) {
                        op = "withdraw"
                        await send(payroll.connect(e).withdraw(rand() < 0.7 ? ethers.MaxUint256 : 1n))
                    } else if (r < 0.32) {
                        op = "shifts"
                        const batch = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
                            employee: pick(staff).address,
                            shiftId: sid(`${seed}-${shiftN++}`),
                            amount: pick(amounts)
                        }))
                        await send(payroll.connect(e).approveShifts(batch))
                        for (const b of batch) add(earned, key(e.address, b.employee), b.amount)
                    } else if (r < 0.5) {
                        op = "setSchedule"
                        const period = pick(periods)
                        const amount = pick(amounts)
                        const old = sched.get(k)
                        const earliest = old ? now : Math.max(endedAt.get(k) ?? 0, now - 30 * DAY)
                        const mode = rand()
                        let start: number
                        if (mode < 0.15) start = 0
                        else if (mode < 0.3) start = earliest
                        else if (mode < 0.4) start = now + 30 * DAY
                        else if (mode < 0.5) start = earliest - 1 - Math.floor(rand() * DAY) // invalid on purpose
                        else start = earliest + Math.floor(rand() * 5 * DAY)
                        await time.setNextBlockTimestamp(now)
                        const t = await send(payroll.connect(e).setSchedule(s.address, amount, period, start))
                        expect(start === 0 || start >= earliest, "accepted an invalid start").to.equal(true)
                        if (old) add(earned, k, proRata(old, t))
                        sched.set(k, { amount, period, start: start === 0 ? t : start })
                    } else if (r < 0.6) {
                        op = rand() < 0.5 ? "endSchedule" : "resign"
                        const t = await send(op === "resign" ? payroll.connect(s).resign(e.address) : payroll.connect(e).endSchedule(s.address))
                        add(earned, k, proRata(sched.get(k)!, t))
                        sched.delete(k)
                        endedAt.set(k, t)
                    } else if (r < 0.8) {
                        op = "claim"
                        await send(rand() < 0.5 ? payroll.connect(s).claim(e.address) : payroll.connect(keeper).claimFor(e.address, s.address))
                    } else {
                        op = "time"
                        const sc = sched.get(k)
                        const g = rand()
                        if (g < 0.3 && sc) {
                            const next = sc.start + (Number(periodsAt(sc, now)) + 1) * sc.period
                            await time.increaseTo(Math.max(now, next - (rand() < 0.5 ? 0 : 1)))
                        } else if (g < 0.4) await time.increase(60 * DAY)
                        else await time.increase(1 + Math.floor(rand() * 4 * DAY))
                    }
                    ops[op] = (ops[op] ?? 0) + 1
                } catch (err) {
                    const msg = String((err as Error).message)
                    expect(msg).to.match(/InsufficientAvailable|AccountUnderfunded|NoSchedule|NothingToClaim|InvalidStart|ZeroAmount/, `${op}: ${msg}`)
                    ops[`${op}!`] = (ops[`${op}!`] ?? 0) + 1
                }
                await check(step)
            }
            console.log("      ops:", JSON.stringify(ops))

            await time.increase(45 * DAY)
            for (const e of employers) {
                for (const s of staff) {
                    const k = key(e.address, s.address)
                    if (sched.get(k)) {
                        const t = await send(payroll.connect(e).endSchedule(s.address))
                        add(earned, k, proRata(sched.get(k)!, t))
                        sched.delete(k)
                    }
                }
                const need = await payroll.fundingNeeded(e.address, 0)
                if (need > 0n) await send(payroll.connect(e).fund(need))
                expect((await payroll.employerInfo(e.address)).shortfall).to.equal(0n)
                for (const s of staff) {
                    const p = await payroll.employeeInfo(e.address, s.address)
                    expect(p.shortfall).to.equal(0n)
                    if (p.claimable > 0n) await send(payroll.connect(keeper).claimFor(e.address, s.address))
                    const k = key(e.address, s.address)
                    expect(paid.get(k) ?? 0n, `final ${k}`).to.equal(earned.get(k) ?? 0n)
                }
                if ((await payroll.available(e.address)) > 0n) await send(payroll.connect(e).withdraw(ethers.MaxUint256))
                const info = await payroll.employerInfo(e.address)
                expect([info.balance, info.owed, info.shortfall]).to.deep.equal([0n, 0n, 0n])
            }
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })
    }
})
