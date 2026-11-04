import { Hono } from "hono"
import { FairPayError } from "@fairpay/sdk"
import { getAddress, isAddress, zeroAddress, type Address, type Hash, type Hex } from "viem"
import type { PublicConfig } from "../../shared/types.js"
import type { AppEnv, Deps } from "../context.js"
import { clientIp, HttpError, limit, rateLimiter, readJson } from "../http.js"
import { payService, type RelayHold } from "./pay.js"

export type ChainServices = {
    config: PublicConfig
    /** The SDK relayer's handle(); undefined when RELAYER_KEY isn't set. */
    relay?: (body: unknown) => Promise<{ txHash: Hash }>
    /** Whether the relayer's wallet can pay for one more relay (cached briefly). */
    relayerReady?: () => Promise<boolean>
    /**
     * Hashes of recent FairPay payments for `orderRef` to `merchant` (the SDK's findPayments over
     * the last blocks). Lets a relay credit a note whose payment it lost track of.
     */
    findPayments?: (orderRef: Hex, merchant: Address) => Promise<Hash[]>
    /** Testnet faucet; undefined when FAUCET_KEY isn't set. */
    faucet?: (to: Address) => Promise<{ minted: string; gasSent: string }>
    /** Pool deposits from the indexer, in order. */
    commitments: () => string[]
    /** How long a relay hold outlives a relayed payment the server could not settle itself. */
    relaySettleGraceMs?: number
}

export const FAUCET_WINDOW_MS = 30 * 60_000
const MAX_RELAYS_IN_FLIGHT = 4
const MAX_FAUCET_IN_FLIGHT = 3
const RELAY_SETTLE_GRACE_MS = 30_000
const MAX_FAUCET_CLAIMS = 50_000
const HASH32 = /^0x[0-9a-fA-F]{64}$/

// Contract and relayer outcomes a payer can act on. Anything else stays in the server log: raw
// RPC errors can carry node URLs, the relayer's address and its balance.
const RELAY_REASONS: Record<string, [409 | 400, string]> = {
    NullifierSpent: [409, "This note has already been spent."],
    UnknownRoot: [409, "The pool changed while your proof was built. Try again."],
    InvalidProof: [400, "The payment proof is not valid."],
    WrongScope: [400, "The proof is for a different pool."],
    WrongMessage: [400, "The proof is for a different payment."],
    UnsupportedDepth: [400, "The proof uses an unsupported tree depth."],
    NotMerchant: [409, "This business can't take confidential payments right now."],
    AmountMismatch: [409, "The pool rejected the payment amount."],
    "payment already being submitted": [409, "This note is already being submitted."],
    "request is for another deployment": [400, "This payment is for a different pool."]
}

const OUT_OF_GAS = "The relayer is out of test MON, so confidential payments are paused. Pay publicly for now."

function relayError(err: unknown): HttpError {
    if (err instanceof HttpError) return err
    if (err instanceof FairPayError) {
        if (err.code === "INVALID_INPUT") return new HttpError(400, "Malformed confidential payment.")
        if (err.code === "RELAYER_UNFUNDED") {
            console.error("relay: the relayer wallet is out of MON")
            return new HttpError(503, OUT_OF_GAS)
        }
        if (err.code === "RELAYER_BUSY") return new HttpError(503, "The relayer is busy. Try again in a few seconds.")
        const known = Object.entries(RELAY_REASONS).find(([k]) => err.message.includes(k))
        if (known) return new HttpError(known[1][0], known[1][1])
    }
    console.error("relay:", err instanceof Error ? err.message.split("\n")[0] : err)
    return new HttpError(502, "The relayer could not submit this payment. Try again shortly.")
}

