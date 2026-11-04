// Image uploads for menus, chefs and covers. The type is decided by the file's magic bytes, never
// by the client's content-type, and only PNG, JPEG and WebP are accepted (no SVG: it can carry
// script). Images are served with nosniff and a CSP that allows nothing, so even a polyglot file
// can't run as a page.

import { createHash } from "node:crypto"
import { Hono } from "hono"
import { requireWallet } from "../auth.js"
import type { AppEnv, Deps } from "../context.js"
import { requireRole } from "../faireats.js"
import { clientIp, HttpError, rateLimiter } from "../http.js"
import { newId } from "../ids.js"

export const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_IMAGES_PER_RESTAURANT = 1000
/** Images live in the database, so each restaurant gets a fixed amount of it. */
export const MAX_RESTAURANT_IMAGE_BYTES = 25 * 1024 * 1024
/** New images stored per hour, per signed-in wallet and per client address. */
export const UPLOADS_PER_HOUR_WALLET = 30
export const UPLOADS_PER_HOUR_IP = 60
const IMAGE_ID = /^img_[a-z2-7]{16}$/

type Mime = "image/png" | "image/jpeg" | "image/webp"

/** The image type from its first bytes, or null when it isn't PNG, JPEG or WebP. */
export function sniffImage(b: Uint8Array): Mime | null {
    const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x)
    if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
    if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg"
    // "RIFF" <size> "WEBP"
    if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"
    return null
}

/** Reads the raw body, stopping as soon as it passes the limit (no buffering of huge uploads). */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
    const declared = Number(req.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "Images can be at most 1 MB.")
    if (!req.body) return new Uint8Array(0)
    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > max) {
            await reader.cancel().catch(() => undefined)
            throw new HttpError(413, "Images can be at most 1 MB.")
        }
        chunks.push(value)
    }
    const out = new Uint8Array(size)
    let off = 0
    for (const ch of chunks) {
        out.set(ch, off)
        off += ch.byteLength
    }
    return out
}

export function imageRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    // Wallets are free and one can own several restaurants, so uploads are also limited per
    // client address. Only images actually stored count; a re-upload of the same file doesn't.
    const perWallet = rateLimiter(UPLOADS_PER_HOUR_WALLET, 60 * 60_000, deps.now)
    const perIp = rateLimiter(UPLOADS_PER_HOUR_IP, 60 * 60_000, deps.now)
    const tooMany = new HttpError(429, "You've uploaded a lot of images in the last hour. Try again later.")

    app.post("/restaurants/:id/images", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, ["owner", "manager"])
        // Refuse before reading a megabyte from someone already over their allowance.
        if (perWallet.blocked(me) || perIp.blocked(clientIp(c))) throw tooMany
        const bytes = await readCapped(c.req.raw, MAX_IMAGE_BYTES)
        if (bytes.length === 0) throw new HttpError(400, "Send the image as the request body.")
        const mime = sniffImage(bytes)
        if (!mime) throw new HttpError(415, "Upload a PNG, JPEG or WebP image.")
        const used = await db.one<{ n: number; size: number }>("SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS size FROM images WHERE restaurant_id = $1", [
            restaurant.id
        ])
        if (Number(used?.n ?? 0) >= MAX_IMAGES_PER_RESTAURANT) throw new HttpError(409, "This restaurant has too many images. Remove some first.")
        const sha256 = createHash("sha256").update(bytes).digest("hex")
        // The same file uploaded twice for one restaurant reuses the stored copy.
        const dup = await db.one<{ id: string }>("SELECT id FROM images WHERE restaurant_id = $1 AND sha256 = $2 LIMIT 1", [restaurant.id, sha256])
        if (dup) return c.json({ url: `/api/images/${dup.id}` }, 200)
        if (Number(used?.size ?? 0) + bytes.length > MAX_RESTAURANT_IMAGE_BYTES) {
            throw new HttpError(413, `This restaurant has used its ${MAX_RESTAURANT_IMAGE_BYTES / (1024 * 1024)} MB of image storage. Reuse an image you've already uploaded.`)
        }
        if (!perWallet.hit(me) || !perIp.hit(clientIp(c))) throw tooMany
        const id = newId("img")
        // The quota is checked again in the INSERT, so two uploads at once can't both squeeze in.
        const stored = await db.query(
            `INSERT INTO images (id, restaurant_id, mime, bytes, size, sha256, uploaded_by, created_at)
             SELECT $1::text, $2::text, $3::text, $4::bytea, $5::int, $6::text, $7::text, $8::bigint
             WHERE (SELECT COALESCE(SUM(size), 0) FROM images WHERE restaurant_id = $2::text) + $5::int <= $9::bigint
             RETURNING id`,
            [id, restaurant.id, mime, bytes, bytes.length, sha256, me, deps.now(), MAX_RESTAURANT_IMAGE_BYTES]
        )
        if (stored.length === 0) throw new HttpError(413, "This restaurant has used all of its image storage.")
        return c.json({ url: `/api/images/${id}` }, 201)
    })

    app.get("/images/:id", async (c) => {
        const id = c.req.param("id")
        const row = IMAGE_ID.test(id) ? await db.one<{ mime: Mime; bytes: Uint8Array }>("SELECT mime, bytes FROM images WHERE id = $1", [id]) : undefined
        if (!row) throw new HttpError(404, "No such image.")
        const body = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as ArrayLike<number>)
        return new Response(body as Uint8Array<ArrayBuffer>, {
            status: 200,
            headers: {
                "Content-Type": row.mime,
                "Content-Length": String(body.byteLength),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Security-Policy": "default-src 'none'"
            }
        })
    })

    return app
}
