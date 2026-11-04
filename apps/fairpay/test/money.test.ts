// The owner's money view (server/routes/money.ts): who may read it, totals and tips, the payment
// log and its pages, what a confidential payment never shows, refund notes, invoices, the CSV
// export and the on-chain re-check.

import { beforeEach, describe, expect, it } from "vitest"
import { FairPayError } from "@fairpay/sdk"
import type { Hash, Hex } from "viem"
import type { MoneyInvoicePage, MoneyPayment, MoneyPaymentPage, MoneySummary, RecheckResult, Restaurant, SettleResult, Wallet } from "../shared/types.js"
import { newOrderRef, newToken } from "../server/ids.js"
import { recheckOutcome, startOfDayIst } from "../server/routes/money.js"
import { DEMO_GSTIN } from "../server/seed.js"
import { DENOMINATION, TEST_DEPLOYMENT, fakeChain, makeTestApp, paidOnChain, txHash, type TestApp } from "./helpers.js"

const U = 1_000_000
const OWNER = "0x1111111111111111111111111111111111111111" as Wallet
const MANAGER = "0x2222222222222222222222222222222222222222" as Wallet
const CHEF = "0x3333333333333333333333333333333333333333" as Wallet
const WAITER = "0x4444444444444444444444444444444444444444" as Wallet
const GUEST = "0x5555555555555555555555555555555555555555" as Wallet
const OUTSIDER = "0x6666666666666666666666666666666666666666" as Wallet
const POOL = TEST_DEPLOYMENT.pool.toLowerCase()
const T0 = Date.parse("2026-10-31T12:00:00+05:30")
const DAY = 86_400_000

type Ctx = TestApp & { clock: { t: number }; cookies: Record<string, string>; r: Restaurant; tables: string[] }

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    const body = await r.json()
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`)
    return body as T
}

async function setup(): Promise<Ctx> {
    const clock = { t: T0 }
    // The owner registers, so the payout wallet is theirs; FairPool allowlists it.
    const t = await makeTestApp({ chain: fakeChain({ merchants: [OWNER] }), now: () => clock.t })
    const cookies: Record<string, string> = {}
    for (const [name, w] of Object.entries({ OWNER, MANAGER, CHEF, WAITER, GUEST, OUTSIDER })) cookies[name] = await t.signIn(w)
    const r = await json<Restaurant>(
        t.call("POST", "/api/restaurants", { cookie: cookies.OWNER, body: { name: "Spice Route", state: "Karnataka", gstin: DEMO_GSTIN, tables: 6 } }),
        201
    )
    for (const [w, role] of [[MANAGER, "manager"], [CHEF, "chef"], [WAITER, "waiter"]] as const) {
        await json(t.call("POST", `/api/restaurants/${r.id}/staff`, { cookie: cookies.OWNER, body: { wallet: w, role, displayName: role } }), 201)
    }
    const tables = (await t.deps.db.query<{ id: string; label: string }>("SELECT id, label FROM restaurant_tables WHERE restaurant_id = $1", [r.id]))
        .sort((a, b) => Number(a.label) - Number(b.label))
        .map((x) => x.id)
    return { ...t, clock, cookies, r, tables }
}

let seq = 0

/** An order awaiting payment at table `table` (1-based), one share per amount. */
async function makeOrder(t: Ctx, table: number, shares: { amount: number; label?: string }[]) {
    const orderId = `o_money${++seq}`
    const token = newToken()
    const total = shares.reduce((s, x) => s + x.amount, 0)
    await t.deps.db.query(
        `INSERT INTO orders (id, restaurant_id, table_id, guests, payment_mode, status, subtotal, total, gst_rate_bps, share_token, invoice_token, created_at, payout_wallet)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_payment', $6, $6, 500, $7, $8, $9, $10)`,
        [orderId, t.r.id, t.tables[table - 1], shares.length, shares.length > 1 ? "split" : "one_pays", total, token, newToken(), t.clock.t, OWNER]
    )
    const ids: { id: string; orderRef: Hex }[] = []
    for (const [i, s] of shares.entries()) {
        const id = `s_money${++seq}`
        const { orderRef, secret } = newOrderRef(orderId, id)
        await t.deps.db.query(
            "INSERT INTO order_shares (id, order_id, guest, label, amount, status, order_ref, secret) VALUES ($1, $2, $3, $4, $5, 'owed', $6, $7)",
            [id, orderId, i + 1, s.label ?? `Guest ${i + 1}`, s.amount, orderRef, secret]
        )
        ids.push({ id, orderRef })
    }
    return { orderId, token, shares: ids }
}

