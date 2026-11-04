// Where the app lives. The default build serves it at "/" (npm run dev:fairpay, the Docker image);
// the website build (npm run build:pay -w fairpay-app) serves it at "/pay/" on the public website,
// which proxies /api to the server. Vite sets BASE_URL from `base`, always with a trailing slash.

/** "/" or "/pay/". */
export const BASE = import.meta.env.BASE_URL || "/"

/** The router's basename: undefined at the root, "/pay" on the website. */
export const ROUTER_BASENAME = BASE === "/" ? undefined : BASE.replace(/\/+$/, "")

/** "/b/abc" (a router path) as a full link people can open: https://host/pay/b/abc on the website. */
export function absoluteUrl(path: string) {
    try {
        const p = path.startsWith("/") && !path.startsWith("//") ? (ROUTER_BASENAME ?? "") + path : path
        return new URL(p, window.location.origin).toString()
    } catch {
        return path
    }
}

/**
 * A link from the server (https://host/pay/i/abc, or a bare /i/abc) as a router path ("/i/abc")
 * when it points into this app, so the router handles it. Anything else is returned unchanged.
 */
export function toPath(url: string) {
    try {
        const u = new URL(url, window.location.origin)
        if (u.origin !== window.location.origin) return url
        let p = u.pathname
        if (ROUTER_BASENAME && (p === ROUTER_BASENAME || p.startsWith(`${ROUTER_BASENAME}/`))) p = p.slice(ROUTER_BASENAME.length) || "/"
        return `${p}${u.search}${u.hash}`
    } catch {
        return url
    }
}

/**
 * An image path stored by the server, like the bundled menu art "/menu/chai.svg", resolved against
 * where the app is served. Uploads ("/api/images/...") stay as they are, since /api is always at
 * the site root; data:, blob: and full URLs are untouched.
 */
export function mediaUrl(src: string): string
export function mediaUrl(src: string | null | undefined): string | null | undefined
export function mediaUrl(src: string | null | undefined) {
    if (!src || !src.startsWith("/") || src.startsWith("//") || src.startsWith("/api/") || BASE === "/") return src
    return BASE + src.slice(1)
}
