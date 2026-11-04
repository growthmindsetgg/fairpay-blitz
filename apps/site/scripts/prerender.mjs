// Prerenders every route to static HTML after `vite build` and `vite build --ssr`.
// Writes dist/index.html, dist/guide/index.html, dist/guide/<page>/index.html, dist/404.html
// and dist/sitemap.xml, each with its own title, description, canonical and Open Graph tags.
// The client bundle then hydrates the markup, so pages work without JavaScript and load fast.
// Run by `npm run build`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(siteDir, "dist")
const ssrDir = join(siteDir, "dist-ssr")

function fail(msg) {
    console.error(`prerender: ${msg}`)
    process.exit(1)
}

const template = readFileSync(join(dist, "index.html"), "utf8")
const base = template.match(/<link rel="canonical" href="([^"]*)\/"/)?.[1]
if (base === undefined) fail("the template has no canonical link")

const { render, PAGE_META, ROUTES } = await import(pathToFileURL(join(ssrDir, "entry-server.js")).href)

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function setHead(html, path, meta) {
    const url = `${base}${path === "/" ? "/" : path}`
    const swaps = [
        [/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`],
        [/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(meta.description)}" />`],
        [/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`],
        [/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`],
        [/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(meta.title)}" />`],
        [
            /<meta property="og:description" content="[^"]*" \/>/,
            `<meta property="og:description" content="${esc(meta.description)}" />`
        ]
    ]
    for (const [re, value] of swaps) {
        if (!re.test(html)) fail(`template is missing ${re}`)
        html = html.replace(re, value)
    }
    if (meta.noindex) {
        html = html
            .replace(/\s*<link rel="canonical" href="[^"]*" \/>/, "")
            .replace(/\s*<meta property="og:url" content="[^"]*" \/>/, "")
            .replace("</title>", '</title>\n    <meta name="robots" content="noindex" />')
    }
    return html
}

async function page(path, outFile) {
    let body = await render(path === "/404" ? "/this-page-does-not-exist" : path)
    // React emits the page's <title> and <meta> into the markup; the head already has them.
    body = body.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<meta [^>]*\/?>/g, "")
    if (/<script|<style|\sstyle="/i.test(body)) fail(`${path} rendered an inline script, style or style attribute`)
    if ((body.match(/<h1[\s>]/g) ?? []).length !== 1) fail(`${path} should have exactly one <h1>`)
    const meta = PAGE_META[path]
    if (!meta) fail(`no meta for ${path}`)
    let html = setHead(template, path, meta)
    if (!html.includes('<div id="root"></div>')) fail("the template has no empty #root")
    html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`)
    if ((html.match(/<title>/g) ?? []).length !== 1) fail(`${path} has more than one <title>`)
    const file = join(dist, outFile)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, html)
    return file
}

let count = 0
for (const path of ROUTES) {
    await page(path, path === "/" ? "index.html" : join(path.slice(1), "index.html"))
    count++
}
await page("/404", "404.html")

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${ROUTES.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}
</urlset>
`
writeFileSync(join(dist, "sitemap.xml"), sitemap)
rmSync(ssrDir, { recursive: true, force: true })
console.log(`prerender: wrote ${count} routes, 404.html and sitemap.xml`)