/** Settles one transaction through the real pay route; `payer` makes it public. */
async function pay(t: Ctx, order: { token: string }, share: { id: string; orderRef: Hex }, amount: number, payer?: Wallet) {
    const h = txHash()
    t.chain.verifyResult = paidOnChain({ txHash: h, amount, payer, orderRef: share.orderRef as Hash, recipient: OWNER })
    const res = await json<SettleResult>(t.call("POST", `/api/pay/order/${share.id}/settle?t=${order.token}`, { body: { txHash: h } }))
    return { h, res }
}

const money = (t: Ctx, cookie = t.cookies.OWNER) => json<MoneySummary>(t.call("GET", `/api/restaurants/${t.r.id}/money`, { cookie }))
const log = (t: Ctx, query = "") => json<MoneyPaymentPage>(t.call("GET", `/api/restaurants/${t.r.id}/money/payments${query}`, { cookie: t.cookies.OWNER }))

let t: Ctx
beforeEach(async () => {
    t = await setup()
})

describe("who can read the money view", () => {
    it("is the owner only; everyone else gets the same 404 as a restaurant that doesn't exist", async () => {
        const order = await makeOrder(t, 1, [{ amount: 5 * U }])
        await pay(t, order, order.shares[0]!, 5 * U, GUEST)
        const pid = (await log(t)).payments[0]!.id
        const paths = [
            ["GET", "/money"],
            ["GET", "/money/payments"],
            ["GET", "/money/payments.csv"],
            ["GET", "/money/invoices"],
            ["POST", `/money/payments/${pid}/recheck`]
        ] as const
        const missing = await (await t.call("GET", "/api/restaurants/r_nope/money", { cookie: t.cookies.OWNER })).json()
        for (const [method, p] of paths) {
            expect((await t.call(method, `/api/restaurants/${t.r.id}${p}`)).status, `anonymous ${p}`).toBe(401)
            for (const who of ["MANAGER", "CHEF", "WAITER", "GUEST", "OUTSIDER"]) {
                const res = await t.call(method, `/api/restaurants/${t.r.id}${p}`, { cookie: t.cookies[who] })
                expect(res.status, `${who} ${method} ${p}`).toBe(404)
                expect(await res.json()).toEqual(missing)
            }
        }
        expect(missing).toEqual({ error: "No restaurant with that id." })
        t.chain.verifyResult = paidOnChain({ txHash: (await log(t)).payments[0]!.proof!.txHash, amount: 5 * U, payer: GUEST })
        for (const [method, p] of paths) expect((await t.call(method, `/api/restaurants/${t.r.id}${p}`, { cookie: t.cookies.OWNER })).status, p).toBe(200)
    })

    it("needs the x-fairpay header for the re-check", async () => {
        const order = await makeOrder(t, 1, [{ amount: 5 * U }])
        await pay(t, order, order.shares[0]!, 5 * U, GUEST)
        const pid = (await log(t)).payments[0]!.id
        const res = await t.app.request(`/api/restaurants/${t.r.id}/money/payments/${pid}/recheck`, { method: "POST", headers: { cookie: t.cookies.OWNER } })
        expect(res.status).toBe(403)
    })
})

