import { Hono } from "hono"
import type { Friend, Wallet } from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Deps } from "../context.js"
import { HttpError, readJson, str, wallet as parseWallet } from "../http.js"

const MAX_FRIENDS = 500

/** GET /friends, POST /friends {wallet, nickname}, DELETE /friends/:wallet */
export function friendRoutes(deps: Deps) {
    const app = new Hono<AppEnv>()

    app.get("/friends", async (c) => {
        const me = requireWallet(c)
        const rows = await deps.db.query<{ wallet: Wallet; nickname: string }>(
            "SELECT wallet, nickname FROM friends WHERE owner = $1 ORDER BY lower(nickname), wallet",
            [me]
        )
        const friends: Friend[] = rows.map((r) => ({ wallet: r.wallet, nickname: r.nickname }))
        return c.json(friends)
    })

    // Adds a friend, or renames one already added.
    app.post("/friends", async (c) => {
        const me = requireWallet(c)
        const body = await readJson(c)
        const w = parseWallet(body.wallet)
        const nickname = str(body.nickname, { max: 60, name: "Nickname" })
        if (w === me) throw new HttpError(400, "You can't add yourself as a friend.")
        const friend = await deps.db.tx(async (q) => {
            const count = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM friends WHERE owner = $1", [me])
            const exists = await q.one("SELECT 1 FROM friends WHERE owner = $1 AND wallet = $2", [me, w])
            if (!exists && (count?.n ?? 0) >= MAX_FRIENDS) throw new HttpError(409, `You can have at most ${MAX_FRIENDS} friends.`)
            await q.query(
                `INSERT INTO friends (owner, wallet, nickname, created_at) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (owner, wallet) DO UPDATE SET nickname = EXCLUDED.nickname`,
                [me, w, nickname, deps.now()]
            )
            return { wallet: w, nickname } satisfies Friend
        })
        return c.json(friend, 201)
    })

    app.delete("/friends/:wallet", async (c) => {
        const me = requireWallet(c)
        const w = parseWallet(c.req.param("wallet"))
        await deps.db.query("DELETE FROM friends WHERE owner = $1 AND wallet = $2", [me, w])
        return c.json({ ok: true })
    })

    return app
}
