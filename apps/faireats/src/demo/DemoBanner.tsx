import { useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { DEMO_KITCHEN_PIN } from "./config"
import { consumeResetFlag, demoStorageBlocked, resetDemo } from "./lifecycle"
import "./demo.css"

/** Site pages that sit next to the demo on the static deploy. */
const SITE = { home: "/", guide: "/guide/demo" }
/**
 * The real FairPay app, served by the same website at /pay/ (its server is on a free plan, so the
 * first visit after a quiet spell can take about 50 seconds).
 */
const REAL_APP = "/pay/"

/** The bar on every demo screen: what is simulated, where the real app is, and a reset. */
export function DemoBanner() {
    const { pathname } = useLocation()
    const onKitchen = /\/kitchen\/?$/.test(pathname)
    const [confirming, setConfirming] = useState(false)
    const [status, setStatus] = useState("")
    const resetBtn = useRef<HTMLButtonElement>(null)
    const yesBtn = useRef<HTMLButtonElement>(null)
    const asked = useRef(false)
    const bar = useRef<HTMLDivElement>(null)

    // Publishes the banner's height so the app's sticky bars can sit below it (see demo.css).
    useEffect(() => {
        const el = bar.current
        if (!el) return
        const root = document.documentElement
        const apply = () => root.style.setProperty("--demo-banner-h", `${Math.ceil(el.getBoundingClientRect().height)}px`)
        apply()
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", apply)
            return () => window.removeEventListener("resize", apply)
        }
        const ro = new ResizeObserver(apply)
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    useEffect(() => {
        if (!consumeResetFlag()) return
        setStatus("Demo reset. Start a new order.")
        const t = setTimeout(() => setStatus(""), 5000)
        return () => clearTimeout(t)
    }, [])

    useEffect(() => {
        if (confirming) yesBtn.current?.focus()
        else if (asked.current) resetBtn.current?.focus()
    }, [confirming])

    const ask = () => {
        asked.current = true
        setConfirming(true)
    }

    return (
        <div ref={bar} className="demo-banner" role="region" aria-label="Demo mode" data-tone={onKitchen ? "ink" : "light"}>
            <div className="demo-banner__in">
                <p className="demo-banner__text">
                    <span className="demo-banner__glyph" aria-hidden="true" />
                    <strong>Simulated demo:</strong> no wallet, no real payments.
                    <span className="demo-wide"> Everything runs in your browser.</span>
                </p>
                <div className="demo-banner__links">
                    <a className="demo-narrow" href={SITE.home}>
                        About
                    </a>
                    <a href={REAL_APP}>
                        <span className="demo-narrow">Real app</span>
                        <span className="demo-wide">Open the real app</span>
                    </a>
                    <a className="demo-wide" href={SITE.guide}>
                        Guide
                    </a>
                    {confirming ? (
                        <span className="demo-banner__confirm">
                            <span>Reset everything?</span>
                            <button ref={yesBtn} type="button" onClick={() => resetDemo(import.meta.env.BASE_URL)}>
                                Yes, reset
                            </button>
                            <button type="button" onClick={() => setConfirming(false)}>
                                Cancel
                            </button>
                        </span>
                    ) : (
                        <button ref={resetBtn} type="button" onClick={ask}>
                            <span className="demo-narrow">Reset</span>
                            <span className="demo-wide">Reset demo</span>
                        </button>
                    )}
                </div>
            </div>
            {onKitchen && (
                <p className="demo-banner__note">
                    Demo kitchen PIN: <code>{DEMO_KITCHEN_PIN}</code>. The real kitchen uses a private PIN.
                </p>
            )}
            {demoStorageBlocked() && (
                <p className="demo-banner__note">Your browser isn't saving site data, so the kitchen screen must be opened in this tab.</p>
            )}
            <p className={status ? "demo-banner__note" : "demo-sr"} role="status">
                {status}
            </p>
        </div>
    )
}
