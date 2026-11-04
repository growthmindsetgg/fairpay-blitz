import type { Hash } from "viem"
import { FairPayError } from "./config.js"
import type { PrivatePaymentRequest } from "./pool.js"

export { fairPayAbi, fairPoolAbi, fairPoolBatcherAbi, erc20Abi } from "./abi.js"
export { FairPayError, type FairPayDeployment, type LogScanOptions } from "./config.js"
export type { Clients } from "./chain.js"
export { sendSimulated, waitForSent } from "./chain.js"
export { createOrderRef, randomSecret } from "./refs.js"
export { payPublic } from "./public.js"
export {
    createNote,
    serializeNote,
    parseNote,
    depositNote,
    depositNotes,
    walletSupportsAtomic,
    fetchGroup,
    groupFromCommitments,
    createPrivatePayment,
    paymentMessage,
    isNoteSpent,
    WITHDRAW_REF,
    withdrawMessage,
    poolSupportsWithdraw,
    createWithdrawal,
    withdrawNote,
    type WithdrawalRequest,
    type WithdrawProgress,
    type Note,
    type DepositedNote,
    type DepositNotesOptions,
    type DepositProgress,
    type PrivatePaymentRequest
} from "./pool.js"
export {
    fairPayrollAbi,
    PAY_PERIOD,
    MAX_SHIFTS,
    MAX_START_OFFSET,
    payPeriodName,
    shiftIdFor,
    readEmployerInfo,
    readEmployeeInfo,
    readSchedule,
    readFundingNeeded,
    fundPayroll,
    withdrawPayroll,
    approveShifts,
    setPaySchedule,
    endPaySchedule,
    claimPay,
    claimPayFor,
    resignPayroll,
    type PayPeriod,
    type PayrollDeployment,
    type EmployerInfo,
    type EmployeeInfo,
    type PaySchedule,
    type ShiftInput
} from "./payroll.js"
export { verifyPaymentTx, findPayments, type VerifiedPayment, type VerifyResult } from "./verify.js"

/** Browser side: hands a private payment to your relayer endpoint. */
export async function submitToRelayer(url: string, request: PrivatePaymentRequest): Promise<{ txHash: Hash }> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
    })
    const data = (await res.json().catch(() => ({}))) as { txHash?: Hash; error?: string }
    if (!res.ok || !data.txHash) throw new FairPayError("RELAYER_REJECTED", data.error ?? `relayer returned ${res.status}`)
    return { txHash: data.txHash }
}
