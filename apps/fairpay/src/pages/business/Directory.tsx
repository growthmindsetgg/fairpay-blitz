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

// Cloth tints for restaurants without a cover photo, picked from the name: saffron, purple, teal, rose.
const CLOTH = ["#f2a93b", "#6e54ff", "#1f9e8f", "#e0637f"]

/**
 * A laid table seen from above for restaurants without a cover photo: cloth, plates, cutlery,
 * glasses and a candle, tinted per restaurant. Cuisine-neutral on purpose (no food the restaurant
 * may not serve) and drawn with theme tokens, so it follows light and dark. `wide` is the low
 * storefront banner (one row of places); otherwise a 16:9 card (two rows facing each other).
 */
export function CoverArt({ seed, wide = false }: { seed: string; wide?: boolean }) {
    let h = 0
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    // Unsigned shifts: a signed one goes negative for half of all names.
    const bits = (shift: number, n: number) => (h >>> shift) % n
    const [w, ht] = wide ? [960, 160] : [400, 225]
    const places = wide
        ? Array.from({ length: 6 }, (_, i) => ({ x: 90 + i * 156, y: 80, flip: false }))
        : [52, 173].flatMap((y, row) => [80, 200, 320].map((x) => ({ x, y, flip: row === 1 })))
    const candles = wide ? [168, 480, 792].map((x) => ({ x, y: 80 })) : [{ x: 140, y: 112 }, { x: 260, y: 112 }]
    return (
        <svg
            className="fe-cover-art"
            viewBox={`0 0 ${w} ${ht}`}
            aria-hidden="true"
            focusable="false"
            preserveAspectRatio="xMidYMid slice"
            style={{ ["--cloth" as string]: CLOTH[bits(7, CLOTH.length)] }}
        >
            <defs>
                <pattern id={`fe-weave-${wide ? "w" : "c"}`} width="12" height="12" patternUnits="userSpaceOnUse">
                    <path d="M0 6h12M6 0v12" className="weave" />
                </pattern>
            </defs>
            <rect width={w} height={ht} className="bg" />
            <rect width={w} height={ht} fill={`url(#fe-weave-${wide ? "w" : "c"})`} />
            {wide ? (
                <rect y={ht / 2 - 52} width={w} height="104" className="runner" />
            ) : (
                <rect y={ht / 2 - 26} width={w} height="52" className="runner" />
            )}
            {places.map((p, i) => (
                <g key={i} transform={`translate(${p.x} ${p.y})${p.flip ? " rotate(180)" : ""}`}>
                    <rect x="-52" y="-30" width="18" height="34" rx="3" className="napkin" transform="rotate(-8 -43 -13)" />
                    <circle r="30" className="plate" />
                    <circle r="20" className="plate-in" />
                    <path d="M-40 -18v36M-44 -18v10a4 4 0 0 0 8 0v-10" className="cutlery" />
                    <path d="M40 -18c5 6 5 16 0 22v14" className="cutlery" />
                    <circle cx="44" cy="-30" r="8" className="glass" />
                </g>
            ))}
            {candles.map((c, i) => (
                <g key={i} transform={`translate(${c.x} ${c.y})`}>
                    <circle r="16" className="glow" />
                    <circle r="7" className="candle" />
                    <circle r="2.6" className="flame" />
                </g>
            ))}
        </svg>
    )
}
