import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react"
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom"
import { Icon, type IconName } from "./components/Icon"
import { Logo } from "./components/Logo"
import { MerchantLanding } from "./components/MerchantLanding"
import { Loading } from "./components/Page"
import { ProfilePrompt } from "./components/ProfilePrompt"
import { WalletButton } from "./components/WalletButton"
import { api } from "./lib/api"
import { useWallet } from "./lib/wallet"
import { Home } from "./pages/Home"

// Pages load on demand so the first paint only needs the shell and Home.
const NewBill = lazy(() => import("./pages/NewBill").then((m) => ({ default: m.NewBill })))
const BillPage = lazy(() => import("./pages/Bill").then((m) => ({ default: m.BillPage })))
const Requests = lazy(() => import("./pages/Requests").then((m) => ({ default: m.Requests })))
const Friends = lazy(() => import("./pages/Friends").then((m) => ({ default: m.Friends })))
const Activity = lazy(() => import("./pages/Activity").then((m) => ({ default: m.Activity })))
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })))
const NotFound = lazy(() => import("./pages/NotFound").then((m) => ({ default: m.NotFound })))

// Business platform pages (Builder E). import.meta.glob resolves at build time, so a page that
// doesn't exist yet shows a fallback instead of breaking the build.
const businessModules = import.meta.glob("./pages/business/*.tsx") as Record<string, () => Promise<Record<string, unknown>>>

function ComingSoon() {
    return (
        <div className="content">
            <div className="notfound">
                <h1 className="page-title">This page isn't ready yet</h1>
                <p className="muted">It's part of FairEats and is still being built. Try again after the next update.</p>
                <Link className="btn btn-secondary" to="/business/faireats">
                    Back to FairEats
                </Link>
            </div>
        </div>
    )
}

function business(file: string, name: string) {
    return lazy(async () => {
        const load = businessModules[`./pages/business/${file}.tsx`]
        if (!load) return { default: ComingSoon }
        const mod = await load()
        const C = mod[name] as ComponentType | undefined
        return { default: C ?? ComingSoon }
    })
}

const Directory = business("Directory", "Directory")
const Register = business("Register", "Register")
const Manage = business("Manage", "Manage")
const Storefront = business("Storefront", "Storefront")
const OrderPage = business("OrderPage", "OrderPage")
const InvoicePage = business("InvoicePage", "InvoicePage")

// ------------------------------------------------------------------ navigation model

type NavItem = { to: string; label: string; icon: IconName; end?: boolean; sub?: string }

const SPLIT_NAV: NavItem[] = [
    { to: "/", label: "Home", icon: "home", end: true },
    { to: "/bills/new", label: "New bill", icon: "plus" },
    { to: "/requests", label: "Requests", icon: "inbox" },
    { to: "/friends", label: "Friends", icon: "users" },
    { to: "/activity", label: "Activity", icon: "bell" }
]

/** Business platforms built on FairPay. Add new ones here; the sidebar lists them in order. */
const PLATFORMS: NavItem[] = [{ to: "/business/faireats", label: "FairEats", sub: "Restaurants", icon: "store" }]

function useUnread() {
    const { me } = useWallet()
    const { pathname } = useLocation()
    const [count, setCount] = useState(0)
    useEffect(() => {
        if (!me) {
            setCount(0)
            return
        }
        let live = true
        api.activity()
            .then((items) => live && setCount(items.filter((i) => !i.read).length))
            .catch(() => undefined)
        return () => {
            live = false
        }
        // Re-count on navigation: cheap, and it catches marks made on the Activity page.
    }, [me, pathname])
    return count
}

