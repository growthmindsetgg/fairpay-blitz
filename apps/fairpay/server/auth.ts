import { createHash, timingSafeEqual } from "node:crypto"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { recoverMessageAddress, type Address, type Hex } from "viem"
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe"
import type { Me, Role, Wallet } from "../shared/types.js"
import type { AppEnv, Db, Deps } from "./context.js"
import { HttpError, limit, rateLimiter, readJson } from "./http.js"
import { newToken } from "./ids.js"

export const SESSION_COOKIE = "fp_session"
export const SESSION_MS = 7 * 24 * 60 * 60_000
const NONCE_MS = 10 * 60_000
// A wallet's clock can run a little ahead of the server's.
const CLOCK_SKEW_MS = 60_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/**
 * Checks that `signature` signs `message` for `address`. The default recovers an EOA signature
 * locally; server/index.ts passes one that falls back to viem's verifySiweMessage on-chain so
 * smart wallets (ERC-1271 / ERC-6492) can sign in too.
 */
export type SignatureVerifier = (p: { message: string; signature: Hex; address: Address }) => Promise<boolean>

export const verifyEoaSignature: SignatureVerifier = async ({ message, signature, address }) => {
    try {
        const signer = await recoverMessageAddress({ message, signature })
        return signer.toLowerCase() === address.toLowerCase()
    } catch {
        return false
    }
}

/** Creates the profile row a wallet's data hangs off, if it doesn't exist yet. */
export async function ensureProfile(q: Db, wallet: Wallet, now: number) {
    await q.query(
        "INSERT INTO profiles (wallet, created_at, updated_at) VALUES ($1, $2, $2) ON CONFLICT (wallet) DO NOTHING",
        [wallet, now]
    )
}

/** Starts a session and returns its token. Only the token's hash is stored. */
export async function createSession(q: Db, wallet: Wallet, now: number): Promise<string> {
    const token = newToken()
    await ensureProfile(q, wallet, now)
    await q.query("INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
        hashToken(token),
        wallet,
        now,
        now + SESSION_MS
    ])
    return token
}

/** Sets c.var.wallet from the fp_session cookie (null when signed out or expired). */
export function sessionMiddleware(deps: Deps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        c.set("wallet", null)
        const token = getCookie(c, SESSION_COOKIE)
        if (token && TOKEN.test(token)) {
            const row = await deps.db.one<{ wallet: Wallet }>(
                "SELECT wallet FROM sessions WHERE token_hash = $1 AND expires_at > $2",
                [hashToken(token), deps.now()]
            )
            if (row) c.set("wallet", row.wallet)
        }
        await next()
    }
}

/** The signed-in wallet, or a 401. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireWallet(c: Context<AppEnv, any, any>): Wallet {
    const w = c.get("wallet")
    if (!w) throw new HttpError(401, "Sign in with your wallet first.")
    return w
}

/** Profile plus the restaurants this wallet owns or works at. */
export async function loadMe(db: Db, wallet: Wallet): Promise<Me> {
    const p = await db.one<{ wallet: Wallet; display_name: string | null; email: string | null; bio: string | null }>(
        "SELECT wallet, display_name, email, bio FROM profiles WHERE wallet = $1",
        [wallet]
    )
    const restaurants = await db.query<{ id: string; slug: string; name: string; role: Role }>(
        `SELECT id, slug, name, 'owner' AS role FROM restaurants WHERE owner_wallet = $1
         UNION ALL
         SELECT r.id, r.slug, r.name, s.role FROM restaurant_staff s JOIN restaurants r ON r.id = s.restaurant_id
         WHERE s.wallet = $1 AND r.owner_wallet <> $1
         ORDER BY name`,
        [wallet]
    )
    return {
        profile: { wallet, displayName: p?.display_name ?? null, email: p?.email ?? null, bio: p?.bio ?? null },
        restaurants: restaurants.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role }))
    }
}

