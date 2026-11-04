// Bill split maths. Pure functions, no I/O, so they can be tested on their own and reused by the
// browser preview if needed. Money is integer micro-USDC; splitting happens in whole cents so every
// share is a payable cent amount, and leftover cents are handed out one at a time.

export const MICRO_PER_CENT = 10_000
export const MAX_PEOPLE = 20
/** 1,000,000 USDC in micro-USDC. */
export const MAX_TOTAL = 1_000_000 * 1_000_000
export const MAX_WEIGHT = 10_000
const BPS_TOTAL = 10_000

export type ComputableSplit = "equal" | "fixed" | "percent" | "shares"

export type ComputeSharesInput = {
    /** micro-USDC, whole cents */
    total: number
    splitType: ComputableSplit
    /**
     * One entry per participant other than the creator, in order. Unit depends on splitType:
     * micro-USDC for fixed, basis points for percent, an integer weight for shares, ignored for
     * equal.
     */
    values: (number | undefined | null)[]
    /** The creator's own value in the same unit. Omitted means the creator's part is zero. */
    creatorValue?: number | null
    /** Optional participant names (same order as values), only used in error messages. */
    names?: string[]
}

/** A split that can't be computed. The message is written for the person filling in the form. */
export class SplitError extends Error {}

/** "42.00" for 42_000_000 micro-USDC. */
export function usdc(micro: number): string {
    const cents = Math.round(micro / MICRO_PER_CENT)
    const sign = cents < 0 ? "-" : ""
    const abs = Math.abs(cents)
    const whole = Math.floor(abs / 100).toLocaleString("en-US")
    return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`
}

function percent(bps: number): string {
    // 9550 -> "95.5%", 10000 -> "100%"
    return `${Number((bps / 100).toFixed(2))}%`
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v)

/**
 * Splits `total` between the creator and the participants.
 * Returns micro-USDC amounts, creator first, then participants in input order. They always sum to
 * total, and each is a whole number of cents.
 *
 *  - equal:   total / people in cents; leftover cents go one each from the first person (creator).
 *  - fixed:   the amounts as given; they must be whole cents and add up to total.
 *  - percent: basis points adding up to 10000; each share is rounded down to a cent and the
 *             leftover cents go to the last person with a non-zero percentage.
 *  - shares:  integer weights; each share is rounded down to a cent and the leftover cents go one
 *             each from the first person with a non-zero weight.
 */
export function computeShares(input: ComputeSharesInput): number[] {
    const { total, splitType, values } = input
    if (!isInt(total) || total <= 0) throw new SplitError("The total must be a positive amount.")
    if (total > MAX_TOTAL) throw new SplitError(`The total can be at most ${usdc(MAX_TOTAL)} USDC.`)
    if (total % MICRO_PER_CENT !== 0) throw new SplitError("The total must be a whole number of cents.")
    if (!Array.isArray(values) || values.length === 0) throw new SplitError("Add at least one person to split with.")
    const people = values.length + 1
    if (people > MAX_PEOPLE) throw new SplitError(`A bill can have at most ${MAX_PEOPLE} people, including you.`)

    const cents = total / MICRO_PER_CENT
    const toMicro = (c: number[]) => c.map((x) => x * MICRO_PER_CENT)
    const who = (i: number) => (i === 0 ? "your own share" : (input.names?.[i - 1]?.trim() || `participant ${i}`))
    // Creator first, then participants. A missing creator value means zero; a missing participant
    // value is an error, because a silent zero would hide a form mistake.
    const raw = (): number[] => {
        const creator = input.creatorValue ?? 0
        return [creator, ...values].map((v, i) => {
            if (v === undefined || v === null) throw new SplitError(`Enter a value for ${who(i)}.`)
            return v
        })
    }

    switch (splitType) {
        case "equal": {
            const base = Math.floor(cents / people)
            const extra = cents - base * people
            return toMicro(Array.from({ length: people }, (_, i) => base + (i < extra ? 1 : 0)))
        }
        case "fixed": {
            const amounts = raw()
            amounts.forEach((a, i) => {
                if (!isInt(a) || a < 0) throw new SplitError(`The amount for ${who(i)} must be zero or more.`)
                if (a % MICRO_PER_CENT !== 0) throw new SplitError(`The amount for ${who(i)} must be a whole number of cents.`)
                if (a > total) throw new SplitError(`The amount for ${who(i)} is more than the total.`)
            })
            const sum = amounts.reduce((s, a) => s + a, 0)
            if (sum !== total) {
                throw new SplitError(`Fixed amounts add up to ${usdc(sum)} USDC but the total is ${usdc(total)} USDC.`)
            }
            return amounts
        }
        case "percent": {
            const bps = raw()
            bps.forEach((b, i) => {
                if (!isInt(b) || b < 0 || b > BPS_TOTAL) throw new SplitError(`The percentage for ${who(i)} must be between 0% and 100%.`)
            })
            const sum = bps.reduce((s, b) => s + b, 0)
            if (sum !== BPS_TOTAL) throw new SplitError(`Percentages add up to ${percent(sum)} but must add up to 100%.`)
            const shares = bps.map((b) => Math.floor((cents * b) / BPS_TOTAL))
            const left = cents - shares.reduce((s, c) => s + c, 0)
            let last = bps.length - 1
            while (bps[last] === 0) last--
            shares[last] += left
            return toMicro(shares)
        }
        case "shares": {
            const weights = raw()
            weights.forEach((w, i) => {
                if (!isInt(w) || w < 0 || w > MAX_WEIGHT) throw new SplitError(`The shares for ${who(i)} must be a whole number from 0 to ${MAX_WEIGHT}.`)
            })
            const sum = weights.reduce((s, w) => s + w, 0)
            if (sum === 0) throw new SplitError("Give at least one person a share above zero.")
            const shares = weights.map((w) => Math.floor((cents * w) / sum))
            let left = cents - shares.reduce((s, c) => s + c, 0)
            // left < number of people with a non-zero weight, so one pass is enough.
            for (let i = 0; i < weights.length && left > 0; i++) {
                if (weights[i] === 0) continue
                shares[i] += 1
                left--
            }
            return toMicro(shares)
        }
        default:
            throw new SplitError("Split type must be equal, fixed, percent or shares.")
    }
}
