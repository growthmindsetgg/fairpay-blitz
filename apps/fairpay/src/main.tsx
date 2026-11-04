import { StrictMode, useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import type { PublicConfig } from "../shared/types"
import { App } from "./App"
import { friendly } from "./components/errors"
import { Logo } from "./components/Logo"
import { WalletPicker } from "./components/WalletButton"
import { api, ApiError, isUnreachable } from "./lib/api"
import { ROUTER_BASENAME } from "./lib/base"
import { applyTheme, readTheme } from "./lib/theme"
import { WalletProvider } from "./lib/wallet"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/components.css"
import "./styles/app.css"

/** A free server that slept usually answers within a minute; give up and offer a retry after this. */
const WAKE_LIMIT_MS = 3 * 60_000
/** Say "starting the server" if the first answer takes longer than this (a sleeping host holds it). */
const SLOW_MS = 2_500
/** After this, add that it's taking longer than usual. */
const LONG_MS = 75_000

/** Loads the public config (chain, contracts) before anything that needs the chain renders. */
function Boot() {
    const [cfg, setCfg] = useState<PublicConfig | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [waking, setWaking] = useState<"no" | "yes" | "long">("no")
    const run = useRef(0)

    // On free hosting the server sleeps when idle. Its first request then gets no answer, a gateway
    // error or the host's HTML "waking up" page for up to a minute. Keep asking quietly meanwhile.
    const load = useCallback(() => {
        const id = ++run.current
        const started = Date.now()
        setError(null)
        setWaking("no")
        const slow = setTimeout(() => run.current === id && setWaking("yes"), SLOW_MS)
        const long = setTimeout(() => run.current === id && setWaking("long"), LONG_MS)
        const stop = () => {
            clearTimeout(slow)
            clearTimeout(long)
        }
        const attempt = (n: number) => {
            api.config()
                .then((c) => {
                    if (run.current !== id) return
                    if (!c || typeof c.chainId !== "number") throw new ApiError(503, "FairPay's server sent an unexpected answer.")
                    stop()
                    setCfg(c)
                })
                .catch((e) => {
                    if (run.current !== id) return
                    if (isUnreachable(e) && Date.now() - started < WAKE_LIMIT_MS) {
                        setWaking((w) => (w === "no" ? "yes" : w))
                        setTimeout(() => run.current === id && attempt(n + 1), Math.min(2_000 + n * 1_000, 5_000))
                        return
                    }
                    stop()
                    setWaking("no")
                    setError(isUnreachable(e) ? "Its server didn't answer. It may be down for maintenance; try again in a few minutes." : friendly(e))
                })
        }
        attempt(0)
        return () => {
            run.current++
            stop()
        }
    }, [])

    useEffect(load, [load])

    if (!cfg)
        return (
            <div className="boot">
                <div className="boot-inner">
                    <Logo variant="full" size={32} className="fp-logo--theme" />
                    {error ? (
                        <>
                            <p role="alert">FairPay couldn't start. {error}</p>
                            <button type="button" className="btn btn-primary" onClick={() => void load()}>
                                Try again
                            </button>
                        </>
                    ) : waking === "no" ? (
                        <p className="progress" role="status">
                            <span className="spinner" aria-hidden="true" />
                            Loading FairPay…
                        </p>
                    ) : (
                        <div className="stack-sm boot-wake" role="status">
                            <p className="progress">
                                <span className="spinner" aria-hidden="true" />
                                Starting the server…
                            </p>
                            <p className="muted">
                                {waking === "long"
                                    ? "This is taking longer than usual. Still trying; you can keep this page open."
                                    : "FairPay runs on free hosting, which sleeps when nobody is using it. Waking it takes up to a minute."}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        )

    return (
        <WalletProvider cfg={cfg}>
            <BrowserRouter basename={ROUTER_BASENAME}>
                <App />
                <WalletPicker />
            </BrowserRouter>
        </WalletProvider>
    )
}

// public/theme-init.js already did this before first paint; repeat it in case that file didn't load.
applyTheme(readTheme())

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Boot />
    </StrictMode>
)
