import { useEffect, useId, useRef, type ReactNode } from "react"
import { Icon } from "./Icon"

/**
 * A modal dialog on the native <dialog> element (focus trap, Escape, inert background for free).
 * `dismissible={false}` blocks Escape and hides the close button, e.g. while a payment is running.
 */
export function Modal({
    open,
    onClose,
    title,
    children,
    dismissible = true,
    size = "md"
}: {
    open: boolean
    onClose: () => void
    title: ReactNode
    children: ReactNode
    dismissible?: boolean
    size?: "sm" | "md"
}) {
    const ref = useRef<HTMLDialogElement>(null)
    const titleId = `m${useId().replace(/:/g, "")}`
    const opener = useRef<Element | null>(null)

    useEffect(() => {
        const d = ref.current
        if (!d) return
        if (open && !d.open) {
            opener.current = document.activeElement
            try {
                d.showModal()
            } catch {
                d.setAttribute("open", "")
            }
        } else if (!open && d.open) {
            d.close()
            // Return focus to whatever opened the dialog.
            const el = opener.current as HTMLElement | null
            if (el && typeof el.focus === "function" && document.contains(el)) el.focus()
        }
    }, [open])

    // Closing from outside React (Escape) must go through onClose so state stays in sync.
    useEffect(() => {
        const d = ref.current
        if (!d) return
        const onCancel = (e: Event) => {
            e.preventDefault()
            if (dismissible) onClose()
        }
        d.addEventListener("cancel", onCancel)
        return () => d.removeEventListener("cancel", onCancel)
    }, [dismissible, onClose])

    return (
        <dialog
            ref={ref}
            className={`modal modal-${size}`}
            aria-labelledby={titleId}
            onClick={(e) => {
                // A click on the backdrop (the dialog itself, outside the panel) closes it.
                if (dismissible && e.target === ref.current) onClose()
            }}
        >
            {open && (
                <div className="modal-panel">
                    <div className="modal-head">
                        <h2 id={titleId} className="modal-title">
                            {title}
                        </h2>
                        {dismissible && (
                            <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close">
                                <Icon name="close" />
                            </button>
                        )}
                    </div>
                    <div className="modal-body">{children}</div>
                </div>
            )}
        </dialog>
    )
}
