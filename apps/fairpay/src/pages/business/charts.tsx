// Small charts for the dashboard, drawn as inline SVG: no chart library and nothing loaded from
// elsewhere (the app's CSP allows only 'self'). One series each, so no legend: the heading names
// it. Colours come from CSS tokens in business.css (light and dark). Every value is also in a
// table under "Show as table", so the hover readout is a convenience, never the only way in.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { niceMax, type Column } from "./statsView"

export type { Column }

/** Width of an element in CSS pixels, kept current. Starts at a phone width before the first measure. */
function useWidth<T extends HTMLElement>(fallback = 320) {
    const ref = useRef<T>(null)
    const [width, setWidth] = useState(fallback)
    useEffect(() => {
        const el = ref.current
        if (!el) return
        setWidth(el.clientWidth || fallback)
        if (typeof ResizeObserver === "undefined") return
        const ro = new ResizeObserver(() => setWidth(el.clientWidth || fallback))
        ro.observe(el)
        return () => ro.disconnect()
    }, [fallback])
    return [ref, width] as const
}

/** A column whose top corners are rounded (4px) and whose foot sits square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number) {
    const r = Math.min(4, w / 2, h)
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

const PLOT_H = 140
const TOP = 22
const TICK_H = 22

/**
 * A column chart. Hover or arrow keys read one column out in the line above the chart; the
 * tallest column carries its value. `axis` formats the gridline value at the top.
 */
