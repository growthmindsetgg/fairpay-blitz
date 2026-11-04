import { useEffect, useRef } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { LANDED_KEY, landingTarget } from "../lib/landing"
import { useWallet } from "../lib/wallet"

// sessionStorage, not localStorage: "once" means once per tab session. Blocked storage only means
// a reload on Home lands again.
const session = {
    get: () => {
        try {
            return sessionStorage.getItem(LANDED_KEY)
        } catch {
            return null
        }
    },
    set: (w: string) => {
        try {
            sessionStorage.setItem(LANDED_KEY, w)
        } catch {
            /* ignore */
        }
    }
}

/** Takes a merchant from Home to their restaurant's dashboard at sign-in (src/lib/landing.ts). Renders nothing. */
export function MerchantLanding() {
    const { me, meLoading } = useWallet()
    const navigate = useNavigate()
    const { pathname } = useLocation()
    // undefined until the first session check finishes; then the wallet signed in (or null).
    const seen = useRef<string | null | undefined>(undefined)
    const wallet = me?.profile.wallet ?? null

    useEffect(() => {
        if (meLoading) return
        const before = seen.current
        seen.current = wallet
        if (!wallet || !me || before === wallet) return
        const target = landingTarget({ event: before === undefined ? "load" : "signin", wallet, restaurants: me.restaurants, pathname, landed: session.get() })
        // Decided for this wallet in this tab, whether or not it moved (a deep link stays put).
        session.set(wallet)
        // A redirect on load replaces Home; after a sign-in, Back returns to it.
        if (target) navigate(target, { replace: before === undefined })
        // Only the session changing decides; later visits to Home don't.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meLoading, wallet])

    return null
}
