// Turns the stats endpoint's numbers into chart columns and labels for the Overview. No React here,
// so the formatting is testable on its own.

import type { RestaurantStats, StatsRange } from "../../../shared/types"
import { plural, usdc, usdcNumber } from "../../lib/format"

export type Column = {
    key: string
    /** Axis label under the column, or null to leave it unlabelled (only some ticks fit). */
    tick: string | null
    /** Full name for the readout and the table, e.g. "Thu 5 Nov". */
    label: string
    value: number
    /** The value as people read it, e.g. "3 orders" or "120.00 USDC". */
    text: string
}

export const RANGE_LABEL: Record<StatsRange, string> = { today: "Today", "7d": "7 days", "30d": "30 days", mtd: "This month" }

/** What a range covers, to end a sentence: "placed today", "sold in the last 7 days"… */
export const RANGE_WORDS: Record<StatsRange, string> = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days", mtd: "this month" }

/** A clean top for the axis at or above v: 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten, so the tallest column fills most of the height. */
export function niceMax(v: number) {
    if (!(v > 0)) return 1
    const p = 10 ** Math.floor(Math.log10(v))
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p
    return 10 * p
}

/** 0 -> "12 am", 13 -> "1 pm". Hours are India time already. */
export function hourLabel(h: number) {
    const n = h % 12 === 0 ? 12 : h % 12
    return `${n} ${h < 12 ? "am" : "pm"}`
}

/** 24 columns, midnight first; axis labels every 6 hours so they fit on a phone. */
export function hourColumns(hours: number[]): Column[] {
    return hours.map((n, h) => ({
        key: String(h),
        tick: h % 6 === 0 ? hourLabel(h) : null,
        label: `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`,
        value: n,
        text: plural(n, "order")
    }))
}

/** The busiest hour, for the readout before anyone points at a column. */
export function busiestText(hours: number[]) {
    const max = Math.max(0, ...hours)
    if (max === 0) return "No paid orders yet."
    const h = hours.indexOf(max)
    return `Busiest: ${hourLabel(h)} to ${hourLabel((h + 1) % 24)}, ${plural(max, "order")}.`
}

// `day` is the India date as YYYY-MM-DD; read it at UTC midnight so the date never shifts.
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
const weekdayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" })
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" })
const utcDay = (day: string) => Date.parse(`${day}T00:00:00Z`)

/**
 * Revenue per day. A week labels every weekday; a month labels every seventh day counting back
 * from today, so today always has a label.
 */
export function dayColumns(days: RestaurantStats["days"]): Column[] {
    const week = days.length <= 7
    return days.map((d, i) => ({
        key: d.day,
        tick: week ? weekdayFmt.format(utcDay(d.day)) : (days.length - 1 - i) % 7 === 0 ? dateFmt.format(utcDay(d.day)) : null,
        label: dayFmt.format(utcDay(d.day)),
        value: d.revenue,
        text: `${usdc(d.revenue)} · ${plural(d.orders, "order")}`
    }))
}

export function bestDayText(days: RestaurantStats["days"]) {
    const best = days.reduce<RestaurantStats["days"][number] | null>((b, d) => (d.revenue > (b?.revenue ?? 0) ? d : b), null)
    if (!best) return "No paid orders yet."
    return `Best day: ${dayFmt.format(utcDay(best.day))}, ${usdc(best.revenue)}.`
}

/** Axis value for money: compact, without the unit repeated on every chart ("120 USDC"). */
export function usdcAxis(micro: number) {
    return `${usdcNumber(micro).replace(/\.00$/, "")} USDC`
}

/** "12 min", "1 h 05 min", or a dash when nothing was timed. */
export function minutesText(m: number | null) {
    if (m === null) return "–"
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}
