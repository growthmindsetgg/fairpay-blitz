import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import type { BillSummary, Me } from "../../shared/types"
import { Badge } from "../components/Badge"
import { EmptyState } from "../components/EmptyState"
import { friendly } from "../components/errors"
import { Icon } from "../components/Icon"
import { Modal } from "../components/Modal"
import { Money } from "../components/Money"
import { ErrorNote, Loading, PageHeader, useTitle } from "../components/Page"
import { api } from "../lib/api"
import { plural, timeAgo } from "../lib/format"
import { useWallet } from "../lib/wallet"

// Home is in the first paint; the payment code (notes, proofs) loads only when someone pays.
const PayShare = lazy(() => import("../components/PayShare").then((m) => ({ default: m.PayShare })))

export function Home() {
    const { me, meLoading } = useWallet()
    useTitle(me ? "Home" : null)
    if (meLoading)
        return (
            <div className="content">
                <Loading />
            </div>
        )
    return me ? <Dashboard /> : <Welcome />
}

function Welcome() {
    const { requestConnect } = useWallet()
    return (
        <div className="content">
            <section className="intro" aria-labelledby="intro-h">
                <div className="stack">
                    <h1 id="intro-h" className="intro-title">
                        Split the bill. Everyone pays their part.
                    </h1>
                    <p className="intro-lead">
                        FairPay splits a bill between friends and tracks who has paid. Payments are in USDC on Monad, and FairPay checks every
                        one on-chain before marking it paid.
                    </p>
                    <div className="row">
                        <button type="button" className="btn btn-primary" onClick={() => void requestConnect({ signIn: true })}>
                            <Icon name="wallet" size={18} />
                            Sign in with a wallet
                        </button>
                        <Link to="/business/faireats" className="btn btn-secondary">
                            Browse FairEats restaurants
                        </Link>
                    </div>
                    <p className="field-hint">Runs on Monad Testnet with test USDC. No real money moves. Unaudited software.</p>
                </div>
                <IntroPreview />
                <ul className="intro-points">
                    <li>
                        <h2>Split any way</h2>
                        <p>Evenly, by fixed amounts, by percentage or by shares. Mark anyone who already paid you outside FairPay.</p>
                    </li>
                    <li>
                        <h2>One link per bill</h2>
                        <p>Send the link to the group. Each person sees their share and pays it from their own wallet.</p>
                    </li>
                    <li>
                        <h2>Paid means verified</h2>
                        <p>A share only shows as paid after FairPay finds the payment on Monad. Nobody can just tick a box.</p>
                    </li>
                    <li>
                        <h2>Confidential payments, for businesses</h2>
                        <p>
                            At verified businesses you can pay through the privacy pool. It hides which wallet paid; the amount is still
                            visible.
                        </p>
                    </li>
                </ul>
            </section>
        </div>
    )
}

/** A static example bill beside the welcome text: shows what a split looks like before signing in. Decorative. */
function IntroPreview() {
    const rows: { name: string; amount: number; badge: ReactNode }[] = [
        { name: "You", amount: 24_100_000, badge: <Badge tone="neutral">Organiser</Badge> },
        { name: "Asha", amount: 24_100_000, badge: <Badge tone="verified">Paid</Badge> },
        { name: "Ravi", amount: 24_100_000, badge: <Badge tone="private">Paid confidentially</Badge> },
        { name: "Sam", amount: 24_100_000, badge: <Badge tone="owed">Owes</Badge> }
    ]
    return (
        <figure className="intro-preview" aria-hidden="true">
            <div className="intro-preview-head">
                <span className="intro-preview-title">Dinner at Toit</span>
                <Badge tone="info">Open</Badge>
            </div>
            <div className="intro-preview-total">
                <Money value={96_400_000} />
                <span className="muted">3 of 4 paid</span>
            </div>
            <div className="progress-bar">
                <span style={{ width: "75%" }} />
            </div>
            <ul className="intro-preview-rows">
                {rows.map((r) => (
                    <li key={r.name}>
                        <span className="person">{r.name[0]}</span>
                        <span className="intro-preview-name">{r.name}</span>
                        <Money value={r.amount} />
                        {r.badge}
                    </li>
                ))}
            </ul>
            <figcaption className="field-hint">Example bill</figcaption>
        </figure>
    )
}

