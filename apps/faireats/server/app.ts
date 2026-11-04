import { createHash, timingSafeEqual } from "node:crypto"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { secureHeaders } from "hono/secure-headers"
import { FairPayError } from "@fairpay/sdk"
import { getAddress, isAddress, zeroAddress, type Address, type Hash } from "viem"
import { menu, restaurant } from "./menu.js"
import { ipKey } from "./net.js"
import { HttpError, MAX_GUESTS, parseCreateOrder, type Service } from "./service.js"

export type AppDeps = {
    service: Service
    relay: (body: unknown) => Promise<{ txHash: Hash }>
    faucet: (to: Address) => Promise<{ minted: string; gasSent: string }>
    commitments: () => string[]
    kitchenPin: string
    publicConfig: Record<string, unknown>
    /** The client's address as the server sees it (after any trusted proxy handling). */
    clientIp: (c: Context) => string
    now?: () => number
    /** How long a relay hold outlives a relayed payment the server could not settle itself. */
    relaySettleGraceMs?: number
}

/** Hosts the browser app talks to besides this server. */
const ZK_ARTIFACTS = "https://snark-artifacts.pse.dev" // @zk-kit/artifacts, used by Semaphore proofs
const MONAD_RPC = "https://testnet-rpc.monad.xyz"

export const FAUCET_WINDOW_MS = 30 * 60_000
const MAX_RELAYS_IN_FLIGHT = 4
const MAX_FAUCET_IN_FLIGHT = 3
const RELAY_SETTLE_GRACE_MS = 30_000
const KITCHEN_TRUST_MS = 12 * 60 * 60_000
const MAX_KITCHEN_TRUSTED = 256
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/

/**
 * Fixed-window counter. In memory: fine for one demo server, use a shared store if you scale out.
 * At most `maxKeys` keys are kept; expired windows are dropped first, then the oldest window.
 */
export function rateLimiter(limit: number, windowMs: number, now: () => number, maxKeys = 10_000) {
    const hits = new Map<string, { n: number; reset: number }>()

    const current = (key: string) => {
        const h = hits.get(key)
        if (h && h.reset <= now()) {
            hits.delete(key)
            return undefined
        }
        return h
    }

    const makeRoom = () => {
        const t = now()
        for (const [k, h] of hits) if (h.reset <= t) hits.delete(k)
        // Map iteration is insertion order, and a key is re-inserted when its window restarts,
        // so the first entries are the windows that started longest ago.
        for (const k of hits.keys()) {
            if (hits.size < maxKeys) break
            hits.delete(k)
        }
    }

    return {
        /** Counts one request; false once the key is over the limit for this window. */
        hit(key: string) {
            const h = current(key)
            if (!h) {
                if (hits.size >= maxKeys) makeRoom()
                hits.set(key, { n: 1, reset: now() + windowMs })
                return 1 <= limit
            }
            h.n += 1
            return h.n <= limit
        },
        /** True when the key has used its whole allowance, without counting a request. */
        blocked(key: string) {
            const h = current(key)
            return h !== undefined && h.n >= limit
        },
        get size() {
            return hits.size
        }
    }
}

/**
 * Keys that proved something recently, each forgotten `ttlMs` after it last did. At most
 * `maxKeys` are kept; the one refreshed longest ago goes first.
 */
export function recentSet(ttlMs: number, now: () => number, maxKeys: number) {
    const until = new Map<string, number>()
    return {
        add(key: string) {
            // Re-inserting keeps the map ordered by last refresh, oldest first.
            until.delete(key)
            if (until.size >= maxKeys) until.delete(until.keys().next().value!)
            until.set(key, now() + ttlMs)
        },
        has(key: string) {
            const t = until.get(key)
            if (t === undefined) return false
            if (t <= now()) {
                until.delete(key)
                return false
            }
            return true
        },
        get size() {
            return until.size
        }
    }
}

const digest = (s: string) => createHash("sha256").update(s).digest()

