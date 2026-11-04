/** How many guests the menu starts with when the URL doesn't say. */
export const DEFAULT_GUESTS = 2

/**
 * Reads ?guests= from the menu URL, so a link like /app/?guests=4 opens with four guests.
 * Only a whole number from 1 to max counts (max is cfg.maxGuests, the server's MAX_GUESTS).
 * Anything else, including a missing value, gives the default of 2.
 */
export function guestsFromParam(raw: string | null, max: number): number {
    const fallback = Math.max(1, Math.min(DEFAULT_GUESTS, max))
    if (raw === null || !/^\d{1,3}$/.test(raw.trim())) return fallback
    const n = Number(raw.trim())
    return n >= 1 && n <= max ? n : fallback
}
