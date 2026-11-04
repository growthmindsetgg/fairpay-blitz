// Where a merchant lands after signing in (src/lib/landing.ts): their dashboard from Home, never
// away from a deep link, and once per tab session.

import { describe, expect, it } from "vitest"
import { isHomePath, landingTarget, merchantHome } from "../src/lib/landing.js"

const W = "0x20835c231a5ab47e0a19591ea23f20cac1556d25"
const ONE = [{ id: "r_saffrontable" }]
const TWO = [{ id: "r_saffrontable" }, { id: "r_other" }]

describe("merchant landing", () => {
    it("goes to the one dashboard, the list for several, nowhere for none", () => {
        expect(merchantHome(ONE)).toBe("/business/faireats/manage/r_saffrontable")
        expect(merchantHome(TWO)).toBe("/business/faireats")
        expect(merchantHome([])).toBeNull()
        expect(merchantHome([{ id: "r/../x" }])).toBe("/business/faireats/manage/r%2F..%2Fx")
    })

    it("lands from Home on first load and on sign-in", () => {
        expect(landingTarget({ event: "load", wallet: W, restaurants: ONE, pathname: "/", landed: null })).toBe("/business/faireats/manage/r_saffrontable")
        expect(landingTarget({ event: "signin", wallet: W, restaurants: TWO, pathname: "/", landed: null })).toBe("/business/faireats")
    })

    it("never moves someone who opened a deep link", () => {
        for (const pathname of ["/b/tok", "/bills/b_1", "/o/o_1", "/i/tok", "/r/saffron-table", "/business/faireats", "/profile", "/requests"]) {
            expect(landingTarget({ event: "load", wallet: W, restaurants: ONE, pathname, landed: null }), pathname).toBeNull()
            expect(landingTarget({ event: "signin", wallet: W, restaurants: ONE, pathname, landed: null }), pathname).toBeNull()
        }
    })

    it("lands once per tab session: a reload on Home stays, a fresh sign-in or another wallet lands", () => {
        expect(landingTarget({ event: "load", wallet: W, restaurants: ONE, pathname: "/", landed: W })).toBeNull()
        expect(landingTarget({ event: "signin", wallet: W, restaurants: ONE, pathname: "/", landed: W })).not.toBeNull()
        expect(landingTarget({ event: "load", wallet: W, restaurants: ONE, pathname: "/", landed: "0xother" })).not.toBeNull()
    })

    it("leaves wallets with no restaurant on Home", () => {
        expect(landingTarget({ event: "signin", wallet: W, restaurants: [], pathname: "/", landed: null })).toBeNull()
        expect(isHomePath("/")).toBe(true)
        expect(isHomePath("/friends")).toBe(false)
    })
})