function Dashboard() {
    const { me } = useWallet()
    const [data, setData] = useState<{ bills: BillSummary[]; incoming: BillSummary[]; outgoing: BillSummary[] } | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const [bills, req] = await Promise.all([api.bills(), api.requests()])
            setData({ bills, incoming: req.incoming, outgoing: req.outgoing })
        } catch (e) {
            setError(friendly(e))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const name = me?.profile.displayName
    const owe = data?.incoming.reduce((s, b) => s + b.myDue, 0) ?? 0
    const waiting = data?.outgoing.reduce((s, b) => s + (b.participantCount - b.paidCount), 0) ?? 0

    return (
        <div className="content">
            <PageHeader
                title={name ? `Hi, ${name}` : "Your bills"}
                description="What you owe, what others owe you, and your recent bills."
                actions={
                    <Link to="/bills/new" className="btn btn-primary">
                        <Icon name="plus" size={18} />
                        New bill
                    </Link>
                }
            />
            {me && me.restaurants.length > 0 && <YourRestaurants restaurants={me.restaurants} />}
            {error && <ErrorNote message={error} onRetry={() => void load()} title="We couldn't load your bills" />}
            {!data && !error && <Loading label="Loading your bills…" />}
            {data && (
                <>
                    <div className="stat-grid">
                        <Link to="/requests" className="stat stat-link">
                            <span className="stat-label">You owe</span>
                            <span className="stat-value">
                                <Money value={owe} />
                            </span>
                            <span className="stat-sub">{data.incoming.length ? `On ${plural(data.incoming.length, "bill")}` : "You're all square"}</span>
                        </Link>
                        <Link to="/requests?tab=outgoing" className="stat stat-link">
                            <span className="stat-label">Waiting on others</span>
                            <span className="stat-value">{plural(waiting, "share")}</span>
                            <span className="stat-sub">{data.outgoing.length ? `Across ${plural(data.outgoing.length, "bill")}` : "Nobody owes you"}</span>
                        </Link>
                    </div>

                    <section className="card card-flush" aria-labelledby="recent-h">
                        <div className="card-head">
                            <h2 className="card-title" id="recent-h">
                                Recent bills
                            </h2>
                        </div>
                        {data.bills.length === 0 ? (
                            <EmptyState
                                icon="receipt"
                                title="No bills yet"
                                action={
                                    <Link to="/bills/new" className="btn btn-primary">
                                        Split your first bill
                                    </Link>
                                }
                            >
                                <p>Create a bill, add the people who shared it, and send them the link. Bills you're added to show up here too.</p>
                            </EmptyState>
                        ) : (
                            <BillList bills={data.bills.slice(0, 10)} onChanged={load} />
                        )}
                    </section>

                    <Link to="/business/faireats" className="card platform-card">
                        <span className="platform-mark">
                            <Icon name="store" size={22} />
                        </span>
                        <span className="list-main">
                            <span className="list-title">FairEats</span>
                            <span className="list-sub">Order at a restaurant table and pay your share. Verified restaurants take confidential payments.</span>
                        </span>
                        <Icon name="chevronRight" />
                    </Link>
                </>
            )}
        </div>
    )
}

const ROLE_LABEL: Record<Me["restaurants"][number]["role"], string> = { owner: "Owner", manager: "Manager", chef: "Chef", waiter: "Waiter" }

