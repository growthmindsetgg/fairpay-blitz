// The Overview's chart labels (src/pages/business/statsView.ts): hours, India dates, axis tops.

import { describe, expect, it } from "vitest"
import { bestDayText, busiestText, dayColumns, hourColumns, hourLabel, minutesText, niceMax } from "../src/pages/business/statsView.js"

describe("overview chart labels", () => {
    it("names hours in India time, 12-hour clock", () => {
        expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(["12 am", "1 am", "11 am", "12 pm", "1 pm", "11 pm"])
        const cols = hourColumns(Array.from({ length: 24 }, (_, h) => (h === 13 ? 6 : 0)))
        expect(cols.filter((c) => c.tick).map((c) => c.tick)).toEqual(["12 am", "6 am", "12 pm", "6 pm"])
        expect(cols[23]!.label).toBe("11 pm to 12 am")
        expect(busiestText(cols.map((c) => c.value))).toBe("Busiest: 1 pm to 2 pm, 6 orders.")
        expect(busiestText(Array.from({ length: 24 }, () => 0))).toBe("No paid orders yet.")
    })

    it("labels days by their India date, every day in a week and every seventh in a month", () => {
        const day = (d: string, revenue = 0) => ({ day: d, start: 0, revenue, orders: revenue ? 1 : 0 })
        const week = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"].map((d) => day(d))
        expect(dayColumns(week).map((c) => c.tick)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
        const month = Array.from({ length: 30 }, (_, i) => day(`2026-10-${String(i + 2).padStart(2, "0")}`))
        const ticks = dayColumns(month).filter((c) => c.tick).map((c) => c.tick)
        expect(ticks.at(-1)).toBe("31 Oct")
        expect(ticks).toEqual(["3 Oct", "10 Oct", "17 Oct", "24 Oct", "31 Oct"])
        const cols = dayColumns([day("2026-10-31", 12_500_000)])
        expect(cols[0]).toMatchObject({ label: "Sat 31 Oct", value: 12_500_000, text: "12.50 USDC · 1 order" })
        expect(bestDayText([day("2026-10-30", 3_000_000), day("2026-10-31", 9_000_000)])).toBe("Best day: Sat 31 Oct, 9.00 USDC.")
    })

    it("rounds the axis up to a clean number and prints minutes", () => {
        expect([0, 1, 3, 7, 12, 24, 58, 120, 12_600_000].map(niceMax)).toEqual([1, 1, 3, 8, 15, 25, 60, 150, 15_000_000])
        expect(minutesText(null)).toBe("–")
        expect(minutesText(42)).toBe("42 min")
        expect(minutesText(65)).toBe("1 h 05 min")
    })
})
