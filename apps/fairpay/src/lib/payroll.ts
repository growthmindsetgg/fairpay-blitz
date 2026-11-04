// Team pay's payroll escrow in the browser (FairPayroll). The owner's connected wallet funds,
// withdraws, approves shifts and sets schedules; a staff member's wallet claims. Every write is
// simulated first by the SDK and sent with a gas limit close to the estimate. The server reads the
// escrow from the chain itself and records a shift approval only after it verifies on-chain
// (server/routes/payroll.ts); nothing here is trusted by it.

import {
    approveShifts as sdkApproveShifts,
    claimPay,
    endPaySchedule,
    erc20Abi,
    fundPayroll,
    resignPayroll,
    setPaySchedule,
    withdrawPayroll,
    type Clients,
    type PayPeriod,
    type PayrollDeployment
} from "@fairpay/sdk"
import { getAddress, type Hash } from "viem"
import type { PayrollShift } from "../../shared/types"
import { ApiError, escrowApi } from "./api"
import { usdc } from "./format"
import { NeedFundsError, PaymentRejectedError } from "./payments"
import type { Deployment } from "./wallet"

export const ESCROW_STEPS = ["Check your wallet", "Confirm in your wallet", "Confirm on Monad"]
export const APPROVE_STEPS = ["Check your wallet", "Confirm in your wallet", "Verify on Monad"]

// Gas limits these calls can need (Monad charges the full limit; the SDK uses the estimate plus
// 15%). Slightly generous: the check only stops a wallet that would fail anyway.
const GAS = { approve: 80_000n, fund: 200_000n, withdraw: 150_000n, schedule: 250_000n, end: 200_000n, claim: 200_000n, shiftBase: 80_000n, shift: 60_000n }

const mon3 = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toFixed(3)

export function payrollDeployment(d: Deployment): PayrollDeployment {
    if (!d.payroll) throw new Error("The payroll escrow isn't set up on this server yet.")
    return { ...d, payroll: d.payroll }
}

async function assertGas(clients: Clients, gas: bigint, usdcNeeded?: { token: `0x${string}`; amount: bigint }) {
    const address = clients.walletClient.account.address
    const [mon, fees, bal] = await Promise.all([
        clients.publicClient.getBalance({ address }),
        clients.publicClient.estimateFeesPerGas(),
        usdcNeeded ? clients.publicClient.readContract({ address: usdcNeeded.token, abi: erc20Abi, functionName: "balanceOf", args: [address] }) : Promise.resolve(0n)
    ])
    if (usdcNeeded && bal < usdcNeeded.amount) {
        throw new NeedFundsError("usdc", `Your wallet has ${usdc(Number(bal))}, and this needs ${usdc(Number(usdcNeeded.amount))}. Get test USDC, then try again.`)
    }
    const need = gas * (fees.maxFeePerGas ?? 0n)
    if (mon === 0n || mon < need) {
        throw new NeedFundsError("gas", `This needs about ${mon3(need)} MON for gas, and your wallet has ${mon3(mon)}. Get test funds, then try again.`)
    }
}

async function confirmed(clients: Clients, hash: Hash) {
    const r = await clients.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
    if (r.status !== "success") throw new Error("The transaction reverted on Monad. Nothing changed.")
    return r
}

/** Contract errors a person can act on; anything else goes through the usual friendly(). */
const REASONS: [RegExp, string][] = [
    [/InsufficientAvailable/, "Not enough available money in the escrow for this. Add to the escrow first."],
    [/AccountUnderfunded/, "The escrow is short of what your staff have earned. Add the shortfall first, then try again."],
    [/InvalidStart/, "That start date isn't allowed: at most 30 days back (new schedules only, not before the last one ended) or 30 days ahead."],
    [/NothingToClaim/, "There is nothing to claim right now."],
    [/NoSchedule/, "There is no schedule running for this person."],
    [/ShiftAlreadyApproved/, "One of these shifts is already approved on-chain. Refresh, then try again."],
    [/BatchTooLarge/, "At most 50 shifts per approval."],
    [/InvalidPeriod/, "Pick daily, weekly or monthly."],
    [/AmountTooLarge|BalanceTooLarge/, "That amount is too large."],
    [/WrongChain/, "Your wallet is on another network. Switch to Monad Testnet and try again."],
    [/ERC20InsufficientAllowance/, "The USDC approval didn't go through. Try again."],
    [/ERC20InsufficientBalance/, "Your wallet doesn't have enough USDC for this."]
]

/** A sentence for a contract revert, or null when it isn't one we know. */
export function payrollReason(e: unknown): string | null {
    const err = (e ?? {}) as { shortMessage?: string; details?: string; message?: string; metaMessages?: string[] }
    const all = `${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? ""} ${(err.metaMessages ?? []).join(" ")}`
    for (const [re, text] of REASONS) if (re.test(all)) return text
    return null
}

