// Team pay part 2: the payroll escrow (FairPayroll; server/payroll.ts). Mounted by teamPayRoutes.
//
// Owner only, like the rest of Team pay: every endpoint below answers anyone but the restaurant's
// owner with the same 404 as an unknown restaurant id, except /team-pay/escrow/mine, where a staff
// member reads their own position. After that check, a server whose deployment has no `payroll`
// contract answers 503 "not set up".
//
// The escrow's numbers are always read from the chain (employerInfo, employeeInfo, scheduleOf,
// fundingNeeded) and its history comes from the event indexer; the browser is never trusted for
// chain state. The owner's browser sends the escrow transactions itself. The one thing recorded
// from a transaction hash is a shift approval, and only after the ShiftApproved events verify.

import { Hono } from "hono"
import { FairPayError, payPeriodName, shiftIdFor } from "@fairpay/sdk"
import { getAddress, type Address, type Hash } from "viem"
import type {
    EscrowEvent,
    EscrowEventKind,
    EscrowEventPage,
    EscrowMember,
    EscrowPosition,
    EscrowSchedule,
    EscrowView,
    MyEscrowView,
    PayrollShift,
    ShiftApproveResult,
    StaffMember,
    Wallet
} from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { fmtUsdc, getRestaurant, loadStaff, roleFor, type RestaurantRow } from "../faireats.js"
import { bool, HttpError, int, limit, optStr, rateLimiter, readJson, wallet as walletInput } from "../http.js"
import { newId } from "../ids.js"
import type { EmployeeInfo, EmployerInfo, PayrollChain, PaySchedule } from "../payroll.js"
import { addActivity } from "./activity.js"
import { MAX_TEAM_PAYOUT, myPayLink } from "./teamPay.js"

const PAGE = 25
const MAX_PAGE = 100
const EVENT_ID = /^[1-9][0-9]{0,15}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CENT = 10_000
const DAY_MS = 86_400_000
/** Pending shifts one restaurant may hold; an approval takes at most 50 at a time. */
export const MAX_PENDING_SHIFTS = 500
/** Most people the owner's view reads from the chain (each costs two RPC reads). */
const MAX_MEMBERS = 60
const SUGGEST_DAYS = [7, 30]

export const NOT_SET_UP = "The payroll escrow isn't set up on this server yet."
const READ_FAILED = "Couldn't read the payroll escrow on Monad right now. Try again shortly."

/** Not found and not the owner get the same answer, so restaurant ids can't be probed. */
async function requireOwner(db: Db, id: string, me: Wallet): Promise<RestaurantRow> {
    const r = await getRestaurant(db, id)
    if (!r || r.owner_wallet !== me) throw new HttpError(404, "No restaurant with that id.")
    return r
}

function needPayroll(deps: Deps): PayrollChain {
    const p = deps.chain.payroll
    if (!p) throw new HttpError(503, NOT_SET_UP)
    return p
}

/** Chain reads: a failure is logged in one line and the client gets a fixed sentence. */
async function onChain<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch (err) {
        if (err instanceof HttpError) throw err
        console.error(`payroll ${what}:`, err instanceof Error ? err.message.split("\n")[0] : err)
        throw new HttpError(502, READ_FAILED)
    }
}

