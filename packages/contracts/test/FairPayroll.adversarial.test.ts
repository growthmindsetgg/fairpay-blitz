// Adversarial tests for FairPayroll.
// Each `describe` targets one claim of the contract and tries to break it.
import { expect } from "chai"
import { ethers, network } from "hardhat"
import { loadFixture, time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers"

const U = 1_000_000n
const DAY = 86_400
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const SCALE = 1_000_000_000n
const sid = (s: string) => ethers.id(`adv:${s}`)

async function at<T>(t: number, send: () => Promise<T>): Promise<T> {
    await time.setNextBlockTimestamp(t)
    return send()
}

describe("FairPayroll (adversarial)", () => {
    async function fixture() {
        const signers = await ethers.getSigners()
        const [boss, boss2, alice, bob, carol, dave, keeper, sock] = signers
        const usdc = await ethers.deployContract("MockUSDC")
        const payroll = await ethers.deployContract("FairPayroll", [await usdc.getAddress()])
        const addr = await payroll.getAddress()
        for (const s of [boss, boss2]) {
            await usdc.mint(s.address, 10n ** 30n)
            await usdc.connect(s).approve(addr, ethers.MaxUint256)
        }
        const t0 = (await time.latest()) + 100
        return { boss, boss2, alice, bob, carol, dave, keeper, sock, usdc, payroll, addr, t0 }
    }

    // ------------------------------------------------------------------ model-based fuzz
    // Keeps an exact off-chain model of what each (employer, employee) has earned (completed periods
    // of every schedule version + approved shifts) and checks after every step that
    //   paid so far + employeeInfo.earned == model earned  (no double counting, nothing lost)
    //     (an end or change settles the period in progress pro rata, a change can never start in the
    //      past, a new schedule never before the previous one ended)
    //   sum(claimable) + available <= balance              (everyone can be paid at once)
    //   token.balanceOf(payroll) == sum(balance)           (every token belongs to one escrow)
    // and, at the end, that after funding the shortfall every employee received exactly the model.
    for (const seed of (process.env.ADV_SEEDS ?? "1,2,3,48879,24301").split(",").map(Number)) {
        it(`model fuzz, seed ${seed}`, async function () {
            this.timeout(600_000)
            const f = await loadFixture(fixture)
            const { usdc, payroll, addr, keeper } = f
            const employers = [f.boss, f.boss2]
            const staff = [f.alice, f.bob, f.carol, f.dave]
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
            const earned = new Map<string, bigint>()
            const paid = new Map<string, bigint>()
            const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v)
            const periodsAt = (s: Sch, t: number) => (t < s.start ? 0n : BigInt(Math.floor((t - s.start) / s.period)))
            // What an end or change settles: completed periods plus the period in progress pro rata.
            const proRata = (s: Sch, t: number) => (t <= s.start ? 0n : (BigInt(t - s.start) * s.amount) / BigInt(s.period))
            const lastEnd = new Map<string, number>()
            let invalidStarts = 0
            let shiftN = 0
            let step = 0
            const ops: Record<string, number> = {}

            const send = async (txp: Promise<any>) => {
                const tx = await txp
                const rc = await tx.wait()
                const blk = await ethers.provider.getBlock(rc.blockNumber)
                for (const l of rc.logs) {
                    const p = payroll.interface.parseLog(l)
                    if (p?.name === "Claimed") add(paid, key(p.args.employer, p.args.employee), p.args.amount)
                }
                return blk!.timestamp
            }

            const check = async () => {
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
                        expect((paid.get(k) ?? 0n) + p.earned, `earned ${k}`).to.equal(model)
                        expect(p.claimable + p.shortfall).to.equal(p.earned)
                        claimables += p.claimable
                    }
                    // Debt is shown pro rata, so this always holds.
                    expect(claimables + info.available, "sum(claimable) + available <= balance").to.be.lessThanOrEqual(info.balance)
                    if (step % 10 === 0) await bankRun(payroll, usdc, addr, e, staff, keeper)
                    if (info.shortfall > 0n) expect(info.available).to.equal(0n)
                    sum += info.balance
                }
                expect(await usdc.balanceOf(addr)).to.equal(sum)
            }

            for (step = 0; step < 150; step++) {
                const e = pick(employers)
                const s = pick(staff)
                const k = key(e.address, s.address)
                const r = rand()
                let op = ""
                const now = (await time.latest()) + 1
                try {
                    if (r < 0.14) {
                        op = "fund"
                        await send(payroll.connect(e).fund(pick(amounts) * BigInt(1 + Math.floor(rand() * 40))))
                    } else if (r < 0.22) {
                        op = "withdraw"
                        const avail = await payroll.available(e.address)
                        if (avail > 0n) await send(payroll.connect(e).withdraw(rand() < 0.5 ? avail : avail / 2n + 1n))
                    } else if (r < 0.34) {
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
                        const mode = rand()
                        // Exact boundaries included: start = now ± MAX_START_OFFSET, now, the old period start.
                        let start = now + Math.floor((rand() - 0.6) * 10 * DAY)
                        if (mode < 0.1) start = now - 30 * DAY
                        else if (mode < 0.2) start = now + 30 * DAY
                        else if (mode < 0.3) start = now
                        else if (mode < 0.37) start = 0 // "now"
                        else if (mode < 0.45 && sched.get(k)) {
                            const old = sched.get(k)!
                            start = now < old.start ? old.start : old.start + Number(periodsAt(old, now)) * old.period
                            if (start < now - 30 * DAY) start = now
                        } else if (mode < 0.5 && lastEnd.get(k)) start = lastEnd.get(k)! - (rand() < 0.5 ? 0 : 1)
                        const begin = start === 0 ? now : start
                        const earliest = sched.get(k) ? now : Math.max(lastEnd.get(k) ?? 0, now - 30 * DAY)
                        const invalid = begin < earliest || begin > now + 30 * DAY
                        await time.setNextBlockTimestamp(now)
                        try {
                            const t = await send(payroll.connect(e).setSchedule(s.address, amount, period, start))
                            expect(invalid, `start ${start} accepted at ${now}`).to.equal(false)
                            const old = sched.get(k)
                            if (old) add(earned, k, proRata(old, t))
                            sched.set(k, { amount, period, start: begin })
                        } catch (err) {
                            if (String((err as Error).message).includes("InvalidStart")) {
                                expect(invalid, `start ${start} rejected at ${now}`).to.equal(true)
                                invalidStarts++
                            } else throw err
                        }
                    } else if (r < 0.58) {
                        op = "endSchedule"
                        const t = await send(payroll.connect(e).endSchedule(s.address))
                        const old = sched.get(k)!
                        add(earned, k, proRata(old, t))
                        sched.delete(k)
                        lastEnd.set(k, t)
                    } else if (r < 0.78) {
                        op = "claim"
                        await send(rand() < 0.5 ? payroll.connect(s).claim(e.address) : payroll.connect(keeper).claimFor(e.address, s.address))
                    } else {
                        op = "time"
                        const sc = sched.get(k)
                        const g = rand()
                        if (g < 0.3 && sc) {
                            // land exactly on, or one second before, a period boundary
                            const next = sc.start + (Number(periodsAt(sc, now)) + 1) * sc.period
                            await time.increaseTo(Math.max(now, next - (rand() < 0.5 ? 0 : 1)))
                        } else if (g < 0.4) await time.increase(100 * DAY)
                        else await time.increase(1 + Math.floor(rand() * 4 * DAY))
                    }
                    ops[op] = (ops[op] ?? 0) + 1
                } catch (err) {
                    const msg = String((err as Error).message)
                    expect(msg).to.match(/InsufficientAvailable|AccountUnderfunded|NoSchedule|NothingToClaim/, `${op}: ${msg}`)
                    ops[`${op}!`] = (ops[`${op}!`] ?? 0) + 1
                }
                await check()
            }
            console.log("      ops:", JSON.stringify(ops), "rejected starts:", invalidStarts)

            // Wind down and compare every employee's total pay with the model, exactly.
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
                const short = (await payroll.employerInfo(e.address)).shortfall
                if (short > 0n) await send(payroll.connect(e).fund(short))
                for (const s of staff) {
                    const p = await payroll.employeeInfo(e.address, s.address)
                    if (p.claimable > 0n) await send(payroll.connect(keeper).claimFor(e.address, s.address))
                    const k = key(e.address, s.address)
                    expect(paid.get(k) ?? 0n, `final ${k}`).to.equal(earned.get(k) ?? 0n)
                }
                const avail = await payroll.available(e.address)
                if (avail > 0n) await send(payroll.connect(e).withdraw(avail))
                const info = await payroll.employerInfo(e.address)
                expect([info.balance, info.owed, info.shortfall]).to.deep.equal([0n, 0n, 0n])
            }
            expect(await usdc.balanceOf(addr)).to.equal(0n)
        })
    }

    // ------------------------------------------------------------------ solvency under a "bank run"
    it("every employee and the employer can all be paid at once at any moment (bank run)", async () => {
        const { boss, alice, bob, carol, keeper, usdc, payroll, addr, t0 } = await loadFixture(fixture)
        await at(t0, () => payroll.connect(boss).fund(1000n * U + 1n))
        await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U + 1n, DAY, t0 - 2 * DAY))
        await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 333n * U, WEEK, t0 + 3 * DAY))
        await at(t0 + 3, () => payroll.connect(boss).setSchedule(carol.address, 7n, MONTH, t0 + 3))
        await at(t0 + 4, () => payroll.connect(boss).approveShifts([{ employee: carol.address, shiftId: sid("c"), amount: 5n * U }]))
        for (const dt of [DAY, 3 * DAY, 9 * DAY, 31 * DAY, 200 * DAY]) {
            await time.increaseTo(t0 + dt)
            await bankRun(payroll, usdc, addr, boss, [alice, bob, carol], keeper)
        }
    })

    // All claims and then withdraw(available) in ONE block, so no reservation time passes in between.
    // Proves at this moment: every employee can take their claimable, and the employer its available,
    // simultaneously; afterwards the contract still holds exactly the employers' balances.
    async function bankRun(payroll: any, usdc: any, addr: string, boss: any, staff: any[], keeper: any) {
        const T = (await time.latest()) + 1
        const balanceBefore = (await payroll.employerInfo(boss.address)).balance
        const tokenBefore: bigint = await usdc.balanceOf(addr)
        const bal = async () => Promise.all(staff.map((s) => usdc.balanceOf(s.address) as Promise<bigint>))
        const start = await bal()
        const runBlock = async (withdrawAmt: bigint) => {
            await time.setNextBlockTimestamp(T)
            await network.provider.send("evm_setAutomine", [false])
            try {
                for (const s of staff) await payroll.connect(keeper).claimFor(boss.address, s.address, { gasLimit: 400_000 })
                if (withdrawAmt > 0n) await payroll.connect(boss).withdraw(withdrawAmt, { gasLimit: 400_000 })
                await network.provider.send("evm_mine")
            } finally {
                await network.provider.send("evm_setAutomine", [true])
            }
            const blk = await ethers.provider.getBlock("latest")
            for (const h of blk!.transactions) {
                const rc = (await ethers.provider.getTransactionReceipt(h))!
                if (rc.from === boss.address) expect(rc.status, "withdraw(available) in a bank run").to.equal(1)
            }
            return (await bal()).map((b, i) => b - start[i])
        }
        // Pass 1: claims only, to learn `available` at T after them.
        const snap = await takeSnapshot()
        const paid1 = await runBlock(0n)
        const avail = await payroll.available(boss.address)
        await snap.restore()
        // Pass 2: the same claims plus withdraw(available), in one block at T. Staff get the same.
        const snap2 = await takeSnapshot()
        const paid2 = await runBlock(avail)
        expect(paid2).to.deep.equal(paid1)
        const out = paid1.reduce((a, b) => a + b, 0n) + avail
        expect(out).to.be.lessThanOrEqual(balanceBefore)
        expect((await payroll.employerInfo(boss.address)).balance).to.equal(balanceBefore - out)
        expect(await usdc.balanceOf(addr)).to.equal(tokenBefore - out)
        await snap2.restore()
    }

    // ------------------------------------------------------------------ employer theft attempts
    describe("employer tries to take earned pay", () => {
        it("second wallet with a huge, back-dated or future schedule cannot touch what alice already earned", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const t5 = t0 + 1 + 5 * DAY
            // Back-dated huge schedule: needs free funds for the back pay, so it fails...
            await expect(at(t5, () => payroll.connect(boss).setSchedule(sock.address, 10n ** 12n * U, DAY, t5 - DAY))).to.be.revertedWithCustomError(
                payroll,
                "InsufficientAvailable"
            )
            // ... a future-start huge schedule reserves ahead and starves alice's FUTURE pay only.
            await at(t5 + 1, () => payroll.connect(boss).setSchedule(sock.address, 10n ** 12n * U, DAY, t5 + 10 * DAY))
            await time.increaseTo(t5 + 20 * DAY)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect(e.claimable).to.be.greaterThanOrEqual(500n * U)
            // The employer ends its sock schedule: whatever it pre-reserved returns to free and is
            // used for alice's unreserved time first, not to the employer.
            await payroll.connect(boss).endSchedule(sock.address)
            expect(await usdc.balanceOf(sock.address)).to.equal(0n)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.be.greaterThanOrEqual(500n * U)
        })

        it("ending a schedule at the last second of a period pays the time worked pro rata", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(3000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 3000n * U, MONTH, t0 + 1))
            // 29 days 23:59:58 worked. While the schedule runs, the money is locked...
            const last = t0 + 1 + MONTH - 1
            await time.increaseTo(last - 10)
            expect(await payroll.available(boss.address)).to.be.lessThan(2n * U)
            // ...and ending it no longer hands the month back: the time worked is settled pro rata.
            const worked = (3000n * U * BigInt(MONTH - 2)) / BigInt(MONTH)
            await expect(at(last - 1, () => payroll.connect(boss).endSchedule(alice.address)))
                .to.emit(payroll, "ScheduleEnded")
                .withArgs(boss.address, alice.address, worked, 0n)
            await expect(at(last, () => payroll.connect(boss).withdraw(3000n * U))).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            expect(await payroll.available(boss.address)).to.equal(3000n * U - worked)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.earned, e.claimable]).to.deep.equal([worked, worked])
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(worked)
        })

        it("a change cannot keep the old start, so it cannot re-price the period in progress", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(3000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 3000n * U, MONTH, t0 + 1))
            await time.increaseTo(t0 + 1 + 29 * DAY - 5)
            await expect(payroll.connect(boss).setSchedule(alice.address, 1n, MONTH, t0 + 1)).to.be.revertedWithCustomError(payroll, "InvalidStart")
            // The change (start 0 = now) settles the 29 days at the old rate first.
            await expect(at(t0 + 1 + 29 * DAY, () => payroll.connect(boss).setSchedule(alice.address, 1n, MONTH, 0)))
                .to.emit(payroll, "ScheduleEnded")
                .withArgs(boss.address, alice.address, 2900n * U, 0n)
            await at(t0 + 1 + MONTH + 1, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(2900n * U)
        })

        it("cannot withdraw or spend on shifts while any pay is unfunded, even dust", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(100n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            await time.increaseTo(t0 + 1 + DAY + 5)
            expect(await payroll.available(boss.address)).to.equal(0n)
            await expect(payroll.connect(boss).withdraw(1n)).to.be.revertedWithCustomError(payroll, "InsufficientAvailable")
            await expect(payroll.connect(boss).approveShifts([{ employee: boss.address, shiftId: sid("x"), amount: 1n }])).to.be.revertedWithCustomError(
                payroll,
                "InsufficientAvailable"
            )
        })

        it("a change with scheduleOf().start (or any past start) is refused, so no period is paid twice", async () => {
            const { boss, alice, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(10_000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const t = t0 + 1 + 10.5 * DAY
            const s = await payroll.scheduleOf(boss.address, alice.address)
            await time.increaseTo(t - 5)
            await expect(payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, Number(s.start))).to.be.revertedWithCustomError(
                payroll,
                "InvalidStart"
            )
            // The raise from now: 10.5 days at the old rate, then the new rate from t.
            await at(t, () => payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, 0))
            await at(t + DAY + 1, () => payroll.connect(alice).claim(boss.address))
            expect(await usdc.balanceOf(alice.address)).to.equal(1050n * U + 110n * U)
            // Ending and re-creating back-dated over the paid time is refused too.
            await at(t + DAY + 2, () => payroll.connect(boss).endSchedule(alice.address))
            await time.increaseTo(t + DAY + 10)
            await expect(payroll.connect(boss).setSchedule(alice.address, 110n * U, DAY, t)).to.be.revertedWithCustomError(payroll, "InvalidStart")
        })
    })

    // ------------------------------------------------------------------ debts
    describe("debts after underfunding", () => {
        it("backed debt is shared pro rata, so the employer's own wallet claiming first cannot take alice's share", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            // Account funded to 'now' but with zero free: setSchedule is allowed.
            // Both in one block (zero free; a second later the account would already be underfunded).
            await network.provider.send("evm_setAutomine", [false])
            await time.setNextBlockTimestamp(t0)
            await payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, { gasLimit: 300_000 })
            await payroll.connect(boss).setSchedule(sock.address, 1_000_000n * U, DAY, t0 + 1, { gasLimit: 300_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            await at(t0 + 3 * DAY + 10, () => payroll.connect(boss).endSchedule(alice.address)) // alice: 300 debt
            await at(t0 + 3 * DAY + 11, () => payroll.connect(boss).endSchedule(sock.address)) // sock: 2,000,000 debt
            // Ending settles the time worked pro rata (3 days + 10 s for alice, 3 days + 10 s for sock).
            const aliceDebt = (100n * U * BigInt(3 * DAY + 10)) / BigInt(DAY)
            const sockDebt = (1_000_000n * U * BigInt(3 * DAY + 10)) / BigInt(DAY)
            expect((await payroll.employeeInfo(boss.address, alice.address)).debt).to.equal(aliceDebt)
            expect((await payroll.employeeInfo(boss.address, sock.address)).debt).to.equal(sockDebt)
            // The employer "pays its debts": 300 funded, then its own wallet claims first, in one block.
            const share = (300n * U * aliceDebt) / (aliceDebt + sockDebt)
            await network.provider.send("evm_setAutomine", [false])
            await payroll.connect(boss).fund(300n * U, { gasLimit: 300_000 })
            await payroll.connect(sock).claim(boss.address, { gasLimit: 300_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            // The sock got only its pro-rata part; alice's part is still there for her.
            expect(await usdc.balanceOf(sock.address)).to.be.lessThanOrEqual(300n * U - share)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect(e.claimable).to.be.closeTo(share, 2n)
            expect(e.claimable + e.shortfall).to.equal(aliceDebt)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(e.claimable)
            // Once the employer funds all debt, both are paid exactly what they are owed.
            await payroll.connect(boss).fund((await payroll.employerInfo(boss.address)).shortfall)
            await payroll.connect(alice).claim(boss.address)
            await payroll.connect(sock).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(aliceDebt)
            expect(await usdc.balanceOf(sock.address)).to.equal(sockDebt)
        })

        it("employeeInfo.claimable shows each debtor only its pro-rata part, whatever the claim order", async () => {
            const { boss, alice, bob, usdc, payroll, t0 } = await loadFixture(fixture)
            await network.provider.send("evm_setAutomine", [false])
            await time.setNextBlockTimestamp(t0)
            await payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, { gasLimit: 300_000 })
            await payroll.connect(boss).setSchedule(bob.address, 100n * U, DAY, t0, { gasLimit: 300_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            await at(t0 + DAY + 10, () => payroll.connect(boss).endSchedule(alice.address))
            await at(t0 + DAY + 11, () => payroll.connect(boss).endSchedule(bob.address))
            await payroll.connect(boss).fund(100n * U)
            const a = await payroll.employeeInfo(boss.address, alice.address)
            const b = await payroll.employeeInfo(boss.address, bob.address)
            expect(a.claimable + b.claimable).to.be.lessThanOrEqual(100n * U)
            expect(a.claimable).to.be.closeTo(50n * U, 10_000n)
            expect(b.claimable).to.be.closeTo(50n * U, 10_000n)
            expect((await payroll.employerInfo(boss.address)).balance).to.equal(100n * U)
            await payroll.connect(alice).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(a.claimable)
            expect((await payroll.employeeInfo(boss.address, bob.address)).claimable).to.equal(b.claimable)
            await payroll.connect(bob).claim(boss.address)
            expect(await usdc.balanceOf(bob.address)).to.equal(b.claimable)
        })

        it("debts are backed before older unreserved schedule time of staff still working", async () => {
            const { boss, alice, sock, usdc, payroll, t0 } = await loadFixture(fixture)
            await network.provider.send("evm_setAutomine", [false])
            await time.setNextBlockTimestamp(t0)
            await payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0, { gasLimit: 300_000 })
            await payroll.connect(boss).setSchedule(sock.address, 1000n * U, DAY, t0 + 1, { gasLimit: 300_000 })
            await network.provider.send("evm_mine")
            await network.provider.send("evm_setAutomine", [true])
            await at(t0 + 2 * DAY + 10, () => payroll.connect(boss).endSchedule(sock.address)) // sock debt 2000; alice keeps working
            await at(t0 + 2 * DAY + 20, () => payroll.connect(boss).fund(2000n * U))
            await at(t0 + 2 * DAY + 30, () => payroll.connect(sock).claim(boss.address))
            // The only debtor gets all 2000 backed (less at most one unit of index rounding until all
            // of its debt is backed).
            expect(await usdc.balanceOf(sock.address)).to.be.closeTo(2000n * U, 1n)
            // alice earned 200 before sock's debt existed, and gets nothing from that funding.
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect([e.claimable, e.earned]).to.deep.equal([0n, 200n * U])
        })
    })

    // ------------------------------------------------------------------ rounding
    describe("rounding", () => {
        it("funding exactly N periods leaves about one second unfunded, and fundingNeeded says exactly what to add", async () => {
            const { boss, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            const until = t0 + 1 + 10 * DAY
            const needed = await payroll.fundingNeeded(boss.address, until)
            expect(needed).to.be.greaterThan(0n)
            expect(needed).to.be.lessThanOrEqual(2n)
            expect(await payroll.fundingNeeded(boss.address, t0 + 1 + 5 * DAY)).to.equal(0n)
            const snap = await takeSnapshot()
            await payroll.connect(boss).fund(needed)
            await time.increaseTo(until)
            const exact = await payroll.employeeInfo(boss.address, alice.address)
            expect([exact.claimable, exact.shortfall]).to.deep.equal([1000n * U, 0n])
            await snap.restore()
            await time.increaseTo(t0 + 1 + 10 * DAY)
            const e = await payroll.employeeInfo(boss.address, alice.address)
            expect(e.earned).to.equal(1000n * U)
            expect(e.shortfall).to.be.greaterThan(0n)
            expect(e.shortfall).to.be.lessThanOrEqual((100n * U) / BigInt(DAY) + 1n)
            const info = await payroll.employerInfo(boss.address)
            expect(info.available).to.equal(0n)
            // Funding the reported shortfall clears it exactly.
            await payroll.connect(boss).fund(info.shortfall + 1n)
            const e2 = await payroll.employeeInfo(boss.address, alice.address)
            expect(e2.claimable).to.equal(1000n * U)
        })

        it("1-unit amounts on every period never over-pay, and dust returns to the employer at the end", async () => {
            const { boss, alice, bob, carol, usdc, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(1000n))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 1n, DAY, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 1n, WEEK, t0 + 2))
            await at(t0 + 3, () => payroll.connect(boss).setSchedule(carol.address, 1n, MONTH, t0 + 3))
            await time.increaseTo(t0 + 3 + 60 * DAY)
            for (const s of [alice, bob, carol]) await payroll.connect(s).claim(boss.address)
            expect(await usdc.balanceOf(alice.address)).to.equal(60n)
            expect(await usdc.balanceOf(bob.address)).to.equal(8n)
            expect(await usdc.balanceOf(carol.address)).to.equal(2n)
            for (const s of [alice, bob, carol]) await payroll.connect(boss).endSchedule(s.address)
            expect(await payroll.available(boss.address)).to.equal(1000n - 70n)
        })

        it("huge balances and uint96-max rates do not overflow anywhere a claim depends on", async () => {
            const { boss, alice, bob, usdc, payroll } = await loadFixture(fixture)
            const maxFund = (2n ** 128n - 1n) / SCALE
            await usdc.mint(boss.address, maxFund)
            const t0 = (await time.latest()) + 100
            await at(t0, () => payroll.connect(boss).fund(maxFund))
            await expect(payroll.connect(boss).fund(1n)).to.be.revertedWithCustomError(payroll, "BalanceTooLarge")
            const big = 2n ** 96n - 1n
            await at(t0 + 11, () => payroll.connect(boss).setSchedule(alice.address, big, DAY, t0 + 11))
            await at(t0 + 12, () => payroll.connect(boss).setSchedule(bob.address, big, DAY, t0 + 12))
            await at(t0 + 13, () => payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: sid("big"), amount: 10n ** 27n }]))
            // Years pass: the account runs dry, then debts grow.
            await time.increaseTo(t0 + 3 + 3650 * DAY)
            await payroll.connect(alice).claim(boss.address)
            await payroll.connect(boss).endSchedule(bob.address)
            await payroll.connect(bob).claim(boss.address).catch(() => undefined)
            await payroll.connect(boss).endSchedule(alice.address)
            const info = await payroll.employerInfo(boss.address)
            expect(info.shortfall).to.be.greaterThan(0n)
            expect(await usdc.balanceOf(await payroll.getAddress())).to.equal(info.balance)
        })
    })

    // ------------------------------------------------------------------ same block / ordering
    it("several operations in one block (same timestamp) keep the books exact", async () => {
        const { boss, alice, bob, keeper, usdc, payroll, addr, t0 } = await loadFixture(fixture)
        await at(t0, () => payroll.connect(boss).fund(500n * U))
        await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1 - 2 * DAY))
        await network.provider.send("evm_setAutomine", [false])
        const g = { gasLimit: 500_000 }
        await payroll.connect(keeper).claimFor(boss.address, alice.address, g)
        await payroll.connect(boss).setSchedule(alice.address, 50n * U, WEEK, t0 + 2, g)
        await payroll.connect(boss).setSchedule(bob.address, 10n * U, DAY, t0 + 2, g)
        await payroll.connect(boss).endSchedule(bob.address, g)
        await payroll.connect(boss).withdraw(1n * U, g)
        await time.setNextBlockTimestamp(t0 + 2)
        await network.provider.send("evm_mine")
        await network.provider.send("evm_setAutomine", [true])
        const blk = await ethers.provider.getBlock("latest")
        for (const h of blk!.transactions) expect((await ethers.provider.getTransactionReceipt(h))!.status).to.equal(1)
        expect(await usdc.balanceOf(alice.address)).to.equal(200n * U)
        expect(await usdc.balanceOf(addr)).to.equal((await payroll.employerInfo(boss.address)).balance)
    })

    // ------------------------------------------------------------------ griefing / events
    describe("griefing and events", () => {
        it("claimFor by a stranger only pays the employee, and when underfunded emits events without paying", async () => {
            const { boss, alice, keeper, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0))
            await time.increaseTo(t0 + DAY + 1)
            for (let i = 0; i < 3; i++) {
                const tx = payroll.connect(keeper).claimFor(boss.address, alice.address)
                await expect(tx).to.emit(payroll, "Shortfall")
                await expect(tx).to.emit(payroll, "Underfunded")
                await expect(tx).to.not.emit(payroll, "Claimed")
            }
        })

        it("endSchedule applies returned funds before reporting, so no stale Underfunded", async () => {
            const { boss, alice, bob, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(150n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 100n * U, DAY, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss).setSchedule(bob.address, 100n * U, DAY, t0 + 3 * DAY))
            await time.increaseTo(t0 + 1 + DAY + 100)
            // bob has a big pre-reservation and has earned nothing: ending it frees money that covers alice.
            const tx = payroll.connect(boss).endSchedule(bob.address)
            await expect(tx).to.not.emit(payroll, "Underfunded")
            expect((await payroll.employerInfo(boss.address)).shortfall).to.equal(0n)
        })

        it("an employer cannot affect another employer's account or a shared employee's pay there", async () => {
            const { boss, boss2, alice, payroll, t0 } = await loadFixture(fixture)
            await at(t0, () => payroll.connect(boss).fund(100n * U))
            await at(t0 + 1, () => payroll.connect(boss).setSchedule(alice.address, 10n * U, DAY, t0 + 1))
            await at(t0 + 2, () => payroll.connect(boss2).setSchedule(alice.address, 10n ** 12n * U, DAY, t0 + 2))
            await at(t0 + 3, () => payroll.connect(boss2).approveShifts([{ employee: alice.address, shiftId: sid("x"), amount: 0n }]).catch(() => 0))
            await time.increaseTo(t0 + 5 * DAY)
            expect((await payroll.employeeInfo(boss.address, alice.address)).claimable).to.equal(40n * U)
            expect((await payroll.employerInfo(boss.address)).shortfall).to.equal(0n)
            await expect(payroll.connect(boss2).endSchedule(alice.address)).to.emit(payroll, "ScheduleEnded")
            expect((await payroll.scheduleOf(boss.address, alice.address)).amountPerPeriod).to.equal(10n * U)
        })
    })

    // ------------------------------------------------------------------ reentrancy through every token call
    it("a hook token cannot re-enter setSchedule / endSchedule / approveShifts / fund from a claim transfer", async () => {
        const [boss, alice] = await ethers.getSigners()
        const hook = await ethers.deployContract("HookToken")
        const payroll = await ethers.deployContract("FairPayroll", [await hook.getAddress()])
        const target = await payroll.getAddress()
        await hook.mint(boss.address, 1000n * U)
        await hook.connect(boss).approve(target, ethers.MaxUint256)
        await payroll.connect(boss).fund(100n * U)
        await payroll.connect(boss).approveShifts([{ employee: alice.address, shiftId: sid("r"), amount: 10n * U }])
        const now = (await time.latest()) + 10
        for (const data of [
            payroll.interface.encodeFunctionData("setSchedule", [alice.address, U, DAY, now]),
            payroll.interface.encodeFunctionData("endSchedule", [alice.address]),
            payroll.interface.encodeFunctionData("approveShifts", [[{ employee: alice.address, shiftId: sid("z"), amount: 1n }]]),
            payroll.interface.encodeFunctionData("fund", [1n])
        ]) {
            await hook.arm(target, data)
            await expect(payroll.connect(alice).claim(boss.address)).to.be.revertedWithCustomError(payroll, "ReentrancyGuardReentrantCall")
        }
    })
})
