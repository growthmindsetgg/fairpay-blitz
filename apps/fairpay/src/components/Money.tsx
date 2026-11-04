import { shortHex, usdcNumber } from "../lib/format"

/**
 * Formats integer micro-USDC: <Money value={12500000} /> renders "12.50 USDC" with tabular figures.
 * The figure and the unit are separate spans, so the unit can sit back visually; the text (and what
 * a screen reader hears) is still "12.50 USDC".
 * `unit={false}` drops " USDC" (for tight columns that say the unit in a header).
 */
export function Money({ value, unit = true, className, strong }: { value: number; unit?: boolean; className?: string; strong?: boolean }) {
    const cls = ["money", className].filter(Boolean).join(" ")
    const inner = (
        <>
            <span className="money-num">{usdcNumber(value)}</span>
            {unit && <span className="money-unit"> USDC</span>}
        </>
    )
    return strong ? <strong className={cls}>{inner}</strong> : <span className={cls}>{inner}</span>
}

/**
 * A wallet address or hash in the house style: mono, middle ellipsis (0x1234…abcd), the full value
 * in `title` and for screen readers. Pass `href` to link it (opens a new tab, announced).
 */
export function Address({ value, href, className }: { value: string; href?: string; className?: string }) {
    const cls = ["mono addr", className].filter(Boolean).join(" ")
    const inner = (
        <>
            <span aria-hidden="true">{shortHex(value)}</span>
            <span className="sr-only">{value}</span>
        </>
    )
    if (href)
        return (
            <a className={cls} href={href} target="_blank" rel="noreferrer" title={value}>
                {inner}
                <span className="sr-only"> (opens in a new tab)</span>
            </a>
        )
    return (
        <span className={cls} title={value}>
            {inner}
        </span>
    )
}
