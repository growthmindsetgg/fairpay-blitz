// FairPayroll (packages/contracts/contracts/FairPayroll.sol): a payroll escrow in the deployment's
// token. Any wallet is an employer; state is keyed by (employer, employee). Employers fund it, pay
// per shift (approveShifts) or on a schedule (setSchedule, per DAY / WEEK / MONTH = 30 days), and
// employees claim. Anyone may claimFor an employee; the money always goes to the employee.
//
// Writes here are simulated first and sent with a gas limit close to the estimate (sendSimulated),
// because Monad charges the full gas limit. Amounts are in the token's smallest unit (micro-USDC).

import { getAddress, isAddress, keccak256, parseAbi, toBytes, zeroAddress, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { erc20Abi } from "./abi.js"
import { assertChain, sendSimulated, waitForSent, type Clients } from "./chain.js"
import { FairPayError, type FairPayDeployment } from "./config.js"

export const fairPayrollAbi = parseAbi([
    "struct Shift { address employee; bytes32 shiftId; uint256 amount; }",
    "struct Schedule { uint96 amountPerPeriod; uint32 period; uint40 start; uint40 origin; uint40 endedAt; uint256 paid; }",
    "struct EmployerInfo { uint256 balance; uint256 available; uint256 owed; uint256 shortfall; uint256 fundedUntil; uint256 runwayUntil; uint256 payPerDay; }",
    "struct EmployeeInfo { uint256 claimable; uint256 earned; uint256 shortfall; uint256 settled; uint256 debt; uint256 scheduleEarned; uint256 nextPeriodEnd; }",
    "function DAY() view returns (uint256)",
    "function WEEK() view returns (uint256)",
    "function MONTH() view returns (uint256)",
    "function MAX_SHIFTS() view returns (uint256)",
    "function MAX_START_OFFSET() view returns (uint256)",
    "function SCALE() view returns (uint256)",
    "function token() view returns (address)",
    "function deployChainId() view returns (uint256)",
    "function shiftApproved(address employer, bytes32 shiftId) view returns (bool)",
    "function available(address employer) view returns (uint256)",
    "function fundingNeeded(address employer, uint256 until) view returns (uint256)",
    "function employerInfo(address employer) view returns (EmployerInfo info)",
    "function employeeInfo(address employer, address employee) view returns (EmployeeInfo info)",
    "function scheduleOf(address employer, address employee) view returns (Schedule)",
    "function fund(uint256 amount)",
    "function withdraw(uint256 amount) returns (uint256)",
    "function approveShifts(Shift[] shifts)",
    "function setSchedule(address employee, uint256 amountPerPeriod, uint256 period, uint256 start)",
    "function endSchedule(address employee)",
    "function claim(address employer) returns (uint256)",
    "function claimFor(address employer, address employee) returns (uint256)",
    // The caller (an employee) ends their own schedule with this employer, settled pro rata.
    "function resign(address employer)",
    "event Funded(address indexed employer, uint256 amount)",
    "event Withdrawn(address indexed employer, uint256 amount)",
    "event ShiftApproved(address indexed employer, address indexed employee, bytes32 indexed shiftId, uint256 amount)",
    "event ScheduleSet(address indexed employer, address indexed employee, uint256 amountPerPeriod, uint256 period, uint256 start, uint256 origin, uint256 upfront)",
    "event ScheduleEnded(address indexed employer, address indexed employee, uint256 settled, uint256 debt)",
    "event Claimed(address indexed employer, address indexed employee, address indexed caller, uint256 amount, uint256 fromSchedule, uint256 fromDebt)",
    "event Shortfall(address indexed employer, address indexed employee, uint256 unpaid)",
    "event Underfunded(address indexed employer, uint256 fundedUntil, uint256 shortfall)",
    "event DebtBacked(address indexed employer, uint256 amount, uint256 debtLeft)",
    "event DebtRepaid(address indexed employer, address indexed employee, uint256 amount)",
    "event Resigned(address indexed employer, address indexed employee)",
    "error WrongChain()",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error ZeroShiftId()",
    "error InvalidEmployee()",
    "error AmountMismatch()",
    "error AmountTooLarge()",
    "error BalanceTooLarge()",
    "error EmptyBatch()",
    "error BatchTooLarge()",
    "error ShiftAlreadyApproved(bytes32 shiftId)",
    "error InsufficientAvailable(uint256 available, uint256 needed)",
    "error InvalidPeriod()",
    "error InvalidStart()",
    "error AccountUnderfunded()",
    "error NoSchedule()",
    "error NothingToClaim()",
    "error ReentrancyGuardReentrantCall()",
    "error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)",
    "error SafeERC20FailedOperation(address token)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"
])

/** Pay periods in seconds, as the contract takes them. MONTH is a fixed 30 days. */
export const PAY_PERIOD = { day: 86_400n, week: 604_800n, month: 2_592_000n } as const
export type PayPeriod = keyof typeof PAY_PERIOD
/** Most shifts one approveShifts call takes. */
export const MAX_SHIFTS = 50
/** A schedule may start at most this far in the past (a new one only) or the future, in seconds. */
export const MAX_START_OFFSET = 30n * 86_400n

/** The name of a period in seconds, or null when the contract wouldn't take it. */
export function payPeriodName(seconds: bigint | number): PayPeriod | null {
    const s = BigInt(seconds)
    for (const [k, v] of Object.entries(PAY_PERIOD)) if (v === s) return k as PayPeriod
    return null
}

export type PayrollDeployment = FairPayDeployment & { payroll: Address }

export type EmployerInfo = {
    /** Tokens held for the employer. */
    balance: bigint
    /** Withdrawable (or spendable on shifts) now. */
    available: bigint
    /** Set aside for staff or owed to them: balance - available + shortfall. */
    owed: bigint
    /** What the employer must fund for all pay to be set aside up to now. */
    shortfall: bigint
    /** Schedule pay is set aside up to this time (unix seconds). */
    fundedUntil: bigint
    /** When the free balance runs out at today's rates (unix seconds; 0: no schedules). */
    runwayUntil: bigint
    /** What all running schedules cost per day, rounded up. */
    payPerDay: bigint
}

export type EmployeeInfo = {
    /** What claim() would pay now. */
    claimable: bigint
    /** Everything owed to the employee by this employer up to now. */
    earned: bigint
    /** earned - claimable: earned but not funded yet. */
    shortfall: bigint
    settled: bigint
    debt: bigint
    /** Unpaid pay from completed periods of the running schedule. */
    scheduleEarned: bigint
    /** When the running schedule's next period completes (unix seconds; 0: no schedule). */
    nextPeriodEnd: bigint
}

export type PaySchedule = {
    /** 0 when no schedule is running. */
    amountPerPeriod: bigint
    period: bigint
    start: bigint
    origin: bigint
    /** When this pair's previous schedule ended (a new one can't start earlier). */
    endedAt: bigint
    paid: bigint
}

export type ShiftInput = { employee: Address; shiftId: Hex; amount: bigint }

type Reader = Pick<PublicClient, "readContract">
type ReadOptions = { blockNumber?: bigint }

function payrollOf(d: { payroll?: Address }): Address {
    if (!d.payroll || !isAddress(d.payroll)) throw new FairPayError("INVALID_INPUT", "this deployment has no payroll contract")
    return getAddress(d.payroll)
}

function addr(v: string, what: string): Address {
    if (!isAddress(v)) throw new FairPayError("INVALID_INPUT", `${what} is not an address`)
    const a = getAddress(v)
    if (a === zeroAddress) throw new FairPayError("INVALID_INPUT", `${what} is the zero address`)
    return a
}

/**
 * A shift id the contract accepts (non-zero bytes32) from a unique label, e.g. a server-generated
 * random id. The contract pays one shiftId at most once per employer, so labels must never repeat.
 */
export function shiftIdFor(label: string): Hex {
    if (typeof label !== "string" || label.length < 8) throw new FairPayError("INVALID_INPUT", "shift label must be at least 8 characters")
    return keccak256(toBytes(`fairpay-shift:${label}`))
}

// ------------------------------------------------------------------ reads

export async function readEmployerInfo(d: { payroll?: Address }, client: Reader, employer: Address, o: ReadOptions = {}): Promise<EmployerInfo> {
    const r = await client.readContract({ address: payrollOf(d), abi: fairPayrollAbi, functionName: "employerInfo", args: [addr(employer, "employer")], ...o })
    return { ...r }
}

export async function readEmployeeInfo(
    d: { payroll?: Address },
    client: Reader,
    employer: Address,
    employee: Address,
    o: ReadOptions = {}
): Promise<EmployeeInfo> {
    const r = await client.readContract({
        address: payrollOf(d),
        abi: fairPayrollAbi,
        functionName: "employeeInfo",
        args: [addr(employer, "employer"), addr(employee, "employee")],
        ...o
    })
    return { ...r }
}

export async function readSchedule(d: { payroll?: Address }, client: Reader, employer: Address, employee: Address, o: ReadOptions = {}): Promise<PaySchedule> {
    const r = await client.readContract({
        address: payrollOf(d),
        abi: fairPayrollAbi,
        functionName: "scheduleOf",
        args: [addr(employer, "employer"), addr(employee, "employee")],
        ...o
    })
    return {
        amountPerPeriod: BigInt(r.amountPerPeriod),
        period: BigInt(r.period),
        start: BigInt(r.start),
        origin: BigInt(r.origin),
        endedAt: BigInt(r.endedAt),
        paid: r.paid
    }
}

/** Tokens to fund now so all debt is backed and running schedules are set aside up to `until` (unix seconds). */
export async function readFundingNeeded(d: { payroll?: Address }, client: Reader, employer: Address, until: bigint, o: ReadOptions = {}): Promise<bigint> {
    return client.readContract({ address: payrollOf(d), abi: fairPayrollAbi, functionName: "fundingNeeded", args: [addr(employer, "employer"), until], ...o })
}

// ------------------------------------------------------------------ employer writes

/**
 * Adds `amount` to the connected wallet's escrow: approves exactly that amount when the allowance
 * is short (never an unlimited one), waits for it, then sends fund().
 */
export async function fundPayroll(d: PayrollDeployment, clients: Clients, amount: bigint): Promise<{ txHash: Hash; approveTxHash?: Hash }> {
    if (amount <= 0n) throw new FairPayError("INVALID_INPUT", "amount must be positive")
    const payroll = payrollOf(d)
    await assertChain(d, clients)
    const owner = clients.walletClient.account.address
    const allowance = await clients.publicClient.readContract({ address: d.token, abi: erc20Abi, functionName: "allowance", args: [owner, payroll] })
    let approveTxHash: Hash | undefined
    if (allowance < amount) {
        approveTxHash = await sendSimulated(clients, { address: d.token, abi: erc20Abi, functionName: "approve", args: [payroll, amount] })
        const r = await waitForSent(clients, approveTxHash)
        if (r.status !== "success") throw new FairPayError("INVALID_INPUT", "the token approval reverted")
    }
    const txHash = await sendSimulated(clients, { address: payroll, abi: fairPayrollAbi, functionName: "fund", args: [amount] })
    return { txHash, approveTxHash }
}

/** Withdraws `amount`, or everything available when the call runs ("max"). */
export async function withdrawPayroll(d: PayrollDeployment, clients: Clients, amount: bigint | "max"): Promise<{ txHash: Hash }> {
    const value = amount === "max" ? 2n ** 256n - 1n : amount
    if (value <= 0n) throw new FairPayError("INVALID_INPUT", "amount must be positive")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payrollOf(d), abi: fairPayrollAbi, functionName: "withdraw", args: [value] })
    return { txHash }
}

