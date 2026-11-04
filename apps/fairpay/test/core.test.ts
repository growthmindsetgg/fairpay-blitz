import { beforeEach, describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createSiweMessage } from "viem/siwe"
import type { Friend, Me, Profile } from "../shared/types.js"
import { formatUsdc, parseUsdc } from "../shared/money.js"
import { newId, newOrderRef, newToken } from "../server/ids.js"
import { DEV_ORIGIN, publicOriginFrom } from "../server/origin.js"
import { makeTestApp, TEST_ORIGIN, type TestApp } from "./helpers.js"

const ALICE = "0x1111111111111111111111111111111111111111"
const BOB = "0x2222222222222222222222222222222222222222"

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
    return (await res.json()) as T
}

function cookieFrom(res: Response): string {
    const set = res.headers.get("set-cookie") ?? ""
    const m = /fp_session=([^;]*)/.exec(set)
    return m ? `fp_session=${m[1]}` : ""
}

describe("SIWE sign-in", () => {
    let t: TestApp
    const account = privateKeyToAccount(generatePrivateKey())
    const origin = new URL(TEST_ORIGIN)

    beforeEach(async () => {
        t = await makeTestApp()
    })

    async function signedMessage(over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
        const { nonce } = await json<{ nonce: string }>(await t.call("GET", "/api/auth/nonce"))
        const message = createSiweMessage({
            address: account.address,
            chainId: 10143,
            domain: origin.host,
            nonce,
            uri: TEST_ORIGIN,
            version: "1",
            issuedAt: new Date(),
            statement: "Sign in to FairPay.",
            ...over
        })
        return { message, signature: await account.signMessage({ message }) }
    }

    it("signs in, sets a hardened session cookie, and signs out", async () => {
        const body = await signedMessage()
        const res = await t.call("POST", "/api/auth/verify", { body })
        expect(res.status).toBe(200)
        const me = await json<Me>(res)
        expect(me.profile.wallet).toBe(account.address.toLowerCase())
        expect(me.restaurants).toEqual([])

        const set = res.headers.get("set-cookie") ?? ""
        expect(set).toMatch(/HttpOnly/i)
        expect(set).toMatch(/SameSite=Lax/i)
        expect(set).toMatch(/Max-Age=604800/)
        expect(set).not.toMatch(/Secure/i) // http origin in tests
        const cookie = cookieFrom(res)

        // Only the hash of the token is stored.
        const token = cookie.split("=")[1]!
        const rows = await t.deps.db.query<{ token_hash: string }>("SELECT token_hash FROM sessions")
        expect(rows).toHaveLength(1)
        expect(rows[0]!.token_hash).not.toContain(token)

        expect((await t.call("GET", "/api/me", { cookie })).status).toBe(200)
        expect((await t.call("POST", "/api/auth/logout", { cookie })).status).toBe(200)
        expect((await t.call("GET", "/api/me", { cookie })).status).toBe(401)
        expect(await t.deps.db.query("SELECT 1 FROM sessions")).toHaveLength(0)
    })

    it("rejects a reused nonce", async () => {
        const body = await signedMessage()
        expect((await t.call("POST", "/api/auth/verify", { body })).status).toBe(200)
        const again = await t.call("POST", "/api/auth/verify", { body })
        expect(again.status).toBe(401)
        expect((await json(again)).error).toMatch(/nonce/)
    })

    it("rejects a nonce the server never issued", async () => {
        const message = createSiweMessage({
            address: account.address,
            chainId: 10143,
            domain: origin.host,
            nonce: "abcdefgh12345678",
            uri: TEST_ORIGIN,
            version: "1",
            issuedAt: new Date()
        })
        const res = await t.call("POST", "/api/auth/verify", { body: { message, signature: await account.signMessage({ message }) } })
        expect(res.status).toBe(401)
    })

    it("rejects the wrong domain, uri, chain and an old message", async () => {
        for (const over of [
            { domain: "evil.example" },
            { uri: "https://evil.example/login" },
            { chainId: 1 },
            { issuedAt: new Date(Date.now() - 11 * 60_000) },
            { expirationTime: new Date(Date.now() - 1000) }
        ]) {
            const res = await t.call("POST", "/api/auth/verify", { body: await signedMessage(over) })
            expect(res.status, JSON.stringify(over)).toBe(401)
        }
        expect(await t.deps.db.query("SELECT 1 FROM sessions")).toHaveLength(0)
    })

    it("says which way the clock is off: too old, or issued in the future", async () => {
        const old = await t.call("POST", "/api/auth/verify", { body: await signedMessage({ issuedAt: new Date(Date.now() - 11 * 60_000) }) })
        expect(old.status).toBe(401)
        expect((await json(old)).error).toMatch(/too old/)
        const ahead = await t.call("POST", "/api/auth/verify", { body: await signedMessage({ issuedAt: new Date(Date.now() + 5 * 60_000) }) })
        expect(ahead.status).toBe(401)
        const error = (await json(ahead)).error
        expect(error).toMatch(/in the future/)
        expect(error).not.toMatch(/too old/)
    })

    it("rejects a signature from another wallet", async () => {
        const body = await signedMessage()
        const other = privateKeyToAccount(generatePrivateKey())
        const res = await t.call("POST", "/api/auth/verify", { body: { message: body.message, signature: await other.signMessage({ message: body.message }) } })
        expect(res.status).toBe(401)
        expect((await json(res)).error).toMatch(/signature/)
    })

    it("rejects an expired session", async () => {
        let now = Date.now()
        const app = await makeTestApp({ now: () => now })
        const cookie = await app.signIn(ALICE)
        expect((await app.call("GET", "/api/me", { cookie })).status).toBe(200)
        now += 8 * 24 * 60 * 60_000
        expect((await app.call("GET", "/api/me", { cookie })).status).toBe(401)
    })
})

