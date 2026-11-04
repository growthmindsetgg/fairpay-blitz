import { useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { api, usdc, type MenuItem } from "../api"
import { guestsFromParam } from "../menuParams"
import { useWallet } from "../wallet"

type Line = { id: string; guest: number; qty: number }

export function MenuPage() {
    const { cfg } = useWallet()
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const [items, setItems] = useState<MenuItem[]>([])
    const [table, setTable] = useState(() => clampTable(Number(params.get("table")), cfg.restaurant.tables))
    const [guests, setGuests] = useState(() => guestsFromParam(params.get("guests"), cfg.maxGuests))
    const [guest, setGuest] = useState(1)
    const [lines, setLines] = useState<Line[]>([])
    const [placing, setPlacing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [added, setAdded] = useState("")
    const [nudge, setNudge] = useState("")

    useEffect(() => {
        api.menu().then(setItems, (e: Error) => setError(e.message))
    }, [])

    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
    const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items])
    const total = lines.reduce((sum, l) => sum + (byId.get(l.id)?.price ?? 0) * l.qty, 0)
    const count = lines.reduce((n, l) => n + l.qty, 0)

    const add = (id: string) => {
        setAdded(`Added ${byId.get(id)?.name ?? "dish"} for guest ${guest}.`)
        setNudge("")
        setLines((ls) => {
            const hit = ls.find((l) => l.id === id && l.guest === guest)
            return hit ? ls.map((l) => (l === hit ? { ...l, qty: Math.min(l.qty + 1, 20) } : l)) : [...ls, { id, guest, qty: 1 }]
        })
    }
    const change = (line: Line, delta: number) =>
        setLines((ls) => ls.flatMap((l) => (l === line ? (l.qty + delta > 0 ? [{ ...l, qty: l.qty + delta }] : []) : [l])))

    const setGuestCount = (n: number) => {
        setGuests(n)
        if (guest > n) setGuest(n)
        setLines((ls) => ls.filter((l) => l.guest <= n))
    }

    async function placeOrder() {
        if (placing) return
        // The button stays enabled when the order is empty, so it can say why nothing happened.
        if (count === 0) {
            setNudge("Add at least one dish first.")
            return
        }
        setNudge("")
        setPlacing(true)
        setError(null)
        try {
            const order = await api.createOrder({ table, guests, items: lines })
            navigate(`/order/${order.id}`)
        } catch (e) {
            setError((e as Error).message)
            setPlacing(false)
        }
    }

    return (
        <main className="wrap" id="main">
            <p className="sr-only" aria-live="polite">
                {added}
            </p>
            <section className="menu-hero">
                <h1>Tonight at {cfg.restaurant.name}</h1>
                <p>{cfg.restaurant.tagline}</p>
            </section>

            <div className="menu-layout">
                <div>
                    {guests > 1 && (
                        <div className="guest-switch" role="group" aria-label="Ordering for">
                            <span className="label" aria-hidden="true">
                                Ordering for
                            </span>
                            <div className="chips">
                                {Array.from({ length: guests }, (_, i) => (
                                    <button
                                        key={i}
                                        className="guest-tab"
                                        aria-pressed={guest === i + 1}
                                        aria-label={`Guest ${i + 1}`}
                                        onClick={() => setGuest(i + 1)}
                                    >
                                        G{i + 1}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {categories.map((cat) => (
                        <section className="category" key={cat} aria-labelledby={`cat-${cat}`}>
                            <h2 id={`cat-${cat}`}>{cat}</h2>
                            {items
                                .filter((i) => i.category === cat)
                                .map((item) => {
                                    const added = lines.find((l) => l.id === item.id && l.guest === guest)?.qty ?? 0
                                    return (
                                    <article className="dish" key={item.id}>
                                        <div>
                                            <h3>{item.name}</h3>
                                            <p>{item.description}</p>
                                        </div>
                                        <span className="price">{usdc(item.price)}</span>
                                        <button className="btn small quiet add" onClick={() => add(item.id)}>
                                            {added > 0 ? `Add another (${added} added)` : `Add for guest ${guest}`}
                                        </button>
                                    </article>
                                    )
                                })}
                        </section>
                    ))}
                    {items.length === 0 && !error && (
                        <p className="empty" role="status">
                            Loading the menu…
                        </p>
                    )}
                    {items.length === 0 && error && (
                        <p className="error" role="alert">
                            The menu didn't load: {error}
                        </p>
                    )}
                </div>

                <aside className="panel" id="your-table" aria-label="Your table" tabIndex={-1}>
                    <h2>Your table</h2>
                    <div className="field-row">
                        <label htmlFor="table-no">Table</label>
                        <select id="table-no" value={table} onChange={(e) => setTable(Number(e.target.value))}>
                            {Array.from({ length: cfg.restaurant.tables }, (_, i) => (
                                <option key={i + 1} value={i + 1}>
                                    {i + 1}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="field-row">
                        <span id="guests-label">Guests</span>
                        <div className="stepper" role="group" aria-labelledby="guests-label">
                            <button aria-label="One fewer guest" disabled={guests <= 1} onClick={() => setGuestCount(guests - 1)}>
                                −
                            </button>
                            <output aria-live="polite">{guests}</output>
                            <button
                                aria-label="One more guest"
                                disabled={guests >= cfg.maxGuests}
                                onClick={() => setGuestCount(guests + 1)}
                            >
                                +
                            </button>
                        </div>
                    </div>

                    <p className="hint" id="guest-hint">
                        Who is ordering? Each guest pays for their own dishes.
                    </p>
                    <div className="guest-tabs" role="group" aria-labelledby="guest-hint">
                        {Array.from({ length: guests }, (_, i) => (
                            <button key={i} className="guest-tab" aria-pressed={guest === i + 1} onClick={() => setGuest(i + 1)}>
                                Guest {i + 1}
                            </button>
                        ))}
                    </div>

                    {lines.length === 0 ? (
                        <p className="empty" id="lines-empty">
                            Pick dishes from the menu. They go on guest {guest}'s bill.
                        </p>
                    ) : (
                        <ul className="lines">
                            {[...lines]
                                .sort((a, b) => a.guest - b.guest)
                                .map((l) => (
                                    <li key={`${l.guest}-${l.id}`}>
                                        <span className="who">
                                            <span aria-hidden="true">G{l.guest}</span>
                                            <span className="sr-only">Guest {l.guest}:</span>
                                        </span>
                                        <span>
                                            {l.qty} × {byId.get(l.id)?.name}
                                        </span>
                                        <span>
                                            <button
                                                className="qty-btn"
                                                aria-label={`Remove one ${byId.get(l.id)?.name}`}
                                                onClick={() => change(l, -1)}
                                            >
                                                −
                                            </button>
                                            <button
                                                className="qty-btn"
                                                aria-label={`Add one ${byId.get(l.id)?.name}`}
                                                onClick={() => change(l, 1)}
                                            >
                                                +
                                            </button>
                                        </span>
                                    </li>
                                ))}
                        </ul>
                    )}

                    <div className="total-row">
                        <span>Total</span>
                        <strong>{usdc(total)}</strong>
                    </div>
                    {error && items.length > 0 && (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    )}
                    <p className="nudge" role="status">
                        {nudge}
                    </p>
                    <button
                        className="btn block"
                        disabled={placing}
                        aria-describedby={count === 0 ? "lines-empty" : undefined}
                        onClick={placeOrder}
                    >
                        {placing ? "Placing order…" : "Place order"}
                    </button>
                </aside>
            </div>

            {count > 0 && (
                <div className="mobile-bar">
                    <span>
                        <span className="sr-only">Your order: </span>
                        {count} {count === 1 ? "dish" : "dishes"} · {usdc(total)}
                    </span>
                    <a
                        className="btn small"
                        href="#your-table"
                        onClick={(e) => {
                            const panel = document.getElementById("your-table")
                            if (!panel) return
                            e.preventDefault()
                            panel.scrollIntoView({ block: "start" })
                            panel.focus({ preventScroll: true })
                        }}
                    >
                        Review order
                    </a>
                </div>
            )}
        </main>
    )
}

function clampTable(n: number, max: number) {
    return Number.isInteger(n) && n >= 1 && n <= max ? n : 1
}
