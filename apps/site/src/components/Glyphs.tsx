// The site's few glyphs: the verified check, the privacy lock, the copy glyph for proof rows,
// and three for the hero's trust row.

export function LockGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="2.5" y="7" width="11" height="7.5" rx="1.8" fill="currentColor" />
            <path d="M5 7V5.2a3 3 0 0 1 6 0V7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    )
}

export function CheckGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
                d="M3 8.5l3.2 3.2L13 4.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

export function CopyGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
    )
}

/** A signature line with a pen: "you sign a message". Trust row only. */
export function SignGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M9.8 2.8l2.4 2.4l-6.4 6.4H3.4V9.2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M2 14.2h12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

/** A warning triangle: testnet and unaudited. */
export function AlertGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6.4v3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
        </svg>
    )
}

/** An "i" in a circle: who makes FairPay. */
export function InfoGlyph({ className = "glyph" }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7.2v4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
        </svg>
    )
}
