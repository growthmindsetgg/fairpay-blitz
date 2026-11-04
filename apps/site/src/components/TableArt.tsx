import type { Ref } from "react"
import { CHAIR_N, CHAIR_S, CHAIR_W, PRIVATE_CHAIR, PRIVATE_HOLE } from "./tablePlan"

// The hero table, drawn on the logo's 48-unit grid with the logo's own chair paths: a table
// disc (r 10) and four chairs, guest 1 north, then clockwise. A chair fills when that guest's
// share is verified: basil with a check for a public payment, hollow teal with a lock for a
// private one. Classes and presentation attributes only, no style props (CSP).

export type SeatState = "empty" | "public" | "private"

type Seat = { d: string; cx: number; cy: number }

// Clockwise from the top, so guest 2 is east: the logo's hollow chair.
const SEATS: Seat[] = [
    { d: CHAIR_N, cx: 24, cy: 5.5 },
    { d: PRIVATE_CHAIR, cx: 42.5, cy: 24 },
    { d: CHAIR_S, cx: 24, cy: 42.5 },
    { d: CHAIR_W, cx: 5.5, cy: 24 }
]

function Check({ x, y }: { x: number; y: number }) {
    return (
        <path
            className="ta-check"
            d={`M${x - 1.7} ${y + 0.1}l1.15 1.15l2.3 -2.5`}
            fill="none"
            strokeWidth="0.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    )
}

function Lock({ x, y }: { x: number; y: number }) {
    return (
        <g className="ta-lock">
            <rect x={x - 1.2} y={y - 0.25} width="2.4" height="1.8" rx="0.35" />
            <path d={`M${x - 0.72} ${y - 0.25}v-0.55a0.72 0.72 0 0 1 1.44 0v0.55`} fill="none" strokeWidth="0.42" />
        </g>
    )
}

export function TableArt({
    seats,
    table,
    ready = false,
    label,
    className = "table-art",
    svgRef
}: {
    seats: SeatState[]
    table: number | string
    /** Every share verified: the table turns basil. */
    ready?: boolean
    /** Accessible name. Without one, the drawing is decorative. */
    label?: string
    className?: string
    svgRef?: Ref<SVGSVGElement>
}) {
    const a11y = label ? ({ role: "img", "aria-label": label } as const) : ({ "aria-hidden": true } as const)
    return (
        <svg ref={svgRef} className={`${className}${ready ? " is-ready" : ""}`} viewBox="-2 -2 52 52" focusable="false" {...a11y}>
            {SEATS.map((s, i) => {
                const state = seats[i] ?? "empty"
                const isPrivateChair = i === 1
                return (
                    <g key={i} className={`ta-seat is-${state}`}>
                        <path className="ta-empty" d={s.d} strokeWidth="0.4" strokeLinejoin="round" />
                        <text className="ta-num" x={s.cx} y={s.cy + 1.05} textAnchor="middle">
                            {i + 1}
                        </text>
                        <g className="ta-fill">
                            {state === "private" && isPrivateChair ? (
                                <>
                                    <path className="ta-hole" d={PRIVATE_HOLE} />
                                    <path className="ta-private" d={s.d + PRIVATE_HOLE} fillRule="evenodd" />
                                    <Lock x={s.cx} y={s.cy} />
                                </>
                            ) : state === "private" ? (
                                <>
                                    <path className="ta-private" d={s.d} />
                                    <Lock x={s.cx} y={s.cy} />
                                </>
                            ) : state === "public" ? (
                                <>
                                    <path className="ta-public" d={s.d} />
                                    <Check x={s.cx} y={s.cy} />
                                </>
                            ) : null}
                        </g>
                    </g>
                )
            })}
            <circle className="ta-table" cx="24" cy="24" r="10" />
            <text className="ta-t-num" x="24" y={typeof table === "number" ? 25.6 : 25.2} textAnchor="middle">
                {table}
            </text>
            <text className="ta-t-cap" x="24" y="29.4" textAnchor="middle">
                table
            </text>
        </svg>
    )
}
