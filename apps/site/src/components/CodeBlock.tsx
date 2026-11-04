import { useRef } from "react"
import { highlight, langFor } from "../lib/highlight"
import { useCopy } from "../lib/hooks"

/** Code block: label strip, Copy button, local syntax colouring (no third-party highlighter, so it works under the CSP). */
export function CodeBlock({ code, label }: { code: string; label: string }) {
    const pre = useRef<HTMLPreElement>(null)
    const { state, copy } = useCopy()

    return (
        <div className="code on-ink">
            <div className="code-head">
                <span className="code-label">{label}</span>
                <button type="button" className="code-copy" onClick={() => copy(code, pre.current)}>
                    {state === "copied" ? "Copied" : state === "manual" ? "Press Ctrl+C" : "Copy"}
                    <span className="sr-only"> {label} code</span>
                </button>
            </div>
            <pre ref={pre} tabIndex={0} aria-label={`${label} code`}>
                <code>{highlight(code, langFor(label))}</code>
            </pre>
            <p className="sr-only" role="status">
                {state === "copied" ? "Copied to clipboard" : state === "manual" ? "Code selected. Press Ctrl+C to copy." : ""}
            </p>
        </div>
    )
}