describe("totals and tips", () => {
    it("counts today, the last 7 days and all time in India time, split by kind, with tips apart", async () => {
        // 8 days ago: 3 USDC public. Outside the week.
        t.clock.t = T0 - 8 * DAY
        const old = await makeOrder(t, 1, [{ amount: 3 * U }])
        await pay(t, old, old.shares[0]!, 3 * U, GUEST)
        // Yesterday at 23:30 India time: 7 USDC public. In the week, not today.
        t.clock.t = startOfDayIst(T0) - 30 * 60_000
        const yesterday = await makeOrder(t, 2, [{ amount: 7 * U }])
        await pay(t, yesterday, yesterday.shares[0]!, 7 * U, GUEST)
        // Today: 12.60 USDC paid with three confidential notes of 5; the last pays a 2.40 tip.
        t.clock.t = T0
        const today = await makeOrder(t, 3, [{ amount: 12_600_000 }])
        for (let i = 0; i < 3; i++) expect((await pay(t, today, today.shares[0]!, DENOMINATION)).res.status).toBe("credited")

        const m = await money(t)
        expect(m.totals.today).toEqual({ received: 15 * U, public: 0, private: 15 * U, tips: 2_400_000, count: 3 })
        expect(m.totals.week).toEqual({ received: 22 * U, public: 7 * U, private: 15 * U, tips: 2_400_000, count: 4 })
        expect(m.totals.all).toEqual({ received: 25 * U, public: 10 * U, private: 15 * U, tips: 2_400_000, count: 5 })
        expect(m.payout).toEqual({ wallet: OWNER, privatePayments: true })

        // The tip sits on the note that finished the share, not on the earlier ones.
        const rows = (await log(t)).payments
        expect(rows.map((p) => p.tip)).toEqual([2_400_000, 0, 0, 0, 0])
        expect(rows.map((p) => p.amount)).toEqual([5 * U, 5 * U, 5 * U, 7 * U, 3 * U])
    })

    it("is all zeros for a restaurant with no payments, and says when the allowlist couldn't be read", async () => {
        t.chain.isMerchant = async () => {
            throw new Error("rpc down")
        }
        const m = await money(t)
        const zero = { received: 0, public: 0, private: 0, tips: 0, count: 0 }
        expect(m.totals).toEqual({ today: zero, week: zero, all: zero })
        expect(m.payout.privatePayments).toBeNull()
        expect(m.attention).toEqual([])
    })

    it("startOfDayIst is midnight in India", () => {
        expect(startOfDayIst(T0)).toBe(Date.parse("2026-10-31T00:00:00+05:30"))
        expect(startOfDayIst(Date.parse("2026-10-31T00:00:00+05:30"))).toBe(Date.parse("2026-10-31T00:00:00+05:30"))
        expect(startOfDayIst(Date.parse("2026-10-30T23:59:59+05:30"))).toBe(Date.parse("2026-10-30T00:00:00+05:30"))
    })
})

describe("payment log", () => {
    it("lists newest first with the order, table, share and proof", async () => {
        const order = await makeOrder(t, 4, [{ amount: 6 * U, label: "Ravi" }])
        const { h } = await pay(t, order, order.shares[0]!, 6 * U, GUEST)
        const [p] = (await log(t)).payments
        expect(p).toEqual<MoneyPayment>({
            id: expect.any(Number),
            at: T0,
            kind: "public",
            amount: 6 * U,
            tip: 0,
            order: { id: order.orderId, invoiceNo: expect.stringMatching(/^SR\/2026-27\/000001$/), table: "4" },
            share: "Ravi",
            payer: GUEST,
            recipient: OWNER,
            proof: { chainId: 10143, txHash: h, logIndex: 0, blockNumber: 100, orderRef: order.shares[0]!.orderRef }
        })
    })

    it("pages with a cursor, without repeats or gaps", async () => {
        for (let i = 0; i < 5; i++) {
            const o = await makeOrder(t, (i % 6) + 1, [{ amount: (i + 1) * U }])
            await pay(t, o, o.shares[0]!, (i + 1) * U, GUEST)
            t.clock.t += 1000
        }
        const seen: number[] = []
        let next: string | null = null
        let pages = 0
        do {
            const page: MoneyPaymentPage = await log(t, `?limit=2${next ? `&before=${next}` : ""}`)
            expect(page.payments.length).toBeLessThanOrEqual(2)
            seen.push(...page.payments.map((p) => p.amount))
            next = page.next
            pages++
        } while (next)
        expect(pages).toBe(3)
        expect(seen).toEqual([5 * U, 4 * U, 3 * U, 2 * U, 1 * U])
        // A full last page has no next.
        expect((await log(t, "?limit=5")).next).toBeNull()
        for (const bad of ["?limit=0", "?limit=101", "?limit=x", "?before=0", "?before=abc", "?before=-1"]) {
            expect((await t.call("GET", `/api/restaurants/${t.r.id}/money/payments${bad}`, { cookie: t.cookies.OWNER })).status, bad).toBe(400)
        }
    })

    it("shows only this restaurant's payments", async () => {
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Other Place", state: "Goa" } }), 201)
        await t.deps.db.query("INSERT INTO restaurant_tables (id, restaurant_id, label, seats, status, updated_at) VALUES ('t_other', $1, '1', 2, 'available', $2)", [other.id, T0])
        const mine = await makeOrder(t, 1, [{ amount: 2 * U }])
        await pay(t, mine, mine.shares[0]!, 2 * U, GUEST)
        const theirs = await makeOrder({ ...t, r: other, tables: ["t_other"] }, 1, [{ amount: 9 * U }])
        await t.deps.db.query("UPDATE orders SET payout_wallet = $2 WHERE id = $1", [theirs.orderId, OUTSIDER])
        const h = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: h, amount: 9 * U, payer: GUEST, orderRef: theirs.shares[0]!.orderRef as Hash })
        await json(t.call("POST", `/api/pay/order/${theirs.shares[0]!.id}/settle?t=${theirs.token}`, { body: { txHash: h } }))
        expect((await log(t)).payments.map((p) => p.amount)).toEqual([2 * U])
        expect((await money(t)).totals.all.received).toBe(2 * U)
    })
})

