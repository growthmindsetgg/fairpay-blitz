import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { CheckGlyph, LockGlyph } from "./Glyphs"

/** A guide section with an h2 and a "#" anchor link that shows on hover and focus. */
export function Section({
    id,
    title,
    children,
    toTop = false
}: {
    id: string
    title: string
    children: ReactNode
    /** Adds a "Back to top" link at the end, shown on phones, for long sections. */
    toTop?: boolean
}) {
    return (
        <section id={id} className="g-section" aria-labelledby={`${id}-h`}>
            <h2 id={`${id}-h`}>
                {title}
                <a className="anchor" href={`#${id}`}>
                    <span aria-hidden="true">#</span>
                    <span className="sr-only">Link to this section</span>
                </a>
            </h2>
            {children}
            {toTop && <BackToTop />}
        </section>
    )
}

/** An h3 with an id, so the "On this page" rail can link to it. */
export function H3({ id, children }: { id: string; children: ReactNode }) {
    return (
        <h3 id={id}>
            {children}
            <a className="anchor" href={`#${id}`}>
                <span aria-hidden="true">#</span>
                <span className="sr-only">Link to this section</span>
            </a>
        </h3>
    )
}

export function BackToTop() {
    return (
        <p className="to-top">
            <a href="#top">Back to top</a>
        </p>
    )
}

/** "You need" block on how-to and tutorial pages. Items are lifted from the page's own text. */
export function YouNeed({ children }: { children: ReactNode }) {
    return (
        <aside className="you-need" aria-labelledby="you-need">
            <h2 id="you-need">You need</h2>
            {children}
        </aside>
    )
}

/** The three callout kinds: check, careful, privacy. */
export function Callout({ kind, children }: { kind: "check" | "careful" | "privacy"; children: ReactNode }) {
    const label = kind === "check" ? "Check:" : kind === "careful" ? "Careful:" : "Privacy:"
    return (
        <div className={`callout ${kind}`}>
            {kind === "privacy" && <LockGlyph />}
            {kind === "check" && <CheckGlyph />}
            <p>
                <strong>{label}</strong> {children}
            </p>
        </div>
    )
}

/** An internal link to another guide page. */
export function G({ to, children }: { to: string; children: ReactNode }) {
    return <Link to={to}>{children}</Link>
}
