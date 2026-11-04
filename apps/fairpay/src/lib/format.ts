// Display helpers. Money is integer micro-USDC everywhere; only these functions turn it into text.

export const MICRO = 1_000_000

/** 12500000 -> "12.50". Whole cents show two decimals; finer amounts show what they need. */
export function usdcNumber(micro: number): string {
    const neg = micro < 0
    const abs = Math.abs(Math.round(micro))
    const whole = Math.floor(abs / MICRO)
    const frac = abs % MICRO
    let fracStr = String(frac).padStart(6, "0")
    // Keep at least cents, drop trailing zeros beyond that.
    fracStr = fracStr.replace(/0+$/, "")
    if (fracStr.length < 2) fracStr = fracStr.padEnd(2, "0")
    const wholeStr = whole.toLocaleString("en-US")
    return `${neg ? "-" : ""}${wholeStr}.${fracStr}`
}

/** 12500000 -> "12.50 USDC". */
export const usdc = (micro: number) => `${usdcNumber(micro)} USDC`

/**
 * Parses what a person typed ("12", "12.5", "1,200.25") into micro-USDC.
 * Returns null for anything that isn't a plain non-negative amount with at most 6 decimals.
 */
export function parseUsdc(input: string): number | null {
    const s = input.trim().replace(/,/g, "")
    if (!/^\d{1,9}(\.\d{0,6})?$/.test(s) && !/^\.\d{1,6}$/.test(s)) return null
    const [w = "0", f = ""] = s.split(".")
    return Number(w || "0") * MICRO + Number(f.padEnd(6, "0") || "0")
}

/** micro-USDC -> the string an input field should show ("12.5"). */
export function usdcInput(micro: number): string {
    if (!micro) return ""
    const whole = Math.floor(micro / MICRO)
    const frac = String(micro % MICRO).padStart(6, "0").replace(/0+$/, "")
    return frac ? `${whole}.${frac}` : String(whole)
}

/** 0x1234…abcd (6 + 4), the house style for addresses and hashes. */
export function shortHex(hex: string, head = 6, tail = 4): string {
    if (hex.length <= head + tail + 1) return hex
    return `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

export const isWallet = (v: string): v is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(v.trim())

/** A well-formed transaction hash, checked before it goes into an explorer URL. */
export const isTxHash = (v: string | null | undefined): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)

/** Basis points -> "5%" / "2.5%". */
export function percent(bps: number): string {
    const p = bps / 100
    return `${Number.isInteger(p) ? p : p.toFixed(2).replace(/0$/, "")}%`
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null

/** "just now", "5 minutes ago", "yesterday", then a date. */
export function timeAgo(ms: number, now = Date.now()): string {
    const diff = Math.round((ms - now) / 1000)
    const abs = Math.abs(diff)
    if (abs < 45) return "just now"
    if (!rtf) return dateShort(ms)
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
    if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day")
    return dateShort(ms)
}

export function dateShort(ms: number): string {
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export function dateTime(ms: number): string {
    return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
