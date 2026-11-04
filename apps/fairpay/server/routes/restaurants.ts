// FairEats restaurants: the public directory and storefront, registration, and everything an
// owner or their staff manage (settings, menu, chefs, tables, staff). Orders live in orders.ts, the
// owner's money view in money.ts, the dashboard's stats in stats.ts.

import { Hono } from "hono"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { isUniqueViolation } from "../db.js"
import {
    ID_RE,
    IMAGE_REF_RE,
    expireStaleOrders,
    loadChefs,
    loadMenu,
    loadStaff,
    loadTables,
    requireRole,
    roleFor,
    toChef,
    toMenuItem,
    toRestaurant,
    toRestaurants,
    toStaff,
    toTable,
    type RestaurantRow
} from "../faireats.js"
import { HttpError, bool, int, optStr, readJson, str, wallet as walletInput } from "../http.js"
import { newId } from "../ids.js"
import { moneyRoutes } from "./money.js"
import { statsRoutes } from "./stats.js"
import { payrollRoutes } from "./payroll.js"
import { teamPayRoutes } from "./teamPay.js"
import { STATE_CODES, isValidGstin, stateCode } from "../../shared/gst.js"
import type { Role, Table, Wallet } from "../../shared/types.js"

const MAX_BODY = 16 * 1024
const MAX_RESTAURANTS_PER_OWNER = 10
const MAX_MENU_ITEMS = 300
const MAX_CHEFS = 50
const MAX_TABLES = 100
const MAX_STAFF = 100
const MAX_PRICE = 10_000 * 1_000_000
const SLUG_RE = /^[a-z0-9-]{1,48}$/
const GST_RATES = [0, 500, 1200, 1800]
const TABLE_STATUSES: Table["status"][] = ["available", "occupied", "reserved", "closed"]
/**
 * A payout wallet must be the wallet the owner is signed in with: signing in proved control of
 * it. Otherwise anyone could point a restaurant at another business's allowlisted wallet and show
 * "Private payments" for money that never reaches them. (Payouts that already differ are kept.)
 */
const PAYOUT_NOT_YOURS = "The payout wallet must be the wallet you're signed in with. To be paid at another wallet, sign in with that wallet."
const MANAGERS: Role[] = ["owner", "manager"]
const ALL_STAFF: Role[] = ["owner", "manager", "chef", "waiter"]

type Body = Record<string, unknown>
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined

function shortAddress(w: string) {
    return `${w.slice(0, 6)}…${w.slice(-4)}`
}

/** URL slug from a name: "Saffron Table!" -> "saffron-table". */
export function slugify(name: string): string {
    const s = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "")
    return s || "restaurant"
}

/** Invoice prefix from a name: initials of up to 4 words ("Saffron Table" -> "ST"), else 3 letters. */
export function invoicePrefixBase(name: string): string {
    const words = name
        .normalize("NFKD")
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean)
    let p = words.length >= 2 ? words.slice(0, 4).map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3)
    if (p.length < 2) p = (p + "RR").slice(0, 2)
    return p
}

/** An image the restaurant may use: bundled menu art, or one of its own uploads. */
async function imageRef(db: Db, v: unknown, restaurantId: string | null, name: string): Promise<string | null> {
    const s = optStr(v, { max: 120, name })
    if (s === null) return null
    if (!IMAGE_REF_RE.test(s)) throw new HttpError(400, `${name} must be an uploaded image.`)
    if (s.startsWith("/api/images/")) {
        const id = s.slice("/api/images/".length)
        const img = await db.one<{ restaurant_id: string | null }>("SELECT restaurant_id FROM images WHERE id = $1", [id])
        if (!img || img.restaurant_id !== restaurantId) throw new HttpError(400, `${name} must be an image uploaded for this restaurant.`)
    }
    return s
}

type RestaurantFields = Partial<{
    name: string
    tagline: string | null
    description: string | null
    cuisine: string | null
    address: string | null
    city: string | null
    state: string
    gstin: string | null
    fssai: string | null
    gst_rate_bps: number
    service_charge_bps: number
    hours: string | null
    cover_image: string | null
    payout_wallet: Wallet
}>

