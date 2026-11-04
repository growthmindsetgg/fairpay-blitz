import { useCallback, useEffect, useRef, useState } from "react"

/** Any value that is new for each failure (a counter works); null, undefined or false while nothing has failed. */
export type FailureKey = string | number | null | undefined | false

export type AutoRefresh = {
    /** Seconds until the reload, or null when no countdown is running. */
    secondsLeft: number | null
    /** Stops the countdown for this failure ("Stay on this page"). */
    cancel: () => void
}

/**
 * Reloads the page `seconds` after a failure is shown, with a countdown the person can stop.
 *
 * Callers pass a key only once the flow has ended in an error: never while a transaction is in
 * flight. A full reload is safe there because every sent payment is remembered first (the pending
 * hash and the notes are in localStorage, and the relayer's hold is on the server), and PayShare
 * picks a pending payment up again on load. A new key starts a new countdown; going back to null
 * (the dialog closed, a new attempt started) stops it. `canRefresh` is asked at zero, so a flow
 * started in the meantime is never cut off.
 */
export function useAutoRefreshOnError(
    failure: FailureKey,
    { seconds = 5, onRefresh, canRefresh }: { seconds?: number; onRefresh?: () => void; canRefresh?: () => boolean } = {}
): AutoRefresh {
    const [stoppedFor, setStoppedFor] = useState<FailureKey>(null)
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
    const latest = useRef({ onRefresh, canRefresh })
    latest.current = { onRefresh, canRefresh }
    const armed = failure !== null && failure !== undefined && failure !== false && failure !== stoppedFor

    useEffect(() => {
        if (!armed) {
            setSecondsLeft(null)
            return
        }
        let left = seconds
        setSecondsLeft(left)
        const timer = setInterval(() => {
            left -= 1
            if (left > 0) {
                setSecondsLeft(left)
                return
            }
            clearInterval(timer)
            setSecondsLeft(null)
            if (latest.current.canRefresh?.() === false) return
            ;(latest.current.onRefresh ?? (() => window.location.reload()))()
        }, 1000)
        return () => clearInterval(timer)
    }, [armed, failure, seconds])

    const cancel = useCallback(() => setStoppedFor(failure), [failure])
    return { secondsLeft: armed ? secondsLeft : null, cancel }
}

/**
 * The line under a failure: "Refreshing in 5 s…" and a way to stay. Text only, no motion. Renders
 * the live region even when idle. Existing classes only (no stylesheet of its own).
 */
export function AutoRefreshNotice({ secondsLeft, cancel }: AutoRefresh) {
    return (
        <div aria-live="polite" aria-atomic="true">
            {secondsLeft !== null && (
                <p className="field-hint" style={{ marginTop: "var(--s-2)" }}>
                    Refreshing in {secondsLeft} s…{" "}
                    <button type="button" className="linkish" onClick={cancel}>
                        Stay on this page
                    </button>
                </p>
            )}
        </div>
    )
}