type Step = (index: number, detail?: string) => void

// ------------------------------------------------------------------ owner

export async function fundEscrow(d: Deployment, clients: Clients, amount: number, onStep: Step) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.approve + GAS.fund, { token: d.token, amount: BigInt(amount) })
    onStep(1, `Your wallet may ask twice: allow ${usdc(amount)} for the escrow, then add it.`)
    const { txHash } = await fundPayroll(pd, clients, BigInt(amount))
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

export async function withdrawEscrow(d: Deployment, clients: Clients, onStep: Step) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.withdraw)
    onStep(1, "Your wallet asks once: withdraw everything available.")
    const { txHash } = await withdrawPayroll(pd, clients, "max")
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

export async function setSchedule(
    d: Deployment,
    clients: Clients,
    p: { employee: `0x${string}`; amountPerPeriod: number; period: PayPeriod; start: number | null; name: string },
    onStep: Step
) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.schedule)
    onStep(1, `Your wallet asks once: pay ${p.name} ${usdc(p.amountPerPeriod)} per ${p.period === "month" ? "30 days" : p.period}.`)
    const { txHash } = await setPaySchedule(pd, clients, {
        employee: getAddress(p.employee),
        amountPerPeriod: BigInt(p.amountPerPeriod),
        period: p.period,
        // 0 = now; a change always starts now.
        start: p.start === null ? 0n : BigInt(Math.floor(p.start / 1000))
    })
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

export async function endSchedule(d: Deployment, clients: Clients, p: { employee: `0x${string}`; name: string }, onStep: Step) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.end)
    onStep(1, `Your wallet asks once: end ${p.name}'s schedule now.`)
    const { txHash } = await endPaySchedule(pd, clients, getAddress(p.employee))
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Approves up to 50 pending shifts in one transaction, then waits for FairPay to verify the
 * ShiftApproved events and mark them approved. If this page closes before that, the server's
 * event indexer marks them approved anyway once it reads the block.
 */
export async function approveShifts(d: Deployment, clients: Clients, restaurantId: string, shifts: PayrollShift[], onStep: Step) {
    const pd = payrollDeployment(d)
    if (shifts.length === 0) throw new Error("Pick the shifts to approve.")
    if (shifts.length > 50) throw new Error("At most 50 shifts per approval.")
    onStep(0)
    await assertGas(clients, GAS.shiftBase + GAS.shift * BigInt(shifts.length))
    const total = shifts.reduce((s, x) => s + x.amount, 0)
    onStep(1, `Your wallet asks once: approve ${shifts.length === 1 ? "1 shift" : `${shifts.length} shifts`}, ${usdc(total)} in all.`)
    const { txHash } = await sdkApproveShifts(
        pd,
        clients,
        shifts.map((s) => ({ employee: getAddress(s.wallet), shiftId: s.shiftId, amount: BigInt(s.amount) }))
    )
    onStep(2, "Waiting for 2 confirmations, usually a few seconds.")
    for (let i = 0; i < 60; i++) {
        let r: Awaited<ReturnType<typeof escrowApi.approveShifts>> | null = null
        try {
            r = await escrowApi.approveShifts(restaurantId, txHash)
        } catch (err) {
            const transient = err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504)
            if (!transient || i === 59) throw err
        }
        if (r?.status === "recorded") return { txHash, shifts: r.shifts }
        if (r?.status === "rejected") throw new PaymentRejectedError(r.reason)
        await sleep(2000)
    }
    throw new ApiError(504, "The approval was sent but is taking longer than usual to confirm. FairPay will pick it up from the chain.")
}

// ------------------------------------------------------------------ staff

export async function claimEscrow(d: Deployment, clients: Clients, employer: `0x${string}`, onStep: Step) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.claim)
    onStep(1, "Your wallet asks once: claim your pay.")
    const { txHash } = await claimPay(pd, clients, getAddress(employer))
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

/** Leaves the owner's payroll: ends your own schedule now, pay for the time worked stays yours. */
export async function leavePayroll(d: Deployment, clients: Clients, employer: `0x${string}`, onStep: Step) {
    const pd = payrollDeployment(d)
    onStep(0)
    await assertGas(clients, GAS.end)
    onStep(1, "Your wallet asks once: end your pay schedule here.")
    const { txHash } = await resignPayroll(pd, clients, getAddress(employer))
    onStep(2, "Waiting for Monad, usually a few seconds.")
    await confirmed(clients, txHash)
    return txHash
}

// ------------------------------------------------------------------ words

export const PERIOD_LABEL: Record<PayPeriod, string> = { day: "day", week: "week", month: "30 days" }
export const PERIOD_ADJ: Record<PayPeriod, string> = { day: "Daily", week: "Weekly", month: "Monthly (30 days)" }
