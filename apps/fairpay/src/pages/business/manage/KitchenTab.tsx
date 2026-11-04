import { useCallback, useRef, useState } from "react"
import type { Order, Role } from "../../../../shared/types"
import { Modal } from "../../../components"
import { errorText, fe } from "../client"
import type { TabProps } from "../Manage"
import { Alert, istTime, Loading, minutesSince, plural, startOfTodayIst, usdc, useNow, usePoll } from "../ui"

type Col = "paid" | "cooking" | "served"

/** Paid -> Cooking -> Served (done). The server's clock moves tickets along by itself. */
const COLS: { key: Col; title: string; empty: string }[] = [
    { key: "paid", title: "Paid", empty: "Paid tickets go straight to cooking." },
    { key: "cooking", title: "Cooking", empty: "Nothing on the stove. Paid orders start here by themselves." },
    { key: "served", title: "Served · done", empty: "Nothing served yet today." }
]

/** The next step for an order and who may take it (mirrors the server's rules). */
const NEXT: Partial<Record<Order["status"], { to: Order["status"]; label: string; roles: Role[] }>> = {
    paid: { to: "cooking", label: "Start cooking", roles: ["chef", "manager", "owner"] },
    cooking: { to: "served", label: "Mark served", roles: ["waiter", "manager", "owner"] },
    // Only an order marked ready elsewhere; the clock serves it on the next update.
    ready: { to: "served", label: "Mark served", roles: ["waiter", "manager", "owner"] }
}

