import { beforeEach, describe, expect, it } from "vitest"
import { FairPayError } from "@fairpay/sdk"
import type { Hash } from "viem"
import type { PayTarget, SettleResult, Wallet } from "../shared/types.js"
import type { Db } from "../server/context.js"
import { newOrderRef, newToken } from "../server/ids.js"
import { DENOMINATION, fakeChain, makeTestApp, paidOnChain, txHash, type FakeChain, type TestApp } from "./helpers.js"

const U = 1_000_000
const ALICE = "0x1111111111111111111111111111111111111111" as Wallet // bill creator
const BOB = "0x2222222222222222222222222222222222222222" as Wallet // participant
const CAROL = "0x3333333333333333333333333333333333333333" as Wallet // stranger
const OWNER = "0x4444444444444444444444444444444444444444" as Wallet // restaurant owner
const PAYOUT = "0x5555555555555555555555555555555555555555" as Wallet // allowlisted merchant

async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T
}

let seq = 0
const uid = (p: string) => `${p}_test${++seq}`

async function makeBill(db: Db, people: { wallet: Wallet | null; name: string; amount: number; status?: "owed" | "covered" }[]) {
    const billId = uid("b")
    const token = newToken()
    const total = people.reduce((s, p) => s + p.amount, 0)
    await db.query(
        `INSERT INTO bills (id, creator, recipient, title, total, split_type, status, share_token, created_at)
         VALUES ($1, $2, $2, 'Dinner', $3, 'fixed', 'open', $4, $5)`,
        [billId, ALICE, total, token, Date.now()]
    )
    const ids: { id: string; orderRef: string }[] = []
    for (const p of people) {
        const id = uid("p")
        const { orderRef, secret } = newOrderRef(billId, id)
        await db.query(
            `INSERT INTO bill_participants (id, bill_id, wallet, display_name, amount, status, order_ref, secret)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, billId, p.wallet, p.name, p.amount, p.status ?? "owed", orderRef, secret]
        )
        ids.push({ id, orderRef })
    }
    return { billId, token, participants: ids }
}

async function makeOrder(db: Db, shares: number[], opts: { placedBy?: Wallet } = {}) {
    const now = Date.now()
    const rid = uid("r")
    await db.query(
        `INSERT INTO restaurants (id, slug, name, state, owner_wallet, payout_wallet, invoice_prefix, created_at)
         VALUES ($1, $2, 'Saffron Test', 'Karnataka', $3, $4, 'SAF', $5)`,
        [rid, rid.replace("_", "-"), OWNER, PAYOUT, now]
    )
    const tableId = uid("t")
    await db.query("INSERT INTO restaurant_tables (id, restaurant_id, label, seats, status, updated_at) VALUES ($1, $2, '4', 4, 'occupied', $3)", [
        tableId,
        rid,
        now
    ])
    await db.query("INSERT INTO menu_items (id, restaurant_id, name, category, price, prep_minutes) VALUES ($1, $2, 'Dal', 'Mains', 10000, 20)", [
        `${rid}-dal`,
        rid
    ])
    const orderId = uid("o")
    const token = newToken()
    const total = shares.reduce((s, x) => s + x, 0)
    await db.query(
        `INSERT INTO orders (id, restaurant_id, table_id, placed_by, guests, payment_mode, status, subtotal, total, gst_rate_bps, share_token, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $7, 500, $8, $9)`,
        [orderId, rid, tableId, opts.placedBy ?? null, shares.length, shares.length > 1 ? "split" : "one_pays", total, token, now]
    )
    await db.query("UPDATE restaurant_tables SET order_id = $1 WHERE id = $2", [orderId, tableId])
    await db.query("INSERT INTO order_items (order_id, item_id, name, unit_price, qty, guest, sac) VALUES ($1, $2, 'Dal', 10000, 1, 1, '996331')", [
        orderId,
        `${rid}-dal`
    ])
    const ids: { id: string; orderRef: string }[] = []
    for (const [i, amount] of shares.entries()) {
        const id = uid("s")
        const { orderRef, secret } = newOrderRef(orderId, id)
        await db.query(
            `INSERT INTO order_shares (id, order_id, guest, label, amount, status, order_ref, secret) VALUES ($1, $2, $3, $4, $5, 'owed', $6, $7)`,
            [id, orderId, i + 1, `Guest ${i + 1}`, amount, orderRef, secret]
        )
        ids.push({ id, orderRef })
    }
    return { restaurantId: rid, orderId, token, shares: ids }
}

describe("bill shares", () => {
    let t: TestApp
    let chain: FakeChain
    let alice: string
    let bob: string

    beforeEach(async () => {
        chain = fakeChain()
        t = await makeTestApp({ chain })
        alice = await t.signIn(ALICE)
        bob = await t.signIn(BOB)
    })

    it("shows the share with public-only payment to a friend", async () => {
        const { participants } = await makeBill(t.deps.db, [
            { wallet: ALICE, name: "Alice", amount: 10 * U, status: "covered" },
            { wallet: BOB, name: "Bob", amount: 15 * U }
        ])
        const res = await t.call("GET", `/api/pay/bill/${participants[1]!.id}`, { cookie: bob })
        expect(res.status).toBe(200)
        const target = await json<PayTarget>(res)
        expect(target).toMatchObject({ kind: "bill", recipient: ALICE, amount: 15 * U, tip: 0, paid: 0, due: 15 * U, status: "owed", expectedPayer: BOB, payerLocked: true })
        expect(target.orderRef).toBe(participants[1]!.orderRef)
        expect(target.private).toEqual({ possible: false, reason: expect.stringMatching(/verified businesses/) })
        // The secret never leaves the server.
        expect(JSON.stringify(target)).not.toMatch(/secret/)
    })

    it("shows who a share is bound to only to that wallet, the creator and the recipient", async () => {
        const { participants, token } = await makeBill(t.deps.db, [
            { wallet: BOB, name: "Bob", amount: 5 * U },
            { wallet: null, name: "Dee", amount: 5 * U }
        ])
        const bound = `/api/pay/bill/${participants[0]!.id}`
        const get = async (path: string, cookie?: string) => json<PayTarget>(await t.call("GET", path, { cookie }))
        expect(await get(bound, bob)).toMatchObject({ expectedPayer: BOB, payerLocked: true })
        expect(await get(bound, alice)).toMatchObject({ expectedPayer: BOB, payerLocked: true })
        // A link holder, signed out or signed in as someone else, learns only that it is bound.
        expect(await get(`${bound}?t=${token}`)).toMatchObject({ expectedPayer: null, payerLocked: true })
        expect(await get(`${bound}?t=${token}`, await t.signIn(CAROL))).toMatchObject({ expectedPayer: null, payerLocked: true })
        // A name-only seat isn't bound to anyone.
        expect(await get(`/api/pay/bill/${participants[1]!.id}?t=${token}`)).toMatchObject({ expectedPayer: null, payerLocked: false })

        // The settle answer follows the same rule.
        const h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: BOB })
        const r = await json<SettleResult>(await t.call("POST", `${bound}/settle?t=${token}`, { body: { txHash: h } }))
        if (r.status !== "credited") throw new Error(JSON.stringify(r))
        expect(r.target).toMatchObject({ expectedPayer: null, payerLocked: true })
        // The chain check still used the bound wallet.
        expect(chain.calls[0]!.expectedPayer!.toLowerCase()).toBe(BOB)
    })

    it("gives a share's orderRef only to someone who may pay it now", async () => {
        const { participants, token } = await makeBill(t.deps.db, [
            { wallet: BOB, name: "Bob", amount: 5 * U },
            { wallet: null, name: "Dee", amount: 5 * U },
            { wallet: ALICE, name: "Alice", amount: 5 * U, status: "covered" }
        ])
        const [bobSeat, deeSeat, aliceSeat] = participants
        const ref = async (id: string, opts: { cookie?: string; t?: string } = {}) =>
            (await json<PayTarget>(await t.call("GET", `/api/pay/bill/${id}${opts.t ? `?t=${opts.t}` : ""}`, { cookie: opts.cookie }))).orderRef
        // A link holder can't collect Bob's reference (and look his wallet up on-chain), nor can the
        // creator, who doesn't pay it; Bob can.
        expect(await ref(bobSeat!.id, { t: token })).toBeNull()
        expect(await ref(bobSeat!.id, { t: token, cookie: await t.signIn(CAROL) })).toBeNull()
        expect(await ref(bobSeat!.id, { cookie: alice })).toBeNull()
        expect(await ref(bobSeat!.id, { cookie: bob })).toBe(bobSeat!.orderRef)
        // An unbound seat can be paid by whoever holds the link.
        expect(await ref(deeSeat!.id, { t: token })).toBe(deeSeat!.orderRef)
        // Nothing to pay, nothing to hand out.
        expect(await ref(aliceSeat!.id, { cookie: alice })).toBeNull()
        await t.deps.db.query("UPDATE bill_participants SET paid = amount, status = 'paid' WHERE id = $1", [deeSeat!.id])
        expect(await ref(deeSeat!.id, { t: token })).toBeNull()
    })

    it("tells the recipient about a payment that can't be credited: paid twice, closed bill, wrong wallet", async () => {
        const { billId, participants, token } = await makeBill(t.deps.db, [
            { wallet: BOB, name: "Bob", amount: 5 * U },
            { wallet: null, name: "Dee", amount: 5 * U }
        ])
        const [bobSeat, deeSeat] = participants
        const settle = (id: string, h: Hash) => t.call("POST", `/api/pay/bill/${id}/settle?t=${token}`, { body: { txHash: h } })
        const notes = () => t.deps.db.query<{ wallet: string; kind: string; title: string; detail: string }>("SELECT wallet, kind, title, detail FROM activity WHERE title LIKE 'Payment not counted%' ORDER BY id")

        // Dee's share is paid from two tabs: the second payment is real but can't be credited.
        const first = txHash()
        chain.verifyResult = paidOnChain({ txHash: first, amount: 5 * U, payer: CAROL })
        expect((await json<SettleResult>(await settle(deeSeat!.id, first))).status).toBe("credited")
        const second = txHash()
        chain.verifyResult = paidOnChain({ txHash: second, amount: 5 * U, payer: CAROL })
        const twice = await json<SettleResult>(await settle(deeSeat!.id, second))
        expect(twice.status).toBe("rejected")
        if (twice.status === "rejected") expect(twice.reason).toMatch(/already paid.*wasn't counted/)
        // Asking again (the browser retrying) doesn't repeat the note.
        await settle(deeSeat!.id, second)

        // Someone else's wallet pays Bob's seat.
        const stray = txHash()
        chain.verifyResult = paidOnChain({ txHash: stray, amount: 5 * U, payer: CAROL })
        expect((await json<SettleResult>(await settle(bobSeat!.id, stray))).status).toBe("rejected")

        // Bob pays after the bill was cancelled.
        await t.deps.db.query("UPDATE bills SET status = 'cancelled' WHERE id = $1", [billId])
        const late = txHash()
        chain.verifyResult = paidOnChain({ txHash: late, amount: 5 * U, payer: BOB })
        expect((await json<SettleResult>(await settle(bobSeat!.id, late))).status).toBe("rejected")

        // A hash that isn't a payment for this share says nothing.
        chain.verifyResult = { status: "pending", confirmations: 0n }
        expect((await json<SettleResult>(await settle(bobSeat!.id, txHash()))).status).toBe("rejected")

        const rows = await notes()
        expect(rows.map((r) => [r.wallet, r.kind])).toEqual([
            [ALICE, "payment_received"],
            [ALICE, "payment_received"],
            [ALICE, "payment_received"]
        ])
        expect(rows[0]!.detail).toContain(second)
        expect(rows[0]!.detail).toMatch(/already paid/)
        expect(rows[1]!.detail).toContain(stray)
        expect(rows[1]!.detail).toMatch(/different wallet/)
        expect(rows[2]!.detail).toContain(late)
        expect(rows[2]!.detail).toMatch(/bill is cancelled/)
        // Nothing extra was credited.
        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(1)
    })

    it("only lets the creator, participants and link holders see a share", async () => {
        const { participants, token } = await makeBill(t.deps.db, [{ wallet: BOB, name: "Bob", amount: 5 * U }])
        const path = `/api/pay/bill/${participants[0]!.id}`
        expect((await t.call("GET", path, { cookie: alice })).status).toBe(200)
        expect((await t.call("GET", path, { cookie: await t.signIn(CAROL) })).status).toBe(404)
        expect((await t.call("GET", path)).status).toBe(404)
        expect((await t.call("GET", `${path}?t=${token}`)).status).toBe(200)
        expect((await t.call("GET", `${path}?t=${token}x`)).status).toBe(404)
        expect((await t.call("GET", "/api/pay/bill/p_doesnotexist", { cookie: alice })).status).toBe(404)
        expect((await t.call("GET", `/api/pay/nope/${participants[0]!.id}`, { cookie: alice })).status).toBe(404)
    })

    it("credits a verified payment once, settles the bill and writes activity", async () => {
        const { billId, participants } = await makeBill(t.deps.db, [
            { wallet: ALICE, name: "Alice", amount: 10 * U, status: "covered" },
            { wallet: BOB, name: "Bob", amount: 15 * U }
        ])
        const share = participants[1]!
        const h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 15 * U, payer: BOB, orderRef: share.orderRef as Hash, recipient: ALICE })

        const res = await t.call("POST", `/api/pay/bill/${share.id}/settle`, { cookie: bob, body: { txHash: h } })
        expect(res.status).toBe(200)
        const r = await json<SettleResult>(res)
        expect(r.status).toBe("credited")
        if (r.status === "credited") expect(r.target).toMatchObject({ paid: 15 * U, due: 0, status: "paid" })

        // What was checked on-chain: this share's reference, recipient, amount and payer.
        expect(chain.calls[0]).toMatchObject({ amount: 15n * BigInt(U) })
        expect(chain.calls[0]!.orderRef).toBe(share.orderRef)
        expect(chain.calls[0]!.merchant.toLowerCase()).toBe(ALICE)
        expect(chain.calls[0]!.expectedPayer!.toLowerCase()).toBe(BOB)

        const bill = await t.deps.db.one<{ status: string; settled_at: number | null }>("SELECT status, settled_at FROM bills WHERE id = $1", [billId])
        expect(bill!.status).toBe("settled")
        expect(bill!.settled_at).toBeGreaterThan(0)

        // Replaying the same transaction is harmless: credited, but counted once.
        const again = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${share.id}/settle`, { cookie: bob, body: { txHash: h.toUpperCase().replace("0X", "0x") } }))
        expect(again.status).toBe("credited")
        const payments = await t.deps.db.query<{ amount: number; kind: string; payer: string }>("SELECT amount, kind, payer FROM payments")
        expect(payments).toEqual([{ amount: 15 * U, kind: "public", payer: BOB }])
        const p = await t.deps.db.one<{ paid: number; status: string }>("SELECT paid, status FROM bill_participants WHERE id = $1", [share.id])
        expect(p).toEqual({ paid: 15 * U, status: "paid" })

        const activity = await t.deps.db.query<{ wallet: string; kind: string; title: string }>("SELECT wallet, kind, title FROM activity ORDER BY id")
        expect(activity.map((a) => [a.wallet, a.kind])).toEqual([
            [ALICE, "payment_received"],
            [BOB, "payment_sent"],
            [ALICE, "bill_settled"]
        ])
        expect(activity[0]!.title).toBe("Bob paid 15.00 USDC")
    })

    it("rejects a wrong amount, a wrong payer and an unconfirmed tx without crediting", async () => {
        const { billId, participants } = await makeBill(t.deps.db, [{ wallet: BOB, name: "Bob", amount: 15 * U }])
        const share = participants[0]!
        const settle = (h: Hash) => t.call("POST", `/api/pay/bill/${share.id}/settle`, { cookie: bob, body: { txHash: h } })

        let h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 14 * U, payer: BOB })
        let r = await json<SettleResult>(await settle(h))
        expect(r.status).toBe("rejected")
        if (r.status === "rejected") expect(r.reason).toMatch(/amount/)

        h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 15 * U, payer: CAROL })
        r = await json<SettleResult>(await settle(h))
        expect(r.status).toBe("rejected")
        if (r.status === "rejected") expect(r.reason).toMatch(/different wallet/)

        chain.verifyResult = { status: "pending", confirmations: 0n }
        const pending = await settle(txHash())
        expect(pending.status).toBe(202)
        expect((await json<SettleResult>(pending)).status).toBe("pending")

        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
        const p = await t.deps.db.one<{ paid: number; status: string }>("SELECT paid, status FROM bill_participants WHERE id = $1", [share.id])
        expect(p).toEqual({ paid: 0, status: "owed" })
        expect((await t.deps.db.one<{ status: string }>("SELECT status FROM bills WHERE id = $1", [billId]))!.status).toBe("open")
    })

    it("validates the settle request", async () => {
        const { participants } = await makeBill(t.deps.db, [{ wallet: BOB, name: "Bob", amount: 15 * U }])
        const path = `/api/pay/bill/${participants[0]!.id}/settle`
        expect((await t.call("POST", path, { cookie: bob, body: { txHash: "0x1234" } })).status).toBe(400)
        const noCsrf = await t.app.request(path, { method: "POST", headers: { cookie: bob }, body: JSON.stringify({ txHash: txHash() }) })
        expect(noCsrf.status).toBe(403)
        expect((await t.call("POST", path, { body: { txHash: txHash() } })).status).toBe(404)
        expect(chain.calls).toHaveLength(0)
    })

    it("has no round-up endpoint any more", async () => {
        const { participants } = await makeBill(t.deps.db, [{ wallet: BOB, name: "Bob", amount: 12 * U }])
        const res = await t.call("POST", `/api/pay/bill/${participants[0]!.id}/round-up`, { cookie: bob })
        expect(res.status).toBe(410)
        expect(await json(res)).toEqual({ error: "Round-up is automatic now: the last private note covers the difference as a tip." })
        expect((await t.call("POST", `/api/pay/order/o_whatever/round-up`)).status).toBe(410)
        const p = await t.deps.db.one<{ tip: number }>("SELECT tip FROM bill_participants WHERE id = $1", [participants[0]!.id])
        expect(p!.tip).toBe(0)
    })

    it("re-checks the bill under lock: a cancel during verification wins", async () => {
        const { billId, participants } = await makeBill(t.deps.db, [{ wallet: BOB, name: "Bob", amount: 5 * U }])
        const h = txHash()
        const paid = paidOnChain({ txHash: h, amount: 5 * U, payer: BOB })
        // The creator cancels while the server is checking the chain.
        chain.verifyResult = async (p) => {
            await t.deps.db.query("UPDATE bills SET status = 'cancelled' WHERE id = $1", [billId])
            return paid(p)
        }
        const r = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${participants[0]!.id}/settle`, { cookie: bob, body: { txHash: h } }))
        expect(r.status).toBe("rejected")
        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
        expect((await t.deps.db.one<{ paid: number }>("SELECT paid FROM bill_participants WHERE id = $1", [participants[0]!.id]))!.paid).toBe(0)
    })

    it("one transfer can't pay two shares", async () => {
        const { participants } = await makeBill(t.deps.db, [
            { wallet: null, name: "Dee", amount: 5 * U },
            { wallet: null, name: "Eve", amount: 5 * U }
        ])
        const h = txHash()
        // A chain that (wrongly) verifies the same log for any reference.
        chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: CAROL })
        const first = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${participants[0]!.id}/settle`, { cookie: alice, body: { txHash: h } }))
        expect(first.status).toBe("credited")
        const second = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${participants[1]!.id}/settle`, { cookie: alice, body: { txHash: h } }))
        expect(second).toEqual({ status: "rejected", reason: "This payment has already been counted." })
        const p = await t.deps.db.one<{ paid: number }>("SELECT paid FROM bill_participants WHERE id = $1", [participants[1]!.id])
        expect(p!.paid).toBe(0)
    })

    it("rejects payments to covered shares and closed bills", async () => {
        const { billId, participants } = await makeBill(t.deps.db, [
            { wallet: ALICE, name: "Alice", amount: 5 * U, status: "covered" },
            { wallet: BOB, name: "Bob", amount: 5 * U }
        ])
        const h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: BOB })
        const covered = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${participants[0]!.id}/settle`, { cookie: alice, body: { txHash: h } }))
        expect(covered.status).toBe("rejected")
        const view = await json<PayTarget>(await t.call("GET", `/api/pay/bill/${participants[0]!.id}`, { cookie: alice }))
        expect(view.due).toBe(0)

        await t.deps.db.query("UPDATE bills SET status = 'cancelled' WHERE id = $1", [billId])
        const closed = await json<SettleResult>(await t.call("POST", `/api/pay/bill/${participants[1]!.id}/settle`, { cookie: bob, body: { txHash: h } }))
        expect(closed.status).toBe("rejected")
        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
        // The chain is still asked, only to tell the recipient about money that arrived anyway.
        const notes = await t.deps.db.query<{ wallet: string }>("SELECT wallet FROM activity WHERE title LIKE 'Payment not counted%'")
        expect(notes.map((n) => n.wallet)).toEqual([ALICE])
    })
})

