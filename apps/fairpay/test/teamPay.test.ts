// Team pay (server/routes/teamPay.ts, server/transfers.ts): only the owner may see or record team
// payments; a payout is recorded only after the chain shows exactly one USDC Transfer of the right
// amount from the owner's wallet to a wallet on the staff, with enough confirmations, and only once.

import { beforeEach, describe, expect, it } from "vitest"
import type { ActivityItem, Restaurant, TeamPayoutPage, TeamPayRecordResult, TeamPayView, Wallet } from "../shared/types.js"
import { myPayLink } from "../server/routes/teamPay.js"
import { fakeChain, makeTestApp, mineTransfer, transferLog, txHash, type TestApp } from "./helpers.js"

const U = 1_000_000
const OWNER = "0x1111111111111111111111111111111111111111" as Wallet
const MANAGER = "0x2222222222222222222222222222222222222222" as Wallet
const CHEF = "0x3333333333333333333333333333333333333333" as Wallet
const WAITER = "0x4444444444444444444444444444444444444444" as Wallet
const OUTSIDER = "0x6666666666666666666666666666666666666666" as Wallet
const OTHER_OWNER = "0x7777777777777777777777777777777777777777" as Wallet
const FAKE_TOKEN = "0x00000000000000000000000000000000000000f1"