// Contract and relayer outcomes a customer can act on. Anything else stays in the server log:
// raw RPC errors can carry node URLs, the relayer's address and its balance.
const RELAY_REASONS: Record<string, [409 | 400, string]> = {
    NullifierSpent: [409, "This note has already been spent."],
    UnknownRoot: [409, "The pool changed while your proof was built. Try again."],
    InvalidProof: [400, "The payment proof is not valid."],
    WrongScope: [400, "The proof is for a different pool."],
    WrongMessage: [400, "The proof is for a different payment."],
    UnsupportedDepth: [400, "The proof uses an unsupported tree depth."],
    NotMerchant: [409, "This restaurant cannot take private payments right now."],
    AmountMismatch: [409, "The pool rejected the payment amount."],
    "payment already being submitted": [409, "This note is already being submitted."],
    "request is for another deployment": [400, "This payment is for a different pool."]
}

function relayError(err: unknown): HttpError {
    if (err instanceof HttpError) return err
    if (err instanceof FairPayError) {
        if (err.code === "INVALID_INPUT") return new HttpError(400, "Malformed private payment.")
        const known = Object.entries(RELAY_REASONS).find(([k]) => err.message.includes(k))
        if (known) return new HttpError(known[1][0], known[1][1])
    }
    console.error("relay:", err)
    return new HttpError(502, "The relayer could not submit this payment. Try again shortly.")
}

