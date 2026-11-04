import {
    BaseError,
    ContractFunctionRevertedError,
    getAddress,
    HttpRequestError,
    InsufficientFundsError,
    InvalidInputRpcError,
    isAddress,
    LimitExceededRpcError,
    NonceTooHighError,
    NonceTooLowError,
    TimeoutError,
    type Hash
} from "viem"
import { fairPoolAbi } from "./abi.js"
import { assertChain, sendSimulated, waitForSent, type Clients } from "./chain.js"
import { FairPayError, type FairPayDeployment } from "./config.js"
import type { PrivatePaymentRequest } from "./pool.js"

/**
 * Server-side relayer. It submits private payments from its own wallet so the customer's
 * wallet never appears on-chain next to the payment.
 *
 * The relayer cannot steal or redirect funds: the proof is bound to the merchant and order.
 * The worst a malicious relayer can do is refuse to submit. Still:
 *  - run it on your backend only; its key pays gas,
 *  - put rate limiting in front of it (per IP / per session),
 *  - fund its wallet with only a small amount of MON.
 */
export function createRelayer(deployment: FairPayDeployment, clients: Clients) {
    if (!deployment.pool) throw new FairPayError("NO_POOL", "this deployment has no private pool")
    const pool = getAddress(deployment.pool)
    const inFlight = new Set<string>()

    return {
        /** Validates an untrusted request body, simulates it, then submits. */
        async handle(body: unknown): Promise<{ txHash: Hash }> {
            const req = parseRequest(body)
            if (req.chainId !== deployment.chainId || getAddress(req.pool) !== pool) {
                throw new FairPayError("RELAYER_REJECTED", "request is for another deployment")
            }
            await assertChain(deployment, clients)

            const nullifier = req.proof.nullifier
            if (inFlight.has(nullifier)) throw new FairPayError("RELAYER_REJECTED", "payment already being submitted")
            inFlight.add(nullifier)
            try {
                const txHash = await sendSimulated(clients, {
                    address: pool,
                    abi: fairPoolAbi,
                    functionName: "pay",
                    args: [
                        getAddress(req.merchant),
                        req.orderRef,
                        {
                            merkleTreeDepth: BigInt(req.proof.merkleTreeDepth),
                            merkleTreeRoot: BigInt(req.proof.merkleTreeRoot),
                            nullifier: BigInt(req.proof.nullifier),
                            message: BigInt(req.proof.message),
                            scope: BigInt(req.proof.scope),
                            points: req.proof.points.map(BigInt) as unknown as readonly [
                                bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint
                            ]
                        }
                    ]
                })
                // Sent: from here on every error carries the hash, so the caller can still settle a
                // payment whose receipt was slow, or look for the one that beat this transaction.
                const receipt = await waitForSent(clients, txHash).catch((err: unknown) => {
                    throw new FairPayError("RELAYER_TIMEOUT", `sent ${txHash}, no receipt: ${revertReason(err)}`, txHash)
                })
                if (receipt.status !== "success") throw new FairPayError("RELAYER_REJECTED", `reverted: ${txHash}`, txHash)
                return { txHash }
            } catch (err) {
                throw err instanceof FairPayError ? err : sendFailure(err)
            } finally {
                inFlight.delete(nullifier)
            }
        }
    }
}

// Canonical decimal uint256 only. With leading zeros allowed, "07" and "7" would be different
// in-flight keys for one nullifier, so concurrent copies of one proof would each pass simulation
// and be sent, and every copy but one would revert at the relayer's expense.
const UINT = /^(0|[1-9][0-9]{0,77})$/
const UINT256_MAX = (1n << 256n) - 1n

function parseRequest(body: unknown): PrivatePaymentRequest {
    const bad = (why: string): never => {
        throw new FairPayError("INVALID_INPUT", `invalid payment request: ${why}`)
    }
    if (typeof body !== "object" || body === null) bad("not an object")
    const b = body as Record<string, unknown>
    const p = b.proof as Record<string, unknown> | undefined
    if (typeof b.chainId !== "number") bad("chainId")
    if (typeof b.pool !== "string" || !isAddress(b.pool)) bad("pool")
    if (typeof b.merchant !== "string" || !isAddress(b.merchant)) bad("merchant")
    if (typeof b.orderRef !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.orderRef)) bad("orderRef")
    if (typeof p !== "object" || p === null) bad("proof")
    for (const k of ["merkleTreeDepth", "merkleTreeRoot", "nullifier", "message", "scope"]) {
        if (!isUint(p![k])) bad(`proof.${k}`)
    }
    const points = p!.points
    if (!Array.isArray(points) || points.length !== 8 || !points.every(isUint)) bad("proof.points")
    return body as PrivatePaymentRequest
}

function isUint(x: unknown): boolean {
    return typeof x === "string" && UINT.test(x) && BigInt(x) <= UINT256_MAX
}

/**
 * Classifies a failure before the transaction was sent. The node answered every case but the
 * last, so nothing reached the chain: RELAYER_UNFUNDED (the relayer can't cover gas),
 * RELAYER_BUSY (it refused the nonce or is rate limiting: retry), RELAYER_REJECTED (the payment
 * reverts in simulation, or another refusal). Without any answer from the RPC the transaction may
 * or may not have gone out: RELAYER_TIMEOUT without a hash.
 */
function sendFailure(err: unknown): FairPayError {
    if (err instanceof BaseError) {
        const is = (...types: (abstract new (...args: never[]) => Error)[]) => err.walk((e) => types.some((t) => e instanceof t)) !== null
        // Some nodes report a revert as a bare -32000 that viem doesn't decode; it is still a revert.
        if (is(ContractFunctionRevertedError) || /revert/i.test(err.message)) return new FairPayError("RELAYER_REJECTED", revertReason(err))
        if (is(InsufficientFundsError)) return new FairPayError("RELAYER_UNFUNDED", "the relayer wallet can't cover gas")
        if (is(NonceTooLowError, NonceTooHighError, InvalidInputRpcError, LimitExceededRpcError) || is429(err)) {
            return new FairPayError("RELAYER_BUSY", err.shortMessage)
        }
        if (is(HttpRequestError, TimeoutError)) return new FairPayError("RELAYER_TIMEOUT", `no answer from the RPC: ${err.shortMessage}`)
    }
    return new FairPayError("RELAYER_REJECTED", revertReason(err))
}

function is429(err: BaseError): boolean {
    const http = err.walk((e) => e instanceof HttpRequestError)
    return http instanceof HttpRequestError && http.status === 429
}

function revertReason(err: unknown): string {
    if (err instanceof BaseError) {
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
        if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.shortMessage
        return err.shortMessage
    }
    return err instanceof Error ? err.message : String(err)
}
