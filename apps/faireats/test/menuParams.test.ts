// ?guests= on the menu URL (src/menuParams.ts). Pure parsing, no server or chain.
import { describe, expect, it } from "vitest"
import { MAX_GUESTS as SERVER_MAX_GUESTS } from "../server/service.js"
import { demoConfig, MAX_GUESTS as DEMO_MAX_GUESTS } from "../src/demo/config"
import { DEFAULT_GUESTS, guestsFromParam } from "../src/menuParams"

const max = demoConfig("/app/").maxGuests

describe("guestsFromParam", () => {
    it("starts with two guests when the URL doesn't say", () => {
        expect(DEFAULT_GUESTS).toBe(2)
        expect(guestsFromParam(null, max)).toBe(2)
        expect(guestsFromParam("", max)).toBe(2)
    })

    it("reads a whole number from 1 to the maximum", () => {
        expect(guestsFromParam("4", max)).toBe(4)
        expect(guestsFromParam("1", max)).toBe(1)
        expect(guestsFromParam(String(max), max)).toBe(max)
        expect(guestsFromParam(" 3 ", max)).toBe(3)
        expect(guestsFromParam("04", max)).toBe(4)
    })

    it("ignores numbers outside 1 to the maximum", () => {
        expect(guestsFromParam("0", max)).toBe(2)
        expect(guestsFromParam(String(max + 1), max)).toBe(2)
        expect(guestsFromParam("-3", max)).toBe(2)
        expect(guestsFromParam("999999999999", max)).toBe(2)
    })

    it("ignores anything that isn't a plain whole number", () => {
        for (const raw of ["abc", "2.5", "4.0", "1e1", "0x4", "4abc", "+4", "Infinity", "NaN", "4,5"]) {
            expect(guestsFromParam(raw, max), raw).toBe(2)
        }
    })

    it("keeps the default inside a smaller maximum", () => {
        expect(guestsFromParam(null, 1)).toBe(1)
        expect(guestsFromParam("2", 1)).toBe(1)
    })

    it("uses the same maximum as the demo and real servers", () => {
        expect(max).toBe(DEMO_MAX_GUESTS)
        expect(DEMO_MAX_GUESTS).toBe(SERVER_MAX_GUESTS)
    })
})
