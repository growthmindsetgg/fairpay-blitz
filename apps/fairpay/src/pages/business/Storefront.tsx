import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import type { Chef, MenuItem, StorefrontView, Table } from "../../../shared/types"
import { Badge, Icon, useSession } from "../../components"
import "../../styles/business.css"
import { ApiError, errorText, fe } from "./client"
import { CoverArt } from "./Directory"
import { computeBill, splitAmounts } from "./gstx"
import { mediaUrl } from "../../lib/base"
import { Alert, Avatar, DishImage, Loading, percent, plural, SpiceMark, TABLE_STATUS, usdc, usePoll, VegMark } from "./ui"

type Line = { id: string; guest: number; qty: number }
type Mode = "one_pays" | "split"
type SplitBy = "items" | "equal"

const MAX_GUESTS = 20
const MAX_QTY = 20

/** Keeps the cart through a reload or a trip to the wallet, for this tab only. */
function useStoredCart(slug: string) {
    const key = `fairpay.cart.${slug}`
    const [state, setState] = useState<{ lines: Line[]; guests: number }>(() => {
        try {
            const v = JSON.parse(sessionStorage.getItem(key) ?? "null") as { lines?: unknown; guests?: unknown } | null
            if (v && Array.isArray(v.lines) && typeof v.guests === "number")
                return {
                    guests: Math.min(Math.max(1, Math.floor(v.guests)), MAX_GUESTS),
                    lines: (v.lines as Line[]).filter((l) => typeof l.id === "string" && l.qty > 0 && l.guest >= 1)
                }
        } catch {
            /* storage blocked or bad JSON: start empty */
        }
        return { lines: [], guests: 2 }
    })
    useEffect(() => {
        try {
            sessionStorage.setItem(key, JSON.stringify(state))
        } catch {
            /* ignore */
        }
    }, [key, state])
    const clear = () => {
        try {
            sessionStorage.removeItem(key)
        } catch {
            /* ignore */
        }
    }
    return [state, setState, clear] as const
}