type Ctx = TestApp & { cookies: Record<string, string>; r: Restaurant }

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    const body = await r.json()
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`)
    return body as T
}

async function setup(): Promise<Ctx> {
    const t = await makeTestApp({ chain: fakeChain() })
    const cookies: Record<string, string> = {}
    for (const [name, w] of Object.entries({ OWNER, MANAGER, CHEF, WAITER, OUTSIDER, OTHER_OWNER })) cookies[name] = await t.signIn(w)
    const r = await json<Restaurant>(t.call("POST", "/api/restaurants", { cookie: cookies.OWNER, body: { name: "Spice Route", state: "Karnataka", tables: 2 } }), 201)
    for (const [w, role, name] of [
        [MANAGER, "manager", "Meera"],
        [CHEF, "chef", "Arjun"],
        [WAITER, "waiter", "Kavya"]
    ] as const) {
        await json(t.call("POST", `/api/restaurants/${r.id}/staff`, { cookie: cookies.OWNER, body: { wallet: w, role, displayName: name } }), 201)
    }
    return { ...t, cookies, r }
}

/** A mined transfer of `value` from `from` to `to` (the deployment's token by default). */
function paid(t: Ctx, value: number, to: string = CHEF, from: string = OWNER, token?: string) {
    return mineTransfer(t.chain, { logs: [transferLog({ from, to, value, token })] })
}

function record(t: Ctx, body: Record<string, unknown>, cookie = t.cookies.OWNER) {
    return t.call("POST", `/api/restaurants/${t.r.id}/team-pay`, { cookie, body })
}

describe("team pay: who may use it", () => {
    let t: Ctx
    beforeEach(async () => {
        t = await setup()
    })

    it("answers only the owner; staff, strangers and unknown ids get the same 404, signed-out callers 401", async () => {
        const h = paid(t, 10 * U)
        const paths: [string, string, unknown?][] = [
            ["GET", `/api/restaurants/${t.r.id}/team-pay`],
            ["GET", `/api/restaurants/${t.r.id}/team-pay/payouts`],
            ["GET", `/api/restaurants/${t.r.id}/team-pay/payouts.csv`],
            ["POST", `/api/restaurants/${t.r.id}/team-pay`, { wallet: CHEF, amount: 10 * U, txHash: h }]
        ]
        for (const [method, path, body] of paths) {
            expect((await t.call(method, path, { cookie: t.cookies.OWNER, body })).status, `${method} ${path} owner`).toBe(200)
            for (const who of ["MANAGER", "CHEF", "WAITER", "OUTSIDER", "OTHER_OWNER"]) {
                const res = await t.call(method, path, { cookie: t.cookies[who], body })
                expect(res.status, `${method} ${path} as ${who}`).toBe(404)
                expect(await res.json()).toEqual({ error: "No restaurant with that id." })
            }
            expect((await t.call(method, path, { body })).status, `${method} ${path} signed out`).toBe(401)
            const unknown = path.replace(t.r.id, "r_doesnotexist")
            expect((await t.call(method, unknown, { cookie: t.cookies.OWNER, body })).status).toBe(404)
        }
        // Only the owner's one request reached the chain.
        expect(t.chain.transferCalls).toHaveLength(1)
    })

    it("lists every staff member with what they were paid, and the payouts, newest first", async () => {
        await json(record(t, { wallet: CHEF, amount: 10 * U, note: "October tips", txHash: paid(t, 10 * U) }))
        await json(record(t, { wallet: CHEF, amount: 5 * U, txHash: paid(t, 5 * U) }))
        await json(record(t, { wallet: WAITER, amount: 2_500_000, txHash: paid(t, 2_500_000, WAITER) }))
        const v = await json<TeamPayView>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay`, { cookie: t.cookies.OWNER }))
        expect(v.owner).toBe(OWNER)
        const byName = Object.fromEntries(v.staff.map((s) => [s.displayName, s]))
        expect(Object.keys(byName).sort()).toEqual(["Arjun", "Kavya", "Meera"])
        expect(byName.Arjun).toMatchObject({ wallet: CHEF, role: "chef", paidTotal: 15 * U, payCount: 2 })
        expect(byName.Kavya).toMatchObject({ paidTotal: 2_500_000, payCount: 1 })
        expect(byName.Meera).toMatchObject({ paidTotal: 0, payCount: 0, lastPaidAt: null })
        expect(v.payouts.map((p) => p.amount)).toEqual([2_500_000, 5 * U, 10 * U])
        expect(v.payouts[2]).toMatchObject({ note: "October tips", payer: OWNER, recipient: { wallet: CHEF, name: "Arjun", role: "chef" } })
        expect(v.payouts[2]!.proof).toMatchObject({ chainId: 10143, logIndex: 0 })
        expect(v.next).toBeNull()
    })

    it("pages the history and exports it as CSV", async () => {
        for (let i = 1; i <= 5; i++) await json(record(t, { wallet: CHEF, amount: i * U, txHash: paid(t, i * U) }))
        const p1 = await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/payouts?limit=2`, { cookie: t.cookies.OWNER }))
        expect(p1.payouts.map((p) => p.amount)).toEqual([5 * U, 4 * U])
        const p2 = await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/payouts?limit=2&before=${p1.next}`, { cookie: t.cookies.OWNER }))
        expect(p2.payouts.map((p) => p.amount)).toEqual([3 * U, 2 * U])
        const p3 = await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/payouts?limit=2&before=${p2.next}`, { cookie: t.cookies.OWNER }))
        expect(p3.payouts.map((p) => p.amount)).toEqual([1 * U])
        expect(p3.next).toBeNull()
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/team-pay/payouts?before=abc`, { cookie: t.cookies.OWNER })).status).toBe(400)

        const csv = await t.call("GET", `/api/restaurants/${t.r.id}/team-pay/payouts.csv`, { cookie: t.cookies.OWNER })
        expect(csv.headers.get("content-type")).toContain("text/csv")
        const lines = (await csv.text()).trim().split("\r\n")
        expect(lines[0]).toBe("verified_at_utc,name,role,wallet,amount_usdc,note,payer,chain_id,tx_hash,log_index,block")
        expect(lines).toHaveLength(6)
        expect(lines[1]).toContain(",Arjun,chef,0x3333333333333333333333333333333333333333,5.000000,,")
    })

    it("lets a staff member read only their own payouts from this restaurant", async () => {
        await json(record(t, { wallet: CHEF, amount: 10 * U, note: "Thanks!", txHash: paid(t, 10 * U) }))
        await json(record(t, { wallet: WAITER, amount: 3 * U, txHash: paid(t, 3 * U, WAITER) }))
        const mine = await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`, { cookie: t.cookies.CHEF }))
        expect(mine.payouts).toHaveLength(1)
        expect(mine.payouts[0]).toMatchObject({ amount: 10 * U, note: "Thanks!", recipient: { wallet: CHEF } })
        // Staff with nothing yet see an empty list; outsiders and the owner get 404.
        expect((await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`, { cookie: t.cookies.MANAGER }))).payouts).toEqual([])
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`, { cookie: t.cookies.OUTSIDER })).status).toBe(404)
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`, { cookie: t.cookies.OWNER })).status).toBe(404)
        expect((await t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`)).status).toBe(401)
        // Someone who left the staff still sees what they were paid here.
        await json(t.call("DELETE", `/api/restaurants/${t.r.id}/staff/${CHEF}`, { cookie: t.cookies.OWNER }))
        expect((await json<TeamPayoutPage>(t.call("GET", `/api/restaurants/${t.r.id}/team-pay/mine`, { cookie: t.cookies.CHEF }))).payouts).toHaveLength(1)
    })
})

describe("team pay: recording a payout checks the chain", () => {
    let t: Ctx
    beforeEach(async () => {
        t = await setup()
    })

    const rows = async (t: Ctx) => Number((await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM team_payouts"))!.n)

    it("records a matching transfer once and tells the staff member", async () => {
        const h = paid(t, 12_340_000)
        const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF.toUpperCase().replace("0X", "0x"), amount: 12_340_000, note: "  Overtime  ", txHash: h }))
        expect(res.status).toBe("recorded")
        if (res.status !== "recorded") return
        expect(res.duplicate).toBe(false)
        expect(res.payout).toMatchObject({ amount: 12_340_000, note: "Overtime", payer: OWNER, recipient: { wallet: CHEF, name: "Arjun", role: "chef" } })
        expect(res.payout.proof.txHash).toBe(h.toLowerCase())

        const items = await json<ActivityItem[]>(t.call("GET", "/api/activity", { cookie: t.cookies.CHEF }))
        const note = items.find((a) => a.kind === "payment_received")
        expect(note).toMatchObject({ title: "You were paid 12.34 USDC by Spice Route", detail: "Overtime", link: myPayLink(t.r.id) })
        // The owner and other staff get nothing.
        for (const who of ["OWNER", "WAITER"]) {
            const theirs = await json<ActivityItem[]>(t.call("GET", "/api/activity", { cookie: t.cookies[who] }))
            expect(theirs.some((a) => a.kind === "payment_received")).toBe(false)
        }
    })

    it("answers pending (202) until the transfer has 2 confirmations, then records it", async () => {
        const h = mineTransfer(t.chain, { logs: [transferLog({ from: OWNER, to: CHEF, value: 10 * U })], blockNumber: t.chain.head })
        const body = { wallet: CHEF, amount: 10 * U, txHash: h }
        expect(await json<TeamPayRecordResult>(record(t, body), 202)).toEqual({ status: "pending", reason: "Waiting for the transaction to be confirmed." })
        // Not on the chain at all yet.
        expect((await json<TeamPayRecordResult>(record(t, { ...body, txHash: txHash() }), 202)).status).toBe("pending")
        expect(await rows(t)).toBe(0)
        t.chain.head += 1n
        expect((await json<TeamPayRecordResult>(record(t, body))).status).toBe("recorded")
    })

    it("waits while the receipt's block isn't the canonical one (a reorg)", async () => {
        const h = paid(t, 10 * U)
        const block = t.chain.receipts.get(h.toLowerCase())!.blockNumber
        t.chain.reorged.add(block)
        expect((await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: h }), 202)).status).toBe("pending")
        t.chain.reorged.delete(block)
        expect((await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: h }))).status).toBe("recorded")
    })

    it("refuses a reverted transaction", async () => {
        const h = mineTransfer(t.chain, { logs: [], status: "reverted" })
        expect(await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: h }))).toEqual({
            status: "rejected",
            reason: "Not recorded: transaction reverted."
        })
        expect(await rows(t)).toBe(0)
    })

    it("ignores Transfer events from any other token contract", async () => {
        const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: paid(t, 10 * U, CHEF, OWNER, FAKE_TOKEN) }))
        expect(res).toEqual({ status: "rejected", reason: "Not recorded: no USDC transfer in this transaction." })
        expect(await rows(t)).toBe(0)
    })

    it("refuses USDC that didn't come from the owner's wallet", async () => {
        // A manager (or anyone) paying the chef can't be passed off as the owner's payout.
        const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: paid(t, 10 * U, CHEF, MANAGER) }))
        expect(res).toEqual({ status: "rejected", reason: "Not recorded: the USDC didn't come from the restaurant owner's wallet." })
    })

    it("refuses USDC that went to another wallet than the staff member named", async () => {
        const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: paid(t, 10 * U, WAITER) }))
        expect(res).toEqual({ status: "rejected", reason: "Not recorded: the USDC went to a different wallet." })
        expect(await rows(t)).toBe(0)
    })

    it("refuses a wallet that isn't on this restaurant's staff, before asking the chain", async () => {
        for (const w of [OUTSIDER, OWNER]) {
            const res = await record(t, { wallet: w, amount: 10 * U, txHash: paid(t, 10 * U, w) })
            expect(res.status).toBe(400)
            expect(await res.json()).toEqual({ error: "That wallet isn't on this restaurant's staff." })
        }
        expect(t.chain.transferCalls).toHaveLength(0)
        // Removed from the staff after being paid: not recorded either.
        const h = paid(t, 10 * U, WAITER)
        await json(t.call("DELETE", `/api/restaurants/${t.r.id}/staff/${WAITER}`, { cookie: t.cookies.OWNER }))
        expect((await record(t, { wallet: WAITER, amount: 10 * U, txHash: h })).status).toBe(400)
        expect(await rows(t)).toBe(0)
    })

    it("refuses an amount that doesn't match the transfer", async () => {
        const h = paid(t, 10 * U)
        for (const amount of [9 * U, 11 * U]) {
            const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount, txHash: h }))
            expect(res.status).toBe("rejected")
            if (res.status === "rejected") expect(res.reason).toMatch(/^Not recorded: amount 10000000 does not equal/)
        }
        expect(await rows(t)).toBe(0)
    })

    it("refuses a transaction with several USDC transfers, even if one matches", async () => {
        const h = mineTransfer(t.chain, {
            logs: [transferLog({ from: OWNER, to: CHEF, value: 10 * U }), transferLog({ from: OWNER, to: WAITER, value: 10 * U })]
        })
        const res = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: h }))
        expect(res).toEqual({ status: "rejected", reason: "Not recorded: several USDC transfers in one transaction." })
        // A fake token's Transfer next to the real one doesn't count as a second one.
        const h2 = mineTransfer(t.chain, {
            logs: [transferLog({ from: OWNER, to: CHEF, value: 1 * U, token: FAKE_TOKEN }), transferLog({ from: OWNER, to: CHEF, value: 10 * U })]
        })
        const ok = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, txHash: h2 }))
        expect(ok.status).toBe("recorded")
        if (ok.status === "recorded") expect(ok.payout.proof.logIndex).toBe(1)
    })

    it("records a transaction once: a retry gets the same payout, another claim on it is refused", async () => {
        const h = paid(t, 10 * U)
        const first = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, note: "a", txHash: h }))
        const again = await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 10 * U, note: "b", txHash: h.toUpperCase().replace("0X", "0x") }))
        expect(first.status).toBe("recorded")
        expect(again.status).toBe("recorded")
        if (first.status === "recorded" && again.status === "recorded") {
            expect(again.duplicate).toBe(true)
            expect(again.payout.id).toBe(first.payout.id)
            expect(again.payout.note).toBe("a")
        }
        expect(await rows(t)).toBe(1)
        // Only one note for the chef.
        const items = await json<ActivityItem[]>(t.call("GET", "/api/activity", { cookie: t.cookies.CHEF }))
        expect(items.filter((a) => a.kind === "payment_received")).toHaveLength(1)
        // The same transaction for someone else or another amount is refused.
        expect((await json<TeamPayRecordResult>(record(t, { wallet: WAITER, amount: 10 * U, txHash: h }))).status).toBe("rejected")
        expect((await json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 5 * U, txHash: h }))).status).toBe("rejected")
        // Two requests at the same moment still store one row.
        const h2 = paid(t, 7 * U)
        const both = await Promise.all([1, 2].map(() => json<TeamPayRecordResult>(record(t, { wallet: CHEF, amount: 7 * U, txHash: h2 }))))
        expect(both.map((b) => b.status)).toEqual(["recorded", "recorded"])
        expect(await rows(t)).toBe(2)
    })

    it("keeps the history append-only", async () => {
        await json(record(t, { wallet: CHEF, amount: 10 * U, txHash: paid(t, 10 * U) }))
        await expect(t.deps.db.query("UPDATE team_payouts SET amount = 1")).rejects.toThrow(/append-only/)
        await expect(t.deps.db.query("DELETE FROM team_payouts")).rejects.toThrow(/append-only/)
    })

    it("checks the request before anything else", async () => {
        const h = paid(t, 10 * U)
        const bad: [Record<string, unknown>, string][] = [
            [{ wallet: "nope", amount: 10 * U, txHash: h }, "Staff wallet must be a 0x address."],
            [{ wallet: CHEF, amount: 0, txHash: h }, "Amount must be between 10000 and 100000000000."],
            [{ wallet: CHEF, amount: 1.5, txHash: h }, "Amount must be a whole number."],
            [{ wallet: CHEF, amount: 10_005_000, txHash: h }, "Amount must be whole cents."],
            [{ wallet: CHEF, amount: 10 * U, txHash: "0x1234" }, "txHash must be a transaction hash."],
            [{ wallet: CHEF, amount: 10 * U, note: "x".repeat(141), txHash: h }, "Note must be at most 140 characters."]
        ]
        for (const [body, error] of bad) {
            const res = await record(t, body)
            expect(res.status, JSON.stringify(body)).toBe(400)
            expect(await res.json()).toEqual({ error })
        }
        // Without the CSRF header the request is refused outright.
        const res = await t.call("POST", `/api/restaurants/${t.r.id}/team-pay`, { cookie: t.cookies.OWNER, body: { wallet: CHEF, amount: 10 * U, txHash: h }, headers: { "x-fairpay": "0" } })
        expect(res.status).toBe(403)
        expect(t.chain.transferCalls).toHaveLength(0)
    })

    it("answers 502 when the chain can't be read, and stores nothing", async () => {
        t.chain.verifyTransfer = async () => {
            throw new Error("rpc down")
        }
        expect((await record(t, { wallet: CHEF, amount: 10 * U, txHash: paid(t, 10 * U) })).status).toBe(502)
        expect(await rows(t)).toBe(0)
    })

    it("rate-limits recording", async () => {
        const h = txHash()
        let last = 0
        for (let i = 0; i < 61; i++) last = (await record(t, { wallet: CHEF, amount: 10 * U, txHash: h })).status
        expect(last).toBe(429)
    })
})
