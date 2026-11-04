// Bill split maths for the live preview. The rules are the server's own (server/bills.ts is pure,
// with no imports), so the preview can never disagree with what the server will store.

import { computeShares, MAX_PEOPLE, MICRO_PER_CENT, SplitError, type ComputableSplit } from "../../server/bills"

export { MAX_PEOPLE, MICRO_PER_CENT, SplitError, type ComputableSplit }

export type PreviewInput = {
    total: number
    splitType: ComputableSplit
    creatorValue?: number | null
    values: (number | null | undefined)[]
    names?: string[]
}

/** Shares for the creator (index 0) and each participant, or the reason the split doesn't work yet. */
export function previewShares(input: PreviewInput): { ok: true; shares: number[] } | { ok: false; error: string } {
    try {
        return { ok: true, shares: computeShares(input) }
    } catch (e) {
        if (e instanceof SplitError) return { ok: false, error: e.message }
        return { ok: false, error: "Check the amounts." }
    }
}

/** Parses a whole-cent USDC amount ("12", "12.5", "12.50"). Null when invalid or finer than a cent. */
export function parseCents(input: string): number | null {
    const s = input.trim().replace(/,/g, "")
    if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null
    const [w, f = ""] = s.split(".")
    return (Number(w) * 100 + Number(f.padEnd(2, "0") || "0")) * MICRO_PER_CENT
}

/** Parses a percentage with up to two decimals ("33.33") into basis points. */
export function parsePercent(input: string): number | null {
    const s = input.trim().replace(/%$/, "")
    if (!/^\d{1,3}(\.\d{0,2})?$/.test(s)) return null
    const [w, f = ""] = s.split(".")
    const bps = Number(w) * 100 + Number(f.padEnd(2, "0") || "0")
    return bps <= 10_000 ? bps : null
}

/** Parses a whole-number weight (shares split). */
export function parseWeight(input: string): number | null {
    const s = input.trim()
    if (!/^\d{1,5}$/.test(s)) return null
    return Number(s)
}
