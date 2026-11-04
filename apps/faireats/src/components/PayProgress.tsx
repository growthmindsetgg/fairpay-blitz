import { DEMO } from "./demo"

export type PayKind = "public" | "private" | "other"

const PRIVATE_STEPS = ["Checking your notes", "Building your proof in this browser", "The relayer is sending it", "Verified on-chain"]
const PUBLIC_STEPS = ["Confirm in your wallet", "Sending", "Checking on-chain"]

/** Maps the step strings from payments.ts (and the demo's) onto the visible steps, by prefix. */
function stepIndex(kind: PayKind, text: string) {
    if (kind === "private") {
        if (/^Building your private proof/i.test(text)) return 1
        if (/^Sending through the relayer/i.test(text)) return 2
        if (/^Checking the payment on-chain/i.test(text)) return 3
        return 0 // Starting, checking notes, loading the pool
    }
    if (/^Sending/i.test(text)) return 1
    if (/^Checking the payment on-chain/i.test(text)) return 2
    return 0 // Starting, getting test funds, confirm in the wallet
}

/**
 * The visible part of a running payment: a short list of steps with the current one marked.
 * Screen readers hear the step text through the card's always-mounted status region instead,
 * so this list is not a live region itself.
 */
export function PayProgress({ kind, step }: { kind: PayKind; step: string }) {
    if (kind === "other")
        return (
            <p className="progress" aria-hidden="true">
                {step}
            </p>
        )
    const labels = kind === "private" ? PRIVATE_STEPS : PUBLIC_STEPS
    const at = stepIndex(kind, step)
    const note = step.match(/(\d+) of (\d+)/)
    const extra = kind === "public" && /test USDC/i.test(step) ? step : null
    return (
        <div className="pay-progress">
            <ol className="pay-steps" aria-label={kind === "private" ? "Private payment steps" : "Payment steps"}>
                {labels.map((label, i) => (
                    <li key={label} data-state={i < at ? "done" : i === at ? "now" : "next"} aria-current={i === at ? "step" : undefined}>
                        <span className="mark" aria-hidden="true" />
                        <span>
                            {label}
                            {i < at && <span className="sr-only"> (done)</span>}
                            {i === at && note && kind === "private" && (
                                <span className="sub">
                                    Note {note[1]} of {note[2]}
                                </span>
                            )}
                            {i === at && extra && <span className="sub">{extra}</span>}
                        </span>
                    </li>
                ))}
            </ol>
            {kind === "private" && (
                <p className="hint">
                    {DEMO
                        ? "Simulated: no proof is built in demo mode. In the real app this usually takes 5–15 seconds."
                        : "Usually 5–15 seconds. Keep this tab open."}
                </p>
            )}
        </div>
    )
}
