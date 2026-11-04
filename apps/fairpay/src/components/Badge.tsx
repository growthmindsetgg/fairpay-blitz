import type { ReactNode } from "react"
import { Icon } from "./Icon"

export type BadgeTone = "neutral" | "verified" | "private" | "owed" | "warn" | "error" | "info"

/**
 * A small status chip. Tones carry meaning: "verified" (basil) only beside an on-chain check,
 * "private" (ink chip, cyan lock) only for confidential payments, "owed" (amber) for money still due.
 */
export function Badge({ tone = "neutral", children, icon }: { tone?: BadgeTone; children: ReactNode; icon?: boolean }) {
    const glyph = icon === false ? null : tone === "verified" ? "check" : tone === "private" ? "lock" : tone === "error" ? "alert" : null
    return (
        <span className={`badge badge-${tone}`}>
            {glyph ? <Icon name={glyph} size={14} /> : <span className="badge-dot" aria-hidden="true" />}
            {children}
        </span>
    )
}
