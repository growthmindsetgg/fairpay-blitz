// PUBLIC_ORIGIN, kept apart from env.ts (which reads .env files and the deployment on import) so
// tests can check it on its own.

/** Where `npm run dev:fairpay` serves the app. Only a default outside production. */
export const DEV_ORIGIN = "http://localhost:5174"

const EXAMPLE = "https://fairpay.onrender.com"

/**
 * The origin people open the app at. Every sign-in message is checked against exactly this
 * origin, so a wrong value makes every sign-in fail with nothing in the logs to say why.
 *
 * Production is NODE_ENV=production, which the Dockerfile sets. There PUBLIC_ORIGIN must be set
 * and the server refuses to start without it. Dev and tests fall back to the Vite dev server.
 * The value is never echoed back in an error, in case something secret was pasted into it.
 */
export function publicOriginFrom(env: { PUBLIC_ORIGIN?: string; NODE_ENV?: string }): string {
    const value = env.PUBLIC_ORIGIN?.trim()
    if (!value) {
        if (env.NODE_ENV?.trim() === "production") {
            throw new Error(
                `PUBLIC_ORIGIN is not set. Set it to the exact address people open the app at, like ${EXAMPLE}; ` +
                    "sign-in checks every message against it."
            )
        }
        return DEV_ORIGIN
    }
    let u: URL
    try {
        u = new URL(value)
    } catch {
        throw new Error(`PUBLIC_ORIGIN must be an absolute http(s) origin like ${EXAMPLE}.`)
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`PUBLIC_ORIGIN must start with https:// or http://, like ${EXAMPLE}.`)
    }
    // A path, query or user name would be dropped silently, so the origin people actually open
    // might not be the one sign-in expects.
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
        throw new Error(`PUBLIC_ORIGIN must be an origin only (scheme, host and optional port), like ${EXAMPLE}.`)
    }
    return u.origin
}

/**
 * The path the app is served under on PUBLIC_ORIGIN, from PUBLIC_APP_PATH: "" when the app is at
 * the root (the default, and the standalone Docker image), "/pay" when the public website serves it
 * at https://<site>/pay/ and proxies /api to this server. Share, invoice and bill links are built
 * as PUBLIC_ORIGIN + this path. Sign-in still checks only the origin.
 */
export function appPathFrom(env: { PUBLIC_APP_PATH?: string }): string {
    const value = env.PUBLIC_APP_PATH?.trim()
    if (!value || value === "/") return ""
    // Letters, digits and - _ . ~ in each segment; no "..", query, fragment or encoded characters.
    if (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/.test(value)) {
        throw new Error('PUBLIC_APP_PATH must be a path like "/pay" (or "/" for the root).')
    }
    return value.replace(/\/+$/, "")
}

/** Where links to the app point: PUBLIC_ORIGIN plus PUBLIC_APP_PATH, with no trailing slash. */
export function appUrlOf(deps: { publicOrigin: string; appPath?: string }): string {
    return deps.publicOrigin.replace(/\/+$/, "") + (deps.appPath ?? "")
}
