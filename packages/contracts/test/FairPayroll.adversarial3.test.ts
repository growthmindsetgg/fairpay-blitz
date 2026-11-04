// Adversarial tests for FairPayroll: the debt scale factor, resign(), and DebtRepaid events.
// Written independently of FairPayroll.test.ts.
import { expect } from "chai"
import { ethers, network } from "hardhat"
import { loadFixture, time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers"

const U = 1_000_000n
const DAY = 86_400
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const G = { gasLimit: 600_000 }
const sid = (s: string) => ethers.id(`adv3:${s}`)
const addrN = (i: number) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0x7000 + i), 20))

async function at<T>(t: number, send: () => Promise<T>): Promise<T> {
    await time.setNextBlockTimestamp(t)
    return send()
}

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

describe("FairPayroll (adversarial, part 3)", () => {
    async function fixture() {
        const [boss, boss2, alice, bob, carol, dave, keeper, sock, sock2, sock3, stranger] = await ethers.getSigners()
        const usdc = await ethers.deployContract("MockUSDC")
        const payroll = await ethers.deployContract("FairPayroll", [await usdc.getAddress()])
        const addr = await payroll.getAddress()
        for (const s of [boss, boss2]) {
            await usdc.mint(s.address, 10n ** 40n)
            await usdc.connect(s).approve(addr, ethers.MaxUint256)
        }
        const t0 = (await time.latest()) + 100
        return { boss, boss2, alice, bob, carol, dave, keeper, sock, sock2, sock3, stranger, usdc, payroll, addr, t0 }
    }

    const parse = (payroll: any, rc: any) => rc.logs.map((l: any) => payroll.interface.parseLog(l)).filter((x: any) => x)

    /** Reads Account.debtEpoch / debtScale / debtIndex from storage (_accounts is slot 0: OZ 5.6 namespaces the guard). */
    async function acct(payroll: any, employer: string) {
        const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [employer, 0])))
        const w = async (i: bigint) => BigInt(await ethers.provider.getStorage(await payroll.getAddress(), base + i))
        const w1 = await w(1n)
        const w3 = await w(3n)
        return { epoch: (w1 >> 168n) & ((1n << 64n) - 1n), scale: w1 >> 232n, debt: w3 & ((1n << 128n) - 1n), index: w3 >> 128n }
    }

    // ================================================================== debt index decay
    describe("debt index decay", () => {
        it("3 socks backed to 1 unit each: alice still gets her pro-rata half", async () => {
            const { boss, alice, sock, sock2, sock3, usdc, payroll, t0 } = await loadFixture(fixture)
            const big = 100_000n * U
            await oneBlock(t0, [sock, sock2, sock3].map((s) => () => payroll.connect(boss).setSchedule(s.address, big, DAY, t0, G)).concat([
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G)
            ]))
            let t = t0 + 10 * DAY
            for (const s of [sock, sock2, sock3]) {
                await at(t, () => payroll.connect(boss).endSchedule(s.address))
                await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) - 1n)
                t += 100
            }
            await at(t, () => payroll.connect(boss).endSchedule(alice.address))
            const debt = (await payroll.employeeInfo(boss.address, alice.address)).debt
            const need = await payroll.fundingNeeded(boss.address, 0)
            await payroll.connect(boss).fund(need / 2n)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            const exact = (debt * (need / 2n)) / need
            expect(e.claimable).to.be.lessThanOrEqual(exact + 1n)
            expect(e.claimable).to.be.greaterThanOrEqual(exact - 2n)
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(debt)
        })

        it("24 leavers, 99% funded after each: every leaver sees ~99% repaid", async () => {
            const { boss, payroll, t0 } = await loadFixture(fixture)
            const staff = Array.from({ length: 24 }, (_, i) => addrN(i))
            await oneBlock(t0, staff.map((s) => () => payroll.connect(boss).setSchedule(s, 100n * U, DAY, t0, G)))
            const ratios: number[] = []
            for (let i = 0; i < staff.length; i++) {
                await at(t0 + DAY + i * 3600, () => payroll.connect(boss).endSchedule(staff[i]))
                await payroll.connect(boss).fund(((await payroll.fundingNeeded(boss.address, 0)) * 99n) / 100n)
                const p = await payroll.employeeInfo(boss.address, staff[i])
                ratios.push(Number((p.claimable * 10000n) / (p.claimable + p.debt)) / 100)
            }
            console.log(`      repaid share per leaver: ${ratios.join(" ")}`)
            for (const r of ratios) expect(r).to.be.greaterThan(98.5)
        })
    })

    // ================================================================== exact pro-rata model, 1200 backings
    it("1200 partial backings, 70 debtors joining at different scales, epoch rollovers: never overpaid, never stuck, exact wind-down", async function () {
        this.timeout(900_000)
        const { boss, keeper, usdc, payroll, addr, t0 } = await loadFixture(fixture)
        const N = 70
        const staff = Array.from({ length: N }, (_, i) => addrN(100 + i))
        let st = 0xc0ffee
        const rand = () => {
            st = (st * 1103515245 + 12345) & 0x7fffffff
            return st / 0x7fffffff
        }
        const mags = [1n, 1_000n, 1_000_000n * U, 10n ** 15n, 10n ** 20n]
        await oneBlock(
            t0,
            staff.map((s, i) => () => payroll.connect(boss).setSchedule(s, mags[i % mags.length] + BigInt(i), DAY, t0, { gasLimit: 300_000 }))
        )
        // Exact model: each debtor's remaining debt as a rational with a big fixed denominator.
        const P = 10n ** 80n
        const orig = new Map<string, bigint>()
        const remX = new Map<string, bigint>() // exact remaining * P (floor; error < 1e-80)
        const epochOf = new Map<string, number>()
        const endSettled = new Map<string, bigint>()
        let epoch = 0
        let D = 0n // exact account debt
        let joined = 0
        let scaleSteps = 0
        let rollovers = 0
        const apply = (rc: any) => {
            for (const ev of parse(payroll, rc)) {
                if (ev.name === "ScheduleEnded" && ev.args.debt > 0n) {
                    const who = ev.args.employee
                    expect(orig.has(who)).to.equal(false)
                    orig.set(who, ev.args.debt)
                    endSettled.set(who, ev.args.settled)
                    remX.set(who, ev.args.debt * P)
                    epochOf.set(who, epoch)
                    D += ev.args.debt
                }
                if (ev.name === "DebtBacked") {
                    const x = ev.args.amount
                    expect(ev.args.debtLeft).to.equal(D - x)
                    for (const [w, r] of remX) if (epochOf.get(w) === epoch) remX.set(w, (r * (D - x)) / D)
                    D -= x
                    if (D === 0n) {
                        for (const [w] of remX) if (epochOf.get(w) === epoch) remX.set(w, 0n)
                        epoch++
                        rollovers++
                    }
                }
            }
        }
        const check = async () => {
            let sumClaimable = 0n
            for (const [w, o] of orig) {
                const p = await payroll.employeeInfo(boss.address, w)
                const repaidC = o - p.debt // nothing claimed in this test before the wind-down
                expect(p.settled).to.equal(repaidC + endSettled.get(w)!)
                expect(p.claimable).to.equal(p.settled)
                const exactRepaid = o - (remX.get(w)! + P - 1n) / P // floor of exact repaid
                // never more than the exact pro-rata share ...
                expect(repaidC, `overpaid ${w}`).to.be.lessThanOrEqual(o - remX.get(w)! / P)
                // ... and never stuck: at most a couple of units (or debt/1e17 for huge debts) behind
                expect(repaidC, `stuck ${w}`).to.be.greaterThanOrEqual(exactRepaid - 3n - o / 10n ** 17n)
                sumClaimable += p.claimable
            }
            const info = await payroll.employerInfo(boss.address)
            expect(sumClaimable + info.available).to.be.lessThanOrEqual(info.balance)
            expect(await usdc.balanceOf(addr)).to.equal(info.balance)
        }

        let t = t0 + DAY
        let fundings = 0
        for (let i = 0; i < 9000 && fundings < 1200; i++) {
            if ((D < 4n || i % 60 === 0) && joined < N) {
                t = Math.max(t + 600, (await time.latest()) + 1)
                apply(await (await at(t, () => payroll.connect(boss).endSchedule(staff[joined++]))).wait())
                continue
            }
            if (D === 0n) continue
            const r = rand()
            let x: bigint
            if (r < 0.006) x = D // full: epoch rollover
            else if (r < 0.04) x = D > 3n ? D - 1n - BigInt(Math.floor(rand() * 3)) : 0n // near-full: scale steps
            else if (r < 0.4) x = D > 10n ? 1n + BigInt(Math.floor(rand() * 9)) : 0n // tiny
            else x = D > 2n ? D / BigInt(2 + Math.floor(rand() * 1000)) + 1n : 0n // a fraction
            if (x <= 0n || x > D) continue
            // fund exactly x of debt (free dust is folded in by the contract; the model uses DebtBacked)
            const need = await payroll.fundingNeeded(boss.address, 0)
            const amt = x - (D - need) // need = D - dust, so this backs ~x
            if (amt <= 0n) continue
            const rc = await (await payroll.connect(boss).fund(amt)).wait()
            fundings++
            apply(rc)
            const ac = await acct(payroll, boss.address)
            expect(ac.debt, "storage layout / exact account debt").to.equal(D)
            if (D > 0n) expect(ac.index >= 10n ** 18n && ac.index <= 10n ** 36n, `index ${ac.index}`).to.equal(true)
            if (ac.scale > BigInt(scaleSteps)) scaleSteps = Number(ac.scale)
            if (i % 40 === 0) await check()
        }
        await check()
        expect(fundings).to.be.greaterThanOrEqual(1000)
        console.log(`      fundings ${fundings}, joined ${joined}, max debtScale within an epoch ${scaleSteps}, epoch rollovers ${rollovers}`)
        expect(scaleSteps).to.be.greaterThan(2)
        expect(rollovers).to.be.greaterThan(3)

        // wind down: end the rest, fund everything, every debtor gets exactly its debt
        for (let j = joined; j < N; j++) apply(await (await payroll.connect(boss).endSchedule(staff[j])).wait())
        apply(await (await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) + 1n)).wait())
        expect(D).to.equal(0n)
        for (const [w, o] of orig) {
            await payroll.connect(keeper).claimFor(boss.address, w)
            expect(await usdc.balanceOf(w)).to.equal(o + endSettled.get(w)!)
        }
        await payroll.connect(boss).withdraw(ethers.MaxUint256).catch(() => undefined)
        const info = await payroll.employerInfo(boss.address)
        expect([info.balance, info.owed, info.shortfall]).to.deep.equal([0n, 0n, 0n])
        expect(await usdc.balanceOf(addr)).to.equal(0n)
    })

    // ================================================================== extreme ratios and scale boundaries
    describe("extreme ratios and scale boundaries", () => {
        /** Debt of exactly `perDay * days` for each listed address, all hired at t0, ended in order. */
        async function debts(payroll: any, boss: any, t0: number, list: { who: string; perDay: bigint }[], days = 10) {
            await oneBlock(t0, list.map((x) => () => payroll.connect(boss).setSchedule(x.who, x.perDay, DAY, t0, G)))
            for (let i = 0; i < list.length; i++) await at(t0 + days * DAY + i, () => Promise.resolve(0))
        }

        it("1 unit left of a 1e29 debt, twice (two scale steps at once), then a small debtor joins and is paid pro rata", async () => {
            const { boss, keeper, usdc, payroll, t0 } = await loadFixture(fixture)
            const [s1, s2, small] = [addrN(1), addrN(2), addrN(3)]
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(s1, 10n ** 28n, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(s2, 10n ** 28n, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(small, 100n * U, DAY, t0, G)
            ])
            await at(t0 + 10 * DAY, () => payroll.connect(boss).endSchedule(s1)) // 1e29
            await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) - 1n)
            // s1's remaining should be ~1 unit
            expect((await payroll.employeeInfo(boss.address, s1)).debt).to.be.lessThanOrEqual(2n)
            await payroll.connect(keeper).claimFor(boss.address, s1) // s1 takes ~1e29 out (keeps the held cap low)
            await at(t0 + 10 * DAY + 50, () => payroll.connect(boss).endSchedule(s2)) // 1e29 + a bit
            await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) - 1n)
            const sc = await acct(payroll, boss.address)
            console.log(`      after two 1-unit-left backings: debtScale ${sc.scale}, index ${sc.index}`)
            expect(sc.scale).to.be.greaterThanOrEqual(3n) // the second backing took two steps at once
            await payroll.connect(keeper).claimFor(boss.address, s2)
            // s2 is one or more scales behind its join: held back by at most ceil(debt / 1e18)
            const s2ends = ((10n * 86400n + 50n) * 10n ** 28n) / 86400n
            const held = s2ends - (await usdc.balanceOf(s2))
            console.log(`      s2 held back after its claim: ${held} units of ${s2ends}`)
            expect(held).to.be.lessThanOrEqual(s2ends / 10n ** 18n + 2n)
            await at(t0 + 10 * DAY + 100, () => payroll.connect(boss).endSchedule(small))
            const sd = (await payroll.employeeInfo(boss.address, small)).debt
            const need = await payroll.fundingNeeded(boss.address, 0)
            await payroll.connect(boss).fund(need / 3n)
            const e = await payroll.employeeInfo(boss.address, small)
            const exact = (sd * (need / 3n)) / need
            expect(e.claimable).to.be.lessThanOrEqual(exact + 1n)
            expect(e.claimable).to.be.greaterThanOrEqual(exact - 2n)
            // earlier debtors draw only on what is still theirs: received + claimable never exceeds the debt
            const s1c = (await payroll.employeeInfo(boss.address, s1)).claimable
            const s2c = (await payroll.employeeInfo(boss.address, s2)).claimable
            expect((await usdc.balanceOf(s1)) + s1c).to.be.lessThanOrEqual(10n ** 29n)
            expect((await usdc.balanceOf(s2)) + s2c).to.be.lessThanOrEqual(s2ends)
            const info = await payroll.employerInfo(boss.address)
            expect(s1c + s2c + e.claimable + info.available).to.be.lessThanOrEqual(info.balance)
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            const before = [await usdc.balanceOf(s1), await usdc.balanceOf(s2)]
            for (const s of [s1, s2, small]) await payroll.connect(keeper).claimFor(boss.address, s).catch(() => undefined)
            const ends = [10n ** 29n, ((10n * 86400n + 50n) * 10n ** 28n) / 86400n]
            expect(before[0] + ((await usdc.balanceOf(s1)) - before[0])).to.equal(ends[0])
            expect(await usdc.balanceOf(s2)).to.equal(ends[1])
            expect(await usdc.balanceOf(small)).to.equal(sd)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })

        it("index lands exactly on MIN_INDEX (no rescale), then one below (rescale), then rollover exactly after a scale step", async () => {
            const { boss, keeper, usdc, payroll, t0 } = await loadFixture(fixture)
            const [a, b, c, d] = [addrN(11), addrN(12), addrN(13), addrN(14)]
            // a: debt exactly 1e18 (1e17/day * 10 days); backing leaves 1 => index = 1e36 * 1 / 1e18 = 1e18 = MIN_INDEX
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(a, 10n ** 17n, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(b, 2n * 10n ** 17n, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(c, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(d, 7n * U, DAY, t0, G)
            ])
            await at(t0 + 10 * DAY, () => payroll.connect(boss).endSchedule(a))
            expect((await payroll.employeeInfo(boss.address, a)).debt).to.equal(10n ** 18n)
            await payroll.connect(boss).fund(10n ** 18n - 1n)
            expect((await payroll.employeeInfo(boss.address, a)).debt).to.equal(1n)
            // b joins: debt ~2e18+; leave 1 => index ~ 1e18 * 1/(2e18) < MIN_INDEX => rescale
            await payroll.connect(boss).endSchedule(b)
            const bd = (await payroll.employeeInfo(boss.address, b)).debt
            await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) - 1n)
            // two scale steps in one backing: both are now >= 2 scales behind => bounded by ceil(debt / 1e18)
            const sc = await acct(payroll, boss.address)
            console.log(`      after b's backing: debtScale ${sc.scale}, index ${sc.index}`)
            expect((await payroll.employeeInfo(boss.address, b)).debt).to.equal((bd + 10n ** 18n - 1n) / 10n ** 18n)
            expect((await payroll.employeeInfo(boss.address, a)).debt).to.equal(1n)
            // c joins after the rescale, half backed, then the whole rest backed: rollover right after a scale step
            await payroll.connect(boss).endSchedule(c)
            const cd = (await payroll.employeeInfo(boss.address, c)).debt
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            for (const w of [a, b, c]) expect((await payroll.employeeInfo(boss.address, w)).debt).to.equal(0n)
            // new epoch: d's debt starts fresh at ONE
            await payroll.connect(boss).endSchedule(d)
            const dd = (await payroll.employeeInfo(boss.address, d)).debt
            await payroll.connect(boss).fund(dd / 2n)
            expect((await payroll.employeeInfo(boss.address, d)).claimable).to.be.closeTo(dd / 2n, 1n)
            await payroll.connect(boss).fund(await payroll.fundingNeeded(boss.address, 0))
            for (const w of [a, b, c, d]) await payroll.connect(keeper).claimFor(boss.address, w)
            expect(await usdc.balanceOf(a)).to.equal(10n ** 18n)
            expect(await usdc.balanceOf(b)).to.equal(bd)
            expect(await usdc.balanceOf(c)).to.equal(cd)
            expect(await usdc.balanceOf(d)).to.equal(dd)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
            void debts
        })

        it("claiming between every backing (checkpoints at many scales) never pays more than the debt", async () => {
            const { boss, keeper, usdc, payroll, t0 } = await loadFixture(fixture)
            const ws = Array.from({ length: 6 }, (_, i) => addrN(200 + i))
            await oneBlock(t0, ws.map((w, i) => () => payroll.connect(boss).setSchedule(w, 10n ** BigInt(10 + 3 * i), DAY, t0, G)))
            const owed = new Map<string, bigint>()
            for (let i = 0; i < ws.length; i++) {
                if (i === 0) await time.increaseTo(t0 + 5 * DAY)
                await payroll.connect(boss).endSchedule(ws[i])
                owed.set(ws[i], (await payroll.employeeInfo(boss.address, ws[i])).debt)
                for (let k = 0; k < 4; k++) {
                    const need = await payroll.fundingNeeded(boss.address, 0)
                    if (need < 3n) break
                    await payroll.connect(boss).fund(k % 2 === 0 ? need - 1n : need / 3n)
                    for (const w of ws.slice(0, i + 1)) await payroll.connect(keeper).claimFor(boss.address, w).catch(() => undefined)
                    for (const w of ws.slice(0, i + 1)) expect(await usdc.balanceOf(w)).to.be.lessThanOrEqual(owed.get(w)!)
                }
            }
            await payroll.connect(boss).fund((await payroll.fundingNeeded(boss.address, 0)) + 1n)
            for (const w of ws) await payroll.connect(keeper).claimFor(boss.address, w).catch(() => undefined)
            for (const w of ws) expect(await usdc.balanceOf(w)).to.equal(owed.get(w)!)
            await payroll.connect(boss).withdraw(ethers.MaxUint256).catch(() => undefined)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(0n)
        })
    })

    // ================================================================== resign
    describe("resign", () => {
        it("only the caller's own schedule: a stranger or the employer cannot resign for someone else", async () => {
            const { boss, alice, stranger, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, 0))
            await expect(payroll.connect(stranger).resign(boss.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            await expect(payroll.connect(boss).resign(boss.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            await expect(payroll.connect(alice).resign(stranger.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            expect((await payroll.scheduleOf(boss.address, alice.address)).amountPerPeriod).to.equal(100n * U)
        })

        it("resign when funded = endSchedule (pro rata, reservation back to the employer), with Resigned + ScheduleEnded", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, 0))
            const tx = at(t0 + 1 + 1.5 * DAY, () => payroll.connect(alice).resign(boss.address))
            await expect(tx).to.emit(payroll, "Resigned").withArgs(boss.address, alice.address)
            await expect(tx).to.emit(payroll, "ScheduleEnded").withArgs(boss.address, alice.address, 150n * U, 0n)
            expect(await payroll.available(boss.address)).to.equal(850n * U)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(150n * U)
        })

        it("resign then re-set: endedAt applies; resign twice reverts", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, 0))
            const tr = t0 + 1 + DAY
            await at(tr, () => payroll.connect(alice).resign(boss.address))
            await expect(payroll.connect(alice).resign(boss.address)).to.be.revertedWithCustomError(payroll, "NoSchedule")
            await expect(at(tr + 10, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, tr - 1))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            await at(tr + 20, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, tr))
        })

        it("resign during underfunding joins the debt pool pro rata; resign + claim in one block, both orders", async () => {
            const { boss, alice, bob, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(bob.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(sock.address, 10_000n * U, DAY, t0, G)
            ])
            await at(t0 + 5 * DAY, () => payroll.connect(boss).endSchedule(sock.address)) // sock debt 50,000
            // Without resigning, alice is junior to sock's debt; she resigns to join the pool.
            await at(t0 + 5 * DAY + 1, () => payroll.connect(alice).resign(boss.address))
            const ad = (await payroll.employeeInfo(boss.address, alice.address)).debt
            const sd = (await payroll.employeeInfo(boss.address, sock.address)).debt
            const T = t0 + 5 * DAY + 10
            const snap = await takeSnapshot()
            // order 1: fund, sock claims, alice claims
            await oneBlock(T, [
                () => payroll.connect(boss).fund(10_000n * U, G),
                () => payroll.connect(sock).claim(boss.address, G),
                () => payroll.connect(alice).claim(boss.address, G)
            ])
            const r1 = [await usdc.balanceOf(alice.address), await usdc.balanceOf(sock.address)]
            await snap.restore()
            // order 2: fund, alice claims, sock claims
            await oneBlock(T, [
                () => payroll.connect(boss).fund(10_000n * U, G),
                () => payroll.connect(alice).claim(boss.address, G),
                () => payroll.connect(sock).claim(boss.address, G)
            ])
            const r2 = [await usdc.balanceOf(alice.address), await usdc.balanceOf(sock.address)]
            expect(r2).to.deep.equal(r1)
            expect(r1[0]).to.be.closeTo((ad * 10_000n * U) / (ad + sd), 2n)
            // bob, who did not resign, is still behind both debts
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(0n)
        })

        it("FINDING (info): in an underfunded account, staff who resign first are senior to colleagues still working", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(bob.address, 100n * U, DAY, t0, G)
            ])
            await at(t0 + 5 * DAY, () => payroll.connect(bob).resign(boss.address))
            await at(t0 + 5 * DAY + 10, () => payroll.connect(boss).fund(500n * U))
            await payroll.connect(bob).claim(boss.address)
            expect(await usdc.balanceOf(bob.address)).to.equal(500n * U)
            const a = await payroll.employeeInfo(boss.address, alice.address)
            expect([a.claimable, a.earned]).to.deep.equal([0n, 500n * U])
        })

        it("a sock resigning has no power beyond the employer ending it: exact pro-rata share only", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await oneBlock(t0, [
                () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, G),
                () => payroll.connect(boss).setSchedule(sock.address, 900n * U, DAY, t0, G)
            ])
            await at(t0 + 3 * DAY, () => payroll.connect(alice).resign(boss.address))
            await at(t0 + 3 * DAY + 1, () => payroll.connect(sock).resign(boss.address))
            const ad = 300n * U
            const sd = ((3n * 86400n + 1n) * 900n * U) / 86400n
            await oneBlock(t0 + 3 * DAY + 5, [
                () => payroll.connect(boss).fund(1000n * U, G),
                () => payroll.connect(sock).claim(boss.address, G)
            ])
            const s = await usdc.balanceOf(sock.address)
            expect(s).to.be.lessThanOrEqual((sd * 1000n * U) / (ad + sd))
            expect(s).to.be.greaterThanOrEqual((sd * 1000n * U) / (ad + sd) - 2n)
        })
    })

    // ================================================================== model fuzz with resign + event reconciliation
    for (const seed of (process.env.ADV3_SEEDS ?? "7001,7002,7003,7004,7005,7006").split(",").map(Number)) {
        it(`model fuzz with resign and event reconciliation, seed ${seed}`, async function () {
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
            const amounts = [1n, 3n, 999_999n, 100n * U + 123n, 12_345n * U + 1n, 10n ** 15n + 7n, 10n ** 20n + 3n]
            const periods = [DAY, WEEK, MONTH]
            type Sch = { amount: bigint; period: number; start: number }
            const key = (e: string, s: string) => `${e}:${s}`
            const sched = new Map<string, Sch>()
            const endedAt = new Map<string, number>()
            const earned = new Map<string, bigint>()
            const paid = new Map<string, bigint>()
            // indexer view built only from events
            const ix = {
                intoSettled: new Map<string, bigint>(), // shifts + ScheduleEnded.settled + DebtRepaid
                fromSchedule: new Map<string, bigint>(),
                debtAdded: new Map<string, bigint>(), // per employee: ScheduleEnded.debt
                debtRepaid: new Map<string, bigint>(),
                backed: new Map<string, bigint>(), // per employer: DebtBacked
                acctDebtAdded: new Map<string, bigint>(),
                repaidByEmployer: new Map<string, bigint>()
            }
            const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v)
            const periodsAt = (s: Sch, t: number) => (t < s.start ? 0n : BigInt(Math.floor((t - s.start) / s.period)))
            const proRata = (s: Sch, t: number) => (t <= s.start ? 0n : (BigInt(t - s.start) * s.amount) / BigInt(s.period))
            const ops: Record<string, number> = {}
            let shiftN = 0

            const send = async (txp: Promise<any>) => {
                const rc = await (await txp).wait()
                for (const ev of parse(payroll, rc)) {
                    const a = ev.args
                    if (ev.name === "Claimed") {
                        add(paid, key(a.employer, a.employee), a.amount)
                        add(ix.fromSchedule, key(a.employer, a.employee), a.fromSchedule)
                    } else if (ev.name === "ShiftApproved") add(ix.intoSettled, key(a.employer, a.employee), a.amount)
                    else if (ev.name === "ScheduleEnded") {
                        add(ix.intoSettled, key(a.employer, a.employee), a.settled)
                        add(ix.debtAdded, key(a.employer, a.employee), a.debt)
                        add(ix.acctDebtAdded, a.employer, a.debt)
                    } else if (ev.name === "DebtRepaid") {
                        add(ix.intoSettled, key(a.employer, a.employee), a.amount)
                        add(ix.debtRepaid, key(a.employer, a.employee), a.amount)
                        add(ix.repaidByEmployer, a.employer, a.amount)
                    } else if (ev.name === "DebtBacked") {
                        add(ix.backed, a.employer, a.amount)
                        expect(a.debtLeft).to.equal((ix.acctDebtAdded.get(a.employer) ?? 0n) - (ix.backed.get(a.employer) ?? 0n))
                    }
                }
                return (await ethers.provider.getBlock(rc.blockNumber))!.timestamp
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
                        claimables += p.claimable
                        // indexer: settled from events <= view settled (view also counts un-emitted shares)
                        const ixSettled = (ix.intoSettled.get(k) ?? 0n) - ((paid.get(k) ?? 0n) - (ix.fromSchedule.get(k) ?? 0n))
                        expect(ixSettled >= 0n && ixSettled <= p.settled, `ix settled ${k}`).to.equal(true)
                        // indexer debt (added - repaid) >= view debt, and the gap is backed-but-unsynced share
                        const ixDebt = (ix.debtAdded.get(k) ?? 0n) - (ix.debtRepaid.get(k) ?? 0n)
                        expect(ixDebt - p.debt, `ix debt ${k}`).to.equal(p.settled - ixSettled)
                    }
                    expect(claimables + info.available, `solvency ${step}`).to.be.lessThanOrEqual(info.balance)
                    // account debt from events is exact
                    const acctDebt = (ix.acctDebtAdded.get(e.address) ?? 0n) - (ix.backed.get(e.address) ?? 0n)
                    expect(info.shortfall).to.be.greaterThanOrEqual(acctDebt)
                    expect((ix.backed.get(e.address) ?? 0n) - (ix.repaidByEmployer.get(e.address) ?? 0n)).to.be.greaterThanOrEqual(0n)
                    sum += info.balance
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
                    if (r < 0.16) {
                        const mode = rand()
                        if (mode < 0.3) {
                            op = "fundNeeded"
                            const need = await payroll.fundingNeeded(e.address, now + Math.floor(rand() * 5 * DAY))
                            await send(payroll.connect(e).fund(need > 0n ? need : 1n))
                        } else if (mode < 0.6) {
                            op = "fundNearFull"
                            const need = await payroll.fundingNeeded(e.address, 0)
                            await send(payroll.connect(e).fund(need > 2n ? need - 1n - BigInt(Math.floor(rand() * 2)) : 1n))
                        } else {
                            op = "fund"
                            await send(payroll.connect(e).fund(pick(amounts) * BigInt(1 + Math.floor(rand() * 40))))
                        }
                    } else if (r < 0.22) {
                        op = "withdraw"
                        await send(payroll.connect(e).withdraw(ethers.MaxUint256))
                    } else if (r < 0.3) {
                        op = "shifts"
                        const batch = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({
                            employee: pick(staff).address,
                            shiftId: sid(`${seed}-${shiftN++}`),
                            amount: pick(amounts)
                        }))
                        await send(payroll.connect(e).approveShifts(batch))
                        for (const b of batch) add(earned, key(e.address, b.employee), b.amount)
                    } else if (r < 0.48) {
                        op = "setSchedule"
                        const old = sched.get(k)
                        const earliest = old ? now : Math.max(endedAt.get(k) ?? 0, now - 30 * DAY)
                        const start = rand() < 0.3 ? 0 : earliest + Math.floor(rand() * 3 * DAY)
                        await time.setNextBlockTimestamp(now)
                        const t = await send(payroll.connect(e).setSchedule(s.address, pick(amounts), pick(periods), start))
                        if (old) add(earned, k, proRata(old, t))
                        sched.set(k, { amount: (await payroll.scheduleOf(e.address, s.address)).amountPerPeriod, period: Number((await payroll.scheduleOf(e.address, s.address)).period), start: start === 0 ? t : start })
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
                        const g = rand()
                        if (g < 0.15) await time.increase(60 * DAY)
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
                for (const s of staff) {
                    const k = key(e.address, s.address)
                    if ((await payroll.employeeInfo(e.address, s.address)).claimable > 0n) await send(payroll.connect(keeper).claimFor(e.address, s.address))
                    expect(paid.get(k) ?? 0n, `final ${k}`).to.equal(earned.get(k) ?? 0n)
                    // indexer reconciles exactly after the wind-down
                    expect((ix.debtAdded.get(k) ?? 0n) - (ix.debtRepaid.get(k) ?? 0n), `final ix debt ${k}`).to.equal(0n)
                    expect(ix.intoSettled.get(k) ?? 0n).to.equal((paid.get(k) ?? 0n) - (ix.fromSchedule.get(k) ?? 0n))
                }
                expect(ix.backed.get(e.address) ?? 0n).to.equal(ix.repaidByEmployer.get(e.address) ?? 0n)
                if ((await payroll.available(e.address)) > 0n) await send(payroll.connect(e).withdraw(ethers.MaxUint256))
                const info = await payroll.employerInfo(e.address)
                expect([info.balance, info.owed, info.shortfall]).to.deep.equal([0n, 0n, 0n])
            }
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })
    }
})
