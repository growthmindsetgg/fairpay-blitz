import { useId, useRef, type KeyboardEvent, type ReactNode } from "react"

export type TabItem<T extends string = string> = { id: T; label: ReactNode; count?: number; hidden?: boolean }

/**
 * ARIA tabs (manual activation is not needed here: arrow keys move and select). Render the
 * panels with <TabPanel> using the same `idBase`, or pass `children` for the current panel.
 *
 *   const [tab, setTab] = useState("incoming")
 *   <Tabs label="Requests" items={[{id:"incoming",label:"Incoming"},...]} value={tab} onChange={setTab}>
 *     {tab === "incoming" ? <Incoming/> : <Outgoing/>}
 *   </Tabs>
 */
export function Tabs<T extends string>({
    label,
    items,
    value,
    onChange,
    children
}: {
    label: string
    items: TabItem<T>[]
    value: T
    onChange: (id: T) => void
    children?: ReactNode
}) {
    const base = `t${useId().replace(/:/g, "")}`
    const visible = items.filter((i) => !i.hidden)
    const refs = useRef<Record<string, HTMLButtonElement | null>>({})
    const onKey = (e: KeyboardEvent) => {
        const i = visible.findIndex((t) => t.id === value)
        let next = -1
        if (e.key === "ArrowRight") next = (i + 1) % visible.length
        else if (e.key === "ArrowLeft") next = (i - 1 + visible.length) % visible.length
        else if (e.key === "Home") next = 0
        else if (e.key === "End") next = visible.length - 1
        if (next < 0) return
        e.preventDefault()
        const id = visible[next]!.id
        onChange(id)
        refs.current[id]?.focus()
    }
    return (
        <div className="tabs">
            <div className="tablist" role="tablist" aria-label={label} onKeyDown={onKey}>
                {visible.map((t) => (
                    <button
                        key={t.id}
                        ref={(el) => {
                            refs.current[t.id] = el
                        }}
                        type="button"
                        role="tab"
                        id={`${base}-tab-${t.id}`}
                        aria-selected={t.id === value}
                        aria-controls={`${base}-panel`}
                        tabIndex={t.id === value ? 0 : -1}
                        className="tab"
                        onClick={() => onChange(t.id)}
                    >
                        {t.label}
                        {typeof t.count === "number" && t.count > 0 && <span className="tab-count">{t.count}</span>}
                    </button>
                ))}
            </div>
            {children !== undefined && (
                <div className="tabpanel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`} tabIndex={0}>
                    {children}
                </div>
            )}
        </div>
    )
}