describe("CSRF and headers", () => {
    it("requires x-fairpay on mutating requests", async () => {
        const t = await makeTestApp()
        const cookie = await t.signIn(ALICE)
        const res = await t.app.request("/api/me", {
            method: "PUT",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ displayName: "Alice" })
        })
        expect(res.status).toBe(403)
        expect((await json(res)).error).toMatch(/x-fairpay/)
        // GET needs no header.
        expect((await t.app.request("/api/me", { headers: { cookie } })).status).toBe(200)
        expect((await t.call("PUT", "/api/me", { cookie, body: { displayName: "Alice" } })).status).toBe(200)
    })

    it("sends security headers, JSON 404s and a body limit", async () => {
        const t = await makeTestApp()
        const res = await t.call("GET", "/api/nope")
        expect(res.status).toBe(404)
        expect(await json(res)).toEqual({ error: "Not found." })
        const csp = res.headers.get("content-security-policy") ?? ""
        expect(csp).toContain("default-src 'self'")
        expect(csp).toContain("img-src 'self' data:")
        expect(csp).toContain("frame-ancestors 'none'")
        expect(res.headers.get("x-content-type-options")).toBe("nosniff")
        expect(res.headers.get("cache-control")).toBe("no-store")

        const cookie = await t.signIn(ALICE)
        const big = await t.call("PUT", "/api/me", { cookie, body: { bio: "x".repeat(100_000) } })
        expect(big.status).toBe(413)
        const bad = await t.app.request("/api/me", { method: "PUT", headers: { cookie, "x-fairpay": "1" }, body: "{not json" })
        expect(bad.status).toBe(400)
    })

    it("serves the public config", async () => {
        const t = await makeTestApp()
        const cfg = await json(await t.call("GET", "/api/config"))
        expect(cfg.chainId).toBe(10143)
        expect(cfg.denomination).toBe(5_000_000)
    })
})

