// Thin adapter over shared/gst.ts so the pages don't depend on how STATE_CODES is shaped.

import * as gst from "../../../shared/gst"

export type StateOption = { name: string; code: string }

let cached: StateOption[] | null = null

/** All GST states and union territories, sorted by name. */
export function stateOptions(): StateOption[] {
    if (cached) return cached
    const raw: unknown = (gst as Record<string, unknown>).STATE_CODES
    const out: StateOption[] = []
    const push = (a: unknown, b: unknown) => {
        const x = String(a)
        const y = String(b)
        // One side is a two-digit code, the other the name.
        if (/^\d{1,2}$/.test(x)) out.push({ code: x.padStart(2, "0"), name: y })
        else out.push({ code: y.padStart(2, "0"), name: x })
    }
    if (Array.isArray(raw)) {
        for (const e of raw) {
            if (Array.isArray(e)) push(e[0], e[1])
            else if (e && typeof e === "object") {
                const o = e as Record<string, unknown>
                push(o.code ?? o.stateCode, o.name ?? o.state)
            }
        }
    } else if (raw instanceof Map) {
        for (const [k, v] of raw) push(k, v)
    } else if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) push(k, typeof v === "object" && v ? ((v as { code?: unknown }).code ?? v) : v)
    }
    cached = out.filter((s) => s.name && /^\d{2}$/.test(s.code)).sort((a, b) => a.name.localeCompare(b.name))
    return cached
}

export function stateCode(name: string): string | null {
    return stateOptions().find((s) => s.name.toLowerCase() === name.toLowerCase())?.code ?? null
}

export function isValidGstin(v: string): boolean {
    return gst.isValidGstin(v)
}

export type BillLine = { unitPrice: number; qty: number }

export function computeBill(lines: BillLine[], gstRateBps: number, serviceChargeBps: number) {
    return gst.computeBill({ lines, gstRateBps, serviceChargeBps, intraState: true })
}

/** Per-guest amounts (index 0 = guest 1), the same maths the server uses for split orders. */
export function splitAmounts(lines: (BillLine & { guest: number })[], guests: number, gstRateBps: number, serviceChargeBps: number, by: "items" | "equal") {
    const totals = computeBill(lines, gstRateBps, serviceChargeBps)
    try {
        return gst.splitOrder(lines, guests, totals, by)
    } catch {
        return null
    }
}