/** Checks the restaurant fields present in the body. `current` is set for an update. */
async function parseRestaurantFields(db: Db, b: Body, current: RestaurantRow | null): Promise<RestaurantFields> {
    const f: RestaurantFields = {}
    const create = current === null
    if (create || has(b, "name")) f.name = str(b.name, { max: 80, name: "Name" })
    for (const [key, col, max, label] of [
        ["tagline", "tagline", 140, "Tagline"],
        ["description", "description", 1000, "Description"],
        ["cuisine", "cuisine", 60, "Cuisine"],
        ["address", "address", 200, "Address"],
        ["city", "city", 60, "City"],
        ["hours", "hours", 120, "Hours"]
    ] as const) {
        if (has(b, key)) f[col] = optStr(b[key], { max, name: label })
    }
    if (create || has(b, "state")) {
        const state = str(b.state, { max: 60, name: "State" })
        if (!stateCode(state)) throw new HttpError(400, "Choose an Indian state or union territory.")
        f.state = state
    }
    if (has(b, "gstin")) {
        const g = optStr(b.gstin, { max: 15, name: "GSTIN" })
        if (g === null) f.gstin = null
        else {
            const up = g.toUpperCase().replace(/\s+/g, "")
            if (!isValidGstin(up)) throw new HttpError(400, "That GSTIN is not valid. Check the 15 characters.")
            f.gstin = up
        }
    }
    const state = f.state ?? current?.state
    const gstin = f.gstin !== undefined ? f.gstin : (current?.gstin ?? null)
    if (gstin && state && gstin.slice(0, 2) !== STATE_CODES[state]) {
        throw new HttpError(400, `The GSTIN is registered in another state; ${state} GSTINs start with ${STATE_CODES[state]}.`)
    }
    if (has(b, "fssai")) {
        const s = optStr(b.fssai, { max: 20, name: "FSSAI licence" })
        if (s !== null && !/^[0-9]{14}$/.test(s)) throw new HttpError(400, "The FSSAI licence number is 14 digits.")
        f.fssai = s
    }
    if (has(b, "gstRateBps")) {
        const r = int(b.gstRateBps, { min: 0, max: 1800, name: "GST rate" })
        if (!GST_RATES.includes(r)) throw new HttpError(400, "GST rate must be 0%, 5%, 12% or 18%.")
        f.gst_rate_bps = r
    }
    if (has(b, "serviceChargeBps")) f.service_charge_bps = int(b.serviceChargeBps, { min: 0, max: 2000, name: "Service charge" })
    if (has(b, "coverImage")) f.cover_image = await imageRef(db, b.coverImage, current?.id ?? null, "Cover image")
    if (has(b, "payoutWallet")) f.payout_wallet = walletInput(b.payoutWallet, "Payout wallet")
    return f
}

/** Tables to create with a new restaurant: `tables` as a count with `seats`, or a list. */
function parseNewTables(b: Body): { label: string; seats: number }[] {
    if (!has(b, "tables") || b.tables === null) return []
    if (Array.isArray(b.tables)) {
        if (b.tables.length > MAX_TABLES) throw new HttpError(400, `At most ${MAX_TABLES} tables.`)
        const seen = new Set<string>()
        return b.tables.map((raw, i) => {
            const t = (raw && typeof raw === "object" ? raw : {}) as Body
            const label = has(t, "label") ? str(t.label, { max: 12, name: "Table label" }) : String(i + 1)
            if (seen.has(label)) throw new HttpError(400, `Table ${label} is listed twice.`)
            seen.add(label)
            return { label, seats: int(t.seats, { min: 1, max: 30, name: "Seats" }) }
        })
    }
    const count = int(b.tables, { min: 0, max: MAX_TABLES, name: "Number of tables" })
    const seats = has(b, "seats") ? int(b.seats, { min: 1, max: 30, name: "Seats" }) : 4
    return Array.from({ length: count }, (_, i) => ({ label: String(i + 1), seats }))
}