function sameString(a: string, b: string) {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Sign-in with Ethereum (EIP-4361): GET /auth/nonce, POST /auth/verify, POST /auth/logout.
 * The message must name this app's origin and chain, carry a fresh unused nonce, and be signed
 * by the address it names.
 */
export function authRoutes(deps: Deps, options: { verifySignature?: SignatureVerifier } = {}) {
    const verifySignature = options.verifySignature ?? verifyEoaSignature
    const origin = new URL(deps.publicOrigin)
    const secure = origin.protocol === "https:"
    const limits = {
        nonce: rateLimiter(30, 60_000, deps.now),
        verify: rateLimiter(30, 60_000, deps.now)
    }
    const app = new Hono<AppEnv>()

    app.get("/auth/nonce", async (c) => {
        limit(c, limits.nonce)
        const now = deps.now()
        // Expired nonces are useless; clear them as new ones are handed out.
        await deps.db.query("DELETE FROM auth_nonces WHERE created_at < $1", [now - NONCE_MS])
        const nonce = generateSiweNonce()
        await deps.db.query("INSERT INTO auth_nonces (nonce, created_at) VALUES ($1, $2)", [nonce, now])
        return c.json({ nonce })
    })

    app.post("/auth/verify", async (c) => {
        limit(c, limits.verify)
        const body = await readJson(c, 8 * 1024)
        const message = body.message
        const signature = body.signature
        if (typeof message !== "string" || message.length > 4000) throw new HttpError(400, "Send the signed sign-in message.")
        if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) {
            throw new HttpError(400, "Send the signature as hex.")
        }

        const fields = parseSiweMessage(message)
        const now = deps.now()
        const bad = (why: string): never => {
            throw new HttpError(401, `Sign-in refused: ${why}`)
        }
        if (!fields.address || !fields.nonce || !fields.domain || !fields.uri) bad("the message is not a sign-in message.")
        if (fields.domain !== origin.host) bad(`the message is for ${fields.domain}, not ${origin.host}.`)
        if (fields.scheme && `${fields.scheme}:` !== origin.protocol) bad("the message is for another site.")
        let uriOrigin = ""
        try {
            uriOrigin = new URL(fields.uri!).origin
        } catch {
            bad("the message's URI is not valid.")
        }
        if (uriOrigin !== origin.origin) bad("the message's URI is for another site.")
        if (fields.chainId !== deps.chain.deployment.chainId) bad(`sign in on chain ${deps.chain.deployment.chainId}.`)
        const issuedAt = fields.issuedAt?.getTime()
        if (issuedAt === undefined || Number.isNaN(issuedAt)) bad("the message has no issue time.")
        if (issuedAt! > now + CLOCK_SKEW_MS) bad("the message was issued in the future. Check this device's clock and try again.")
        if (issuedAt! < now - NONCE_MS) bad("the message is too old. Try again.")
        // expirationTime / notBefore, and the fields' formats.
        if (!validateSiweMessage({ message: fields, domain: origin.host, time: new Date(now) })) bad("the message has expired.")

        // Use the nonce up before checking the signature, so one message can only ever be tried once.
        const used = await deps.db.one<{ nonce: string }>(
            "UPDATE auth_nonces SET used_at = $2 WHERE nonce = $1 AND used_at IS NULL AND created_at >= $3 RETURNING nonce",
            [fields.nonce, now, now - NONCE_MS]
        )
        if (!used || !sameString(used.nonce, fields.nonce!)) bad("the nonce is unknown, used or expired. Try again.")

        let ok = false
        try {
            ok = await verifySignature({ message, signature: signature as Hex, address: fields.address! })
        } catch (err) {
            console.error("siwe verify:", err instanceof Error ? err.message.split("\n")[0] : err)
            throw new HttpError(502, "Could not check the signature right now. Try again.")
        }
        if (!ok) bad("the signature does not match the address.")

        const wallet = fields.address!.toLowerCase() as Wallet
        const token = await createSession(deps.db, wallet, now)
        setCookie(c, SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: "Lax",
            secure,
            path: "/",
            maxAge: SESSION_MS / 1000
        })
        return c.json(await loadMe(deps.db, wallet))
    })

    app.post("/auth/logout", async (c) => {
        const token = getCookie(c, SESSION_COOKIE)
        if (token && TOKEN.test(token)) await deps.db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)])
        deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" })
        return c.json({ ok: true })
    })

    return app
}
