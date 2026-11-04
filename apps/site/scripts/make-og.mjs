// Draws the social card (public/og.png, 1200x630) and the apple-touch icon
// (public/apple-touch-icon.png, 180x180) from the brand artwork.
//
// It writes two small HTML pages to scripts/brand-source/ (the logo file, the finished hero
// table drawn with the chair paths read from src/components/tablePlan.ts, and the self-hosted
// Bricolage font), then screenshots them with headless Microsoft Edge. Nothing is fetched.
// Set EDGE to the browser path if it is not in the default Windows location.
//
//   npm run og -w site
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = join(site, "scripts", "brand-source")
const pub = join(site, "public")
const edge = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"

// Read the chair paths from tablePlan.ts (the illustration TableArt draws), so the card uses its exact numbers.
const plan = readFileSync(join(site, "src", "components", "tablePlan.ts"), "utf8")
const path = (name) => {
    const m = plan.match(new RegExp(`export const ${name} = "([^"]+)"`))
    if (!m) throw new Error(`make-og: ${name} not found in tablePlan.ts`)
    return m[1]
}
const N = path("CHAIR_N"), W = path("CHAIR_W"), S = path("CHAIR_S"), E = path("PRIVATE_CHAIR"), HOLE = path("PRIVATE_HOLE")

const check = (x, y) =>
    `<path d="M${x - 1.7} ${y + 0.1}l1.15 1.15l2.3 -2.5" fill="none" stroke="#fff" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"/>`
const lock = (x, y) =>
    `<rect x="${x - 1.2}" y="${y - 0.25}" width="2.4" height="1.8" rx="0.35" fill="#008DA6"/>` +
    `<path d="M${x - 0.72} ${y - 0.25}v-0.55a0.72 0.72 0 0 1 1.44 0v0.55" fill="none" stroke="#008DA6" stroke-width="0.42"/>`

const table = `<svg viewBox="-2 -2 52 52" width="360" height="360" xmlns="http://www.w3.org/2000/svg">
  <path d="${N}" fill="#1E7A4E"/>${check(24, 5.5)}
  <path d="${HOLE}" fill="#E4F4F7"/><path d="${E}${HOLE}" fill="#008DA6" fill-rule="evenodd"/>${lock(42.5, 24)}
  <path d="${S}" fill="#1E7A4E"/>${check(24, 42.5)}
  <path d="${W}" fill="#1E7A4E"/>${check(5.5, 24)}
  <circle cx="24" cy="24" r="10" fill="#1E7A4E"/>
  <text x="24" y="25.6" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="600" font-size="7" letter-spacing="-0.14" fill="#fff">4</text>
  <text x="24" y="29.4" text-anchor="middle" font-family="Atkinson Hyperlegible Mono" font-size="2.4" fill="#fff">table</text>
</svg>`

const og = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FairPay social card</title>
<style>
  @font-face { font-family: "Bricolage Grotesque"; src: url("../../public/fonts/bricolage-grotesque-5.3.0-latin-opsz-wght.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Atkinson Hyperlegible Next"; src: url("../../public/fonts/atkinson-next-5.3.0-latin-wght.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Atkinson Hyperlegible Mono"; src: url("../../public/fonts/atkinson-mono-5.3.0-latin-wght.woff2") format("woff2"); font-weight: 200 800; }
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #F6F4FE; }
  body { position: relative; font-family: "Atkinson Hyperlegible Next", sans-serif; color: #16112E; }
  .logo { position: absolute; left: 80px; top: 80px; height: 72px; }
  h1 { position: absolute; left: 80px; top: 214px; width: 620px; margin: 0; font-family: "Bricolage Grotesque", sans-serif;
       font-weight: 600; font-size: 56px; line-height: 1.04; letter-spacing: -0.025em; font-optical-sizing: auto; }
  .foot { position: absolute; left: 80px; bottom: 72px; margin: 0; font-size: 24px; color: #474065; }
  .table { position: absolute; right: 96px; top: 135px; }
  .rule { position: absolute; left: 80px; right: 80px; bottom: 132px; height: 1px; background: rgba(22,17,46,.10); }
</style></head>
<body>
  <img class="logo" src="../../public/brand/fairpay-logo.svg" alt="">
  <h1>Every guest pays their own share, privately if they like.</h1>
  <div class="table">${table}</div>
  <div class="rule"></div>
  <p class="foot">Monad Testnet · test USDC only · unaudited · independent project</p>
</body></html>
`

// The favicon artwork on a square purple tile, no margin; iOS rounds the corners itself.
const favicon = readFileSync(join(pub, "favicon.svg"), "utf8")
    .replace(/<rect width="32" height="32" rx="7"/, '<rect width="32" height="32"')
    .replace("<svg ", '<svg width="180" height="180" ')
const touch = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FairPay touch icon</title>
<style>html, body { margin: 0; width: 180px; height: 180px; overflow: hidden; background: #5536F0; } svg { display: block; }</style>
</head><body>${favicon}</body></html>
`

mkdirSync(src, { recursive: true })
writeFileSync(join(src, "og.html"), og)
writeFileSync(join(src, "apple-touch.html"), touch)

function shoot(page, out, w, h) {
    const r = spawnSync(
        edge,
        [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--default-background-color=00000000",
            `--window-size=${w},${h}`,
            `--screenshot=${out}`,
            pathToFileURL(join(src, page)).href
        ],
        { stdio: "inherit" }
    )
    if (r.status !== 0) throw new Error(`make-og: Edge exited with ${r.status}`)
    console.log(`wrote ${out} (${statSync(out).size} bytes)`)
}

shoot("og.html", join(pub, "og.png"), 1200, 630)
shoot("apple-touch.html", join(pub, "apple-touch-icon.png"), 180, 180)
