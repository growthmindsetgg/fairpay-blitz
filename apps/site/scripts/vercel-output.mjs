// Packs the finished site (apps/site/dist) into Vercel's Build Output API layout so
// `vercel deploy --prebuilt` uploads exactly these static files and Vercel runs no build of its
// own. Redirects, headers and rewrites come from apps/site/vercel.json.
//
// /api/* is a rewrite to an external origin (the FairPay server on Render): Vercel forwards those
// requests and their answers, cookies included, so the app at /pay/ talks only to this website.
//
// Hardening (`npm run deploy:vercel` turns it on by default through scripts/deploy.mjs): with
// PROXY_SECRET_HEADER=1 in the environment when this runs, every forwarded /api request also carries `x-fairpay-proxy: $PROXY_SECRET`,
// filled in by Vercel at request time from the project's PROXY_SECRET environment variable. The
// value itself never appears in this repository or in the uploaded files. The FairPay server,
// given the same PROXY_SECRET, can then tell requests that came through this website.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(site, "dist")
const out = path.join(site, ".vercel", "output")
for (const page of ["app", "pay"]) {
    if (!existsSync(path.join(dist, page, "index.html"))) {
        console.error(`vercel-output: apps/site/dist/${page} is missing. Run \`npm run build:vercel\` first.`)
        process.exit(1)
    }
}

const config = JSON.parse(readFileSync(path.join(site, "vercel.json"), "utf8"))

// vercel.json uses path-to-regexp syntax: (...) groups, named :params and :params* (any number of
// segments). Each becomes one numbered capture group, in order, so destinations use $1, $2, ...
const PARAM = /:([a-z]+)(\*)?/gi
const toRegex = (source) => "^" + source.replace(PARAM, (_, _name, star) => (star ? "(.*)" : "([^/]+)")) + "$"
const toDest = (source, dest) => {
    const names = [...source.matchAll(PARAM)].map((m) => m[0])
    // Longest first, so ":path*" is replaced before a ":path" that is its prefix.
    const order = names.map((n, i) => [n, i]).sort((a, b) => b[0].length - a[0].length)
    return order.reduce((d, [name, i]) => d.replaceAll(name, "$" + (i + 1)), dest)
}
const isExternal = (dest) => /^https?:\/\//i.test(dest)

const proxySecretHeader = process.env.PROXY_SECRET_HEADER === "1"
const proxyTransforms = proxySecretHeader
    ? [
          {
              type: "request.headers",
              op: "set",
              target: { key: "x-fairpay-proxy" },
              args: "$PROXY_SECRET",
              env: ["PROXY_SECRET"]
          }
      ]
    : undefined

const external = config.rewrites.filter((r) => isExternal(r.destination))
const internal = config.rewrites.filter((r) => !isExternal(r.destination))

// Redirects come first of all, so a request for an old host (the .vercel.app one, www.) never
// reaches a page, a header rule or the /api proxy: a stale tab is sent to the one origin sign-in
// accepts. `permanent: true` is a 308, which keeps the method and body; Vercel keeps the query.
const redirects = (config.redirects ?? []).map((r) => ({
    src: toRegex(r.source),
    ...(r.has ? { has: r.has } : {}),
    headers: { Location: toDest(r.source, r.destination) },
    status: r.statusCode ?? (r.permanent === false ? 307 : 308)
}))

const routes = [
    ...redirects,
    ...config.headers.map((h) => ({
        src: toRegex(h.source),
        headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])),
        continue: true
    })),
    // The API proxy goes before the filesystem, so no static file can ever shadow it.
    ...external.map((r) => ({
        src: toRegex(r.source),
        dest: toDest(r.source, r.destination),
        ...(proxyTransforms ? { transforms: proxyTransforms } : {})
    })),
    { handle: "filesystem" },
    ...internal.map((r) => ({ src: toRegex(r.source), dest: toDest(r.source, r.destination), check: true })),
    // Unknown paths get the prerendered 404 page with a real 404 status.
    { handle: "error" },
    { src: "/.*", dest: "/404.html", status: 404 }
]

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(dist, path.join(out, "static"), {
    recursive: true,
    filter: (src) => {
        const name = path.basename(src)
        return !name.startsWith(".env") && name !== ".vercel" && name !== ".vercelignore" && name !== "vercel.json"
    }
})
writeFileSync(path.join(out, "config.json"), JSON.stringify({ version: 3, routes }, null, 2))
console.log(
    `vercel-output: wrote ${path.relative(process.cwd(), out)} with ${routes.length} routes` +
        (proxySecretHeader ? " (forwarded /api requests carry the proxy secret header)" : "")
)