describe("privacy", () => {
    it("never shows who paid confidentially, nor the seat, anywhere the owner reads", async () => {
        const order = await makeOrder(t, 1, [{ amount: 5 * U, label: "Asha" }])
        await pay(t, order, order.shares[0]!, DENOMINATION)
        const rows = (await log(t)).payments
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ kind: "private", share: null, payer: null, amount: 5 * U })
        // The owner's own receipt: the transaction FairPool sent to their wallet.
        expect(rows[0]!.proof?.txHash).toMatch(/^0x[0-9a-f]{64}$/)

        t.chain.verifyResult = paidOnChain({ txHash: rows[0]!.proof!.txHash, amount: DENOMINATION })
        const bodies = [
            JSON.stringify(await money(t)),
            JSON.stringify(rows),
            await (await t.call("GET", `/api/restaurants/${t.r.id}/money/payments.csv`, { cookie: t.cookies.OWNER })).text(),
            JSON.stringify(await json(t.call("GET", `/api/restaurants/${t.r.id}/money/invoices`, { cookie: t.cookies.OWNER }))),
            JSON.stringify(await json(t.call("POST", `/api/restaurants/${t.r.id}/money/payments/${rows[0]!.id}/recheck`, { cookie: t.cookies.OWNER })))
        ]
        for (const b of bodies) {
            expect(b).not.toContain("Asha")
            // The stored payer of a confidential payment is the pool; it is never returned as one.
            expect(b.toLowerCase()).not.toContain(POOL)
        }
    })

    it("withholds every transaction of a share paid partly in public and partly confidentially", async () => {
        const order = await makeOrder(t, 1, [{ amount: 8 * U, label: "Meera" }])
        await pay(t, order, order.shares[0]!, DENOMINATION)
        await pay(t, order, order.shares[0]!, 3 * U, GUEST)
        const rows = (await log(t)).payments
        expect(rows.map((p) => p.kind)).toEqual(["public", "private"])
        for (const p of rows) {
            expect(p.proof).toBeNull()
            expect(p.payer).toBeNull()
        }
        // The public part keeps its seat label, as on the invoice.
        expect(rows[0]!.share).toBe("Meera")
        expect(rows[1]!.share).toBeNull()
        const csv = await (await t.call("GET", `/api/restaurants/${t.r.id}/money/payments.csv`, { cookie: t.cookies.OWNER })).text()
        expect(JSON.stringify(rows) + csv).not.toContain(GUEST)
        const hashes = await t.deps.db.query<{ tx_hash: string }>("SELECT tx_hash FROM payments")
        for (const { tx_hash } of hashes) expect(JSON.stringify(rows) + csv).not.toContain(tx_hash)

        // The re-check still works, and says only whether the chain agrees.
        const all = await t.deps.db.query<{ id: number; tx_hash: Hash; kind: string }>("SELECT id, tx_hash, kind FROM payments ORDER BY id")
        t.chain.verifyResult = paidOnChain({ txHash: all[1]!.tx_hash, amount: 3 * U, payer: GUEST })
        const r = await t.call("POST", `/api/restaurants/${t.r.id}/money/payments/${all[1]!.id}/recheck`, { cookie: t.cookies.OWNER })
        const text = await r.text()
        expect(JSON.parse(text)).toEqual({ status: "verified", reason: null, checkedAt: T0 })
        expect(text).not.toContain(GUEST)
    })
})