export function ColumnChart({
    title,
    columns,
    summary,
    axis,
    valueHead
}: {
    title: string
    columns: Column[]
    /** What the readout says when no column is picked, e.g. "Busiest: 1 pm, 6 orders". */
    summary: string
    axis: (v: number) => string
    /** Column heading for the values in the table view. */
    valueHead: string
}) {
    const [box, width] = useWidth<HTMLDivElement>()
    const [active, setActive] = useState<number | null>(null)
    const n = columns.length
    const max = niceMax(Math.max(0, ...columns.map((c) => c.value)))
    const slot = width / Math.max(1, n)
    // Thin columns with air between them: never wider than 24px, at least a 2px gap.
    const barW = Math.max(2, Math.min(24, slot * 0.66, slot - 2))
    const peak = columns.reduce((best, c, i) => (c.value > (columns[best]?.value ?? 0) ? i : best), 0)
    const y = (v: number) => TOP + PLOT_H - (v / max) * PLOT_H
    const h = TOP + PLOT_H + TICK_H
    const pick = active !== null ? columns[active] : null

    const onKey = (e: KeyboardEvent) => {
        let next: number | null = null
        if (e.key === "ArrowRight") next = active === null ? 0 : Math.min(n - 1, active + 1)
        else if (e.key === "ArrowLeft") next = active === null ? n - 1 : Math.max(0, active - 1)
        else if (e.key === "Home") next = 0
        else if (e.key === "End") next = n - 1
        else if (e.key === "Escape") setActive(null)
        if (next === null) return
        e.preventDefault()
        setActive(next)
    }

    return (
        <figure className="fe-chart">
            <figcaption className="fe-chart-title">{title}</figcaption>
            <p className="fe-chart-readout" aria-live="polite">
                {pick ? (
                    <>
                        <strong>{pick.text}</strong> <span>{pick.label}</span>
                    </>
                ) : (
                    <span>{summary}</span>
                )}
            </p>
            <div
                ref={box}
                className="fe-chart-plot"
                tabIndex={0}
                role="group"
                aria-label={`${title}. Use the left and right arrow keys to read each column.`}
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
            >
                <svg
                    width={width}
                    height={h}
                    viewBox={`0 0 ${width} ${h}`}
                    aria-hidden="true"
                    focusable="false"
                    onPointerMove={(e) => {
                        const x = e.clientX - e.currentTarget.getBoundingClientRect().left
                        setActive(Math.max(0, Math.min(n - 1, Math.floor(x / slot))))
                    }}
                    onPointerLeave={() => setActive(null)}
                >
                    <line className="fe-chart-grid" x1={0} x2={width} y1={TOP} y2={TOP} />
                    <text className="fe-chart-axis" x={0} y={TOP - 7}>
                        {axis(max)}
                    </text>
                    {columns.map((c, i) => {
                        const x = i * slot + (slot - barW) / 2
                        const top = y(c.value)
                        return (
                            <g key={c.key} className={i === active ? "is-active" : undefined}>
                                {/* The whole slot is the hover target, not just the painted column. */}
                                <rect className="fe-chart-hit" x={i * slot} y={TOP} width={slot} height={PLOT_H} />
                                {c.value > 0 && <path className="fe-chart-col" d={columnPath(x, top, barW, TOP + PLOT_H - top)} />}
                                {c.tick && (
                                    <text className="fe-chart-tick" x={i * slot + slot / 2} y={TOP + PLOT_H + 16} textAnchor="middle">
                                        {c.tick}
                                    </text>
                                )}
                            </g>
                        )
                    })}
                    <line className="fe-chart-base" x1={0} x2={width} y1={TOP + PLOT_H} y2={TOP + PLOT_H} />
                    {active === null && columns[peak] && columns[peak].value > 0 && (
                        <PeakLabel x={peak * slot + slot / 2} y={y(columns[peak].value) - 6} width={width} text={columns[peak].text} avoid={axis(max).length * 7 + 8} />
                    )}
                </svg>
            </div>
            <TableView>
                <table className="fe-chart-table">
                    <thead>
                        <tr>
                            <th scope="col">{title}</th>
                            <th scope="col">{valueHead}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {columns.map((c) => (
                            <tr key={c.key}>
                                <th scope="row">{c.label}</th>
                                <td>{c.text}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </TableView>
        </figure>
    )
}

/**
 * The tallest column's value just above it, kept inside the chart at the edges. Left out when it
 * would sit on the axis label (up to `avoid` px from the left); the readout still names it.
 */
function PeakLabel({ x, y, width, text, avoid }: { x: number; y: number; width: number; text: string; avoid: number }) {
    // About 7px per character at 12px; enough to keep the label off the edges.
    const half = (text.length * 7) / 2
    const cx = Math.max(half, Math.min(width - half, x))
    const ty = Math.max(12, y)
    if (ty < TOP + 4 && cx - half < avoid) return null
    return (
        <text className="fe-chart-peak" x={cx} y={ty} textAnchor="middle">
            {text}
        </text>
    )
}

export function TableView({ children }: { children: ReactNode }) {
    return (
        <details className="fe-chart-details">
            <summary>Show as table</summary>
            {children}
        </details>
    )
}

/**
 * One bar split in two (public and confidential payments), with a legend that names each part
 * and its amount, so identity never rests on colour.
 */
export function SplitBar({ parts }: { parts: { key: string; label: string; value: number; text: string; tone: "public" | "private" }[] }) {
    const total = parts.reduce((s, p) => s + p.value, 0)
    return (
        <div className="fe-paysplit">
            {total > 0 && (
                <div className="fe-paysplit-bar" aria-hidden="true">
                    {parts
                        .filter((p) => p.value > 0)
                        .map((p) => (
                            <span key={p.key} className={`fe-paysplit-seg is-${p.tone}`} style={{ flexGrow: p.value }} />
                        ))}
                </div>
            )}
            <ul className="fe-paysplit-legend">
                {parts.map((p) => (
                    <li key={p.key}>
                        <span className={`fe-paysplit-key is-${p.tone}`} aria-hidden="true" />
                        <span className="fe-paysplit-label">{p.label}</span>
                        <span className="fe-num">{p.text}</span>
                        {total > 0 && <span className="fe-paysplit-share">{Math.round((p.value / total) * 100)}%</span>}
                    </li>
                ))}
            </ul>
        </div>
    )
}
