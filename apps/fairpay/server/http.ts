import { timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { getAddress, isAddress } from "viem"
import type { Wallet } from "../shared/types.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<any, any, any>

/** An error the client sees as `{ error: message }` with this status. */
export class HttpError extends Error {
    constructor(
        readonly status: ContentfulStatusCode,
        message: string
    ) {
        super(message)
    }
}

/** Default cap for JSON bodies. Routes that need more pass their own limit to readJson. */
export const JSON_LIMIT = 16 * 1024

/**
 * Reads the body as a JSON object. The content-type is not trusted or required: the x-fairpay
 * header already blocks cross-site requests, and the body is parsed strictly here.
 */
export async function readJson(c: AnyContext, maxBytes = JSON_LIMIT): Promise<Record<string, unknown>> {
    let text: string
    try {
        text = await c.req.text()
    } catch {
        throw new HttpError(400, "Could not read the request body.")
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new HttpError(413, "Request body too large.")
    if (text.trim() === "") throw new HttpError(400, "Send a JSON body.")
    let body: unknown
    try {
        body = JSON.parse(text)
    } catch {
        throw new HttpError(400, "Send a valid JSON body.")
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Send a JSON object.")
    return body as Record<string, unknown>
}

// ------------------------------------------------------------------ input checks

type StrOpts = { min?: number; max: number; name?: string; trim?: boolean }

/** A required string, trimmed, between min (default 1) and max characters. */
export function str(v: unknown, opts: StrOpts): string {
    const name = opts.name ?? "Value"
    if (typeof v !== "string") throw new HttpError(400, `${name} must be text.`)
    const s = opts.trim === false ? v : v.trim()
    const min = opts.min ?? 1
    // Count code points so an emoji is one character, like char_length in Postgres.
    const len = [...s].length
    if (len < min) throw new HttpError(400, min <= 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`)
    if (len > opts.max) throw new HttpError(400, `${name} must be at most ${opts.max} characters.`)
    // Control characters have no place in names, notes or emails.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new HttpError(400, `${name} contains invalid characters.`)
    return s
}

/** An optional string: undefined, null or blank becomes null; otherwise as str(). */
export function optStr(v: unknown, opts: Omit<StrOpts, "min">): string | null {
    if (v === undefined || v === null) return null
    if (typeof v === "string" && v.trim() === "") return null
    return str(v, { ...opts, min: 1 })
}

/** A whole number between min and max (inclusive). Money is always checked with this. */
export function int(v: unknown, opts: { min: number; max: number; name?: string }): number {
    const name = opts.name ?? "Value"
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new HttpError(400, `${name} must be a whole number.`)
    if (v < opts.min || v > opts.max) throw new HttpError(400, `${name} must be between ${opts.min} and ${opts.max}.`)
    return v
}

/** A wallet address in any case, returned lowercase (the database's form). */
export function wallet(v: unknown, name = "Wallet"): Wallet {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.trim())) throw new HttpError(400, `${name} must be a 0x address.`)
    const s = v.trim()
    // Mixed case means a checksummed address; a wrong checksum is a typo, so refuse it.
    const hex = s.slice(2)
    const singleCase = hex === hex.toLowerCase() || hex === hex.toUpperCase()
    if (!singleCase && !isAddress(s)) {
        throw new HttpError(400, `${name} has a wrong checksum. Check the address.`)
    }
    if (/^0x0{40}$/i.test(s)) throw new HttpError(400, `${name} must be a real address.`)
    return s.toLowerCase() as Wallet
}

export function bool(v: unknown, name = "Value"): boolean {
    if (typeof v !== "boolean") throw new HttpError(400, `${name} must be true or false.`)
    return v
}

/** Checksummed form for viem calls. */
export function checksum(w: string) {
    return getAddress(w)
}

// ------------------------------------------------------------------ rate limits

/**
 * Fixed-window counter. In memory: fine for one server, use a shared store if you scale out.
 * At most `maxKeys` keys are kept; expired windows are dropped first, then the oldest window.
 */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 10_000) {
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

export type RateLimiter = ReturnType<typeof rateLimiter>

/** Throws 429 when this client is over the limiter's allowance. */
export function limit(c: AnyContext, limiter: RateLimiter, key = clientIp(c)) {
    if (!limiter.hit(key)) throw new HttpError(429, "Too many requests. Wait a minute and try again.")
}

// The rate-limit key of each request, set by server/app.ts from the socket (and trusted proxies).
// Keyed by the request's context, not c.req.raw: the body-limit middleware swaps c.req.raw for a
// new Request when a body comes without Content-Length (chunked), which would turn every such
// request into "unknown" and let a client step out of its own address's limits.
const ips = new WeakMap<object, string>()

export function rememberClientIp(c: AnyContext, ip: string) {
    ips.set(c, ipKey(ip))
}

/** The client's rate-limit key: an IPv4 address or an IPv6 /64. "unknown" when none was set. */
export function clientIp(c: AnyContext): string {
    return ips.get(c) ?? "unknown"
}

/**
 * The key rate limits are counted under. IPv4-mapped IPv6 becomes plain IPv4, and IPv6 is cut to
 * its /64: one host usually owns a whole /64, so per-address limits would be free to bypass.
 */
export function ipKey(ip: string): string {
    let a = ip.trim()
    if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1)
    const zone = a.indexOf("%")
    if (zone !== -1) a = a.slice(0, zone)
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a)
    if (mapped) a = mapped[1]!
    const kind = isIP(a)
    if (kind === 4) return a
    if (kind !== 6) return "unknown"
    return expandIpv6(a).slice(0, 4).join(":") + "::/64"
}

function expandIpv6(a: string): string[] {
    let s = a.toLowerCase()
    // A trailing dotted quad (::1.2.3.4) is two hextets.
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
    if (v4) {
        const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number]
        s = s.slice(0, v4.index) + ((b0 << 8) | b1).toString(16) + ":" + ((b2 << 8) | b3).toString(16)
    }
    const [head, tail] = s.split("::") as [string, string | undefined]
    const h = head ? head.split(":") : []
    const t = tail ? tail.split(":") : []
    const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0")
    return [...h, ...fill, ...t].map((x) => x.padStart(4, "0"))
}

/**
 * The client address when the server sits behind `trustedHops` reverse proxies that each append
 * to X-Forwarded-For. Only the entries those proxies wrote are believed; anything to their left
 * came from the client and is ignored. With no trusted proxies the socket address is used.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined, trustedHops: number): string {
    const socket = remote ?? "unknown"
    if (trustedHops <= 0 || !forwardedFor) return socket
    const hops = forwardedFor.split(",").map((s) => s.trim())
    if (hops.length < trustedHops) return socket
    const candidate = hops[hops.length - trustedHops]!
    return isIP(candidate) ? candidate : socket
}

/** Header the website's proxy (Vercel) adds to every /api request it forwards. See DEPLOY.md. */
export const PROXY_HEADER = "x-fairpay-proxy"

/**
 * Header Vercel's rewrite sets to the visitor's address. In our measurements it held the real
 * address on every request, even when the client sent its own, while X-Forwarded-For and
 * x-vercel-forwarded-for kept a client's forged value on about half of them. A request straight
 * to the host can send it too, so it is believed only with the proxy secret (proxyVerdict "yes").
 */
export const VERCEL_CLIENT_HEADER = "x-vercel-proxied-for"

/** The address Vercel's header names for a verified proxied request, else `fallback`. */
export function proxiedClientAddress(vercelClient: string | undefined, fallback: string): string {
    const last = vercelClient?.split(",").pop()?.trim()
    return last && isIP(last) ? last : fallback
}

/**
 * Whether a request came through the website's proxy: "off" when no PROXY_SECRET is set (every
 * request is then counted as proxied), "yes" when the header carries the secret, "no" otherwise.
 * A request that skipped the proxy has one hop fewer in X-Forwarded-For, so its address is read
 * one hop further right, where the host's own proxy wrote it, and it can't pick its own.
 */
export function proxyVerdict(secret: string | undefined, header: string | undefined): "off" | "yes" | "no" {
    if (!secret) return "off"
    if (!header) return "no"
    const a = Buffer.from(header, "utf8")
    const b = Buffer.from(secret, "utf8")
    return a.length === b.length && timingSafeEqual(a, b) ? "yes" : "no"
}

// ------------------------------------------------------------------ CSRF

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Mutating requests must carry `x-fairpay: 1`. A custom header forces a CORS preflight, and this
 * server never approves one, so another site can't send it.
 */
export function checkCsrf(c: AnyContext) {
    if (MUTATING.has(c.req.method) && c.req.header("x-fairpay") !== "1") {
        throw new HttpError(403, "Missing the x-fairpay header.")
    }
}