/** Approves up to MAX_SHIFTS shifts in one transaction. Ids must be unique and non-zero. */
export async function approveShifts(d: PayrollDeployment, clients: Clients, shifts: ShiftInput[]): Promise<{ txHash: Hash }> {
    if (shifts.length === 0) throw new FairPayError("INVALID_INPUT", "no shifts to approve")
    if (shifts.length > MAX_SHIFTS) throw new FairPayError("INVALID_INPUT", `at most ${MAX_SHIFTS} shifts per approval`)
    const seen = new Set<string>()
    const args = shifts.map((s) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(s.shiftId) || BigInt(s.shiftId) === 0n) throw new FairPayError("INVALID_INPUT", "shiftId must be a non-zero bytes32")
        const id = s.shiftId.toLowerCase()
        if (seen.has(id)) throw new FairPayError("INVALID_INPUT", "the same shiftId twice")
        seen.add(id)
        if (s.amount <= 0n) throw new FairPayError("INVALID_INPUT", "shift amount must be positive")
        return { employee: addr(s.employee, "employee"), shiftId: s.shiftId, amount: s.amount }
    })
    const payroll = payrollOf(d)
    if (args.some((s) => s.employee === payroll)) throw new FairPayError("INVALID_INPUT", "employee cannot be the payroll contract")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payroll, abi: fairPayrollAbi, functionName: "approveShifts", args: [args] })
    return { txHash }
}

