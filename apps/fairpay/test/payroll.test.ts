// Team pay part 2, the payroll escrow (server/routes/payroll.ts, server/payroll.ts): only the owner
// may use the escrow endpoints and a staff member sees only their own position; nothing works
// without a payroll contract; a shift is approved only after its ShiftApproved event verifies
// on-chain; the event indexer is idempotent and resumes; the keeper only claims for opted-in staff.

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import type { Hash, Hex } from "viem"
import type { ActivityItem, EscrowView, MyEscrowView, PayrollShift, Restaurant, ShiftApproveResult, Wallet } from "../shared/types.js"
import { createChain, loadDeployment } from "../server/chain.js"
import type { Db } from "../server/context.js"
import {
    assertDistinctKeys,
    createPayrollIndexer,
    createPayrollKeeper,
    keeperMode,
    type KeeperWallet,
    type PayrollLog,
    type PayrollLogSource
} from "../server/payroll.js"
import { NOT_SET_UP } from "../server/routes/payroll.js"
import { fakeChain, makeTestApp, mineTransfer, shiftApprovedLog, TEST_PAYROLL, transferLog, txHash, type TestApp } from "./helpers.js"

const U = 1_000_000
const DAY_S = 86_400n
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0)
const OWNER = "0x1111111111111111111111111111111111111111" as Wallet
const MANAGER = "0x2222222222222222222222222222222222222222" as Wallet
const CHEF = "0x3333333333333333333333333333333333333333" as Wallet
const WAITER = "0x4444444444444444444444444444444444444444" as Wallet
const LEFT = "0x5555555555555555555555555555555555555555" as Wallet
const OUTSIDER = "0x6666666666666666666666666666666666666666" as Wallet
const OTHER_OWNER = "0x7777777777777777777777777777777777777777" as Wallet
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000f2"

