import { describe, expect, it } from "vitest"
import {
    CENT,
    STATE_CODES,
    STATES,
    USDC,
    amountInWords,
    computeBill,
    financialYear,
    gstinCheckChar,
    isValidGstin,
    roundToCent,
    splitOrder,
    stateCode
} from "../shared/gst.js"

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe("computeBill", () => {
    it("splits 5% GST into CGST and SGST halves", () => {
        const b = computeBill({ lines: [{ unitPrice: 10 * USDC, qty: 2 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(b).toEqual({ subtotal: 20 * USDC, serviceCharge: 0, taxable: 20 * USDC, cgst: 500_000, sgst: 500_000, igst: 0, roundOff: 0, total: 21 * USDC })
    })

    it("uses IGST for inter-state supply", () => {
        const b = computeBill({ lines: [{ unitPrice: 20 * USDC, qty: 1 }], gstRateBps: 1800, serviceChargeBps: 0, intraState: false })
        expect(b.cgst).toBe(0)
        expect(b.sgst).toBe(0)
        expect(b.igst).toBe(3_600_000)
        expect(b.total).toBe(23_600_000)
    })

    it("rounds each half to a cent, half up", () => {
        // taxable 3.33: 2.5% is 0.08325 -> 0.08 each
        const b = computeBill({ lines: [{ unitPrice: 3_330_000, qty: 1 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(b.cgst).toBe(80_000)
        expect(b.sgst).toBe(80_000)
        expect(b.total).toBe(3_490_000)
        // taxable 1.00: 2.5% is exactly 0.025 -> rounds half up to 0.03
        const h = computeBill({ lines: [{ unitPrice: USDC, qty: 1 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(h.cgst).toBe(30_000)
        expect(h.total).toBe(1_060_000)
    })

    it("charges GST on the service charge too", () => {
        const b = computeBill({ lines: [{ unitPrice: 15 * USDC, qty: 1 }, { unitPrice: 5 * USDC, qty: 1 }], gstRateBps: 500, serviceChargeBps: 1000, intraState: true })
        expect(b.subtotal).toBe(20 * USDC)
        expect(b.serviceCharge).toBe(2 * USDC)
        expect(b.taxable).toBe(22 * USDC)
        expect(b.cgst).toBe(550_000)
        expect(b.sgst).toBe(550_000)
        expect(b.total).toBe(23_100_000)
    })

    it("rounds the service charge to a cent", () => {
        // 7.5% of 3.33 = 0.24975 -> 0.25
        const b = computeBill({ lines: [{ unitPrice: 3_330_000, qty: 1 }], gstRateBps: 0, serviceChargeBps: 750, intraState: true })
        expect(b.serviceCharge).toBe(250_000)
        expect(b.total).toBe(3_580_000)
    })

    it("adds a round-off only for prices that aren't whole cents", () => {
        const b = computeBill({ lines: [{ unitPrice: 1_235_000, qty: 1 }], gstRateBps: 0, serviceChargeBps: 0, intraState: true })
        expect(b.roundOff).toBe(5_000)
        expect(b.total).toBe(1_240_000)
        const d = computeBill({ lines: [{ unitPrice: 1_234_567, qty: 1 }], gstRateBps: 0, serviceChargeBps: 0, intraState: true })
        expect(d.roundOff).toBe(-4_567)
        expect(d.total).toBe(1_230_000)
        expect(b.total % CENT).toBe(0)
    })

    it("always satisfies total = parts (the database CHECK)", () => {
        for (let p = 10_000; p < 3_000_000; p += 137_770) {
            for (const sc of [0, 500, 1250]) {
                const b = computeBill({ lines: [{ unitPrice: p, qty: 3 }, { unitPrice: 2_500_000, qty: 1 }], gstRateBps: 500, serviceChargeBps: sc, intraState: true })
                expect(b.total).toBe(b.subtotal + b.serviceCharge + b.cgst + b.sgst + b.igst + b.roundOff)
                expect(b.total % CENT).toBe(0)
            }
        }
    })

    it("rejects fractional or negative inputs", () => {
        expect(() => computeBill({ lines: [{ unitPrice: 1.5, qty: 1 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })).toThrow()
        expect(() => computeBill({ lines: [{ unitPrice: 100, qty: -1 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })).toThrow()
    })

    it("roundToCent rounds half up", () => {
        expect(roundToCent(5_000)).toBe(10_000)
        expect(roundToCent(4_999)).toBe(0)
        expect(roundToCent(1_234_567)).toBe(1_230_000)
    })
})

describe("splitOrder", () => {
    const lines = [
        { unitPrice: 15 * USDC, qty: 1, guest: 1 },
        { unitPrice: 5 * USDC, qty: 1, guest: 2 },
        { unitPrice: 3_330_000, qty: 1, guest: 3 }
    ]

    it("by items: shares sum to the total and track what each guest ordered", () => {
        const totals = computeBill({ lines, gstRateBps: 500, serviceChargeBps: 1000, intraState: true })
        const shares = splitOrder(lines, 3, totals, "items")
        expect(sum(shares)).toBe(totals.total)
        for (const s of shares) expect(s % CENT).toBe(0)
        // total 26.94 on a 23.33 subtotal: 3.61 on top, shared 15 : 5 : 3.33
        expect(totals.total).toBe(26_940_000)
        expect(shares[0]).toBe(17_320_000)
        expect(shares[1]).toBe(5_770_000)
        expect(shares[2]).toBe(3_850_000)
    })

    it("by items: a guest with no dishes pays nothing", () => {
        const totals = computeBill({ lines, gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        const shares = splitOrder(lines, 4, totals, "items")
        expect(shares[3]).toBe(0)
        expect(sum(shares)).toBe(totals.total)
    })

    it("equal: whole cents, leftover spread from guest 1", () => {
        const totals = computeBill({ lines: [{ unitPrice: 10 * USDC, qty: 1 }], gstRateBps: 0, serviceChargeBps: 0, intraState: true })
        const shares = splitOrder([], 3, totals, "equal")
        expect(shares).toEqual([3_340_000, 3_330_000, 3_330_000])
        expect(sum(shares)).toBe(10 * USDC)
    })

    it("always sums to total over many inputs", () => {
        for (let g = 1; g <= 7; g++) {
            const ls = Array.from({ length: g }, (_, i) => ({ unitPrice: 1_110_000 * (i + 1) + 70_000, qty: (i % 3) + 1, guest: i + 1 }))
            const totals = computeBill({ lines: ls, gstRateBps: 500, serviceChargeBps: 750, intraState: true })
            expect(sum(splitOrder(ls, g, totals, "items"))).toBe(totals.total)
            expect(sum(splitOrder(ls, g, totals, "equal"))).toBe(totals.total)
        }
    })

    it("by items: never negative, even when rounding drift piles up on a cheap last dish", () => {
        // 19 guests with a 0.10 dish and a last guest with a 0.01 dish, 5% GST. Rounding each share
        // naively would give the last guest -0.08 and everyone else 2.09 against a 2.01 total.
        const ls = Array.from({ length: 19 }, (_, i) => ({ unitPrice: 100_000, qty: 1, guest: i + 1 }))
        ls.push({ unitPrice: CENT, qty: 1, guest: 20 })
        const totals = computeBill({ lines: ls, gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(totals.total).toBe(2_010_000)
        const shares = splitOrder(ls, 20, totals, "items")
        expect(sum(shares)).toBe(totals.total)
        for (const s of shares) {
            expect(s).toBeGreaterThanOrEqual(0)
            expect(s % CENT).toBe(0)
        }
        expect(shares[19]).toBeGreaterThan(0)
    })

    it("by items: no share is negative and they always add up, over random orders", () => {
        let seed = 7
        const rand = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31
            return seed % n
        }
        for (let round = 0; round < 300; round++) {
            const guests = 1 + rand(20)
            const ls = Array.from({ length: 1 + rand(30) }, () => ({ unitPrice: (1 + rand(5000)) * CENT, qty: 1 + rand(3), guest: 1 + rand(guests) }))
            const totals = computeBill({ lines: ls, gstRateBps: [0, 500, 1200, 1800][rand(4)]!, serviceChargeBps: rand(2001), intraState: true })
            const shares = splitOrder(ls, guests, totals, "items")
            expect(sum(shares)).toBe(totals.total)
            for (const [i, s] of shares.entries()) {
                expect(s).toBeGreaterThanOrEqual(0)
                // Somebody who ordered nothing pays nothing.
                if (!ls.some((l) => l.guest === i + 1)) expect(s).toBe(0)
            }
        }
    })

    it("rejects lines that don't match the bill", () => {
        const totals = computeBill({ lines, gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(() => splitOrder(lines.slice(1), 3, totals, "items")).toThrow()
        expect(() => splitOrder(lines, 2, totals, "items")).toThrow()
    })
})

describe("GSTIN", () => {
    it("accepts known-valid GSTINs", () => {
        for (const g of ["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", "27AAACR5055K1Z7", "29AAACF1234A1ZB"]) expect(isValidGstin(g)).toBe(true)
    })

    it("rejects a wrong check digit", () => {
        expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false)
        expect(isValidGstin("29AAACF1234A1Z5")).toBe(false)
        expect(gstinCheckChar("29AAACF1234A1Z")).toBe("B")
    })

    it("rejects bad formats and unknown state codes", () => {
        expect(isValidGstin("")).toBe(false)
        expect(isValidGstin("27aapfu0939f1zv")).toBe(false)
        expect(isValidGstin("27AAPFU0939F1Z")).toBe(false)
        expect(isValidGstin("27AAPFU0939F1XV")).toBe(false)
        const body = "00AAPFU0939F1Z"
        expect(isValidGstin(body + gstinCheckChar(body))).toBe(false)
        const ok = "36AAPFU0939F1Z"
        expect(isValidGstin(ok + gstinCheckChar(ok))).toBe(true)
    })

    it("lists every state and UT with its code", () => {
        expect(STATES.length).toBe(36)
        expect(STATE_CODES.Karnataka).toBe("29")
        expect(STATE_CODES.Maharashtra).toBe("27")
        expect(STATE_CODES.Delhi).toBe("07")
        expect(stateCode("Ladakh")).toBe("38")
        expect(stateCode("toString")).toBeNull()
        expect(new Set(Object.values(STATE_CODES)).size).toBe(36)
    })
})

describe("amountInWords", () => {
    it("reads amounts out", () => {
        expect(amountInWords(21_500_000)).toBe("Twenty-one USDC and fifty cents only")
        expect(amountInWords(21 * USDC)).toBe("Twenty-one USDC only")
        expect(amountInWords(0)).toBe("Zero USDC only")
        expect(amountInWords(10_000)).toBe("One cent only")
        expect(amountInWords(990_000)).toBe("Ninety-nine cents only")
        expect(amountInWords(1_105_010_000)).toBe("One thousand one hundred five USDC and one cent only")
        expect(amountInWords(2_000_015 * USDC)).toBe("Two million fifteen USDC only")
    })

    it("rounds to the nearest cent", () => {
        expect(amountInWords(1_995_000)).toBe("Two USDC only")
    })
})

describe("financialYear", () => {
    const ist = (iso: string) => Date.parse(iso + "+05:30")

    it("runs April to March in IST", () => {
        expect(financialYear(ist("2026-04-01T00:00:00"))).toBe("2026-27")
        expect(financialYear(ist("2026-03-31T23:59:59"))).toBe("2025-26")
        expect(financialYear(ist("2027-03-31T23:59:59"))).toBe("2026-27")
        expect(financialYear(ist("2026-10-31T12:00:00"))).toBe("2026-27")
    })

    it("uses IST, not UTC, at the boundary", () => {
        // 2026-03-31 19:00 UTC is already 1 April 00:30 in India.
        expect(financialYear(Date.parse("2026-03-31T19:00:00Z"))).toBe("2026-27")
        expect(financialYear(Date.parse("2026-03-31T18:29:59Z"))).toBe("2025-26")
    })

    it("pads the century rollover", () => {
        expect(financialYear(ist("2099-06-01T00:00:00"))).toBe("2099-00")
        expect(financialYear(ist("2008-06-01T00:00:00"))).toBe("2008-09")
    })
})
