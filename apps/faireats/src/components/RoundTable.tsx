import { usdc, type Share } from "../api"

// The table seen from above. Each guest is a seat; a seat fills in when that guest's share is
// verified on-chain. Seats paid privately are frosted violet with a lock: the table knows they
// paid, nobody can see which wallet did.

const SIZE = 340
const C = SIZE / 2
const TABLE_R = 92
const SEAT_R = 30
const ORBIT = TABLE_R + SEAT_R + 18

const INK = "#1D1B33"
const INK_FAINT = "#66637F"
const SAFFRON_DEEP = "#B8731A"
const BASIL = "#2E7A57"

type SeatState = "paid" | "private" | "partial" | "open"

function seatState(s: Share): SeatState {
    if (s.status === "verified") return s.payments.length > 0 && s.payments.every((p) => p.kind === "private") ? "private" : "paid"
    return s.status === "executed" ? "partial" : "open"
}

export function RoundTable({ shares, table, highlight }: { shares: Share[]; table: number; highlight?: number }) {
    const n = Math.max(shares.length, 1)
    return (
        <svg className="table-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={describe(shares, table)}>
            <defs>
                <pattern id="frost" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="6" height="6" fill="#6A4BD6" />
                    <line x1="0" y1="0" x2="0" y2="6" stroke="#8B71E8" strokeWidth="3" />
                </pattern>
            </defs>
            <circle cx={C} cy={C} r={TABLE_R} fill={INK} />
            <circle cx={C} cy={C} r={TABLE_R - 10} fill="none" stroke="#F2A93B" strokeWidth="2" strokeDasharray="2 7" />
            <text x={C} y={C - 4} textAnchor="middle" fill="#F4F2FB" fontFamily="Bricolage Grotesque" fontWeight="800" fontSize="44">
                {table}
            </text>
            <text x={C} y={C + 22} textAnchor="middle" fill="#A9A6C6" fontFamily="Atkinson Hyperlegible" fontSize="13">
                table
            </text>
            {shares.map((s, i) => {
                const a = (i / n) * Math.PI * 2 - Math.PI / 2
                const x = C + Math.cos(a) * ORBIT
                const y = C + Math.sin(a) * ORBIT
                const state = seatState(s)
                const mine = highlight === s.guest
                const fill = state === "private" ? "url(#frost)" : state === "paid" ? BASIL : "#FFFFFF"
                const stroke =
                    state === "paid" || state === "private"
                        ? mine
                            ? INK
                            : "none"
                        : state === "partial"
                          ? SAFFRON_DEEP
                          : mine
                            ? INK
                            : INK_FAINT
                return (
                    <g key={s.id}>
                        <circle
                            className="seat"
                            cx={x}
                            cy={y}
                            r={SEAT_R}
                            fill={fill}
                            stroke={stroke}
                            strokeWidth={mine ? 5 : 4}
                            strokeDasharray={state === "partial" && !mine ? "6 5" : undefined}
                        />
                        {state === "private" ? (
                            <Lock x={x} y={y} />
                        ) : state === "paid" ? (
                            <Check x={x} y={y} />
                        ) : (
                            <text
                                x={x}
                                y={y + 6}
                                textAnchor="middle"
                                fontFamily="Bricolage Grotesque"
                                fontWeight="800"
                                fontSize="18"
                                fill={INK}
                            >
                                {s.guest}
                            </text>
                        )}
                    </g>
                )
            })}
        </svg>
    )
}

/** A padlock drawn in paths, so it renders the same on every device with no font involved. */
function Lock({ x, y }: { x: number; y: number }) {
    return (
        <g fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x={x - 7} y={y - 2} width={14} height={10} rx={2.5} fill="#FFFFFF" />
            <path d={`M ${x - 5} ${y - 2} v -3 a 5 5 0 0 1 10 0 v 3`} />
        </g>
    )
}

function Check({ x, y }: { x: number; y: number }) {
    return (
        <path
            d={`M ${x - 8} ${y + 1} l 5.5 5.5 l 10.5 -11`}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    )
}

function describe(shares: Share[], table: number) {
    const states = shares.map(seatState)
    const paid = states.filter((s) => s === "paid" || s === "private").length
    const privately = states.filter((s) => s === "private").length
    const parts = [`Table ${table}: ${paid} of ${shares.length} ${shares.length === 1 ? "guest" : "guests"} paid`]
    if (privately > 0) parts[0] += `, ${privately} privately`
    const partial = shares
        .filter((s) => s.status === "executed")
        .map((s) => `Guest ${s.guest} has paid ${usdc(s.paid)} of ${usdc(s.amount)}`)
    return [...parts, ...partial].join(". ") + "."
}

/** The key for the seats, so colour is never the only signal. */
export function RoundTableLegend() {
    return (
        <ul className="legend" aria-label="What the seats mean">
            <li>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="7" fill={BASIL} />
                    <path
                        d="M 4.5 8.3 l 2.3 2.3 l 4.7 -4.9"
                        fill="none"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
                Paid
            </li>
            <li>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="7" fill="#6A4BD6" />
                    <rect x="5" y="7.5" width="6" height="4.5" rx="1" fill="#fff" />
                    <path d="M 6 7.5 v -1.5 a 2 2 0 0 1 4 0 v 1.5" fill="none" stroke="#fff" strokeWidth="1.4" />
                </svg>
                Paid privately
            </li>
            <li>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" fill="#fff" stroke={SAFFRON_DEEP} strokeWidth="2" strokeDasharray="3 2.4" />
                </svg>
                Part paid
            </li>
            <li>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" fill="#fff" stroke={INK_FAINT} strokeWidth="2" />
                </svg>
                Not paid yet
            </li>
        </ul>
    )
}
