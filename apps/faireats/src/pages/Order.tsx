import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { erc20Abi } from "@fairpay/sdk"
import { api, ApiError, usdc, type Order, type Share } from "../api"
import { DEMO, REAL_POOL_URL } from "../components/demo"
import { friendly } from "../components/errors"
import { PayProgress, type PayKind } from "../components/PayProgress"
import { RoundTable, RoundTableLegend } from "../components/RoundTable"
import {
    forgetPending,
    payShareInPrivate,
    payShareInPublic,
    pendingPayment,
    reconcileNotes,
    retryPending,
    subscribeNotes,
    topUp,
    unspentNotes
} from "../payments"
import { useWallet } from "../wallet"

type CardState = "idle" | "busy" | "pending"

export function OrderPage() {
    const { id = "" } = useParams()
    const [params] = useSearchParams()
    const { cfg } = useWallet()
    const [order, setOrder] = useState<Order | null>(null)
    const [error, setError] = useState<{ status: number; message: string } | null>(null)
    const [announcement, setAnnouncement] = useState("")
    const [myState, setMyState] = useState<CardState>("idle")
    const skew = useRef(0)
    const latest = useRef(0)
    const notes = useNoteCount()

    const guestParam = params.get("guest")
    const asked = guestParam !== null && /^[1-9][0-9]?$/.test(guestParam) ? Number(guestParam) : undefined
    const me = asked !== undefined && order?.shares.some((s) => s.guest === asked) ? asked : undefined

    // Polls and payments both deliver orders; only the newest response may replace the state.
    const accept = useCallback((o: Order) => {
        if (o.serverTime < latest.current) return
        latest.current = o.serverTime
        skew.current = o.serverTime - Date.now()
        setOrder(o)
    }, [])

    const load = useCallback(async () => {
        try {
            const o = await api.order(id)
            accept(o)
            setError(null)
            return o
        } catch (e) {
            setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message })
            return null
        }
    }, [id, accept])

    const served = order?.status === "served"
    useEffect(() => {
        void load()
        if (served) return
        const t = setInterval(load, 3000)
        return () => clearInterval(t)
    }, [load, served])

    // Tell screen reader users when the order moves on, without reading the countdown every second.
    const seen = useRef<string | null>(null)
    useEffect(() => {
        if (!order) return
        const paid = order.shares.filter((s) => s.status === "verified").length
        const key = `${order.status}:${paid}`
        if (seen.current !== null && seen.current !== key) setAnnouncement(describeProgress(order))
        seen.current = key
    }, [order])

    if (!order)
        return (
            <main className="wrap page" id="main">
                {error ? (
                    <>
                        <h1>{error.status === 404 ? "We can't find that order" : "We can't load your order"}</h1>
                        <p className="error" role="alert">
                            {error.message}
                        </p>
                        {error.status === 404 ? (
                            <Link to="/">Back to the menu</Link>
                        ) : (
                            <div className="actions">
                                <button className="btn quiet" onClick={() => void load()}>
                                    Try again
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <p className="empty" role="status">
                        Loading your order…
                    </p>
                )}
            </main>
        )

    const shares = me ? [...order.shares].sort((a, b) => (a.guest === me ? -1 : b.guest === me ? 1 : a.guest - b.guest)) : order.shares
    const myShare = me !== undefined ? order.shares.find((s) => s.guest === me) : undefined
    const showPayBar = !!myShare && myShare.status !== "verified" && myState === "idle" && order.status === "awaiting_payment"

    // Focusing the card's first button scrolls it into view, clear of the sticky bars.
    const goToMyShare = (e: MouseEvent<HTMLAnchorElement>) => {
        if (!myShare) return
        const button = document.getElementById(`card-${myShare.id}`)?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        if (!button) return
        e.preventDefault()
        button.focus()
    }

    return (
        <main className="wrap order-page" id="main" data-paybar={showPayBar}>
            <p className="sr-only" aria-live="polite">
                {announcement}
            </p>
            <section className="order-hero">
                <div className="table-col">
                    <RoundTable shares={order.shares} table={order.table} highlight={me} />
                    <RoundTableLegend />
                </div>
                <div>
                    {me ? (
                        <p className="you-are">
                            You are guest {me} at table {order.table}
                        </p>
                    ) : (
                        asked !== undefined && (
                            <p className="you-are unknown">
                                This link is for guest {asked}, but table {order.table} has {order.shares.length}{" "}
                                {order.shares.length === 1 ? "guest" : "guests"}.
                            </p>
                        )
                    )}
                    <StatusHeadline order={order} skew={skew.current} onAnnounce={setAnnouncement} />
                    <Steps status={order.status} />
                    <p className={error ? "hint offline" : "sr-only"} role="status">
                        {error ? "Connection lost. Retrying every 3 seconds." : ""}
                    </p>
                    {order.status === "awaiting_payment" && <ShareLink orderId={order.id} guests={order.shares.map((s) => s.guest)} />}
                </div>
            </section>
            <section className="shares" aria-label="Who pays what">
                {shares.map((s) => (
                    <ShareCard
                        key={s.id}
                        share={s}
                        order={order}
                        mine={s.guest === me}
                        notes={notes}
                        onOrder={accept}
                        onState={s.guest === me ? setMyState : undefined}
                        reload={load}
                        denomination={Number(cfg.denomination)}
                    />
                ))}
            </section>
            {showPayBar && myShare && (
                <div className="mobile-bar pay-bar">
                    <span>You pay {usdc(myShare.amount - myShare.paid)}</span>
                    <a className="btn small" href={`#card-${myShare.id}`} onClick={goToMyShare}>
                        Pay my share
                    </a>
                </div>
            )}
        </main>
    )
}

function describeProgress(order: Order) {
    const open = order.shares.filter((s) => s.status !== "verified").length
    if (order.status === "awaiting_payment")
        return open === 1 ? "A payment was confirmed. One guest left to pay." : `${open} guests left to pay.`
    if (order.status === "paid") return "Paid in full. The order is with the kitchen."
    if (order.status === "cooking") return "The kitchen started cooking."
    if (order.status === "ready") return "Your order is ready."
    return "Your order was served."
}

/** Unspent notes on this device, kept current across tabs and after every payment. */
function useNoteCount() {
    const { deployment, publicClient } = useWallet()
    const [count, setCount] = useState(() => unspentNotes(deployment).length)
    useEffect(() => {
        const update = () => setCount(unspentNotes(deployment).length)
        const off = subscribeNotes(deployment, update)
        void reconcileNotes(deployment, publicClient).then(update, () => undefined)
        return off
    }, [deployment, publicClient])
    return count
}

/** Coarse countdown steps for screen readers: announced only when the step changes. */
function timeBucket(seconds: number) {
    if (seconds > 60) return `About ${Math.ceil(seconds / 60)} minutes left`
    if (seconds > 30) return "About 1 minute left"
    if (seconds > 10) return "30 seconds left"
    if (seconds > 0) return "10 seconds left"
    return "Ready"
}

function StatusHeadline({ order, skew, onAnnounce }: { order: Order; skew: number; onAnnounce: (text: string) => void }) {
    const [, tick] = useState(0)
    useEffect(() => {
        if (order.status !== "cooking") return
        const t = setInterval(() => tick((n) => n + 1), 250)
        return () => clearInterval(t)
    }, [order.status])

    const cooking = order.status === "cooking"
    const s = cooking ? Math.ceil(Math.max(0, (order.readyAt ?? 0) - (Date.now() + skew)) / 1000) : 0
    const bucket = cooking ? timeBucket(s) : null
    const lastBucket = useRef<string | null>(null)
    useEffect(() => {
        // The first bucket is skipped: the page already says "The kitchen started cooking."
        if (bucket && lastBucket.current && bucket !== lastBucket.current) onAnnounce(bucket)
        lastBucket.current = bucket
    }, [bucket, onAnnounce])

    const open = order.shares.filter((x) => x.status !== "verified").length
    if (order.status === "awaiting_payment")
        return (
            <>
                <h1>{open === 1 ? "One guest left to pay" : `${open} guests left to pay`}</h1>
                <p className="status-line">
                    The kitchen starts once every share is confirmed on-chain. Each guest pays from their own phone.
                </p>
            </>
        )
    if (order.status === "paid")
        return (
            <>
                <h1>Paid in full</h1>
                <p className="status-line">Your order is with the kitchen and will be started shortly.</p>
            </>
        )
    if (cooking)
        return (
            <>
                <h1 className="sr-only">Cooking</h1>
                <p className="countdown" aria-hidden="true">
                    {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
                </p>
                <p className="status-line">
                    {DEMO
                        ? "Cooking now. The demo shortens the timer to 20 seconds."
                        : `Cooking now. We'll bring it to table ${order.table}.`}
                </p>
            </>
        )
    return (
        <>
            <h1>{order.status === "served" ? "Served. Enjoy." : "Ready. It's on its way."}</h1>
            <p className="status-line">
                {DEMO
                    ? "Every share was verified before the kitchen started. In this demo the checks are simulated."
                    : "Every share was verified on Monad before the kitchen started."}
            </p>
        </>
    )
}

function Steps({ status }: { status: Order["status"] }) {
    const order = ["awaiting_payment", "paid", "cooking", "ready"] as const
    const at = status === "served" ? 4 : order.indexOf(status)
    const labels = ["Paying", "Paid", "Cooking", "Ready"]
    return (
        <ol className="steps" aria-label="Order progress">
            {labels.map((l, i) => (
                <li key={l} data-state={i < at ? "done" : i === at ? "now" : "next"} aria-current={i === at ? "step" : undefined}>
                    {i < at && <span aria-hidden="true">✓ </span>}
                    {l}
                    {i < at && <span className="sr-only"> (done)</span>}
                </li>
            ))}
        </ol>
    )
}

function ShareLink({ orderId, guests }: { orderId: string; guests: number[] }) {
    const [copied, setCopied] = useState<number | null>(null)
    const [manual, setManual] = useState<{ guest: number; url: string } | null>(null)
    const manualInput = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (manual) manualInput.current?.select()
    }, [manual])
    if (guests.length < 2) return null
    const copy = async (g: number) => {
        // BASE_URL keeps the link right when the app is served from a sub-path such as /app/.
        const url = new URL(`${import.meta.env.BASE_URL}order/${encodeURIComponent(orderId)}?guest=${g}`, location.origin).href
        try {
            await navigator.clipboard.writeText(url)
            setManual(null)
            setCopied(g)
            setTimeout(() => setCopied(null), 1800)
        } catch {
            setManual({ guest: g, url })
        }
    }
    return (
        <div className="share-link">
            <span className="hint">Send each guest their own link:</span>
            <div className="actions">
                {guests.map((g) => (
                    <button key={g} className="btn small quiet" onClick={() => copy(g)}>
                        {copied === g ? "Link copied" : `Copy guest ${g}'s link`}
                    </button>
                ))}
            </div>
            {manual && (
                <div className="manual-link">
                    <label htmlFor="manual-link">Link for guest {manual.guest}</label>
                    <input id="manual-link" ref={manualInput} readOnly value={manual.url} onFocus={(e) => e.currentTarget.select()} />
                    <span className="hint">Copying didn't work here. Select the link and copy it yourself.</span>
                </div>
            )}
            <span className="sr-only" role="status">
                {copied ? `Link for guest ${copied} copied` : ""}
            </span>
        </div>
    )
}

