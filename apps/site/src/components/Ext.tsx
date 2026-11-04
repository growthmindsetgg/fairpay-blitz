import type { ReactNode } from "react"

/** External link: opens in a new tab and says so to screen readers, no arrow glyph. */
export function Ext({ href, children, hint, className }: { href: string; children: ReactNode; hint?: string; className?: string }) {
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
            {children}
            <span className="sr-only"> ({hint ? `${hint}, ` : ""}opens in a new tab)</span>
        </a>
    )
}