function pageSize(v: string | undefined) {
    if (v === undefined || v === "") return PAGE
    if (!/^[0-9]{1,3}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PAGE) throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE}.`)
    return Number(v)
}

function beforeId(v: string | undefined) {
    if (v === undefined) return null
    if (!EVENT_ID.test(v)) throw new HttpError(400, "before must be an event id.")
    return Number(v)
}

const num = (v: bigint) => Number(v)
const ms = (seconds: bigint) => Number(seconds) * 1000

export function toAccount(i: EmployerInfo) {
    return {
        balance: num(i.balance),
        available: num(i.available),
        owed: num(i.owed),
        shortfall: num(i.shortfall),
        fundedUntil: ms(i.fundedUntil),
        runwayUntil: i.runwayUntil === 0n ? null : ms(i.runwayUntil),
        payPerDay: num(i.payPerDay)
    }
}

export function toPosition(i: EmployeeInfo): EscrowPosition {
    return {
        claimable: num(i.claimable),
        earned: num(i.earned),
        shortfall: num(i.shortfall),
        scheduleEarned: num(i.scheduleEarned),
        debt: num(i.debt),
        nextPayAt: i.nextPeriodEnd === 0n ? null : ms(i.nextPeriodEnd)
    }
}

export function toSchedule(s: PaySchedule): EscrowSchedule | null {
    const period = payPeriodName(s.period)
    if (s.amountPerPeriod === 0n || period === null) return null
    return { amountPerPeriod: num(s.amountPerPeriod), period, start: ms(s.start) }
}

// ------------------------------------------------------------------ shifts

type ShiftRow = {
    id: string
    restaurant_id: string
    employee: Wallet
    employee_name: string
    shift_id: `0x${string}`
    work_date: string
    minutes: number | null
    note: string | null
    amount: number
    status: "pending" | "approved"
    created_at: number
    approved_tx: `0x${string}` | null
    approved_block: number | null
    approved_log_index: number | null
    approved_at: number | null
}

function toShift(r: ShiftRow): PayrollShift {
    return {
        id: r.id,
        wallet: r.employee,
        name: r.employee_name,
        workDate: r.work_date,
        minutes: r.minutes === null ? null : Number(r.minutes),
        note: r.note,
        amount: Number(r.amount),
        shiftId: r.shift_id,
        status: r.status,
        createdAt: Number(r.created_at),
        approved:
            r.status === "approved" && r.approved_tx
                ? { at: Number(r.approved_at), txHash: r.approved_tx, blockNumber: Number(r.approved_block), logIndex: Number(r.approved_log_index) }
                : null
    }
}

/** A calendar date, YYYY-MM-DD, from 2020 up to 31 days ahead of `now`. */
function workDate(v: unknown, now: number): string {
    const m = typeof v === "string" ? DATE.exec(v.trim()) : null
    if (!m) throw new HttpError(400, "Date must be YYYY-MM-DD.")
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const d = new Date(t)
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw new HttpError(400, "That date doesn't exist.")
    if (t < Date.UTC(2020, 0, 1) || t > now + 31 * DAY_MS) throw new HttpError(400, "Date must be between 2020 and a month from now.")
    return m[0]
}

// ------------------------------------------------------------------ events

type EventRow = {
    id: number
    chain_id: number
    block_number: number
    block_time: number
    tx_hash: `0x${string}`
    log_index: number
    event: string
    employee: Wallet | null
    caller: Wallet | null
    amount: string
    args: Record<string, string> | string
}

const KIND: Record<string, EscrowEventKind> = {
    Funded: "funded",
    Withdrawn: "withdrawn",
    ShiftApproved: "shift_approved",
    ScheduleSet: "schedule_set",
    ScheduleEnded: "schedule_ended",
    Claimed: "claimed",
    Shortfall: "shortfall",
    Underfunded: "underfunded",
    DebtBacked: "debt_backed",
    DebtRepaid: "debt_repaid",
    Resigned: "resigned"
}
/** Event arguments that are times (unix seconds), shown in milliseconds like every other time. */
const TIME_ARGS = new Set(["start", "origin", "fundedUntil"])
const NOT_DETAIL = new Set(["employer", "employee", "caller", "shiftId"])
/** Underfunded repeats on every escrow call while it is short; the account card shows the shortfall instead. */
const OWNER_EVENTS = "event <> 'Underfunded'"

function toEvent(r: EventRow, names: Map<string, string>): EscrowEvent {
    const args = typeof r.args === "string" ? (JSON.parse(r.args) as Record<string, string>) : r.args
    const detail: Record<string, number> = {}
    for (const [k, v] of Object.entries(args)) {
        if (NOT_DETAIL.has(k) || !/^[0-9]+$/.test(v)) continue
        detail[k] = TIME_ARGS.has(k) ? Number(v) * 1000 : Number(v)
    }
    return {
        id: Number(r.id),
        kind: KIND[r.event] ?? "funded",
        at: Number(r.block_time),
        amount: Number(r.amount),
        employee: r.employee ? { wallet: r.employee, name: names.get(r.employee) ?? null } : null,
        autoPaid: r.event === "Claimed" && !!r.caller && r.caller !== r.employee,
        detail,
        proof: { chainId: Number(r.chain_id), txHash: r.tx_hash, logIndex: Number(r.log_index), blockNumber: Number(r.block_number) }
    }
}

async function eventPage(
    db: Db,
    p: PayrollChain,
    chainId: number,
    employer: Wallet,
    size: number,
    before: number | null,
    names: Map<string, string>,
    employee?: Wallet
): Promise<EscrowEventPage> {
    const params: unknown[] = [chainId, p.address.toLowerCase(), employer, before ?? Number.MAX_SAFE_INTEGER]
    if (employee) params.push(employee)
    const rows = await db.query<EventRow>(
        `SELECT id, chain_id, block_number, block_time, tx_hash, log_index, event, employee, caller, amount, args FROM payroll_events
         WHERE chain_id = $1 AND contract = $2 AND employer = $3 AND id < $4 AND ${employee ? "employee = $5" : OWNER_EVENTS}
         ORDER BY id DESC LIMIT ${size + 1}`,
        params
    )
    const events = rows.slice(0, size).map((r) => toEvent(r, names))
    return { events, next: rows.length > size ? String(events[events.length - 1]!.id) : null }
}

/** Names for wallets in the history: the current staff list, then the names shifts were entered with. */
async function namesFor(db: Db, restaurantId: string, staff: StaffMember[]) {
    const names = new Map<string, string>()
    const shifts = await db.query<{ employee: string; employee_name: string }>(
        "SELECT DISTINCT ON (employee) employee, employee_name FROM payroll_shifts WHERE restaurant_id = $1 ORDER BY employee, created_at DESC",
        [restaurantId]
    )
    for (const s of shifts) names.set(s.employee, s.employee_name)
    for (const s of staff) names.set(s.wallet, s.displayName)
    return names
}

// ------------------------------------------------------------------ routes

export function payrollRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    // Each view costs several RPC reads; the browser refreshes after every escrow transaction.
    const limits = {
        view: rateLimiter(60, 60_000, deps.now),
        shifts: rateLimiter(120, 60_000, deps.now),
        approve: rateLimiter(60, 60_000, deps.now),
        approveWallet: rateLimiter(60, 60_000, deps.now)
    }
    const chainId = deps.chain.deployment.chainId

    app.get("/restaurants/:id/team-pay/escrow", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.view, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const p = needPayroll(deps)
        const contract = p.address.toLowerCase()
        const employer = getAddress(r.owner_wallet)

        const [staff, settings, pendingRows, approvedRows, seen, shared] = await Promise.all([
            loadStaff(db, r.id),
            db.query<{ wallet: Wallet; shift_rate: number | null; auto_pay: boolean }>("SELECT wallet, shift_rate, auto_pay FROM payroll_settings WHERE restaurant_id = $1", [r.id]),
            db.query<ShiftRow>(
                `SELECT * FROM payroll_shifts WHERE restaurant_id = $1 AND chain_id = $2 AND contract = $3 AND status = 'pending' ORDER BY work_date, created_at LIMIT ${MAX_PENDING_SHIFTS}`,
                [r.id, chainId, contract]
            ),
            db.query<ShiftRow>(
                "SELECT * FROM payroll_shifts WHERE restaurant_id = $1 AND chain_id = $2 AND contract = $3 AND status = 'approved' ORDER BY approved_at DESC, id LIMIT 50",
                [r.id, chainId, contract]
            ),
            // People this owner put on the escrow before: they may still have pay or a schedule.
            db.query<{ employee: Wallet }>(
                `SELECT employee FROM payroll_events WHERE chain_id = $1 AND contract = $2 AND employer = $3 AND employee IS NOT NULL
                 AND event IN ('ScheduleSet', 'ShiftApproved') GROUP BY employee ORDER BY MAX(id) DESC LIMIT ${MAX_MEMBERS}`,
                [chainId, contract, r.owner_wallet]
            ),
            db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurants WHERE owner_wallet = $1 AND id <> $2", [r.owner_wallet, r.id])
        ])
        const onStaff = new Set(staff.map((s) => s.wallet))
        const people: { wallet: Wallet; staff: StaffMember | null }[] = [
            ...staff.filter((s) => s.wallet !== r.owner_wallet).map((s) => ({ wallet: s.wallet, staff: s })),
            ...seen.filter((s) => !onStaff.has(s.employee) && s.employee !== r.owner_wallet).map((s) => ({ wallet: s.employee, staff: null }))
        ].slice(0, MAX_MEMBERS)
        const names = await namesFor(db, r.id, staff)

        const nowSec = Math.floor(deps.now() / 1000)
        const read = await onChain("view", async () => {
            const at = { blockNumber: await p.latestBlock() }
            const [account, suggestions, positions] = await Promise.all([
                p.employerInfo(employer, at),
                Promise.all(SUGGEST_DAYS.map((d) => p.fundingNeeded(employer, BigInt(nowSec + d * 86_400), at))),
                Promise.all(
                    people.map(async (x) => {
                        const w = getAddress(x.wallet)
                        const [info, schedule] = await Promise.all([p.employeeInfo(employer, w, at), p.scheduleOf(employer, w, at)])
                        return { info, schedule }
                    })
                )
            ])
            return { account, suggestions, positions }
        })

        const bySetting = new Map(settings.map((s) => [s.wallet, s]))
        const pendingBy = new Map<string, { count: number; amount: number }>()
        for (const s of pendingRows) {
            const x = pendingBy.get(s.employee) ?? { count: 0, amount: 0 }
            pendingBy.set(s.employee, { count: x.count + 1, amount: x.amount + Number(s.amount) })
        }
        const members: EscrowMember[] = []
        people.forEach((x, i) => {
            const { info, schedule } = read.positions[i]!
            const sched = toSchedule(schedule)
            // Someone who left is listed only while they have pay or a schedule here.
            if (!x.staff && !sched && info.earned === 0n) return
            const set = bySetting.get(x.wallet)
            members.push({
                wallet: x.wallet,
                name: x.staff?.displayName ?? names.get(x.wallet) ?? null,
                role: x.staff?.role ?? null,
                onStaff: !!x.staff,
                position: toPosition(info),
                schedule: sched,
                endedAt: schedule.endedAt === 0n ? null : ms(schedule.endedAt),
                shiftRate: set?.shift_rate == null ? null : Number(set.shift_rate),
                autoPay: !!set?.auto_pay && !!x.staff,
                pending: pendingBy.get(x.wallet) ?? { count: 0, amount: 0 }
            })
        })
        const page = await eventPage(db, p, chainId, r.owner_wallet, PAGE, null, names)
        const body: EscrowView = {
            contract: contract as Wallet,
            employer: r.owner_wallet,
            account: toAccount(read.account),
            members,
            pendingShifts: pendingRows.map(toShift),
            approvedShifts: approvedRows.map(toShift),
            suggestions: SUGGEST_DAYS.map((days, i) => ({ days, amount: num(read.suggestions[i]!) })),
            keeper: !!p.keeper,
            sharedWith: Number(shared?.n ?? 0),
            readAt: deps.now(),
            ...page
        }
        return c.json(body)
    })

    app.get("/restaurants/:id/team-pay/escrow/history", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        const p = needPayroll(deps)
        const names = await namesFor(db, r.id, await loadStaff(db, r.id))
        return c.json(await eventPage(db, p, chainId, r.owner_wallet, pageSize(c.req.query("limit")), beforeId(c.req.query("before")), names))
    })

    // Body: { wallet, workDate: "YYYY-MM-DD", minutes?, note?, amount (micro-USDC, whole cents) }.
    app.post("/restaurants/:id/team-pay/shifts", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.shifts, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const p = needPayroll(deps)
        const b = await readJson(c, 4 * 1024)
        const to = walletInput(b.wallet, "Staff wallet")
        const date = workDate(b.workDate, deps.now())
        const minutes = b.minutes === undefined || b.minutes === null ? null : int(b.minutes, { min: 1, max: 1440, name: "Minutes" })
        const note = optStr(b.note, { max: 140, name: "Note" })
        const amount = int(b.amount, { min: CENT, max: MAX_TEAM_PAYOUT, name: "Amount" })
        if (amount % CENT !== 0) throw new HttpError(400, "Amount must be whole cents.")
        if (to === r.owner_wallet) throw new HttpError(400, "You can't add shifts for your own wallet.")
        const contract = p.address.toLowerCase()

        const row = await db.tx(async (q) => {
            const staff = await q.one<{ display_name: string }>("SELECT display_name FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2 FOR UPDATE", [r.id, to])
            if (!staff) throw new HttpError(400, "That wallet isn't on this restaurant's staff.")
            const n = await q.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM payroll_shifts WHERE restaurant_id = $1 AND status = 'pending'", [r.id])
            if (Number(n?.n ?? 0) >= MAX_PENDING_SHIFTS) throw new HttpError(409, `At most ${MAX_PENDING_SHIFTS} shifts can wait for approval. Approve some first.`)
            const id = newId("ps")
            // A random server id makes the on-chain id unguessable and unique for this owner.
            const shiftId = shiftIdFor(`${chainId}:${contract}:${r.owner_wallet}:${id}`).toLowerCase()
            return q.one<ShiftRow>(
                `INSERT INTO payroll_shifts (id, restaurant_id, chain_id, contract, employer, employee, employee_name, shift_id, work_date, minutes, note, amount, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
                [id, r.id, chainId, contract, r.owner_wallet, to, staff.display_name, shiftId, date, minutes, note, amount, deps.now()]
            )
        })
        return c.json(toShift(row!), 201)
    })

    // Only a pending shift can be removed; an approved one is on-chain and stays.
    app.delete("/restaurants/:id/team-pay/shifts/:shiftId", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.shifts, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        needPayroll(deps)
        const row = await db.one<{ status: string }>("SELECT status FROM payroll_shifts WHERE id = $1 AND restaurant_id = $2", [c.req.param("shiftId"), r.id])
        if (!row) throw new HttpError(404, "No shift with that id.")
        if (row.status !== "pending") throw new HttpError(409, "That shift is approved on-chain and can't be removed.")
        await db.query("DELETE FROM payroll_shifts WHERE id = $1 AND restaurant_id = $2 AND status = 'pending'", [c.req.param("shiftId"), r.id])
        return c.json({ ok: true })
    })

    // Body: { txHash } of the owner's approveShifts. Answers 202 "pending" until it has the
    // confirmations; the browser asks again. Marks approved exactly the pending shifts of this
    // restaurant whose shiftId, employee and amount the transaction's ShiftApproved events carry.
    app.post("/restaurants/:id/team-pay/shifts/approve", async (c) => {
        limit(c, limits.approve)
        const me = requireWallet(c)
        limit(c, limits.approveWallet, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const p = needPayroll(deps)
        const b = await readJson(c, 1024)
        if (typeof b.txHash !== "string" || !HASH32.test(b.txHash)) throw new HttpError(400, "txHash must be a transaction hash.")
        const txHash = b.txHash.toLowerCase() as Hash
        const contract = p.address.toLowerCase()

        let v: Awaited<ReturnType<PayrollChain["verifyShiftApprovals"]>>
        try {
            v = await p.verifyShiftApprovals({ txHash, employer: getAddress(r.owner_wallet) })
        } catch (err) {
            if (err instanceof FairPayError && err.code === "INVALID_INPUT") throw new HttpError(400, "Malformed transaction.")
            console.error("shift approval verification:", err instanceof Error ? err.message.split("\n")[0] : err)
            throw new HttpError(502, "Could not check the approval on-chain right now. Try again shortly.")
        }
        if (v.status === "pending") return c.json({ status: "pending", reason: "Waiting for the transaction to be confirmed." } satisfies ShiftApproveResult, 202)
        if (v.status === "rejected") return c.json({ status: "rejected", reason: `Not recorded: ${v.reason}.` } satisfies ShiftApproveResult)
        if (v.chainId !== chainId) return c.json({ status: "rejected", reason: "Not recorded: wrong chain." } satisfies ShiftApproveResult)
        const verified = v

        const now = deps.now()
        const result = await db.tx(async (q): Promise<ShiftApproveResult> => {
            const fresh: ShiftRow[] = []
            for (const s of verified.shifts) {
                const row = await q.one<ShiftRow>(
                    `UPDATE payroll_shifts SET status = 'approved', approved_tx = $6, approved_block = $7, approved_log_index = $8, approved_at = $9
                     WHERE restaurant_id = $1 AND chain_id = $2 AND contract = $3 AND employer = $4 AND shift_id = $5
                       AND employee = $10 AND amount = $11::bigint AND status = 'pending'
                     RETURNING *`,
                    [r.id, chainId, contract, r.owner_wallet, s.shiftId, txHash, String(verified.blockNumber), s.logIndex, now, s.employee.toLowerCase(), String(s.amount)]
                )
                if (row) fresh.push(row)
            }
            // Shifts this transaction approved earlier (a retry, or the indexer was first).
            const all = await q.query<ShiftRow>("SELECT * FROM payroll_shifts WHERE restaurant_id = $1 AND approved_tx = $2 ORDER BY approved_log_index", [r.id, txHash])
            if (all.length === 0) return { status: "rejected", reason: "Not recorded: this transaction approved none of this restaurant's shifts." }
            const byPerson = new Map<string, number>()
            for (const s of fresh) byPerson.set(s.employee, (byPerson.get(s.employee) ?? 0) + Number(s.amount))
            for (const [w, total] of byPerson) {
                await addActivity(
                    q,
                    {
                        wallet: w as Wallet,
                        kind: "payment_received",
                        title: `${r.name} approved ${fmtUsdc(total)} USDC of shift pay`,
                        detail: "It's in the payroll escrow for you. Claim it in My pay.",
                        link: myPayLink(r.id)
                    },
                    now
                )
            }
            return { status: "recorded", shifts: all.map(toShift) }
        })
        return c.json(result)
    })

    // Body: { shiftRate?: micro-USDC | null, autoPay?: boolean } for one staff member.
    app.put("/restaurants/:id/team-pay/members/:wallet", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.shifts, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const p = needPayroll(deps)
        const w = walletInput(c.req.param("wallet"), "Staff wallet")
        const b = await readJson(c, 1024)
        const staff = await db.one("SELECT 1 FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2", [r.id, w])
        if (!staff || w === r.owner_wallet) throw new HttpError(400, "That wallet isn't on this restaurant's staff.")
        const cur = await db.one<{ shift_rate: number | null; auto_pay: boolean }>("SELECT shift_rate, auto_pay FROM payroll_settings WHERE restaurant_id = $1 AND wallet = $2", [r.id, w])
        let shiftRate = cur?.shift_rate == null ? null : Number(cur.shift_rate)
        let autoPay = !!cur?.auto_pay
        if (b.shiftRate !== undefined) {
            shiftRate = b.shiftRate === null ? null : int(b.shiftRate, { min: CENT, max: MAX_TEAM_PAYOUT, name: "Amount per shift" })
            if (shiftRate !== null && shiftRate % CENT !== 0) throw new HttpError(400, "Amount per shift must be whole cents.")
        }
        if (b.autoPay !== undefined) {
            autoPay = bool(b.autoPay, "autoPay")
            if (autoPay && !p.keeper) throw new HttpError(409, "Auto-pay isn't available on this server.")
        }
        await db.query(
            `INSERT INTO payroll_settings (restaurant_id, wallet, shift_rate, auto_pay, updated_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (restaurant_id, wallet) DO UPDATE SET shift_rate = excluded.shift_rate, auto_pay = excluded.auto_pay, updated_at = excluded.updated_at`,
            [r.id, w, shiftRate, autoPay, deps.now()]
        )
        return c.json({ wallet: w, shiftRate, autoPay })
    })

    // ---------------------------------------------------------------- staff: my position

    /** The restaurant, if `me` works there now or has escrow pay or shifts from its owner. */
    async function myRestaurant(id: string, me: Wallet) {
        const r = await getRestaurant(db, id)
        if (!r || r.owner_wallet === me) throw new HttpError(404, "No restaurant with that id.")
        const role = await roleFor(db, r.id, me)
        if (role !== null) return r
        const p = deps.chain.payroll
        const known =
            (await db.one("SELECT 1 FROM payroll_shifts WHERE restaurant_id = $1 AND employee = $2 LIMIT 1", [r.id, me])) ??
            (p
                ? await db.one("SELECT 1 FROM payroll_events WHERE chain_id = $1 AND contract = $2 AND employer = $3 AND employee = $4 LIMIT 1", [
                      chainId,
                      p.address.toLowerCase(),
                      r.owner_wallet,
                      me
                  ])
                : undefined)
        if (!known) throw new HttpError(404, "No restaurant with that id.")
        return r
    }

    app.get("/restaurants/:id/team-pay/escrow/mine", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.view, me)
        const r = await myRestaurant(c.req.param("id"), me)
        const p = needPayroll(deps)
        const employer = getAddress(r.owner_wallet)
        const self: Address = getAddress(me)
        const read = await onChain("my view", async () => {
            const at = { blockNumber: await p.latestBlock() }
            const [info, schedule] = await Promise.all([p.employeeInfo(employer, self, at), p.scheduleOf(employer, self, at)])
            return { info, schedule }
        })
        const [setting, shifts, names] = await Promise.all([
            db.one<{ auto_pay: boolean }>("SELECT auto_pay FROM payroll_settings WHERE restaurant_id = $1 AND wallet = $2", [r.id, me]),
            db.query<ShiftRow>(
                "SELECT * FROM payroll_shifts WHERE restaurant_id = $1 AND employee = $2 AND chain_id = $3 AND contract = $4 ORDER BY work_date DESC, created_at DESC LIMIT 50",
                [r.id, me, chainId, p.address.toLowerCase()]
            ),
            namesFor(db, r.id, await loadStaff(db, r.id))
        ])
        const page = await eventPage(db, p, chainId, r.owner_wallet, PAGE, null, names, me)
        const body: MyEscrowView = {
            contract: p.address.toLowerCase() as Wallet,
            employer: r.owner_wallet,
            position: toPosition(read.info),
            schedule: toSchedule(read.schedule),
            autoPay: !!setting?.auto_pay && !!p.keeper,
            shifts: shifts.map(toShift),
            readAt: deps.now(),
            ...page
        }
        return c.json(body)
    })

    app.get("/restaurants/:id/team-pay/escrow/mine/history", async (c) => {
        const me = requireWallet(c)
        const r = await myRestaurant(c.req.param("id"), me)
        const p = needPayroll(deps)
        const names = await namesFor(db, r.id, await loadStaff(db, r.id))
        return c.json(await eventPage(db, p, chainId, r.owner_wallet, pageSize(c.req.query("limit")), beforeId(c.req.query("before")), names, me))
    })

    return app
}
