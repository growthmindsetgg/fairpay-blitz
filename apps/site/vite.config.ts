import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { existsSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

// Serve the same security headers in `vite preview` as Vercel does, so CSP problems show up locally.
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
}
const previewHeaders = Object.fromEntries(
    (vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? [])
        .filter((h) => h.key !== "Strict-Transport-Security")
        .map((h) => [h.key, h.value])
)

// Absolute site URL for canonical and Open Graph tags. On Vercel Git builds it comes from the
// production domain; otherwise it is the live site. Set SITE_URL to override.
const siteUrl = (
    process.env.SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "https://fairpay-blitz.vercel.app")
).replace(/\/$/, "")

function siteUrlInHtml(): Plugin {
    return {
        name: "site-url",
        transformIndexHtml: (html) => html.replaceAll("__SITE_URL__", siteUrl)
    }
}

const dist = fileURLToPath(new URL("./dist", import.meta.url))
const isFile = (p: string) => existsSync(p) && statSync(p).isFile()

// `vite preview` serves the assembled dist the way vercel.json does in production:
// /app routes go to the demo's index.html, /guide and /guide/<page> to their prerendered
// index.html, and anything else without a file gets 404.html with status 404.
function previewRouting(): Plugin {
    return {
        name: "preview-routing",
        configurePreviewServer(server) {
            server.middlewares.use((req, _res, next) => {
                const url = req.url ?? "/"
                const [path, query] = url.split("?")
                const q = query ? `?${query}` : ""
                if (path === "/") {
                    req.url = `/index.html${q}`
                } else if ((path === "/app" || path.startsWith("/app/")) && !/\.[a-z0-9]+$/i.test(path)) {
                    req.url = `/app/index.html${q}`
                } else if (/^\/guide(\/[a-z0-9-]+)?\/?$/.test(path)) {
                    const file = join(dist, path.replace(/\/$/, ""), "index.html")
                    if (isFile(file)) req.url = `${path.replace(/\/$/, "")}/index.html${q}`
                }
                next()
            })
            // Runs after the built-in static handler, so only unmatched requests reach it.
            return () => {
                server.middlewares.use((req, res, next) => {
                    if (req.method !== "GET" && req.method !== "HEAD") return next()
                    const page = join(dist, "404.html")
                    if (!isFile(page)) return next()
                    res.statusCode = 404
                    res.setHeader("Content-Type", "text/html; charset=utf-8")
                    for (const [k, v] of Object.entries(previewHeaders)) res.setHeader(k, v)
                    res.end(req.method === "HEAD" ? undefined : readFileSync(page))
                })
            }
        }
    }
}

export default defineConfig({
    appType: "mpa",
    plugins: [react(), siteUrlInHtml(), previewRouting()],
    build: { target: "es2022" },
    preview: { headers: previewHeaders }
})
