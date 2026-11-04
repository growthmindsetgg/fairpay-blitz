import { useCallback, useEffect, useRef, useState } from "react"
import type { Order, RestaurantStats, StatsRange } from "../../../../shared/types"
import { CopyLink, Segmented } from "../../../components"
import { safeStorage } from "../../../lib/wallet"
import { ColumnChart, SplitBar } from "../charts"
import { errorText, fe } from "../client"
import type { TabProps } from "../Manage"
import { bestDayText, busiestText, dayColumns, hourColumns, minutesText, RANGE_LABEL, RANGE_WORDS, usdcAxis } from "../statsView"
import { absoluteUrl, Alert, plural, usdc, usePoll } from "../ui"

const RANGES: StatsRange[] = ["today", "7d", "30d", "mtd"]
// Per browser, a convenience only: the range this person looked at last.
const RANGE_KEY = "fairpay.overviewRange"

function savedRange(): StatsRange {
    const v = safeStorage.get(RANGE_KEY)
    return RANGES.includes(v as StatsRange) ? (v as StatsRange) : "today"
}

export function OverviewTab({ view, goTo, canSee }: TabProps & { goTo: (tab: string) => void; canSee: (tab: string) => boolean }) {
    const r = view.restaurant
    const [orders, setOrders] = useState<Order[] | null>(null)
    const [range, setRange] = useState<StatsRange>(savedRange)
    const [stats, setStats] = useState<RestaurantStats | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    // The latest request wins, so a slow answer for the old range never replaces the new one.
    const asked = useRef(0)

    // Live orders, only for the kitchen callout.
    const loadOrders = useCallback(async () => {
        try {
            setOrders(await fe.orders(r.id, "active"))
        } catch {
            /* the callout just stays hidden */
        }
    }, [r.id])
    usePoll(loadOrders, 30_000)

    const loadStats = useCallback(async () => {
        const n = ++asked.current
        setLoading(true)
        try {
            const s = await fe.stats(r.id, range)
            if (n !== asked.current) return
            setStats(s)
            setError(null)
        } catch (e) {
            if (n === asked.current) setError(errorText(e))
        } finally {
            if (n === asked.current) setLoading(false)
        }
    }, [r.id, range])
    usePoll(loadStats, 60_000)
    // usePoll keeps its first schedule; a new range loads straight away.
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        void loadStats()
    }, [loadStats])

    const pickRange = (v: StatsRange) => {
        setRange(v)
        safeStorage.set(RANGE_KEY, v)
    }

    const count = (s: string) => view.tables.filter((t) => t.status === s).length
    const total = view.tables.length
    const available = count("available")
    const occupied = count("occupied")
    const held = count("reserved") + count("closed")
    const active = (orders ?? []).filter((o) => o.status === "paid" || o.status === "cooking" || o.status === "ready").length

    const todo: { text: string; tab: string }[] = []
    if (view.menu.length === 0) todo.push({ text: "Add your first dishes so guests can order.", tab: "menu" })
    if (total === 0) todo.push({ text: "Set up tables. Guests pick one when they order.", tab: "tables" })
    if (view.chefs.length === 0) todo.push({ text: "Add a chef profile. Guests see who is cooking.", tab: "chefs" })
    if (!r.gstin) todo.push({ text: "Add a GSTIN to issue Tax Invoices instead of Bills of Supply.", tab: "settings" })

    const storefront = absoluteUrl(`/r/${r.slug}`)

    return (
        <div className="fe-stack">
            <h2 className="sr-only">Overview</h2>
            <dl className="fe-stats">
                <div>
                    <dt>Tables</dt>
                    <dd>{total}</dd>
                </div>
                <div>
                    <dt>Free now</dt>
                    <dd>{available}</dd>
                </div>
                <div>
                    <dt>Occupied</dt>
                    <dd>{occupied}</dd>
                    {held > 0 && <span className="fe-stat-note">{held} reserved or closed</span>}
                </div>
            </dl>

            {active > 0 && canSee("kitchen") && (
                <p className="fe-callout">
                    {plural(active, "order")} in the kitchen right now.{" "}
                    <button type="button" className="fe-link" onClick={() => goTo("kitchen")}>
                        Open the kitchen board
                    </button>
                </p>
            )}

            <section className="fe-sales" aria-labelledby="fe-sales-h">
                <div className="fe-sales-head">
                    <h3 id="fe-sales-h" className="fe-h2">
                        Sales
                    </h3>
                    <Segmented label="Period" hideLabel value={range} onChange={pickRange} options={RANGES.map((k) => ({ value: k, label: RANGE_LABEL[k] }))} />
                </div>
                {error && (
                    <div className="fe-row-between">
                        <Alert>The sales numbers didn't load: {error}</Alert>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadStats()}>
                            Try again
                        </button>
                    </div>
                )}
                {stats ? (
                    // While another range loads, the last numbers stay, dimmed, so nothing jumps.
                    <div className={`fe-sales-body${loading && stats.range !== range ? " is-stale" : ""}`} aria-busy={loading || undefined}>
                        <Sales stats={stats} demo={r.isDemo} />
                    </div>
                ) : (
                    !error && <p className="fe-muted">Counting…</p>
                )}
            </section>

            {todo.length > 0 && (view.role === "owner" || view.role === "manager") && (
                <section className="fe-todo" aria-labelledby="fe-todo-h">
                    <h3 id="fe-todo-h" className="fe-h3">
                        Finish setting up
                    </h3>
                    <ul>
                        {todo.map((t) => (
                            <li key={t.tab}>
                                <span>{t.text}</span>
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => goTo(t.tab)}>
                                    Go to {t.tab}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="fe-share" aria-labelledby="fe-share-h">
                <h3 id="fe-share-h" className="fe-h3">
                    Storefront
                </h3>
                <p>Guests order from this page. Put the link on a table card or a QR code.</p>
                <CopyLink url={storefront} label="Storefront link" />
            </section>
        </div>
    )
}

function Sales({ stats: s, demo }: { stats: RestaurantStats; demo: boolean }) {
    const words = RANGE_WORDS[s.range]
    const topQty = Math.max(1, ...s.topDishes.map((d) => d.qty))
    return (
        <div className="fe-stack">
            <dl className="fe-stats">
                <div className="fe-stat-wide">
                    <dt>Revenue</dt>
                    <dd className="fe-num">{usdc(s.revenue)}</dd>
                    <span className="fe-stat-note">Paid orders, GST included, before payouts</span>
                </div>
                <div>
                    <dt>Paid orders</dt>
                    <dd>{s.orders}</dd>
                    {s.awaitingPayment > 0 && <span className="fe-stat-note">{s.awaitingPayment} awaiting payment</span>}
                </div>
                <div>
                    <dt>Average order</dt>
                    {/* To the cent: the micro-USDC the server keeps are noise on a tile. */}
                    <dd className="fe-num">{usdc(Math.round(s.averageOrder / 10_000) * 10_000)}</dd>
                </div>
                <div>
                    <dt>Guests</dt>
                    <dd>{s.guests}</dd>
                    {s.orders > 0 && <span className="fe-stat-note">{(s.guests / s.orders).toFixed(1)} per order</span>}
                </div>
                <div>
                    <dt>Cancelled</dt>
                    <dd>{s.cancelled.count}</dd>
                    <span className="fe-stat-note">
                        {s.cancelled.count > 0 ? `${usdc(s.cancelled.value)} not taken` : `of ${plural(s.placed, "order")} placed`}
                    </span>
                </div>
            </dl>
            {demo && <p className="fe-hint">The demo's sample orders were never paid, so they aren't counted here.</p>}

            {s.money && (
                <section className="fe-sales-card" aria-labelledby="fe-paid-h">
                    <h4 id="fe-paid-h" className="fe-h3">
                        How these orders were paid
                    </h4>
                    {s.money.payments === 0 ? (
                        <p className="fe-muted">No on-chain payments for orders placed {words}.</p>
                    ) : (
                        <>
                            <SplitBar
                                parts={[
                                    { key: "public", label: "Public", value: s.money.public, text: usdc(s.money.public), tone: "public" },
                                    { key: "private", label: "Confidential", value: s.money.confidential, text: usdc(s.money.confidential), tone: "private" }
                                ]}
                            />
                            <p className="fe-hint">
                                {plural(s.money.payments, "payment")}, {usdc(s.money.tips)} of it tips from rounding up to whole private notes. Only
                                you see this, as in Payments.
                            </p>
                        </>
                    )}
                </section>
            )}

            <div className="fe-sales-charts">
                {s.range !== "today" && (
                    <div className="fe-sales-card">
                        <ColumnChart title="Revenue by day" columns={dayColumns(s.days)} summary={bestDayText(s.days)} axis={usdcAxis} valueHead="Revenue" />
                    </div>
                )}
                <div className="fe-sales-card">
                    <ColumnChart
                        title="Busiest hours (India time)"
                        columns={hourColumns(s.hours)}
                        summary={busiestText(s.hours)}
                        axis={(v) => plural(v, "order")}
                        valueHead="Paid orders"
                    />
                </div>
            </div>

            <section className="fe-sales-card" aria-labelledby="fe-top-h">
                <h4 id="fe-top-h" className="fe-h3">
                    Top dishes
                </h4>
                {s.topDishes.length === 0 ? (
                    <p className="fe-muted">Nothing sold {words} yet.</p>
                ) : (
                    <table className="fe-top">
                        <thead>
                            <tr>
                                <th scope="col">Dish</th>
                                <th scope="col">Sold</th>
                                <th scope="col">Revenue</th>
                            </tr>
                        </thead>
                        <tbody>
                            {s.topDishes.map((d) => (
                                <tr key={d.itemId}>
                                    <th scope="row">
                                        <span className="fe-top-name">{d.name}</span>
                                        <span className="fe-top-bar" aria-hidden="true">
                                            <span style={{ width: `${(d.qty / topQty) * 100}%` }} />
                                        </span>
                                    </th>
                                    <td className="fe-num">{d.qty}</td>
                                    <td className="fe-num">{usdc(d.revenue)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {s.topDishes.length > 0 && <p className="fe-hint">Revenue here is the dishes' menu prices, before GST.</p>}
            </section>

            <section className="fe-sales-card" aria-labelledby="fe-turn-h">
                <h4 id="fe-turn-h" className="fe-h3">
                    Table turnover
                </h4>
                <dl className="fe-facts fe-turn">
                    <div>
                        <dt>Order to paid</dt>
                        <dd className="fe-num">{minutesText(s.turnover.toPaidMinutes)}</dd>
                    </div>
                    <div>
                        <dt>Order to served</dt>
                        <dd className="fe-num">{minutesText(s.turnover.toServedMinutes)}</dd>
                    </div>
                    <div>
                        <dt>Turns per table</dt>
                        <dd className="fe-num">{s.turnover.turnsPerTable === null ? "–" : s.turnover.turnsPerTable.toFixed(1)}</dd>
                    </div>
                </dl>
                <p className="fe-hint">
                    Averages over orders placed {words}: {plural(s.orders, "paid order")}, {s.turnover.served} served.
                </p>
            </section>
        </div>
    )
}
