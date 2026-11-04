import { X509Certificate } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite, type Transaction } from "@electric-sql/pglite"
import postgres from "postgres"
import type { Db } from "./context.js"

const here = path.dirname(fileURLToPath(import.meta.url))
/** apps/fairpay: a relative DATABASE_CA path is looked up here first, like the .env file beside it. */
const appDir = path.join(here, "..")
// Via apps/fairpay, so the bundled server (dist-server/index.mjs, one folder down like server/)
// finds it too.
const schemaFile = path.join(appDir, "server", "schema.sql")
const repoRoot = path.join(appDir, "..", "..")
/** Supabase's public root CA, committed so every computer has it. The same for every Supabase project. */
export const SUPABASE_CA_FILE = "certs/supabase-root-2021.crt"

export type OpenDb = Db & {
    /** "supabase" with DATABASE_URL, "local" for PGlite. Shown in the app's footer. */
    storage: "supabase" | "local"
    close(): Promise<void>
}

// BIGINT (int8) and NUMERIC (what SUM over BIGINT returns) come back as JS numbers. Money and
// times in this app are far below 2^53, so nothing is lost.
const INT8 = 20
const NUMERIC = 1700
const toNumber = (v: string) => Number(v)

/**
 * Opens the app's database and applies schema.sql (idempotent). DATABASE_URL picks postgres.js
 * (Supabase, TLS with the server's certificate verified, see tlsOptions); without it a local
 * PGlite lives in `dataDir` (default data/pg).
 */
export async function openDb(options: { databaseUrl?: string; databaseCa?: string; dataDir?: string } = {}): Promise<OpenDb> {
    const url = options.databaseUrl ?? process.env.DATABASE_URL
    if (url) return openPostgres(url, tlsOptions(url, options.databaseCa ?? process.env.DATABASE_CA))
    const dir = options.dataDir ?? path.join(here, "..", "data", "pg")
    mkdirSync(dir, { recursive: true })
    return openPglite(new PGlite(dir, { parsers: { [INT8]: toNumber, [NUMERIC]: toNumber } }))
}

/** A fresh in-memory database with the schema applied. For tests. */
export async function memoryDb(): Promise<OpenDb> {
    return openPglite(new PGlite({ parsers: { [INT8]: toNumber, [NUMERIC]: toNumber } }))
}

function schema() {
    return readFileSync(schemaFile, "utf8")
}

/** Unique-constraint violation (SQLSTATE 23505), from either driver. */
export function isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505"
}

// ------------------------------------------------------------------ PGlite

async function openPglite(pg: PGlite): Promise<OpenDb> {
    await pg.waitReady
    await pg.exec(schema())

    const wrap = (run: (sql: string, params: unknown[]) => Promise<unknown[]>, inTx: boolean): Db => {
        const self: Db = {
            async query<T>(sql: string, params: unknown[] = []) {
                return (await run(sql, params)) as T[]
            },
            async one<T>(sql: string, params: unknown[] = []) {
                return ((await run(sql, params)) as T[])[0]
            },
            // PGlite is a single connection: a nested tx just joins the open one.
            tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
                if (inTx) return fn(self)
                return pg.transaction((t: Transaction) => fn(wrap(async (sql, params) => (await t.query(sql, params)).rows, true)))
            }
        }
        return self
    }

    const db = wrap(async (sql, params) => (await pg.query(sql, params)).rows, false)
    return {
        ...db,
        storage: "local",
        close: () => pg.close()
    }
}

// ------------------------------------------------------------------ TLS to Postgres

export type TlsOptions = { rejectUnauthorized: true; ca?: string }

const SUPABASE_HOST = /(^|\.)supabase\.(co|com)$/i

/**
 * TLS settings for DATABASE_URL. The server's certificate is always verified, including its
 * host name: without that, anyone on the network path could pose as the database and read the
 * password and every row. Supabase signs its database and pooler certificates with its own root
 * CA, which isn't in the system's list, so for Supabase DATABASE_CA is required. It is the PEM
 * text of that CA, or the path of a file holding it (PEM or DER), e.g. a Render secret file.
 */
export function tlsOptions(url: string, caSetting: string | undefined): TlsOptions {
    let host = ""
    try {
        host = new URL(url).hostname
    } catch {
        throw new Error("DATABASE_URL is not a valid connection string.")
    }
    const setting = caSetting?.trim()
    if (!setting) {
        if (SUPABASE_HOST.test(host)) {
            throw new Error(
                "DATABASE_CA is not set. Supabase's database certificate is signed by Supabase's own CA, so the server can't verify it without that CA. " +
                    `The repo has it: put DATABASE_CA=${SUPABASE_CA_FILE} in apps/fairpay/.env (a path relative to apps/fairpay). ` +
                    "Or download it in the Supabase dashboard (Database Settings, SSL Configuration, Download certificate) and set DATABASE_CA to its contents or its file path. See DEPLOY.md."
            )
        }
        // A provider with a publicly trusted certificate: the system's CA list is enough.
        return { rejectUnauthorized: true }
    }
    return { rejectUnauthorized: true, ca: readCa(setting) }
}

