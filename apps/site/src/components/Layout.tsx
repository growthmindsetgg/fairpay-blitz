import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { APP_URL, DEMO_TABLE_URL, addressUrl, CONTRACTS } from "../data"
import { useDismissableDetails, useScrolledPast } from "../lib/hooks"
import Logo from "./Logo"
import { Ext } from "./Ext"

// In the order the sections appear on the landing page.
const NAV = [
    { to: "/#product", id: "product", label: "Product" },
    { to: "/#faireats", id: "faireats", label: "FairEats" },
    { to: "/#privacy", id: "privacy", label: "Privacy" },
    { to: "/guide", id: "guide", label: "Guide" }
]

/** On the landing page, which nav section is in view. */
function useSectionInView(enabled: boolean) {
    const [inView, setInView] = useState<string | undefined>(undefined)
    useEffect(() => {
        if (!enabled || typeof IntersectionObserver === "undefined") {
            setInView(undefined)
            return
        }
        const ids = NAV.filter((n) => n.id !== "guide").map((n) => n.id)
        const seen = new Map<string, boolean>()
        const io = new IntersectionObserver(
            (entries) => {
                for (const e of entries) seen.set(e.target.id, e.isIntersecting)
                setInView(ids.find((id) => seen.get(id)))
            },
            { rootMargin: "-45% 0px -50% 0px" }
        )
        for (const id of ids) {
            const el = document.getElementById(id)
            if (el) io.observe(el)
        }
        return () => io.disconnect()
    }, [enabled])
    return inView
}

function NavLinks({ current }: { current: (id: string) => "page" | "true" | undefined }) {
    return (
        <ul>
            {NAV.map((n) => (
                <li key={n.to}>
                    <Link to={n.to} aria-current={current(n.id)}>
                        {n.label}
                    </Link>
                </li>
            ))}
        </ul>
    )
}

/** Always in the header, on every page: everything here runs on Monad Testnet with test USDC. */
function TestnetPill() {
    return (
        <span className="testnet-pill">
            <span className="testnet-dot" aria-hidden="true" />
            Testnet
            <span className="sr-only">: Monad Testnet, test USDC only, unaudited</span>
        </span>
    )
}

function Header() {
    const menu = useRef<HTMLDetailsElement>(null)
    const location = useLocation()
    const scrolled = useScrolledPast(8)
    const [open, setOpen] = useState(false)
    const onLanding = location.pathname === "/"
    const inView = useSectionInView(onLanding)
    useDismissableDetails(menu)

    // Close the phone menu after any navigation.
    useEffect(() => {
        if (menu.current) menu.current.open = false
    }, [location])

    const current = (id: string) => {
        if (id === "guide") return location.pathname.startsWith("/guide") ? "page" : undefined
        return onLanding && inView === id ? "true" : undefined
    }

    return (
        <header className={`site-head${scrolled ? " is-scrolled" : ""}`}>
            <a className="skip" href="#main">
                Skip to content
            </a>
            <div className="wrap head-row">
                <div className="head-brand">
                    <Link to="/" className="brand" aria-label="FairPay home">
                        <Logo variant="full" tone="dark" size={28} title={null} className="brand-full" />
                        <Logo variant="mark" tone="dark" size={28} title={null} className="brand-mark" />
                    </Link>
                    <TestnetPill />
                </div>
                <nav className="nav-desk" aria-label="Main">
                    <NavLinks current={current} />
                    <a className="btn-primary btn-head" href={APP_URL}>
                        Open app
                    </a>
                </nav>
                <div className="head-phone">
                    <a className="btn-primary btn-head-phone" href={APP_URL}>
                        Open app
                    </a>
                    <details className="nav-phone" ref={menu} onToggle={(e) => setOpen(e.currentTarget.open)}>
                        <summary>{open ? "Close" : "Menu"}</summary>
                        <nav aria-label="Main">
                            <NavLinks current={current} />
                            <p className="nav-phone-note">
                                The app runs on a free server: the first visit can take about 50 seconds to wake it.
                            </p>
                            <a className="btn-secondary btn-block" href={DEMO_TABLE_URL}>
                                Try the simulated demo
                            </a>
                        </nav>
                    </details>
                </div>
            </div>
        </header>
    )
}

const ROUTER = CONTRACTS.find((c) => c.name === "FairPay router")!