describe("profile", () => {
    it("updates only the fields sent and validates them", async () => {
        const t = await makeTestApp()
        const cookie = await t.signIn(ALICE)
        let res = await t.call("PUT", "/api/me", { cookie, body: { displayName: "  Alice  ", email: "alice@example.com", bio: "Hi" } })
        expect(res.status).toBe(200)
        expect(await json<Profile>(res)).toEqual({ wallet: ALICE, displayName: "Alice", email: "alice@example.com", bio: "Hi" })

        res = await t.call("PUT", "/api/me", { cookie, body: { bio: "" } })
        expect(await json<Profile>(res)).toEqual({ wallet: ALICE, displayName: "Alice", email: "alice@example.com", bio: null })

        for (const body of [{ displayName: "x".repeat(61) }, { email: "not-an-email" }, { bio: "y".repeat(281) }, { displayName: 5 }, { displayName: "a\u0000b" }]) {
            const r = await t.call("PUT", "/api/me", { cookie, body })
            expect(r.status, JSON.stringify(body)).toBe(400)
        }
        expect((await t.call("PUT", "/api/me", { body: { displayName: "Anon" } })).status).toBe(401)

        // The public profile shows the name only.
        const pub = await json(await t.call("GET", `/api/profiles/${ALICE.toUpperCase().replace("0X", "0x")}`))
        expect(pub).toEqual({ wallet: ALICE, displayName: "Alice" })
        expect((await t.call("GET", "/api/profiles/nope")).status).toBe(400)
    })

    it("lists restaurants the wallet owns or works at", async () => {
        const t = await makeTestApp()
        const now = Date.now()
        const insert = `INSERT INTO restaurants (id, slug, name, state, owner_wallet, payout_wallet, invoice_prefix, created_at)
                        VALUES ($1, $2, $3, 'Karnataka', $4, $4, $5, $6)`
        await t.deps.db.query(insert, ["r_1", "one", "One", ALICE, "ONE", now])
        await t.deps.db.query(insert, ["r_2", "two", "Two", BOB, "TWO", now])
        await t.deps.db.query("INSERT INTO restaurant_staff (restaurant_id, wallet, role, display_name, added_at) VALUES ('r_2', $1, 'chef', 'Al', $2)", [ALICE, now])
        const cookie = await t.signIn(ALICE)
        const me = await json<Me>(await t.call("GET", "/api/me", { cookie }))
        expect(me.restaurants).toEqual([
            { id: "r_1", slug: "one", name: "One", role: "owner" },
            { id: "r_2", slug: "two", name: "Two", role: "chef" }
        ])
    })
})

describe("friends", () => {
    it("adds, renames, lists and removes friends", async () => {
        const t = await makeTestApp()
        const cookie = await t.signIn(ALICE)
        expect((await t.call("POST", "/api/friends", { cookie, body: { wallet: BOB, nickname: "Bob" } })).status).toBe(201)
        expect((await t.call("POST", "/api/friends", { cookie, body: { wallet: BOB, nickname: "Bobby" } })).status).toBe(201)
        expect(await json<Friend[]>(await t.call("GET", "/api/friends", { cookie }))).toEqual([{ wallet: BOB, nickname: "Bobby" }])

        expect((await t.call("POST", "/api/friends", { cookie, body: { wallet: ALICE, nickname: "Me" } })).status).toBe(400)
        expect((await t.call("POST", "/api/friends", { cookie, body: { wallet: "0x123", nickname: "Bad" } })).status).toBe(400)
        expect((await t.call("POST", "/api/friends", { cookie, body: { wallet: BOB, nickname: "" } })).status).toBe(400)
        expect((await t.call("GET", "/api/friends")).status).toBe(401)

        // Friends are private to their owner.
        const bob = await t.signIn(BOB)
        expect(await json<Friend[]>(await t.call("GET", "/api/friends", { cookie: bob }))).toEqual([])

        expect((await t.call("DELETE", `/api/friends/${BOB}`, { cookie })).status).toBe(200)
        expect(await json<Friend[]>(await t.call("GET", "/api/friends", { cookie }))).toEqual([])
    })
})

describe("activity", () => {
    it("lists a wallet's own activity and marks it read", async () => {
        const t = await makeTestApp()
        const now = Date.now()
        await t.deps.db.query(
            "INSERT INTO activity (wallet, kind, title, created_at) VALUES ($1, 'bill_request', 'Pay me', $2), ($3, 'bill_request', 'Not yours', $2)",
            [ALICE, now, BOB]
        )
        const cookie = await t.signIn(ALICE)
        let items = await json<{ title: string; read: boolean }[]>(await t.call("GET", "/api/activity", { cookie }))
        expect(items.map((i) => [i.title, i.read])).toEqual([["Pay me", false]])
        expect((await t.call("POST", "/api/activity/read", { cookie })).status).toBe(200)
        items = await json(await t.call("GET", "/api/activity", { cookie }))
        expect(items[0]!.read).toBe(true)
    })
})