function readCa(setting: string): string {
    // Inline PEM; some hosts store new lines as the two characters "\n".
    let pem = setting.includes("-----BEGIN") ? setting.replace(/\\n/g, "\n") : ""
    if (!pem) {
        const file = caPath(setting)
        let raw: Buffer
        try {
            raw = readFileSync(file)
        } catch (err) {
            const code = (err as { code?: string }).code ?? "unknown error"
            throw new Error(`DATABASE_CA points to ${file}, which can't be read (${code}). Check the file, or use DATABASE_CA=${SUPABASE_CA_FILE}.`)
        }
        const text = raw.toString("utf8")
        // DER (binary): wrap it as PEM.
        pem = text.includes("-----BEGIN")
            ? text
            : `-----BEGIN CERTIFICATE-----\n${raw.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`
    }
    try {
        new X509Certificate(pem)
    } catch {
        throw new Error("DATABASE_CA is not a valid certificate. Use the CA file from Supabase's dashboard (PEM text or its file path).")
    }
    return pem
}

/**
 * Where a DATABASE_CA file path points. An absolute path is used as it is. A relative one is looked
 * up in apps/fairpay first, then the repo root, then the current folder, so
 * `DATABASE_CA=certs/supabase-root-2021.crt` works on every computer, whatever folder the server
 * starts from. A path found nowhere is refused with a message that says where it looked.
 */
export function caPath(setting: string): string {
    const candidates = path.isAbsolute(setting)
        ? [setting]
        : [...new Set([path.resolve(appDir, setting), path.resolve(repoRoot, setting), path.resolve(setting)])]
    const found = candidates.find((p) => existsSync(p))
    if (found) return found
    const where = path.isAbsolute(setting) ? "" : ` (looked in apps/fairpay, the repo root and ${process.cwd()})`
    throw new Error(
        `DATABASE_CA is neither a PEM certificate nor a file that exists: ${setting}${where}. ` +
            `A path copied from another computer won't work here. Supabase's CA is in the repo: set DATABASE_CA=${SUPABASE_CA_FILE} in apps/fairpay/.env.`
    )
}

const TLS_CODES = new Set([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "CERT_UNTRUSTED",
    "CERT_SIGNATURE_FAILURE",
    "ERR_TLS_CERT_ALTNAME_INVALID"
])

/** A certificate failure on the first connection, said in words, or the error as it was. */
export function explainTlsError(err: unknown, tls: TlsOptions): unknown {
    const code = typeof err === "object" && err !== null ? String((err as { code?: unknown }).code ?? "") : ""
    if (!TLS_CODES.has(code)) return err
    const fix = tls.ca
        ? "Check that DATABASE_CA is your Supabase project's CA (Database Settings, SSL Configuration) and that DATABASE_URL uses the host from the Connect dialog."
        : "Set DATABASE_CA to the CA that signed the database's certificate (for Supabase: Database Settings, SSL Configuration). See DEPLOY.md."
    return new Error(`Could not verify the database's TLS certificate (${code}). ${fix}`, { cause: err })
}

// ------------------------------------------------------------------ postgres.js (Supabase)

async function openPostgres(url: string, tls: TlsOptions): Promise<OpenDb> {
    const sql = postgres(url, {
        // Verified TLS, whatever sslmode the URL asks for (an explicit option wins in postgres.js).
        ssl: tls,
        max: 10,
        // Supabase's poolers don't keep prepared statements across connections.
        prepare: false,
        idle_timeout: 30,
        connect_timeout: 15,
        transform: { undefined: null },
        types: {
            int8: { to: INT8, from: [INT8], serialize: (x: unknown) => String(x), parse: toNumber },
            numeric: { to: NUMERIC, from: [NUMERIC], serialize: (x: unknown) => String(x), parse: toNumber }
        },
        // Postgres NOTICEs (e.g. "relation already exists, skipping") are not worth a log line.
        onnotice: () => undefined
    })
    // Multi-statement text with no parameters runs over the simple protocol. This is also the first
    // connection, so a certificate problem shows up here.
    try {
        await sql.unsafe(schema())
    } catch (err) {
        await sql.end({ timeout: 1 }).catch(() => undefined)
        throw explainTlsError(err, tls)
    }

    type Runner = { unsafe: (q: string, p?: never[]) => Promise<unknown> }
    const wrap = (runner: Runner, inTx: boolean): Db => {
        const run = async (q: string, params: unknown[]) => {
            const rows = (await runner.unsafe(q, params as never[])) as unknown as Record<string, unknown>[]
            // postgres.js result arrays carry extra fields (count, command); hand back plain rows.
            return Array.from(rows)
        }
        const self: Db = {
            async query<T>(q: string, params: unknown[] = []) {
                return (await run(q, params)) as T[]
            },
            async one<T>(q: string, params: unknown[] = []) {
                return ((await run(q, params)) as T[])[0]
            },
            async tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
                if (inTx) return fn(self)
                return (await sql.begin((t) => fn(wrap(t as unknown as Runner, true)))) as T
            }
        }
        return self
    }

    return {
        ...wrap(sql as unknown as Runner, false),
        storage: "supabase",
        close: () => sql.end({ timeout: 5 })
    }
}