function Footer() {
    return (
        <footer className="site-foot">
            <div className="wrap">
                <div className="foot-grid">
                    <div className="foot-brand">
                        <Logo variant="full" tone="dark" size={24} title="FairPay" />
                        <p>Split bills with friends and pay restaurants privately, on Monad Testnet.</p>
                        <p className="foot-cta">
                            <a className="btn-primary" href={APP_URL}>
                                Open FairPay
                            </a>
                        </p>
                    </div>
                    <nav className="foot-col foot-product" aria-labelledby="foot-product">
                        <h2 id="foot-product">Product</h2>
                        <ul>
                            <li>
                                <Link to="/#product">Bill splitting</Link>
                            </li>
                            <li>
                                <Link to="/#faireats">FairEats for restaurants</Link>
                            </li>
                            <li>
                                <Link to="/#privacy">Private payments</Link>
                            </li>
                            <li>
                                <Link to="/#proof">Proof on Monad Testnet</Link>
                            </li>
                            <li>
                                <a href={DEMO_TABLE_URL}>Simulated table demo</a>
                            </li>
                        </ul>
                    </nav>
                    <nav className="foot-col foot-guide" aria-labelledby="foot-guide">
                        <h2 id="foot-guide">Guide</h2>
                        <ul>
                            <li>
                                <Link to="/guide/start">Get started</Link>
                            </li>
                            <li>
                                <Link to="/guide/how-it-works">How it works</Link>
                            </li>
                            <li>
                                <Link to="/guide/run">Run it locally</Link>
                            </li>
                            <li>
                                <Link to="/guide/sdk">Use the SDK</Link>
                            </li>
                            <li>
                                <Link to="/guide/faq">FAQ and glossary</Link>
                            </li>
                        </ul>
                    </nav>
                    <nav className="foot-col foot-project" aria-labelledby="foot-project">
                        <h2 id="foot-project">Project</h2>
                        <ul>
                            <li>
                                <Link to="/about">About FairPay</Link>
                            </li>
                            <li>
                                <Link to="/about#privacy">Privacy</Link>
                            </li>
                            <li>
                                <Link to="/guide/security">Security and limitations</Link>
                            </li>
                            <li>
                                <Ext href={addressUrl(ROUTER.address)} hint="FairPay router on the Monad explorer">
                                    Contracts on the explorer
                                </Ext>
                            </li>
                            <li>
                                <Link to="/guide/security#reporting">Report a problem</Link>
                            </li>
                            <li>
                                <a href="/brand/BRAND.md">Brand files</a>
                            </li>
                        </ul>
                    </nav>
                </div>
                <div className="legal">
                    <p className="legal-indep">Independent project. Not affiliated with or endorsed by the Monad Foundation.</p>
                    <p>
                        Monad Testnet (chain 10143) · Test USDC only · Unaudited testnet software. No real funds. Saffron
                        Table is a demo restaurant.
                    </p>
                </div>
            </div>
        </footer>
    )
}

/** Scroll to the hash after navigation; on a new page, start at the top and move focus to main. */
function ScrollManager() {
    const { pathname, hash } = useLocation()
    const lastPath = useRef(pathname)

    useEffect(() => {
        const pageChanged = lastPath.current !== pathname
        lastPath.current = pathname
        if (hash) {
            const id = decodeURIComponent(hash.slice(1))
            let tries = 0
            // Wait for the new page (or a lazy guide chunk) to render.
            const find = () => {
                const el = document.getElementById(id)
                if (!el) {
                    if (tries++ < 20) window.setTimeout(find, 50)
                    return
                }
                el.scrollIntoView()
                if (pageChanged) {
                    const h = el.matches("h1,h2,h3") ? el : el.querySelector("h1,h2,h3")
                    if (h instanceof HTMLElement) {
                        if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1")
                        h.focus({ preventScroll: true })
                    }
                }
            }
            window.setTimeout(find, 0)
        } else if (pageChanged) {
            window.scrollTo(0, 0)
            document.getElementById("main")?.focus({ preventScroll: true })
        }
    }, [pathname, hash])
    return null
}

export function Layout({ children }: { children: ReactNode }) {
    return (
        <>
            <ScrollManager />
            <Header />
            <main id="main" tabIndex={-1}>
                {children}
            </main>
            <Footer />
        </>
    )
}
