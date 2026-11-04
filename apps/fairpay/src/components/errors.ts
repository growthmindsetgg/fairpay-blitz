import { ApiError } from "../lib/api"

// Kept free of lib/payments (and so of the SDK): many pages import this file.
const REJECTED = /User rejected|denied|4001|UserRejectedRequestError/i
const WALLET_BUSY = /resource unavailable|already pending|-32002/i

function allText(e: unknown) {
    const err = (e ?? {}) as { shortMessage?: string; details?: string; message?: string; code?: string | number; name?: string }
    return `${err.code ?? ""} ${err.name ?? ""} ${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? String(e)}`
}

/** The person said no in their wallet (EIP-1193 4001, anywhere in the `cause` chain). Nothing was sent. */
export function cancelledInWallet(e: unknown) {
    if (e instanceof ApiError) return false
    for (let x = e as { code?: unknown; name?: unknown; cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
        if (x.code === 4001 || x.name === "UserRejectedRequestError") return true
    }
    return REJECTED.test(allText(e))
}

/** The wallet still has a prompt open (EIP-1193 -32002): confirming it later could still send something. */
export function walletBusy(e: unknown) {
    return !(e instanceof ApiError) && WALLET_BUSY.test(allText(e))
}

/**
 * Whether a failed payment, deposit or withdrawal should reload the page after a short countdown.
 * Not when the person cancelled in their wallet (they may retry at once), and not while the wallet
 * still has a prompt open (a reload would lose track of what it sends).
 */
export function refreshesAfter(e: unknown) {
    return !cancelledInWallet(e) && !walletBusy(e)
}

/**
 * Turns any payment, wallet or API error into one short sentence a person can act on. Raw library
 * output (viem `details`, `shortMessage`, RPC URLs) is never shown: it can be long, technical,
 * and may carry node URLs.
 */
export function friendly(e: unknown): string {
    const err = (e ?? {}) as { shortMessage?: string; details?: string; message?: string; code?: string | number; name?: string }
    const all = allText(e)

    // Server messages are fixed, readable sentences: show them as they are.
    if (e instanceof ApiError) {
        if (e.status === 504) return `${e.message} Check again in a minute.`
        return e.message
    }

    if (REJECTED.test(all)) return "You cancelled in your wallet. Nothing was sent."
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
    if (/NO_WITHDRAW/.test(all)) return "This pool can't withdraw notes yet. Nothing was sent."
    if (/POOL_PAUSED/.test(all)) return "The private pool is paused right now. Pay publicly instead. Nothing was sent."
    if (/NOT_MERCHANT/i.test(all))return "This recipient can't take confidential payments. Pay publicly instead."
    if (/relayer returned 429/i.test(all)) return "Too many tries in a short time. Wait a minute and try again. Nothing was paid."
    if (/RELAYER_REJECTED|relayer returned 5\d\d/i.test(all)) return "The relayer couldn't send it. Nothing was spent. Try again."
    if (/proof|witness|wasm/i.test(all)) return "The proof didn't finish. Nothing was paid. Try again."
    if (WALLET_BUSY.test(all)) return "Your wallet already has a request open. Check the wallet window."

    if (e instanceof Error && !err.shortMessage && !err.details) return e.message.split("\n")[0]!
    if (err.shortMessage) return "Your wallet couldn't complete that. Nothing was sent. Try again."
    return "Something went wrong. Try again."
}
