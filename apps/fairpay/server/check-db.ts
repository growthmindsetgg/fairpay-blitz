// Checks that this computer reaches the database named in apps/fairpay/.env, with the certificate
// verified, without starting the server (so no relayer, faucet or indexer runs). Prints no secrets.
//   npm run check:db -w fairpay-app
import postgres from "postgres"
import { explainTlsError, tlsOptions } from "./db.js"
import { config } from "./env.js"

if (!config.databaseUrl) {
    console.log("No DATABASE_URL in apps/fairpay/.env: the app uses the local database in apps/fairpay/data/pg. Nothing to check.")
    process.exit(0)
}

try {
    const tls = tlsOptions(config.databaseUrl, process.env.DATABASE_CA)
    const sql = postgres(config.databaseUrl, { ssl: tls, max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined })
    try {
        await sql`select 1`
    } catch (err) {
        throw explainTlsError(err, tls)
    } finally {
        await sql.end({ timeout: 1 }).catch(() => undefined)
    }
    const host = new URL(config.databaseUrl).hostname
    console.log(`Database OK: connected to ${/supabase\.(co|com)$/i.test(host) ? "Supabase" : "the database"} with its certificate verified.`)
} catch (err) {
    console.error(`Database check failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
}