export function Storefront() {
    const { slug = "" } = useParams()
    const navigate = useNavigate()
    const [view, setView] = useState<StorefrontView | null>(null)
    const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null)
    const [cart, setCart, clearCart] = useStoredCart(slug)
    const { lines, guests } = cart
    const [guest, setGuest] = useState(1)
    const [step, setStep] = useState<"cart" | "checkout">("cart")
    const [tableId, setTableId] = useState<string | null>(null)
    const [mode, setMode] = useState<Mode>("split")
    const [splitBy, setSplitBy] = useState<SplitBy>("items")
    const [names, setNames] = useState<string[]>([])
    const [placing, setPlacing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [announce, setAnnounce] = useState("")
    const cartRef = useRef<HTMLElement>(null)

    const load = useCallback(async () => {
        try {
            const v = await fe.storefront(slug)
            setView(v)
            setLoadError(null)
            document.title = `${v.restaurant.name} · FairPay`
        } catch (e) {
            setLoadError({ status: e instanceof ApiError ? e.status : 0, message: errorText(e) })
        }
    }, [slug])
    // Table availability changes as other guests order, so refresh it every 30 seconds.
    usePoll(load, 30_000)

    const items = useMemo(() => [...(view?.menu ?? [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)), [view])
    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
    const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items])
    // Drop cart lines for dishes that left the menu or sold out.
    const valid = lines.filter((l) => byId.get(l.id)?.available && l.guest <= guests)
    const count = valid.reduce((n, l) => n + l.qty, 0)

    const r = view?.restaurant
    // Without a GSTIN the restaurant issues a Bill of Supply and charges no GST.
    const rate = r?.gstin ? r.gstRateBps : 0
    const billLines = valid.map((l) => ({ unitPrice: byId.get(l.id)!.price, qty: l.qty, guest: l.guest }))
    const bill = r && billLines.length ? computeBill(billLines, rate, r.serviceChargeBps) : null

    const table = view?.tables.find((t) => t.id === tableId) ?? null
    // A table taken by someone else since we picked it can't be ordered at.
    useEffect(() => {
        if (table && table.status !== "available") {
            setTableId(null)
            setError(`Table ${table.label} was just taken. Pick another free table.`)
        }
    }, [table])

    if (!view || !r)
        return (
            <div className="fe fe-page">
                {loadError ? (
                    <div className="fe-state">
                        <h1>{loadError.status === 404 ? "We can't find that restaurant" : "The restaurant didn't load"}</h1>
                        <Alert>{loadError.status === 404 ? "The link may be wrong, or the restaurant may have closed its page." : loadError.message}</Alert>
                        {loadError.status === 404 ? (
                            <Link to="/business/faireats" className="btn btn-secondary">
                                See all restaurants
                            </Link>
                        ) : (
                            <button className="btn btn-secondary" onClick={() => void load()}>
                                Try again
                            </button>
                        )}
                    </div>
                ) : (
                    <Loading label="Loading the menu…" />
                )}
            </div>
        )

    const setLines = (fn: (ls: Line[]) => Line[]) => setCart((c) => ({ ...c, lines: fn(c.lines) }))
    const add = (item: MenuItem) => {
        setError(null)
        setLines((ls) => {
            const hit = ls.find((l) => l.id === item.id && l.guest === guest)
            return hit ? ls.map((l) => (l === hit ? { ...l, qty: Math.min(l.qty + 1, MAX_QTY) } : l)) : [...ls, { id: item.id, guest, qty: 1 }]
        })
        setAnnounce(`Added ${item.name}${guests > 1 ? ` for ${guestName(guest)}` : ""}.`)
    }
    const changeQty = (line: Line, delta: number) =>
        setLines((ls) => ls.flatMap((l) => (l.id === line.id && l.guest === line.guest ? (l.qty + delta > 0 ? [{ ...l, qty: Math.min(l.qty + delta, MAX_QTY) }] : []) : [l])))
    const moveLine = (line: Line, to: number) =>
        setLines((ls) => {
            const rest = ls.filter((l) => !(l.id === line.id && l.guest === line.guest))
            const hit = rest.find((l) => l.id === line.id && l.guest === to)
            return hit ? rest.map((l) => (l === hit ? { ...l, qty: Math.min(l.qty + line.qty, MAX_QTY) } : l)) : [...rest, { ...line, guest: to }]
        })
    const setGuests = (n: number) => {
        const g = Math.min(Math.max(1, n), MAX_GUESTS)
        // Dishes of a removed guest move to guest 1 rather than vanishing.
        setCart((c) => ({
            guests: g,
            lines: c.lines.reduce<Line[]>((acc, l) => {
                const to = l.guest > g ? 1 : l.guest
                const hit = acc.find((x) => x.id === l.id && x.guest === to)
                if (hit) hit.qty = Math.min(hit.qty + l.qty, MAX_QTY)
                else acc.push({ ...l, guest: to })
                return acc
            }, [])
        }))
        if (guest > g) setGuest(g)
    }
    function guestName(n: number) {
        return names[n - 1]?.trim() || `Guest ${n}`
    }

    const free = view.tables.filter((t) => t.status === "available").length
    const effectiveMode: Mode = guests === 1 ? "one_pays" : mode
    const shares =
        bill && effectiveMode === "split" ? splitAmounts(billLines, guests, rate, r.serviceChargeBps, splitBy) : null
    const emptyGuests =
        effectiveMode === "split" && splitBy === "items"
            ? Array.from({ length: guests }, (_, i) => i + 1).filter((g) => !valid.some((l) => l.guest === g))
            : []

    const goToCart = () => {
        cartRef.current?.scrollIntoView({ block: "start" })
        cartRef.current?.focus({ preventScroll: true })
    }

    async function place() {
        if (placing) return
        setError(null)
        if (count === 0) return setError("Add at least one dish first.")
        if (!table) {
            setError("Choose a free table.")
            document.getElementById("fe-tables")?.scrollIntoView({ block: "start" })
            return
        }
        if (emptyGuests.length)
            return setError(
                `${emptyGuests.map(guestName).join(", ")} ${emptyGuests.length === 1 ? "has" : "have"} no dishes. Assign a dish, split equally, or lower the number of guests.`
            )
        setPlacing(true)
        try {
            const anyNames = names.slice(0, guests).some((n) => n?.trim())
            const res = await fe.placeOrder({
                tableId: table.id,
                guests,
                paymentMode: effectiveMode,
                items: valid.map((l) => ({ id: l.id, qty: l.qty, guest: l.guest })),
                ...(effectiveMode === "split" ? { splitBy } : {}),
                ...(anyNames ? { guestNames: Array.from({ length: guests }, (_, i) => (names[i]?.trim() || `Guest ${i + 1}`).slice(0, 40)) } : {})
            })
            clearCart()
            navigate(`/o/${res.order.id}?t=${encodeURIComponent(res.token)}`)
        } catch (e) {
            setError(errorText(e))
            setPlacing(false)
            void load()
        }
    }

    const where = [r.address, r.city, r.state].filter(Boolean).join(", ")

    return (
        <div className="fe fe-store">
            <p className="sr-only" aria-live="polite">
                {announce}
            </p>
            <header className="fe-hero">
                {/* Without a photo, a low patterned band rather than a tall empty block. */}
                <div className={r.coverImage ? "fe-hero-cover" : "fe-hero-cover is-art"}>
                    {r.coverImage ? <img src={mediaUrl(r.coverImage)} alt="" decoding="async" width={1200} height={480} /> : <CoverArt seed={r.name} wide />}
                </div>
                <div className="fe-hero-card">
                    <p className="fe-crumb">
                        <Link to="/business/faireats">FairEats</Link>
                    </p>
                    <h1>{r.name}</h1>
                    {r.tagline && <p className="fe-lead">{r.tagline}</p>}
                    <dl className="fe-facts">
                        {r.cuisine && (
                            <div>
                                <dt>Cuisine</dt>
                                <dd>{r.cuisine}</dd>
                            </div>
                        )}
                        {where && (
                            <div>
                                <dt>Address</dt>
                                <dd>{where}</dd>
                            </div>
                        )}
                        {r.hours && (
                            <div>
                                <dt>Hours</dt>
                                <dd>{r.hours}</dd>
                            </div>
                        )}
                    </dl>
                    <div className="fe-card-badges">
                        {r.privatePayments && <Badge tone="private">Confidential payments</Badge>}
                        {r.isDemo && <Badge>Demo restaurant</Badge>}
                    </div>
                    {r.description && <p className="fe-about">{r.description}</p>}
                </div>
            </header>

            <div className="fe-store-layout">
                <div className="fe-store-main">
                    <section className="fe-section" id="fe-tables" aria-labelledby="fe-tables-h">
                        <div className="fe-row-between">
                            <h2 id="fe-tables-h" className="fe-h2">
                                Tables
                            </h2>
                            <p className="fe-muted fe-num">
                                {view.tables.length === 0 ? "No tables set up" : `${free} of ${view.tables.length} tables free`}
                            </p>
                        </div>
                        {view.tables.length > 0 && (
                            <>
                                <p className="fe-hint" id="fe-tables-hint">
                                    Pick the table you're sitting at. Taken tables can't be chosen.
                                </p>
                                <ul className="fe-pick-grid" aria-describedby="fe-tables-hint">
                                    {[...view.tables]
                                        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                                        .map((t) => (
                                            <li key={t.id}>
                                                <TablePick t={t} selected={t.id === tableId} onPick={() => (setTableId(t.id), setError(null))} />
                                            </li>
                                        ))}
                                </ul>
                                {free === 0 && <Alert tone="info">Every table is taken right now. This updates every 30 seconds.</Alert>}
                            </>
                        )}
                    </section>

                    <section className="fe-section" aria-labelledby="fe-menu-h">
                        <h2 id="fe-menu-h" className="fe-h2">
                            Menu
                        </h2>
                        {categories.length > 1 && (
                            <nav className="fe-catnav" aria-label="Menu sections">
                                {categories.map((c) => (
                                    <a key={c} href={`#cat-${catId(c)}`}>
                                        {c}
                                    </a>
                                ))}
                            </nav>
                        )}
                        {guests > 1 && (
                            <div className="fe-ordering-for" role="group" aria-label="Adding dishes for">
                                <span className="fe-label-sm" aria-hidden="true">
                                    Adding for
                                </span>
                                <div className="fe-guest-chips">
                                    {Array.from({ length: guests }, (_, i) => (
                                        <button key={i} type="button" className="fe-guest-chip" aria-pressed={guest === i + 1} onClick={() => setGuest(i + 1)}>
                                            {guestName(i + 1)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {items.length === 0 ? (
                            <div className="fe-empty">
                                <h3>The menu is on its way</h3>
                                <p>This restaurant hasn't added dishes yet.</p>
                            </div>
                        ) : (
                            categories.map((cat) => (
                                <section key={cat} className="fe-cat" id={`cat-${catId(cat)}`} aria-labelledby={`cat-${catId(cat)}-h`}>
                                    <h3 id={`cat-${catId(cat)}-h`} className="fe-h3">
                                        {cat}
                                    </h3>
                                    <ul className="fe-dishes">
                                        {items
                                            .filter((i) => i.category === cat)
                                            .map((item) => {
                                                const mine = valid.find((l) => l.id === item.id && l.guest === guest)
                                                return (
                                                    <li key={item.id}>
                                                        <DishCard
                                                            item={item}
                                                            qty={mine?.qty ?? 0}
                                                            forWho={guests > 1 ? guestName(guest) : null}
                                                            onAdd={() => add(item)}
                                                            onLess={() => mine && changeQty(mine, -1)}
                                                        />
                                                    </li>
                                                )
                                            })}
                                    </ul>
                                </section>
                            ))
                        )}
                    </section>

                    {/* The kitchen team comes after the menu, so the first dish is higher on the page. */}
                    {view.chefs.length > 0 && (
                        <section className="fe-section" aria-labelledby="fe-chefs-h">
                            <h2 id="fe-chefs-h" className="fe-h2">
                                In the kitchen
                            </h2>
                            <ul className="fe-chefs">
                                {view.chefs.map((c) => (
                                    <li key={c.id}>
                                        <ChefCard chef={c} />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>

                <aside className="fe-cart" ref={cartRef} tabIndex={-1} aria-labelledby="fe-cart-h">
                    <h2 id="fe-cart-h" className="fe-h3">
                        {step === "cart" ? "Your order" : "Table and payment"}
                    </h2>

                    {step === "cart" ? (
                        <>
                            <div className="fe-stepper-row">
                                <span id="fe-guests-l">Guests</span>
                                <div className="fe-stepper" role="group" aria-labelledby="fe-guests-l">
                                    <button type="button" aria-label="One fewer guest" disabled={guests <= 1} onClick={() => setGuests(guests - 1)}>
                                        −
                                    </button>
                                    <output aria-live="polite">{guests}</output>
                                    <button type="button" aria-label="One more guest" disabled={guests >= MAX_GUESTS} onClick={() => setGuests(guests + 1)}>
                                        +
                                    </button>
                                </div>
                            </div>
                            {valid.length === 0 ? (
                                <p className="fe-muted fe-cart-empty" id="fe-cart-empty">
                                    {guests > 1 ? `Pick dishes from the menu. They go on ${guestName(guest)}'s list; you can move them later.` : "Pick dishes from the menu."}
                                </p>
                            ) : (
                                <CartLines
                                    lines={valid}
                                    byId={byId}
                                    guests={guests}
                                    guestName={guestName}
                                    onQty={changeQty}
                                    onMove={moveLine}
                                />
                            )}
                            {bill && (
                                <dl className="fe-sum">
                                    <div>
                                        <dt>Subtotal</dt>
                                        <dd>{usdc(bill.subtotal)}</dd>
                                    </div>
                                    <div className="fe-sum-note">
                                        <dt>Tax and charges</dt>
                                        <dd>on the next step</dd>
                                    </div>
                                </dl>
                            )}
                            {error && <Alert>{error}</Alert>}
                            <button
                                type="button"
                                className="btn btn-primary btn-block"
                                aria-describedby={count === 0 ? "fe-cart-empty" : undefined}
                                onClick={() => {
                                    if (count === 0) return setError("Add at least one dish first.")
                                    setError(null)
                                    setStep("checkout")
                                    requestAnimationFrame(goToCart)
                                }}
                            >
                                Choose table and payment
                            </button>
                        </>
                    ) : (
                        <Checkout
                            table={table}
                            guests={guests}
                            setGuests={setGuests}
                            mode={effectiveMode}
                            setMode={setMode}
                            splitBy={splitBy}
                            setSplitBy={setSplitBy}
                            names={names}
                            setNames={setNames}
                            bill={bill}
                            rate={rate}
                            serviceBps={r.serviceChargeBps}
                            hasGstin={!!r.gstin}
                            shares={shares}
                            emptyGuests={emptyGuests}
                            guestName={guestName}
                            privatePayments={r.privatePayments}
                            error={error}
                            placing={placing}
                            onBack={() => (setStep("cart"), setError(null))}
                            onPlace={() => void place()}
                        />
                    )}
                </aside>
            </div>

            {count > 0 && (
                <div className="fe-mobile-bar">
                    <span className="fe-num">
                        <span className="sr-only">Your order: </span>
                        {plural(count, "dish", "dishes")} · {usdc(bill?.subtotal ?? 0)}
                    </span>
                    <button type="button" className="btn btn-primary btn-sm" onClick={goToCart}>
                        Review order
                    </button>
                </div>
            )}
        </div>
    )
}

function catId(c: string) {
    return c.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

function ChefCard({ chef }: { chef: Chef }) {
    const facts = [chef.title, chef.years != null ? `${chef.years} years cooking` : null].filter(Boolean).join(" · ")
    return (
        <article className="fe-chef">
            <Avatar src={chef.photo} name={chef.name} size={72} />
            <div>
                <h3 className="fe-chef-name">{chef.name}</h3>
                {facts && <p className="fe-muted">{facts}</p>}
                {chef.specialty && <p className="fe-chef-spec">Known for {chef.specialty}</p>}
                {chef.bio && <p className="fe-chef-bio">{chef.bio}</p>}
            </div>
        </article>
    )
}

function TablePick({ t, selected, onPick }: { t: Table; selected: boolean; onPick: () => void }) {
    const free = t.status === "available"
    return (
        <button
            type="button"
            className={`fe-pick is-${t.status}`}
            aria-pressed={free ? selected : undefined}
            disabled={!free}
            onClick={onPick}
            aria-label={`Table ${t.label}, ${t.seats} seats, ${free ? (selected ? "selected" : "free") : TABLE_STATUS[t.status].toLowerCase()}`}
        >
            <span className="fe-pick-top" aria-hidden="true">
                <span className="fe-pick-label">{t.label}</span>
                {selected && <Icon name="check" size={16} />}
            </span>
            {/* Seats drawn as dots, like chairs on a floor plan (up to 12). */}
            <span className="fe-pick-seats" aria-hidden="true">
                {Array.from({ length: Math.min(t.seats, 12) }, (_, i) => (
                    <span key={i} />
                ))}
            </span>
            <span className="fe-pick-meta" aria-hidden="true">
                {t.seats} seats
            </span>
            <span className="fe-pick-status" aria-hidden="true">
                {selected ? "Your table" : free ? "Free" : TABLE_STATUS[t.status]}
            </span>
        </button>
    )
}

function DishCard({
    item,
    qty,
    forWho,
    onAdd,
    onLess
}: {
    item: MenuItem
    qty: number
    forWho: string | null
    onAdd: () => void
    onLess: () => void
}) {
    return (
        <article className={`fe-dish${item.available ? "" : " is-off"}${qty > 0 ? " is-in" : ""}`}>
            <div className="fe-dish-body">
                <h4 className="fe-dish-name">
                    <VegMark veg={item.veg} />
                    <span>{item.name}</span>
                </h4>
                <p className="fe-dish-meta">
                    <span className="fe-dish-price fe-num">{usdc(item.price)}</span>
                    <SpiceMark level={item.spice} />
                    <span className="fe-dish-time">
                        <span className="sr-only">Ready in about </span>
                        {item.prepMinutes} min
                    </span>
                </p>
                {item.description && <p className="fe-dish-desc">{item.description}</p>}
                <div className="fe-dish-cta">
                    {!item.available ? (
                        <span className="fe-sold">Sold out</span>
                    ) : qty === 0 ? (
                        <button type="button" className="btn btn-sm fe-add" onClick={onAdd} aria-label={`Add ${item.name}${forWho ? ` for ${forWho}` : ""}`}>
                            <Icon name="plus" size={16} />
                            <span className="fe-add-label">{forWho ? `Add for ${forWho}` : "Add"}</span>
                        </button>
                    ) : (
                        <div className="fe-stepper fe-stepper--sm" role="group" aria-label={`${item.name}${forWho ? ` for ${forWho}` : ""}`}>
                            <button type="button" aria-label={`Remove one ${item.name}`} onClick={onLess}>
                                −
                            </button>
                            <output aria-live="polite">{qty}</output>
                            <button type="button" aria-label={`Add one more ${item.name}`} onClick={onAdd} disabled={qty >= MAX_QTY}>
                                +
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <DishImage item={item} />
        </article>
    )
}

function CartLines({
    lines,
    byId,
    guests,
    guestName,
    onQty,
    onMove
}: {
    lines: Line[]
    byId: Map<string, MenuItem>
    guests: number
    guestName: (n: number) => string
    onQty: (l: Line, d: number) => void
    onMove: (l: Line, to: number) => void
}) {
    const groups = Array.from({ length: guests }, (_, i) => i + 1)
        .map((g) => ({ g, ls: lines.filter((l) => l.guest === g) }))
        .filter((x) => x.ls.length > 0)
    return (
        <div className="fe-cart-groups">
            {groups.map(({ g, ls }) => (
                <div key={g} className="fe-cart-group">
                    {guests > 1 && <p className="fe-cart-guest">{guestName(g)}</p>}
                    <ul className="fe-lines">
                        {ls.map((l) => {
                            const item = byId.get(l.id)!
                            return (
                                <li key={`${l.guest}-${l.id}`} className="fe-line">
                                    <span className="fe-line-name">
                                        {item.name}
                                        <span className="fe-line-price fe-num">{usdc(item.price * l.qty)}</span>
                                    </span>
                                    <span className="fe-line-controls">
                                        <span className="fe-stepper fe-stepper--sm" role="group" aria-label={`${item.name} for ${guestName(g)}`}>
                                            <button type="button" aria-label={`Remove one ${item.name}`} onClick={() => onQty(l, -1)}>
                                                −
                                            </button>
                                            <output>{l.qty}</output>
                                            <button type="button" aria-label={`Add one ${item.name}`} onClick={() => onQty(l, 1)} disabled={l.qty >= MAX_QTY}>
                                                +
                                            </button>
                                        </span>
                                        {guests > 1 && (
                                            <select
                                                className="fe-line-move"
                                                aria-label={`Who has the ${item.name}`}
                                                value={l.guest}
                                                onChange={(e) => onMove(l, Number(e.target.value))}
                                            >
                                                {Array.from({ length: guests }, (_, i) => (
                                                    <option key={i} value={i + 1}>
                                                        {guestName(i + 1)}
                                                    </option>
                                                ))}
                                            </select>
                                        )}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            ))}
        </div>
    )
}

type Bill = ReturnType<typeof computeBill>

function Checkout(p: {
    table: Table | null
    guests: number
    setGuests: (n: number) => void
    mode: Mode
    setMode: (m: Mode) => void
    splitBy: SplitBy
    setSplitBy: (s: SplitBy) => void
    names: string[]
    setNames: (fn: (n: string[]) => string[]) => void
    bill: Bill | null
    rate: number
    serviceBps: number
    hasGstin: boolean
    shares: number[] | null
    emptyGuests: number[]
    guestName: (n: number) => string
    privatePayments: boolean
    error: string | null
    placing: boolean
    onBack: () => void
    onPlace: () => void
}) {
    const { table, guests, mode, bill } = p
    // Splitting with friends later needs the payer's wallet on the order, so it must be placed signed in.
    const { me, loading: meLoading } = useSession()
    const signedOut = !me && !meLoading
    return (
        <div className="fe-checkout">
            <div className="fe-check-row">
                <span className="fe-label-sm">Table</span>
                {table ? (
                    <span>
                        <strong>Table {table.label}</strong> · {table.seats} seats
                    </span>
                ) : (
                    <a href="#fe-tables" className="fe-link">
                        Choose a free table
                    </a>
                )}
            </div>
            {table && guests > table.seats && (
                <p className="fe-hint">
                    That's {guests} guests at a table for {table.seats}. Ask the staff if you need a bigger one.
                </p>
            )}

            <div className="fe-stepper-row">
                <span id="fe-guests-l2">Guests</span>
                <div className="fe-stepper" role="group" aria-labelledby="fe-guests-l2">
                    <button type="button" aria-label="One fewer guest" disabled={guests <= 1} onClick={() => p.setGuests(guests - 1)}>
                        −
                    </button>
                    <output aria-live="polite">{guests}</output>
                    <button type="button" aria-label="One more guest" disabled={guests >= MAX_GUESTS} onClick={() => p.setGuests(guests + 1)}>
                        +
                    </button>
                </div>
            </div>

            <fieldset className="fe-choice">
                <legend>Who pays</legend>
                <label className="fe-choice-opt">
                    <input type="radio" name="fe-mode" checked={mode === "one_pays"} onChange={() => p.setMode("one_pays")} />
                    <span>
                        <strong>One person pays the whole bill</strong>
                        <span className="fe-muted">Then split it with friends: they pay you back through FairPay.</span>
                        {signedOut && <span className="fe-hint">Sign in before ordering if you want to split it with friends afterwards.</span>}
                    </span>
                </label>
                <label className={`fe-choice-opt${guests === 1 ? " is-disabled" : ""}`}>
                    <input type="radio" name="fe-mode" checked={mode === "split"} disabled={guests === 1} onChange={() => p.setMode("split")} />
                    <span>
                        <strong>Everyone pays their own share</strong>
                        <span className="fe-muted">
                            {guests === 1 ? "Needs two or more guests." : "Each guest pays the restaurant directly. The kitchen starts when every share is paid."}
                        </span>
                    </span>
                </label>
            </fieldset>

            {mode === "split" && (
                <>
                    <fieldset className="fe-choice fe-choice--inline">
                        <legend>Split by</legend>
                        <label className="fe-choice-opt">
                            <input type="radio" name="fe-splitby" checked={p.splitBy === "items"} onChange={() => p.setSplitBy("items")} />
                            <span>What each person ordered</span>
                        </label>
                        <label className="fe-choice-opt">
                            <input type="radio" name="fe-splitby" checked={p.splitBy === "equal"} onChange={() => p.setSplitBy("equal")} />
                            <span>Equally</span>
                        </label>
                    </fieldset>
                    <details className="fe-names">
                        <summary>Add guest names (optional)</summary>
                        <div className="fe-names-grid">
                            {Array.from({ length: guests }, (_, i) => (
                                <div key={i} className="fe-field">
                                    <label htmlFor={`fe-gn-${i}`}>Guest {i + 1}</label>
                                    <input
                                        id={`fe-gn-${i}`}
                                        value={p.names[i] ?? ""}
                                        maxLength={40}
                                        autoComplete="off"
                                        onChange={(e) =>
                                            p.setNames((n) => {
                                                const c = [...n]
                                                c[i] = e.target.value
                                                return c
                                            })
                                        }
                                    />
                                </div>
                            ))}
                        </div>
                    </details>
                </>
            )}

            {bill && (
                <section aria-labelledby="fe-preview-h" className="fe-preview">
                    <h3 id="fe-preview-h" className="fe-label-sm">
                        Bill preview
                    </h3>
                    <dl className="fe-sum">
                        <div>
                            <dt>Subtotal</dt>
                            <dd>{usdc(bill.subtotal)}</dd>
                        </div>
                        {p.serviceBps > 0 && (
                            <div>
                                <dt>Service charge {percent(p.serviceBps)}</dt>
                                <dd>{usdc(bill.serviceCharge)}</dd>
                            </div>
                        )}
                        {p.hasGstin && p.rate > 0 ? (
                            <>
                                <div>
                                    <dt>CGST {percent(p.rate / 2)}</dt>
                                    <dd>{usdc(bill.cgst)}</dd>
                                </div>
                                <div>
                                    <dt>SGST {percent(p.rate / 2)}</dt>
                                    <dd>{usdc(bill.sgst)}</dd>
                                </div>
                            </>
                        ) : (
                            <div className="fe-sum-note">
                                <dt>GST</dt>
                                <dd>{p.hasGstin ? "0%" : "Not charged (no GSTIN)"}</dd>
                            </div>
                        )}
                        {bill.roundOff !== 0 && (
                            <div>
                                <dt>Round off</dt>
                                <dd>{usdc(bill.roundOff)}</dd>
                            </div>
                        )}
                        <div className="fe-sum-total">
                            <dt>Total</dt>
                            <dd>{usdc(bill.total)}</dd>
                        </div>
                    </dl>
                    {mode === "split" && p.shares && (
                        <ul className="fe-share-preview" aria-label="Each guest pays">
                            {p.shares.map((amt, i) => (
                                <li key={i} className={p.emptyGuests.includes(i + 1) ? "is-empty" : undefined}>
                                    <span>{p.guestName(i + 1)}</span>
                                    <span className="fe-num">{usdc(amt)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="fe-hint">
                        Prices in test USDC on Monad Testnet.
                        {p.privatePayments ? " You can pay confidentially: each note is exactly 5 USDC, and any extra on the last note goes to the restaurant as a tip." : ""}
                    </p>
                </section>
            )}

            {p.error && <Alert>{p.error}</Alert>}
            <div className="fe-checkout-actions">
                <button type="button" className="btn btn-primary btn-block" disabled={p.placing} onClick={p.onPlace}>
                    {p.placing ? "Placing order…" : bill ? `Place order · ${usdc(bill.total)}` : "Place order"}
                </button>
                <button type="button" className="btn btn-quiet btn-block" onClick={p.onBack} disabled={p.placing}>
                    Back to the order
                </button>
            </div>
        </div>
    )
}