describe("ids and money", () => {
    it("makes unguessable ids and tokens", () => {
        expect(newId("b")).toMatch(/^b_[a-z2-7]{16}$/)
        expect(newId("b_")).toMatch(/^b_[a-z2-7]{16}$/)
        expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
        const { orderRef, secret } = newOrderRef("b_1", "p_1")
        expect(orderRef).toMatch(/^0x[0-9a-f]{64}$/)
        expect(secret).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it("formats and parses USDC", () => {
        expect(formatUsdc(1_234_500_000)).toBe("1,234.50")
        expect(formatUsdc(5_000_000, { symbol: true })).toBe("5.00 USDC")
        expect(formatUsdc(1_234_567, { decimals: 6 })).toBe("1.234567")
        expect(formatUsdc(1_005_000, { decimals: 2 })).toBe("1.01")
        expect(formatUsdc(0)).toBe("0.00")
        expect(parseUsdc("12.5")).toBe(12_500_000)
        expect(parseUsdc("$1,234.56")).toBe(1_234_560_000)
        expect(parseUsdc(".5")).toBe(500_000)
        expect(parseUsdc("3 USDC")).toBe(3_000_000)
        for (const bad of ["", "-1", "1e3", "1.1234567", "12,34", "abc", "99999999999"]) expect(() => parseUsdc(bad), bad).toThrow()
    })
})

describe("PUBLIC_ORIGIN", () => {
    it("defaults to the dev server outside production", () => {
        expect(DEV_ORIGIN).toBe(TEST_ORIGIN)
        expect(publicOriginFrom({})).toBe(DEV_ORIGIN)
        expect(publicOriginFrom({ NODE_ENV: "test" })).toBe(DEV_ORIGIN)
        expect(publicOriginFrom({ NODE_ENV: "development", PUBLIC_ORIGIN: "  " })).toBe(DEV_ORIGIN)
        expect(publicOriginFrom({ PUBLIC_ORIGIN: "http://127.0.0.1:8788" })).toBe("http://127.0.0.1:8788")
    })

    it("refuses to start in production without one", () => {
        for (const value of [undefined, "", "   "]) {
            expect(() => publicOriginFrom({ NODE_ENV: "production", PUBLIC_ORIGIN: value }), String(value)).toThrow(/PUBLIC_ORIGIN is not set/)
        }
    })

    it("accepts only an absolute http(s) origin", () => {
        const env = (value: string) => ({ NODE_ENV: "production", PUBLIC_ORIGIN: value })
        expect(publicOriginFrom(env("https://fairpay.onrender.com"))).toBe("https://fairpay.onrender.com")
        expect(publicOriginFrom(env(" https://FairPay.OnRender.com/ "))).toBe("https://fairpay.onrender.com")
        expect(publicOriginFrom(env("https://fairpay.example:8443"))).toBe("https://fairpay.example:8443")
        for (const bad of [
            "fairpay.onrender.com",
            "localhost:5174",
            "/app",
            "ftp://fairpay.onrender.com",
            "postgresql://user:secret@db.example:5432/postgres",
            "https://fairpay.onrender.com/app",
            "https://fairpay.onrender.com/?x=1",
            "https://fairpay.onrender.com/#top",
            "https://user:secret@fairpay.onrender.com"
        ]) {
            let message = ""
            try {
                publicOriginFrom(env(bad))
            } catch (err) {
                message = (err as Error).message
            }
            expect(message, bad).toMatch(/^PUBLIC_ORIGIN must /)
            // The value itself is never echoed, in case a secret was pasted into it.
            expect(message, bad).not.toContain("secret")
        }
        // The same rules apply in development to a value that is set.
        expect(() => publicOriginFrom({ PUBLIC_ORIGIN: "https://fairpay.onrender.com/app" })).toThrow(/origin only/)
    })
})
