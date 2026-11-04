import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"
import { assignInvoiceNo, estimateReadyAt, onOrderPaid } from "../server/faireats.js"
import { DINE_IN_INTRA_STATE } from "../server/routes/orders.js"
import { invoicePrefixBase, slugify } from "../server/routes/restaurants.js"
import { sniffImage } from "../server/routes/images.js"
import { DEMO_GSTIN, DEMO_MENU, refreshDemoOrders, seedDemo } from "../server/seed.js"
import { computeBill, financialYear, isValidGstin } from "../shared/gst.js"
import type { Bill, Invoice, MenuItem, Order, Restaurant, StaffMember, StorefrontView, Table, Wallet } from "../shared/types.js"
import { fakeChain, makeTestApp, txHash, type TestApp } from "./helpers.js"

const U = 1_000_000
const OWNER = "0x1111111111111111111111111111111111111111" as Wallet
const MANAGER = "0x2222222222222222222222222222222222222222" as Wallet
const CHEF = "0x3333333333333333333333333333333333333333" as Wallet
const WAITER = "0x4444444444444444444444444444444444444444" as Wallet
const GUEST = "0x5555555555555555555555555555555555555555" as Wallet
const OUTSIDER = "0x6666666666666666666666666666666666666666" as Wallet
const FRIEND = "0x7777777777777777777777777777777777777777" as Wallet
const PAYOUT = "0x8888888888888888888888888888888888888888" as Wallet
const T0 = Date.parse("2026-10-31T12:00:00+05:30")

const here = path.dirname(fileURLToPath(import.meta.url))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])

type Ctx = TestApp & { clock: { t: number }; cookies: Record<string, string> }