export function createApp(deps: AppDeps) {
    const now = deps.now ?? Date.now
    const app = new Hono()
    const limits = {
        api: rateLimiter(600, 60_000, now),
        orders: rateLimiter(20, 60_000, now),
        relay: rateLimiter(12, 60_000, now),
        faucetIp: rateLimiter(3, 60 * 60_000, now),
        faucetAll: rateLimiter(60, 60 * 60_000, now, 1),
        // Only wrong PINs count, so a kitchen screen polling with the right PIN is never locked
        // out. The global counter caps guessing spread over many addresses. It does not apply to
        // addresses that already gave the right PIN (kitchenTrusted), or anyone could lock the
        // real kitchen out by guessing wrong from a few addresses.
        kitchenFail: rateLimiter(10, 15 * 60_000, now),
        kitchenFailAll: rateLimiter(60, 60 * 60_000, now, 1),
        payments: rateLimiter(60, 60_000, now)
    }
    const kitchenTrusted = recentSet(KITCHEN_TRUST_MS, now, MAX_KITCHEN_TRUSTED)
    const relayGraceMs = deps.relaySettleGraceMs ?? RELAY_SETTLE_GRACE_MS
    // Relay holds kept after the server could not settle the note itself, by transaction hash.
    // They are released when that transaction is settled, or when the grace period ends.
    const unsettledHolds = new Map<string, { shareId: string; release: () => void }[]>()
    const pinDigest = digest(deps.kitchenPin)
    let relaysInFlight = 0
    let faucetsInFlight = 0

    const rpcOrigin = (() => {
        try {
            return typeof deps.publicConfig.rpcUrl === "string" ? new URL(deps.publicConfig.rpcUrl).origin : undefined
        } catch {
            return undefined
        }
    })()
    const connectSrc = [...new Set(["'self'", MONAD_RPC, ZK_ARTIFACTS, ...(rpcOrigin ? [rpcOrigin] : [])])]

    app.use(
        "*",
        secureHeaders({
            contentSecurityPolicy: {
                defaultSrc: ["'self'"],
                // snarkjs compiles the prover's WebAssembly; that needs wasm-unsafe-eval, not unsafe-eval.
                scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
                // ffjavascript starts its prover threads from blob: URLs.
                workerSrc: ["'self'", "blob:"],
                // Fonts are self-hosted (public/fonts), so no visitor IP goes to a font CDN.
                styleSrc: ["'self'"],
                fontSrc: ["'self'"],
                imgSrc: ["'self'", "data:"],
                connectSrc,
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"]
            },
            xFrameOptions: "DENY",
            referrerPolicy: "no-referrer",
            permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] }
        })
    )

    app.onError((err, c) => {
        if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
        if (err instanceof FairPayError && err.code === "INVALID_INPUT") return c.json({ error: err.message, code: err.code }, 400)
        console.error(err)
        return c.json({ error: "Something went wrong on the server. Try again." }, 500)
    })

    const ip = (c: Context) => ipKey(deps.clientIp(c))

    const limit = (c: Context, name: Exclude<keyof typeof limits, "kitchenFail" | "kitchenFailAll">, key = ip(c)) => {
        if (!limits[name].hit(key)) throw new HttpError(429, "Too many requests. Wait a minute and try again.")
    }

    app.use("/api/*", async (c, next) => {
        limit(c, "api")
        // Only JSON is accepted. Browsers cannot send that cross-site without a CORS preflight,
        // which this API never approves.
        if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
            const type = c.req.header("content-type") ?? ""
            if (!/^application\/json\s*(;|$)/i.test(type)) return c.json({ error: "Send the body as application/json." }, 415)
        }
        await next()
    })
    app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request body too large." }, 413) }))

    const json = async (c: Context): Promise<Record<string, unknown>> => {
        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            throw new HttpError(400, "Send a JSON body.")
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Send a JSON object.")
        return body as Record<string, unknown>
    }

    const idParam = (c: Context, what: string) => {
        const id = c.req.param("id") ?? ""
        if (!ID.test(id)) throw new HttpError(404, `No ${what} with that id.`)
        return id
    }

    const requireKitchen = (c: Context) => {
        const key = ip(c)
        // Refuse before comparing so a locked-out client learns nothing, not even from a right PIN.
        // While the global cap is hit, only addresses that gave the right PIN before get through;
        // an attacker's addresses never have, so they still learn nothing.
        if (limits.kitchenFail.blocked(key) || (limits.kitchenFailAll.blocked("*") && !kitchenTrusted.has(key))) {
            throw new HttpError(429, "Too many wrong PINs. Wait a few minutes and try again.")
        }
        const pin = c.req.header("x-kitchen-pin") ?? ""
        // Comparing fixed-length digests keeps the time independent of the PIN and its length.
        if (!timingSafeEqual(digest(pin), pinDigest)) {
            limits.kitchenFail.hit(key)
            limits.kitchenFailAll.hit("*")
            throw new HttpError(401, "Wrong kitchen PIN.")
        }
        kitchenTrusted.add(key)
    }

    const releaseUnsettled = (txHash: string, shareId: string) => {
        const key = txHash.toLowerCase()
        const holds = unsettledHolds.get(key)
        if (!holds) return
        const rest = holds.filter((h) => h.shareId !== shareId)
        for (const h of holds) if (h.shareId === shareId) h.release()
        if (rest.length > 0) unsettledHolds.set(key, rest)
        else unsettledHolds.delete(key)
    }

    // Until a spent note is credited, another relay for the same share could spend one note too
    // many. Keep its hold until the client's own settle call lands, or the grace period ends.
    const keepHold = (txHash: Hash, hold: { shareId: string; release: () => void }) => {
        const key = txHash.toLowerCase()
        const timer = setTimeout(() => releaseUnsettled(key, hold.shareId), relayGraceMs)
        timer.unref?.()
        const entry = {
            shareId: hold.shareId,
            release: () => {
                clearTimeout(timer)
                hold.release()
            }
        }
        unsettledHolds.set(key, [...(unsettledHolds.get(key) ?? []), entry])
    }

    app.get("/api/config", (c) =>
        c.json({ ...deps.publicConfig, restaurant, maxGuests: MAX_GUESTS })
    )
    // The address rate limits count this caller under. Lets an operator check TRUST_PROXY_HOPS
    // after deploying: it must show their real address and ignore a forged X-Forwarded-For.
    app.get("/api/whoami", (c) => c.json({ ip: ip(c) }))
    app.get("/api/menu", (c) => c.json({ restaurant, items: menu }))
    app.get("/api/pool/commitments", (c) => c.json({ commitments: deps.commitments() }))

    app.post("/api/orders", async (c) => {
        limit(c, "orders")
        const order = deps.service.createOrder(parseCreateOrder(await json(c)))
        return c.json(order, 201)
    })

    app.get("/api/orders/:id", (c) => c.json(deps.service.viewOrder(idParam(c, "order"))))

    app.post("/api/shares/:id/payments", async (c) => {
        limit(c, "payments")
        const id = idParam(c, "share")
        const body = await json(c)
        if (typeof body.txHash !== "string" || !HASH32.test(body.txHash)) {
            throw new HttpError(400, "txHash must be a transaction hash.")
        }
        const result = await deps.service.submitPayment(id, body.txHash as Hash)
        if (result.status !== "pending") releaseUnsettled(body.txHash, id)
        return c.json(result, result.status === "pending" ? 202 : 200)
    })

    // The relayer pays gas, so it only submits payments for open shares at this restaurant, a
    // few at a time, and never more notes than a share still owes.
    app.post("/api/relay", async (c) => {
        limit(c, "relay")
        const body = await json(c)
        if (
            typeof body.merchant !== "string" ||
            !isAddress(body.merchant) ||
            typeof body.orderRef !== "string" ||
            !HASH32.test(body.orderRef)
        ) {
            throw new HttpError(400, "Malformed private payment.")
        }
        if (relaysInFlight >= MAX_RELAYS_IN_FLIGHT) throw new HttpError(503, "The relayer is busy. Try again in a few seconds.")
        const hold = deps.service.reserveRelay(body.orderRef, getAddress(body.merchant))
        if (!hold) throw new HttpError(409, "This share is already paid or is not open for private payment.")
        relaysInFlight += 1
        // Set once the note is spent on-chain but not credited to the share yet.
        let unsettled: Hash | undefined
        // Set when the relayer failed in a way that may still have broadcast the transaction
        // (a receipt timeout, a dropped connection); its hash is unknown, so hold for the grace period.
        let unclear = false
        try {
            const { txHash } = await deps.relay(body).catch((err: unknown) => {
                const mapped = relayError(err)
                unclear = mapped.status === 502
                throw mapped
            })
            // Credit the note before releasing the hold, so the share never looks like it owes
            // more than it does. The client also submits the hash; that call is idempotent.
            try {
                const settled = await deps.service.submitPayment(hold.shareId, txHash)
                if (settled.status === "pending") unsettled = txHash
            } catch (err) {
                // A 409 means the chain answered and this note does not count for the share, so
                // holding on would only block a note it still needs. Anything else (an RPC
                // hiccup) leaves the note spent but not yet credited.
                if (!(err instanceof HttpError && err.status === 409)) unsettled = txHash
                console.warn("relay: could not settle", txHash, err instanceof Error ? err.message : err)
            }
            return c.json({ txHash })
        } finally {
            relaysInFlight -= 1
            if (unsettled !== undefined) keepHold(unsettled, hold)
            else if (unclear) setTimeout(() => hold.release(), relayGraceMs).unref?.()
            else hold.release()
        }
    })

    app.post("/api/faucet", async (c) => {
        const body = await json(c)
        if (typeof body.address !== "string" || !isAddress(body.address)) throw new HttpError(400, "Send a wallet address.")
        const to = getAddress(body.address)
        if (to === zeroAddress) throw new HttpError(400, "Send a wallet address.")
        limit(c, "faucetIp")
        if (faucetsInFlight >= MAX_FAUCET_IN_FLIGHT) throw new HttpError(503, "The faucet is busy. Try again in a minute.")
        const undo = deps.service.claimFaucet(to, FAUCET_WINDOW_MS)
        if (!undo) throw new HttpError(429, "This wallet was topped up recently. Try again later.")
        if (!limits.faucetAll.hit("*")) {
            undo()
            throw new HttpError(503, "The faucet is resting. Try again later.")
        }
        faucetsInFlight += 1
        try {
            return c.json(await deps.faucet(to))
        } catch (err) {
            undo()
            console.error("faucet:", err)
            throw new HttpError(502, "The faucet could not send right now. Try again shortly.")
        } finally {
            faucetsInFlight -= 1
        }
    })

    app.get("/api/kitchen", (c) => {
        requireKitchen(c)
        return c.json(deps.service.kitchenQueue())
    })
    app.post("/api/kitchen/orders/:id/start", (c) => {
        requireKitchen(c)
        return c.json(deps.service.startCooking(idParam(c, "order")))
    })
    app.post("/api/kitchen/orders/:id/served", (c) => {
        requireKitchen(c)
        return c.json(deps.service.markServed(idParam(c, "order")))
    })

    app.all("/api/*", (c) => c.json({ error: "Not found." }, 404))
    return app
}