describe("needs attention", () => {
    it("lists money that arrived but wasn't credited, with its transaction", async () => {
        // A second public payment for a share that is already paid.
        const order = await makeOrder(t, 1, [{ amount: 4 * U }])
        await pay(t, order, order.shares[0]!, 4 * U, GUEST)
        const late = await pay(t, order, order.shares[0]!, 4 * U, OUTSIDER)
        expect(late.res.status).toBe("rejected")
        // A confidential note for an order that was cancelled.
        t.clock.t += 1000
        const cancelled = await makeOrder(t, 2, [{ amount: 5 * U }])
        await t.deps.db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [cancelled.orderId])
        const refund = await pay(t, cancelled, cancelled.shares[0]!, DENOMINATION)
        expect(refund.res.status).toBe("rejected")
        // Text someone else could put in the owner's feed (a bill title) doesn't count.
        await t.deps.db.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, 'order_update', 'Payment not counted: 1.00 USDC', 'fake', '/bills/b_x', $2)", [
            OWNER,
            T0
        ])

        const { attention } = await money(t)
        expect(attention).toHaveLength(2)
        expect(attention[0]).toMatchObject({ kind: "refund", title: "Refund needed: 5.00 USDC", txHash: refund.h })
        expect(attention[0]!.detail).not.toMatch(/0x[0-9a-f]{40}(?![0-9a-f])/)
        expect(attention[1]).toMatchObject({ kind: "not_counted", title: "Payment not counted: 4.00 USDC", txHash: late.h })
        // Uncredited money is not in the totals or the log.
        expect((await money(t)).totals.all.received).toBe(4 * U)
        expect((await log(t)).payments).toHaveLength(1)
    })
})

