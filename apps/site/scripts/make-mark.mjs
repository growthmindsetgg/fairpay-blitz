// Builds the FairPay mark ("fair share", public/brand/BRAND.md) and writes every file that
// carries it: the share paths in both Logo.tsx files (site and app), the six SVGs in
// public/brand and both favicon.svg files. It also writes the table-plan chair paths that the
// hero table illustration draws (src/components/tablePlan.ts). Run `npm run og -w site`
// afterwards so og.png and apple-touch-icon.png pick up the same artwork.
//
//   node scripts/make-mark.mjs            write the files
//   node scripts/make-mark.mjs --preview  write a size-test page to stdout instead
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const appRoot = join(site, "..", "fairpay")

// ---------------------------------------------------------------- the mark: fair share
// A bill drawn as a disc with its north-east quarter lifted out along the diagonal: one
// person's share. At 24px and up the lifted quarter is hollow (a confidential share is paid
// but not shown); below that it is solid saffron.
export const SHARE = { cx: 22.5, cy: 25.5, r: 18, lift: 3.5, wall: 3 }
export const SHARE_FAVICON = { cx: 14.6, cy: 17.4, r: 11, lift: 2.4, wall: 2 }

const fmt = (v, dp) => {
    const s = (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp).replace(/\.?0+$/, "")
    return s === "-0" ? "0" : s
}

/** The disc minus its north-east quarter, the lifted quarter and the hole that makes it hollow. */
export function sharePaths({ cx, cy, r, lift, wall } = SHARE, scale = 1, shift = 0, dp = 2) {
    const X = (v) => fmt(v * scale + shift, dp)
    const R = (v) => fmt(v * scale, dp)
    const qx = cx + lift
    const qy = cy - lift
    const ri = r - wall
    const e = Math.sqrt(ri * ri - wall * wall)
    return {
        rest: `M${X(cx)} ${X(cy)}L${X(cx + r)} ${X(cy)}A${R(r)} ${R(r)} 0 1 1 ${X(cx)} ${X(cy - r)}Z`,
        share: `M${X(qx)} ${X(qy)}L${X(qx)} ${X(qy - r)}A${R(r)} ${R(r)} 0 0 1 ${X(qx + r)} ${X(qy)}Z`,
        hole: `M${X(qx + wall)} ${X(qy - wall)}L${X(qx + wall)} ${X(qy - e)}A${R(ri)} ${R(ri)} 0 0 1 ${X(qx + e)} ${X(qy - wall)}Z`
    }
}

// Colour per tone: "" sits on light backgrounds, "-light" on dark ones, "-mono" is one colour.
const TONES = {
    "": { main: "#5536F0", word: "#16112E" },
    "-light": { main: "#AD9EFF", word: "#F4F1FF" },
    "-mono": { main: "currentColor", word: "currentColor" }
}
const SAFFRON = "#F2A93B"
const TILE = "#5536F0"

const markBody = (t, m) => `<path fill="${t.main}" d="${m.rest}"/><path fill="${t.main}" fill-rule="evenodd" d="${m.share}${m.hole}"/>`

function markSvg(t, m) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img"><title>FairPay</title>${markBody(t, m)}</svg>`
}

function logoSvg(t, word) {
    // The lockup places the 48-grid mark with translate(-4.5 -4.5) scale(2.25), as Logo.tsx does.
    const m = sharePaths(SHARE, 2.25, -4.5, 1)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 464.7 99.5" role="img"><title>FairPay</title>${markBody(t, m)}<path fill="${t.word}" d="${word}"/></svg>`
}

function faviconSvg(geo = SHARE_FAVICON) {
    const m = sharePaths(geo)
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${TILE}"/>` +
        `<path fill="#FFFFFF" d="${m.rest}"/><path fill="${SAFFRON}" d="${m.share}"/></svg>`
    )
}

// ---------------------------------------------------------------- table plan (illustration only)
// The table illustration: a round table from above with four chairs. The landing page's hero
// table (TableArt), the privacy flow markers and og.png draw it.
export const TABLE = { c: 24, ro: 22, ri: 15, gap: 11, fillet: 2, inset: 2.25 }

const S2 = Math.SQRT1_2
const D = [S2, -S2] // the right-hand cut of the north chair, running out from the centre
const N = [-S2, -S2] // unit normal from that cut towards the north chair
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k]
const mul = (a, k) => [a[0] * k, a[1] * k]
const mirror = (p) => [-p[0], p[1]]
// Quarter turns about the centre, in screen coordinates (y down): N -> W -> S -> E.
const TURN = { n: (p) => p, w: (p) => [p[1], -p[0]], s: (p) => [-p[0], -p[1]], e: (p) => [-p[1], p[0]] }