/**
 * Pays `employee` `amountPerPeriod` per completed period from `start` (unix seconds; 0 or omitted
 * = now). Changing a running schedule settles it up to now, so pass 0 (or a later time) then.
 */
export async function setPaySchedule(
    d: PayrollDeployment,
    clients: Clients,
    p: { employee: Address; amountPerPeriod: bigint; period: PayPeriod | bigint; start?: bigint }
): Promise<{ txHash: Hash }> {
    const period = typeof p.period === "bigint" ? p.period : PAY_PERIOD[p.period]
    if (payPeriodName(period) === null) throw new FairPayError("INVALID_INPUT", "period must be a day, a week or 30 days")
    if (p.amountPerPeriod <= 0n || p.amountPerPeriod >= 2n ** 96n) throw new FairPayError("INVALID_INPUT", "amountPerPeriod out of range")
    const start = p.start ?? 0n
    if (start < 0n) throw new FairPayError("INVALID_INPUT", "start must be 0 or a unix time")
    const employee = addr(p.employee, "employee")
    const payroll = payrollOf(d)
    if (employee === payroll) throw new FairPayError("INVALID_INPUT", "employee cannot be the payroll contract")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payroll, abi: fairPayrollAbi, functionName: "setSchedule", args: [employee, p.amountPerPeriod, period, start] })
    return { txHash }
}

