// The app served by the public website at /pay/, with /api proxied to this server (DEPLOY.md).
import { describe, expect, it } from "vitest"
import type { Bill } from "../shared/types.js"
import { clientAddress, proxiedClientAddress, proxyVerdict } from "../server/http.js"
import { appPathFrom, appUrlOf } from "../server/origin.js"
import { makeTestApp, TEST_ORIGIN } from "./helpers.js"

const ALICE = "0x1111111111111111111111111111111111111111"
const BOB = "0x2222222222222222222222222222222222222222"

describe("PUBLIC_APP_PATH", () => {
    it("is the root by default", () => {
        for (const v of [undefined, "", "  ", "/"]) expect(appPathFrom({ PUBLIC_APP_PATH: v }), String(v)).toBe("")
    })

    it("takes a plain path, with or without a trailing slash", () => {
        expect(appPathFrom({ PUBLIC_APP_PATH: "/pay" })).toBe("/pay")
        expect(appPathFrom({ PUBLIC_APP_PATH: " /pay/ " })).toBe("/pay")
        expect(appPathFrom({ PUBLIC_APP_PATH: "/apps/fair-pay" })).toBe("/apps/fair-pay")
    })

    it("refuses anything that isn't a plain path", () => {
        for (const bad of ["pay", "/pay?x=1", "/pay#a", "/../pay", "/pay/..", "https://x/pay", "//evil.example", "/p ay", "/%2e%2e", "C:/Program Files/Git/pay"]) {
            expect(() => appPathFrom({ PUBLIC_APP_PATH: bad }), bad).toThrow(/PUBLIC_APP_PATH must be/)
        }
    })

    it("builds app links from the origin and the path", () => {
        expect(appUrlOf({ publicOrigin: "https://fairpay-blitz.vercel.app", appPath: "/pay" })).toBe("https://fairpay-blitz.vercel.app/pay")
        expect(appUrlOf({ publicOrigin: "https://fairpay.onrender.com" })).toBe("https://fairpay.onrender.com")
    })
})

describe("served under /pay", () => {
    it("puts /pay in share links", async () => {
        const t = await makeTestApp({ appPath: "/pay" })
        const cookie = await t.signIn(ALICE)
        const res = await t.call("POST", "/api/bills", {
            cookie,
            body: { title: "Dinner", total: 30_000_000, splitType: "equal", participants: [{ wallet: BOB, displayName: "Bob" }] }
        })
        expect(res.status).toBe(201)
        const bill = (await res.json()) as Bill
        expect(bill.shareUrl).toMatch(new RegExp(`^${TEST_ORIGIN}/pay/b/[A-Za-z0-9_-]{43}$`))
    })

    it("sends page visits on this server to the website, and leaves /api alone", async () => {
        const t = await makeTestApp({ appPath: "/pay" })
        const res = await t.app.request("/b/abc123?x=1")
        expect(res.status).toBe(308)
        expect(res.headers.get("location")).toBe(`${TEST_ORIGIN}/pay/b/abc123?x=1`)
        expect((await t.app.request("/")).headers.get("location")).toBe(`${TEST_ORIGIN}/pay/`)
        // No redirect loop if this server is ever opened at the app path itself.
        expect((await t.app.request("/pay/b/abc")).status).toBe(404)
        expect((await t.app.request("/api/config")).status).toBe(200)
        expect((await t.app.request("/api/nope")).status).toBe(404)
    })

    it("keeps the root layout when no path is set", async () => {
        const t = await makeTestApp()
        expect((await t.app.request("/b/abc")).headers.get("location")).toBeNull()
    })
})

describe("client address behind the website's proxy", () => {
    it("shows the caller the address rate limits use", async () => {
        const t = await makeTestApp()
        const res = await t.app.request("/api/whoami", { headers: { "x-test-ip": "203.0.113.7" } })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ip: "203.0.113.7", proxy: "off" })
        expect(res.headers.get("cache-control")).toBe("no-store")
    })

    it("answers wake-up pings, uncached and without starting a session", async () => {
        const t = await makeTestApp()
        const res = await t.app.request("/api/health")
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(res.headers.get("set-cookie")).toBeNull()
    })

    it("checks the proxy secret in constant time and never accepts a missing one", () => {
        expect(proxyVerdict(undefined, "anything")).toBe("off")
        expect(proxyVerdict("s3cret-value", undefined)).toBe("no")
        expect(proxyVerdict("s3cret-value", "")).toBe("no")
        expect(proxyVerdict("s3cret-value", "s3cret-valu")).toBe("no")
        expect(proxyVerdict("s3cret-value", "s3cret-valuE")).toBe("no")
        expect(proxyVerdict("s3cret-value", "s3cret-value")).toBe("yes")
    })

    it("reads a request straight to Render with 3 hops, so a forged X-Forwarded-For is ignored", () => {
        // Cloudflare and Render's load balancer both append, so a direct request
        // arrives as "forged, visitor, cloudflare, balancer". With PROXY_SECRET set, a request
        // without the proxy header is read with TRUST_PROXY_HOPS - 1 = 3.
        expect(clientAddress("10.0.0.1", "6.6.6.6, 203.0.113.9, 172.70.1.1, 10.198.0.1", 3)).toBe("203.0.113.9")
        expect(clientAddress("10.0.0.1", "6.6.6.6, 203.0.113.9, 172.70.1.1, 10.198.0.1", 4)).toBe("6.6.6.6")
    })

    it("takes a proxied visitor from Vercel's own header, which a client can't forge", () => {
        // Through Vercel, X-Forwarded-For sometimes keeps a forged first entry, so 4 hops can land
        // on it; x-vercel-proxied-for always held the real visitor.
        const byHops = clientAddress("10.0.0.1", "6.6.6.6, 3.109.0.1, 172.70.1.1, 10.196.0.1", 4)
        expect(byHops).toBe("6.6.6.6")
        expect(proxiedClientAddress("203.0.113.9", byHops)).toBe("203.0.113.9")
        expect(proxiedClientAddress("8.8.8.8, 203.0.113.9", byHops)).toBe("203.0.113.9")
        expect(proxiedClientAddress(undefined, byHops)).toBe(byHops)
        expect(proxiedClientAddress("not-an-ip", byHops)).toBe(byHops)
    })
})
