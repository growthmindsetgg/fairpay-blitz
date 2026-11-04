import { getAddress, isAddress, parseEventLogs, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { fairPayAbi } from "./abi.js"
import { assertChain } from "./chain.js"
import { FairPayError, type FairPayDeployment, type LogScanOptions } from "./config.js"
import { getLogsChunked } from "./logs.js"

export type VerifiedPayment = {
    chainId: number
    txHash: Hash
    /** Store (chainId, txHash, logIndex) under a UNIQUE constraint so one payment can never settle two shares. */
    logIndex: number
    blockNumber: bigint
    payer: Address
    amount: bigint
    kind: "public" | "private"
}

export type VerifyResult =
    | { status: "verified"; payment: VerifiedPayment }
    | { status: "pending"; confirmations: bigint }
    | { status: "rejected"; reason: string }

/**
 * Merchant-side verification of one payment transaction. Trusts only the chain: the
 * transaction must have succeeded on the deployment's chain, the event must come from the
 * FairPay contract, and its order reference, recipient and amount must all match.
 *
 * Never mark a share paid from a client-side "success" message; call this on your backend.
 */
export async function verifyPaymentTx(
    deployment: FairPayDeployment,
    publicClient: PublicClient,
    params: {
        txHash: Hash
        orderRef: Hex
        merchant: Address
        /** Exact amount this share requires. */
        amount: bigint
        /** For public payments: the participant wallet expected to pay. Ignored for private payments. */
        expectedPayer?: Address
        /** Default 1. */
        minConfirmations?: bigint
    }
): Promise<VerifyResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) throw new FairPayError("INVALID_INPUT", "bad txHash")
    assertOrderRef(params.orderRef)
    if (!isAddress(params.merchant)) throw new FairPayError("INVALID_INPUT", "merchant is not an address")
    await assertChain(deployment, { publicClient })

    const receipt = await publicClient.getTransactionReceipt({ hash: params.txHash }).catch(() => null)
    if (!receipt) return { status: "pending", confirmations: 0n }
    if (receipt.status !== "success") return { status: "rejected", reason: "transaction reverted" }

    const latest = await publicClient.getBlockNumber({ cacheTime: 0 })
    const confirmations = latest - receipt.blockNumber + 1n
    if (confirmations < (params.minConfirmations ?? 1n)) return { status: "pending", confirmations }
    // A receipt can belong to a block that was since reorged out, or come from a lagging node
    // behind a load balancer. Only count it once the canonical block at that height is that block.
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null)
    if (!block || block.hash !== receipt.blockHash) return { status: "pending", confirmations: 0n }

    const fairPay = getAddress(deployment.fairPay)
    const merchant = getAddress(params.merchant)
    const matches = parseEventLogs({ abi: fairPayAbi, eventName: "PaymentReceived", logs: receipt.logs }).filter(
        (l) =>
            getAddress(l.address) === fairPay &&
            l.args.orderRef.toLowerCase() === params.orderRef.toLowerCase() &&
            getAddress(l.args.recipient) === merchant
    )
    if (matches.length === 0) return { status: "rejected", reason: "no matching PaymentReceived event" }
    if (matches.length > 1) return { status: "rejected", reason: "ambiguous: several payments in one transaction" }

    const log = matches[0]!
    const payment = toPayment(deployment, log)
    if (payment.amount !== params.amount) {
        return { status: "rejected", reason: `amount ${payment.amount} does not equal required ${params.amount}` }
    }
    if (payment.kind === "public" && params.expectedPayer && getAddress(params.expectedPayer) !== payment.payer) {
        return { status: "rejected", reason: "paid from a different wallet than the participant" }
    }
    return { status: "verified", payment }
}

/**
 * Finds every payment carrying `orderRef`. Use it to recover payments whose transaction hash
 * was lost, or to sum several private notes that pay one share.
 */
export async function findPayments(
    deployment: FairPayDeployment,
    publicClient: PublicClient,
    params: { orderRef: Hex; merchant?: Address; fromBlock: bigint },
    options: LogScanOptions = {}
): Promise<VerifiedPayment[]> {
    assertOrderRef(params.orderRef)
    if (params.merchant !== undefined && !isAddress(params.merchant)) {
        throw new FairPayError("INVALID_INPUT", "merchant is not an address")
    }
    await assertChain(deployment, { publicClient })
    const fairPay = getAddress(deployment.fairPay)
    const orderRef = params.orderRef.toLowerCase()
    const merchant = params.merchant === undefined ? undefined : getAddress(params.merchant)
    const toBlock = await publicClient.getBlockNumber({ cacheTime: 0 })
    const logs = await getLogsChunked(params.fromBlock, toBlock, options.chunkSize ?? 100n, (fromBlock, to) =>
        publicClient.getContractEvents({
            address: deployment.fairPay,
            abi: fairPayAbi,
            eventName: "PaymentReceived",
            args: { orderRef: params.orderRef, recipient: params.merchant },
            fromBlock,
            toBlock: to
        })
    )
    // The address and topic filters run on the RPC. Re-check them here so an RPC or proxy that
    // ignores them cannot make other orders' payments count for this one.
    return logs
        .filter(
            (l) =>
                !l.removed &&
                l.transactionHash !== null &&
                l.blockNumber !== null &&
                l.logIndex !== null &&
                getAddress(l.address) === fairPay &&
                l.args.orderRef?.toLowerCase() === orderRef &&
                l.args.recipient !== undefined &&
                (merchant === undefined || getAddress(l.args.recipient) === merchant) &&
                l.args.payer !== undefined &&
                l.args.amount !== undefined
        )
        .map((l) => toPayment(deployment, l))
}

function assertOrderRef(orderRef: unknown) {
    if (typeof orderRef !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderRef)) {
        throw new FairPayError("INVALID_INPUT", "orderRef must be a bytes32 hex string")
    }
}

function toPayment(
    deployment: FairPayDeployment,
    log: {
        transactionHash: Hash | null
        logIndex: number | null
        blockNumber: bigint | null
        args: { payer?: Address; amount?: bigint }
    }
): VerifiedPayment {
    const payer = getAddress(log.args.payer!)
    return {
        chainId: deployment.chainId,
        txHash: log.transactionHash!,
        logIndex: log.logIndex!,
        blockNumber: log.blockNumber!,
        payer,
        amount: log.args.amount!,
        kind: deployment.pool && payer === getAddress(deployment.pool) ? "private" : "public"
    }
}
