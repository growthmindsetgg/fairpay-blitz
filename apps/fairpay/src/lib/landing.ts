// Where a restaurant owner or staff member lands. A wallet that works at a restaurant goes to its
// dashboard when it signs in, or when the app first opens already signed in, so the merchant side
// shows without hunting for it. Only from Home, so a link to a bill, an order, an invoice or a
// storefront still opens what it points at; and only once per tab session, so Home stays usable
// for the personal side afterwards. No React or browser APIs here, so the rules are testable.

import type { Me } from "../../shared/types"

/** sessionStorage key: the wallet whose landing this tab has already decided. */
export const LANDED_KEY = "fairpay.merchantLanding"

const DIRECTORY = "/business/faireats"

/** The merchant home for these restaurants: the one dashboard, or the "Your restaurants" list. */
export function merchantHome(restaurants: Pick<Me["restaurants"][number], "id">[]): string | null {
    if (restaurants.length === 0) return null
    if (restaurants.length === 1) return `${DIRECTORY}/manage/${encodeURIComponent(restaurants[0].id)}`
    return DIRECTORY
}

/** Home is the only page a merchant is moved away from; every other path is a deep link. */
export function isHomePath(pathname: string) {
    return pathname === "/" || pathname === ""
}

export type LandingEvent =
    /** The first session check of this tab found a signed-in wallet. */
    | "load"
    /** A wallet signed in (or a different one) while the tab was open. */
    | "signin"

/**
 * Where to go, or null to stay. `landed` is the wallet this tab already landed (sessionStorage),
 * so a reload doesn't move a merchant who went back to Home on purpose. A fresh sign-in always
 * counts: it is the moment the owner asked for.
 */
export function landingTarget(o: {
    event: LandingEvent
    wallet: string
    restaurants: Pick<Me["restaurants"][number], "id">[]
    pathname: string
    landed: string | null
}): string | null {
    if (!isHomePath(o.pathname)) return null
    if (o.event === "load" && o.landed === o.wallet) return null
    return merchantHome(o.restaurants)
}
