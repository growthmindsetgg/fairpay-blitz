// The demo restaurant, Saffron Table, so a fresh install has something to order from. Runs at
// startup and does nothing when a demo restaurant already exists, except move the sample orders'
// times up to now (refreshDemoOrders) so their wait estimates stay believable.

import type { Db } from "./context.js"
import { assignInvoiceNo, estimateReadyAt } from "./faireats.js"
import { newOrderRef, newToken } from "./ids.js"
import { computeBill, splitOrder } from "../shared/gst.js"
import type { Wallet } from "../shared/types.js"

const DEMO_ID = "r_saffrontable"
/** Format and check digit valid (29 = Karnataka). A demo number, not a real registration. */
export const DEMO_GSTIN = "29AAACF1234A1ZB"
const DEMO_FSSAI = "11226999000123"

// Prices are set so that dish + 5% GST lands on a whole number of 5 USDC notes (4.76 -> 5.00),
// so most guest shares need little or no round-up to be paid privately.
const c = (cents: number) => cents * 10_000

type DemoItem = {
    id: string
    name: string
    description: string
    category: "Small plates" | "Mains" | "Sweet" | "Drinks"
    price: number
    veg: boolean
    spice: number
    prep: number
}

export const DEMO_MENU: DemoItem[] = [
    { id: "pakora", name: "Onion pakora", description: "Crisp gram-flour fritters, tamarind chutney", category: "Small plates", price: c(476), veg: true, spice: 1, prep: 10 },
    { id: "burrata", name: "Burrata & peaches", description: "Charred peach, basil oil, black pepper", category: "Small plates", price: c(952), veg: true, spice: 0, prep: 8 },
    { id: "tacos", name: "Mushroom tacos", description: "Oyster mushroom, salsa macha, lime", category: "Small plates", price: c(952), veg: true, spice: 2, prep: 12 },
    { id: "biryani", name: "Saffron chicken biryani", description: "Slow-cooked rice, fried onion, raita", category: "Mains", price: c(1428), veg: false, spice: 2, prep: 25 },
    { id: "paneer", name: "Butter paneer", description: "Tomato-cashew gravy, kasuri methi, naan", category: "Mains", price: c(1428), veg: true, spice: 1, prep: 20 },
    { id: "ramen", name: "Miso ramen", description: "White miso broth, soft egg, chili oil", category: "Mains", price: c(1428), veg: false, spice: 1, prep: 18 },
    { id: "risotto", name: "Lemon risotto", description: "Parmesan, lemon zest, crispy sage", category: "Mains", price: c(1904), veg: true, spice: 0, prep: 22 },
    { id: "kulfi", name: "Pistachio kulfi", description: "Cardamom, rose, crushed pistachio", category: "Sweet", price: c(476), veg: true, spice: 0, prep: 5 },
    { id: "jamun", name: "Gulab jamun", description: "Warm milk dumplings, saffron syrup", category: "Sweet", price: c(476), veg: true, spice: 0, prep: 6 },
    { id: "lassi", name: "Mango lassi", description: "Alphonso mango, yoghurt, a pinch of salt", category: "Drinks", price: c(476), veg: true, spice: 0, prep: 4 },
    { id: "chai", name: "Masala chai", description: "Assam tea, ginger, cardamom", category: "Drinks", price: c(238), veg: true, spice: 0, prep: 4 }
]

const CHEFS = [
    {
        id: "c_saffronasha",
        name: "Asha Rao",
        title: "Head chef",
        bio: "Grew up cooking in her grandmother's Udupi kitchen, trained in Lyon, and has run the pass at Saffron Table since it opened. Spice is a seasoning, not a dare.",
        specialty: "Slow-cooked biryani and coastal Karnataka plates",
        years: 16
    },
    {
        id: "c_saffronvikram",
        name: "Vikram Menon",
        title: "Sous chef",
        bio: "Came from a Tokyo ramen counter by way of a Kochi toddy shop. Runs the tandoor and the noodle station, and makes the kulfi every morning.",
        specialty: "Broths, tandoor and frozen desserts",
        years: 9
    }
]

// Labels 1-12; seats 2, 4 or 6.
const SEATS = [2, 2, 4, 4, 4, 4, 6, 6, 2, 4, 4, 6]

// Three in-progress orders so the storefront shows some tables taken. They are marked paid without
// any payment (no payments row, no transaction): Order.demo and Invoice.demo say so in the UI.
const DEMO_ORDERS: { table: number; mode: "one_pays" | "split"; guests: number; status: "paid" | "cooking"; minutesAgo: number; items: [string, number, number][] }[] = [
    { table: 3, mode: "split", guests: 2, status: "cooking", minutesAgo: 6, items: [["biryani", 1, 1], ["paneer", 1, 2], ["lassi", 2, 1]] },
    { table: 7, mode: "one_pays", guests: 4, status: "paid", minutesAgo: 2, items: [["pakora", 2, 1], ["ramen", 2, 1], ["risotto", 1, 1], ["chai", 4, 1]] },
    { table: 10, mode: "one_pays", guests: 2, status: "cooking", minutesAgo: 4, items: [["tacos", 1, 1], ["burrata", 1, 1], ["kulfi", 2, 1]] }
]

