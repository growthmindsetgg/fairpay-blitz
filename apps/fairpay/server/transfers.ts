// Server-side check of a plain ERC-20 transfer of the deployment's token (USDC), for Team pay
// (routes/teamPay.ts): the owner pays a staff member straight from their wallet, with no FairPay
// contract and no orderRef in between. Like verifyPaymentTx (packages/sdk/src/verify.ts) it trusts
// only the chain: the browser sends a transaction hash, never "it worked".

import { FairPayError } from "@fairpay/sdk"
import { erc20Abi, getAddress, parseEventLogs, type Address, type Hash, type Log } from "viem"

/** The few RPC reads the check needs. The live chain passes viem's PublicClient; tests a fake. */
export interface TransferReader {
    getChainId(): Promise<number>
    /** Throws or answers null when the node doesn't know the transaction (yet). */
    getTransactionReceipt(args: { hash: Hash }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; blockHash: Hash; logs: Log[] } | null>
    /** The latest block, uncached. */
    getBlockNumber(): Promise<bigint>
    getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hash | null }>
}

export type VerifiedTransfer = {
    chainId: number
    txHash: Hash
    /** Store (chainId, txHash, logIndex) under a UNIQUE constraint so one transfer is recorded once. */
    logIndex: number
    blockNumber: bigint
    from: Address
    to: Address
    amount: bigint
}

export type TransferResult =
    | { status: "verified"; transfer: VerifiedTransfer }
    | { status: "pending"; confirmations: bigint }
    | { status: "rejected"; reason: string }

export type TransferParams = {
    txHash: Hash
    /** The wallet the token must leave. */
    from: Address
    /** The wallet it must reach. */
    to: Address
    /** Exact amount in the token's smallest unit. */
    amount: bigint
}

/**
 * Checks that `txHash` succeeded on the deployment's chain, sits in a canonical block with at
 * least `minConfirmations` (the payment's own block is 1), and moved exactly `amount` of the
 * deployment's token from `from` to `to` in its only Transfer of that token.
 *
 * Transfer events from any other contract are ignored: anyone can deploy a contract that emits a
 * Transfer with any arguments. More than one transfer of the token in the transaction is refused,
 * so a batch can't be passed off as one payment (and stays out of the history).
 */
export async function verifyTokenTransfer(
    deployment: { chainId: number; token: Address },
    client: TransferReader,
    params: TransferParams & { minConfirmations?: bigint }
): Promise<TransferResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) throw new FairPayError("INVALID_INPUT", "bad txHash")
    const from = getAddress(params.from)
    const to = getAddress(params.to)
    if (params.amount <= 0n) throw new FairPayError("INVALID_INPUT", "amount must be positive")
    const id = await client.getChainId()
    if (id !== deployment.chainId) throw new FairPayError("WRONG_CHAIN", `RPC is on chain ${id}, deployment is on ${deployment.chainId}`)

    const receipt = await client.getTransactionReceipt({ hash: params.txHash }).catch(() => null)
    if (!receipt) return { status: "pending", confirmations: 0n }
    if (receipt.status !== "success") return { status: "rejected", reason: "transaction reverted" }

    const latest = await client.getBlockNumber()
    const confirmations = latest - receipt.blockNumber + 1n
    if (confirmations < (params.minConfirmations ?? 1n)) return { status: "pending", confirmations }
    // As verifyPaymentTx: only count a receipt once the canonical block at its height is its block.
    const block = await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null)
    if (!block || block.hash !== receipt.blockHash) return { status: "pending", confirmations: 0n }

    const token = getAddress(deployment.token)
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter((l) => !l.removed && getAddress(l.address) === token)
    if (transfers.length === 0) return { status: "rejected", reason: "no USDC transfer in this transaction" }
    if (transfers.length > 1) return { status: "rejected", reason: "several USDC transfers in one transaction" }
    const log = transfers[0]!
    if (getAddress(log.args.from) !== from) return { status: "rejected", reason: "the USDC didn't come from the restaurant owner's wallet" }
    if (getAddress(log.args.to) !== to) return { status: "rejected", reason: "the USDC went to a different wallet" }
    if (log.args.value !== params.amount) return { status: "rejected", reason: `amount ${log.args.value} does not equal ${params.amount}` }
    if (log.logIndex === null || log.transactionHash === null) return { status: "pending", confirmations: 0n }
    return {
        status: "verified",
        transfer: {
            chainId: deployment.chainId,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: receipt.blockNumber,
            from,
            to,
            amount: log.args.value
        }
    }
}
