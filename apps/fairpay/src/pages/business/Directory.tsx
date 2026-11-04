import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { Restaurant } from "../../../shared/types"
import { useTitle } from "../../components"
import { useMe } from "../../lib/wallet"
import "../../styles/business.css"
import { errorText, fe } from "./client"
import { mediaUrl } from "../../lib/base"
import { Alert, Chip, Loading } from "./ui"

const ROLE: Record<string, string> = { owner: "Owner", manager: "Manager", chef: "Chef", waiter: "Waiter" }

export function Directory() {
    useTitle("FairEats")
    const me = useMe()
    const [list, setList] = useState<Restaurant[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(() => {
        setError(null)
        fe.restaurants().then(setList, (e) => setError(errorText(e)))
    }, [])
    useEffect(load, [load])

    const mine = me?.restaurants ?? []

    return (
        <div className="fe fe-page">
            <header className="fe-head">
                <div>
                    <h1>FairEats</h1>
                    <p className="fe-lead">
                        Restaurants that take FairPay. Order at the table, split the bill your way, and get a GST invoice.
                    </p>
                </div>
                <Link className="btn btn-primary" to="/business/faireats/new">
                    Register your restaurant
                </Link>
            </header>

            {mine.length > 0 && (
                <section className="fe-mine" aria-labelledby="fe-mine-h">
                    <h2 id="fe-mine-h" className="fe-h3">
                        Your restaurants
                    </h2>
                    <ul className="fe-mine-list">
                        {mine.map((r) => (
                            <li key={r.id}>
                                <Link to={`/business/faireats/manage/${r.id}`} className="fe-mine-card">
                                    <span className="fe-mine-name">{r.name}</span>
                                    <span className="fe-mine-meta">
                                        <Chip tone="muted">{ROLE[r.role] ?? r.role}</Chip>
                                        <span>Manage</span>
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section aria-labelledby="fe-dir-h" className="fe-section">
                <h2 id="fe-dir-h" className="fe-h2">
                    Restaurants
                </h2>
                {error ? (
                    <div className="fe-state">
                        <Alert>The restaurant list didn't load: {error}</Alert>
                        <button className="btn btn-secondary" onClick={load}>
                            Try again
                        </button>
                    </div>
                ) : list === null ? (
                    <Loading label="Loading restaurants…" />
                ) : list.length === 0 ? (
                    <div className="fe-empty">
                        <h3>No restaurants yet</h3>
                        <p>Be the first. Registering takes a couple of minutes and you can add the menu after.</p>
                        <Link className="btn btn-primary" to="/business/faireats/new">
                            Register your restaurant
                        </Link>
                    </div>
                ) : (
                    <ul className="fe-cards">
                        {list.map((r) => (
                            <li key={r.id}>
                                <RestaurantCard r={r} />
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    )
}

function RestaurantCard({ r }: { r: Restaurant }) {
    const [broken, setBroken] = useState(false)
    const where = [r.cuisine, r.city].filter(Boolean).join(" · ")
    const { total, available } = r.tables
    return (
        <article className="fe-card">
            <div className="fe-card-cover">
                {r.coverImage && !broken ? (
                    <img src={mediaUrl(r.coverImage)} alt="" loading="lazy" decoding="async" width={640} height={360} onError={() => setBroken(true)} />
                ) : (
                    <CoverArt seed={r.name} />
                )}
            </div>
            <div className="fe-card-body">
                <h3 className="fe-card-title">
                    <Link to={`/r/${r.slug}`} className="fe-stretch">
                        {r.name}
                    </Link>
                </h3>
                {where && <p className="fe-card-where">{where}</p>}
                {r.tagline && <p className="fe-card-tag">{r.tagline}</p>}
                <p className="fe-card-tables">
                    <span className={`fe-dot ${available > 0 ? "is-free" : "is-full"}`} aria-hidden="true" />
                    {total === 0 ? "No tables set up yet" : available === 0 ? `All ${total} tables taken` : `${available} of ${total} tables free`}
                </p>
                <div className="fe-card-badges">
                    {r.privatePayments && <Chip tone="violet">Confidential payments</Chip>}
                    {r.isDemo && <Chip tone="muted">Demo</Chip>}
                </div>
            </div>
        </article>
    )
}

/**
 * A floor-plan pattern for restaurants without a cover photo: tables and chairs, never a stock
 * image. `wide` is a low banner (the storefront header) with the tables in a loose row.
 */
export function CoverArt({ seed, wide = false }: { seed: string; wide?: boolean }) {
    let h = 0
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    // Unsigned shifts: a signed one goes negative for half of all names and puts tables off the canvas.
    const bits = (shift: number, n: number) => (h >>> shift) % n
    const [w, ht] = wide ? [960, 160] : [400, 225]
    const tables = wide
        ? Array.from({ length: 8 }, (_, i) => ({ x: 60 + i * 120 + bits(i * 3, 3) * 15, y: 50 + bits(i * 4, 3) * 30 }))
        : Array.from({ length: 5 }, (_, i) => ({ x: 50 + i * 75 + bits(i * 3, 3) * 10, y: 50 + bits(i * 5, 3) * 60 }))
    return (
        <svg className="fe-cover-art" viewBox={`0 0 ${w} ${ht}`} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
            <rect width={w} height={ht} className="bg" />
            {tables.map((t, i) => (
                <g key={i} transform={`translate(${t.x} ${t.y})`}>
                    <circle r="15" className={i === 1 ? "table hero" : "table"} />
                    {[0, 90, 180, 270].map((a) => (
                        <rect key={a} x="-6" y="-29" width="12" height="8" rx="3" className="chair" transform={`rotate(${a})`} />
                    ))}
                </g>
            ))}
        </svg>
    )
}
