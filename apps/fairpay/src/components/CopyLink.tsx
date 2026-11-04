import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "./Icon"

async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch {
        // Older browsers or a denied permission: fall back to a hidden textarea.
        try {
            const ta = document.createElement("textarea")
            ta.value = text
            ta.setAttribute("readonly", "")
            ta.className = "sr-only"
            document.body.appendChild(ta)
            ta.select()
            const ok = document.execCommand("copy")
            ta.remove()
            return ok
        } catch {
            return false
        }
    }
}

/** A copy button. Announces "Copied" politely; shows an error if the browser refuses. */
export function CopyButton({ text, label = "Copy", className = "btn btn-secondary btn-sm" }: { text: string; label?: string; className?: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const onClick = async () => {
        const ok = await copyText(text)
        setState(ok ? "copied" : "failed")
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setState("idle"), 2000)
    }
    return (
        <>
            <button type="button" className={className} onClick={onClick}>
                <Icon name={state === "copied" ? "check" : "copy"} size={16} />
                {state === "copied" ? "Copied" : label}
            </button>
            <span className="sr-only" role="status">
                {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Couldn't copy. Select the text and copy it yourself." : ""}
            </span>
        </>
    )
}

/**
 * A share link with a copy button: the URL is shown read-only (selectable) so it can be copied by
 * hand too. `label` names the field for screen readers and sighted users.
 */
export function CopyLink({ url, label = "Share link", hint }: { url: string; label?: string; hint?: string }) {
    const id = `copy${useId().replace(/:/g, "")}`
    return (
        <div className="copy-link">
            <label htmlFor={id} className="field-label">
                {label}
            </label>
            <div className="copy-link-row">
                <input
                    id={id}
                    className="input mono"
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-describedby={hint ? `${id}-hint` : undefined}
                />
                <CopyButton text={url} label="Copy link" className="btn btn-primary btn-sm" />
            </div>
            {hint && (
                <p className="field-hint" id={`${id}-hint`}>
                    {hint}
                </p>
            )}
        </div>
    )
}
