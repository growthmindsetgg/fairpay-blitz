// TLS to the cloud database: the certificate is always verified, Supabase needs its CA,
// and a missing or wrong CA is explained at startup instead of failing with a bare TLS code.

import { X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { caPath, explainTlsError, SUPABASE_CA_FILE, tlsOptions } from "../server/db.js"

// A throwaway self-signed certificate made for this test (its key was never kept).
const CA = `-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIULL3KC+4k3Mo6RV/8+NuV/r27Ya0wCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPRmFpclBheSB0ZXN0IENBMCAXDTI2MTAzMTE5MDg1M1oYDzIx
MjYxMDA3MTkwODUzWjAaMRgwFgYDVQQDDA9GYWlyUGF5IHRlc3QgQ0EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQCzQECSbW1SSPzRk4orJk/5sysiCs5tg9wb9pq
TLln8mDmJakJrYtflGiKdwuX4JXjUC4F3IY1WczbwliA4Pwao1MwUTAdBgNVHQ4E
FgQUynAfL7IS7RL3/P+vBHidG5AxLSAwHwYDVR0jBBgwFoAUynAfL7IS7RL3/P+v
BHidG5AxLSAwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAjPKS
/KgxEwOO6PchG+VSIEzp8ipkBuMN2p1Fm6c9BZ4CIBosOWycGwuxSSEa5cLkjtL7
u1cNg9wC/nMSlYlBFzbt
-----END CERTIFICATE-----
`

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SUPABASE = "postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
const dir = mkdtempSync(path.join(tmpdir(), "fairpay-ca-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("database TLS", () => {
    it("always verifies the certificate", () => {
        expect(tlsOptions("postgres://u:p@db.example.com:5432/app", undefined)).toEqual({ rejectUnauthorized: true })
        expect(tlsOptions(SUPABASE, CA)).toEqual({ rejectUnauthorized: true, ca: CA.trim() })
    })

    it("refuses to start against Supabase without its CA, and says what to do", () => {
        expect(() => tlsOptions(SUPABASE, undefined)).toThrow(/DATABASE_CA is not set.*Supabase.*DEPLOY\.md/)
        expect(() => tlsOptions("postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres", "  ")).toThrow(/DATABASE_CA is not set/)
    })

    it("takes the CA as PEM text (also with escaped new lines) or as a PEM or DER file", () => {
        expect(tlsOptions(SUPABASE, CA.replace(/\n/g, "\\n")).ca).toContain("-----BEGIN CERTIFICATE-----\nMIIB")
        const pemFile = path.join(dir, "ca.crt")
        writeFileSync(pemFile, CA)
        expect(tlsOptions(SUPABASE, pemFile).ca).toBe(CA)
        const der = Buffer.from(CA.replace(/-----[A-Z ]+-----|\s/g, ""), "base64")
        const derFile = path.join(dir, "ca.cer")
        writeFileSync(derFile, der)
        const fromDer = tlsOptions(SUPABASE, derFile).ca!
        expect(fromDer.replace(/\s/g, "")).toBe(CA.replace(/\s/g, ""))
    })

    it("ships Supabase's public root CA and finds it by a relative path from any folder", () => {
        const committed = readFileSync(path.join(appDir, SUPABASE_CA_FILE), "utf8")
        const cert = new X509Certificate(committed)
        expect(cert.subject).toContain("CN=Supabase Root 2021 CA")
        expect(cert.ca).toBe(true)
        expect(committed).not.toMatch(/PRIVATE KEY/)
        // Relative to apps/fairpay (what apps/fairpay/.env should say) and to the repo root.
        expect(tlsOptions(SUPABASE, SUPABASE_CA_FILE).ca).toBe(committed)
        expect(tlsOptions(SUPABASE, `apps/fairpay/${SUPABASE_CA_FILE}`).ca).toBe(committed)
        expect(caPath(SUPABASE_CA_FILE)).toBe(path.join(appDir, SUPABASE_CA_FILE))
    })

    it("explains a CA that is missing, unreadable or isn't a certificate", () => {
        expect(() => tlsOptions(SUPABASE, path.join(dir, "nope.crt"))).toThrow(/neither a PEM certificate nor a file that exists/)
        // An absolute path from another computer: says so and names the committed CA.
        expect(() => tlsOptions(SUPABASE, path.join(dir, "Users", "someone", "supabase-ca.crt"))).toThrow(
            /another computer.*DATABASE_CA=certs\/supabase-root-2021\.crt/
        )
        expect(() => tlsOptions(SUPABASE, "no-such-folder/ca.crt")).toThrow(/looked in apps\/fairpay, the repo root/)
        // A folder instead of a file can't be read.
        expect(() => tlsOptions(SUPABASE, dir)).toThrow(/can't be read \(EISDIR\)/)
        expect(() => tlsOptions(SUPABASE, "-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----")).toThrow(/not a valid certificate/)
        expect(() => tlsOptions("not a url", CA)).toThrow(/DATABASE_URL is not a valid/)
    })

    it("turns a certificate failure on connect into a clear message, and leaves other errors alone", () => {
        const tlsErr = Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })
        const noCa = explainTlsError(tlsErr, { rejectUnauthorized: true }) as Error
        expect(noCa.message).toMatch(/Could not verify the database's TLS certificate \(SELF_SIGNED_CERT_IN_CHAIN\)\. Set DATABASE_CA/)
        const wrongCa = explainTlsError(tlsErr, { rejectUnauthorized: true, ca: CA }) as Error
        expect(wrongCa.message).toMatch(/Check that DATABASE_CA is your Supabase project's CA/)
        const other = Object.assign(new Error("password authentication failed"), { code: "28P01" })
        expect(explainTlsError(other, { rejectUnauthorized: true })).toBe(other)
    })
})
