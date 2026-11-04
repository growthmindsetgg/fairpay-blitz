// Indian GST maths for restaurant bills. Pure functions with no Node APIs: the server prices
// orders with them and the browser shows the same numbers in previews and invoices.
// Money is integer micro-USDC (6 decimals). Every tax figure is rounded to a whole cent.

export const USDC = 1_000_000
/** One cent in micro-USDC. */
export const CENT = 10_000

export type BillLine = { unitPrice: number; qty: number }

export type BillInput = {
    lines: BillLine[]
    /** GST rate in basis points (500 = 5%). 0 for a restaurant without a GSTIN. */
    gstRateBps: number
    serviceChargeBps: number
    /** Restaurant service is almost always intra-state (CGST + SGST). */
    intraState: boolean
}

export type BillTotals = {
    subtotal: number
    serviceCharge: number
    /** subtotal + service charge: service charge is part of the taxable value. */
    taxable: number
    cgst: number
    sgst: number
    igst: number
    roundOff: number
    total: number
}

function assertMoney(n: number, what: string): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer`)
}

/** round(value * num / den) to the nearest cent, half up. BigInt so large products stay exact. */
function centRound(value: number, num: number, den: number): number {
    const v = BigInt(value) * BigInt(num)
    const d = BigInt(den) * BigInt(CENT)
    return Number((v * 2n + d) / (d * 2n)) * CENT
}

/** Rounds a micro-USDC amount to the nearest whole cent, half up. */
export function roundToCent(micro: number): number {
    return centRound(micro, 1, 1)
}

export function computeBill(input: BillInput): BillTotals {
    assertMoney(input.gstRateBps, "gstRateBps")
    assertMoney(input.serviceChargeBps, "serviceChargeBps")
    let subtotal = 0
    for (const l of input.lines) {
        assertMoney(l.unitPrice, "unitPrice")
        assertMoney(l.qty, "qty")
        subtotal += l.unitPrice * l.qty
    }
    assertMoney(subtotal, "subtotal")
    const serviceCharge = centRound(subtotal, input.serviceChargeBps, 10_000)
    const taxable = subtotal + serviceCharge
    let cgst = 0
    let sgst = 0
    let igst = 0
    if (input.intraState) {
        // Each half is rounded on its own, as it appears on the invoice.
        cgst = centRound(taxable, input.gstRateBps, 20_000)
        sgst = cgst
    } else {
        igst = centRound(taxable, input.gstRateBps, 10_000)
    }
    const raw = taxable + cgst + sgst + igst
    // Prices are whole cents in the database, so this is 0 unless a caller passes odd prices.
    const roundOff = roundToCent(raw) - raw
    return { subtotal, serviceCharge, taxable, cgst, sgst, igst, roundOff, total: raw + roundOff }
}

export type SplitLine = BillLine & { guest: number }

/**
 * Splits an order's total across guests (index 0 = guest 1).
 *  - "equal": whole cents, the leftover cents go one at a time from guest 1.
 *  - "items": each guest pays the same fraction of the total as of the item subtotal, so service
 *    charge, tax and round-off are shared in proportion. Largest remainder in whole cents: every
 *    guest gets their exact share rounded down, then the leftover cents go one each to the guests
 *    whose shares were cut the most (ties to the lower guest number). No share is ever negative,
 *    and a guest who ordered nothing gets 0.
 * The result always sums to `totals.total`; anything else throws a RangeError.
 */
export function splitOrder(lines: SplitLine[], guests: number, totals: BillTotals, by: "items" | "equal"): number[] {
    if (!Number.isInteger(guests) || guests < 1) throw new RangeError("guests must be at least 1")
    const total = totals.total
    assertMoney(total, "total")
    const out = new Array<number>(guests).fill(0)
    // total is whole cents (computeBill guarantees it); any odd micro-USDC goes to one payer.
    const cents = Math.floor(total / CENT)
    const extraMicro = total - cents * CENT
    if (by === "equal") {
        const base = Math.floor(cents / guests)
        let left = cents - base * guests
        for (let i = 0; i < guests; i++) {
            out[i] = base * CENT + (left > 0 ? CENT : 0)
            if (left > 0) left--
        }
        out[0] += extraMicro
        return checked(out, total)
    }
    const sub = new Array<number>(guests).fill(0)
    for (const l of lines) {
        if (!Number.isInteger(l.guest) || l.guest < 1 || l.guest > guests) throw new RangeError("line guest out of range")
        assertMoney(l.unitPrice, "unitPrice")
        assertMoney(l.qty, "qty")
        sub[l.guest - 1] += l.unitPrice * l.qty
    }
    const subtotal = sub.reduce((a, b) => a + b, 0)
    if (subtotal !== totals.subtotal) throw new RangeError("lines do not match the bill subtotal")
    if (subtotal <= 0) throw new RangeError("no guest ordered anything")
    // BigInt so cents x item subtotal stays exact.
    const whole = BigInt(subtotal)
    const cut: { i: number; r: bigint }[] = []
    let left = cents
    for (let i = 0; i < guests; i++) {
        if (sub[i] === 0) continue
        const exact = BigInt(cents) * BigInt(sub[i])
        const floor = Number(exact / whole)
        out[i] = floor * CENT
        left -= floor
        cut.push({ i, r: exact % whole })
    }
    // Each guest lost less than a cent, so fewer cents are left than guests with dishes.
    cut.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
    for (let k = 0; k < left; k++) out[cut[k]!.i] += CENT
    out[cut[0]!.i] += extraMicro
    return checked(out, total)
}

/** What callers rely on: no share is negative and together they are exactly the total. */
function checked(shares: number[], total: number): number[] {
    let sum = 0
    for (const s of shares) {
        if (!Number.isSafeInteger(s) || s < 0) throw new RangeError("a share came out negative")
        sum += s
    }
    if (sum !== total) throw new RangeError("shares do not add up to the total")
    return shares
}

// ------------------------------------------------------------------ states and GSTIN

/**
 * GST state codes (the first two digits of a GSTIN) for every state and union territory, keyed
 * by name in alphabetical order, so Object.keys(STATE_CODES) is a ready-made dropdown.
 */
export const STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
    "Andaman and Nicobar Islands": "35",
    "Andhra Pradesh": "37",
    "Arunachal Pradesh": "12",
    Assam: "18",
    Bihar: "10",
    Chandigarh: "04",
    Chhattisgarh: "22",
    "Dadra and Nagar Haveli and Daman and Diu": "26",
    Delhi: "07",
    Goa: "30",
    Gujarat: "24",
    Haryana: "06",
    "Himachal Pradesh": "02",
    "Jammu and Kashmir": "01",
    Jharkhand: "20",
    Karnataka: "29",
    Kerala: "32",
    Ladakh: "38",
    Lakshadweep: "31",
    "Madhya Pradesh": "23",
    Maharashtra: "27",
    Manipur: "14",
    Meghalaya: "17",
    Mizoram: "15",
    Nagaland: "13",
    Odisha: "21",
    Puducherry: "34",
    Punjab: "03",
    Rajasthan: "08",
    Sikkim: "11",
    "Tamil Nadu": "33",
    Telangana: "36",
    Tripura: "16",
    "Uttar Pradesh": "09",
    Uttarakhand: "05",
    "West Bengal": "19"
})

/** State and UT names, alphabetical. */
export const STATES: readonly string[] = Object.freeze(Object.keys(STATE_CODES))

/** The GST state code for a state name, or null if it isn't one. */
export function stateCode(state: string): string | null {
    return Object.prototype.hasOwnProperty.call(STATE_CODES, state) ? STATE_CODES[state] : null
}

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
// Valid state codes, plus 97 ("Other Territory"), which GSTN also issues.
const GSTIN_STATES = new Set([...Object.values(STATE_CODES), "97"])

/**
 * The GSTIN check character for the first 14 characters (GSTN's base-36 algorithm): weights
 * alternate 1, 2 from the left; each product adds its base-36 quotient and remainder; the check
 * value is (36 - sum mod 36) mod 36.
 */
export function gstinCheckChar(first14: string): string {
    if (first14.length !== 14) throw new RangeError("need the first 14 characters")
    let sum = 0
    for (let i = 0; i < 14; i++) {
        const v = BASE36.indexOf(first14[i])
        if (v < 0) throw new RangeError("GSTIN characters are 0-9 and A-Z")
        const p = v * (i % 2 === 0 ? 1 : 2)
        sum += Math.floor(p / 36) + (p % 36)
    }
    return BASE36[(36 - (sum % 36)) % 36]
}

/** Format, a real state code, and the check digit. Expects uppercase. */
export function isValidGstin(gstin: string): boolean {
    if (typeof gstin !== "string" || !GSTIN_FORMAT.test(gstin)) return false
    if (!GSTIN_STATES.has(gstin.slice(0, 2))) return false
    return gstinCheckChar(gstin.slice(0, 14)) === gstin[14]
}

// ------------------------------------------------------------------ words and dates

const ONES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"
]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
const SCALES: [number, string][] = [
    [1e12, "trillion"],
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"]
]

function under1000(n: number): string {
    const parts: string[] = []
    if (n >= 100) {
        parts.push(`${ONES[Math.floor(n / 100)]} hundred`)
        n %= 100
    }
    if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""))
    else if (n > 0) parts.push(ONES[n])
    return parts.join(" ")
}

function numberWords(n: number): string {
    if (n === 0) return "zero"
    const parts: string[] = []
    for (const [size, name] of SCALES) {
        if (n >= size) {
            parts.push(`${under1000(Math.floor(n / size))} ${name}`)
            n %= size
        }
    }
    if (n > 0) parts.push(under1000(n))
    return parts.join(" ")
}

/** "Twenty-one USDC and fifty cents only". Rounds to the nearest cent. */
export function amountInWords(micro: number): string {
    if (!Number.isSafeInteger(micro) || micro < 0) throw new RangeError("amount must be a non-negative integer")
    const cents = Math.round(micro / CENT)
    const whole = Math.floor(cents / 100)
    const rest = cents % 100
    let s: string
    if (rest === 0) s = `${numberWords(whole)} USDC`
    else if (whole === 0) s = `${numberWords(rest)} ${rest === 1 ? "cent" : "cents"}`
    else s = `${numberWords(whole)} USDC and ${numberWords(rest)} ${rest === 1 ? "cent" : "cents"}`
    return `${s.charAt(0).toUpperCase()}${s.slice(1)} only`
}

const IST_OFFSET_MS = 330 * 60_000

/** Indian financial year (April to March) of a unix-ms time, in IST: "2026-27". */
export function financialYear(ts: number): string {
    const d = new Date(ts + IST_OFFSET_MS)
    const y = d.getUTCFullYear()
    const start = d.getUTCMonth() >= 3 ? y : y - 1
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}