type Ctx = TestApp & { cookies: Record<string, string>; r: Restaurant }

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    const body = await r.json()
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`)
    return body as T
}

async function setup(opts: { payroll?: boolean } = {}): Promise<Ctx> {
    const t = await makeTestApp({ chain: fakeChain({ payroll: opts.payroll ?? true }), now: () => NOW })
    const cookies: Record<string, string> = {}
    for (const [name, w] of Object.entries({ OWNER, MANAGER, CHEF, WAITER, LEFT, OUTSIDER, OTHER_OWNER })) cookies[name] = await t.signIn(w)
    const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: cookies.OWNER, body: { name: "Spice Route", state: "Karnataka", tables: 2 } }), 201)
    for (const [w, role, name] of [
        [MANAGER, "manager", "Meera"],
        [CHEF, "chef", "Arjun"],
        [WAITER, "waiter", "Kavya"]
    ] as const) {
        await json(t.call("POST", `/api/restaurants/${r.id}/staff`, { cookie: cookies.OWNER, body: { wallet: w, role, displayName: name } }), 201)
    }
    return { ...t, cookies, r }
}

const pay = (t: Ctx) => t.chain.payroll!
const base = (t: Ctx) => `/api/restaurants/${t.r.id}/team-pay`

function addShift(t: Ctx, body: Record<string, unknown>, cookie = t.cookies.OWNER) {
    return t.call("POST", `${base(t)}/shifts`, { cookie, body: { workDate: "2026-11-02", amount: 20 * U, ...body } })
}

/** Mines approveShifts for these shifts by `employer` (the owner by default) on the fake chain. */
function approvedOnChain(t: Ctx, shifts: { wallet: string; shiftId: Hex; amount: number }[], o: { employer?: string; contract?: string; status?: "success" | "reverted"; blockNumber?: bigint } = {}) {
    return mineTransfer(t.chain, {
        logs: shifts.map((s) => shiftApprovedLog({ employer: o.employer ?? OWNER, employee: s.wallet, shiftId: s.shiftId, amount: s.amount, contract: o.contract })),
        status: o.status,
        blockNumber: o.blockNumber
    })
}

function approve(t: Ctx, h: Hash, cookie = t.cookies.OWNER) {
    return t.call("POST", `${base(t)}/shifts/approve`, { cookie, body: { txHash: h } })
}

// ------------------------------------------------------------------ feature switch

describe("payroll escrow: hidden without a payroll contract", () => {
    it("answers the owner 503 'not set up' on every escrow endpoint, and others still 404", async () => {
        const t = await setup({ payroll: false })
        const calls: [string, string, unknown?][] = [
            ["GET", `${base(t)}/escrow`],
            ["GET", `${base(t)}/escrow/history`],
            ["POST", `${base(t)}/shifts`, { wallet: CHEF, workDate: "2026-11-02", amount: 20 * U }],
            ["DELETE", `${base(t)}/shifts/ps_aaaaaaaaaaaaaaaa`],
            ["POST", `${base(t)}/shifts/approve`, { txHash: txHash() }],
            ["PUT", `${base(t)}/members/${CHEF}`, { autoPay: false }]
        ]
        for (const [method, p, body] of calls) {
            const res = await t.call(method, p, { cookie: t.cookies.OWNER, body })
            expect(res.status, `${method} ${p}`).toBe(503)
            expect(await res.json()).toEqual({ error: NOT_SET_UP })
            expect((await t.call(method, p, { cookie: t.cookies.CHEF, body })).status, `${method} ${p} as chef`).toBe(404)
        }
        // A staff member sees "not set up" too, once they may see the restaurant at all.
        expect((await t.call("GET", `${base(t)}/escrow/mine`, { cookie: t.cookies.CHEF })).status).toBe(503)
        expect((await t.call("GET", `${base(t)}/escrow/mine`, { cookie: t.cookies.OUTSIDER })).status).toBe(404)
        expect(await t.deps.db.query("SELECT * FROM payroll_shifts")).toHaveLength(0)
    })

    it("loads `payroll` from the deployment file only when it is there", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "fairpay-dep-"))
        const raw = {
            chainId: 10143,
            token: "0x00000000000000000000000000000000000000a1",
            fairPay: "0x00000000000000000000000000000000000000a2",
            pool: "0x00000000000000000000000000000000000000a3",
            poolDeployBlock: "75539369",
            denomination: "5000000"
        }
        const without = path.join(dir, "a.json")
        const withIt = path.join(dir, "b.json")
        writeFileSync(without, JSON.stringify(raw))
        writeFileSync(withIt, JSON.stringify({ ...raw, payroll: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", payrollDeployBlock: "77000000" }))
        const a = loadDeployment(without)
        expect(a.payroll).toBeUndefined()
        expect(createChain({ deployment: a, rpcUrl: "http://127.0.0.1:1" }).chain.payroll).toBeUndefined()
        const b = loadDeployment(withIt)
        expect(b.payroll).toBe("0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD")
        expect(b.payrollDeployBlock).toBe(77000000n)
        const live = createChain({ deployment: b, rpcUrl: "http://127.0.0.1:1" }).chain.payroll!
        expect(live.address).toBe(b.payroll)
        expect(live.deployBlock).toBe(77000000n)
    })
})

// ------------------------------------------------------------------ who may use it

describe("payroll escrow: who may use it", () => {
    let t: Ctx
    beforeEach(async () => {
        t = await setup()
    })

    it("answers only the owner on the owner endpoints; staff, strangers, other owners and unknown ids get 404, signed-out 401", async () => {
        const shift = await json<PayrollShift>(addShift(t, { wallet: WAITER }), 201)
        const calls: [string, string, unknown?, number?][] = [
            ["GET", `${base(t)}/escrow`],
            ["GET", `${base(t)}/escrow/history`],
            ["POST", `${base(t)}/shifts`, { wallet: CHEF, workDate: "2026-11-02", amount: 20 * U }, 201],
            ["POST", `${base(t)}/shifts/approve`, { txHash: txHash() }, 202],
            ["PUT", `${base(t)}/members/${CHEF}`, { shiftRate: 25 * U }],
            ["DELETE", `${base(t)}/shifts/${shift.id}`]
        ]
        for (const [method, p, body, ok] of calls) {
            for (const who of ["MANAGER", "CHEF", "WAITER", "OUTSIDER", "OTHER_OWNER"]) {
                const res = await t.call(method, p, { cookie: t.cookies[who], body })
                expect(res.status, `${method} ${p} as ${who}`).toBe(404)
                expect(await res.json()).toEqual({ error: "No restaurant with that id." })
            }
            expect((await t.call(method, p, { body })).status, `${method} ${p} signed out`).toBe(401)
            expect((await t.call(method, p.replace(t.r.id, "r_doesnotexist"), { cookie: t.cookies.OWNER, body })).status).toBe(404)
            expect((await t.call(method, p, { cookie: t.cookies.OWNER, body })).status, `${method} ${p} owner`).toBe(ok ?? 200)
        }
    })

    it("shows a staff member only their own position; strangers and the owner get 404", async () => {
        pay(t).employees.set(`${OWNER}:${CHEF}`, { claimable: 12n * BigInt(U), earned: 15n * BigInt(U), shortfall: 3n * BigInt(U), nextPeriodEnd: BigInt(NOW / 1000) + DAY_S })
        pay(t).schedules.set(`${OWNER}:${CHEF}`, { amountPerPeriod: 100n * BigInt(U), period: 7n * DAY_S, start: BigInt(NOW / 1000) - 3n * DAY_S })
        pay(t).employees.set(`${OWNER}:${WAITER}`, { claimable: 99n * BigInt(U) })
        await json(addShift(t, { wallet: CHEF, note: "Dinner" }), 201)
        await json(addShift(t, { wallet: WAITER }), 201)

        const mine = await json<MyEscrowView>(t.call("GET", `${base(t)}/escrow/mine`, { cookie: t.cookies.CHEF }))
        expect(mine.employer).toBe(OWNER)
        expect(mine.position).toEqual({ claimable: 12 * U, earned: 15 * U, shortfall: 3 * U, scheduleEarned: 0, debt: 0, nextPayAt: NOW + 86_400_000 })
        expect(mine.schedule).toEqual({ amountPerPeriod: 100 * U, period: "week", start: NOW - 3 * 86_400_000 })
        expect(mine.shifts.map((s) => [s.wallet, s.note])).toEqual([[CHEF, "Dinner"]])
        // Only the chef's own pair was read.
        expect(pay(t).employeeReads).toEqual([`${OWNER}:${CHEF}`])

        for (const who of ["OUTSIDER", "OTHER_OWNER", "OWNER", "LEFT"]) {
            expect((await t.call("GET", `${base(t)}/escrow/mine`, { cookie: t.cookies[who] })).status, who).toBe(404)
            expect((await t.call("GET", `${base(t)}/escrow/mine/history`, { cookie: t.cookies[who] })).status, who).toBe(404)
        }
        expect((await t.call("GET", `${base(t)}/escrow/mine`)).status).toBe(401)
    })

    it("still answers someone who left the staff but has escrow history with this owner", async () => {
        const db = t.deps.db
        await db.query(
            `INSERT INTO payroll_events (chain_id, contract, block_number, block_time, tx_hash, log_index, event, employer, employee, amount, args)
             VALUES (10143, $1, 5, $2, $3, 0, 'ScheduleSet', $4, $5, '1000000', '{}')`,
            [TEST_PAYROLL.toLowerCase(), NOW, txHash(), OWNER, LEFT]
        )
        const mine = await json<MyEscrowView>(t.call("GET", `${base(t)}/escrow/mine`, { cookie: t.cookies.LEFT }))
        expect(mine.events.map((e) => e.kind)).toEqual(["schedule_set"])
    })

    it("refuses shifts for people not on the staff, the owner, bad dates and amounts", async () => {
        for (const [body, status] of [
            [{ wallet: OUTSIDER }, 400],
            [{ wallet: OWNER }, 400],
            [{ wallet: CHEF, workDate: "2026-02-30" }, 400],
            [{ wallet: CHEF, workDate: "2027-06-01" }, 400],
            [{ wallet: CHEF, amount: 0 }, 400],
            [{ wallet: CHEF, amount: 1_234_567 }, 400],
            [{ wallet: CHEF, minutes: 0 }, 400],
            [{ wallet: CHEF, minutes: 1441 }, 400],
            [{ wallet: CHEF, note: "x".repeat(141) }, 400]
        ] as const) {
            expect((await addShift(t, body)).status, JSON.stringify(body)).toBe(status)
        }
        const s = await json<PayrollShift>(addShift(t, { wallet: CHEF, minutes: 450 }), 201)
        expect(s).toMatchObject({ wallet: CHEF, name: "Arjun", workDate: "2026-11-02", minutes: 450, amount: 20 * U, status: "pending", approved: null })
        expect(s.shiftId).toMatch(/^0x[0-9a-f]{64}$/)
        const other = await json<PayrollShift>(addShift(t, { wallet: CHEF }), 201)
        expect(other.shiftId).not.toBe(s.shiftId)
    })

    it("saves shift rates and refuses auto-pay while the server has no keeper", async () => {
        const res = await json<{ shiftRate: number | null; autoPay: boolean }>(t.call("PUT", `${base(t)}/members/${CHEF}`, { cookie: t.cookies.OWNER, body: { shiftRate: 25 * U } }))
        expect(res).toMatchObject({ shiftRate: 25 * U, autoPay: false })
        expect((await t.call("PUT", `${base(t)}/members/${CHEF}`, { cookie: t.cookies.OWNER, body: { autoPay: true } })).status).toBe(409)
        expect((await t.call("PUT", `${base(t)}/members/${OUTSIDER}`, { cookie: t.cookies.OWNER, body: { shiftRate: 1 * U } })).status).toBe(400)
        pay(t).keeper = "0x00000000000000000000000000000000000000ee"
        expect(await json(t.call("PUT", `${base(t)}/members/${CHEF}`, { cookie: t.cookies.OWNER, body: { autoPay: true } }))).toMatchObject({ shiftRate: 25 * U, autoPay: true })
    })
})

// ------------------------------------------------------------------ the owner's view

describe("payroll escrow: the owner's view", () => {
    it("reads the account, every staff member's position, people who left with pay, and suggestions from the chain", async () => {
        const t = await setup()
        const p = pay(t)
        const nowS = BigInt(NOW / 1000)
        p.employers.set(OWNER, { balance: 500n * BigInt(U), available: 200n * BigInt(U), owed: 300n * BigInt(U), fundedUntil: nowS, runwayUntil: nowS + 20n * DAY_S, payPerDay: 10n * BigInt(U) })
        p.funding = (_e, until) => (until - nowS) * 1000n
        p.employees.set(`${OWNER}:${CHEF}`, { claimable: 5n * BigInt(U), earned: 5n * BigInt(U) })
        p.schedules.set(`${OWNER}:${CHEF}`, { amountPerPeriod: 70n * BigInt(U), period: 7n * DAY_S, start: nowS - DAY_S, endedAt: 0n })
        p.employees.set(`${OWNER}:${LEFT}`, { claimable: 8n * BigInt(U), earned: 8n * BigInt(U) })
        await t.deps.db.query(
            `INSERT INTO payroll_events (chain_id, contract, block_number, block_time, tx_hash, log_index, event, employer, employee, amount, args)
             VALUES (10143, $1, 5, $2, $3, 0, 'ShiftApproved', $4, $5, '8000000', '{"amount":"8000000"}'),
                    (10143, $1, 6, $2, $6, 0, 'Underfunded', $4, NULL, '1', '{}'),
                    (10143, $1, 7, $2, $7, 0, 'Funded', $8, NULL, '9', '{}')`,
            [TEST_PAYROLL.toLowerCase(), NOW, txHash(), OWNER, LEFT, txHash(), txHash(), OTHER_OWNER]
        )
        await json(t.call("PUT", `/api/restaurants/${t.r.id}/team-pay/members/${WAITER}`, { cookie: t.cookies.OWNER, body: { shiftRate: 15 * U } }))

        const v = await json<EscrowView>(t.call("GET", `${base(t)}/escrow`, { cookie: t.cookies.OWNER }))
        expect(v.account).toEqual({ balance: 500 * U, available: 200 * U, owed: 300 * U, shortfall: 0, fundedUntil: NOW, runwayUntil: NOW + 20 * 86_400_000, payPerDay: 10 * U })
        expect(v.suggestions).toEqual([
            { days: 7, amount: 7 * 86_400_000 },
            { days: 30, amount: 30 * 86_400_000 }
        ])
        const byWallet = Object.fromEntries(v.members.map((m) => [m.wallet, m]))
        expect(Object.keys(byWallet).sort()).toEqual([MANAGER, CHEF, WAITER, LEFT].sort())
        expect(byWallet[CHEF]).toMatchObject({ name: "Arjun", onStaff: true, schedule: { amountPerPeriod: 70 * U, period: "week", start: NOW - 86_400_000 }, position: { claimable: 5 * U } })
        expect(byWallet[WAITER]).toMatchObject({ shiftRate: 15 * U, schedule: null, autoPay: false })
        expect(byWallet[LEFT]).toMatchObject({ onStaff: false, role: null, position: { claimable: 8 * U } })
        // History: this owner's events only, without the repeated Underfunded.
        expect(v.events.map((e) => e.kind)).toEqual(["shift_approved"])
        expect(v.keeper).toBe(false)
    })

    it("answers 502 with a fixed sentence when the chain can't be read", async () => {
        const t = await setup()
        pay(t).failReads = true
        const res = await t.call("GET", `${base(t)}/escrow`, { cookie: t.cookies.OWNER })
        expect(res.status).toBe(502)
        expect((await res.json()).error).not.toContain("rpc")
    })
})

// ------------------------------------------------------------------ shift approvals

describe("payroll escrow: shift approvals are recorded only after the chain shows them", () => {
    let t: Ctx
    let a: PayrollShift
    let b: PayrollShift
    beforeEach(async () => {
        t = await setup()
        a = await json<PayrollShift>(addShift(t, { wallet: CHEF, amount: 20 * U }), 201)
        b = await json<PayrollShift>(addShift(t, { wallet: WAITER, amount: 12 * U }), 201)
    })
    const status = async () => Object.fromEntries((await t.deps.db.query<{ id: string; status: string }>("SELECT id, status FROM payroll_shifts")).map((r) => [r.id, r.status]))

    it("waits (202) for an unknown transaction or too few confirmations, and records nothing", async () => {
        expect((await approve(t, txHash())).status).toBe(202)
        const h = approvedOnChain(t, [a], { blockNumber: t.chain.head })
        expect((await approve(t, h)).status).toBe(202)
        expect(await status()).toEqual({ [a.id]: "pending", [b.id]: "pending" })
    })

    it("refuses reverted transactions, look-alike events from other contracts, another employer, and wrong amounts or people", async () => {
        const cases: Hash[] = [
            approvedOnChain(t, [a], { status: "reverted" }),
            approvedOnChain(t, [a], { contract: OTHER_CONTRACT }),
            approvedOnChain(t, [a], { employer: OTHER_OWNER }),
            approvedOnChain(t, [{ ...a, amount: 25 * U }]),
            approvedOnChain(t, [{ ...a, wallet: WAITER }]),
            // A plain transfer is not an approval.
            mineTransfer(t.chain, { logs: [transferLog({ from: OWNER, to: CHEF, value: 20 * U })] })
        ]
        for (const h of cases) {
            const r = await json<ShiftApproveResult>(approve(t, h))
            expect(r.status, h).toBe("rejected")
        }
        expect(await status()).toEqual({ [a.id]: "pending", [b.id]: "pending" })
    })

    it("waits while the receipt's block isn't the canonical one", async () => {
        const h = approvedOnChain(t, [a])
        t.chain.reorged.add(t.chain.receipts.get(h)!.blockNumber)
        expect((await approve(t, h)).status).toBe(202)
        expect(await status()).toEqual({ [a.id]: "pending", [b.id]: "pending" })
    })

    it("marks exactly the matching shifts approved, notes it in staff activity, and answers a retry the same", async () => {
        const h = approvedOnChain(t, [a, b])
        const r = await json<ShiftApproveResult>(approve(t, h))
        if (r.status !== "recorded") throw new Error(JSON.stringify(r))
        expect(r.shifts.map((s) => [s.id, s.status, s.approved?.txHash, s.approved?.logIndex])).toEqual([
            [a.id, "approved", h, 0],
            [b.id, "approved", h, 1]
        ])
        expect(await status()).toEqual({ [a.id]: "approved", [b.id]: "approved" })
        const again = await json<ShiftApproveResult>(approve(t, h))
        expect(again.status).toBe("recorded")
        const feed = await json<ActivityItem[] | { items: ActivityItem[] }>(t.call("GET", "/api/activity", { cookie: t.cookies.CHEF }))
        const items = Array.isArray(feed) ? feed : feed.items
        expect(items.filter((i) => i.title.includes("shift pay"))).toHaveLength(1)
        // An approved shift can't be removed.
        expect((await t.call("DELETE", `${base(t)}/shifts/${a.id}`, { cookie: t.cookies.OWNER })).status).toBe(409)
    })

    it("does not touch another restaurant's shifts with the same owner", async () => {
        const r2 = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Second Kitchen", state: "Karnataka", tables: 1 } }), 201)
        await json(t.call("POST", `/api/restaurants/${r2.id}/staff`, { cookie: t.cookies.OWNER, body: { wallet: CHEF, role: "chef", displayName: "Arjun" } }), 201)
        const h = approvedOnChain(t, [a])
        const r = await json<ShiftApproveResult>(t.call("POST", `/api/restaurants/${r2.id}/team-pay/shifts/approve`, { cookie: t.cookies.OWNER, body: { txHash: h } }))
        expect(r.status).toBe("rejected")
        expect(await status()).toEqual({ [a.id]: "pending", [b.id]: "pending" })
    })
})

// ------------------------------------------------------------------ indexer

type FakeSource = PayrollLogSource & { logs: PayrollLog[]; head: bigint; ranges: [bigint, bigint][] }

function fakeSource(): FakeSource {
    const s: FakeSource = {
        logs: [],
        head: 50n,
        ranges: [],
        getBlockNumber: async () => s.head,
        async getLogs(from, to) {
            s.ranges.push([from, to])
            return s.logs.filter((l) => l.blockNumber! >= from && l.blockNumber! <= to)
        },
        getBlockTime: async (b) => 1_800_000_000n + b
    }
    return s
}

let logCounter = 0
function log(eventName: string, block: bigint, args: Record<string, unknown>, logIndex = 0): PayrollLog {
    return { eventName, args, blockNumber: block, transactionHash: `0x${(++logCounter).toString(16).padStart(64, "c")}` as Hash, logIndex }
}

const count = async (db: Db) => Number((await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM payroll_events"))!.n)

describe("payroll escrow: event indexer", () => {
    it("stores each confirmed event once, resumes from the saved block, and never stores one twice", async () => {
        const t = await setup()
        const db = t.deps.db
        const src = fakeSource()
        src.logs.push(
            log("Funded", 10n, { employer: OWNER, amount: 100n * BigInt(U) }),
            log("Claimed", 20n, { employer: OWNER, employee: CHEF, caller: OUTSIDER, amount: 5n * BigInt(U), fromSchedule: 5n * BigInt(U), fromDebt: 0n }),
            // Only 2 blocks on top of head 50 count: block 49 waits.
            log("Withdrawn", 49n, { employer: OWNER, amount: 1n })
        )
        const opts = { chainId: 10143, contract: TEST_PAYROLL, deployBlock: 5n, confirmations: 2n, now: () => NOW }
        const ix = createPayrollIndexer(db, src, opts)
        await ix.syncOnce()
        expect(src.ranges[0]![0]).toBe(5n)
        expect(await count(db)).toBe(2)
        const state = await db.one<{ last_block: number }>("SELECT last_block FROM payroll_indexer_state")
        expect(Number(state!.last_block)).toBe(48)

        // A new process resumes after block 48, and sees block 49 once it has confirmations.
        src.head = 52n
        src.ranges = []
        const ix2 = createPayrollIndexer(db, src, opts)
        await ix2.syncOnce()
        expect(src.ranges[0]![0]).toBe(49n)
        expect(await count(db)).toBe(3)

        // Scanning everything again (a second instance from the deploy block) adds nothing.
        await db.query("UPDATE payroll_indexer_state SET last_block = NULL")
        await createPayrollIndexer(db, src, opts).syncOnce()
        expect(await count(db)).toBe(3)

        // The owner's history shows them, an auto-paid claim marked as such.
        const v = await json<{ events: { kind: string; autoPaid: boolean; at: number; amount: number }[] }>(
            t.call("GET", `${base(t)}/escrow/history`, { cookie: t.cookies.OWNER })
        )
        expect(v.events.map((e) => [e.kind, e.autoPaid, e.amount])).toEqual([
            ["withdrawn", false, 1],
            ["claimed", true, 5 * U],
            ["funded", false, 100 * U]
        ])
        expect(v.events[2]!.at).toBe(Number(1_800_000_010n) * 1000)
        // The events table is append-only.
        await expect(db.query("DELETE FROM payroll_events")).rejects.toThrow()
    })

    it("marks a pending shift approved from its ShiftApproved event, even without the browser's hash", async () => {
        const t = await setup()
        const s = await json<PayrollShift>(addShift(t, { wallet: CHEF, amount: 20 * U }), 201)
        const other = await json<PayrollShift>(addShift(t, { wallet: WAITER, amount: 10 * U }), 201)
        const src = fakeSource()
        src.logs.push(
            log("ShiftApproved", 12n, { employer: OWNER, employee: CHEF, shiftId: s.shiftId, amount: 20n * BigInt(U) }),
            // Wrong amount: not this shift.
            log("ShiftApproved", 13n, { employer: OWNER, employee: WAITER, shiftId: other.shiftId, amount: 11n * BigInt(U) }),
            // Another employer using the same id: not this restaurant's.
            log("ShiftApproved", 14n, { employer: OTHER_OWNER, employee: WAITER, shiftId: other.shiftId, amount: 10n * BigInt(U) })
        )
        await createPayrollIndexer(t.deps.db, src, { chainId: 10143, contract: TEST_PAYROLL, deployBlock: 1n, confirmations: 2n }).syncOnce()
        const rows = await t.deps.db.query<{ id: string; status: string; approved_block: number | null }>("SELECT id, status, approved_block FROM payroll_shifts ORDER BY created_at, id")
        const by = Object.fromEntries(rows.map((r) => [r.id, r]))
        expect(by[s.id]).toMatchObject({ status: "approved" })
        expect(Number(by[s.id]!.approved_block)).toBe(12)
        expect(by[other.id]).toMatchObject({ status: "pending" })
    })
})

// ------------------------------------------------------------------ keeper

function fakeKeeperWallet(): KeeperWallet & { claims: string[]; funded: boolean } {
    const w = {
        address: "0x00000000000000000000000000000000000000ee" as const,
        claims: [] as string[],
        funded: true,
        canPay: async () => w.funded,
        async claimFor(employer: string, employee: string) {
            w.claims.push(`${employer.toLowerCase()}:${employee.toLowerCase()}`)
            return txHash()
        },
        wait: async () => ({ status: "success" as const, amount: 5n * BigInt(U) })
    }
    return w
}

describe("payroll escrow: auto-pay keeper", () => {
    it("is off without KEEPER_KEY, and refuses a key shared with the relayer or the faucet", () => {
        const k = `0x${"1".repeat(64)}` as Hex
        const r = `0x${"2".repeat(64)}` as Hex
        expect(keeperMode(undefined, TEST_PAYROLL)).toBe("off")
        expect(keeperMode(k, undefined)).toBe("no-payroll")
        expect(keeperMode(k, TEST_PAYROLL)).toBe("on")
        expect(() => assertDistinctKeys({ relayerKey: r, faucetKey: `0x${"3".repeat(64)}`, keeperKey: k })).not.toThrow()
        expect(() => assertDistinctKeys({ relayerKey: k, keeperKey: k })).toThrow(/KEEPER_KEY and RELAYER_KEY/)
        expect(() => assertDistinctKeys({ faucetKey: k.toUpperCase().replace("0X", "0x") as Hex, keeperKey: k })).toThrow(/KEEPER_KEY and FAUCET_KEY/)
        expect(() => createChain({ deployment: loadDeployment(path.join(__dirname, "..", "..", "..", "packages", "contracts", "deployments", "monadTestnet.json")), rpcUrl: "http://127.0.0.1:1", relayerKey: r, keeperKey: r })).toThrow(/KEEPER_KEY/)
    })

    it("claims only for opted-in staff with something claimable, within its limits", async () => {
        const t = await setup()
        const p = pay(t)
        p.keeper = "0x00000000000000000000000000000000000000ee"
        for (const w of [CHEF, WAITER, MANAGER]) p.employees.set(`${OWNER}:${w}`, { claimable: 5n * BigInt(U) })
        // Chef and manager opted in; the waiter did not.
        for (const w of [CHEF, MANAGER]) await json(t.call("PUT", `${base(t)}/members/${w}`, { cookie: t.cookies.OWNER, body: { autoPay: true } }))
        p.employees.set(`${OWNER}:${MANAGER}`, { claimable: 0n })
        let clock = NOW
        const wallet = fakeKeeperWallet()
        const logs: string[] = []
        const keeper = createPayrollKeeper({ db: t.deps.db, payroll: p, wallet, now: () => clock, log: (m) => logs.push(m), pairCooldownMs: 3_600_000 })

        expect(await keeper.runOnce()).toMatchObject({ claimed: 1 })
        expect(wallet.claims).toEqual([`${OWNER}:${CHEF}`])
        // The log names short wallets and the transaction, nothing else.
        expect(logs).toEqual([expect.stringMatching(/^auto-paid 5\.00 USDC to 0x3333…3333 from 0x1111…1111: 0x[0-9a-f]{64}$/)])
        const feed = await json<ActivityItem[] | { items: ActivityItem[] }>(t.call("GET", "/api/activity", { cookie: t.cookies.CHEF }))
        expect((Array.isArray(feed) ? feed : feed.items).some((i) => i.title.startsWith("You were auto-paid 5.00 USDC"))).toBe(true)

        // Within the cooldown nothing is sent again.
        await keeper.runOnce()
        expect(wallet.claims).toHaveLength(1)
        clock += 3_600_001
        await keeper.runOnce()
        expect(wallet.claims).toHaveLength(2)

        // Someone removed from the staff is never claimed for, even with auto-pay saved.
        await json(t.call("DELETE", `/api/restaurants/${t.r.id}/staff/${CHEF}`, { cookie: t.cookies.OWNER }))
        clock += 3_600_001
        await keeper.runOnce()
        expect(wallet.claims).toHaveLength(2)
        expect(wallet.claims.every((c) => c === `${OWNER}:${CHEF}`)).toBe(true)
    })

    it("stops while its wallet can't pay for gas, and respects the per-run cap", async () => {
        const t = await setup()
        const p = pay(t)
        p.keeper = "0x00000000000000000000000000000000000000ee"
        for (const w of [CHEF, WAITER, MANAGER]) {
            p.employees.set(`${OWNER}:${w}`, { claimable: 1n * BigInt(U) })
            await json(t.call("PUT", `${base(t)}/members/${w}`, { cookie: t.cookies.OWNER, body: { autoPay: true } }))
        }
        const wallet = fakeKeeperWallet()
        wallet.funded = false
        const logs: string[] = []
        const keeper = createPayrollKeeper({ db: t.deps.db, payroll: p, wallet, now: () => NOW, log: (m) => logs.push(m), maxPerRun: 2 })
        await keeper.runOnce()
        expect(wallet.claims).toHaveLength(0)
        expect(logs.some((l) => l.includes("low on MON"))).toBe(true)
        wallet.funded = true
        expect(await keeper.runOnce()).toMatchObject({ claimed: 2, skipped: 1 })
        expect(wallet.claims).toHaveLength(2)
    })
})