async function setup(): Promise<Ctx> {
    const clock = { t: T0 }
    const t = await makeTestApp({ chain: fakeChain({ merchants: [PAYOUT] }), now: () => clock.t })
    const cookies: Record<string, string> = {}
    for (const [name, w] of Object.entries({ OWNER, MANAGER, CHEF, WAITER, GUEST, OUTSIDER, FRIEND })) cookies[name] = await t.signIn(w)
    return { ...t, clock, cookies }
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    const body = await r.json()
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`)
    return body as T
}

async function status(res: Response | Promise<Response>): Promise<number> {
    const r = await res
    await r.arrayBuffer()
    return r.status
}

/** A restaurant with a manager, chef and waiter, a GSTIN, 4 tables and a small menu. */
async function restaurantWithStaff(t: Ctx, extra: Record<string, unknown> = {}) {
    const r = await json<Restaurant>(
        t.call("POST", "/api/restaurants", {
            cookie: t.cookies.OWNER,
            body: { name: "Spice Route", cuisine: "South Indian", city: "Bengaluru", state: "Karnataka", gstin: DEMO_GSTIN, tables: 4, seats: 4, ...extra }
        }),
        201
    )
    for (const [w, role] of [[MANAGER, "manager"], [CHEF, "chef"], [WAITER, "waiter"]] as const) {
        await json(t.call("POST", `/api/restaurants/${r.id}/staff`, { cookie: t.cookies.OWNER, body: { wallet: w, role, displayName: role } }), 201)
    }
    const dosa = await json<MenuItem>(
        t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name: "Masala dosa", category: "Mains", price: 10 * U, prepMinutes: 12 } }),
        201
    )
    const coffee = await json<MenuItem>(
        t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name: "Filter coffee", category: "Drinks", price: 2_500_000, prepMinutes: 5 } }),
        201
    )
    await json(t.call("POST", `/api/restaurants/${r.id}/chefs`, { cookie: t.cookies.OWNER, body: { name: "Lakshmi", title: "Head chef" } }), 201)
    const manage = await json<{ tables: Table[] }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))
    return { r, dosa, coffee, tables: manage.tables }
}

async function placeOrder(t: Ctx, body: Record<string, unknown>, cookie?: string) {
    return json<{ order: Order; token: string }>(t.call("POST", "/api/orders", { cookie, body }), 201)
}

type PaidBy = { kind: "public"; wallet: Wallet } | { kind: "private" }

/** A verified payment row, as routes/pay.ts records it (a private one records the pool). */
async function recordPayment(t: Ctx, shareId: string, amount: number, by: PaidBy) {
    await t.deps.db.query(
        `INSERT INTO payments (target_kind, target_id, chain_id, tx_hash, log_index, kind, payer, recipient, amount, block_number, verified_at)
         VALUES ('order', $1, 10143, $2, 0, $3, $4, $5, $6, 1, $7)`,
        [shareId, txHash(), by.kind, by.kind === "public" ? by.wallet : "0x00000000000000000000000000000000000000a3", PAYOUT, amount, t.clock.t]
    )
}

/** Stands in for routes/pay.ts settling every share on-chain; `by` also records the payment rows. */
async function markPaid(t: Ctx, orderId: string, by?: PaidBy) {
    if (by) {
        const shares = await t.deps.db.query<{ id: string; amount: number }>("SELECT id, amount + tip AS amount FROM order_shares WHERE order_id = $1", [orderId])
        for (const s of shares) await recordPayment(t, s.id, Number(s.amount), by)
    }
    await t.deps.db.tx(async (q) => {
        await q.query("UPDATE order_shares SET paid = amount + tip, status = 'paid', paid_at = $2 WHERE order_id = $1", [orderId, t.clock.t])
        await onOrderPaid(q, orderId, t.clock.t)
    })
}

/** The invoice token from an order's invoiceUrl. */
const invoiceTokenOf = (o: Order) => o.invoiceUrl.split("/i/")[1]!

let t: Ctx
beforeEach(async () => {
    t = await setup()
})

describe("register a restaurant", () => {
    it("needs a signed-in wallet", async () => {
        expect(await status(t.call("POST", "/api/restaurants", { body: { name: "X", state: "Karnataka" } }))).toBe(401)
    })

    it("makes the caller owner, derives slug and prefix, creates tables", async () => {
        const r = await json<Restaurant>(
            t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Café Mysore!", state: "Karnataka", tables: 6, seats: 2 } }),
            201
        )
        expect(r.slug).toBe("cafe-mysore")
        expect(r.payoutWallet).toBe(OWNER)
        expect(r.tables).toEqual({ total: 6, available: 6 })
        expect(r.privatePayments).toBe(false)
        expect(r.gstRateBps).toBe(500)
        const row = await t.deps.db.one<{ owner_wallet: string; invoice_prefix: string }>("SELECT owner_wallet, invoice_prefix FROM restaurants WHERE id = $1", [r.id])
        expect(row).toEqual({ owner_wallet: OWNER, invoice_prefix: "CM" })

        // Same name again: unique slug and invoice prefix.
        const r2 = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.GUEST, body: { name: "Cafe Mysore", state: "Goa" } }), 201)
        expect(r2.slug).toBe("cafe-mysore-2")
        const p2 = await t.deps.db.one<{ invoice_prefix: string }>("SELECT invoice_prefix FROM restaurants WHERE id = $1", [r2.id])
        expect(p2!.invoice_prefix).toBe("CM2")

        const list = await json<Restaurant[]>(t.call("GET", "/api/restaurants"))
        expect(list.map((x) => x.id).sort()).toEqual([r.id, r2.id].sort())
        const me = await json<{ restaurants: { id: string; role: string }[] }>(t.call("GET", "/api/me", { cookie: t.cookies.OWNER }))
        expect(me.restaurants).toEqual([expect.objectContaining({ id: r.id, role: "owner" })])
    })

    it("validates GSTIN, state, FSSAI and rates", async () => {
        const post = (body: Record<string, unknown>) => status(t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Test", state: "Karnataka", ...body } }))
        expect(await post({ gstin: "29AAACF1234A1Z5" })).toBe(400) // bad check digit
        expect(await post({ gstin: DEMO_GSTIN, state: "Maharashtra" })).toBe(400) // other state's GSTIN
        expect(await post({ state: "Atlantis" })).toBe(400)
        expect(await post({ fssai: "1234" })).toBe(400)
        expect(await post({ gstRateBps: 700 })).toBe(400)
        expect(await post({ serviceChargeBps: 5000 })).toBe(400)
        expect(await post({ coverImage: "https://evil.example/x.png" })).toBe(400)
        expect(await post({ name: "x".repeat(81) })).toBe(400)
        expect(await post({ tables: 101 })).toBe(400)
        const ok = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Test", state: "Karnataka", gstin: DEMO_GSTIN.toLowerCase(), fssai: "12345678901234" } }), 201)
        expect(ok.gstin).toBe(DEMO_GSTIN)
    })

    it("reports private payments when the payout wallet is allowlisted", async () => {
        const payout = await t.signIn(PAYOUT)
        const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: payout, body: { name: "Pool Side", state: "Goa", payoutWallet: PAYOUT } }), 201)
        expect(r.privatePayments).toBe(true)
    })

    it("only pays out to the wallet the owner is signed in with", async () => {
        // OWNER can't borrow PAYOUT's verified wallet (and its "Private payments" badge).
        const borrowed = await t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Copycat", state: "Goa", payoutWallet: PAYOUT } })
        expect(borrowed.status).toBe(400)
        expect(((await borrowed.json()) as { error: string }).error).toMatch(/wallet you're signed in with/)
        const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Copycat", state: "Goa", payoutWallet: OWNER } }), 201)
        expect(r).toMatchObject({ payoutWallet: OWNER, privatePayments: false })
        expect(await status(t.call("PUT", `/api/restaurants/${r.id}`, { cookie: t.cookies.OWNER, body: { payoutWallet: PAYOUT } }))).toBe(400)
        // Sending the current value back (a settings form) is fine.
        expect(await status(t.call("PUT", `/api/restaurants/${r.id}`, { cookie: t.cookies.OWNER, body: { payoutWallet: OWNER, tagline: "Same" } }))).toBe(200)
        const after = await t.deps.db.one<{ payout_wallet: string }>("SELECT payout_wallet FROM restaurants WHERE id = $1", [r.id])
        expect(after!.payout_wallet).toBe(OWNER)
    })

    it("derives slugs and prefixes", () => {
        expect(slugify("  Saffron   Table  ")).toBe("saffron-table")
        expect(slugify("!!!")).toBe("restaurant")
        expect(invoicePrefixBase("Saffron Table")).toBe("ST")
        expect(invoicePrefixBase("Dosa")).toBe("DOS")
        expect(invoicePrefixBase("A")).toBe("AR")
        expect(invoicePrefixBase("The Big Fat Indian Kitchen")).toBe("TBFI")
    })
})

describe("roles and permissions", () => {
    it("enforces the owner / manager / chef / waiter matrix", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const id = r.id
        const as = (who: string, method: string, p: string, body?: unknown) => status(t.call(method, p, { cookie: t.cookies[who], body }))

        // manage view: any staff; staff list only for owner/manager
        for (const who of ["OWNER", "MANAGER", "CHEF", "WAITER"]) expect(await as(who, "GET", `/api/restaurants/${id}/manage`)).toBe(200)
        expect(await as("OUTSIDER", "GET", `/api/restaurants/${id}/manage`)).toBe(403)
        expect(await status(t.call("GET", `/api/restaurants/${id}/manage`))).toBe(401)
        const chefView = await json<{ staff: StaffMember[]; role: string }>(t.call("GET", `/api/restaurants/${id}/manage`, { cookie: t.cookies.CHEF }))
        expect(chefView).toMatchObject({ staff: [], role: "chef" })
        const ownerView = await json<{ staff: StaffMember[]; role: string }>(t.call("GET", `/api/restaurants/${id}/manage`, { cookie: t.cookies.OWNER }))
        expect(ownerView.staff.map((s) => s.role).sort()).toEqual(["chef", "manager", "waiter"])

        // settings: owner/manager; payout wallet: owner only
        expect(await as("MANAGER", "PUT", `/api/restaurants/${id}`, { tagline: "Crisp dosas" })).toBe(200)
        expect(await as("CHEF", "PUT", `/api/restaurants/${id}`, { tagline: "x" })).toBe(403)
        expect(await as("WAITER", "PUT", `/api/restaurants/${id}`, { tagline: "x" })).toBe(403)
        expect(await as("MANAGER", "PUT", `/api/restaurants/${id}`, { payoutWallet: MANAGER })).toBe(403)
        // ...and only to the owner's own signed-in wallet.
        expect(await as("OWNER", "PUT", `/api/restaurants/${id}`, { payoutWallet: PAYOUT })).toBe(400)
        const updated = await json<Restaurant>(t.call("PUT", `/api/restaurants/${id}`, { cookie: t.cookies.OWNER, body: { payoutWallet: OWNER } }))
        expect(updated).toMatchObject({ payoutWallet: OWNER, privatePayments: false, tagline: "Crisp dosas" })

        // menu, chefs, tables: owner/manager
        for (const who of ["CHEF", "WAITER", "OUTSIDER"]) {
            expect(await as(who, "POST", `/api/restaurants/${id}/menu`, { name: "Idli", category: "Mains", price: U })).toBe(403)
            expect(await as(who, "PUT", `/api/restaurants/${id}/menu/${dosa.id}`, { price: U })).toBe(403)
            expect(await as(who, "POST", `/api/restaurants/${id}/chefs`, { name: "Ravi" })).toBe(403)
            expect(await as(who, "POST", `/api/restaurants/${id}/tables`, { label: "9", seats: 2 })).toBe(403)
        }
        expect(await as("MANAGER", "POST", `/api/restaurants/${id}/menu`, { name: "Idli", category: "Mains", price: U })).toBe(201)
        expect(await as("MANAGER", "POST", `/api/restaurants/${id}/tables`, { label: "9", seats: 2 })).toBe(201)

        // table status: waiter, manager, owner, not chef
        expect(await as("WAITER", "PUT", `/api/restaurants/${id}/tables/${tables[0].id}/status`, { status: "reserved" })).toBe(200)
        expect(await as("CHEF", "PUT", `/api/restaurants/${id}/tables/${tables[0].id}/status`, { status: "available" })).toBe(403)
        expect(await as("MANAGER", "PUT", `/api/restaurants/${id}/tables/${tables[0].id}/status`, { status: "available" })).toBe(200)

        // staff: managers handle chefs and waiters only
        expect(await as("MANAGER", "POST", `/api/restaurants/${id}/staff`, { wallet: FRIEND, role: "waiter", displayName: "New" })).toBe(201)
        expect(await as("MANAGER", "POST", `/api/restaurants/${id}/staff`, { wallet: GUEST, role: "manager", displayName: "Boss" })).toBe(403)
        expect(await as("MANAGER", "DELETE", `/api/restaurants/${id}/staff/${MANAGER}`)).toBe(403)
        expect(await as("MANAGER", "DELETE", `/api/restaurants/${id}/staff/${FRIEND}`)).toBe(200)
        expect(await as("CHEF", "POST", `/api/restaurants/${id}/staff`, { wallet: GUEST, role: "waiter", displayName: "x" })).toBe(403)
        expect(await as("WAITER", "GET", `/api/restaurants/${id}/staff`)).toBe(403)
        expect(await as("OWNER", "POST", `/api/restaurants/${id}/staff`, { wallet: OWNER, role: "chef" })).toBe(400)
        expect(await as("OWNER", "DELETE", `/api/restaurants/${id}/staff/${MANAGER}`)).toBe(200)
        expect(await as("MANAGER", "GET", `/api/restaurants/${id}/manage`)).toBe(403)

        // staff_added lands in the new staff member's activity
        const act = await t.deps.db.query<{ kind: string }>("SELECT kind FROM activity WHERE wallet = $1", [CHEF])
        expect(act.map((a) => a.kind)).toContain("staff_added")
    })

    it("needs the x-fairpay header on writes", async () => {
        const res = await t.app.request("/api/restaurants", {
            method: "POST",
            headers: { cookie: t.cookies.OWNER, "content-type": "application/json" },
            body: JSON.stringify({ name: "X", state: "Goa" })
        })
        expect(res.status).toBe(403)
    })
})

describe("menu", () => {
    it("validates and updates dishes", async () => {
        const { r, dosa } = await restaurantWithStaff(t)
        const post = (body: Record<string, unknown>) => status(t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body }))
        expect(await post({ name: "Bad", category: "Mains", price: 1_234_567 })).toBe(400) // not whole cents
        expect(await post({ name: "Bad", category: "Mains", price: -10_000 })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: 1.5 })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: "10" })).toBe(400)
        expect(await post({ name: "", category: "Mains", price: U })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: U, spice: 4 })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: U, prepMinutes: 0 })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: U, image: "javascript:alert(1)" })).toBe(400)
        expect(await post({ name: "Bad", category: "Mains", price: U, image: "/api/images/img_aaaaaaaaaaaaaaaa" })).toBe(400) // not this restaurant's
        expect(await post({ name: "Bad", category: "Mains", price: U, sac: "12" })).toBe(400)

        const upd = await json<MenuItem>(
            t.call("PUT", `/api/restaurants/${r.id}/menu/${dosa.id}`, { cookie: t.cookies.MANAGER, body: { price: 12 * U, available: false, veg: true, spice: 2, image: "/menu/biryani.svg" } })
        )
        expect(upd).toMatchObject({ price: 12 * U, available: false, spice: 2, image: "/menu/biryani.svg", name: "Masala dosa" })

        // Another restaurant can't touch it.
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Other", state: "Goa" } }), 201)
        expect(await status(t.call("PUT", `/api/restaurants/${other.id}/menu/${dosa.id}`, { cookie: t.cookies.OUTSIDER, body: { price: U } }))).toBe(404)
        expect(await status(t.call("DELETE", `/api/restaurants/${other.id}/menu/${dosa.id}`, { cookie: t.cookies.OUTSIDER }))).toBe(404)

        expect(await status(t.call("DELETE", `/api/restaurants/${r.id}/menu/${dosa.id}`, { cookie: t.cookies.OWNER }))).toBe(200)
        const sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.menu.map((m) => m.name)).toEqual(["Filter coffee"])
    })
})

describe("images", () => {
    it("accepts a PNG and serves it with locked-down headers", async () => {
        const { r } = await restaurantWithStaff(t)
        const res = await t.app.request(`/api/restaurants/${r.id}/images`, {
            method: "POST",
            headers: { cookie: t.cookies.MANAGER, "x-fairpay": "1", "content-type": "image/jpeg" },
            body: PNG
        })
        expect(res.status).toBe(201)
        const { url } = (await res.json()) as { url: string }
        expect(url).toMatch(/^\/api\/images\/img_[a-z2-7]{16}$/)
        const img = await t.app.request(url)
        expect(img.status).toBe(200)
        expect(img.headers.get("content-type")).toBe("image/png")
        expect(img.headers.get("x-content-type-options")).toBe("nosniff")
        expect(img.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
        expect(img.headers.get("content-security-policy")).toBe("default-src 'none'")
        expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG)

        // The upload can now be used by this restaurant's menu.
        await json(t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name: "Vada", category: "Small plates", price: U, image: url } }), 201)
    })

    it("limits uploads per wallet and per address, and storage per restaurant", async () => {
        const { r } = await restaurantWithStaff(t)
        let n = 0
        // A distinct small PNG each time, so nothing is deduplicated.
        const png = () => {
            n += 1
            const b = new Uint8Array(PNG.length + 4)
            b.set(PNG)
            new DataView(b.buffer).setUint32(PNG.length, n)
            return b
        }
        const upload = (restaurantId: string, cookie: string, ip?: string) =>
            t.app.request(`/api/restaurants/${restaurantId}/images`, {
                method: "POST",
                headers: { cookie, "x-fairpay": "1", "content-type": "image/png", ...(ip ? { "x-test-ip": ip } : {}) },
                body: png()
            })

        for (let i = 0; i < 30; i++) expect((await upload(r.id, t.cookies.OWNER)).status).toBe(201)
        const wallet = await upload(r.id, t.cookies.OWNER)
        expect(wallet.status).toBe(429)
        expect(((await wallet.json()) as { error: string }).error).toMatch(/lot of images/)
        // The manager has an allowance of their own, but this address is now at 60 an hour.
        for (let i = 0; i < 30; i++) expect((await upload(r.id, t.cookies.MANAGER)).status).toBe(201)
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Elsewhere", state: "Goa" } }), 201)
        expect((await upload(other.id, t.cookies.OUTSIDER)).status).toBe(429)
        expect((await upload(other.id, t.cookies.OUTSIDER, "10.9.9.9")).status).toBe(201)
        // An hour later both allowances are back.
        t.clock.t += 61 * 60_000
        expect((await upload(r.id, t.cookies.OWNER)).status).toBe(201)

        // Storage: a restaurant at 25 MB can't add more.
        for (let i = 0; i < 25; i++) {
            await t.deps.db.query(
                "INSERT INTO images (id, restaurant_id, mime, bytes, size, sha256, uploaded_by, created_at) VALUES ($1, $2, 'image/png', $3, 1048576, $4, $5, 1)",
                [`img_fill${i}`, other.id, PNG, `fill${i}`, OUTSIDER]
            )
        }
        const full = await upload(other.id, t.cookies.OUTSIDER, "10.9.9.9")
        expect(full.status).toBe(413)
        expect(((await full.json()) as { error: string }).error).toMatch(/25 MB/)
    })

    it("rejects SVG labelled as PNG, oversize bodies and non-managers", async () => {
        const { r } = await restaurantWithStaff(t)
        const upload = (body: Uint8Array<ArrayBuffer> | string, cookie = t.cookies.OWNER, type = "image/png") =>
            t.app.request(`/api/restaurants/${r.id}/images`, { method: "POST", headers: { cookie, "x-fairpay": "1", "content-type": type }, body })
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        expect((await upload(svg)).status).toBe(415)
        expect((await upload(new Uint8Array(0))).status).toBe(400)
        const big = new Uint8Array(1024 * 1024 + 1)
        big.set(PNG)
        expect((await upload(big)).status).toBe(413)
        expect((await upload(PNG, t.cookies.CHEF)).status).toBe(403)
        expect((await upload(PNG, t.cookies.WAITER)).status).toBe(403)
        expect(await status(t.call("GET", "/api/images/img_aaaaaaaaaaaaaaaa"))).toBe(404)
        expect(await status(t.call("GET", "/api/images/../etc"))).toBe(404)
    })

    it("sniffs magic bytes", () => {
        expect(sniffImage(PNG)).toBe("image/png")
        expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
        expect(sniffImage(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp")
        expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull()
        expect(sniffImage(new TextEncoder().encode("<svg"))).toBeNull()
    })
})

describe("orders", () => {
    it("prices from the database and occupies the table", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(t, {
            tableId: tables[0].id,
            guests: 2,
            paymentMode: "one_pays",
            items: [
                { id: dosa.id, qty: 2, guest: 1, price: 1 },
                { id: coffee.id, qty: 1, guest: 2 }
            ],
            total: 1
        })
        const expected = computeBill({ lines: [{ unitPrice: 10 * U, qty: 2 }, { unitPrice: 2_500_000, qty: 1 }], gstRateBps: 500, serviceChargeBps: 0, intraState: true })
        expect(order).toMatchObject({
            status: "awaiting_payment",
            subtotal: expected.subtotal,
            cgst: expected.cgst,
            sgst: expected.sgst,
            total: expected.total,
            gstRateBps: 500,
            table: { id: tables[0].id, label: "1" },
            invoiceNo: null,
            waitMinutes: null,
            invoiceUrl: expect.stringMatching(/^http:\/\/localhost:5174\/i\/[A-Za-z0-9_-]{43}$/)
        })
        // The invoice link has its own token; the share token (pay and split) isn't in it.
        expect(order.invoiceUrl).not.toContain(token)
        expect(order.total).toBe(23_620_000)
        expect(order.shares).toEqual([expect.objectContaining({ guest: 1, label: "Whole table", amount: order.total, status: "owed", paidPrivately: false })])
        // Secrets never leave the server.
        expect(JSON.stringify(order)).not.toMatch(/secret|order_ref|orderRef/)

        const sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.tables.find((x) => x.id === tables[0].id)).toMatchObject({ status: "occupied", orderId: null })
        expect(sf.restaurant.tables).toEqual({ total: 4, available: 3 })
        const staffView = await json<{ tables: Table[] }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.WAITER }))
        expect(staffView.tables.find((x) => x.id === tables[0].id)!.orderId).toBe(order.id)

        // The same table can't be taken twice.
        expect(await status(t.call("POST", "/api/orders", { body: { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: coffee.id, qty: 1, guest: 1 }] } }))).toBe(409)
    })

    it("splits by items, or equally", async () => {
        const { dosa, coffee, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, {
            tableId: tables[1].id,
            guests: 3,
            paymentMode: "split",
            items: [
                { id: dosa.id, qty: 1, guest: 1 },
                { id: coffee.id, qty: 2, guest: 2 }
            ],
            guestNames: ["Asha", "Ben"]
        })
        // Guest 3 ordered nothing, so has no share.
        expect(order.shares.map((s) => [s.guest, s.label, s.amount])).toEqual([
            // 15.00 + 0.76 GST: guest 1 takes 10/15 of the tax (0.51), guest 2 the rest
            [1, "Asha", 10_510_000],
            [2, "Ben", 5_250_000]
        ])
        expect(order.shares.reduce((a, s) => a + s.amount, 0)).toBe(order.total)

        const eq = await placeOrder(t, { tableId: tables[2].id, guests: 3, paymentMode: "split", splitBy: "equal", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        expect(eq.order.shares.map((s) => s.amount)).toEqual([3_500_000, 3_500_000, 3_500_000])
    })

    it("caps unpaid orders per guest, so one address can't hold every table", async () => {
        const { dosa, tables } = await restaurantWithStaff(t, { tables: 8 })
        const items = [{ id: dosa.id, qty: 1, guest: 1 }]
        const order = (table: Table, o: { ip?: string; cookie?: string } = {}) =>
            t.call("POST", "/api/orders", {
                cookie: o.cookie,
                headers: o.ip ? { "x-test-ip": o.ip } : {},
                body: { tableId: table.id, guests: 1, paymentMode: "one_pays", items }
            })
        const free = async () => (await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurant_tables WHERE status = 'available'"))!.n

        const first = await json<{ order: Order }>(order(tables[0]), 201)
        await json(order(tables[1]), 201)
        const third = await order(tables[2])
        expect(third.status).toBe(429)
        expect(((await third.json()) as { error: string }).error).toMatch(/2 unpaid orders here/)
        expect(await free()).toBe(6)
        // Another address is a different guest.
        await json(order(tables[2], { ip: "10.0.0.9" }), 201)
        // Paying for an order frees its slot (not its table, which it still uses).
        await markPaid(t, first.order.id)
        await json(order(tables[3]), 201)
        expect(await status(order(tables[4]))).toBe(429)

        // Signed in, the wallet is counted, from the orders it placed (another address here, so
        // the placement rate limit stays out of the way).
        await json(order(tables[4], { cookie: t.cookies.GUEST, ip: "10.0.0.20" }), 201)
        await json(order(tables[5], { cookie: t.cookies.GUEST, ip: "10.0.0.20" }), 201)
        const mine = await order(tables[6], { cookie: t.cookies.GUEST, ip: "10.0.0.20" })
        expect(mine.status).toBe(429)
        expect(((await mine.json()) as { error: string }).error).toMatch(/You already have 2 unpaid orders/)

        // Unpaid orders expire after 15 minutes, which frees both the tables and the slots.
        t.clock.t += 16 * 60_000
        await json(order(tables[6]), 201)
        await json(order(tables[7], { cookie: t.cookies.GUEST, ip: "10.0.0.20" }), 201)

        // Staff taking orders for several tables aren't capped.
        await t.deps.db.query("UPDATE restaurant_tables SET status = 'available', order_id = NULL")
        for (const table of tables.slice(0, 3)) await json(order(table, { cookie: t.cookies.WAITER, ip: "10.0.0.30" }), 201)
    })

    it("charges dine-in orders CGST + SGST, never IGST: the supply happens in the restaurant's state", async () => {
        expect(DINE_IN_INTRA_STATE).toBe(true)
        const { dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        expect(order).toMatchObject({ cgst: 250_000, sgst: 250_000, igst: 0, total: 10_500_000 })
    })

    it("records the payout wallet each order is paid to when it is placed", async () => {
        const { dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        const row = await t.deps.db.one<{ payout_wallet: string | null }>("SELECT payout_wallet FROM orders WHERE id = $1", [order.id])
        expect(row!.payout_wallet).toBe(OWNER)
    })

    it("never charges guests more than the order total when splitting by items", async () => {
        const { r, tables } = await restaurantWithStaff(t)
        const add = (name: string, price: number) =>
            json<MenuItem>(t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name, category: "Small", price } }), 201)
        const bite = await add("Bite", 100_000)
        const mint = await add("Mint", 10_000)
        const items = Array.from({ length: 19 }, (_, i) => ({ id: bite.id, qty: 1, guest: i + 1 }))
        items.push({ id: mint.id, qty: 1, guest: 20 })
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 20, paymentMode: "split", splitBy: "items", items })
        expect(order.total).toBe(2_010_000)
        expect(order.shares).toHaveLength(20)
        expect(order.shares.reduce((a, s) => a + s.amount, 0)).toBe(order.total)
        for (const s of order.shares) expect(s.amount).toBeGreaterThan(0)
    })

    it("validates order input", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t)
        const post = (body: Record<string, unknown>) => status(t.call("POST", "/api/orders", { body: { tableId: tables[0].id, guests: 2, paymentMode: "one_pays", ...body } }))
        const items = [{ id: dosa.id, qty: 1, guest: 1 }]
        expect(await post({ guests: 0, items })).toBe(400)
        expect(await post({ guests: 21, items })).toBe(400)
        expect(await post({ items: [] })).toBe(400)
        expect(await post({ items: [{ id: dosa.id, qty: 51, guest: 1 }] })).toBe(400)
        expect(await post({ items: [{ id: dosa.id, qty: 0, guest: 1 }] })).toBe(400)
        expect(await post({ items: [{ id: dosa.id, qty: 1, guest: 3 }] })).toBe(400)
        expect(await post({ items: Array.from({ length: 61 }, () => ({ id: coffee.id, qty: 1, guest: 1 })) })).toBe(400)
        expect(await post({ items, paymentMode: "dine_and_dash" })).toBe(400)
        expect(await post({ items, tableId: "t_nope" })).toBe(404)
        expect(await post({ items: [{ id: "m_nope", qty: 1, guest: 1 }] })).toBe(400)

        // A dish from another restaurant
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Other", state: "Goa" } }), 201)
        const foreign = await json<MenuItem>(t.call("POST", `/api/restaurants/${other.id}/menu`, { cookie: t.cookies.OUTSIDER, body: { name: "Fish", category: "Mains", price: U } }), 201)
        expect(await post({ items: [{ id: foreign.id, qty: 1, guest: 1 }] })).toBe(400)

        // An unavailable dish
        await json(t.call("PUT", `/api/restaurants/${r.id}/menu/${dosa.id}`, { cookie: t.cookies.OWNER, body: { available: false } }))
        expect(await post({ items })).toBe(409)

        // A closed table
        await json(t.call("PUT", `/api/restaurants/${r.id}/tables/${tables[0].id}/status`, { cookie: t.cookies.WAITER, body: { status: "closed" } }))
        expect(await post({ items: [{ id: coffee.id, qty: 1, guest: 1 }] })).toBe(409)
        // Nothing was half-created.
        const n = await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM orders")
        expect(n!.n).toBe(0)
    })

    it("charges no GST without a GSTIN (bill of supply)", async () => {
        const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OWNER, body: { name: "Chaat Cart", state: "Delhi", tables: 1, serviceChargeBps: 1000 } }), 201)
        const m = await json<MenuItem>(t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name: "Pani puri", category: "Chaat", price: 3 * U } }), 201)
        const { tables } = await json<{ tables: Table[] }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: m.id, qty: 2, guest: 1 }] })
        expect(order).toMatchObject({ subtotal: 6 * U, serviceCharge: 600_000, cgst: 0, sgst: 0, igst: 0, total: 6_600_000, gstRateBps: 0 })
        const inv = await json<Invoice>(t.call("GET", `/api/i/${invoiceTokenOf(order)}`))
        expect(inv.kind).toBe("bill_of_supply")
        expect(inv.supplier.stateCode).toBe("07")
    })

    it("shows an order only to its link holder, its placer, or staff", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        expect(await status(t.call("GET", `/api/orders/${order.id}`))).toBe(404)
        expect(await status(t.call("GET", `/api/orders/${order.id}?t=${"x".repeat(43)}`))).toBe(404)
        expect(await status(t.call("GET", `/api/orders/${order.id}`, { cookie: t.cookies.OUTSIDER }))).toBe(404)
        expect(await status(t.call("GET", `/api/orders/${order.id}?t=${token}`))).toBe(200)
        expect(await status(t.call("GET", `/api/orders/${order.id}`, { cookie: t.cookies.GUEST }))).toBe(200)
        expect(await status(t.call("GET", `/api/orders/${order.id}`, { cookie: t.cookies.CHEF }))).toBe(200)
        const list = await json<Order[]>(t.call("GET", `/api/restaurants/${r.id}/orders?status=awaiting_payment`, { cookie: t.cookies.CHEF }))
        expect(list.map((o) => o.id)).toEqual([order.id])
        // Staff never get the guests' share token (it can pay and split), anywhere in the answer.
        expect(JSON.stringify(list)).not.toContain(token)
        const one = await t.call("GET", `/api/orders/${order.id}`, { cookie: t.cookies.CHEF })
        expect(await one.text()).not.toContain(token)
        const manage = await t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER })
        expect(await manage.text()).not.toContain(token)
        expect(await json<Order[]>(t.call("GET", `/api/restaurants/${r.id}/orders?status=paid,cooking`, { cookie: t.cookies.CHEF }))).toEqual([])
        expect(await status(t.call("GET", `/api/restaurants/${r.id}/orders?status=bogus`, { cookie: t.cookies.CHEF }))).toBe(400)
        expect(await status(t.call("GET", `/api/restaurants/${r.id}/orders`, { cookie: t.cookies.OUTSIDER }))).toBe(403)
    })
})

describe("kitchen and tables", () => {
    it("moves an order along by role and frees the table when served", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(t, { tableId: tables[0].id, guests: 2, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }, { id: coffee.id, qty: 1, guest: 2 }] }, t.cookies.GUEST)
        const move = (who: string, s: string) => status(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies[who], body: { status: s } }))

        // Not paid yet: the kitchen can't start.
        expect(await move("CHEF", "cooking")).toBe(409)
        await markPaid(t, order.id)
        const paid = await json<Order>(t.call("GET", `/api/orders/${order.id}?t=${token}`))
        // Paid and verified: cooking at once, with the on-duty chef; 12 min prep is kept to 10.
        expect(paid).toMatchObject({ status: "cooking", paidAt: T0, cookingStartedAt: T0, chef: expect.objectContaining({ name: "Lakshmi" }) })
        expect(paid.estReadyAt).toBe(T0 + 10 * 60_000)
        expect(paid.waitMinutes).toBe(10)
        expect(paid.invoiceNo).toBe(`SR/${financialYear(T0)}/000001`)

        // Table can't be freed while the order is unserved.
        expect(await status(t.call("PUT", `/api/restaurants/${r.id}/tables/${tables[0].id}/status`, { cookie: t.cookies.WAITER, body: { status: "available" } }))).toBe(409)

        expect(await move("WAITER", "ready")).toBe(403)
        expect(await move("CHEF", "served")).toBe(403)
        expect(await move("OUTSIDER", "ready")).toBe(403)
        // Already cooking: starting it again is refused.
        expect(await move("CHEF", "cooking")).toBe(409)
        expect(await move("MANAGER", "cancelled")).toBe(409)
        // Staff can finish early: ready after 3 minutes.
        t.clock.t += 3 * 60_000
        expect(await move("CHEF", "ready")).toBe(200)
        expect(await move("CHEF", "served")).toBe(403)
        const served = await json<Order>(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.WAITER, body: { status: "served" } }))
        expect(served).toMatchObject({ status: "served", waitMinutes: 0 })
        const sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.tables.find((x) => x.id === tables[0].id)!.status).toBe("available")

        // The guest heard about each manual step.
        const act = await t.deps.db.query<{ title: string }>("SELECT title FROM activity WHERE wallet = $1 AND kind = 'order_update' ORDER BY id", [GUEST])
        expect(act.map((a) => a.title)).toEqual(["Your order is ready", "Your order has been served"])
        expect(await move("OWNER", "nonsense")).toBe(400)
    })

    it("lets owner and manager cancel an unpaid order, which frees the table", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        expect(await status(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.CHEF, body: { status: "cancelled" } }))).toBe(403)
        expect(await status(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.WAITER, body: { status: "cancelled" } }))).toBe(403)
        const c = await json<Order>(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.MANAGER, body: { status: "cancelled" } }))
        expect(c.status).toBe("cancelled")
        const m = await json<{ restaurant: Restaurant }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))
        expect(m.restaurant.tables.available).toBe(4)
    })

    it("lets owner and manager cancel a part-paid order, freeing the table and listing what to refund", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(
            t,
            { tableId: tables[0].id, guests: 3, paymentMode: "split", splitBy: "equal", items: [{ id: dosa.id, qty: 3, guest: 1 }] },
            t.cookies.GUEST
        )
        // Guest 1 paid publicly, guest 2 paid one confidential note; guest 3 walked out.
        const [s1, s2] = order.shares
        await recordPayment(t, s1.id, s1.amount, { kind: "public", wallet: FRIEND })
        await recordPayment(t, s2.id, 5 * U, { kind: "private" })
        await t.deps.db.query("UPDATE order_shares SET paid = amount, status = 'paid' WHERE id = $1", [s1.id])
        await t.deps.db.query("UPDATE order_shares SET paid = $2 WHERE id = $1", [s2.id, 5 * U])
        const cancel = (who: string) => t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies[who], body: { status: "cancelled" } })
        expect(await status(cancel("CHEF"))).toBe(403)
        expect(await status(cancel("WAITER"))).toBe(403)

        const c = await json<Order>(cancel("MANAGER"))
        expect(c.status).toBe("cancelled")
        const m = await json<{ restaurant: Restaurant; tables: Table[] }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))
        expect(m.restaurant.tables.available).toBe(4)
        expect(m.tables.find((x) => x.id === tables[0].id)).toMatchObject({ status: "available", orderId: null })

        const received = s1.amount + 5 * U
        const [note] = await t.deps.db.query<{ title: string; detail: string; link: string }>(
            "SELECT title, detail, link FROM activity WHERE wallet = $1 AND title LIKE 'Refund%'",
            [OWNER]
        )
        expect(note.title).toBe(`Refund ${(received / U).toFixed(2)} USDC for a cancelled order`)
        expect(note.link).toBe(`/business/faireats/manage/${r.id}`)
        expect(note.detail).toContain(`Guest 1: ${(s1.amount / U).toFixed(2)} USDC from ${FRIEND}`)
        expect(note.detail).toContain("5.00 USDC paid confidentially")
        // The confidential payment names neither a wallet nor the seat.
        expect(note.detail).not.toContain("Guest 2")
        const guest = await t.deps.db.one<{ detail: string }>("SELECT detail FROM activity WHERE wallet = $1 AND title = 'Your order was cancelled'", [GUEST])
        expect(guest!.detail).toContain("will refund")
        // Already cancelled: not again.
        expect(await status(cancel("OWNER"))).toBe(409)
    })

    it("expires unpaid orders after 15 minutes and gives their tables back", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const item = [{ id: dosa.id, qty: 1, guest: 1 }]
        const stale = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: item })
        const partPaid = await placeOrder(t, { tableId: tables[1].id, guests: 2, paymentMode: "split", splitBy: "equal", items: item })
        await t.deps.db.query("UPDATE order_shares SET paid = 10000 WHERE id = $1", [partPaid.order.shares[0].id])
        t.clock.t += 10 * 60_000
        // Another guest (this address already holds two unpaid orders here).
        const fresh = await json<{ order: Order }>(
            t.call("POST", "/api/orders", { headers: { "x-test-ip": "10.0.0.2" }, body: { tableId: tables[2].id, guests: 1, paymentMode: "one_pays", items: item } }),
            201
        )

        // 14 minutes: nothing expires yet.
        t.clock.t += 4 * 60_000
        let sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.restaurant.tables.available).toBe(1)

        // 16 minutes: the unpaid order goes; the part-paid one (money to refund) and the newer one stay.
        t.clock.t += 2 * 60_000
        sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.tables.find((x) => x.id === tables[0].id)!.status).toBe("available")
        expect(sf.tables.find((x) => x.id === tables[1].id)!.status).toBe("occupied")
        expect(sf.tables.find((x) => x.id === tables[2].id)!.status).toBe("occupied")
        const statusOf = async (id: string) => (await t.deps.db.one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id]))!.status
        expect(await statusOf(stale.order.id)).toBe("cancelled")
        expect(await statusOf(partPaid.order.id)).toBe("awaiting_payment")
        expect(await statusOf(fresh.order.id)).toBe("awaiting_payment")

        // Each entry point sweeps: the staff board and placing an order on an expired table.
        t.clock.t += 20 * 60_000
        const board = await json<Order[]>(t.call("GET", `/api/restaurants/${r.id}/orders?status=awaiting_payment`, { cookie: t.cookies.CHEF }))
        expect(board.map((o) => o.id)).toEqual([partPaid.order.id])
        await t.deps.db.query("UPDATE orders SET status = 'awaiting_payment' WHERE id = $1", [fresh.order.id])
        await t.deps.db.query("UPDATE restaurant_tables SET status = 'occupied', order_id = $2 WHERE id = $1", [tables[2].id, fresh.order.id])
        const again = await placeOrder(t, { tableId: tables[2].id, guests: 1, paymentMode: "one_pays", items: item })
        expect(await statusOf(fresh.order.id)).toBe("cancelled")
        expect(again.order.table!.id).toBe(tables[2].id)
        // The manage view sweeps too (idempotent: nothing left to do).
        expect((await json<{ restaurant: Restaurant }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))).restaurant.tables.available).toBe(2)
    })

    it("manages tables: labels unique, no deleting a busy table", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        expect(await status(t.call("POST", `/api/restaurants/${r.id}/tables`, { cookie: t.cookies.OWNER, body: { label: "1", seats: 2 } }))).toBe(409)
        expect(await status(t.call("POST", `/api/restaurants/${r.id}/tables`, { cookie: t.cookies.OWNER, body: { label: "Patio", seats: 31 } }))).toBe(400)
        const upd = await json<Table>(t.call("PUT", `/api/restaurants/${r.id}/tables/${tables[1].id}`, { cookie: t.cookies.MANAGER, body: { seats: 6 } }))
        expect(upd.seats).toBe(6)
        await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        expect(await status(t.call("DELETE", `/api/restaurants/${r.id}/tables/${tables[0].id}`, { cookie: t.cookies.OWNER }))).toBe(409)
        expect(await status(t.call("PUT", `/api/restaurants/${r.id}/tables/${tables[0].id}/status`, { cookie: t.cookies.OWNER, body: { status: "closed" } }))).toBe(409)
        expect(await status(t.call("PUT", `/api/restaurants/${r.id}/tables/${tables[0].id}/status`, { cookie: t.cookies.OWNER, body: { status: "dirty" } }))).toBe(400)
        expect(await status(t.call("DELETE", `/api/restaurants/${r.id}/tables/${tables[3].id}`, { cookie: t.cookies.OWNER }))).toBe(200)
    })

    it("estimates readiness from prep time kept within 5 to 10 minutes, with no queue", async () => {
        const { dosa, coffee, tables } = await restaurantWithStaff(t)
        const a = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        const b = await placeOrder(t, { tableId: tables[1].id, guests: 1, paymentMode: "one_pays", items: [{ id: coffee.id, qty: 1, guest: 1 }] })
        await markPaid(t, a.order.id)
        // b: 5 min prep; order a in the kitchen adds nothing.
        expect(await estimateReadyAt(t.deps.db, b.order.id, T0)).toBe(T0 + 5 * 60_000)
        // a: 12 min prep is kept to 10.
        expect(await estimateReadyAt(t.deps.db, a.order.id, T0)).toBe(T0 + 10 * 60_000)
        await markPaid(t, b.order.id)
        const nos = await t.deps.db.query<{ invoice_no: string }>("SELECT invoice_no FROM orders ORDER BY invoice_no")
        expect(nos.map((n) => n.invoice_no)).toEqual([`SR/2026-27/000001`, `SR/2026-27/000002`])
        // Idempotent
        expect(await assignInvoiceNo(t.deps.db, a.order.id, T0)).toBe("SR/2026-27/000001")
        await t.deps.db.tx((q) => onOrderPaid(q, a.order.id, T0 + 60_000))
        const again = await t.deps.db.one<{ invoice_no: string; est_ready_at: number; paid_at: number }>("SELECT invoice_no, est_ready_at, paid_at FROM orders WHERE id = $1", [a.order.id])
        expect(again).toEqual({ invoice_no: "SR/2026-27/000001", est_ready_at: T0 + 10 * 60_000, paid_at: T0 })
    })

    it("tells unpaid orders the wait they'd get once paid, by the same rule", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t)
        const papad = await json<MenuItem>(
            t.call("POST", `/api/restaurants/${r.id}/menu`, { cookie: t.cookies.OWNER, body: { name: "Papad", category: "Small plates", price: U, prepMinutes: 2 } }),
            201
        )
        const a = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        const b = await placeOrder(t, { tableId: tables[1].id, guests: 2, paymentMode: "one_pays", items: [{ id: coffee.id, qty: 1, guest: 1 }, { id: dosa.id, qty: 1, guest: 2 }] })
        const c = await placeOrder(t, { tableId: tables[2].id, guests: 1, paymentMode: "one_pays", items: [{ id: papad.id, qty: 1, guest: 1 }] }, t.cookies.FRIEND)
        // The longest prep time, never more than 10 minutes and never less than 5.
        expect(a.order.expectedWaitMinutes).toBe(10)
        expect(b.order.expectedWaitMinutes).toBe(10)
        expect(c.order.expectedWaitMinutes).toBe(5)
        await markPaid(t, a.order.id)
        const unpaid = await json<Order>(t.call("GET", `/api/orders/${b.order.id}?t=${b.token}`))
        // Order a in the kitchen doesn't make b wait longer.
        expect(unpaid.expectedWaitMinutes).toBe(10)
        expect(unpaid.waitMinutes).toBeNull()
        // Paying turns the expectation into the real estimate, and the field goes away.
        await markPaid(t, b.order.id)
        const paid = await json<Order>(t.call("GET", `/api/orders/${b.order.id}?t=${b.token}`))
        expect(paid.expectedWaitMinutes).toBeUndefined()
        expect(paid.estReadyAt).toBe(T0 + 10 * 60_000)
        expect(paid.waitMinutes).toBe(10)
        expect(paid.demo).toBeUndefined()
    })
})

describe("the kitchen runs itself", () => {
    const board = (rid: string) => json<Order[]>(t.call("GET", `/api/restaurants/${rid}/orders`, { cookie: t.cookies.CHEF }))
    const row = (id: string) =>
        t.deps.db.one<{ status: string; paid_at: number; cooking_started_at: number; ready_at: number; served_at: number; est_ready_at: number }>(
            "SELECT status, paid_at, cooking_started_at, ready_at, served_at, est_ready_at FROM orders WHERE id = $1",
            [id]
        )

    it("cooks a paid order at once, makes it ready when its cook time is up, and serves it a minute later", async () => {
        const { r, coffee, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: coffee.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        await markPaid(t, order.id)
        // Paid -> cooking straight away (5 min coffee).
        expect(await row(order.id)).toMatchObject({ status: "cooking", cooking_started_at: T0, est_ready_at: T0 + 5 * 60_000 })

        t.clock.t = T0 + 5 * 60_000 - 1000
        let o = await json<Order>(t.call("GET", `/api/orders/${order.id}?t=${token}`))
        expect(o).toMatchObject({ status: "cooking", waitMinutes: 1 })

        t.clock.t = T0 + 5 * 60_000
        o = await json<Order>(t.call("GET", `/api/orders/${order.id}?t=${token}`))
        expect(o).toMatchObject({ status: "ready", readyAt: T0 + 5 * 60_000, waitMinutes: 0 })

        t.clock.t = T0 + 6 * 60_000 - 1000
        expect((await board(r.id)).find((x) => x.id === order.id)!.status).toBe("ready")
        t.clock.t = T0 + 6 * 60_000
        expect((await board(r.id)).find((x) => x.id === order.id)).toMatchObject({ status: "served", servedAt: T0 + 6 * 60_000 })
        // Served frees the table, and the guest heard ready and served at the times they happened.
        const sf = await json<StorefrontView>(t.call("GET", `/api/restaurants/${r.slug}`))
        expect(sf.tables.find((x) => x.id === tables[0].id)!.status).toBe("available")
        const act = await t.deps.db.query<{ title: string; created_at: number }>(
            "SELECT title, created_at FROM activity WHERE wallet = $1 AND kind = 'order_update' ORDER BY id",
            [GUEST]
        )
        expect(act.map((a) => [a.title, Number(a.created_at)])).toEqual([
            ["Your order is ready", T0 + 5 * 60_000],
            ["Your order has been served", T0 + 6 * 60_000]
        ])
        // Staff can't move it again.
        expect(await status(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.WAITER, body: { status: "served" } }))).toBe(409)
    })

    it("brings old stuck orders through to served on the next read, once, at the times they were due", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t)
        const a = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        const b = await placeOrder(t, { tableId: tables[1].id, guests: 1, paymentMode: "one_pays", items: [{ id: coffee.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        await markPaid(t, a.order.id)
        await markPaid(t, b.order.id)
        // As the old rules left them: a paid but never started (16 min estimate with the queue),
        // b started by hand a minute after paying with an estimate from paid time.
        await t.deps.db.query("UPDATE orders SET status = 'paid', cooking_started_at = NULL, chef_id = NULL, est_ready_at = $2 WHERE id = $1", [a.order.id, T0 + 16 * 60_000])
        await t.deps.db.query("UPDATE orders SET status = 'cooking', cooking_started_at = $2, est_ready_at = $3 WHERE id = $1", [b.order.id, T0 + 60_000, T0 + 9 * 60_000])

        t.clock.t = T0 + 1555 * 60_000
        expect((await board(r.id)).map((o) => o.status)).toEqual(["served", "served"])
        // a: cooking from payment, 10 min (16 kept to 10), served a minute later.
        expect(await row(a.order.id)).toMatchObject({ status: "served", cooking_started_at: T0, ready_at: T0 + 10 * 60_000, served_at: T0 + 11 * 60_000 })
        // b: 8 min left of its estimate when it started, so ready at T0 + 9 min.
        expect(await row(b.order.id)).toMatchObject({ status: "served", cooking_started_at: T0 + 60_000, ready_at: T0 + 9 * 60_000, served_at: T0 + 10 * 60_000 })

        // Reading again changes nothing and tells nobody twice.
        const snap = await t.deps.db.query("SELECT * FROM orders ORDER BY id")
        const acts = await t.deps.db.query("SELECT * FROM activity ORDER BY id")
        await board(r.id)
        await json<Order>(t.call("GET", `/api/orders/${a.order.id}?t=${a.token}`))
        expect(await t.deps.db.query("SELECT * FROM orders ORDER BY id")).toEqual(snap)
        expect(await t.deps.db.query("SELECT * FROM activity ORDER BY id")).toEqual(acts)
        const tablesNow = await json<{ tables: Table[] }>(t.call("GET", `/api/restaurants/${r.id}/manage`, { cookie: t.cookies.OWNER }))
        expect(tablesNow.tables.filter((x) => x.status === "available")).toHaveLength(4)
    })

    it("never cooks an unpaid or part-paid order", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const item = [{ id: dosa.id, qty: 2, guest: 1 }]
        const unpaid = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: item })
        const part = await placeOrder(t, { tableId: tables[1].id, guests: 2, paymentMode: "split", splitBy: "equal", items: item })
        await t.deps.db.query("UPDATE order_shares SET paid = amount, status = 'paid', paid_at = $2 WHERE id = $1", [part.order.shares[0].id, T0])
        t.clock.t = T0 + 14 * 60_000
        let o = await json<Order>(t.call("GET", `/api/orders/${unpaid.order.id}?t=${unpaid.token}`))
        expect(o).toMatchObject({ status: "awaiting_payment", cookingStartedAt: null, waitMinutes: null, expectedWaitMinutes: 10 })
        t.clock.t = T0 + 5 * 3600_000
        await board(r.id)
        o = await json<Order>(t.call("GET", `/api/orders/${part.order.id}?t=${part.token}`))
        expect(o).toMatchObject({ status: "awaiting_payment", cookingStartedAt: null, readyAt: null, servedAt: null })
        expect((await row(unpaid.order.id))!.status).toBe("cancelled")
    })

    it("still lets staff finish early, and the clock then serves a minute after ready", async () => {
        const { r, dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 1, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] })
        await markPaid(t, order.id)
        t.clock.t = T0 + 2 * 60_000
        const ready = await json<Order>(t.call("POST", `/api/orders/${order.id}/status`, { cookie: t.cookies.CHEF, body: { status: "ready" } }))
        expect(ready).toMatchObject({ status: "ready", readyAt: T0 + 2 * 60_000 })
        t.clock.t = T0 + 3 * 60_000
        expect((await board(r.id))[0]).toMatchObject({ status: "served", servedAt: T0 + 3 * 60_000 })
    })
})

describe("invoice", () => {
    it("is a public tax invoice via its own read-only token", async () => {
        const { r, dosa, coffee, tables } = await restaurantWithStaff(t, { address: "100 Feet Road", fssai: "12345678901234" })
        const { order, token } = await placeOrder(t, {
            tableId: tables[0].id,
            guests: 2,
            paymentMode: "one_pays",
            items: [
                { id: dosa.id, qty: 1, guest: 1 },
                { id: dosa.id, qty: 1, guest: 2 },
                { id: coffee.id, qty: 1, guest: 2 }
            ]
        })
        await markPaid(t, order.id)
        await t.deps.db.query(
            `INSERT INTO payments (target_kind, target_id, chain_id, tx_hash, log_index, kind, payer, recipient, amount, block_number, verified_at)
             VALUES ('order', $1, 10143, $2, 0, 'private', $3, $4, $5, 1, $6)`,
            [order.shares[0].id, `0x${"ab".repeat(32)}`, "0x00000000000000000000000000000000000000a3", OWNER, order.total, T0]
        )
        const invoiceToken = invoiceTokenOf(order)
        // The share token pays and splits; it does not open the invoice, and the invoice token differs.
        expect(invoiceToken).not.toBe(token)
        expect(await status(t.call("GET", `/api/i/${token}`))).toBe(404)
        const inv = await json<Invoice>(t.call("GET", `/api/i/${invoiceToken}`))
        expect(inv).toMatchObject({
            kind: "tax_invoice",
            invoiceNo: `SR/2026-27/000001`,
            supplier: { name: "Spice Route", address: "100 Feet Road", state: "Karnataka", stateCode: "29", gstin: DEMO_GSTIN, fssai: "12345678901234" },
            placeOfSupply: "Karnataka",
            table: "1",
            subtotal: 22_500_000,
            taxableValue: 22_500_000,
            cgst: { rateBps: 250, amount: 560_000 },
            sgst: { rateBps: 250, amount: 560_000 },
            igst: { rateBps: 0, amount: 0 },
            total: 23_620_000,
            amountInWords: "Twenty-three USDC and sixty-two cents only",
            // Paid orders go straight to the kitchen.
            status: "cooking",
            orderId: order.id,
            shareUrl: `http://localhost:5174/i/${invoiceToken}`
        })
        expect(JSON.stringify(inv)).not.toContain(token)
        // Same dish for two guests is one line.
        expect(inv.lines).toEqual([
            { name: "Masala dosa", sac: "996331", qty: 2, rate: 10 * U, taxable: 20 * U },
            { name: "Filter coffee", sac: "996331", qty: 1, rate: 2_500_000, taxable: 2_500_000 }
        ])
        // A private payment shows no hash.
        expect(inv.payments).toEqual([{ label: "Confidential payment", amount: order.total, private: true, txHash: null, at: T0 }])
        expect(JSON.stringify(inv)).not.toContain(GUEST)
        expect(await status(t.call("GET", `/api/i/${"A".repeat(43)}`))).toBe(404)
        expect(await status(t.call("GET", "/api/i/short"))).toBe(404)
        void r
    })

    it("keeps payers off the shareable invoice, as bills do", async () => {
        const { dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(
            t,
            { tableId: tables[0].id, guests: 2, paymentMode: "split", splitBy: "equal", items: [{ id: dosa.id, qty: 2, guest: 1 }], guestNames: ["Asha", "Ben"] },
            t.cookies.GUEST
        )
        const [asha, ben] = order.shares
        // Asha pays publicly. Ben pays one note confidentially and the rest publicly.
        await recordPayment(t, asha.id, asha.amount, { kind: "public", wallet: GUEST })
        await recordPayment(t, ben.id, 5 * U, { kind: "private" })
        await recordPayment(t, ben.id, ben.amount - 5 * U, { kind: "public", wallet: FRIEND })
        await markPaid(t, order.id)
        const url = `/api/i/${invoiceTokenOf((await json<Order>(t.call("GET", `/api/orders/${order.id}`, { cookie: t.cookies.GUEST }))))}`

        // A link holder: no transactions at all, and the confidential note names nobody.
        const anon = await json<Invoice>(t.call("GET", url))
        expect(anon.payments.map((p) => [p.label, p.private, p.txHash])).toEqual([
            ["Asha", false, null],
            ["Confidential payment", true, null],
            ["Ben", false, null]
        ])
        expect(JSON.stringify(anon)).not.toMatch(/0x[0-9a-f]{64}/)
        expect(JSON.stringify(await json<Invoice>(t.call("GET", url, { cookie: t.cookies.OUTSIDER })))).not.toMatch(/0x[0-9a-f]{64}/)

        // Staff and the wallet that ordered see Asha's public tx, but not Ben's: his seat also paid
        // privately, and his public tx would tie his wallet to that note.
        for (const cookie of [t.cookies.CHEF, t.cookies.GUEST]) {
            const inv = await json<Invoice>(t.call("GET", url, { cookie }))
            expect(inv.payments[0].txHash).toMatch(/^0x[0-9a-f]{64}$/)
            expect(inv.payments[1].txHash).toBeNull()
            expect(inv.payments[2].txHash).toBeNull()
        }
    })
})

