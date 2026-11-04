import { ApiError } from "../lib/api"

/**
 * Turns any payment, wallet or API error into one short sentence a person can act on. Raw library
 * output (viem `details`, `shortMessage`, RPC URLs) is never shown: it can be long, technical,
 * and may carry node URLs.
 */
export function friendly(e: unknown): string {
    const err = (e ?? {}) as { shortMessage?: string; details?: string; message?: string; code?: string | number; name?: string }
    const all = `${err.code ?? ""} ${err.name ?? ""} ${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? String(e)}`

    // Server messages are fixed, readable sentences: show them as they are.
    if (e instanceof ApiError) {
        if (e.status === 504) return `${e.message} Check again in a minute.`
        return e.message
    }

    if (/User rejected|denied|4001|UserRejectedRequestError/i.test(all)) return "You cancelled in your wallet. Nothing was sent."
    if (/already (been )?spent|NOTE_SPENT|nullifier/i.test(all)) return "This note was already spent. Restore a newer backup or add a note."
    if (/WRONG_CHAIN|chain mismatch|does not match the target chain|ChainMismatch/i.test(all))
        return "Your wallet is on another network. Switch to Monad Testnet and try again."
    if (/insufficient funds|exceeds balance|gas required exceeds/i.test(all))
        return "Your wallet needs more MON for gas. Get test funds, then try again."
    if (/Failed to fetch|NetworkError|Load failed|HttpRequestError/i.test(all))
        return "We couldn't reach the network. Check your connection and try again."
    if (/POOL_FULL|DepositCapReached/i.test(all)) {
        const left = /takes (\d+) more/.exec(all)?.[1]
        return left !== undefined
            ? `The private pool takes only ${left} more ${left === "1" ? "note" : "notes"} right now. Add fewer, or pay publicly. Nothing was sent.`
            : "The private pool is full right now. Pay publicly instead."
    }
    if (/POOL_PAUSED/.test(all)) return "The private pool is paused right now. Pay publicly instead. Nothing was sent."
    if (/NOT_MERCHANT/i.test(all))return "This recipient can't take confidential payments. Pay publicly instead."
    if (/relayer returned 429/i.test(all)) return "Too many tries in a short time. Wait a minute and try again. Nothing was paid."
    if (/RELAYER_REJECTED|relayer returned 5\d\d/i.test(all)) return "The relayer couldn't send it. Nothing was spent. Try again."
    if (/proof|witness|wasm/i.test(all)) return "The proof didn't finish. Nothing was paid. Try again."
    if (/resource unavailable|already pending|-32002/i.test(all)) return "Your wallet already has a request open. Check the wallet window."

    if (e instanceof Error && !err.shortMessage && !err.details) return e.message.split("\n")[0]!
    if (err.shortMessage) return "Your wallet couldn't complete that. Nothing was sent. Try again."
    return "Something went wrong. Try again."
}