type CardProps = {
    share: Share
    order: Order
    mine: boolean
    notes: number
    denomination: number
    onOrder: (o: Order) => void
    onState?: (s: CardState) => void
    reload: () => Promise<Order | null>
}

function ShareCard({ share, order, mine, notes, denomination, onOrder, onState, reload }: CardProps) {
    const { cfg, deployment, publicClient, wallet, chooseDemoWallet, refreshBalances } = useWallet()
    const [busy, setBusy] = useState<string | null>(null)
    const [kind, setKind] = useState<PayKind>("other")
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [pending, setPending] = useState(() => pendingPayment(deployment, share.id))
    const inFlight = useRef(false)
    const publicButton = useRef<HTMLButtonElement>(null)
    const remaining = share.amount - share.paid
    const needed = Math.ceil(remaining / denomination)
    const missing = Math.max(0, needed - notes)
    const items = order.items.filter((i) => i.guest === share.guest)
    const verified = share.status === "verified"
    const allPrivate = share.payments.length > 0 && share.payments.every((p) => p.kind === "private")
    const anyPrivate = share.payments.some((p) => p.kind === "private")

    useEffect(() => {
        onState?.(busy ? "busy" : pending ? "pending" : "idle")
    }, [onState, busy, pending])

    const run = useCallback(
        async (k: PayKind, fn: (step: (s: string) => void) => Promise<unknown>) => {
            // A ref, not state: two quick taps arrive before React re-renders the disabled button.
            if (inFlight.current) return
            inFlight.current = true
            setError(null)
            setNotice(null)
            setKind(k)
            setBusy("Starting…")
            try {
                await fn(setBusy)
            } catch (e) {
                setError(friendly(e))
            } finally {
                inFlight.current = false
                setBusy(null)
                setPending(pendingPayment(deployment, share.id))
                void refreshBalances().catch(() => undefined)
                void reload()
            }
        },
        [deployment, share.id, refreshBalances, reload]
    )

    /** Re-reads the share right before paying, so nobody pays an amount that is already covered. */
    const freshShare = async () => {
        const o = await api.order(order.id)
        onOrder(o)
        const s = o.shares.find((x) => x.id === share.id)
        if (!s || s.status === "verified") throw new Error("This share is already paid.")
        if (pendingPayment(deployment, share.id))
            throw new Error("A payment for this share is still confirming. Check it before paying again.")
        return s
    }

    const ensureFunds = async (w: NonNullable<typeof wallet>, amount: number, step: (s: string) => void) => {
        if (w.kind !== "demo") return
        // Read from the chain, not from cached state: a stale zero would ask the faucet again.
        const [bal, tok] = await Promise.all([
            publicClient.getBalance({ address: w.address }),
            publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [w.address] })
        ])
        if (bal < 8n * 10n ** 16n || tok < BigInt(amount)) {
            step("Getting test USDC for your demo wallet…")
            await api.faucet(w.address)
        }
    }

    const payPublic = () =>
        run("public", async (step) => {
            const s = await freshShare()
            const w = wallet ?? chooseDemoWallet()
            await ensureFunds(w, s.amount - s.paid, step)
            const r = await payShareInPublic(deployment, w.clients, cfg.merchant, s, step)
            if (r.order) onOrder(r.order)
        })

    const addNotes = () =>
        run("other", async (step) => {
            const w = wallet ?? chooseDemoWallet()
            const add = needed - notes
            if (add <= 0) return
            await ensureFunds(w, add * denomination, step)
            await topUp(deployment, w.clients, add, step)
            setNotice("Added. For the most privacy, pay later, after other guests add notes.")
        })

    const payPrivate = () =>
        run("private", async (step) => {
            const s = await freshShare()
            const r = await payShareInPrivate(
                { ...deployment, denomination: BigInt(cfg.denomination) },
                publicClient,
                cfg.merchant,
                s,
                step
            )
            if (r.order) onOrder(r.order)
        })

    const checkAgain = useCallback(
        () =>
            run("other", async (step) => {
                step("Checking the payment on-chain…")
                const r = await retryPending(deployment, share.id)
                if (r?.order) onOrder(r.order)
            }),
        [run, deployment, share.id, onOrder]
    )

    // A payment sent before a reload or a dropped connection is checked again automatically, once.
    const autoChecked = useRef(false)
    useEffect(() => {
        if (verified) {
            if (pendingPayment(deployment, share.id)) forgetPending(deployment, share.id)
            setPending(undefined)
            return
        }
        if (pending && !autoChecked.current) {
            autoChecked.current = true
            void checkAgain()
        }
    }, [verified, pending, deployment, share.id, checkAgain])

    const stopWaiting = () => {
        forgetPending(deployment, share.id)
        setPending(undefined)
        setError(null)
    }

    const open = order.shares.filter((s) => s.status !== "verified").length
    const nextLine =
        open > 0
            ? `${open} ${open === 1 ? "guest" : "guests"} left to pay. The kitchen starts when every share is in.`
            : "Everyone has paid. The kitchen has your order."

    const headingId = `share-${share.id}`
    const plural = (n: number) => (n === 1 ? "note" : "notes")
    return (
        <article className="share" id={`card-${share.id}`} data-mine={mine} aria-labelledby={headingId}>
            <header>
                <h2 id={headingId}>{mine ? `You · guest ${share.guest}` : `Guest ${share.guest}`}</h2>
                <span className="amount">{usdc(share.amount)}</span>
            </header>
            <ul className="share-items">
                {items.map((i) => (
                    <li key={i.id}>
                        {i.qty} × {i.name}
                    </li>
                ))}
            </ul>

            {/* Always mounted, so screen readers hear every step change. Shows the post-action notice visibly. */}
            <p role="status" className={!busy && notice ? "notice" : "sr-only"}>
                {busy ?? notice ?? ""}
            </p>

            {verified ? (
                <div className="paid-block">
                    <span className={`badge ${allPrivate ? "private" : "verified"}`}>
                        <span aria-hidden="true">{allPrivate ? "●" : "✓"}</span>
                        {allPrivate ? "Paid privately" : "Paid"} · {DEMO ? "verified (simulated)" : "verified on-chain"}
                    </span>
                    <dl className="receipt">
                        <dt>Paid</dt>
                        <dd>{usdc(share.amount)}</dd>
                        <dt>For</dt>
                        <dd>{items.map((i) => `${i.qty} × ${i.name}`).join(", ") || "Nothing listed"}</dd>
                        <dt>How</dt>
                        <dd>{allPrivate ? "Private" : anyPrivate ? "Public and private" : "Public"}</dd>
                        <dt>Receipt</dt>
                        <dd>
                            {DEMO ? (
                                <SimulatedReceipt
                                    share={share}
                                    privately={allPrivate}
                                    payer={wallet?.address}
                                    denomination={denomination}
                                />
                            ) : (
                                share.payments.map((p, i) => (
                                    <span key={p.txHash}>
                                        {i > 0 ? ", " : ""}
                                        <a href={`${cfg.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer">
                                            {share.payments.length > 1 ? `Transaction ${i + 1}` : "View on the Monad explorer"}
                                            <span className="sr-only"> (opens in a new tab)</span>
                                        </a>
                                    </span>
                                ))
                            )}
                        </dd>
                    </dl>
                    {allPrivate && (
                        <p className="private-note">
                            {mine ? "Your wallet isn't in this payment." : "The payer's wallet isn't in this payment."} Open the receipt:
                            the sender is the restaurant's relayer{mine ? ", not you" : ""}.
                        </p>
                    )}
                    <p className="hint">{nextLine}</p>
                    {DEMO && (
                        <div className="actions">
                            <Link className="btn small quiet" to="/kitchen">
                                Open the kitchen screen
                            </Link>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    {share.status === "executed" && (
                        <span className="badge partial">
                            {usdc(share.paid)} paid, {usdc(remaining)} to go
                        </span>
                    )}
                    {busy ? (
                        <PayProgress kind={kind} step={busy} />
                    ) : pending ? (
                        <div className="pending">
                            <p>
                                <strong>Payment sent but not confirmed yet.</strong> Check again before paying a second time.{" "}
                                <a href={`${cfg.explorer}/tx/${pending.txHash}`} target="_blank" rel="noreferrer">
                                    See it on the explorer<span className="sr-only"> (opens in a new tab)</span>
                                </a>
                            </p>
                            <div className="actions">
                                <button className="btn" onClick={checkAgain}>
                                    Check again
                                </button>
                                <button className="linkish" onClick={stopWaiting}>
                                    It failed, let me pay again
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="pay-actions">
                            <button ref={publicButton} className="btn pay" onClick={payPublic}>
                                Pay {usdc(remaining)} publicly
                            </button>
                            <div className="private-zone">
                                <h3>
                                    <LockIcon />
                                    Pay privately
                                </h3>
                                {missing === 0 ? (
                                    <>
                                        <p>
                                            Uses {needed} prepaid {plural(needed)} of {usdc(denomination)}. You have {notes}.
                                        </p>
                                        <p>The restaurant sees your share is paid, not which wallet paid it.</p>
                                        <button className="btn private pay" onClick={payPrivate}>
                                            Pay {usdc(remaining)} privately
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <p>
                                            You need {needed} {plural(needed)} and have {notes}. Adding notes is public. If you add them and
                                            pay straight away, the two are easy to link.
                                        </p>
                                        <div className="actions">
                                            <button className="btn quiet" onClick={addNotes}>
                                                Add {missing} {plural(missing)} (public)
                                            </button>
                                            <button className="linkish" onClick={() => publicButton.current?.focus()}>
                                                Pay publicly instead
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                    {error && (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    )}
                </>
            )}
        </article>
    )
}

function LockIcon() {
    return (
        <svg className="lock-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor" />
            <path d="M 5 7 V 5 a 3 3 0 0 1 6 0 V 7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    )
}

/** Demo mode only: simulated hashes never become explorer links. One real payment is linked instead. */
function SimulatedReceipt({
    share,
    privately,
    payer,
    denomination
}: {
    share: Share
    privately: boolean
    payer?: string
    denomination: number
}) {
    const id = share.payments[0]?.txHash.slice(2, 6) ?? "0000"
    const from = payer ? `Demo wallet ${payer.slice(0, 6)}…${payer.slice(-5)}` : "Demo wallet"
    return (
        <details className="sim-receipt">
            <summary>
                Simulated receipt <span className="mono">demo·{id}</span>
            </summary>
            {privately ? (
                <ul>
                    <li>From: the restaurant's relayer</li>
                    <li>Payer in the event: the privacy pool</li>
                    <li>To: Saffron Table</li>
                    <li>
                        {usdc(denomination)} × {share.payments.length}
                    </li>
                    <li>Your wallet: not in this payment</li>
                </ul>
            ) : (
                <ul>
                    <li>From: {from}</li>
                    <li>To: Saffron Table</li>
                    <li>{usdc(share.payments.reduce((sum, p) => sum + p.amount, 0) || share.amount)}</li>
                    <li>Event: PaymentReceived</li>
                </ul>
            )}
            <p>
                Simulated. In the real app this links to the Monad explorer.{" "}
                <a href={REAL_POOL_URL} target="_blank" rel="noreferrer">
                    See the real privacy pool and its payments<span className="sr-only"> (opens in a new tab)</span>
                </a>
            </p>
        </details>
    )
}
