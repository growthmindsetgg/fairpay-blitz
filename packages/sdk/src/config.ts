import type { Address, Hash } from "viem"

/** Addresses of one FairPay deployment. */
export type FairPayDeployment = {
    chainId: number
    token: Address
    fairPay: Address
    /** Omit when the deployment has no private pool. */
    pool?: Address
    /** Block the pool was deployed in. Deposit logs are scanned from here. */
    poolDeployBlock?: bigint
    /**
     * FairPoolBatcher for `pool`, when deployed. `depositNotes` then deposits up to MAX_BATCH notes
     * per transaction after a single approval. Trusted like `pool`: an approval goes to it.
     */
    batcher?: Address
    /** FairPayroll (payroll escrow) for `token`, when deployed. Omit otherwise. */
    payroll?: Address
    /** Block FairPayroll was deployed in. Its event logs are scanned from here. */
    payrollDeployBlock?: bigint
}

/** Options for scanning logs on RPCs that cap the block range of eth_getLogs. */
export type LogScanOptions = {
    /** Blocks per eth_getLogs request. Default 100, which Monad's public RPC accepts (larger ranges get HTTP 413). */
    chunkSize?: bigint
}

export class FairPayError extends Error {
    constructor(
        readonly code:
            | "WRONG_CHAIN"
            | "INVALID_INPUT"
            | "NO_POOL"
            | "GROUP_MISMATCH"
            | "NOTE_NOT_FOUND"
            | "NOTE_SPENT"
            | "NOT_MERCHANT"
            | "NO_WITHDRAW"
            | "POOL_FULL"
            | "POOL_PAUSED"
            | "RELAYER_REJECTED"
            | "RELAYER_TIMEOUT"
            | "RELAYER_BUSY"
            | "RELAYER_UNFUNDED",
        message: string,
        /** Set by the relayer once it has sent a transaction: the payment may be on-chain. */
        readonly txHash?: Hash
    ) {
        super(message)
        this.name = "FairPayError"
    }
}
