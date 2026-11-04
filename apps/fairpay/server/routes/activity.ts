import { Hono } from "hono"
import type { ActivityItem, Wallet } from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { HttpError, int } from "../http.js"

export type ActivityKind =
    | "bill_created"
    | "bill_request"
    | "payment_received"
    | "payment_sent"
    | "bill_settled"
    | "order_placed"
    | "order_update"
    | "staff_added"

/**
 * Adds one notification. Text is written by the server; never put a confidential payer in it.
 * Pass the transaction's `q` when inside one.
 */
export async function addActivity(
    q: Db,
    a: { wallet: Wallet; kind: ActivityKind; title: string; detail?: string | null; link?: string | null },
    now: number
) {
    await q.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        a.wallet.toLowerCase(),
        a.kind,
        a.title.slice(0, 200),
        a.detail?.slice(0, 500) ?? null,
        a.link ?? null,
        now
    ])
}

type Row = { id: number; kind: string; title: string; detail: string | null; link: string | null; read_at: number | null; created_at: number }

type PaymentRow = {
    tx_hash: `0x${string}`
    kind: "public" | "private"
    payer: string
    recipient: string
    verified_at: number
    /** The link settle (routes/pay.ts) puts on the recipient's activity row for this payment. */
    link: string | null
    owner: string | null
}

/**
 * The public transaction behind each payment entry, for an explorer link. Activity rows carry no
 * payment id, so a row is matched to the payment credited in the same transaction (same time) for
 * the same bill or restaurant, received or sent by this wallet. Only a single match that is public
 * counts. A confidential payment never gets a hash: its transaction would undo "hides who paid".
 */
async function publicTxs(db: Db, me: string, rows: Row[]): Promise<Map<number, `0x${string}`>> {
    const found = new Map<number, `0x${string}`>()
    const wanted = rows.filter((r) => r.kind === "payment_received" || r.kind === "payment_sent")
    if (wanted.length === 0) return found
    const times = [...new Set(wanted.map((r) => Number(r.created_at)))]
    const marks = times.map((_, i) => `$${i + 1}`).join(", ")
    const payments = await db.query<PaymentRow>(
        `SELECT y.tx_hash, y.kind, y.payer, y.recipient, y.verified_at, r.owner_wallet AS owner,
                CASE WHEN y.target_kind = 'bill' THEN '/bills/' || bp.bill_id ELSE '/business/faireats/manage/' || o.restaurant_id END AS link
         FROM payments y
         LEFT JOIN bill_participants bp ON y.target_kind = 'bill' AND bp.id = y.target_id
         LEFT JOIN order_shares s ON y.target_kind = 'order' AND s.id = y.target_id
         LEFT JOIN orders o ON o.id = s.order_id
         LEFT JOIN restaurants r ON r.id = o.restaurant_id
         WHERE y.verified_at IN (${marks})`,
        times
    )
    for (const a of wanted) {
        const at = Number(a.created_at)
        const matches = payments.filter((p) => {
            if (Number(p.verified_at) !== at || !p.link) return false
            // "You paid": settle writes it only for public payments, to the paying wallet.
            if (a.kind === "payment_sent") return p.payer === me && (a.link === null || a.link === p.link)
            // "… paid" / "Confidential payment received": to the bill's recipient or the restaurant's owner.
            return a.link === p.link && (p.link.startsWith("/bills/") ? p.recipient === me : p.owner === me)
        })
        // Two payments in the same moment are ambiguous; showing no link beats showing a wrong one.
        if (matches.length === 1 && matches[0]!.kind === "public") found.set(a.id, matches[0]!.tx_hash)
    }
    return found
}

/** GET /activity (newest first, ?before=<id> for older), POST /activity/read. */
export function activityRoutes(deps: Deps) {
    const app = new Hono<AppEnv>()

    app.get("/activity", async (c) => {
        const me = requireWallet(c)
        const beforeRaw = c.req.query("before")
        const before = beforeRaw === undefined ? null : Number(beforeRaw)
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new HttpError(400, "before must be an activity id.")
        const rows = before === null
            ? await deps.db.query<Row>(
                "SELECT id, kind, title, detail, link, read_at, created_at FROM activity WHERE wallet = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
                [me]
            )
            : await deps.db.query<Row>(
                "SELECT id, kind, title, detail, link, read_at, created_at FROM activity WHERE wallet = $1 AND id < $2 ORDER BY created_at DESC, id DESC LIMIT 100",
                [me, before]
            )
        const txs = await publicTxs(deps.db, me.toLowerCase(), rows)
        const items: ActivityItem[] = rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            detail: r.detail,
            link: r.link,
            read: r.read_at !== null,
            createdAt: r.created_at,
            txHash: txs.get(r.id) ?? null
        }))
        return c.json(items)
    })

    // Marks everything read, or only the ids given ({ ids: number[] }).
    app.post("/activity/read", async (c) => {
        const me = requireWallet(c)
        const text = await c.req.text()
        const body: Record<string, unknown> = text.trim() === "" ? {} : await readJsonFromText(text)
        const now = deps.now()
        if (body.ids !== undefined) {
            if (!Array.isArray(body.ids) || body.ids.length > 200) throw new HttpError(400, "ids must be a list of up to 200 ids.")
            const ids = body.ids.map((x) => int(x, { min: 1, max: Number.MAX_SAFE_INTEGER, name: "Activity id" }))
            if (ids.length > 0) {
                const marks = ids.map((_, i) => `$${i + 3}`).join(", ")
                await deps.db.query(`UPDATE activity SET read_at = $2 WHERE wallet = $1 AND read_at IS NULL AND id IN (${marks})`, [me, now, ...ids])
            }
        } else {
            await deps.db.query("UPDATE activity SET read_at = $2 WHERE wallet = $1 AND read_at IS NULL", [me, now])
        }
        return c.json({ ok: true })
    })

    return app
}

async function readJsonFromText(text: string): Promise<Record<string, unknown>> {
    let body: unknown
    try {
        body = JSON.parse(text)
    } catch {
        throw new HttpError(400, "Send a valid JSON body.")
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Send a JSON object.")
    return body as Record<string, unknown>
}
