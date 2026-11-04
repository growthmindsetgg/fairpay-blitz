import { useEffect, useRef, type ReactNode } from "react"
import { useWallet } from "../lib/wallet"
import { EmptyState } from "./EmptyState"
import { Icon } from "./Icon"

/** Sets document.title as "<title> · FairPay". */
export function useTitle(title: string | null | undefined) {
    useEffect(() => {
        document.title = title ? `${title} · FairPay` : "FairPay"
    }, [title])
}

/**
 * The top of a page: H1, optional status badge beside it, one-line description, actions on the
 * right (wrap on phones).
 */
export function PageHeader({
    title,
    description,
    actions,
    back,
    status
}: {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    back?: ReactNode
    /** A <Badge> that qualifies the title, e.g. a bill's Open / Settled state. */
    status?: ReactNode
}) {
    return (
        <header className="page-head">
            {back && <div className="page-back">{back}</div>}
            <div className="page-head-row">
                <div className="page-head-text">
                    {status ? (
                        <div className="page-title-row">
                            <h1 className="page-title">{title}</h1>
                            {status}
                        </div>
                    ) : (
                        <h1 className="page-title">{title}</h1>
                    )}
                    {description && <p className="page-desc">{description}</p>}
                </div>
                {actions && <div className="page-actions">{actions}</div>}
            </div>
        </header>
    )
}

/** A quiet loading line with a spinner. Announced politely. */
export function Loading({ label = "Loading…" }: { label?: string }) {
    return (
        <p className="progress loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {label}
        </p>
    )
}

/** An error block with an optional retry. Use for failed page loads. */
export function ErrorNote({ message, onRetry, title = "Something went wrong" }: { message: string; onRetry?: () => void; title?: string }) {
    const ref = useRef<HTMLDivElement>(null)
    return (
        <div className="error-note" role="alert" ref={ref}>
            <Icon name="alert" size={20} />
            <div>
                <p className="error-note-title">{title}</p>
                <p>{message}</p>
                {onRetry && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                        Try again
                    </button>
                )}
            </div>
        </div>
    )
}

/** Renders children only when signed in; otherwise a sign-in prompt that says why. */
export function SignInGate({ children, title = "Sign in to continue", reason }: { children: ReactNode; title?: string; reason?: ReactNode }) {
    const { me, meLoading, requestConnect } = useWallet()
    if (meLoading) return <Loading label="Checking your session…" />
    if (!me)
        return (
            <EmptyState
                icon="wallet"
                title={title}
                action={
                    <button type="button" className="btn btn-primary" onClick={() => void requestConnect({ signIn: true })}>
                        Sign in with a wallet
                    </button>
                }
            >
                <p>{reason ?? "Sign in with your wallet. It's free, and signing never moves funds."}</p>
            </EmptyState>
        )
    return <>{children}</>
}

/** A titled surface. `flush` drops the padding (for lists that run edge to edge). */
export function Card({ title, actions, children, flush, className, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
    const headingId = id ? `${id}-h` : undefined
    return (
        <section className={["card", flush ? "card-flush" : "", className].filter(Boolean).join(" ")} aria-labelledby={title ? headingId : undefined} id={id}>
            {(title || actions) && (
                <div className="card-head">
                    {title && (
                        <h2 className="card-title" id={headingId}>
                            {title}
                        </h2>
                    )}
                    {actions && <div className="card-actions">{actions}</div>}
                </div>
            )}
            {children}
        </section>
    )
}