/**
 * Creates the Saffron Table demo restaurant unless a demo restaurant already exists.
 * Returns its id and whether it was created now.
 */
export async function seedDemo(db: Db, opts: { ownerWallet: Wallet; payoutWallet: Wallet; now: number }): Promise<{ restaurantId: string; created: boolean }> {
    const owner = opts.ownerWallet.toLowerCase() as Wallet
    const payout = opts.payoutWallet.toLowerCase() as Wallet
    const now = opts.now
    return db.tx(async (q) => {
        const existing = await q.one<{ id: string }>("SELECT id FROM restaurants WHERE is_demo ORDER BY created_at LIMIT 1")
        if (existing) return { restaurantId: existing.id, created: false }
        if (await q.one("SELECT 1 FROM restaurants WHERE id = $1", [DEMO_ID])) return { restaurantId: DEMO_ID, created: false }
        // Someone may have registered a "Saffron Table" first; the demo then takes a variant.
        const slug = (await q.one("SELECT 1 FROM restaurants WHERE slug = 'saffron-table'")) ? "saffron-table-demo" : "saffron-table"
        const prefix = (await q.one("SELECT 1 FROM restaurants WHERE invoice_prefix = 'ST'")) ? "STDEMO" : "ST"

        await q.query(
            `INSERT INTO restaurants (id, slug, name, tagline, description, cuisine, address, city, state, gstin, fssai, gst_rate_bps,
                service_charge_bps, owner_wallet, payout_wallet, cover_image, hours, invoice_prefix, is_demo, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 500, 0, $12, $13, $14, $15, $16, TRUE, $17)`,
            [
                DEMO_ID,
                slug,
                "Saffron Table",
                "Order at the table, split it your way, pay without showing your wallet.",
                "A neighbourhood kitchen in Indiranagar cooking modern Indian plates with a few detours to Tokyo and Lyon. Order from your table, split the bill however you like, and get a proper GST invoice.",
                "Modern Indian",
                "12th Main Road, HAL 2nd Stage, Indiranagar",
                "Bengaluru",
                "Karnataka",
                DEMO_GSTIN,
                DEMO_FSSAI,
                owner,
                payout,
                "/menu/cover.svg",
                "Daily 12:00-15:30, 19:00-23:30",
                prefix,
                now
            ]
        )
        for (const ch of CHEFS) {
            await q.query("INSERT INTO chefs (id, restaurant_id, name, title, bio, specialty, years, photo, on_duty) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, TRUE)", [
                ch.id,
                DEMO_ID,
                ch.name,
                ch.title,
                ch.bio,
                ch.specialty,
                ch.years
            ])
        }
        for (const [i, m] of DEMO_MENU.entries()) {
            await q.query(
                `INSERT INTO menu_items (id, restaurant_id, name, description, category, price, image, veg, spice, prep_minutes, available, sort)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)`,
                [m.id, DEMO_ID, m.name, m.description, m.category, m.price, `/menu/${m.id}.svg`, m.veg, m.spice, m.prep, i + 1]
            )
        }
        const tableIds: string[] = []
        for (const [i, seats] of SEATS.entries()) {
            const id = `t_saffron${String(i + 1).padStart(2, "0")}`
            tableIds.push(id)
            await q.query("INSERT INTO restaurant_tables (id, restaurant_id, label, seats, status, updated_at) VALUES ($1, $2, $3, $4, 'available', $5)", [
                id,
                DEMO_ID,
                String(i + 1),
                seats,
                now
            ])
        }

        const menu = new Map(DEMO_MENU.map((m) => [m.id, m]))
        for (const [n, o] of DEMO_ORDERS.entries()) {
            const orderId = demoOrderId(n)
            const tableId = tableIds[o.table - 1]
            const { placedAt, paidAt } = demoTimes(o.minutesAgo, now)
            const lines = o.items.map(([id, qty, guest]) => ({ m: menu.get(id)!, unitPrice: menu.get(id)!.price, qty, guest }))
            const totals = computeBill({ lines, gstRateBps: 500, serviceChargeBps: 0, intraState: true })
            const shares =
                o.mode === "one_pays"
                    ? [{ guest: 1, label: "Whole table", amount: totals.total }]
                    : splitOrder(lines, o.guests, totals, "items")
                          .map((amount, i) => ({ guest: i + 1, label: `Guest ${i + 1}`, amount }))
                          .filter((s) => s.amount > 0)
            await q.query(
                `INSERT INTO orders (id, restaurant_id, table_id, placed_by, guests, payment_mode, status, subtotal, service_charge, cgst, sgst, igst,
                    round_off, total, gst_rate_bps, chef_id, share_token, invoice_token, created_at, paid_at, cooking_started_at)
                 VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 500, $14, $15, $16, $17, $18, $19)`,
                [
                    orderId,
                    DEMO_ID,
                    tableId,
                    o.guests,
                    o.mode,
                    o.status,
                    totals.subtotal,
                    totals.serviceCharge,
                    totals.cgst,
                    totals.sgst,
                    totals.igst,
                    totals.roundOff,
                    totals.total,
                    o.status === "cooking" ? CHEFS[n % CHEFS.length].id : null,
                    newToken(),
                    newToken(),
                    placedAt,
                    paidAt,
                    o.status === "cooking" ? demoTimes(o.minutesAgo, now).cookingAt : null
                ]
            )
            for (const l of lines) {
                await q.query("INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest, sac) VALUES ($1, $2, $3, $4, $5, $6, '996331')", [
                    orderId,
                    l.m.id,
                    l.m.name,
                    l.unitPrice,
                    l.qty,
                    l.guest
                ])
            }
            for (const s of shares) {
                const shareId = `s_saffrondemo${n + 1}g${s.guest}`
                const ref = newOrderRef(orderId, shareId)
                // Marked paid for the demo only; no payment row exists, so nothing claims an on-chain payment.
                await q.query(
                    "INSERT INTO order_shares (id, order_id, guest, label, amount, paid, status, order_ref, secret, paid_at) VALUES ($1, $2, $3, $4, $5, $5, 'paid', $6, $7, $8)",
                    [shareId, orderId, s.guest, s.label, s.amount, ref.orderRef, ref.secret, paidAt]
                )
            }
            await assignInvoiceNo(q, orderId, paidAt)
            await q.query("UPDATE restaurant_tables SET status = 'occupied', order_id = $2 WHERE id = $1", [tableId, orderId])
        }
        // Estimates once all three exist, so a fresh seed and a later refresh give the same queue.
        await estimateDemoOrders(q, DEMO_ID, now)
        return { restaurantId: DEMO_ID, created: true }
    })
}

