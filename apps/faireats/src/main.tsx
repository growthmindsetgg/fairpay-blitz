import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes } from "react-router-dom"
import { api, type PublicConfig } from "./api"
import { KitchenPage } from "./pages/Kitchen"
import { MenuPage } from "./pages/Menu"
import { OrderPage } from "./pages/Order"
import { WalletPage } from "./pages/Wallet"
import { WalletProvider, useWallet } from "./wallet"
import "./styles.css"

// The static demo build (VITE_DEMO=1) seeds its simulated state before the first render and adds
// the demo banner and receipt pages. Constant `undefined` in the real build.
const demo = import.meta.env.VITE_DEMO === "1" ? await import("./demo") : undefined
demo?.installDemo()

/** "/app" when the app is served under /app/, "" at the root. */
const basename = import.meta.env.BASE_URL.replace(/\/$/, "")

function TopBar() {
    const { cfg, wallet, balances } = useWallet()
    return (
        <header className="topbar">
            <a className="skip" href="#main">
                Skip to content
            </a>
            <div className="wrap">
                <Link to="/" className="wordmark">
                    <span className="sun" aria-hidden="true" />
                    {cfg.restaurant.name}
                </Link>
                <Link to="/wallet" className="wallet-chip">
                    {wallet ? (
                        <>
                            {balances && <span className="bal">{(Number(balances.usdc) / 1e6).toFixed(0)} USDC</span>}
                            <span className="addr">
                                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                            </span>
                        </>
                    ) : (
                        <span className="addr">Set up wallet</span>
                    )}
                </Link>
            </div>
        </header>
    )
}

function Footer() {
    const { cfg } = useWallet()
    return (
        <footer className="site">
            <div className="wrap">
                <span>
                    {demo
                        ? "Demo: payments are simulated in your browser. No real money moves."
                        : "Payments run on Monad Testnet with test USDC. No real money moves."}
                </span>
                <span>
                    <a href={`${demo ? demo.REAL.explorer : cfg.explorer}/address/${cfg.pool}`} target="_blank" rel="noreferrer">
                        {demo ? "Real privacy pool contract on Monad Testnet" : "Privacy pool contract"}
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>{" "}
                    · <Link to="/kitchen">Kitchen</Link>
                </span>
            </div>
        </footer>
    )
}

function Shell() {
    const [cfg, setCfg] = useState<PublicConfig | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        api.config().then(setCfg, (e: Error) => setError(e.message))
    }, [])
    if (error)
        return (
            <main className="wrap page" id="main">
                <h1>The restaurant is offline</h1>
                <p>{error} Start the server with npm run dev, then reload.</p>
            </main>
        )
    if (!cfg)
        return (
            <p className="sr-only" role="status">
                Loading…
            </p>
        )
    return (
        <WalletProvider cfg={cfg}>
            <Routes>
                <Route path="/kitchen" element={<KitchenPage />} />
                <Route
                    path="*"
                    element={
                        <>
                            <TopBar />
                            <Routes>
                                <Route path="/" element={<MenuPage />} />
                                <Route path="/order/:id" element={<OrderPage />} />
                                <Route path="/wallet" element={<WalletPage />} />
                                {demo && <Route path="/explorer/*" element={<demo.DemoExplorer />} />}
                                <Route
                                    path="*"
                                    element={
                                        <main className="wrap page" id="main">
                                            <h1>Nothing on this page</h1>
                                            <Link to="/">Back to the menu</Link>
                                        </main>
                                    }
                                />
                            </Routes>
                            <Footer />
                        </>
                    }
                />
            </Routes>
        </WalletProvider>
    )
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <BrowserRouter basename={basename || undefined}>
            {demo && <demo.DemoBanner />}
            <Shell />
        </BrowserRouter>
    </StrictMode>
)
