import { bytesToHex, encodeAbiParameters, keccak256, type Hex } from "viem"
import { FairPayError } from "./config.js"

/** 32 bytes from the platform CSPRNG, hex encoded. */
export function randomSecret(): Hex {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    return bytesToHex(bytes)
}

/**
 * Derives the opaque on-chain reference for one participant's share of one order.
 *
 * The secret must stay off-chain (database + the participant's share link). Without it an
 * observer cannot link a payment to an order, and cannot produce a valid reference for
 * someone else's share.
 */
export function createOrderRef(params: { orderId: string; participantId: string; secret: Hex }): Hex {
    const { orderId, participantId, secret } = params
    if (!orderId || !participantId) throw new FairPayError("INVALID_INPUT", "orderId and participantId are required")
    if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new FairPayError("INVALID_INPUT", "secret must be 32 bytes of hex")
    return keccak256(
        encodeAbiParameters(
            [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes32" }],
            ["FairPay.orderRef.v1", orderId, participantId, secret]
        )
    )
}