const demoOrderId = (n: number) => `o_saffrondemo${n + 1}`

function demoTimes(minutesAgo: number, now: number) {
    const paidAt = now - minutesAgo * 60_000
    return { placedAt: paidAt - 2 * 60_000, paidAt, cookingAt: paidAt + 60_000 }
}

/** Ready-time estimates for the sample orders still waiting on the kitchen, from their paid time. */
async function estimateDemoOrders(q: Db, restaurantId: string, now: number) {
    for (const [n, o] of DEMO_ORDERS.entries()) {
        const id = demoOrderId(n)
        const { paidAt } = demoTimes(o.minutesAgo, now)
        await q.query("UPDATE orders SET est_ready_at = $3 WHERE id = $1 AND restaurant_id = $2 AND status IN ('paid', 'cooking')", [
            id,
            restaurantId,
            await estimateReadyAt(q, id, paidAt)
        ])
    }
}

/**
 * Seeded sample orders cook and are served by the clock (advanceKitchen) within about ten minutes
 * of the first read. On each startup this moves the ones still paid or cooking back to "placed a
 * few minutes ago". Orders already ready, served or cancelled are left alone. Returns how
 * many it moved; 0 when there is no demo restaurant.
 */
export async function refreshDemoOrders(db: Db, now: number): Promise<number> {
    return db.tx(async (q) => {
        const demo = await q.one<{ id: string }>("SELECT id FROM restaurants WHERE id = $1 AND is_demo", [DEMO_ID])
        if (!demo) return 0
        let moved = 0
        for (const [n, o] of DEMO_ORDERS.entries()) {
            const { placedAt, paidAt, cookingAt } = demoTimes(o.minutesAgo, now)
            const rows = await q.query<{ id: string }>(
                `UPDATE orders SET created_at = $3, paid_at = $4, cooking_started_at = CASE WHEN status = 'cooking' THEN $5::bigint ELSE NULL END
                 WHERE id = $1 AND restaurant_id = $2 AND status IN ('paid', 'cooking') RETURNING id`,
                [demoOrderId(n), DEMO_ID, placedAt, paidAt, cookingAt]
            )
            if (rows.length === 0) continue
            await q.query("UPDATE order_shares SET paid_at = $2 WHERE order_id = $1", [demoOrderId(n), paidAt])
            moved++
        }
        await estimateDemoOrders(q, DEMO_ID, now)
        return moved
    })
}
