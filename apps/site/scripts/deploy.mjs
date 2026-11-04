// Publishes the website (and the app at /pay/) to the Vercel project fairpay-blitz
// (https://fairpay.business). It refuses to upload to any other project.
//
//   npm run deploy:vercel                       check the Vercel sign-in, build, pack, upload to production
//   npm run deploy:vercel -- --skip-build       reuse the last build (apps/site/dist)
//
//   npm run vercel:login                        sign this computer in to Vercel (once)
//
// What it does, in order:
//   1. Gets the pinned Vercel CLI and checks you are signed in, before the slow build. The CLI is
//      installed once into apps/site/.vercel/cli (gitignored) with plain "npm install", retried on
//      npm cache-lock and network errors. That avoids "npx vercel", which fails on slow disks with
//      npm "ECOMPROMISED: Lock compromised". If the install fails it falls back to a `vercel` on
//      PATH. VERCEL_CLI="<command>" picks a CLI yourself.
//   2. Links apps/site to the project fairpay-blitz with `vercel link --yes --project fairpay-blitz`
//      (the link, apps/site/.vercel/project.json, is gitignored). VERCEL_SCOPE="<team>" picks the
//      Vercel team. An existing link to any other project stops the script before anything is built.
//   3. Runs `npm run build:vercel`, then scripts/vercel-output.mjs with PROXY_SECRET_HEADER=1 by
//      default, so forwarded /api requests carry the Vercel project's PROXY_SECRET (the FairPay
//      server checks it when its own PROXY_SECRET is set). PROXY_SECRET_HEADER=0 leaves the header out.
//   4. Checks the link again and uploads the prebuilt output to production.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const VERCEL_VERSION = "65.8.0"
const PROJECT_NAME = "fairpay-blitz"
const SITE_URL = "https://fairpay.business"
const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.join(site, "..", "..")
const skipBuild = process.argv.includes("--skip-build")
// npm and network errors that say the CLI never ran, so trying again is safe.
const TRANSIENT = /ECOMPROMISED|Lock compromised|ENOTEMPTY|EBUSY|EPERM|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|EINTEGRITY|network/i

function fail(message) {
    console.error(`\ndeploy: ${message}`)
    process.exit(1)
}

/** Runs a shell command line and returns its exit code and output, also echoing the output. */
function run(command, args, { cwd = site, env = process.env, quiet = false } = {}) {
    const res = spawnSync([command, ...args].join(" "), { cwd, env, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`
    if (!quiet) process.stdout.write(out)
    return { code: res.status ?? 1, out, stdout: res.stdout ?? "" }
}

/** Runs a command, trying again (up to 3 times) when npm or the network failed. */
function retry(command, args, opts) {
    for (let attempt = 1; ; attempt++) {
        const res = run(command, args, opts)
        if (res.code === 0 || !TRANSIENT.test(res.out) || attempt === 3) return res
        console.log(`deploy: npm or the network failed (attempt ${attempt} of 3). Trying again in ${attempt * 5} s...`)
        spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${attempt * 5000})`])
    }
}

const quote = (p) => `"${p}"`
const lastLine = (text) => text.trim().split(/\r?\n/).pop() ?? ""

/** The Vercel CLI to use, as a command line: VERCEL_CLI, the pinned one in .vercel/cli, or one on PATH. */
function findCli() {
    if (process.env.VERCEL_CLI) return process.env.VERCEL_CLI
    const dir = path.join(site, ".vercel", "cli")
    const bin = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "vercel.cmd" : "vercel")
    const pinned = () => existsSync(bin) && lastLine(run(quote(bin), ["--version"], { quiet: true }).stdout) === VERCEL_VERSION
    if (!pinned()) {
        console.log(`deploy: installing Vercel CLI ${VERCEL_VERSION} into apps/site/.vercel/cli (once)...`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ private: true, description: "Vercel CLI for npm run deploy:vercel" }))
        retry("npm", ["install", "--prefix", quote(dir), "--no-audit", "--no-fund", "--no-save", `vercel@${VERCEL_VERSION}`], { quiet: true })
    }
    if (pinned()) return quote(bin)
    const onPath = run("vercel", ["--version"], { quiet: true })
    if (onPath.code !== 0) fail(`Could not install the Vercel CLI. Install it with "npm install -g vercel@${VERCEL_VERSION}" and run this again.`)
    console.log(`deploy: using the Vercel CLI on PATH (${lastLine(onPath.stdout || onPath.out)}), not the pinned ${VERCEL_VERSION}.`)
    return "vercel"
}

