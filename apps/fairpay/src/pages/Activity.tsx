import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { ActivityItem } from "../../shared/types"
import { EmptyState } from "../components/EmptyState"
import { friendly } from "../components/errors"
import { Icon } from "../components/Icon"
import { ErrorNote, Loading, PageHeader, SignInGate, useTitle } from "../components/Page"
import { api } from "../lib/api"
import { dateTime, isTxHash, timeAgo } from "../lib/format"
import { useWallet } from "../lib/wallet"

export function Activity() {
    useTitle("Activity")
    return (
        <div className="content content-narrow">
            <ActivityInner />
        </div>
    )
}

/** Only follow links that stay inside FairPay. Activity text comes from other people's input. */
const internal = (link: string | null) => (link && link.startsWith("/") && !link.startsWith("//") ? link : null)

function ActivityInner() {
    const { cfg } = useWallet()
    const [items, setItems] = useState<ActivityItem[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [marking, setMarking] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            setItems(await api.activity())
        } catch (e) {
            setError(friendly(e))
        }
    }, [])

    const unread = items?.filter((i) => !i.read).length ?? 0

    const markAll = async () => {
        setMarking(true)
        try {
            await api.markActivityRead()
            setItems((xs) => xs?.map((x) => ({ ...x, read: true })) ?? null)
        } catch (e) {
            setError(friendly(e))
        } finally {
            setMarking(false)
        }
    }

    return (
        <>
            <PageHeader
                title="Activity"
                description="Payments, reminders and bills that involve you."
                actions={
                    unread > 0 ? (
                        <button type="button" className="btn btn-secondary btn-sm" disabled={marking} onClick={() => void markAll()}>
                            {marking ? "Marking…" : `Mark ${unread} as read`}
                        </button>
                    ) : null
                }
            />
            <SignInGate title="Sign in to see your activity">
                <Loader load={load} />
                <section className="card card-flush" aria-label="Activity">
                    {error ? (
                        <div className="card">
                            <ErrorNote message={error} onRetry={() => void load()} />
                        </div>
                    ) : !items ? (
                        <div className="card">
                            <Loading />
                        </div>
                    ) : items.length === 0 ? (
                        <EmptyState icon="bell" title="Nothing yet">
                            <p>When someone adds you to a bill, pays you, or sends a reminder, it shows up here.</p>
                        </EmptyState>
                    ) : (
                        <ul className="list list-actionable">
                            {items.map((i) => {
                                const href = internal(i.link)
                                // The server only sends a hash for public payments; check its shape before building a URL.
                                const tx = isTxHash(i.txHash) ? i.txHash : null
                                const body = (
                                    <>
                                        <span className="activity-dot" data-read={i.read} aria-hidden="true" />
                                        <span className="list-main">
                                            <span className="list-title">
                                                {i.title}
                                                {!i.read && <span className="sr-only"> (unread)</span>}
                                            </span>
                                            {i.detail && <span className="list-sub">{i.detail}</span>}
                                        </span>
                                        <time className="field-hint" dateTime={new Date(i.createdAt).toISOString()} title={dateTime(i.createdAt)}>
                                            {timeAgo(i.createdAt)}
                                        </time>
                                    </>
                                )
                                return (
                                    <li key={i.id} className={tx ? "list-split" : undefined}>
                                        {href ? (
                                            <Link to={href} className="list-row">
                                                {body}
                                            </Link>
                                        ) : (
                                            <div className="list-row">{body}</div>
                                        )}
                                        {tx && (
                                            <div className="list-actions">
                                                <a className="btn btn-quiet btn-sm" href={`${cfg.explorer}/tx/${tx}`} target="_blank" rel="noreferrer" title={tx}>
                                                    <Icon name="external" size={16} />
                                                    View transaction<span className="sr-only"> on the Monad explorer (opens in a new tab)</span>
                                                </a>
                                            </div>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </section>
            </SignInGate>
        </>
    )
}

/** Runs the load once the gate has confirmed a session. */
function Loader({ load }: { load: () => Promise<void> }) {
    useEffect(() => {
        void load()
    }, [load])
    return null
}
