import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import type { Order, OrderShare, Wallet } from "../../../shared/types"
import { Badge, CopyLink, PayShare } from "../../components"
import { useMe } from "../../lib/wallet"
import "../../styles/business.css"
import { ApiError, billIdFrom, errorText, fe } from "./client"
import { Alert, absoluteUrl, Avatar, istTime, isWallet, Loading, percent, plural, toPath, usdc, useNow, usePoll, waitText } from "./ui"

const STEPS: { key: Order["status"]; label: string; at: (o: Order) => number | null }[] = [
    { key: "awaiting_payment", label: "Order placed", at: (o) => o.createdAt },
    { key: "paid", label: "Paid", at: (o) => o.paidAt },
    { key: "cooking", label: "Cooking", at: (o) => o.cookingStartedAt },
    { key: "served", label: "Served", at: (o) => o.servedAt }
]
// Paid -> Cooking -> Served. A 'ready' order is served on the server's next update, so it shows as cooking.
const RANK: Record<Order["status"], number> = { awaiting_payment: 0, paid: 1, cooking: 2, ready: 2, served: 3, cancelled: -1 }

/** "2 guests · one person pays": the guest count alone reads oddly next to a single share. */
function partyText(o: Order) {
    const guests = plural(o.guests, "guest")
    if (o.paymentMode === "one_pays" || o.shares.length <= 1) return o.guests > 1 ? `${guests} · one person pays` : guests
    return `${guests} · split ${o.shares.length} ways`
}

function headline(o: Order) {
    const owed = o.shares.filter((s) => s.status !== "paid").length
    switch (o.status) {
        case "awaiting_payment":
            return o.paymentMode === "one_pays" || o.shares.length === 1
                ? "Waiting for payment. The kitchen starts once the bill is paid."
                : `${plural(owed, "share")} left to pay. The kitchen starts when every share is paid.`
        case "paid":
            return "Paid. Your order is with the kitchen."
        case "cooking":
            return "The kitchen is cooking your order."
        case "ready":
            return "Your food is ready and on its way to the table."
        case "served":
            return "Served. Enjoy your meal."
        case "cancelled":
            return "This order was cancelled."
    }
}

