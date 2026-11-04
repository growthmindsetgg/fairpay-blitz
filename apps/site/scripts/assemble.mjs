// Assembles the static Vercel output: apps/site/dist + the FairEats demo build at /app + the FairPay
// app at /pay (its API is proxied to Render by vercel.json). Cross-platform (node:fs only). Run after
// `npm run build -w site`, `npm run build:demo -w faireats` and `npm run build:pay -w fairpay-app`.
import { cpSync, existsSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(siteDir, "dist")
const demo = join(siteDir, "..", "faireats", "dist-demo")
const appOut = join(dist, "app")
const pay = join(siteDir, "..", "fairpay", "dist-site")
const payOut = join(dist, "pay")

function fail(msg) {
    console.error(`assemble: ${msg}`)
    process.exit(1)
}

if (!existsSync(join(dist, "index.html"))) fail("apps/site/dist/index.html is missing. Run `npm run build -w site` first.")
if (!existsSync(join(demo, "index.html")))
    fail("apps/faireats/dist-demo/index.html is missing. Run `npm run build:demo -w faireats` first.")
if (!existsSync(join(pay, "index.html"))) fail("apps/fairpay/dist-site/index.html is missing. Run `npm run build:pay -w fairpay-app` first.")
// The app must be built for /pay/, or every asset would load from the site root and 404.
if (!readFileSync(join(pay, "index.html"), "utf8").includes('src="/pay/assets/'))
    fail("apps/fairpay/dist-site was not built for /pay/. Run `npm run build:pay -w fairpay-app`.")

rmSync(appOut, { recursive: true, force: true })
cpSync(demo, appOut, { recursive: true })
// The published demo carries the FairPay favicon, so the tab icon stays the same across the site.
// apps/faireats is left as it is; only the assembled copy changes.
if (existsSync(join(appOut, "favicon.svg"))) cpSync(join(siteDir, "public", "favicon.svg"), join(appOut, "favicon.svg"))
rmSync(payOut, { recursive: true, force: true })
cpSync(pay, payOut, { recursive: true })
cpSync(join(siteDir, "vercel.json"), join(dist, "vercel.json"))

// Pre-publish safety check: nothing secret may ship, and the simulated demo must not reach the network.
const files = []
const walk = (d) => {
    for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(html|js|mjs|css|json|map|txt|svg)$/i.test(name)) files.push(p)
    }
}
walk(dist)

const secretPatterns = [
    /(?:RELAYER|FAUCET|PRIVATE|DEPLOYER)_?KEY\s*["']?\s*[=:]\s*["']?0x[0-9a-fA-F]{64}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]
// The demo must not reach the network or load proving files. Their presence in /app is reported.
const demoWarnings = ["snark-artifacts", "testnet-rpc.monad.xyz", "/api/relay", "/api/faucet"]

let bad = 0
for (const f of files) {
    const text = readFileSync(f, "utf8")
    const rel = relative(dist, f)
    for (const re of secretPatterns) {
        if (re.test(text)) {
            console.error(`assemble: possible secret in ${rel} (${re})`)
            bad++
        }
    }
    if (rel.startsWith("app")) {
        for (const s of demoWarnings) if (text.includes(s)) console.warn(`assemble: warning, "${s}" appears in ${rel}`)
    }
}
if (existsSync(join(dist, ".env")) || existsSync(join(appOut, ".env")) || existsSync(join(payOut, ".env"))) {
    console.error("assemble: a .env file is in dist")
    bad++
}
if (bad) fail(`${bad} problem(s) found. Nothing should be published.`)

console.log(`assemble: copied the demo to ${relative(process.cwd(), appOut) || appOut}, the app to ${relative(process.cwd(), payOut) || payOut} and vercel.json to dist. ${files.length} files checked, no secrets found.`)