// 1. CLI and sign-in.
const cli = findCli()
if (process.argv.includes("--login")) {
    const login = spawnSync(`${cli} login`, { cwd: site, shell: true, stdio: "inherit" })
    process.exit(login.status ?? 1)
}
const who = retry(cli, ["whoami"], { quiet: true })
if (who.code !== 0) {
    fail(`Vercel says this computer is not signed in, or the CLI failed:\n${who.out.trim()}\nRun "npm run vercel:login" once, then run this again.`)
}
console.log(`deploy: signed in to Vercel as ${lastLine(who.stdout) || "?"}.`)

// 2. Project link. Only fairpay-blitz is ever accepted.
const link = path.join(site, ".vercel", "project.json")
const linkedName = () => {
    try {
        return JSON.parse(readFileSync(link, "utf8")).projectName
    } catch {
        return undefined
    }
}
if (existsSync(link) && linkedName() !== PROJECT_NAME) {
    fail(
        `apps/site/.vercel/project.json links to the Vercel project "${linkedName() ?? "?"}", not ${PROJECT_NAME}. ` +
            `Nothing was built or uploaded. Delete apps/site/.vercel/project.json and run this again to link ${PROJECT_NAME}.`
    )
}
if (!existsSync(link)) {
    const scope = process.env.VERCEL_SCOPE ? ["--scope", quote(process.env.VERCEL_SCOPE)] : []
    if (retry(cli, ["link", "--yes", "--project", PROJECT_NAME, ...scope]).code !== 0) {
        fail(`Could not link apps/site to the Vercel project ${PROJECT_NAME}. Nothing was built or uploaded.`)
    }
    if (linkedName() !== PROJECT_NAME) {
        fail(`After linking, apps/site/.vercel/project.json names "${linkedName() ?? "?"}", not ${PROJECT_NAME}. Nothing was uploaded.`)
    }
    console.log(`deploy: linked apps/site to the Vercel project ${PROJECT_NAME}.`)
}

// 3. Build and pack.
if (!skipBuild && run("npm", ["run", "build:vercel"], { cwd: root }).code !== 0) fail("The build failed; nothing was uploaded.")
const proxyHeader = process.env.PROXY_SECRET_HEADER ?? "1"
if (proxyHeader !== "1") console.log("deploy: PROXY_SECRET_HEADER is not 1, so forwarded /api requests will NOT carry the proxy secret header.")
const pack = spawnSync(process.execPath, [path.join(site, "scripts", "vercel-output.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PROXY_SECRET_HEADER: proxyHeader }
})
if (pack.status !== 0) fail("Packing the build for Vercel failed; nothing was uploaded.")

// 4. Upload, after checking the link once more.
if (linkedName() !== PROJECT_NAME) fail(`apps/site/.vercel/project.json no longer names ${PROJECT_NAME}. Nothing was uploaded.`)
if (retry(cli, ["deploy", "--prebuilt", "--prod", "--yes"]).code !== 0) fail("The upload failed. The live site is unchanged unless Vercel printed a production URL above.")
console.log(
    `\ndeploy: done. Check ${SITE_URL} and ${SITE_URL}/api/whoami: "proxy":"yes" when Render has the same PROXY_SECRET, "off" when Render has none, "no" when they differ.`
)