function Sidebar({ unread }: { unread: number }) {
    const { me, cfg } = useWallet()
    const { pathname } = useLocation()
    return (
        <aside className="sidebar" aria-label="Main">
            <Link to="/" className="brand" aria-label="FairPay home">
                <Logo variant="full" size={26} title={null} className="fp-logo--theme" />
            </Link>
            <Link to="/bills/new" className="btn btn-primary sidebar-new">
                <Icon name="plus" size={18} />
                New bill
            </Link>
            <nav aria-label="Primary">
                <div className="nav-section">
                    <h2 className="nav-heading">Split</h2>
                    <ul className="nav-list">
                        {SPLIT_NAV.filter((n) => n.to !== "/bills/new").map((n) => (
                            <li key={n.to}>
                                <NavLink to={n.to} end={n.end} className="nav-link">
                                    <Icon name={n.icon} />
                                    <span className="nav-text">{n.label}</span>
                                    {n.to === "/activity" && unread > 0 && (
                                        <span className="nav-badge">
                                            {unread > 99 ? "99+" : unread}
                                            <span className="sr-only"> unread</span>
                                        </span>
                                    )}
                                </NavLink>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="nav-section">
                    <h2 className="nav-heading">Business</h2>
                    <ul className="nav-list">
                        {PLATFORMS.map((p) => (
                            <li key={p.to}>
                                {/* A restaurant's Manage page has its own entry below, so only that one is marked current. */}
                                <NavLink to={p.to} className="nav-link" aria-current={pathname.startsWith(`${p.to}/manage/`) ? false : "page"}>
                                    <Icon name={p.icon} />
                                    <span className="nav-text">
                                        <span>{p.label}</span>
                                        {p.sub && <span className="nav-sub">{p.sub}</span>}
                                    </span>
                                </NavLink>
                            </li>
                        ))}
                        {me?.restaurants.map((r) => (
                            <li key={r.id}>
                                <NavLink to={`/business/faireats/manage/${encodeURIComponent(r.id)}`} className="nav-link">
                                    <Icon name="receipt" />
                                    <span className="nav-text">
                                        <span>{r.name}</span>
                                        <span className="nav-sub">Manage · {r.role}</span>
                                    </span>
                                </NavLink>
                            </li>
                        ))}
                    </ul>
                </div>
            </nav>
            <div className="sidebar-foot">
                <WalletButton placement="up" />
                <p className="sidebar-net">
                    {cfg.chainName || "Monad Testnet"} · test USDC only
                </p>
            </div>
        </aside>
    )
}

function TopBar({ unread }: { unread: number }) {
    const { me } = useWallet()
    return (
        <header className="topbar">
            <Link to="/" className="brand" aria-label="FairPay home">
                <Logo variant="full" size={22} title={null} className="fp-logo--theme" />
            </Link>
            <div className="topbar-actions">
                {me && (
                    <NavLink to="/activity" className="icon-link" aria-label={unread ? `Activity, ${unread} unread` : "Activity"}>
                        <Icon name="bell" />
                        {unread > 0 && (
                            <span className="nav-badge" aria-hidden="true">
                                {unread > 9 ? "9+" : unread}
                            </span>
                        )}
                    </NavLink>
                )}
                <WalletButton compact />
            </div>
        </header>
    )
}

function BottomNav() {
    const items: (NavItem & { cls?: string })[] = [
        { to: "/", label: "Home", icon: "home", end: true },
        { to: "/requests", label: "Requests", icon: "inbox" },
        { to: "/bills/new", label: "New bill", icon: "plus", cls: "bottomnav-new" },
        { to: "/friends", label: "Friends", icon: "users" },
        { to: "/business/faireats", label: "FairEats", icon: "store" }
    ]
    return (
        <nav className="bottomnav" aria-label="Primary">
            <ul>
                {items.map((n) => (
                    <li key={n.to}>
                        <NavLink to={n.to} end={n.end} className={n.cls}>
                            <Icon name={n.icon} size={22} />
                            <span>{n.label}</span>
                        </NavLink>
                    </li>
                ))}
            </ul>
        </nav>
    )
}

function Footer() {
    return (
        <footer className="app-foot">
            <p className="app-foot-slogan">Split fairly. Pay privately.</p>
        </footer>
    )
}

/** Moves focus to the main region after client-side navigation, so screen readers start at the new page. */
function useRouteFocus() {
    const { pathname } = useLocation()
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        window.scrollTo(0, 0)
        document.getElementById("main")?.focus({ preventScroll: true })
    }, [pathname])
}

export function App() {
    const unread = useUnread()
    useRouteFocus()
    return (
        <div className="shell">
            <a className="skip-link" href="#main">
                Skip to content
            </a>
            <Sidebar unread={unread} />
            <TopBar unread={unread} />
            <main id="main" className="main" tabIndex={-1}>
                <Suspense
                    fallback={
                        <div className="content">
                            <Loading />
                        </div>
                    }
                >
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/bills/new" element={<NewBill />} />
                        <Route path="/bills/:id" element={<BillPage />} />
                        <Route path="/b/:token" element={<BillPage />} />
                        <Route path="/requests" element={<Requests />} />
                        <Route path="/friends" element={<Friends />} />
                        <Route path="/activity" element={<Activity />} />
                        <Route path="/profile" element={<Profile />} />
                        <Route path="/business/faireats" element={<Directory />} />
                        <Route path="/business/faireats/new" element={<Register />} />
                        <Route path="/business/faireats/manage/:id" element={<Manage />} />
                        <Route path="/r/:slug" element={<Storefront />} />
                        <Route path="/o/:id" element={<OrderPage />} />
                        <Route path="/i/:token" element={<InvoicePage />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </Suspense>
                <Footer />
            </main>
            <BottomNav />
            <ProfilePrompt />
            <MerchantLanding />
        </div>
    )
}