describe("split a paid order with friends", () => {
    it("creates a bill payable to the payer", async () => {
        const { dosa, coffee, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(
            t,
            { tableId: tables[0].id, guests: 3, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }, { id: dosa.id, qty: 1, guest: 2 }, { id: coffee.id, qty: 1, guest: 3 }] },
            t.cookies.GUEST
        )
        const split = (cookie: string, body: Record<string, unknown>) => t.call("POST", `/api/orders/${order.id}/split-bill`, { cookie, body })
        const people = [{ wallet: FRIEND, displayName: "Friend" }, { displayName: "Sam" }]
        expect(await status(split(t.cookies.GUEST, { participants: people }))).toBe(409) // not paid yet
        // GUEST signed in, placed the order and paid it confidentially.
        await markPaid(t, order.id, { kind: "private" })
        expect(await status(split(t.cookies.OUTSIDER, { participants: people, t: token }))).toBe(403) // the link isn't proof of paying
        expect(await status(split(t.cookies.GUEST, { participants: [] }))).toBe(400)
        expect(await status(split(t.cookies.GUEST, { participants: [{ wallet: GUEST, displayName: "Me" }] }))).toBe(400)

        const bill = await json<Bill>(split(t.cookies.GUEST, { participants: people }), 201)
        expect(bill).toMatchObject({ creator: GUEST, recipient: GUEST, source: "restaurant_order", orderId: order.id, splitType: "equal", status: "open", total: order.total })
        expect(bill.participants.map((p) => [p.displayName, p.amount, p.status])).toEqual([
            // 23.62 in whole cents; the leftover cent stays with the payer
            [expect.any(String), 7_880_000, "covered"],
            ["Friend", 7_870_000, "owed"],
            ["Sam", 7_870_000, "owed"]
        ])
        expect(bill.participants.reduce((a, p) => a + p.amount, 0)).toBe(order.total)
        expect(bill.myParticipantId).toBe(bill.participants[0].id)
        const after = await json<Order>(t.call("GET", `/api/orders/${order.id}?t=${token}`))
        expect(after.splitBillId).toBe(bill.id)
        expect(await status(split(t.cookies.GUEST, { participants: people }))).toBe(409) // only once

        const rows = await t.deps.db.query<{ order_ref: string; source: string }>(
            "SELECT p.order_ref, b.source FROM bill_participants p JOIN bills b ON b.id = p.bill_id WHERE b.id = $1",
            [bill.id]
        )
        expect(rows).toHaveLength(3)
        expect(rows.every((x) => /^0x[0-9a-f]{64}$/.test(x.order_ref) && x.source === "restaurant_order")).toBe(true)
        const act = await t.deps.db.query<{ kind: string; link: string }>("SELECT kind, link FROM activity WHERE wallet = $1", [FRIEND])
        expect(act).toEqual([{ kind: "bill_request", link: `/bills/${bill.id}` }])
    })

    it("keeps the payer first and everyone else in the order entered when the bill is reloaded", async () => {
        const { dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 2, paymentMode: "one_pays", items: [{ id: dosa.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        await markPaid(t, order.id, { kind: "private" })
        const names = ["Zed", "Amy", "Kai", "Bea", "Lou", "Mo", "Ann", "Ray", "Ivy", "Tom", "Eve", "Ola"]
        const bill = await json<Bill>(t.call("POST", `/api/orders/${order.id}/split-bill`, { cookie: t.cookies.GUEST, body: { participants: names.map((displayName) => ({ displayName })) } }), 201)
        // Unsorted random ids would almost never come back in this order.
        const again = await json<Bill>(t.call("GET", `/api/bills/${bill.id}`, { cookie: t.cookies.GUEST }))
        expect(again.participants.map((p) => p.displayName)).toEqual(bill.participants.map((p) => p.displayName))
        expect(again.participants.slice(1).map((p) => p.displayName)).toEqual(names)
        expect(again.participants[0].wallet).toBe(GUEST)
    })

    it("splits by guest items; with nobody signed in, the public payer's wallet decides", async () => {
        const { dosa, coffee, tables } = await restaurantWithStaff(t)
        const { order, token } = await placeOrder(t, {
            tableId: tables[0].id,
            guests: 3,
            paymentMode: "one_pays",
            items: [{ id: dosa.id, qty: 1, guest: 1 }, { id: coffee.id, qty: 2, guest: 2 }, { id: coffee.id, qty: 1, guest: 3 }]
        })
        await markPaid(t, order.id, { kind: "public", wallet: GUEST })
        // Another guest at the table holds the same link, but didn't pay.
        expect(await status(t.call("POST", `/api/orders/${order.id}/split-bill?t=${token}`, { cookie: t.cookies.FRIEND, body: { participants: [{ displayName: "B" }] } }))).toBe(403)
        const bill = await json<Bill>(
            t.call("POST", `/api/orders/${order.id}/split-bill`, {
                cookie: t.cookies.GUEST,
                body: { splitType: "items", participants: [{ wallet: FRIEND, displayName: "Friend", guest: 2 }] }
            }),
            201
        )
        // Friend had two coffees: 5.00 + 5% = 5.25. Guests 1 and 3 stay with the payer.
        expect(bill.splitType).toBe("items")
        expect(bill.participants.map((p) => p.amount)).toEqual([order.total - 5_250_000, 5_250_000])
    })

    it("checks who really paid: the public wallet, or the signed-in placer for a private payment", async () => {
        const { dosa, tables } = await restaurantWithStaff(t)
        const items = [{ id: dosa.id, qty: 1, guest: 1 }]
        const people = { participants: [{ displayName: "B" }] }
        const split = (orderId: string, cookie: string, token?: string) =>
            t.call("POST", `/api/orders/${orderId}/split-bill${token ? `?t=${token}` : ""}`, { cookie, body: people })

        // Placed signed in by GUEST, but paid publicly by FRIEND: FRIEND paid, so only FRIEND may split.
        const a = await placeOrder(t, { tableId: tables[0].id, guests: 2, paymentMode: "one_pays", items }, t.cookies.GUEST)
        await markPaid(t, a.order.id, { kind: "public", wallet: FRIEND })
        expect(await status(split(a.order.id, t.cookies.GUEST, a.token))).toBe(403)
        expect(await status(split(a.order.id, t.cookies.FRIEND))).toBe(201)

        // Paid privately with nobody signed in: nobody can prove they paid.
        const b = await placeOrder(t, { tableId: tables[1].id, guests: 2, paymentMode: "one_pays", items })
        await markPaid(t, b.order.id, { kind: "private" })
        const refused = await t.call("POST", `/api/orders/${b.order.id}/split-bill?t=${b.token}`, { cookie: t.cookies.GUEST, body: people })
        expect(refused.status).toBe(403)
        expect(await refused.json()).toEqual({
            error: "This order was paid privately without signing in, so FairPay can't tell who paid. Sign in before ordering to split later."
        })

        // Paid privately by a signed-in placer: only the placer.
        const c = await placeOrder(t, { tableId: tables[2].id, guests: 2, paymentMode: "one_pays", items }, t.cookies.GUEST)
        await markPaid(t, c.order.id, { kind: "private" })
        expect(await status(split(c.order.id, t.cookies.FRIEND, c.token))).toBe(403)
        expect(await status(split(c.order.id, t.cookies.GUEST))).toBe(201)

        // Marked paid with no payment on record (the demo seed): nobody.
        const d = await placeOrder(t, { tableId: tables[3].id, guests: 2, paymentMode: "one_pays", items }, t.cookies.GUEST)
        await markPaid(t, d.order.id)
        expect(await status(split(d.order.id, t.cookies.GUEST, d.token))).toBe(409)
    })

    it("is only for one-pays orders", async () => {
        const { dosa, tables } = await restaurantWithStaff(t)
        const { order } = await placeOrder(t, { tableId: tables[0].id, guests: 2, paymentMode: "split", splitBy: "equal", items: [{ id: dosa.id, qty: 1, guest: 1 }] }, t.cookies.GUEST)
        await markPaid(t, order.id)
        expect(await status(t.call("POST", `/api/orders/${order.id}/split-bill`, { cookie: t.cookies.GUEST, body: { participants: [{ displayName: "B" }] } }))).toBe(409)
    })
})

describe("demo seed", () => {
    it("creates Saffron Table once", async () => {
        const opts = { ownerWallet: OWNER, payoutWallet: PAYOUT, now: T0 }
        const first = await seedDemo(t.deps.db, opts)
        const second = await seedDemo(t.deps.db, opts)
        expect(first.created).toBe(true)
        expect(second).toEqual({ restaurantId: first.restaurantId, created: false })
        const n = await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM restaurants")
        expect(n!.n).toBe(1)

        const sf = await json<StorefrontView>(t.call("GET", "/api/restaurants/saffron-table"))
        expect(sf.restaurant).toMatchObject({ name: "Saffron Table", isDemo: true, state: "Karnataka", gstRateBps: 500, serviceChargeBps: 0, privatePayments: true, coverImage: "/menu/cover.svg" })
        expect(isValidGstin(sf.restaurant.gstin!)).toBe(true)
        expect(sf.restaurant.fssai).toMatch(/^[0-9]{14}$/)
        expect(sf.tables).toHaveLength(12)
        expect(sf.tables.map((x) => x.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"])
        expect(sf.tables.filter((x) => x.status === "occupied")).toHaveLength(3)
        expect(sf.restaurant.tables).toEqual({ total: 12, available: 9 })
        expect(sf.chefs).toHaveLength(2)
        expect(sf.chefs.every((c) => (c.bio ?? "").length > 20)).toBe(true)
        expect(sf.menu.length).toBeGreaterThanOrEqual(10)
        expect(new Set(sf.menu.map((m) => m.category))).toEqual(new Set(["Small plates", "Mains", "Sweet", "Drinks"]))

        // Every dish has its bundled art, and the art is plain SVG.
        const dir = path.join(here, "..", "public", "menu")
        for (const m of sf.menu) {
            expect(m.image).toBe(`/menu/${m.id}.svg`)
            expect(existsSync(path.join(dir, `${m.id}.svg`))).toBe(true)
        }
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".svg"))) {
            const svg = readFileSync(path.join(dir, f), "utf8")
            expect(svg.length).toBeLessThan(6 * 1024)
            expect(svg).not.toMatch(/<script|<text|href=|url\(http|on[a-z]+=|<foreignObject/i)
        }
        expect(DEMO_MENU.every((m) => m.price % 10_000 === 0)).toBe(true)

        // The kitchen board has the seeded orders, paid, with invoice numbers.
        const orders = await json<Order[]>(t.call("GET", `/api/restaurants/${first.restaurantId}/orders?status=active`, { cookie: t.cookies.OWNER }))
        expect(orders).toHaveLength(3)
        for (const o of orders) {
            expect(["paid", "cooking"]).toContain(o.status)
            expect(o.invoiceNo).toMatch(/^ST\/2026-27\/00000[1-3]$/)
            expect(o.shares.reduce((a, s) => a + s.amount, 0)).toBe(o.total)
        }
    })

    it("keeps the sample orders consistent: labelled demo, no fake payments, believable waits", async () => {
        const { restaurantId } = await seedDemo(t.deps.db, { ownerWallet: OWNER, payoutWallet: PAYOUT, now: T0 })
        const board = () => json<Order[]>(t.call("GET", `/api/restaurants/${restaurantId}/orders?status=active`, { cookie: t.cookies.OWNER }))
        const seeded = await board()
        expect(seeded).toHaveLength(3)
        for (const o of seeded) {
            expect(o.demo).toBe(true)
            // Paid in the recent past, still due in the future.
            expect(o.paidAt!).toBeLessThan(T0)
            expect(o.createdAt).toBeLessThan(o.paidAt!)
            expect(o.estReadyAt!).toBeGreaterThan(T0)
            expect(o.waitMinutes!).toBeGreaterThan(0)
            // The paid one started cooking by itself when the board was read.
            expect(o.status).toBe("cooking")
            expect(o.cookingStartedAt!).toBeGreaterThanOrEqual(o.paidAt!)
            expect(o.waitMinutes!).toBeLessThanOrEqual(10)
            // No invented payments: the invoice says it's demo data instead of listing a fake transaction.
            const inv = await json<Invoice>(t.call("GET", `/api/i/${invoiceTokenOf(o)}`))
            expect(inv).toMatchObject({ demo: true, payments: [], invoiceNo: o.invoiceNo, issuedAt: o.paidAt })
        }
        const noPayments = await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM payments")
        expect(noPayments!.n).toBe(0)

        // A restart before anyone reads the board: the sample orders start over from now.
        const soon = T0 + 3 * 3600_000
        expect(await refreshDemoOrders(t.deps.db, soon)).toBe(3)
        t.clock.t = soon
        const fresh = await board()
        for (const o of fresh) {
            const before = seeded.find((x) => x.id === o.id)!
            expect(o.status).toBe("cooking")
            expect(o.paidAt).toBe(before.paidAt! + (soon - T0))
            expect(o.waitMinutes!).toBeGreaterThan(0)
            expect(o.invoiceNo).toBe(before.invoiceNo)
            expect(o.shares.every((s) => s.status === "paid")).toBe(true)
        }

        // Staff finish one early; the clock serves the rest within ten minutes of being paid.
        const first = fresh[0]
        expect(await status(t.call("POST", `/api/orders/${first.id}/status`, { cookie: t.cookies.OWNER, body: { status: "ready" } }))).toBe(200)
        t.clock.t = soon + 11 * 60_000
        expect(await board()).toEqual([])
        const done = await t.deps.db.query<{ id: string; status: string; paid_at: number; served_at: number }>("SELECT id, status, paid_at, served_at FROM orders ORDER BY id")
        for (const o of done) {
            expect(o.status).toBe("served")
            expect(Number(o.served_at) - Number(o.paid_at)).toBeLessThanOrEqual(11 * 60_000)
        }
        expect(Number(done.find((o) => o.id === first.id)!.served_at)).toBe(soon + 60_000)
        // Served sample orders are left alone by a later restart, and nothing was added.
        const snapshot = await t.deps.db.query("SELECT id, status, created_at, paid_at, cooking_started_at, ready_at, served_at FROM orders ORDER BY id")
        expect(await refreshDemoOrders(t.deps.db, soon + 3600_000)).toBe(0)
        expect(await t.deps.db.query("SELECT id, status, created_at, paid_at, cooking_started_at, ready_at, served_at FROM orders ORDER BY id")).toEqual(snapshot)
        expect((await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM payments"))!.n).toBe(0)

        // A real order at the demo restaurant is not labelled demo.
        const sf = await json<StorefrontView>(t.call("GET", "/api/restaurants/saffron-table"))
        const freeTable = sf.tables.find((x) => x.status === "available")!
        const real = await placeOrder(t, { tableId: freeTable.id, guests: 1, paymentMode: "one_pays", items: [{ id: "chai", qty: 1, guest: 1 }] })
        expect(real.order.demo).toBeUndefined()
        // Chai takes 4 minutes; the wait never shows less than 5 or more than 10.
        expect(real.order.expectedWaitMinutes).toBe(5)
    })

    it("does nothing to refresh without a demo restaurant", async () => {
        expect(await refreshDemoOrders(t.deps.db, T0)).toBe(0)
    })
})