describe("invoices", () => {
    it("lists issued invoices newest first, in pages, with their read-only link", async () => {
        for (let i = 0; i < 3; i++) {
            const o = await makeOrder(t, i + 1, [{ amount: (i + 1) * U }])
            await pay(t, o, o.shares[0]!, (i + 1) * U, GUEST)
        }
        // An unpaid order has no invoice yet.
        await makeOrder(t, 5, [{ amount: 9 * U }])
        const first = await json<MoneyInvoicePage>(t.call("GET", `/api/restaurants/${t.r.id}/money/invoices?limit=2`, { cookie: t.cookies.OWNER }))
        expect(first.invoices.map((i) => i.invoiceNo)).toEqual(["SR/2026-27/000003", "SR/2026-27/000002"])
        expect(first.invoices[0]).toMatchObject({ table: "3", total: 3 * U, kind: "tax_invoice", issuedAt: T0 })
        expect(first.invoices[0]!.url).toMatch(/^http:\/\/localhost:5174\/i\/[A-Za-z0-9_-]{16,}$/)
        // The link opens the invoice; it is not the share token, which can pay.
        const token = first.invoices[0]!.url.split("/i/")[1]!
        expect((await t.call("GET", `/api/i/${token}`)).status).toBe(200)
        const shareTokens = await t.deps.db.query<{ share_token: string }>("SELECT share_token FROM orders")
        expect(shareTokens.map((s) => s.share_token)).not.toContain(token)
        const second = await json<MoneyInvoicePage>(
            t.call("GET", `/api/restaurants/${t.r.id}/money/invoices?limit=2&before=${encodeURIComponent(first.next!)}`, { cookie: t.cookies.OWNER })
        )
        expect(second.invoices.map((i) => i.invoiceNo)).toEqual(["SR/2026-27/000001"])
        expect(second.next).toBeNull()
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/money/invoices?before=nope`, { cookie: t.cookies.OWNER })).status).toBe(400)
    })
})

describe("CSV export", () => {
    it("downloads the log with spreadsheet formulas defused", async () => {
        const order = await makeOrder(t, 1, [{ amount: 2_500_000, label: '=HYPERLINK("x")' }])
        const { h } = await pay(t, order, order.shares[0]!, 2_500_000, GUEST)
        const res = await t.call("GET", `/api/restaurants/${t.r.id}/money/payments.csv`, { cookie: t.cookies.OWNER })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toMatch(/^text\/csv/)
        expect(res.headers.get("content-disposition")).toBe('attachment; filename="spice-route-payments-2026-10-31.csv"')
        const [head, row] = (await res.text()).trim().split("\r\n")
        expect(head).toBe("verified_at_utc,order,invoice,table,share,kind,amount_usdc,tip_usdc,payer,recipient,chain_id,tx_hash,log_index,block")
        expect(row).toBe(`2026-10-31T06:30:00.000Z,${order.orderId},SR/2026-27/000001,1,"'=HYPERLINK(""x"")",public,2.500000,0.000000,${GUEST},${OWNER},10143,${h},0,100`)
    })
})

describe("re-check on-chain", () => {
    async function onePayment(payer?: Wallet) {
        const order = await makeOrder(t, 1, [{ amount: 5 * U }])
        const { h } = await pay(t, order, order.shares[0]!, 5 * U, payer)
        const p = (await log(t)).payments[0]!
        return { order, h, p, path: `/api/restaurants/${t.r.id}/money/payments/${p.id}/recheck` }
    }
    const recheck = (path: string, status = 200) => json<RecheckResult>(t.call("POST", path, { cookie: t.cookies.OWNER }), status)

    it("runs the settle check again on the stored payment", async () => {
        const { order, h, path } = await onePayment(GUEST)
        t.chain.calls.length = 0
        t.chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: GUEST, orderRef: order.shares[0]!.orderRef as Hash, recipient: OWNER })
        expect(await recheck(path)).toEqual({ status: "verified", reason: null, checkedAt: T0 })
        expect(t.chain.calls).toEqual([{ txHash: h, orderRef: order.shares[0]!.orderRef, merchant: expect.stringMatching(/^0x1111/i), amount: BigInt(5 * U), expectedPayer: expect.stringMatching(/^0x5555/i) }])
        expect(t.chain.calls[0]!.merchant.toLowerCase()).toBe(OWNER)
        expect(t.chain.calls[0]!.expectedPayer!.toLowerCase()).toBe(GUEST)
    })

    it("doesn't pin a payer for a confidential payment", async () => {
        const { h, path } = await onePayment()
        t.chain.calls.length = 0
        t.chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U })
        expect((await recheck(path)).status).toBe("verified")
        expect(t.chain.calls[0]!.expectedPayer).toBeUndefined()
    })

    it("maps pending, rejected, a changed transaction and errors", async () => {
        const { path } = await onePayment(GUEST)
        t.chain.verifyResult = { status: "pending", confirmations: 1n }
        expect(await recheck(path)).toMatchObject({ status: "pending", reason: expect.stringContaining("1 so far") })
        t.chain.verifyResult = { status: "pending", confirmations: 0n }
        expect(await recheck(path)).toMatchObject({ status: "pending", reason: expect.stringContaining("block was replaced") })
        t.chain.verifyResult = { status: "rejected", reason: "transaction reverted" }
        expect(await recheck(path)).toMatchObject({ status: "rejected", reason: "The chain doesn't confirm this payment: transaction reverted." })
        t.chain.verifyResult = async () => {
            throw new Error("rpc down")
        }
        expect((await t.call("POST", path, { cookie: t.cookies.OWNER })).status).toBe(502)
        t.chain.verifyResult = async () => {
            throw new FairPayError("INVALID_INPUT", "bad")
        }
        expect((await t.call("POST", path, { cookie: t.cookies.OWNER })).status).toBe(400)
    })

    it("recheckOutcome compares the kind, log index and block with what was stored", () => {
        const stored = { kind: "public" as const, logIndex: 2, blockNumber: 100 }
        const payment = { chainId: 10143, txHash: txHash(), logIndex: 2, blockNumber: 100n, payer: GUEST, amount: 1n, kind: "public" as const }
        expect(recheckOutcome(stored, { status: "verified", payment })).toEqual({ status: "verified", reason: null })
        expect(recheckOutcome(stored, { status: "verified", payment: { ...payment, logIndex: 3 } }).status).toBe("rejected")
        expect(recheckOutcome(stored, { status: "verified", payment: { ...payment, kind: "private" } }).status).toBe("rejected")
        expect(recheckOutcome(stored, { status: "verified", payment: { ...payment, blockNumber: 101n } })).toEqual({
            status: "verified",
            reason: "Confirmed, now in block 101 (recorded in block 100)."
        })
    })

    it("404s a payment of another restaurant or one that doesn't exist, and is rate limited", async () => {
        const { h, path } = await onePayment(GUEST)
        expect((await t.call("POST", `/api/restaurants/${t.r.id}/money/payments/999999/recheck`, { cookie: t.cookies.OWNER })).status).toBe(404)
        expect((await t.call("POST", `/api/restaurants/${t.r.id}/money/payments/abc/recheck`, { cookie: t.cookies.OWNER })).status).toBe(404)
        const other = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: t.cookies.OUTSIDER, body: { name: "Other Place", state: "Goa" } }), 201)
        expect((await t.call("POST", path.replace(t.r.id, other.id), { cookie: t.cookies.OUTSIDER })).status).toBe(404)

        t.chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: GUEST })
        const statuses: number[] = []
        for (let i = 0; i < 22; i++) statuses.push((await t.call("POST", path, { cookie: t.cookies.OWNER, headers: { "x-test-ip": "10.0.0.9" } })).status)
        expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(20)
        expect(statuses.at(-1)).toBe(429)
    })
})