describe("order shares", () => {
    let t: TestApp
    let chain: FakeChain

    beforeEach(async () => {
        chain = fakeChain({ merchants: [PAYOUT] })
        t = await makeTestApp({ chain })
    })

    it("needs the order's link or staff to view", async () => {
        const { shares, token, restaurantId } = await makeOrder(t.deps.db, [15 * U])
        const path = `/api/pay/order/${shares[0]!.id}`
        expect((await t.call("GET", path)).status).toBe(404)
        expect((await t.call("GET", path, { cookie: await t.signIn(CAROL) })).status).toBe(404)
        expect((await t.call("GET", `${path}?t=${token}`)).status).toBe(200)
        expect((await t.call("GET", path, { cookie: await t.signIn(OWNER) })).status).toBe(200)
        await t.deps.db.query("INSERT INTO restaurant_staff (restaurant_id, wallet, role, display_name, added_at) VALUES ($1, $2, 'waiter', 'W', 1)", [
            restaurantId,
            CAROL
        ])
        expect((await t.call("GET", path, { cookie: await t.signIn(CAROL) })).status).toBe(200)
    })

    it("offers private payment when the payout wallet is allowlisted, with the last note's tip shown", async () => {
        const { shares, token } = await makeOrder(t.deps.db, [15 * U, 12_600_000])
        const whole = await json<PayTarget>(await t.call("GET", `/api/pay/order/${shares[0]!.id}?t=${token}`))
        expect(whole).toMatchObject({ recipient: PAYOUT, recipientName: "Saffron Test", expectedPayer: null, payerLocked: false })
        expect(whole.private).toEqual({ possible: true, notes: 3, tip: 0 })

        // Not whole notes: still possible; nothing is stored until a note arrives.
        const odd = await json<PayTarget>(await t.call("GET", `/api/pay/order/${shares[1]!.id}?t=${token}`))
        expect(odd).toMatchObject({ tip: 0, due: 12_600_000 })
        expect(odd.private).toEqual({ possible: true, notes: 3, tip: 2_400_000 })

        chain.merchants.clear()
        const notListed = await json<PayTarget>(await t.call("GET", `/api/pay/order/${shares[0]!.id}?t=${token}`))
        expect(notListed.private).toEqual({ possible: false, reason: "This restaurant isn't verified for confidential payments yet." })
    })

    it("lets the last private note cover a due that isn't whole notes, as a tip", async () => {
        const { orderId, shares, token } = await makeOrder(t.deps.db, [12_600_000])
        const share = shares[0]!
        const note = async () => {
            const h = txHash()
            chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION, orderRef: share.orderRef as Hash, recipient: PAYOUT })
            const r = await json<SettleResult>(await t.call("POST", `/api/pay/order/${share.id}/settle?t=${token}`, { body: { txHash: h } }))
            if (r.status !== "credited") throw new Error(JSON.stringify(r))
            return r.target
        }
        expect(await note()).toMatchObject({ paid: 5 * U, tip: 0, due: 7_600_000, status: "owed", private: { possible: true, notes: 2, tip: 2_400_000 } })
        expect(await note()).toMatchObject({ paid: 10 * U, tip: 0, due: 2_600_000, status: "owed", private: { possible: true, notes: 1, tip: 2_400_000 } })
        // The last note pays 5.00 against 2.60 due: 2.40 becomes the tip, in the same update.
        expect(await note()).toMatchObject({ amount: 12_600_000, paid: 15 * U, tip: 2_400_000, due: 0, status: "paid" })
        const row = await t.deps.db.one<{ amount: number; tip: number; paid: number; status: string }>("SELECT amount, tip, paid, status FROM order_shares WHERE id = $1", [share.id])
        expect(row).toEqual({ amount: 12_600_000, tip: 2_400_000, paid: 15 * U, status: "paid" })
        // Fully paid: the kitchen starts it at once.
        expect((await t.deps.db.one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]))!.status).toBe("cooking")
        const last =await t.deps.db.one<{ detail: string }>("SELECT detail FROM activity WHERE title = 'Confidential payment received' ORDER BY id DESC LIMIT 1")
        expect(last!.detail).toBe("5.00 USDC for Saffron Test, table 4 (includes a 2.40 USDC tip)")
    })

    it("takes one note for a share smaller than a note, and public payments only for the exact due", async () => {
        const { shares, token } = await makeOrder(t.deps.db, [3 * U, 7 * U])
        const settle = (id: string, h: Hash) => t.call("POST", `/api/pay/order/${id}/settle?t=${token}`, { body: { txHash: h } })

        let h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION, orderRef: shares[0]!.orderRef as Hash })
        let r = await json<SettleResult>(await settle(shares[0]!.id, h))
        if (r.status !== "credited") throw new Error(JSON.stringify(r))
        expect(r.target).toMatchObject({ amount: 3 * U, tip: 2 * U, paid: 5 * U, status: "paid", due: 0 })

        // A public payment of one note's worth is not "a note": it must match the due exactly.
        h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION, payer: CAROL, orderRef: shares[1]!.orderRef as Hash })
        r = await json<SettleResult>(await settle(shares[1]!.id, h))
        expect(r.status).toBe("rejected")
        h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 7 * U, payer: CAROL, orderRef: shares[1]!.orderRef as Hash })
        r = await json<SettleResult>(await settle(shares[1]!.id, h))
        if (r.status !== "credited") throw new Error(JSON.stringify(r))
        expect(r.target).toMatchObject({ paid: 7 * U, tip: 0, status: "paid" })
    })

    it("re-checks the order under lock: a cancel during verification wins and the owner hears about the refund", async () => {
        const { orderId, shares, token } = await makeOrder(t.deps.db, [5 * U])
        const h = txHash()
        const paid = paidOnChain({ txHash: h, amount: 5 * U, payer: CAROL })
        chain.verifyResult = async (p) => {
            await t.deps.db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId])
            return paid(p)
        }
        const path = `/api/pay/order/${shares[0]!.id}/settle?t=${token}`
        expect((await json<SettleResult>(await t.call("POST", path, { body: { txHash: h } }))).status).toBe("rejected")
        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
        // A retry (or the relayer and the browser both settling) doesn't repeat the note.
        chain.verifyResult = paid
        expect((await json<SettleResult>(await t.call("POST", path, { body: { txHash: h } }))).status).toBe("rejected")
        const notes = await t.deps.db.query<{ wallet: string; title: string; detail: string }>("SELECT wallet, title, detail FROM activity WHERE title LIKE 'Refund needed%'")
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({ wallet: OWNER, title: "Refund needed: 5.00 USDC" })
        expect(notes[0]!.detail).toContain(CAROL)
        expect(notes[0]!.detail).toContain(h)
    })

    it("credits private notes one at a time and marks the order paid", async () => {
        const { orderId, shares, token } = await makeOrder(t.deps.db, [10 * U, 5 * U], { placedBy: CAROL })
        const settle = (id: string, h: Hash) => t.call("POST", `/api/pay/order/${id}/settle?t=${token}`, { body: { txHash: h } })

        const n1 = txHash()
        chain.verifyResult = paidOnChain({ txHash: n1, amount: DENOMINATION, orderRef: shares[0]!.orderRef as Hash, recipient: PAYOUT })
        let r = await json<SettleResult>(await settle(shares[0]!.id, n1))
        expect(r.status).toBe("credited")
        if (r.status === "credited") expect(r.target).toMatchObject({ paid: 5 * U, due: 5 * U, status: "owed", private: { possible: true, notes: 1 } })

        const n2 = txHash()
        chain.verifyResult = paidOnChain({ txHash: n2, amount: DENOMINATION, orderRef: shares[0]!.orderRef as Hash, recipient: PAYOUT })
        r = await json<SettleResult>(await settle(shares[0]!.id, n2))
        if (r.status !== "credited") throw new Error(JSON.stringify(r))
        expect(r.target.status).toBe("paid")

        let order = await t.deps.db.one<{ status: string; paid_at: number | null }>("SELECT status, paid_at FROM orders WHERE id = $1", [orderId])
        expect(order!.status).toBe("awaiting_payment")

        const n3 = txHash()
        chain.verifyResult = paidOnChain({ txHash: n3, amount: 5 * U, payer: CAROL, orderRef: shares[1]!.orderRef as Hash })
        r = await json<SettleResult>(await settle(shares[1]!.id, n3))
        expect(r.status).toBe("credited")

        const paidOrder = await t.deps.db.one<{ status: string; paid_at: number | null; est_ready_at: number | null; cooking_started_at: number | null }>(
            "SELECT status, paid_at, est_ready_at, cooking_started_at FROM orders WHERE id = $1",
            [orderId]
        )
        // Verified and fully paid: cooking from the moment it was paid, ready within 5 to 10 minutes.
        expect(paidOrder!.status).toBe("cooking")
        expect(paidOrder!.paid_at).toBeGreaterThan(0)
        expect(paidOrder!.cooking_started_at).toBe(paidOrder!.paid_at)
        expect(Number(paidOrder!.est_ready_at) - Number(paidOrder!.paid_at)).toBeGreaterThanOrEqual(5 * 60_000)
        expect(Number(paidOrder!.est_ready_at) - Number(paidOrder!.paid_at)).toBeLessThanOrEqual(10 * 60_000)
        order = paidOrder

        const payments = await t.deps.db.query<{ kind: string; payer: string }>("SELECT kind, payer FROM payments ORDER BY id")
        expect(payments.map((p) => p.kind)).toEqual(["private", "private", "public"])
        // A private payment records the pool, never a person.
        expect(payments[0]!.payer).toBe(chain.deployment.pool.toLowerCase())

        // Activity for confidential payments never names the payer or their seat.
        const activity = await t.deps.db.query<{ wallet: string; kind: string; title: string; detail: string | null }>(
            "SELECT wallet, kind, title, detail FROM activity ORDER BY id"
        )
        const privateRows = activity.filter((a) => a.title === "Confidential payment received")
        expect(privateRows).toHaveLength(2)
        for (const a of privateRows) expect(`${a.title} ${a.detail}`).not.toMatch(/Guest 1|0x/)
        expect(activity.filter((a) => a.kind === "order_update").map((a) => a.wallet)).toEqual([OWNER, CAROL])
    })

    it("rejects payments once the order isn't awaiting payment", async () => {
        const { orderId, shares, token } = await makeOrder(t.deps.db, [5 * U])
        await t.deps.db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId])
        const h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U })
        const r = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: h } }))
        expect(r.status).toBe("rejected")
        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
    })

    it("flags a payment that lands on an already-cancelled order for refund", async () => {
        const { orderId, shares, token } = await makeOrder(t.deps.db, [5 * U, 5 * U])
        // Cancelled (by staff, or expired) before the guests' payments were checked.
        await t.deps.db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId])
        const pub = txHash()
        chain.verifyResult = paidOnChain({ txHash: pub, amount: 5 * U, payer: CAROL, orderRef: shares[0]!.orderRef as Hash })
        const r = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: pub } }))
        expect(r.status).toBe("rejected")
        if (r.status === "rejected") expect(r.reason).toMatch(/no longer taking payments.*has been told/)
        const note = txHash()
        chain.verifyResult = paidOnChain({ txHash: note, amount: DENOMINATION, orderRef: shares[1]!.orderRef as Hash })
        expect((await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[1]!.id}/settle?t=${token}`, { body: { txHash: note } }))).status).toBe("rejected")

        expect(await t.deps.db.query("SELECT 1 FROM payments")).toHaveLength(0)
        const refunds = await t.deps.db.query<{ wallet: string; detail: string }>("SELECT wallet, detail FROM activity WHERE title LIKE 'Refund needed%' ORDER BY id")
        expect(refunds.map((x) => x.wallet)).toEqual([OWNER, OWNER])
        expect(refunds[0]!.detail).toContain(CAROL)
        expect(refunds[0]!.detail).toContain(pub)
        // The confidential one names neither the payer nor the seat.
        expect(refunds[1]!.detail).toContain(note)
        expect(refunds[1]!.detail).not.toMatch(/Guest|0x(?![0-9a-f]{64})/)
    })

    it("verifies against the payout wallet the order was placed with", async () => {
        const { orderId, shares, token, restaurantId } = await makeOrder(t.deps.db, [5 * U])
        const OTHER = "0x6666666666666666666666666666666666666666" as Wallet
        const view = async () => json<PayTarget>(await t.call("GET", `/api/pay/order/${shares[0]!.id}?t=${token}`))
        // An order from before the column existed follows the restaurant's current wallet.
        expect((await view()).recipient).toBe(PAYOUT)
        await t.deps.db.query("UPDATE orders SET payout_wallet = $2 WHERE id = $1", [orderId, PAYOUT])
        // The owner switches wallets mid-order: guests who were shown PAYOUT still pay PAYOUT.
        await t.deps.db.query("UPDATE restaurants SET payout_wallet = $2 WHERE id = $1", [restaurantId, OTHER])
        expect((await view()).recipient).toBe(PAYOUT)
        const h = txHash()
        chain.verifyResult = paidOnChain({ txHash: h, amount: 5 * U, payer: CAROL, recipient: PAYOUT })
        const r = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: h } }))
        expect(r.status).toBe("credited")
        expect((await t.deps.db.one<{ recipient: string }>("SELECT recipient FROM payments"))!.recipient).toBe(PAYOUT)
    })

    it("never credits more than amount + tip", async () => {
        const { shares, token } = await makeOrder(t.deps.db, [10 * U])
        const h = txHash()
        // Verification returns a payment larger than what is owed (e.g. paid concurrently).
        chain.verifyResult = (p) => {
            const r = paidOnChain({ txHash: h, amount: Number(p.amount), payer: CAROL })(p)
            if (r.status === "verified") r.payment.amount = 25n * BigInt(U)
            return r
        }
        const r = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: h } }))
        expect(r.status).toBe("credited")
        const s = await t.deps.db.one<{ paid: number; status: string }>("SELECT paid, status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s).toEqual({ paid: 10 * U, status: "paid" })
    })
})

describe("relay", () => {
    it("relays a private note for an open share and credits it", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const h = txHash()
        const relayed: unknown[] = []
        const t = await makeTestApp({
            chain,
            services: {
                relay: async (body) => {
                    relayed.push(body)
                    return { txHash: h }
                }
            }
        })
        const { shares, token } = await makeOrder(t.deps.db, [5 * U])
        chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION, orderRef: shares[0]!.orderRef as Hash })
        const body = { merchant: PAYOUT, orderRef: shares[0]!.orderRef, chainId: 10143, pool: chain.deployment.pool, proof: {} }
        const res = await t.call("POST", "/api/relay", { body })
        expect(res.status).toBe(200)
        expect(await json(res)).toEqual({ txHash: h })
        const s = await t.deps.db.one<{ status: string }>("SELECT status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s!.status).toBe("paid")

        // The share is paid now: no more relays for it.
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(409)
        // The browser's own settle call afterwards is idempotent.
        const again = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: h } }))
        expect(again.status).toBe("credited")
        expect(relayed).toHaveLength(1)
    })

    it("relays notes for a share that isn't whole notes, and no more than it needs", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const hashes: Hash[] = []
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    const h = txHash()
                    hashes.push(h)
                    chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION })
                    return { txHash: h }
                }
            }
        })
        const { shares } = await makeOrder(t.deps.db, [7 * U])
        const body = { merchant: PAYOUT, orderRef: shares[0]!.orderRef }
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(200)
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(200)
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(409)
        const s = await t.deps.db.one<{ paid: number; tip: number; status: string }>("SELECT paid, tip, status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s).toEqual({ paid: 10 * U, tip: 3 * U, status: "paid" })
        expect(hashes).toHaveLength(2)
    })

    it("refuses shares that can't be paid privately", async () => {
        const chain = fakeChain()
        const t = await makeTestApp({ chain, services: { relay: async () => ({ txHash: txHash() }) } })
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        const res = await t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })
        expect(res.status).toBe(409)
        const noRelayer = await makeTestApp({ chain })
        expect((await noRelayer.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })).status).toBe(503)
    })

    it("never runs more than 4 relays at once, even when requests arrive together", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        let active = 0
        let most = 0
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    active += 1
                    most = Math.max(most, active)
                    await new Promise((r) => setTimeout(r, 50))
                    active -= 1
                    return { txHash: txHash() }
                }
            }
        })
        const { shares } = await makeOrder(t.deps.db, Array(6).fill(5 * U))
        const statuses = await Promise.all(
            shares.map((s) => t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: s.orderRef } }).then((r) => r.status))
        )
        expect(most).toBe(4)
        expect(statuses.filter((s) => s === 200)).toHaveLength(4)
        expect(statuses.filter((s) => s === 503)).toHaveLength(2)
    })

    it("answers with the hash of a relay whose receipt timed out, and settles it", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const h = txHash()
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    throw new FairPayError("RELAYER_TIMEOUT", "no receipt", h)
                }
            }
        })
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        chain.verifyResult = paidOnChain({ txHash: h, amount: DENOMINATION })
        const res = await t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })
        expect(res.status).toBe(200)
        expect(await json(res)).toEqual({ txHash: h })
        const s = await t.deps.db.one<{ status: string }>("SELECT status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s!.status).toBe("paid")
    })

    it("credits a payment that beat the relayer with the same proof", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const theirs = txHash()
        const asked: unknown[][] = []
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    throw new FairPayError("RELAYER_REJECTED", "NullifierSpent")
                },
                findPayments: async (...args) => {
                    asked.push(args)
                    return [theirs]
                }
            }
        })
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        chain.verifyResult = paidOnChain({ txHash: theirs, amount: DENOMINATION, orderRef: shares[0]!.orderRef as Hash })
        const res = await t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })
        expect(res.status).toBe(409)
        expect(asked).toEqual([[shares[0]!.orderRef, PAYOUT]])
        const s = await t.deps.db.one<{ paid: number; status: string }>("SELECT paid, status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s).toEqual({ paid: 5 * U, status: "paid" })
    })

    it("recovery never counts a payment twice", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const first = txHash()
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    throw new FairPayError("RELAYER_REJECTED", `reverted: ${first}`, first)
                },
                findPayments: async () => [first, first]
            }
        })
        // Two notes owed; the first was already settled by the browser.
        const { shares, token } = await makeOrder(t.deps.db, [10 * U])
        chain.verifyResult = paidOnChain({ txHash: first, amount: DENOMINATION })
        const settled = await json<SettleResult>(await t.call("POST", `/api/pay/order/${shares[0]!.id}/settle?t=${token}`, { body: { txHash: first } }))
        expect(settled.status).toBe("credited")
        expect((await t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })).status).toBe(502)
        const s = await t.deps.db.one<{ paid: number; status: string }>("SELECT paid, status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s).toEqual({ paid: 5 * U, status: "owed" })
        const n = await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM payments WHERE target_id = $1", [shares[0]!.id])
        expect(n!.n).toBe(1)
    })

    it("frees the share at once when the node refused the transaction, and says why", async () => {
        const cases: [FairPayError, number, RegExp][] = [
            [new FairPayError("RELAYER_UNFUNDED", "no gas"), 503, /out of test MON/],
            [new FairPayError("RELAYER_BUSY", "nonce"), 503, /busy/],
            [new FairPayError("RELAYER_REJECTED", "Missing or invalid parameters."), 502, /could not submit/]
        ]
        for (const [error, status, message] of cases) {
            const chain = fakeChain({ merchants: [PAYOUT] })
            let calls = 0
            const t = await makeTestApp({
                chain,
                services: {
                    relay: async () => {
                        calls += 1
                        throw error
                    }
                }
            })
            const { shares } = await makeOrder(t.deps.db, [5 * U])
            const body = { merchant: PAYOUT, orderRef: shares[0]!.orderRef }
            const res = await t.call("POST", "/api/relay", { body })
            expect(res.status).toBe(status)
            expect((await json<{ error: string }>(res)).error).toMatch(message)
            // Nothing was sent, so a retry reaches the relayer instead of a stale hold.
            expect((await t.call("POST", "/api/relay", { body })).status).toBe(status)
            expect(calls).toBe(2)
        }
    })

    it("reports whether the relayer can pay for gas, and refuses relays while it can't", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        let ready = false
        let calls = 0
        const t = await makeTestApp({
            chain,
            services: {
                relayerReady: async () => ready,
                relay: async () => {
                    calls += 1
                    return { txHash: txHash() }
                }
            }
        })
        expect((await json<{ relayerReady?: boolean }>(await t.call("GET", "/api/config"))).relayerReady).toBe(false)
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        const body = { merchant: PAYOUT, orderRef: shares[0]!.orderRef }
        const res = await t.call("POST", "/api/relay", { body })
        expect(res.status).toBe(503)
        expect((await json<{ error: string }>(res)).error).toMatch(/out of test MON/)
        expect(calls).toBe(0)

        ready = true
        expect((await json<{ relayerReady?: boolean }>(await t.call("GET", "/api/config"))).relayerReady).toBe(true)
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(200)

        // No relayer at all: nothing to report.
        const none = await makeTestApp({ chain, services: { relayerReady: async () => true } })
        expect(await json<object>(await none.call("GET", "/api/config"))).not.toHaveProperty("relayerReady")
    })

    it("holds the share while an unclear relay may still land, and says so", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        let calls = 0
        const t = await makeTestApp({
            chain,
            services: {
                relay: async () => {
                    calls += 1
                    throw new FairPayError("RELAYER_TIMEOUT", "no answer from the RPC")
                }
            }
        })
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        const body = { merchant: PAYOUT, orderRef: shares[0]!.orderRef }
        expect((await t.call("POST", "/api/relay", { body })).status).toBe(502)
        const again = await t.call("POST", "/api/relay", { body })
        expect(again.status).toBe(409)
        expect((await json<{ error: string }>(again)).error).toMatch(/still going through/)
        expect(calls).toBe(1)
    })

    it("looks again after the grace period when a timed-out relay's transaction didn't pay", async () => {
        const chain = fakeChain({ merchants: [PAYOUT] })
        const ours = txHash()
        const theirs = txHash()
        const t = await makeTestApp({
            chain,
            services: {
                relaySettleGraceMs: 20,
                relay: async () => {
                    throw new FairPayError("RELAYER_TIMEOUT", "no receipt", ours)
                },
                findPayments: async () => [theirs]
            }
        })
        const { shares } = await makeOrder(t.deps.db, [5 * U])
        // Ours reverted (someone else's copy of the proof landed first); theirs paid.
        chain.verifyResult = (p) => (p.txHash.toLowerCase() === ours.toLowerCase() ? { status: "rejected", reason: "transaction reverted" } : paidOnChain({ txHash: theirs, amount: DENOMINATION })(p))
        expect((await t.call("POST", "/api/relay", { body: { merchant: PAYOUT, orderRef: shares[0]!.orderRef } })).status).toBe(200)
        await new Promise((r) => setTimeout(r, 300))
        const s = await t.deps.db.one<{ status: string }>("SELECT status FROM order_shares WHERE id = $1", [shares[0]!.id])
        expect(s!.status).toBe("paid")
    })
})
