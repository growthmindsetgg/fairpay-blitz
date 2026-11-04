import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { serveStatic } from "@hono/node-server/serve-static"
import { FairPayError } from "@fairpay/sdk"
import { sessionMiddleware } from "./auth.js"
import type { AppEnv, Deps, RouteModule } from "./context.js"
import { appUrlOf } from "./origin.js"
import { checkCsrf, clientIp, HttpError, limit, rateLimiter, rememberClientIp } from "./http.js"

/** Snark proving artifacts the browser fetches for a confidential payment (@zk-kit/artifacts). */
const ZK_ARTIFACTS = "https://snark-artifacts.pse.dev"
const JSON_BODY_LIMIT = 64 * 1024
/** Image uploads (server/routes/images.ts) take raw bytes up to 1 MB. */
const UPLOAD_BODY_LIMIT = 1024 * 1024 + 4096
const UPLOAD_PATH = /^\/api\/restaurants\/[^/]+\/images\/?$/

export type AppOptions = Deps & {
    routes: RouteModule[]
    /** The client's address as the server sees it (socket, or trusted proxy header). */
    clientIp?: (c: Context) => string
    /** Whether the request came through the website's proxy (PROXY_SECRET); shown by /api/whoami. */
    proxyStatus?: (c: Context) => "off" | "yes" | "no"
    /** Its origin is allowed in connect-src so the browser can read the chain. */
    rpcUrl?: string
    /** Built SPA to serve (production). Leave unset in development and tests. */
    staticDir?: string
}

function originOf(url: string | undefined) {
    try {
        return url ? new URL(url).origin : undefined
    } catch {
        return undefined
    }
}

export function createApp(opts: AppOptions): Hono<AppEnv> {
    const deps: Deps = { db: opts.db, chain: opts.chain, now: opts.now, publicOrigin: opts.publicOrigin, appPath: opts.appPath }
    const app = new Hono<AppEnv>()
    const apiLimit = rateLimiter(600, 60_000, deps.now)

    const rpcOrigin = originOf(opts.rpcUrl)
    const csp = [
        "default-src 'self'",
        // snarkjs compiles the prover's WebAssembly; that needs wasm-unsafe-eval, not unsafe-eval.
        "script-src 'self' 'wasm-unsafe-eval'",
        // The prover starts its worker threads from blob: URLs.
        "worker-src 'self' blob:",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src ${[...new Set(["'self'", ...(rpcOrigin ? [rpcOrigin] : []), ZK_ARTIFACTS])].join(" ")}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join("; ")
    const secure = new URL(deps.publicOrigin).protocol === "https:"
    const headers: Record<string, string> = {
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ...(secure ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {})
    }

    // Set after the handler, without replacing a header a route chose itself (images use their
    // own stricter CSP and cache headers).
    app.use("*", async (c, next) => {
        await next()
        for (const [k, v] of Object.entries(headers)) if (!c.res.headers.has(k)) c.res.headers.set(k, v)
        if (c.req.path.startsWith("/api/") && !c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store")
    })

    app.onError((err, c) => {
        if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
        if (err instanceof FairPayError && err.code === "INVALID_INPUT") return c.json({ error: err.message }, 400)
        console.error(err)
        return c.json({ error: "Something went wrong on the server. Try again." }, 500)
    })

    app.use("/api/*", async (c, next) => {
        if (opts.clientIp) rememberClientIp(c, opts.clientIp(c))
        limit(c, apiLimit)
        checkCsrf(c)
        await next()
    })
    // For wake-up pings (every page of the website sends one, so a sleeping free host starts while
    // the visitor reads) and uptime checks. Touches neither the database nor the chain.
    app.get("/api/health", (c) => c.json({ ok: true }))
    const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: (c) => c.json({ error: "Request body too large." }, 413) })
    const uploadLimit = bodyLimit({ maxSize: UPLOAD_BODY_LIMIT, onError: (c) => c.json({ error: "Images can be at most 1 MB." }, 413) })
    app.use("/api/*", (c, next) => (UPLOAD_PATH.test(c.req.path) ? uploadLimit(c, next) : jsonLimit(c, next)))
    app.use("/api/*", sessionMiddleware(deps))

    // The address rate limits count this visitor under, so the owner can check TRUST_PROXY_HOPS
    // after a deploy (DEPLOY.md). Read-only; it shows the caller only their own address.
    app.get("/api/whoami", (c) => c.json({ ip: clientIp(c), proxy: opts.proxyStatus?.(c) ?? "off" }))
    for (const route of opts.routes) app.route("/api", route(deps))
    app.all("/api/*", (c) => c.json({ error: "Not found." }, 404))

    // When the website serves the app (PUBLIC_APP_PATH, e.g. /pay) and proxies /api here, this
    // server's own pages would show an app whose sign-in fails, because sign-in names the website.
    // Send page visits there instead, so links shared before the move (/b/..., /o/...) keep working.
    if (deps.appPath) {
        const appUrl = appUrlOf(deps)
        app.get("*", (c) => {
            const url = new URL(c.req.url)
            if (url.pathname === deps.appPath || url.pathname.startsWith(`${deps.appPath}/`)) return c.notFound()
            return c.redirect(`${appUrl}${url.pathname}${url.search}`, 308)
        })
        return app
    }

    // The built frontend (npm start). In development Vite serves it and proxies /api here.
    if (opts.staticDir && existsSync(path.join(opts.staticDir, "index.html"))) {
        const index = readFileSync(path.join(opts.staticDir, "index.html"), "utf8")
        app.use("/*", serveStatic({ root: path.relative(process.cwd(), opts.staticDir) }))
        app.get("*", (c) => c.html(index))
    }
    return app
}