async function uniqueSlug(q: Db, name: string): Promise<string> {
    const base = slugify(name)
    for (let i = 1; i <= 200; i++) {
        const candidate = i === 1 ? base : `${base}-${i}`
        if (!(await q.one("SELECT 1 FROM restaurants WHERE slug = $1", [candidate]))) return candidate
    }
    throw new HttpError(409, "Choose a more distinctive name.")
}

/** Invoice numbers are unique across all restaurants, so prefixes must be too. */
async function uniquePrefix(q: Db, name: string): Promise<string> {
    const base = invoicePrefixBase(name)
    for (let i = 1; i <= 999; i++) {
        const candidate = i === 1 ? base : `${base.slice(0, 6 - String(i).length)}${i}`
        if (!(await q.one("SELECT 1 FROM restaurants WHERE invoice_prefix = $1", [candidate]))) return candidate
    }
    throw new HttpError(409, "Could not pick an invoice prefix. Choose a more distinctive name.")
}

function updateSql(table: string, cols: Record<string, unknown>, where: string, whereParams: unknown[]): { sql: string; params: unknown[] } {
    const keys = Object.keys(cols)
    const sets = keys.map((k, i) => `${k} = $${i + 1 + whereParams.length}`)
    return { sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${where} RETURNING *`, params: [...whereParams, ...keys.map((k) => cols[k])] }
}

export function restaurantRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()

    // ------------------------------------------------------------------ public

    app.get("/restaurants", async (c) => {
        const rows = await db.query<RestaurantRow>("SELECT * FROM restaurants ORDER BY is_demo DESC, created_at DESC, id LIMIT 200")
        return c.json(await toRestaurants(deps, rows))
    })

    app.get("/restaurants/:slug", async (c) => {
        const slug = c.req.param("slug")
        const row = SLUG_RE.test(slug) ? await db.one<RestaurantRow>("SELECT * FROM restaurants WHERE slug = $1", [slug]) : undefined
        if (!row) throw new HttpError(404, "No restaurant at that address.")
        // Tables held by orders nobody paid for come back before guests see the grid.
        await expireStaleOrders(db, row.id, deps.now())
        return c.json({
            restaurant: await toRestaurant(deps, row),
            menu: await loadMenu(db, row.id),
            chefs: await loadChefs(db, row.id),
            // Status only: which order sits where is staff business.
            tables: await loadTables(db, row.id, true)
        })
    })

    // ------------------------------------------------------------------ register and settings

    app.post("/restaurants", async (c) => {
        const me = requireWallet(c)
        const b = await readJson(c, MAX_BODY)
        const fields = await parseRestaurantFields(db, b, null)
        if (fields.payout_wallet !== undefined && fields.payout_wallet !== me) throw new HttpError(400, PAYOUT_NOT_YOURS)
        const tables = parseNewTables(b)
        const now = deps.now()
        const owned = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurants WHERE owner_wallet = $1", [me])
        if (Number(owned?.n ?? 0) >= MAX_RESTAURANTS_PER_OWNER) throw new HttpError(409, `One wallet can own at most ${MAX_RESTAURANTS_PER_OWNER} restaurants.`)

        // Two registrations can race for the same slug or prefix; the loser retries once.
        for (let attempt = 0; ; attempt++) {
            try {
                const row = await db.tx(async (q) => {
                    const id = newId("r")
                    const cols: Record<string, unknown> = {
                        id,
                        slug: await uniqueSlug(q, fields.name!),
                        invoice_prefix: await uniquePrefix(q, fields.name!),
                        owner_wallet: me,
                        payout_wallet: fields.payout_wallet ?? me,
                        created_at: now,
                        ...fields
                    }
                    const keys = Object.keys(cols)
                    const created = await q.one<RestaurantRow>(
                        `INSERT INTO restaurants (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
                        keys.map((k) => cols[k])
                    )
                    for (const t of tables) {
                        await q.query("INSERT INTO restaurant_tables (id, restaurant_id, label, seats, status, updated_at) VALUES ($1, $2, $3, $4, 'available', $5)", [
                            newId("t"),
                            id,
                            t.label,
                            t.seats,
                            now
                        ])
                    }
                    return created!
                })
                return c.json(await toRestaurant(deps, row), 201)
            } catch (err) {
                if (isUniqueViolation(err) && attempt < 2) continue
                throw err
            }
        }
    })

    app.put("/restaurants/:id", async (c) => {
        const me = requireWallet(c)
        const { restaurant, role } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const b = await readJson(c, MAX_BODY)
        const fields = await parseRestaurantFields(db, b, restaurant)
        if (fields.payout_wallet !== undefined && fields.payout_wallet !== restaurant.payout_wallet) {
            if (role !== "owner") throw new HttpError(403, "Only the owner can change the payout wallet.")
            if (fields.payout_wallet !== me) throw new HttpError(400, PAYOUT_NOT_YOURS)
        }
        if (Object.keys(fields).length === 0) return c.json(await toRestaurant(deps, restaurant))
        const { sql, params } = updateSql("restaurants", fields, "id = $1", [restaurant.id])
        const row = await db.one<RestaurantRow>(sql, params)
        return c.json(await toRestaurant(deps, row!))
    })

    app.get("/restaurants/:id/manage", async (c) => {
        const me = requireWallet(c)
        const { restaurant, role } = await requireRole(db, c.req.param("id"), me, ALL_STAFF)
        await expireStaleOrders(db, restaurant.id, deps.now())
        return c.json({
            restaurant: await toRestaurant(deps, restaurant),
            menu: await loadMenu(db, restaurant.id),
            chefs: await loadChefs(db, restaurant.id),
            tables: await loadTables(db, restaurant.id),
            // Colleagues' wallets are for the people who manage staff.
            staff: MANAGERS.includes(role) ? await loadStaff(db, restaurant.id) : [],
            role
        })
    })

    // ------------------------------------------------------------------ menu

    async function parseMenuFields(b: Body, restaurantId: string, create: boolean) {
        const f: Record<string, unknown> = {}
        if (create || has(b, "name")) f.name = str(b.name, { max: 80, name: "Dish name" })
        if (has(b, "description")) f.description = optStr(b.description, { max: 280, name: "Description" })
        if (create || has(b, "category")) f.category = str(b.category, { max: 40, name: "Category" })
        if (create || has(b, "price")) {
            const price = int(b.price, { min: 10_000, max: MAX_PRICE, name: "Price" })
            if (price % 10_000 !== 0) throw new HttpError(400, "Price must be a whole number of cents.")
            f.price = price
        }
        if (has(b, "image")) f.image = await imageRef(db, b.image, restaurantId, "Image")
        if (has(b, "veg")) f.veg = bool(b.veg, "Veg")
        if (has(b, "spice")) f.spice = int(b.spice, { min: 0, max: 3, name: "Spice" })
        if (has(b, "prepMinutes")) f.prep_minutes = int(b.prepMinutes, { min: 1, max: 180, name: "Prep time" })
        if (has(b, "available")) f.available = bool(b.available, "Available")
        if (has(b, "sac")) {
            const sac = str(b.sac, { max: 8, name: "SAC" })
            if (!/^[0-9]{4,8}$/.test(sac)) throw new HttpError(400, "SAC must be 4 to 8 digits.")
            f.sac = sac
        }
        if (has(b, "sort")) f.sort = int(b.sort, { min: -100_000, max: 100_000, name: "Sort order" })
        return f
    }

    app.post("/restaurants/:id/menu", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const f = await parseMenuFields(await readJson(c, MAX_BODY), restaurant.id, true)
        const n = await db.one<{ n: number; top: number | null }>("SELECT COUNT(*)::int AS n, MAX(sort) AS top FROM menu_items WHERE restaurant_id = $1", [restaurant.id])
        if (Number(n?.n ?? 0) >= MAX_MENU_ITEMS) throw new HttpError(409, `A menu can have at most ${MAX_MENU_ITEMS} dishes.`)
        const cols: Record<string, unknown> = { id: newId("m"), restaurant_id: restaurant.id, sort: Number(n?.top ?? 0) + 1, ...f }
        const keys = Object.keys(cols)
        const row = await db.one<Parameters<typeof toMenuItem>[0]>(
            `INSERT INTO menu_items (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
            keys.map((k) => cols[k])
        )
        return c.json(toMenuItem(row!), 201)
    })

    app.put("/restaurants/:id/menu/:itemId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const itemId = c.req.param("itemId")
        const f = await parseMenuFields(await readJson(c, MAX_BODY), restaurant.id, false)
        const existing = ID_RE.test(itemId)
            ? await db.one<Parameters<typeof toMenuItem>[0]>("SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2", [itemId, restaurant.id])
            : undefined
        if (!existing) throw new HttpError(404, "No such dish on this menu.")
        if (Object.keys(f).length === 0) return c.json(toMenuItem(existing))
        const { sql, params } = updateSql("menu_items", f, "id = $1 AND restaurant_id = $2", [itemId, restaurant.id])
        return c.json(toMenuItem((await db.one<Parameters<typeof toMenuItem>[0]>(sql, params))!))
    })

    app.delete("/restaurants/:id/menu/:itemId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const itemId = c.req.param("itemId")
        // Past orders keep their own copy of the name and price, so deleting is safe.
        const rows = ID_RE.test(itemId) ? await db.query("DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2 RETURNING id", [itemId, restaurant.id]) : []
        if (rows.length === 0) throw new HttpError(404, "No such dish on this menu.")
        return c.json({ ok: true })
    })

    // ------------------------------------------------------------------ chefs

    async function parseChefFields(b: Body, restaurantId: string, create: boolean) {
        const f: Record<string, unknown> = {}
        if (create || has(b, "name")) f.name = str(b.name, { max: 60, name: "Chef's name" })
        if (has(b, "title")) f.title = optStr(b.title, { max: 60, name: "Title" })
        if (has(b, "bio")) f.bio = optStr(b.bio, { max: 400, name: "Bio" })
        if (has(b, "specialty")) f.specialty = optStr(b.specialty, { max: 80, name: "Specialty" })
        if (has(b, "years")) f.years = b.years === null ? null : int(b.years, { min: 0, max: 70, name: "Years" })
        if (has(b, "photo")) f.photo = await imageRef(db, b.photo, restaurantId, "Photo")
        if (has(b, "onDuty")) f.on_duty = bool(b.onDuty, "On duty")
        return f
    }

    app.post("/restaurants/:id/chefs", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const f = await parseChefFields(await readJson(c, MAX_BODY), restaurant.id, true)
        const n = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM chefs WHERE restaurant_id = $1", [restaurant.id])
        if (Number(n?.n ?? 0) >= MAX_CHEFS) throw new HttpError(409, `At most ${MAX_CHEFS} chefs.`)
        const cols: Record<string, unknown> = { id: newId("c"), restaurant_id: restaurant.id, ...f }
        const keys = Object.keys(cols)
        const row = await db.one<Parameters<typeof toChef>[0]>(
            `INSERT INTO chefs (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
            keys.map((k) => cols[k])
        )
        return c.json(toChef(row!), 201)
    })

    app.put("/restaurants/:id/chefs/:chefId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const chefId = c.req.param("chefId")
        const f = await parseChefFields(await readJson(c, MAX_BODY), restaurant.id, false)
        const existing = ID_RE.test(chefId)
            ? await db.one<Parameters<typeof toChef>[0]>("SELECT * FROM chefs WHERE id = $1 AND restaurant_id = $2", [chefId, restaurant.id])
            : undefined
        if (!existing) throw new HttpError(404, "No such chef here.")
        if (Object.keys(f).length === 0) return c.json(toChef(existing))
        const { sql, params } = updateSql("chefs", f, "id = $1 AND restaurant_id = $2", [chefId, restaurant.id])
        return c.json(toChef((await db.one<Parameters<typeof toChef>[0]>(sql, params))!))
    })

    app.delete("/restaurants/:id/chefs/:chefId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const chefId = c.req.param("chefId")
        const rows = ID_RE.test(chefId) ? await db.query("DELETE FROM chefs WHERE id = $1 AND restaurant_id = $2 RETURNING id", [chefId, restaurant.id]) : []
        if (rows.length === 0) throw new HttpError(404, "No such chef here.")
        return c.json({ ok: true })
    })

    // ------------------------------------------------------------------ tables

    type TableRow = Parameters<typeof toTable>[0]

    app.post("/restaurants/:id/tables", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const b = await readJson(c, MAX_BODY)
        const label = str(b.label, { max: 12, name: "Table label" })
        const seats = int(b.seats, { min: 1, max: 30, name: "Seats" })
        const n = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurant_tables WHERE restaurant_id = $1", [restaurant.id])
        if (Number(n?.n ?? 0) >= MAX_TABLES) throw new HttpError(409, `At most ${MAX_TABLES} tables.`)
        try {
            const row = await db.one<TableRow>(
                "INSERT INTO restaurant_tables (id, restaurant_id, label, seats, status, updated_at) VALUES ($1, $2, $3, $4, 'available', $5) RETURNING id, label, seats, status, order_id",
                [newId("t"), restaurant.id, label, seats, deps.now()]
            )
            return c.json(toTable(row!), 201)
        } catch (err) {
            if (isUniqueViolation(err)) throw new HttpError(409, `There is already a table ${label}.`)
            throw err
        }
    })

    app.put("/restaurants/:id/tables/:tableId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const tableId = c.req.param("tableId")
        const b = await readJson(c, MAX_BODY)
        const f: Record<string, unknown> = {}
        if (has(b, "label")) f.label = str(b.label, { max: 12, name: "Table label" })
        if (has(b, "seats")) f.seats = int(b.seats, { min: 1, max: 30, name: "Seats" })
        const existing = ID_RE.test(tableId)
            ? await db.one<TableRow>("SELECT id, label, seats, status, order_id FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2", [tableId, restaurant.id])
            : undefined
        if (!existing) throw new HttpError(404, "No such table here.")
        if (Object.keys(f).length === 0) return c.json(toTable(existing))
        f.updated_at = deps.now()
        try {
            const keys = Object.keys(f)
            const row = await db.one<TableRow>(
                `UPDATE restaurant_tables SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE id = $1 AND restaurant_id = $2 RETURNING id, label, seats, status, order_id`,
                [tableId, restaurant.id, ...keys.map((k) => f[k])]
            )
            return c.json(toTable(row!))
        } catch (err) {
            if (isUniqueViolation(err)) throw new HttpError(409, `There is already a table ${String(f.label)}.`)
            throw err
        }
    })

    app.delete("/restaurants/:id/tables/:tableId", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const tableId = c.req.param("tableId")
        if (!ID_RE.test(tableId)) throw new HttpError(404, "No such table here.")
        await db.tx(async (q) => {
            const t = await q.one<TableRow>("SELECT id, label, seats, status, order_id FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [
                tableId,
                restaurant.id
            ])
            if (!t) throw new HttpError(404, "No such table here.")
            const active = await q.one(
                "SELECT 1 FROM orders WHERE table_id = $1 AND status NOT IN ('served', 'cancelled') LIMIT 1",
                [tableId]
            )
            if (active) throw new HttpError(409, `Table ${t.label} has an order in progress. Serve or cancel it first.`)
            // Finished orders keep their invoice; they just stop pointing at the removed table.
            await q.query("UPDATE orders SET table_id = NULL WHERE table_id = $1", [tableId])
            await q.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId])
        })
        return c.json({ ok: true })
    })

    app.put("/restaurants/:id/tables/:tableId/status", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, ["owner", "manager", "waiter"])
        const tableId = c.req.param("tableId")
        const b = await readJson(c, MAX_BODY)
        if (typeof b.status !== "string" || !TABLE_STATUSES.includes(b.status as Table["status"])) {
            throw new HttpError(400, "Status must be available, occupied, reserved or closed.")
        }
        const status = b.status as Table["status"]
        if (!ID_RE.test(tableId)) throw new HttpError(404, "No such table here.")
        const row = await db.tx(async (q) => {
            const t = await q.one<TableRow>("SELECT id, label, seats, status, order_id FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [
                tableId,
                restaurant.id
            ])
            if (!t) throw new HttpError(404, "No such table here.")
            let orderId = t.order_id
            if (orderId) {
                const o = await q.one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId])
                const open = o && o.status !== "served" && o.status !== "cancelled"
                // The table belongs to that order until it is served or cancelled.
                if (open && status !== "occupied") throw new HttpError(409, `Table ${t.label} has an order that hasn't been served yet.`)
                if (!open) orderId = null
            }
            if (status !== "occupied") orderId = null
            return q.one<TableRow>(
                "UPDATE restaurant_tables SET status = $2, order_id = $3, updated_at = $4 WHERE id = $1 RETURNING id, label, seats, status, order_id",
                [tableId, status, orderId, deps.now()]
            )
        })
        return c.json(toTable(row!))
    })

    // ------------------------------------------------------------------ staff

    app.get("/restaurants/:id/staff", async (c) => {
        const me = requireWallet(c)
        const { restaurant } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        return c.json(await loadStaff(db, restaurant.id))
    })

    app.post("/restaurants/:id/staff", async (c) => {
        const me = requireWallet(c)
        const { restaurant, role } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const b = await readJson(c, MAX_BODY)
        const w = walletInput(b.wallet)
        if (typeof b.role !== "string" || !["manager", "chef", "waiter"].includes(b.role)) throw new HttpError(400, "Role must be manager, chef or waiter.")
        const newRole = b.role as "manager" | "chef" | "waiter"
        const displayName = optStr(b.displayName, { max: 60, name: "Name" }) ?? shortAddress(w)
        if (w === restaurant.owner_wallet) throw new HttpError(400, "That wallet is the owner.")
        if (role === "manager" && newRole === "manager") throw new HttpError(403, "Only the owner can add managers.")
        const existing = await roleFor(db, restaurant.id, w)
        if (role === "manager" && existing === "manager") throw new HttpError(403, "Only the owner can change a manager's role.")
        if (!existing) {
            const n = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurant_staff WHERE restaurant_id = $1", [restaurant.id])
            if (Number(n?.n ?? 0) >= MAX_STAFF) throw new HttpError(409, `At most ${MAX_STAFF} staff.`)
        }
        const now = deps.now()
        const row = await db.tx(async (q) => {
            const r = await q.one<Parameters<typeof toStaff>[0]>(
                `INSERT INTO restaurant_staff (restaurant_id, wallet, role, display_name, added_at) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (restaurant_id, wallet) DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name
                 RETURNING wallet, role, display_name, added_at`,
                [restaurant.id, w, newRole, displayName, now]
            )
            if (existing !== newRole) {
                await q.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, 'staff_added', $2, $3, $4, $5)", [
                    w,
                    `You're now a ${newRole} at ${restaurant.name}`,
                    null,
                    `/business/faireats/manage/${restaurant.id}`,
                    now
                ])
            }
            return r
        })
        return c.json(toStaff(row!), existing ? 200 : 201)
    })

    app.delete("/restaurants/:id/staff/:wallet", async (c) => {
        const me = requireWallet(c)
        const { restaurant, role } = await requireRole(db, c.req.param("id"), me, MANAGERS)
        const w = walletInput(c.req.param("wallet"))
        const existing = await db.one<{ role: string }>("SELECT role FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2", [restaurant.id, w])
        if (!existing) throw new HttpError(404, "That wallet isn't on the staff.")
        if (role === "manager" && existing.role === "manager") throw new HttpError(403, "Only the owner can remove a manager.")
        await db.query("DELETE FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2", [restaurant.id, w])
        return c.json({ ok: true })
    })

    // ------------------------------------------------------------------ money (owner only)

    app.route("/", moneyRoutes(deps))

    // ------------------------------------------------------------------ dashboard stats (staff; money owner only)

    app.route("/", statsRoutes(deps))

    // ------------------------------------------------------------------ team pay (owner only)

    app.route("/", teamPayRoutes(deps))
    // Team pay part 2, the payroll escrow (503 until the deployment has a payroll contract).
    app.route("/", payrollRoutes(deps))

    return app
}