export function OrderPage() {
    const { id = "" } = useParams()
    const [params] = useSearchParams()
    const token = params.get("t")
    const [order, setOrder] = useState<Order | null>(null)
    const [error, setError] = useState<{ status: number; message: string } | null>(null)
    const [offline, setOffline] = useState(false)
    const [announce, setAnnounce] = useState("")
    const [paying, setPaying] = useState<string | null>(null)
    const now = useNow(30_000)

    const load = useCallback(async () => {
        try {
            const o = await fe.order(id, token)
            setOrder(o)
            setError(null)
            setOffline(false)
        } catch (e) {
            const status = e instanceof ApiError ? e.status : 0
            if (status === 0) setOffline(true)
            else setError({ status, message: errorText(e) })
        }
    }, [id, token])
    const done = order?.status === "served" || order?.status === "cancelled"
    usePoll(load, 5000, !done)

    // Tell screen reader users when the order moves on.
    const seen = useRef<string | null>(null)
    useEffect(() => {
        if (!order) return
        const key = `${order.status}:${order.shares.filter((s) => s.status === "paid").length}`
        if (seen.current !== null && seen.current !== key) setAnnounce(headline(order))
        seen.current = key
        document.title = `Table ${order.table?.label ?? ""} · ${order.restaurant.name} · FairPay`
    }, [order])

    if (!order)
        return (
            <div className="fe fe-page fe-narrow">
                {error ? (
                    <div className="fe-state">
                        <h1>{error.status === 404 || error.status === 403 ? "We can't open this order" : "The order didn't load"}</h1>
                        <Alert>
                            {error.status === 404 || error.status === 403
                                ? "The link may be incomplete. Ask whoever placed the order to copy the order link again."
                                : error.message}
                        </Alert>
                        {error.status !== 404 && error.status !== 403 && (
                            <button className="btn btn-secondary" onClick={() => void load()}>
                                Try again
                            </button>
                        )}
                    </div>
                ) : offline ? (
                    <Alert>We can't reach FairPay. Retrying every 5 seconds.</Alert>
                ) : (
                    <Loading label="Loading your order…" />
                )}
            </div>
        )

    const o = order
    const rank = RANK[o.status]
    const orderLink = absoluteUrl(`/o/${o.id}${token ? `?t=${encodeURIComponent(token)}` : ""}`)
    const minutes = o.estReadyAt ? Math.max(0, Math.ceil((o.estReadyAt - now) / 60_000)) : o.waitMinutes
    const showWait = (o.status === "paid" || o.status === "cooking") && minutes !== null
    const expected = o.status === "awaiting_payment" ? (o.expectedWaitMinutes ?? null) : null
    const paidCount = o.shares.filter((s) => s.status === "paid").length
    const received = o.shares.reduce((sum, s) => sum + s.paid, 0)
    const cancelled = o.status === "cancelled"

    return (
        <div className="fe fe-page fe-order">
            <p className="sr-only" aria-live="polite">
                {announce}
            </p>
            <p className="fe-crumb">
                <Link to={`/r/${o.restaurant.slug}`}>{o.restaurant.name}</Link>
            </p>
            <header className="fe-order-head">
                <h1>
                    {o.table ? `Table ${o.table.label}` : "Your order"}
                    <span className="fe-order-sub"> · {partyText(o)}</span>
                </h1>
                <p className="fe-lead">{headline(o)}</p>
                {o.status === "awaiting_payment" && received === 0 && (
                    <p className="fe-hint">Unpaid orders are released after 15 minutes, which frees the table.</p>
                )}
                {offline && <p className="fe-hint">Connection lost. Retrying every 5 seconds.</p>}
                {o.demo && (
                    <p className="fe-hint">Demo order: it came with the demo restaurant and was marked paid without any payment, so there's no transaction to show.</p>
                )}
            </header>

            {cancelled ? (
                <div className="callout callout-warn fe-cancelled" role="status">
                    <p>
                        <strong>This order was cancelled.</strong> It can't be paid any more and the kitchen won't cook it.
                    </p>
                    {received === 0 ? (
                        <p>Unpaid orders are released after 15 minutes. Nothing was paid on this order. Place a new one to order again.</p>
                    ) : (
                        <p>{usdc(received)} was paid before it was cancelled. Ask the restaurant staff about a refund.</p>
                    )}
                    <Link to={`/r/${o.restaurant.slug}`} className="btn btn-secondary btn-sm">
                        Back to {o.restaurant.name}
                    </Link>
                </div>
            ) : (
                <ol className="fe-timeline" aria-label="Order progress">
                    {STEPS.map((s, i) => {
                        const state = i < rank || o.status === "served" ? "done" : i === rank ? "current" : "todo"
                        const at = s.at(o)
                        return (
                            <li key={s.key} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                                <span className="fe-tl-dot" aria-hidden="true" />
                                <span className="fe-tl-label">
                                    {s.key === "awaiting_payment" && rank === 0 ? "Awaiting payment" : s.label}
                                    <span className="sr-only">{state === "done" ? ", done" : state === "current" ? ", now" : ", not yet"}</span>
                                </span>
                                {at && state !== "todo" && <span className="fe-tl-time">{istTime(at)}</span>}
                            </li>
                        )
                    })}
                </ol>
            )}

            <div className="fe-order-grid">
                <div className="fe-stack">
                    {(showWait || o.chef || expected !== null) && (
                        <section className="fe-wait" aria-label="Kitchen">
                            {expected !== null && (
                                <div className="fe-wait-time">
                                    <span className="fe-label-sm">Expected wait</span>
                                    <strong className="fe-wait-big">About {plural(Math.max(1, expected), "minute")}</strong>
                                    <span className="fe-muted">once paid; the kitchen starts as soon as payment is verified</span>
                                </div>
                            )}
                            {showWait && (
                                <div className="fe-wait-time">
                                    <span className="fe-label-sm">Estimated wait</span>
                                    <strong className="fe-wait-big">{waitText(minutes ?? 0)}</strong>
                                    {o.estReadyAt && <span className="fe-muted">Served around {istTime(o.estReadyAt)}</span>}
                                </div>
                            )}
                            {o.chef && (
                                <div className="fe-wait-chef">
                                    <Avatar src={o.chef.photo} name={o.chef.name} size={56} />
                                    <div>
                                        <span className="fe-label-sm">{o.status === "paid" ? "In the kitchen" : "Cooking for you"}</span>
                                        <p className="fe-chef-name">{o.chef.name}</p>
                                        {(o.chef.title || o.chef.specialty) && (
                                            <p className="fe-muted">{[o.chef.title, o.chef.specialty && `known for ${o.chef.specialty}`].filter(Boolean).join(" · ")}</p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    <section className="fe-section fe-shares" aria-labelledby="fe-shares-h">
                        <div className="fe-row-between">
                            <h2 id="fe-shares-h" className="fe-h2">
                                {o.shares.length === 1 ? "Payment" : "Shares"}
                            </h2>
                            {o.shares.length > 1 && (
                                <p className="fe-muted fe-num">
                                    {paidCount} of {o.shares.length} paid
                                </p>
                            )}
                        </div>
                        {o.status === "awaiting_payment" && token && (
                            <CopyLink
                                url={orderLink}
                                label="Order link for the table"
                                hint={o.shares.length > 1 ? "Send it to the others so each person can pay their share from their own phone." : "Anyone with this link can see the order and pay."}
                            />
                        )}
                        <ul className="fe-share-list">
                            {o.shares.map((s) => (
                                <li key={s.id}>
                                    <ShareRow
                                        s={s}
                                        cancelled={cancelled}
                                        demo={o.demo === true}
                                        canPay={o.status === "awaiting_payment" && s.status !== "paid"}
                                        open={paying === s.id || (o.shares.length === 1 && o.status === "awaiting_payment")}
                                        onToggle={() => setPaying((p) => (p === s.id ? null : s.id))}
                                        payer={
                                            <PayShare
                                                kind="order"
                                                id={s.id}
                                                token={token}
                                                onPaid={() => {
                                                    setPaying(null)
                                                    void load()
                                                }}
                                            />
                                        }
                                    />
                                </li>
                            ))}
                        </ul>
                    </section>

                    {/* A demo order has no payer on record, so the server would refuse the split. */}
                    {o.paymentMode === "one_pays" && rank >= 1 && !o.demo && <SplitWithFriends order={o} token={token} onDone={load} />}
                </div>

                <aside className="fe-stack">
                    <section className="fe-receipt" aria-labelledby="fe-items-h">
                        <h2 id="fe-items-h" className="fe-h3">
                            What you ordered
                        </h2>
                        <ItemList o={o} />
                        <dl className="fe-sum">
                            <div>
                                <dt>Subtotal</dt>
                                <dd>{usdc(o.subtotal)}</dd>
                            </div>
                            {o.serviceCharge > 0 && (
                                <div>
                                    <dt>Service charge</dt>
                                    <dd>{usdc(o.serviceCharge)}</dd>
                                </div>
                            )}
                            {o.igst > 0 ? (
                                <div>
                                    <dt>IGST {percent(o.gstRateBps)}</dt>
                                    <dd>{usdc(o.igst)}</dd>
                                </div>
                            ) : o.cgst + o.sgst > 0 ? (
                                <>
                                    <div>
                                        <dt>CGST {percent(o.gstRateBps / 2)}</dt>
                                        <dd>{usdc(o.cgst)}</dd>
                                    </div>
                                    <div>
                                        <dt>SGST {percent(o.gstRateBps / 2)}</dt>
                                        <dd>{usdc(o.sgst)}</dd>
                                    </div>
                                </>
                            ) : (
                                <div className="fe-sum-note">
                                    <dt>GST</dt>
                                    <dd>Not charged</dd>
                                </div>
                            )}
                            {o.roundOff !== 0 && (
                                <div>
                                    <dt>Round off</dt>
                                    <dd>{usdc(o.roundOff)}</dd>
                                </div>
                            )}
                            <div className="fe-sum-total">
                                <dt>Total</dt>
                                <dd>{usdc(o.total)}</dd>
                            </div>
                        </dl>
                        {cancelled ? null : rank >= 1 ? (
                            <Link className="btn btn-secondary btn-block" to={toPath(o.invoiceUrl)}>
                                {o.invoiceNo ? `View invoice ${o.invoiceNo}` : "View invoice"}
                            </Link>
                        ) : (
                            <p className="fe-hint">The GST invoice is issued once the bill is fully paid.</p>
                        )}
                        <p className="fe-hint">Prices in test USDC on Monad Testnet.</p>
                    </section>
                </aside>
            </div>
        </div>
    )
}

function ShareRow({
    s,
    cancelled,
    demo,
    canPay,
    open,
    onToggle,
    payer
}: {
    s: OrderShare
    cancelled: boolean
    demo: boolean
    canPay: boolean
    open: boolean
    onToggle: () => void
    payer: ReactNode
}) {
    const due = s.amount + s.tip - s.paid
    return (
        <article className={`fe-share-row${s.status === "paid" ? " is-paid" : ""}`} aria-label={`${s.label}: ${s.status === "paid" ? (s.paidPrivately ? "paid privately" : "paid") : cancelled ? "not paid, order cancelled" : `owes ${usdc(due)}`}`}>
            <div className="fe-share-top">
                <span className="fe-share-label">{s.label}</span>
                <span className="fe-share-amt fe-num">
                    {usdc(s.amount)}
                    {s.tip > 0 && <span className="fe-tip"> + {usdc(s.tip)} tip</span>}
                </span>
                {s.status === "paid" ? (
                    s.paidPrivately ? (
                        <Badge tone="private">Paid confidentially</Badge>
                    ) : (
                        // "Paid" with the verified tone means FairPay checked it on-chain; a demo share wasn't.
                        demo ? (
                            <Badge>Marked paid</Badge>
                        ) : (
                            <Badge tone="verified">Paid</Badge>
                        )
                    )
                ) : canPay ? (
                    <button type="button" className="btn btn-primary btn-sm" aria-expanded={open} onClick={onToggle}>
                        {open ? "Hide" : `Pay ${usdc(due)}`}
                        <span className="sr-only"> for {s.label}</span>
                    </button>
                ) : cancelled ? (
                    <Badge tone="neutral">{s.paid > 0 ? `Partly paid · ${usdc(s.paid)}` : "Not paid"}</Badge>
                ) : (
                    <Badge tone="owed">Owes {usdc(due)}</Badge>
                )}
            </div>
            {s.status === "paid" && s.paidPrivately && (
                <p className="fe-hint">Paid through the privacy pool. The paying wallet isn't shown.</p>
            )}
            {canPay && open && <div className="fe-share-pay">{payer}</div>}
        </article>
    )
}

function ItemList({ o }: { o: Order }) {
    const split = o.paymentMode === "split" && o.guests > 1
    const merge = (list: Order["items"]) => {
        const m = new Map<string, { name: string; qty: number; amount: number }>()
        for (const i of list) {
            const k = `${i.itemId}:${i.unitPrice}`
            const hit = m.get(k)
            if (hit) {
                hit.qty += i.qty
                hit.amount += i.unitPrice * i.qty
            } else m.set(k, { name: i.name, qty: i.qty, amount: i.unitPrice * i.qty })
        }
        return [...m.values()]
    }
    const groups = split
        ? Array.from({ length: o.guests }, (_, g) => ({
              label: o.shares.find((s) => s.guest === g + 1)?.label ?? `Guest ${g + 1}`,
              items: merge(o.items.filter((i) => i.guest === g + 1))
          })).filter((x) => x.items.length)
        : [{ label: null as string | null, items: merge(o.items) }]
    return (
        <div className="fe-items">
            {groups.map((g, i) => (
                <div key={i}>
                    {g.label && <p className="fe-cart-guest">{g.label}</p>}
                    <ul className="fe-item-lines">
                        {g.items.map((it) => (
                            <li key={it.name}>
                                <span>
                                    <span className="fe-num">{it.qty}×</span> {it.name}
                                </span>
                                <span className="fe-num">{usdc(it.amount)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    )
}

type Friend = { name: string; wallet: string }

function SplitWithFriends({ order, token, onDone }: { order: Order; token: string | null; onDone: () => Promise<void> }) {
    const me = useMe()
    const [rows, setRows] = useState<Friend[]>(() => Array.from({ length: Math.max(1, order.guests - 1) }, () => ({ name: "", wallet: "" })))
    const [busy, setBusy] = useState(false)
    const [tried, setTried] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [billId, setBillId] = useState<string | null>(order.splitBillId)

    if (billId || order.splitBillId)
        return (
            <section className="fe-split-done" aria-labelledby="fe-split-h">
                <h2 id="fe-split-h" className="fe-h3">
                    Split with friends
                </h2>
                <p>The bill is shared. Friends pay you back through FairPay, and you can see who has paid.</p>
                <Link className="btn btn-primary" to={`/bills/${billId ?? order.splitBillId}`}>
                    Open the bill
                </Link>
            </section>
        )

    const errs = rows.map((r) => ({
        name: !r.name.trim() ? "Enter a name." : null,
        wallet: r.wallet.trim() && !isWallet(r.wallet.trim()) ? "That isn't a wallet address. Leave it empty if you don't know it." : null
    }))
    const invalid = errs.some((e) => e.name || e.wallet)
    const people = rows.length + 1

    async function submit(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (invalid || busy) return
        setBusy(true)
        setError(null)
        try {
            const res = await fe.splitBill(
                order.id,
                token,
                rows.map((r) => ({ displayName: r.name.trim().slice(0, 60), ...(r.wallet.trim() ? { wallet: r.wallet.trim().toLowerCase() as Wallet } : {}) }))
            )
            const id = billIdFrom(res)
            setBillId(id)
            void onDone()
        } catch (e2) {
            setError(errorText(e2))
        } finally {
            setBusy(false)
        }
    }

    const set = (i: number, k: keyof Friend, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))

    return (
        <section className="fe-split" aria-labelledby="fe-split-h">
            <h2 id="fe-split-h" className="fe-h3">
                Split with friends
            </h2>
            <p>
                You paid {usdc(order.total)}. Add the people you ate with and FairPay makes a bill so they can pay you back: about{" "}
                {usdc(Math.floor(order.total / people / 10_000) * 10_000)} each across {plural(people, "person", "people")}, you included.
            </p>
            {!me ? (
                <p className="fe-hint">Sign in with the wallet that paid to split this bill.</p>
            ) : (
                <form className="fe-form" onSubmit={submit} noValidate>
                    <ul className="fe-friend-rows">
                        {rows.map((r, i) => (
                            <li key={i} className="fe-friend-row">
                                <div className="fe-field">
                                    <label htmlFor={`fr-n-${i}`}>Friend {i + 1}</label>
                                    <input
                                        id={`fr-n-${i}`}
                                        value={r.name}
                                        maxLength={60}
                                        onChange={(e) => set(i, "name", e.target.value)}
                                        aria-invalid={tried && errs[i].name ? true : undefined}
                                        aria-describedby={tried && errs[i].name ? `fr-n-${i}-e` : undefined}
                                    />
                                    {tried && errs[i].name && (
                                        <span className="fe-field-error" id={`fr-n-${i}-e`}>
                                            {errs[i].name}
                                        </span>
                                    )}
                                </div>
                                <div className="fe-field">
                                    <label htmlFor={`fr-w-${i}`}>
                                        Wallet <span className="fe-opt">optional</span>
                                    </label>
                                    <input
                                        id={`fr-w-${i}`}
                                        className="fe-mono"
                                        value={r.wallet}
                                        placeholder="0x…"
                                        spellCheck={false}
                                        autoComplete="off"
                                        onChange={(e) => set(i, "wallet", e.target.value)}
                                        aria-invalid={errs[i].wallet ? true : undefined}
                                        aria-describedby={errs[i].wallet ? `fr-w-${i}-e` : undefined}
                                    />
                                    {errs[i].wallet && (
                                        <span className="fe-field-error" id={`fr-w-${i}-e`}>
                                            {errs[i].wallet}
                                        </span>
                                    )}
                                </div>
                                {rows.length > 1 && (
                                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                                        Remove<span className="sr-only"> friend {i + 1}</span>
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                    {rows.length < 19 && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { name: "", wallet: "" }])}>
                            Add another friend
                        </button>
                    )}
                    <p className="fe-hint">Friends without a wallet get a name-only seat; they claim it from the bill link. Payments between friends are public.</p>
                    {error && <Alert>The bill wasn't created: {error}</Alert>}
                    <div className="fe-form-actions">
                        <button type="submit" className="btn btn-primary" disabled={busy}>
                            {busy ? "Creating the bill…" : "Create the bill"}
                        </button>
                    </div>
                </form>
            )}
        </section>
    )
}

