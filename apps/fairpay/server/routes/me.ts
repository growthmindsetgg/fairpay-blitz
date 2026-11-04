import { Hono } from "hono"
import type { Profile, Wallet } from "../../shared/types.js"
import { ensureProfile, loadMe, requireWallet } from "../auth.js"
import type { AppEnv, Deps } from "../context.js"
import { HttpError, optStr, readJson, wallet as parseWallet } from "../http.js"

// Deliberately simple: one @, no spaces, a dot in the domain. Real checking is a confirmation
// email, which v1 doesn't send.
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/

type ProfileRow = { wallet: Wallet; display_name: string | null; email: string | null; bio: string | null }

/** GET /me, PUT /me, GET /profiles/:wallet */
export function meRoutes(deps: Deps) {
    const app = new Hono<AppEnv>()

    app.get("/me", async (c) => {
        const me = requireWallet(c)
        return c.json(await loadMe(deps.db, me))
    })

    // Only the fields sent change; null or "" clears one.
    app.put("/me", async (c) => {
        const me = requireWallet(c)
        const body = await readJson(c)
        const sets: string[] = []
        const params: unknown[] = [me]
        const set = (column: string, value: string | null) => {
            params.push(value)
            sets.push(`${column} = $${params.length}`)
        }
        if ("displayName" in body) set("display_name", optStr(body.displayName, { max: 60, name: "Name" }))
        if ("email" in body) {
            const email = optStr(body.email, { max: 254, name: "Email" })
            if (email !== null && !EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.")
            set("email", email)
        }
        if ("bio" in body) set("bio", optStr(body.bio, { max: 280, name: "Bio" }))
        const now = deps.now()
        await ensureProfile(deps.db, me, now)
        params.push(now)
        sets.push(`updated_at = $${params.length}`)
        const row = await deps.db.one<ProfileRow>(
            `UPDATE profiles SET ${sets.join(", ")} WHERE wallet = $1 RETURNING wallet, display_name, email, bio`,
            params
        )
        const profile: Profile = { wallet: me, displayName: row?.display_name ?? null, email: row?.email ?? null, bio: row?.bio ?? null }
        return c.json(profile)
    })

    // Public: name only, never email or bio.
    app.get("/profiles/:wallet", async (c) => {
        const w = parseWallet(c.req.param("wallet"))
        const row = await deps.db.one<{ display_name: string | null }>("SELECT display_name FROM profiles WHERE wallet = $1", [w])
        return c.json({ wallet: w, displayName: row?.display_name ?? null })
    })

    return app
}
