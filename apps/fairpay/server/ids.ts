import { randomBytes } from "node:crypto"
import { createOrderRef, randomSecret } from "@fairpay/sdk"
import type { Hex } from "viem"

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

/** 10 random bytes as 16 lowercase base32 characters (80 bits). */
function base32Random(): string {
    const bytes = randomBytes(10)
    let out = ""
    let bits = 0
    let value = 0
    for (const b of bytes) {
        value = (value << 8) | b
        bits += 8
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    return out
}

/**
 * A random id such as "b_k3j5...". Ids are never sequential, so a URL can't be guessed.
 * `newId("b")` and `newId("b_")` give the same shape.
 */
export function newId(prefix: string): string {
    if (!/^[a-z]{1,8}_?$/.test(prefix)) throw new Error("id prefix must be a few lowercase letters")
    return (prefix.endsWith("_") ? prefix : prefix + "_") + base32Random()
}

/** 32 random bytes, base64url (43 characters). Share links and session tokens. */
export function newToken(): string {
    return randomBytes(32).toString("base64url")
}

/**
 * A fresh secret and the on-chain reference it derives for one share (participant or order share).
 * Both stay server-side; only the reference is ever given to the payer.
 */
export function newOrderRef(orderId: string, participantId: string): { orderRef: Hex; secret: Hex } {
    const secret = randomSecret()
    const orderRef = createOrderRef({ orderId, participantId, secret }).toLowerCase() as Hex
    return { orderRef, secret }
}
