import { Icon } from "./Icon"

export type TxStepsState = "running" | "done" | "error"

/**
 * The visible progress of a multi-step transaction: each step is done, current or next.
 * Screen readers hear the current step through a polite live region (the list itself is not live,
 * so steps aren't read twice).
 *
 *   <TxSteps steps={["Check your balance", "Confirm in your wallet", "Verify on Monad"]} current={1}
 *            detail="Your wallet may ask twice" state="running" />
 */
export function TxSteps({
    steps,
    current,
    state = "running",
    detail,
    label = "Payment progress",
    footnote
}: {
    steps: string[]
    /** Index of the step in progress (or the one that failed). */
    current: number
    state?: TxStepsState
    /** A short line under the current step, e.g. "Note 2 of 3". */
    detail?: string | null
    label?: string
    /** Small text under the list, e.g. "Usually 5-15 seconds. Keep this tab open." */
    footnote?: string
}) {
    const statusOf = (i: number) => {
        if (state === "done") return "done"
        if (i < current) return "done"
        if (i === current) return state === "error" ? "error" : "now"
        return "next"
    }
    const announce =
        state === "done"
            ? "All steps finished."
            : state === "error"
              ? `Stopped at: ${steps[current] ?? ""}.`
              : `Step ${current + 1} of ${steps.length}: ${steps[current] ?? ""}${detail ? `. ${detail}` : ""}`
    return (
        <div className="txsteps">
            <ol className="txsteps-list" aria-label={label}>
                {steps.map((s, i) => {
                    const st = statusOf(i)
                    return (
                        <li key={s} data-state={st} aria-current={st === "now" ? "step" : undefined}>
                            <span className="txsteps-mark" aria-hidden="true">
                                {st === "done" ? <Icon name="check" size={14} /> : st === "error" ? <Icon name="close" size={14} /> : i + 1}
                            </span>
                            <span className="txsteps-text">
                                {s}
                                {st === "done" && <span className="sr-only"> (done)</span>}
                                {st === "error" && <span className="sr-only"> (failed)</span>}
                                {st === "now" && detail && <span className="txsteps-detail">{detail}</span>}
                            </span>
                        </li>
                    )
                })}
            </ol>
            {footnote && <p className="field-hint">{footnote}</p>}
            <p className="sr-only" aria-live="polite" role="status">
                {announce}
            </p>
        </div>
    )
}
