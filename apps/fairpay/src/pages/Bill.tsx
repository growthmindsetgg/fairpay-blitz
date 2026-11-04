import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import type { Bill, BillParticipant } from "../../shared/types"
import { Badge } from "../components/Badge"
import { CopyLink } from "../components/CopyLink"
import { friendly } from "../components/errors"
import { Icon } from "../components/Icon"
import { Modal } from "../components/Modal"
import { Address, Money } from "../components/Money"
import { ErrorNote, Loading, PageHeader, useTitle } from "../components/Page"
import { PayShare } from "../components/PayShare"
import { api, ApiError } from "../lib/api"
import { dateTime, isTxHash, plural, shortHex, timeAgo } from "../lib/format"
import { sameWallet, useWallet } from "../lib/wallet"

/** The share token from a share URL like https://host/b/<token>. */
function tokenFromUrl(url: string | null): string | null {
    if (!url) return null
    const m = url.match(/\/b\/([^/?#]+)/)
    return m ? decodeURIComponent(m[1]!) : null
}

export function BillPage() {
    const { id, token: routeToken } = useParams()
    const location = useLocation()
    const { me, meLoading, requestConnect, cfg } = useWallet()
    const [bill, setBill] = useState<Bill | null>(null)
    const [error, setError] = useState<{ text: string; status: number } | null>(null)
    const [action, setAction] = useState<{ text: string; error?: boolean } | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [confirmCancel, setConfirmCancel] = useState(false)
    const created = (location.state as { created?: boolean } | null)?.created === true
    useTitle(bill?.title ?? "Bill")

    const load = useCallback(async () => {
        setError(null)
        try {
            const b = routeToken ? await api.billByToken(routeToken) : await api.bill(id!)
            setBill(b)
        } catch (e) {
            setError({ text: friendly(e), status: e instanceof ApiError ? e.status : 0 })
        }
    }, [id, routeToken])

    // Reload when the session changes: signing in can reveal the viewer's own seat.
    useEffect(() => {
        if (!meLoading) void load()
    }, [load, meLoading, me?.profile.wallet])

    if (error)
        return (
            <div className="content">
                {/* By id, the server answers "not yours" with the same 404 as "doesn't exist". */}
                {error.status === 401 || error.status === 403 || (error.status === 404 && !routeToken) ? (
                    <div className="notfound">
                        <h1 className="page-title">You can't see this bill yet</h1>
                        <p className="muted">
                            Bills are visible to the person who created them and the people on them. If someone sent you a link, open that link. Or
                            sign in with the wallet you were added with.
                        </p>
                        {!me && (
                            <button type="button" className="btn btn-primary" onClick={() => void requestConnect({ signIn: true })}>
                                Sign in with a wallet
                            </button>
                        )}
                    </div>
                ) : (
                    <ErrorNote title="We couldn't load this bill" message={error.text} onRetry={() => void load()} />
                )}
            </div>
        )
    if (!bill)
        return (
            <div className="content">
                <Loading label="Loading the bill…" />
            </div>
        )

    const token = routeToken ?? tokenFromUrl(bill.shareUrl)
    const isCreator = !!me && sameWallet(me.profile.wallet, bill.creator)
    const mine = bill.participants.find((p) => p.id === bill.myParticipantId) ?? null
    const settledCount = bill.participants.filter((p) => p.status !== "owed").length
    // Same rule as the server: any money received in FairPay, even part of a share, blocks cancelling.
    const paidInApp = bill.participants.some((p) => p.paid > 0)
    const collected = bill.participants.reduce((s, p) => s + (p.status === "owed" ? p.paid : p.amount + p.tip), 0)
    const pct = bill.total > 0 ? Math.min(100, Math.round((collected / bill.total) * 100)) : 0
    const open = bill.status === "open"

    const run = async (label: string, fn: () => Promise<string | void>) => {
        setBusy(label)
        setAction(null)
        try {
            const r = await fn()
            if (r) setAction({ text: r })
        } catch (e) {
            setAction({ text: friendly(e), error: true })
        } finally {
            setBusy(null)
        }
    }

    const claim = (p: BillParticipant) =>
        run("Claiming…", async () => {
            if (!me) {
                const w = await requestConnect({ signIn: true, reason: `Sign in to take ${p.displayName}'s seat on this bill.` })
                if (!w) return
            }
            if (!token) throw new Error("This page needs the bill's share link to claim a seat. Open the link you were sent.")
            const b = await api.claimSeat(bill.id, p.id, token)
            setBill(b)
            return `You're now ${p.displayName} on this bill.`
        })

    // Someone took the wrong seat (or was added with the wrong wallet): the name stays, and anyone
    // with the link can claim it again. The server refuses once anything was paid towards it.
    const release = (p: BillParticipant) =>
        run("Freeing the seat…", async () => {
            const b = await api.releaseSeat(bill.id, p.id)
            setBill(b)
            return `${p.displayName}'s seat is free again. Anyone with the link can claim it.`
        })

    const remind = () =>
        run("Sending reminders…", async () => {
            const r = await api.remindBill(bill.id)
            const n = r?.reminded ?? 0
            if (n > 0) return `Reminded ${plural(n, "person", "people")}. They'll see it in their activity.`
            // Reminders go to activity feeds, so people who haven't claimed a seat can't get one.
            const unclaimed = bill.participants.filter((p) => p.status === "owed" && !p.wallet).length
            return unclaimed > 0
                ? `Nobody to remind yet: ${plural(unclaimed, "person hasn't", "people haven't")} claimed a seat. Send them the link.`
                : "Everyone with a wallet has already paid."
        })

    const cancel = () =>
        run("Cancelling…", async () => {
            const b = await api.cancelBill(bill.id)
            setBill(b)
            setConfirmCancel(false)
            return "Bill cancelled. Nobody can pay it now."
        })

    return (
        <div className="content">
            <PageHeader
                back={
                    <Link to={me ? "/requests" : "/"}>
                        <Icon name="chevronLeft" size={14} /> {me ? "Requests" : "Home"}
                    </Link>
                }
                title={bill.title}
                description={
                    <>
                        {isCreator ? "You created this bill" : `Paid to ${bill.recipientName}`} · {timeAgo(bill.createdAt)}
                        {bill.source === "restaurant_order" && " · From a FairEats order"}
                    </>
                }
                status={bill.status === "settled" ? <Badge tone="verified">Settled</Badge> : bill.status === "cancelled" ? <Badge>Cancelled</Badge> : <Badge tone="info">Open</Badge>}
            />

            {created && isCreator && bill.shareUrl && open && (
                <div className="callout callout-verified" role="status">
                    <p>
                        <strong>Bill created.</strong> Send this link to everyone on it. They'll see their share and can pay it from their wallet.
                    </p>
                    <CopyLink url={bill.shareUrl} label="Link to this bill" />
                </div>
            )}
            {bill.status === "cancelled" && <p className="callout">This bill was cancelled. Nothing more can be paid on it.</p>}
            {bill.status === "settled" && (
                <p className="callout callout-verified">
                    Everyone's share is paid or covered{bill.settledAt ? ` as of ${dateTime(bill.settledAt)}` : ""}. Every in-app payment was verified on Monad.
                </p>
            )}

            <div className="bill-layout">
                <div className="stack">
                    <section className="card" aria-labelledby="total-h">
                        <h2 className="sr-only" id="total-h">
                            Total
                        </h2>
                        <div className="stack-sm">
                            <div className="bill-total">
                                <span className="bill-total-amount">
                                    <Money value={bill.total} />
                                </span>
                                <span className="muted">
                                    {settledCount} of {plural(bill.participants.length, "person", "people")} paid or covered
                                </span>
                            </div>
                            <div className="progress-bar" role="img" aria-label={`${pct}% collected`}>
                                <span style={{ width: `${pct}%` }} />
                            </div>
                            {bill.note && <p className="muted">{bill.note}</p>}
                            <p className="field-hint">
                                Paid to {bill.recipientName}
                                {!routeToken && bill.recipientName.toLowerCase() !== shortHex(bill.recipient).toLowerCase() && (
                                    <>
                                        {" "}
                                        <Address value={bill.recipient} href={`${cfg.explorer}/address/${bill.recipient}`} />
                                    </>
                                )}
                            </p>
                        </div>
                    </section>

                    <section className="card card-flush" aria-labelledby="people-h">
                        <div className="card-head">
                            <h2 className="card-title" id="people-h">
                                People
                            </h2>
                        </div>
                        <ul className="list">
                            {bill.participants.map((p) => {
                                const isMe = p.id === bill.myParticipantId
                                const isOrganiser = sameWallet(p.wallet, bill.creator)
                                return (
                                    <li key={p.id} className="list-row">
                                        <span className="person" data-me={isMe ? "" : undefined} aria-hidden="true">
                                            {p.displayName.charAt(0).toUpperCase()}
                                        </span>
                                        <span className="list-main">
                                            <span className="list-title">
                                                {p.displayName}
                                                {isMe && <span className="muted"> (you)</span>}
                                            </span>
                                            <span className="list-sub">
                                                {p.wallet ? <Address value={p.wallet} /> : p.claimable ? "Seat not claimed yet" : routeToken ? "" : "Name only"}
                                                {p.paidAt && p.status === "paid" ? ` · ${timeAgo(p.paidAt)}` : ""}
                                                {p.status === "paid" && !p.paidPrivately && isTxHash(p.txHash) && (
                                                    <>
                                                        {" · "}
                                                        <a href={`${cfg.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer" title={p.txHash}>
                                                            View payment<span className="sr-only"> by {p.displayName} on the Monad explorer (opens in a new tab)</span>
                                                        </a>
                                                    </>
                                                )}
                                            </span>
                                            {p.claimable && open && !isMe && !mine && (
                                                <span>
                                                    <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void claim(p)}>
                                                        {me ? "This is me, claim this seat" : "This is me, sign in to claim"}
                                                    </button>
                                                </span>
                                            )}
                                            {isCreator && p.wallet && !isOrganiser && p.paid === 0 && (
                                                <span>
                                                    <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void release(p)}>
                                                        Free this seat<span className="sr-only"> held by {p.displayName}</span>
                                                    </button>
                                                </span>
                                            )}
                                        </span>
                                        <span className="list-end">
                                            <Money value={p.amount + p.tip} />
                                            <ParticipantStatus p={p} organiser={isOrganiser} cancelled={bill.status === "cancelled"} />
                                        </span>
                                    </li>
                                )
                            })}
                        </ul>
                    </section>
                    <p className="field-hint">
                        "Paid" means FairPay found the payment on Monad. "Covered" means the organiser marked it settled outside FairPay. "Paid
                        confidentially" shows no payer details.
                    </p>
                </div>

                <aside className="bill-side stack">
                    {mine && mine.status === "owed" && open && (
                        <section className="card" aria-labelledby="pay-h">
                            <div className="card-head">
                                <h2 className="card-title" id="pay-h">
                                    Your share
                                </h2>
                            </div>
                            <PayShare kind="bill" id={mine.id} token={token} onPaid={() => void load()} />
                            <p className="field-hint mt-3">Shares between friends are paid publicly. Confidential payments are for verified businesses today.</p>
                        </section>
                    )}
                    {mine && mine.status !== "owed" && (
                        <section className="card">
                            <p className="success-text">
                                <Icon name="check" size={18} />
                                {mine.status === "covered" ? "Your part is covered." : mine.paidPrivately ? "You paid confidentially." : "You've paid your share."}
                            </p>
                        </section>
                    )}
                    {/* Shown even when seats are claimable: someone added by wallet has no seat to claim. */}
                    {!me && !meLoading && !mine && open && (
                        <section className="card stack-sm">
                            <p className="muted">
                                Are you on this bill? Sign in with the wallet you were added with to see and pay your share.
                                {bill.participants.some((p) => p.claimable) && " Added by name only? Use “This is me” next to your name."}
                            </p>
                            <button type="button" className="btn btn-primary" onClick={() => void requestConnect({ signIn: true })}>
                                Sign in with a wallet
                            </button>
                        </section>
                    )}

                    {/* Everything in Manage needs an open bill; a settled or cancelled one would show an empty card. */}
                    {isCreator && open && (
                        <section className="card" aria-labelledby="manage-h">
                            <div className="card-head">
                                <h2 className="card-title" id="manage-h">
                                    Manage
                                </h2>
                            </div>
                            <div className="stack">
                                {bill.shareUrl && open && <CopyLink url={bill.shareUrl} label="Share link" hint="Anyone with this link can see names and amounts, not wallet addresses." />}
                                {open && (
                                    <div className="row">
                                        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void remind()}>
                                            <Icon name="bell" size={16} />
                                            {busy === "Sending reminders…" ? busy : "Remind unpaid"}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-danger btn-sm"
                                            disabled={!!busy || paidInApp}
                                            aria-describedby={paidInApp ? "cancel-why" : undefined}
                                            onClick={() => setConfirmCancel(true)}
                                        >
                                            Cancel bill
                                        </button>
                                    </div>
                                )}
                                {open && paidInApp && (
                                    <p className="field-hint" id="cancel-why">
                                        Someone has already paid in FairPay, so this bill can't be cancelled.
                                    </p>
                                )}
                            </div>
                        </section>
                    )}

                    <div aria-live="polite">
                        {action && (
                            <p className={action.error ? "error-text" : "success-text"} role={action.error ? "alert" : undefined}>
                                {action.text}
                            </p>
                        )}
                    </div>
                </aside>
            </div>

            <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this bill?" size="sm" dismissible={busy !== "Cancelling…"}>
                <p>Nobody will be able to pay it, and it shows as cancelled for everyone on it. This can't be undone.</p>
                <div className="row">
                    <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void cancel()}>
                        {busy === "Cancelling…" ? busy : "Cancel bill"}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmCancel(false)}>
                        Keep it
                    </button>
                </div>
                {action?.error && (
                    <p className="error-text" role="alert">
                        {action.text}
                    </p>
                )}
            </Modal>
        </div>
    )
}

function ParticipantStatus({ p, organiser, cancelled }: { p: BillParticipant; organiser: boolean; cancelled: boolean }) {
    if (p.status === "paid" && p.paidPrivately) return <Badge tone="private">Paid confidentially</Badge>
    if (p.status === "paid") return <Badge tone="verified">Paid</Badge>
    if (p.status === "covered") return <Badge>{organiser ? "Organiser" : "Covered"}</Badge>
    // A cancelled bill can't be paid, so nobody owes anything on it any more.
    if (cancelled) return <Badge>Not due</Badge>
    return <Badge tone="owed">Owes</Badge>
}