function chair({ c, ro, ri, gap, fillet: f }, turn) {
    const h = gap / 2
    const to = Math.sqrt((ro - f) ** 2 - (h + f) ** 2)
    const qo = add(mul(D, to), N, h + f)
    const ti = Math.sqrt((ri + f) ** 2 - (h + f) ** 2)
    const qi = add(mul(D, ti), N, h + f)
    const right = { lo: add(qo, N, -f), co: mul(qo, ro / (ro - f)), li: add(qi, N, -f), ci: mul(qi, ri / (ri + f)) }
    const left = Object.fromEntries(Object.entries(right).map(([k, p]) => [k, mirror(p)]))
    const P = (p) => {
        const q = TURN[turn](p)
        return `${fmt(c + q[0], 2)} ${fmt(c + q[1], 2)}`
    }
    return (
        `M${P(left.lo)}A${f} ${f} 0 0 1 ${P(left.co)}A${ro} ${ro} 0 0 1 ${P(right.co)}` +
        `A${f} ${f} 0 0 1 ${P(right.lo)}L${P(right.li)}A${f} ${f} 0 0 1 ${P(right.ci)}` +
        `A${ri} ${ri} 0 0 0 ${P(left.ci)}A${f} ${f} 0 0 1 ${P(left.li)}Z`
    )
}

/** The hole that makes the east chair hollow: the chair inset on every side, sharp corners. */
function chairHole({ c, ro, ri, gap, inset }) {
    const k = gap / 2 + inset
    const at = (rad) => add(mul(D, Math.sqrt(rad ** 2 - k ** 2)), N, k)
    const o = at(ro - inset)
    const i = at(ri + inset)
    const P = (p) => {
        const q = TURN.e(p)
        return `${fmt(c + q[0], 2)} ${fmt(c + q[1], 2)}`
    }
    const a = fmt(ro - inset, 2)
    const b = fmt(ri + inset, 2)
    return `M${P(mirror(o))}A${a} ${a} 0 0 1 ${P(o)}L${P(i)}A${b} ${b} 0 0 0 ${P(mirror(i))}Z`
}

// ---------------------------------------------------------------- output

/** Replaces `export const NAME = "..."` in a source file's text; throws if it isn't there. */
function setConst(text, file, name, value) {
    const re = new RegExp(`(export const ${name} = )"[^"]+"`)
    if (!re.test(text)) throw new Error(`make-mark: ${name} not found in ${file}`)
    return text.replace(re, `$1"${value}"`)
}

if (process.argv.includes("--preview")) {
    const sizes = [16, 24, 32, 48, 96]
    const m = sharePaths()
    let html = `<!doctype html><meta charset="utf-8"><body style="margin:24px;font:14px sans-serif">`
    for (const [bg, suffix] of [["#F6F4FE", ""], ["#0E0A1C", "-light"]]) {
        html += `<div style="display:flex;gap:24px;align-items:center;padding:16px;background:${bg}">`
        for (const s of sizes) html += markSvg(TONES[suffix], m).replace("<svg ", `<svg width="${s}" height="${s}" `)
        for (const s of [16, 32, 64]) html += faviconSvg().replace("<svg ", `<svg width="${s}" height="${s}" `)
        html += `</div>`
    }
    process.stdout.write(html + "</body>")
} else {
    const m = sharePaths()
    const logos = [join(site, "src", "components", "Logo.tsx"), join(appRoot, "src", "components", "Logo.tsx")]
    let word = null
    for (const file of logos) {
        let text = readFileSync(file, "utf8")
        text = setConst(text, file, "SHARE_REST", m.rest)
        text = setConst(text, file, "SHARE_PIECE", m.share)
        text = setConst(text, file, "SHARE_HOLE", m.hole)
        writeFileSync(file, text)
        word ??= text.match(/const WORD = "([^"]+)"/)[1]
    }

    const planFile = join(site, "src", "components", "tablePlan.ts")
    let plan = readFileSync(planFile, "utf8")
    plan = setConst(plan, planFile, "CHAIR_N", chair(TABLE, "n"))
    plan = setConst(plan, planFile, "CHAIR_W", chair(TABLE, "w"))
    plan = setConst(plan, planFile, "CHAIR_S", chair(TABLE, "s"))
    plan = setConst(plan, planFile, "PRIVATE_CHAIR", chair(TABLE, "e"))
    plan = setConst(plan, planFile, "PRIVATE_HOLE", chairHole(TABLE))
    writeFileSync(planFile, plan)

    for (const [suffix, t] of Object.entries(TONES)) {
        writeFileSync(join(site, "public", "brand", `fairpay-mark${suffix}.svg`), markSvg(t, m) + "\n")
        writeFileSync(join(site, "public", "brand", `fairpay-logo${suffix}.svg`), logoSvg(t, word) + "\n")
    }
    for (const dir of [join(site, "public"), join(appRoot, "public")]) writeFileSync(join(dir, "favicon.svg"), faviconSvg() + "\n")
    console.log("make-mark: wrote both Logo.tsx files, tablePlan.ts, 6 brand SVGs and 2 favicons")
}
