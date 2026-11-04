// USDC amounts are integer micro-USDC (6 decimals) everywhere. These helpers convert to and from
// what people read and type. Used by the server (activity text) and the browser.

export const MICRO = 1_000_000
/** Largest amount accepted from input: one billion USDC, well inside Number's exact range. */
export const MAX_USDC_MICRO = 1_000_000_000 * MICRO

/**
 * "1,234.50" for 1_234_500_000. `decimals` (0-6, default 2) is how many places to show; the value
 * is rounded half-up to that many. Pass `{ symbol: true }` for "1,234.50 USDC".
 */
export function formatUsdc(micro: number, opts: { decimals?: number; symbol?: boolean } = {}): string {
    if (!Number.isSafeInteger(micro)) throw new RangeError("amount must be a whole number of micro-USDC")
    const decimals = opts.decimals ?? 2
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RangeError("decimals must be 0 to 6")
    const negative = micro < 0
    let abs = BigInt(Math.abs(micro))
    const step = 10n ** BigInt(6 - decimals)
    // Round half-up at the shown precision, in integers so nothing drifts.
    abs = ((abs + step / 2n) / step) * step
    const whole = abs / BigInt(MICRO)
    const frac = (abs % BigInt(MICRO)).toString().padStart(6, "0").slice(0, decimals)
    const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    const text = (negative && abs !== 0n ? "-" : "") + wholeText + (decimals > 0 ? "." + frac : "")
    return opts.symbol ? `${text} USDC` : text
}

export class MoneyParseError extends Error {}

/**
 * "12.5", "12.50", "1,234.56" or "$3" → micro-USDC. At most 6 decimal places, no negatives, no
 * exponents, at most MAX_USDC_MICRO. Throws MoneyParseError with a message a person can act on.
 */
export function parseUsdc(input: string): number {
    if (typeof input !== "string") throw new MoneyParseError("Enter an amount.")
    let s = input.trim().replace(/^\$/, "").replace(/\s*USDC$/i, "").trim()
    if (s === "") throw new MoneyParseError("Enter an amount.")
    // Thousands separators are only accepted in the usual places (1,234,567.89).
    if (s.includes(",")) {
        if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) throw new MoneyParseError("Check the amount: commas go between thousands.")
        s = s.replace(/,/g, "")
    }
    const m = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/.exec(s)
    if (!m) throw new MoneyParseError("Enter the amount as a number, like 12.50.")
    const whole = m[1] ?? "0"
    const frac = m[2] ?? m[3] ?? ""
    if (frac.length > 6) throw new MoneyParseError("USDC has at most 6 decimal places.")
    const micro = BigInt(whole) * BigInt(MICRO) + BigInt(frac.padEnd(6, "0") || "0")
    if (micro > BigInt(MAX_USDC_MICRO)) throw new MoneyParseError("That amount is too large.")
    return Number(micro)
}