/** The merchant side, first: a wallet that owns or works at a restaurant gets its dashboard here. */
function YourRestaurants({ restaurants }: { restaurants: Me["restaurants"] }) {
    const shown = restaurants.slice(0, 3)
    return (
        <section className="merchant-home" aria-labelledby="merchant-h">
            <h2 id="merchant-h" className="sr-only">
                {restaurants.length === 1 ? "Your restaurant" : "Your restaurants"}
            </h2>
            <ul className="merchant-list">
                {shown.map((r) => (
                    <li key={r.id}>
                        <Link to={`/business/faireats/manage/${encodeURIComponent(r.id)}`} className="card platform-card merchant-card">
                            <span className="platform-mark">
                                <Icon name="store" size={22} />
                            </span>
                            <span className="list-main">
                                <span className="merchant-kicker">{restaurants.length === 1 ? "Your restaurant" : "Your restaurants"} · {ROLE_LABEL[r.role]}</span>
                                <span className="list-title">{r.name}</span>
                                <span className="list-sub">Today's orders, revenue, kitchen and tables.</span>
                            </span>
                            <span className="merchant-go">
                                Open dashboard
                                <Icon name="chevronRight" />
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
            {restaurants.length > shown.length && (
                <Link to="/business/faireats" className="merchant-more">
                    All {restaurants.length} of your restaurants
                </Link>
            )}
        </section>
    )
}

/** Bill rows, shared by Home and Requests. Rows the viewer can act on get Pay, Remind or Cancel. */
export function BillList({ bills, onChanged }: { bills: BillSummary[]; onChanged?: () => void | Promise<void> }) {
    // Dialogs live here, not in the rows: a refresh can drop the row they were opened from.
    const [paying, setPaying] = useState<BillSummary | null>(null)
    const [cancelling, setCancelling] = useState<BillSummary | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [cancelError, setCancelError] = useState<string | null>(null)
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
    const paid = useRef(false)

    const refresh = () => void Promise.resolve(onChanged?.()).catch(() => undefined)

    const rows = bills.map((b) => {
        const open = b.status === "open"
        return {
            b,
            canPay: open && b.role === "participant" && b.myDue > 0 && !!b.myParticipantId,
            canRemind: open && b.role === "creator" && b.paidCount < b.participantCount,
            canCancel: open && b.role === "creator" && b.canCancel === true
        }
    })
    // Every row keeps the same end column when any row has buttons, so the amounts line up.
    const columns = rows.some((r) => r.canRemind || r.canCancel) ? " list-has-actions list-has-manage" : rows.some((r) => r.canPay) ? " list-has-actions" : ""

    const remind = async (b: BillSummary) => {
        setBusy(`remind:${b.id}`)
        setNotice(null)
        try {
            const r = await api.remindBill(b.id)
            const n = r?.reminded ?? 0
            setNotice({
                text: n > 0 ? `Reminded ${plural(n, "person", "people")} on "${b.title}". They'll see it in their activity.` : `Everyone on "${b.title}" with a wallet has already paid.`
            })
            refresh()
        } catch (e) {
            setNotice({ text: friendly(e), error: true })
        } finally {
            setBusy(null)
        }
    }

    const cancel = async () => {
        const b = cancelling
        if (!b) return
        setBusy(`cancel:${b.id}`)
        setCancelError(null)
        try {
            await api.cancelBill(b.id)
            setCancelling(null)
            setNotice({ text: `"${b.title}" is cancelled. Nobody can pay it now.` })
        } catch (e) {
            setCancelError(friendly(e))
        } finally {
            setBusy(null)
            // Refresh either way: a refusal usually means someone has just paid.
            refresh()
        }
    }

    const closePay = () => {
        const b = paying
        setPaying(null)
        // Refresh once the dialog closes, so the success screen isn't pulled away mid-read.
        if (paid.current && b) {
            paid.current = false
            setNotice({ text: `Your share of "${b.title}" is paid.` })
            refresh()
        }
    }

    return (
        <>
            <div aria-live="polite">
                {notice && (
                    <p className={`list-notice ${notice.error ? "error-text" : "success-text"}`} role={notice.error ? "alert" : undefined}>
                        {!notice.error && <Icon name="check" size={16} />}
                        {notice.text}
                    </p>
                )}
            </div>
            <ul className={`list list-actionable${columns}`}>
                {rows.map(({ b, canPay, canRemind, canCancel }) => {
                    const hasActions = canPay || canRemind || canCancel
                    return (
                        <li key={b.id} className={hasActions ? "list-split" : undefined}>
                            <Link to={`/bills/${encodeURIComponent(b.id)}`} className="list-row">
                                <span
                                    className="list-lead list-lead-optional"
                                    aria-hidden="true"
                                    data-tone={b.myDue > 0 ? "owed" : b.status === "settled" ? "verified" : b.status === "cancelled" ? "muted" : undefined}
                                >
                                    <Icon name="receipt" size={20} />
                                </span>
                                <span className="list-main">
                                    <span className="list-title">{b.title}</span>
                                    <span className="list-sub">
                                        {b.role === "creator" ? "You created" : "You're in"} · {b.paidCount} of {b.participantCount} paid or covered · {timeAgo(b.createdAt)}
                                    </span>
                                </span>
                                <span className="list-end">
                                    {b.myDue > 0 ? (
                                        <>
                                            <Money value={b.myDue} strong />
                                            <Badge tone="owed">You owe</Badge>
                                        </>
                                    ) : (
                                        <>
                                            <Money value={b.total} />
                                            <BillStatus status={b.status} />
                                        </>
                                    )}
                                </span>
                            </Link>
                            {hasActions && (
                                <div className="list-actions">
                                    {canPay && (
                                        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setPaying(b)}>
                                            Pay<span className="sr-only"> your share of {b.title}</span>
                                        </button>
                                    )}
                                    {canRemind && (
                                        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void remind(b)}>
                                            <Icon name="bell" size={16} />
                                            {busy === `remind:${b.id}` ? "Sending…" : "Remind"}
                                            <span className="sr-only"> unpaid people on {b.title}</span>
                                        </button>
                                    )}
                                    {canCancel && (
                                        <button
                                            type="button"
                                            className="btn btn-danger btn-sm"
                                            disabled={!!busy}
                                            onClick={() => {
                                                setCancelError(null)
                                                setCancelling(b)
                                            }}
                                        >
                                            Cancel<span className="sr-only"> {b.title}</span>
                                        </button>
                                    )}
                                </div>
                            )}
                        </li>
                    )
                })}
            </ul>

            <Modal open={!!paying} onClose={closePay} title="Pay your share">
                {paying?.myParticipantId && (
                    <>
                        <p className="muted">{paying.title}</p>
                        <Suspense fallback={<Loading />}>
                            <PayShare
                                kind="bill"
                                id={paying.myParticipantId}
                                onPaid={() => {
                                    paid.current = true
                                }}
                            />
                        </Suspense>
                    </>
                )}
            </Modal>

            <Modal
                open={!!cancelling}
                onClose={() => setCancelling(null)}
                title={cancelling ? `Cancel "${cancelling.title}"?` : "Cancel this bill?"}
                size="sm"
                dismissible={!busy?.startsWith("cancel:")}
            >
                <p>Nobody will be able to pay it, and it shows as cancelled for everyone on it. This can't be undone.</p>
                <div className="row">
                    <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void cancel()}>
                        {busy?.startsWith("cancel:") ? "Cancelling…" : "Cancel bill"}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setCancelling(null)}>
                        Keep it
                    </button>
                </div>
                {cancelError && (
                    <p className="error-text" role="alert">
                        {cancelError}
                    </p>
                )}
            </Modal>
        </>
    )
}

export function BillStatus({ status }: { status: BillSummary["status"] }) {
    if (status === "settled") return <Badge tone="verified">Settled</Badge>
    if (status === "cancelled") return <Badge tone="neutral">Cancelled</Badge>
    return <Badge tone="info">Open</Badge>
}
