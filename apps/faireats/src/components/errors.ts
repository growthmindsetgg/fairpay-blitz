import { ApiError } from "../api"

/**
 * Turns any payment or wallet error into one short sentence a guest can act on. Raw library
 * output (viem `details`, `shortMessage`, RPC URLs) is never shown: it can be long, technical,
 * and may carry node URLs.
 */
export function friendly(e: unknown): string {
    const err = (e ?? {}) as { shortMessage?: string; details?: string; message?: string; code?: string }
    const all = `${err.code ?? ""} ${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? String(e)}`

    if (/User rejected|denied/i.test(all)) return "You cancelled in your wallet. Nothing was paid."
    if (/already (been )?spent|NOTE_SPENT|nullifier/i.test(all)) return "This note was already spent. Restore a newer backup or add a note."
    if (/WRONG_CHAIN|chain mismatch|does not match the target chain/i.test(all))
        return "Your wallet is on another network. Switch to Monad Testnet and try again."
    if (/insufficient (funds|balance)/i.test(all))
        return "Your wallet needs more MON for gas. Get test funds on the wallet page, then try again."
    if (/Failed to fetch|NetworkError|Load failed/i.test(all))
        return "We couldn't reach the restaurant. Check your connection and try again."

    if (e instanceof ApiError) {
        if (e.status === 504) return `${e.message} Check again in a minute.`
        if (e.status === 429) return "Too many tries in a short time. Wait a minute and try again. Nothing was paid."
    }
    if (/relayer returned 429/i.test(all)) return "Too many tries in a short time. Wait a minute and try again. Nothing was paid."
    if (/relayer returned 5\d\d/i.test(all) || (e instanceof ApiError && e.status >= 500))
        return "The restaurant's relayer is busy. Nothing was spent. Try again."
    if (/proof|witness|wasm/i.test(all)) return "The proof didn't finish. Nothing was paid. Try again."

    // Server messages and our own errors are fixed, readable sentences. Library errors are not.
    if (e instanceof ApiError) return e.message
    if (e instanceof Error && !err.shortMessage && !err.details) return e.message.split("\n")[0]!
    return "Something went wrong. Nothing was paid. Try again."
}