export function KitchenTab({ view }: TabProps) {
    const rid = view.restaurant.id
    const role = view.role
    const [orders, setOrders] = useState<Order[] | null>(null)
    const [offline, setOffline] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [acting, setActing] = useState<string | null>(null)
    const [announce, setAnnounce] = useState("")
    const [cancelling, setCancelling] = useState<Order | null>(null)
    const known = useRef<Set<string> | null>(null)
    const now = useNow(5_000)

    const load = useCallback(async () => {
        try {
            const list = await fe.orders(rid)
            const paid = list.filter((o) => o.status === "paid")
            if (known.current) {
                const fresh = paid.filter((o) => !known.current!.has(o.id))
                if (fresh.length) setAnnounce(`New ticket for ${fresh.map((o) => `table ${o.table?.label ?? "?"}`).join(", ")}.`)
            }
            known.current = new Set(list.filter((o) => o.status !== "awaiting_payment").map((o) => o.id))
            setOrders(list)
            setOffline(false)
        } catch {
            setOffline(true)
        }
    }, [rid])
    usePoll(load, 5000)

    async function act(o: Order, to: Order["status"], label: string) {
        if (acting) return false
        setActing(o.id)
        setError(null)
        try {
            const saved = await fe.setOrderStatus(o.id, to)
            setOrders((list) => list?.map((x) => (x.id === o.id ? { ...x, ...(saved ?? {}), status: saved?.status ?? to } : x)) ?? null)
            setAnnounce(`Table ${o.table?.label ?? ""}: ${label.toLowerCase()} done.`)
            void load()
            return true
        } catch (e) {
            setError(`Table ${o.table?.label ?? ""} wasn't updated: ${errorText(e)}`)
            return false
        } finally {
            setActing(null)
        }
    }

    if (!orders)
        return offline ? (
            <Alert>We can't reach the kitchen feed. Retrying every 5 seconds.</Alert>
        ) : (
            <Loading label="Loading tickets…" />
        )

    const today = startOfTodayIst(now)
    const by = (s: Col) => {
        const list = orders.filter((o) => o.status === s || (s === "cooking" && o.status === "ready"))
        if (s === "served") return list.filter((o) => (o.servedAt ?? 0) >= today).sort((a, b) => (b.servedAt ?? 0) - (a.servedAt ?? 0)).slice(0, 8)
        // Oldest first: the ticket that has waited longest is at the top.
        return list.sort((a, b) => (a.paidAt ?? a.createdAt) - (b.paidAt ?? b.createdAt))
    }
    const awaiting = orders.filter((o) => o.status === "awaiting_payment")

    return (
        <div className="fe-stack">
            <div className="fe-row-between">
                <h2 className="fe-h2">Kitchen</h2>
                <p className="fe-muted fe-live-note">
                    <span className={`fe-dot ${offline ? "is-full" : "is-free"}`} aria-hidden="true" />
                    {offline ? "Connection lost. Retrying…" : "Updates every 5 seconds"}
                </p>
            </div>
            <p className="sr-only" aria-live="polite">
                {announce}
            </p>
            {error && <Alert>{error}</Alert>}

            <div className="fe-board">
                {COLS.map((c) => {
                    const list = by(c.key)
                    return (
                        <section key={c.key} className={`fe-col fe-col--${c.key}`} aria-labelledby={`kc-${c.key}`}>
                            <h3 id={`kc-${c.key}`} className="fe-col-head">
                                {c.title} <span className="fe-count">{list.length}</span>
                            </h3>
                            {list.length === 0 ? (
                                <p className="fe-col-empty">{c.empty}</p>
                            ) : (
                                <ul className="fe-tickets">
                                    {list.map((o) => (
                                        <li key={o.id}>
                                            <Ticket o={o} now={now} role={role} acting={acting} onAct={act} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    )
                })}
            </div>

            {awaiting.length > 0 && (
                <section className="fe-awaiting" aria-labelledby="kc-await">
                    <h3 id="kc-await" className="fe-h3">
                        Awaiting payment <span className="fe-count">{awaiting.length}</span>
                    </h3>
                    <p className="fe-hint">
                        These start cooking by themselves once every share is paid and verified on-chain. Orders with no payment are cancelled automatically after 15 minutes,
                        which frees the table.
                    </p>
                    <ul className="fe-await-list">
                        {awaiting.map((o) => {
                            const paid = o.shares.filter((s) => s.status === "paid").length
                            const received = o.shares.reduce((sum, s) => sum + s.paid, 0)
                            return (
                                <li key={o.id}>
                                    <span>
                                        <strong>Table {o.table?.label ?? "?"}</strong> · {plural(o.guests, "guest")} · {usdc(o.total)}
                                    </span>
                                    <span className="fe-muted">
                                        {paid} of {o.shares.length} {o.shares.length === 1 ? "share" : "shares"} paid
                                        {received > 0 ? ` (${usdc(received)} received)` : ""} · placed {istTime(o.createdAt)}
                                    </span>
                                    {(role === "owner" || role === "manager") && (
                                        <button
                                            type="button"
                                            className="btn btn-quiet btn-sm fe-danger-text"
                                            disabled={acting !== null}
                                            onClick={() => setCancelling(o)}
                                        >
                                            Cancel order<span className="sr-only"> for table {o.table?.label ?? "?"}</span>
                                        </button>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                </section>
            )}

            <CancelDialog
                order={cancelling}
                busy={!!cancelling && acting === cancelling.id}
                onClose={() => setCancelling(null)}
                onConfirm={async (o) => {
                    if (await act(o, "cancelled", "Cancel")) setCancelling(null)
                }}
            />
        </div>
    )
}

/** Owner/manager only. Partly paid orders can be cancelled too; money already received isn't sent back automatically. */
function CancelDialog({
    order,
    busy,
    onClose,
    onConfirm
}: {
    order: Order | null
    busy: boolean
    onClose: () => void
    onConfirm: (o: Order) => Promise<void>
}) {
    const received = order ? order.shares.reduce((sum, s) => sum + s.paid, 0) : 0
    return (
        <Modal open={!!order} onClose={onClose} title={`Cancel the order for table ${order?.table?.label ?? "?"}?`} dismissible={!busy} size="sm">
            {order && (
                <div className="fe-stack">
                    <p>The order is cancelled and the table is freed. Guests can no longer pay for it.</p>
                    {received > 0 ? (
                        <p className="callout callout-warn">
                            {usdc(received)} has already been paid. Payments already received stay with the restaurant; refund them yourself.
                        </p>
                    ) : (
                        <p className="fe-hint">Nothing has been paid on this order yet. Payments already received stay with the restaurant; refund them yourself.</p>
                    )}
                    <div className="fe-form-actions">
                        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void onConfirm(order)}>
                            {busy ? "Cancelling…" : "Cancel order"}
                        </button>
                        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
                            Keep it
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    )
}

function Ticket({
    o,
    now,
    role,
    acting,
    onAct
}: {
    o: Order
    now: number
    role: Role
    acting: string | null
    onAct: (o: Order, to: Order["status"], label: string) => void
}) {
    const next = NEXT[o.status]
    const can = next && next.roles.includes(role)
    const items = merge(o)
    const table = o.table?.label ?? "?"
    let timing = ""
    let late = false
    if (o.status === "paid" && o.paidAt) {
        const m = minutesSince(o.paidAt, now)
        timing = `Waiting ${m} min`
        late = m >= 10
    } else if (o.status === "cooking") {
        const m = o.cookingStartedAt ? minutesSince(o.cookingStartedAt, now) : 0
        const left = o.estReadyAt ? Math.ceil((o.estReadyAt - now) / 60_000) : null
        timing = left === null ? `Cooking ${m} min` : left > 0 ? `Cooking · done in ${left} min` : "Cooking · done now"
        late = left !== null && left < -1
    } else if (o.status === "ready") {
        timing = "Ready · serving now"
    } else if (o.status === "served" && o.servedAt) timing = `Done · served ${istTime(o.servedAt)}`

    return (
        <article className={`fe-ticket${late ? " is-late" : ""}`} aria-label={`Table ${table}, ${o.status}`}>
            <header className="fe-ticket-head">
                <span className="fe-ticket-table">
                    <span className="fe-ticket-cap">Table</span>
                    {table}
                </span>
                <span className="fe-ticket-meta">
                    <span>
                        {plural(o.guests, "guest")}
                        {o.demo && " · demo order"}
                    </span>
                    {timing && <span className={late ? "fe-late" : undefined}>{timing}</span>}
                </span>
            </header>
            <ul className="fe-ticket-items">
                {items.map(([name, qty]) => (
                    <li key={name}>
                        <strong className="fe-num">{qty}×</strong> {name}
                    </li>
                ))}
            </ul>
            {o.chef && <p className="fe-ticket-chef">Chef: {o.chef.name}</p>}
            {next && can && (
                <button
                    type="button"
                    className={`btn ${o.status === "paid" ? "btn-primary" : "btn-secondary"} btn-block`}
                    disabled={acting !== null}
                    onClick={() => onAct(o, next.to, next.label)}
                >
                    {acting === o.id ? "Updating…" : next.label}
                    <span className="sr-only"> for table {table}</span>
                </button>
            )}
            {next && !can && <p className="fe-muted fe-ticket-wait">{o.status === "paid" ? "Starts cooking automatically" : "Served automatically when the time is up"}</p>}
        </article>
    )
}

function merge(o: Order): [string, number][] {
    const m = new Map<string, number>()
    for (const i of o.items) m.set(i.name, (m.get(i.name) ?? 0) + i.qty)
    return [...m.entries()]
}