/** Stops `employee`'s schedule now; pay for the time worked (the period in progress pro rata) stays owed. */
export async function endPaySchedule(d: PayrollDeployment, clients: Clients, employee: Address): Promise<{ txHash: Hash }> {
    const e = addr(employee, "employee")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payrollOf(d), abi: fairPayrollAbi, functionName: "endSchedule", args: [e] })
    return { txHash }
}

// ------------------------------------------------------------------ employee writes

/** The connected wallet claims everything `employer` owes it that is funded. */
export async function claimPay(d: PayrollDeployment, clients: Clients, employer: Address): Promise<{ txHash: Hash }> {
    const e = addr(employer, "employer")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payrollOf(d), abi: fairPayrollAbi, functionName: "claim", args: [e] })
    return { txHash }
}

/**
 * The connected wallet leaves `employer`'s payroll: ends its own schedule now, pay for the time
 * worked settled pro rata, like endSchedule: funded pay becomes claimable, unfunded pay joins the
 * employer's debt pool, repaid pro rata with everyone else's. Reverts NoSchedule without one.
 */
export async function resignPayroll(d: PayrollDeployment, clients: Clients, employer: Address): Promise<{ txHash: Hash }> {
    const e = addr(employer, "employer")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payrollOf(d), abi: fairPayrollAbi, functionName: "resign", args: [e] })
    return { txHash }
}

/** Claims for `employee` (a keeper doing auto-pay). The money goes to the employee, never the caller. */
export async function claimPayFor(d: PayrollDeployment, clients: Clients, employer: Address, employee: Address): Promise<{ txHash: Hash }> {
    const er = addr(employer, "employer")
    const ee = addr(employee, "employee")
    await assertChain(d, clients)
    const txHash = await sendSimulated(clients, { address: payrollOf(d), abi: fairPayrollAbi, functionName: "claimFor", args: [er, ee] })
    return { txHash }
}