/** GET /config, GET /pool/commitments, POST /relay, POST /faucet {address} */
export function chainRoutes(deps: Deps, services: ChainServices) {
    const app = new Hono<AppEnv>()
    const pay = payService(deps)
    const now = deps.now
    const limits = {
        relay: rateLimiter(12, 60_000, now),
        faucetIp: rateLimiter(3, 60 * 60_000, now),
        faucetAll: rateLimiter(60, 60 * 60_000, now, 1)
    }
    const graceMs = services.relaySettleGraceMs ?? RELAY_SETTLE_GRACE_MS
    // Faucet claims per address. In memory (the schema has no table for it): a restart resets
    // the window, which the per-IP and global limits still bound.
    const faucetClaims = new Map<string, number>()
    let relaysInFlight = 0
    let faucetsInFlight = 0

    app.get("/config", async (c) => {
        if (!services.relay || !services.relayerReady) return c.json(services.config)
        return c.json({ ...services.config, relayerReady: await services.relayerReady() })
    })

    app.get("/pool/commitments", (c) => c.json({ commitments: services.commitments() }))

    // The relayer pays gas, so it only submits payments for open, privately payable shares, a
    // few at a time, and never more notes than a share still owes.
    app.post("/relay", async (c) => {
        limit(c, limits.relay)
        if (!services.relay) throw new HttpError(503, "Confidential payments are not set up on this server.")
        const body = await readJson(c, 8 * 1024)
        if (typeof body.merchant !== "string" || !isAddress(body.merchant) || typeof body.orderRef !== "string" || !HASH32.test(body.orderRef)) {
            throw new HttpError(400, "Malformed confidential payment.")
        }
        // Before the in-flight check, so no await sits between that check and the count.
        if (services.relayerReady && !(await services.relayerReady())) throw new HttpError(503, OUT_OF_GAS)
        if (relaysInFlight >= MAX_RELAYS_IN_FLIGHT) throw new HttpError(503, "The relayer is busy. Try again in a few seconds.")
        // Counted before the first await, so requests arriving together can't all pass the check.
        relaysInFlight += 1
        try {
            const merchant = getAddress(body.merchant)
            const orderRef = body.orderRef as Hex
            const hold = await pay.reserveRelay(orderRef, merchant)
            if (!hold) throw new HttpError(409, "This share is already paid or can't be paid confidentially.")
            if (hold === "in-flight") throw new HttpError(409, "A confidential payment for this share is still going through. Check again in a minute.")
            // Set once the note is spent on-chain but not credited yet.
            let unsettled: Hash | undefined
            // Set when the relayer failed in a way that may still have broadcast a transaction whose
            // hash it doesn't know (no answer from the RPC), so hold for the grace period. When the
            // node refused the transaction outright nothing was sent, and the hold goes at once.
            let unclear = false
            try {
                const { txHash } = await services.relay(body).catch(async (err: unknown) => {
                    // Sent, but no receipt in time: the payment may still land. Answer with its
                    // hash like any relayed payment, so the browser keeps the note as spent and
                    // settles it, and look for the payment again after the grace period.
                    if (err instanceof FairPayError && err.code === "RELAYER_TIMEOUT" && err.txHash) {
                        console.warn("relay: no receipt yet", err.txHash)
                        recoverLater(orderRef, merchant, hold)
                        return { txHash: err.txHash }
                    }
                    const mapped = relayError(err)
                    unclear = !(err instanceof FairPayError) || (err.code === "RELAYER_TIMEOUT" && err.txHash === undefined)
                    // The note may have paid this share anyway: someone sent the same proof before
                    // the relayer did, or an earlier relay of it timed out and then landed.
                    const spent = err instanceof FairPayError && (err.txHash !== undefined || err.message.includes("NullifierSpent"))
                    if (spent || unclear) await recover(orderRef, merchant, hold)
                    if (unclear) recoverLater(orderRef, merchant, hold)
                    throw mapped
                })
                // Credit the note before releasing the hold, so the share never looks like it owes
                // more than it does. The browser also settles the hash; that call is idempotent.
                try {
                    const settled = await pay.settle(hold.kind, hold.id, txHash)
                    if (settled.status === "pending") unsettled = txHash
                    else if (settled.status === "rejected") console.warn("relay: payment not credited", txHash, settled.reason)
                } catch (err) {
                    unsettled = txHash
                    console.warn("relay: could not settle", txHash, err instanceof Error ? err.message.split("\n")[0] : err)
                }
                return c.json({ txHash })
            } finally {
                if (unsettled !== undefined) pay.keepHold(unsettled, hold, graceMs)
                else if (unclear) setTimeout(() => hold.release(), graceMs).unref?.()
                else hold.release()
            }
        } finally {
            relaysInFlight -= 1
        }
    })

    /**
     * Credits FairPay payments for this reference that the server hasn't counted, through the
     * normal settle: the same on-chain checks and the same UNIQUE(chain_id, tx_hash, log_index),
     * so nothing is counted twice. Failures are logged; the browser can still settle a hash it knows.
     */
    async function recover(orderRef: Hex, merchant: Address, hold: RelayHold) {
        if (!services.findPayments) return
        try {
            for (const txHash of await services.findPayments(orderRef, merchant)) {
                const settled = await pay.settle(hold.kind, hold.id, txHash)
                if (settled.status !== "credited") console.warn("relay: found payment not credited", txHash, settled.status)
            }
        } catch (err) {
            console.warn("relay: recovery failed", err instanceof Error ? err.message.split("\n")[0] : err)
        }
    }
    function recoverLater(orderRef: Hex, merchant: Address, hold: RelayHold) {
        setTimeout(() => void recover(orderRef, merchant, hold), graceMs).unref?.()
    }

    app.post("/faucet", async (c) => {
        if (!services.faucet) throw new HttpError(503, "The faucet is not set up on this server.")
        const body = await readJson(c, 1024)
        if (typeof body.address !== "string" || !isAddress(body.address)) throw new HttpError(400, "Send a wallet address.")
        const to = getAddress(body.address)
        if (to === zeroAddress) throw new HttpError(400, "Send a wallet address.")
        limit(c, limits.faucetIp)
        if (faucetsInFlight >= MAX_FAUCET_IN_FLIGHT) throw new HttpError(503, "The faucet is busy. Try again in a minute.")
        const key = to.toLowerCase()
        const at = now()
        const prev = faucetClaims.get(key)
        if (prev !== undefined && prev > at - FAUCET_WINDOW_MS) throw new HttpError(429, "This wallet was topped up recently. Try again later.")
        if (!limits.faucetAll.hit("*")) throw new HttpError(503, "The faucet is resting. Try again later.")
        if (faucetClaims.size >= MAX_FAUCET_CLAIMS) {
            for (const [k, t] of faucetClaims) if (t <= at - FAUCET_WINDOW_MS) faucetClaims.delete(k)
        }
        faucetClaims.set(key, at)
        faucetsInFlight += 1
        try {
            return c.json(await services.faucet(to))
        } catch (err) {
            if (faucetClaims.get(key) === at) {
                if (prev === undefined) faucetClaims.delete(key)
                else faucetClaims.set(key, prev)
            }
            console.error("faucet:", err instanceof Error ? err.message.split("\n")[0] : err, clientIp(c))
            throw new HttpError(502, "The faucet could not send right now. Try again shortly.")
        } finally {
            faucetsInFlight -= 1
        }
    })

    return app
}
