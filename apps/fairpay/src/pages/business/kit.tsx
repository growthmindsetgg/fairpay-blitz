// Dashboard building blocks: a side drawer (native <dialog>, so focus trapping and Escape come
// from the browser), a switch, a two-step delete button and accessible tabs.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

export function Drawer({
    open,
    onClose,
    title,
    children,
    footer
}: {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
    footer?: ReactNode
}) {
    const ref = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        const d = ref.current
        if (!d) return
        if (open && !d.open) d.showModal()
        if (!open && d.open) d.close()
    }, [open])
    return (
        <dialog
            ref={ref}
            className="fe-drawer"
            aria-labelledby="fe-drawer-title"
            onCancel={(e) => {
                e.preventDefault()
                onClose()
            }}
            onClick={(e) => {
                // A click on the backdrop (the dialog element itself, outside the panel) closes it.
                if (e.target === e.currentTarget) onClose()
            }}
        >
            {open && (
                <div className="fe-drawer-panel">
                    <div className="fe-drawer-head">
                        <h2 id="fe-drawer-title">{title}</h2>
                        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
                            Close
                        </button>
                    </div>
                    <div className="fe-drawer-body">{children}</div>
                    {footer && <div className="fe-drawer-foot">{footer}</div>}
                </div>
            )}
        </dialog>
    )
}

// The app-wide switch (a checkbox with role="switch"), so toggles look the same everywhere.
export { Switch } from "../../components"

/** First click arms it, second click confirms. Disarms after 4 s or on blur. */
export function ConfirmButton({
    children,
    confirmText,
    onConfirm,
    disabled,
    className = "btn btn-danger btn-sm"
}: {
    children: ReactNode
    confirmText: string
    onConfirm: () => void
    disabled?: boolean
    className?: string
}) {
    const [armed, setArmed] = useState(false)
    useEffect(() => {
        if (!armed) return
        const t = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(t)
    }, [armed])
    return (
        <button
            type="button"
            className={`${className}${armed ? " is-armed" : ""}`}
            disabled={disabled}
            onBlur={() => setArmed(false)}
            onClick={() => {
                if (armed) {
                    setArmed(false)
                    onConfirm()
                } else setArmed(true)
            }}
        >
            {armed ? confirmText : children}
        </button>
    )
}

export type TabDef<K extends string> = { key: K; label: string; badge?: number }

/** WAI-ARIA tabs with automatic activation: arrow keys, Home and End move between tabs. */
export function TabBar<K extends string>({
    tabs,
    current,
    onChange,
    label,
    idBase
}: {
    tabs: TabDef<K>[]
    current: K
    onChange: (k: K) => void
    label: string
    idBase: string
}) {
    const refs = useRef<(HTMLButtonElement | null)[]>([])
    const onKey = (e: KeyboardEvent, i: number) => {
        let next = -1
        if (e.key === "ArrowRight") next = (i + 1) % tabs.length
        else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length
        else if (e.key === "Home") next = 0
        else if (e.key === "End") next = tabs.length - 1
        if (next < 0) return
        e.preventDefault()
        onChange(tabs[next].key)
        refs.current[next]?.focus()
    }
    return (
        <div className="fe-tabs" role="tablist" aria-label={label}>
            {tabs.map((t, i) => {
                const selected = t.key === current
                return (
                    <button
                        key={t.key}
                        ref={(el) => {
                            refs.current[i] = el
                        }}
                        id={`${idBase}-tab-${t.key}`}
                        role="tab"
                        type="button"
                        aria-selected={selected}
                        aria-controls={`${idBase}-panel-${t.key}`}
                        tabIndex={selected ? 0 : -1}
                        className="fe-tab"
                        onClick={() => onChange(t.key)}
                        onKeyDown={(e) => onKey(e, i)}
                    >
                        {t.label}
                        {t.badge ? (
                            <span className="fe-tab-badge">
                                {t.badge}
                                <span className="sr-only"> new</span>
                            </span>
                        ) : null}
                    </button>
                )
            })}
        </div>
    )
}
