import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { api, ApiError, type Order } from "../api"
import { DEMO } from "../components/demo"

const DEMO_PIN = "demo-kitchen"
const UNDO_MS = 5000

// The PIN lives only in sessionStorage: it survives a reload of this tab and is gone when the tab closes.
const PIN_KEY = "faireats.kitchenPin"
const session = {
    get: () => {
        try {
            return sessionStorage.getItem(PIN_KEY)
        } catch {
            return null
        }
    },
    set: (v: string) => {
        try {
            sessionStorage.setItem(PIN_KEY, v)
        } catch {
            /* storage blocked: the screen locks again on reload */
        }
    },
    clear: () => {
        try {
            sessionStorage.removeItem(PIN_KEY)
        } catch {
            /* ignore */
        }
    }
}

export function KitchenPage() {
    const [pin, setPin] = useState(() => session.get() ?? (DEMO ? DEMO_PIN : ""))
    const [authed, setAuthed] = useState(false)
    const [checking, setChecking] = useState(false)
    const [orders, setOrders] = useState<Order[]>([])
    // Only the demo's simulated API sends orders that are still being paid; the real API never does.
    const [awaiting, setAwaiting] = useState<Order[]>([])
    const [error, setError] = useState<string | null>(null)
    const [offline, setOffline] = useState(false)
    // "Mark served" waits a few seconds so a mis-tap can be undone before anything is sent.
    const [serving, setServing] = useState<{ id: string; table: number } | null>(null)
    const serveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const undoButton = useRef<HTMLButtonElement>(null)
    const servingId = serving?.id
    // The ticket's button disappears while undo is offered, so keyboard focus moves to Undo.
    useEffect(() => {
        if (servingId) undoButton.current?.focus()
    }, [servingId])
    const [acting, setActing] = useState<string | null>(null)
    const [announcement, setAnnouncement] = useState("")
    const skew = useRef(0)
    const known = useRef<Set<string> | null>(null)
    const [, tick] = useState(0)

    const load = useCallback(async (p: string) => {
        try {
            const q = await api.kitchen(p)
            skew.current = q.serverTime - Date.now()
            const ids = new Set(q.orders.map((o) => o.id))
            if (known.current) {
                const fresh = q.orders.filter((o) => !known.current!.has(o.id))
                if (fresh.length) setAnnouncement(`New ticket for table ${fresh.map((o) => o.table).join(", ")}.`)
            }
            known.current = ids
            setOrders(q.orders)
            const extra = (q as { awaiting?: unknown }).awaiting
            setAwaiting(Array.isArray(extra) ? (extra as Order[]) : [])
            setAuthed(true)
            setOffline(false)
            setError(null)
            session.set(p)
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
                setAuthed(false)
                setPin("")
                known.current = null
                session.clear()
                setError("That PIN didn't work. Try again.")
                return
            }
            // Shown inline under the PIN before unlocking, and as a banner over the board after.
            setOffline(true)
        }
    }, [])

    useEffect(() => {
        // Only a PIN saved in this tab unlocks on its own; the demo's pre-filled PIN still shows the PIN step.
        if (pin && !authed && session.get()) {
            setChecking(true)
            void load(pin).finally(() => setChecking(false))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!authed) return
        const poll = setInterval(() => load(pin), 3000)
        const clock = setInterval(() => tick((n) => n + 1), 500)
        return () => {
            clearInterval(poll)
            clearInterval(clock)
        }
    }, [authed, pin, load])

    const act = async (id: string, fn: () => Promise<unknown>) => {
        if (acting) return
        setActing(id)
        setError(null)
        try {
            await fn()
            await load(pin)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setActing(null)
        }
    }

    const sendServed = useCallback(
        async (target: { id: string; table: number }) => {
            try {
                await api.markServed(target.id, pin)
                setAnnouncement(`Table ${target.table} served.`)
            } catch (e) {
                setError((e as Error).message)
            }
            await load(pin)
        },
        [pin, load]
    )

    const markServed = (o: Order) => {
        // A second ticket marked while the first is still undoable sends the first right away.
        if (serveTimer.current && serving) {
            clearTimeout(serveTimer.current)
            void sendServed(serving)
        }
        const target = { id: o.id, table: o.table }
        setServing(target)
        setAnnouncement(`Table ${o.table} marked served. Undo is available for 5 seconds.`)
        serveTimer.current = setTimeout(() => {
            serveTimer.current = null
            setServing(null)
            void sendServed(target)
        }, UNDO_MS)
    }

    const undoServed = () => {
        if (serveTimer.current) clearTimeout(serveTimer.current)
        serveTimer.current = null
        if (serving) {
            setAnnouncement(`Undone. Table ${serving.table} is still ready.`)
            const id = serving.id
            // The ticket's button comes back on the next render; put focus back on it.
            setTimeout(() => document.getElementById(`serve-${id}`)?.focus(), 0)
        }
        setServing(null)
    }

    // Closing or locking the screen during the undo window leaves the order "ready", which is safe.
    useEffect(
        () => () => {
            if (serveTimer.current) clearTimeout(serveTimer.current)
        },
        []
    )

    const lock = () => {
        if (serveTimer.current) clearTimeout(serveTimer.current)
        serveTimer.current = null
        setServing(null)
        setOffline(false)
        setAwaiting([])
        session.clear()
        setPin("")
        setAuthed(false)
        setOrders([])
        setError(null)
        known.current = null
    }

    if (!authed)
        return (
            <div className="kitchen">
                <main id="main">
                    <form
                        className="pin-form wrap"
                        onSubmit={async (e: FormEvent) => {
                            e.preventDefault()
                            if (checking) return
                            setChecking(true)
                            await load(pin)
                            setChecking(false)
                        }}
                    >
                        <h1>Kitchen</h1>
                        <label htmlFor="pin">Staff PIN</label>
                        <input
                            id="pin"
                            type="password"
                            inputMode={DEMO ? "text" : "numeric"}
                            autoComplete="off"
                            aria-describedby={error || offline ? "pin-error" : undefined}
                            aria-invalid={error ? true : undefined}
                            value={pin}
                            onChange={(e) => setPin(e.target.value)}
                        />
                        <button className="btn" type="submit" disabled={pin.length < 6 || checking}>
                            {checking ? "Checking…" : "Open the kitchen screen"}
                        </button>
                        <p className="error on-dark" id="pin-error" role="alert">
                            {error ?? (offline ? "We can't reach the kitchen server. Check the connection and try again." : "")}
                        </p>
                        <Link to="/">Back to the menu</Link>
                    </form>
                </main>
            </div>
        )

    const now = Date.now() + skew.current
    return (
        <div className="kitchen">
            {offline && (
                <p className="kitchen-offline" role="alert">
                    Connection lost. Retrying every 3 seconds. Tickets may be out of date.
                </p>
            )}
            <main className="wrap" id="main">
                <div className="kitchen-head">
                    <h1>
                        Kitchen · {orders.length === 0 ? "no tickets" : `${orders.length} ${orders.length === 1 ? "ticket" : "tickets"}`}
                    </h1>
                    <button className="btn quiet on-dark" onClick={lock}>
                        Lock screen
                    </button>
                </div>
                <p className="sr-only" aria-live="polite">
                    {announcement}
                </p>
                {error && (
                    <p className="error on-dark" role="alert">
                        {error}
                    </p>
                )}
                {orders.length === 0 ? (
                    <p className="empty">No tickets yet. Orders appear here once every guest has paid.</p>
                ) : (
                    <div className="rail">
                        {orders.map((o) => {
                            const left = o.readyAt ? Math.max(0, Math.ceil((o.readyAt - now) / 1000)) : null
                            const status = o.status === "cooking" && left === 0 ? "ready" : o.status
                            const held = serving?.id === o.id
                            const word = held ? "Served" : status === "paid" ? "New" : status === "cooking" ? "Cooking" : "Ready"
                            return (
                                <article
                                    className="ticket"
                                    key={o.id}
                                    data-status={held ? "served" : status}
                                    aria-label={`Table ${o.table}, ${word}`}
                                >
                                    <div className="ticket-top">
                                        <div>
                                            <span className="ticket-label">Table</span>
                                            <div className="table-no">{o.table}</div>
                                        </div>
                                        <span className="ticket-state">{word}</span>
                                    </div>
                                    <p className="trust">
                                        <span aria-hidden="true">✓ </span>
                                        {o.shares.length === 1 ? "The only share" : `All ${o.shares.length} shares`}{" "}
                                        {DEMO ? "verified (simulated)" : "verified on-chain"}
                                    </p>
                                    <ul>
                                        {mergeItems(o).map(([name, qty]) => (
                                            <li key={name}>
                                                <strong>{qty}×</strong> {name}
                                            </li>
                                        ))}
                                    </ul>
                                    {status === "paid" && (
                                        <button
                                            className="btn big"
                                            disabled={acting !== null}
                                            onClick={() => act(o.id, () => api.startCooking(o.id, pin))}
                                        >
                                            {acting === o.id ? "Starting…" : `Start cooking table ${o.table}`}
                                        </button>
                                    )}
                                    {status === "cooking" && left !== null && (
                                        <div
                                            className="timer"
                                            role="timer"
                                            aria-label={left < 60 ? `${left} seconds left` : `About ${Math.ceil(left / 60)} minutes left`}
                                        >
                                            {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                                        </div>
                                    )}
                                    {status === "ready" && !held && (
                                        <button
                                            id={`serve-${o.id}`}
                                            className="btn big"
                                            disabled={acting !== null}
                                            onClick={() => markServed(o)}
                                        >
                                            Mark table {o.table} served
                                        </button>
                                    )}
                                    {held && <p className="ticket-held">Marked served. Sending in a few seconds.</p>}
                                </article>
                            )
                        })}
                    </div>
                )}

                {awaiting.length > 0 && (
                    <section className="awaiting" aria-labelledby="awaiting-h">
                        <h2 id="awaiting-h">Awaiting payment</h2>
                        <p className="hint">The kitchen can't start these yet. They move up once every share is verified.</p>
                        <ul>
                            {awaiting.map((o) => {
                                const paid = o.shares.filter((s) => s.status === "verified").length
                                return (
                                    <li key={o.id}>
                                        Table {o.table} · {paid} of {o.shares.length} shares verified
                                    </li>
                                )
                            })}
                        </ul>
                    </section>
                )}
            </main>

            {serving && (
                <div className="toast">
                    <span>Table {serving.table} marked served.</span>
                    <button ref={undoButton} className="btn quiet on-dark undo" onClick={undoServed}>
                        Undo
                    </button>
                </div>
            )}
        </div>
    )
}

function mergeItems(o: Order): [string, number][] {
    const m = new Map<string, number>()
    for (const i of o.items) m.set(i.name, (m.get(i.name) ?? 0) + i.qty)
    return [...m.entries()]
}
