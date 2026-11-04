import { describe, expect, it } from "vitest"
import { computeShares, SplitError, usdc } from "../server/bills.js"
import type { ActivityItem, Bill, BillSummary, Wallet } from "../shared/types.js"
import { makeTestApp, paidOnChain, txHash } from "./helpers.js"

const U = 1_000_000 // 1 USDC in micro
const C = 10_000 // 1 cent in micro
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)

function splitError(fn: () => unknown): string {
    try {
        fn()
    } catch (err) {
        expect(err).toBeInstanceOf(SplitError)
        return (err as Error).message
    }
    throw new Error("expected a SplitError")
}

describe("computeShares: equal", () => {
    it("splits evenly", () => {
        expect(computeShares({ total: 45 * U, splitType: "equal", values: [undefined, undefined] })).toEqual([15 * U, 15 * U, 15 * U])
    })

    it("spreads leftover cents one at a time from the creator", () => {
        // 10.00 / 3 = 3.33 r 1 cent
        expect(computeShares({ total: 10 * U, splitType: "equal", values: [null, null] })).toEqual([334 * C, 333 * C, 333 * C])
        // 0.05 / 4 = 0.01 r 1 ... first person gets 0.02
        expect(computeShares({ total: 5 * C, splitType: "equal", values: [1, 2, 3] })).toEqual([2 * C, C, C, C])
        // 1.00 / 7: 14 cents each, 2 left
        const s = computeShares({ total: U, splitType: "equal", values: Array(6).fill(undefined) })
        expect(s).toEqual([15 * C, 15 * C, 14 * C, 14 * C, 14 * C, 14 * C, 14 * C])
        expect(sum(s)).toBe(U)
    })

    it("gives zero to people when the total is smaller than one cent each", () => {
        expect(computeShares({ total: 2 * C, splitType: "equal", values: [undefined, undefined] })).toEqual([C, C, 0])
    })

    it("every share is a whole cent and the sum is exact for many totals", () => {
        for (let total = C; total <= 3 * U; total += 130_000 + 3 * C) {
            for (let n = 1; n < 20; n++) {
                const s = computeShares({ total, splitType: "equal", values: Array(n).fill(undefined) })
                expect(s).toHaveLength(n + 1)
                expect(sum(s)).toBe(total)
                expect(s.every((x) => x % C === 0)).toBe(true)
                expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(C)
            }
        }
    })
})

describe("computeShares: fixed", () => {
    it("returns the amounts, creator first", () => {
        expect(computeShares({ total: 45 * U, splitType: "fixed", values: [20 * U, 15 * U], creatorValue: 10 * U })).toEqual([10 * U, 20 * U, 15 * U])
    })

    it("treats a missing creator value as zero", () => {
        expect(computeShares({ total: 30 * U, splitType: "fixed", values: [20 * U, 10 * U] })).toEqual([0, 20 * U, 10 * U])
    })

    it("explains a sum that does not match the total", () => {
        expect(splitError(() => computeShares({ total: 45 * U, splitType: "fixed", values: [20 * U, 12 * U], creatorValue: 10 * U }))).toBe(
            "Fixed amounts add up to 42.00 USDC but the total is 45.00 USDC."
        )
        expect(splitError(() => computeShares({ total: 1234 * U, splitType: "fixed", values: [1300 * U] }))).toBe(
            "The amount for participant 1 is more than the total."
        )
        expect(splitError(() => computeShares({ total: 1500 * U, splitType: "fixed", values: [1000 * U, 400 * U] }))).toBe(
            "Fixed amounts add up to 1,400.00 USDC but the total is 1,500.00 USDC."
        )
    })

    it("rejects missing, negative, fractional and sub-cent amounts", () => {
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "fixed", values: [5 * U, undefined], names: ["Ana", "Bo"] }))).toBe("Enter a value for Bo.")
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "fixed", values: [-U] }))).toBe("The amount for participant 1 must be zero or more.")
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "fixed", values: [1.5] }))).toBe("The amount for participant 1 must be zero or more.")
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "fixed", values: [10 * U - 1], creatorValue: 1 }))).toBe(
            "The amount for your own share must be a whole number of cents."
        )
    })
})

describe("computeShares: percent", () => {
    it("splits by basis points", () => {
        expect(computeShares({ total: 100 * U, splitType: "percent", values: [2500, 2500], creatorValue: 5000 })).toEqual([50 * U, 25 * U, 25 * U])
    })

    it("gives the leftover cents to the last person", () => {
        // 10.00 at 33.33 / 33.33 / 33.34 -> 3.33, 3.33, 3.33 + 1 cent left
        expect(computeShares({ total: 10 * U, splitType: "percent", values: [3333, 3334], creatorValue: 3333 })).toEqual([333 * C, 333 * C, 334 * C])
        // 0.10 at 1/3 each (3333, 3333, 3334): 0.03, 0.03, 0.03 + 1 left -> last
        expect(computeShares({ total: 10 * C, splitType: "percent", values: [3333, 3334], creatorValue: 3333 })).toEqual([3 * C, 3 * C, 4 * C])
    })

    it("skips people at 0% when handing out the leftover", () => {
        expect(computeShares({ total: 10 * U, splitType: "percent", values: [6667, 0], creatorValue: 3333 })).toEqual([333 * C, 667 * C, 0])
    })

    it("explains percentages that do not add up to 100%", () => {
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "percent", values: [4500, 5050] }))).toBe("Percentages add up to 95.5% but must add up to 100%.")
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "percent", values: [6000, 6000] }))).toBe("Percentages add up to 120% but must add up to 100%.")
        expect(splitError(() => computeShares({ total: 10 * U, splitType: "percent", values: [10001] }))).toBe(
            "The percentage for participant 1 must be between 0% and 100%."
        )
    })
})

describe("computeShares: shares", () => {
    it("splits by weight", () => {
        expect(computeShares({ total: 60 * U, splitType: "shares", values: [2, 3], creatorValue: 1 })).toEqual([10 * U, 20 * U, 30 * U])
    })

    it("spreads leftover cents from the first non-zero weight", () => {
        // 1.00 by 1:1:1 -> 33 each + 1 left -> creator
        expect(computeShares({ total: U, splitType: "shares", values: [1, 1], creatorValue: 1 })).toEqual([34 * C, 33 * C, 33 * C])
        // creator 0: leftover goes to the first participant
        expect(computeShares({ total: U, splitType: "shares", values: [1, 1, 1] })).toEqual([0, 34 * C, 33 * C, 33 * C])
        // 1.00 by 1:1:1:1:1:1 (6 people), 16 each, 4 left
        expect(computeShares({ total: U, splitType: "shares", values: [1, 1, 1, 1, 1], creatorValue: 1 })).toEqual([17 * C, 17 * C, 17 * C, 17 * C, 16 * C, 16 * C])
    })

    it("always sums to the total in whole cents", () => {
        const weights = [3, 7, 1, 0, 13, 2]
        for (const total of [C, 99 * C, 12_345 * C, 999_999 * U]) {
            const s = computeShares({ total, splitType: "shares", values: weights, creatorValue: 5 })
            expect(sum(s)).toBe(total)
            expect(s.every((x) => x % C === 0 && x >= 0)).toBe(true)
            expect(s[4]).toBe(0)
        }
    })

    it("rejects bad weights", () => {
        expect(splitError(() => computeShares({ total: U, splitType: "shares", values: [0, 0] }))).toBe("Give at least one person a share above zero.")
        expect(splitError(() => computeShares({ total: U, splitType: "shares", values: [1.5] }))).toBe(
            "The shares for participant 1 must be a whole number from 0 to 10000."
        )
        expect(splitError(() => computeShares({ total: U, splitType: "shares", values: [1, undefined] }))).toBe("Enter a value for participant 2.")
    })
})

describe("computeShares: totals and people", () => {
    it("validates the total", () => {
        expect(splitError(() => computeShares({ total: 0, splitType: "equal", values: [undefined] }))).toBe("The total must be a positive amount.")
        expect(splitError(() => computeShares({ total: 1.5, splitType: "equal", values: [undefined] }))).toBe("The total must be a positive amount.")
        expect(splitError(() => computeShares({ total: 12_345, splitType: "equal", values: [undefined] }))).toBe("The total must be a whole number of cents.")
        expect(splitError(() => computeShares({ total: 1_000_000 * U + C, splitType: "equal", values: [undefined] }))).toBe(
            "The total can be at most 1,000,000.00 USDC."
        )
        expect(computeShares({ total: 1_000_000 * U, splitType: "equal", values: [undefined] })).toEqual([500_000 * U, 500_000 * U])
    })

    it("needs between 2 and 20 people including the creator", () => {
        expect(splitError(() => computeShares({ total: U, splitType: "equal", values: [] }))).toBe("Add at least one person to split with.")
        expect(computeShares({ total: 20 * U, splitType: "equal", values: Array(19).fill(undefined) })).toHaveLength(20)
        expect(splitError(() => computeShares({ total: U, splitType: "equal", values: Array(20).fill(undefined) }))).toBe(
            "A bill can have at most 20 people, including you."
        )
    })

    it("rejects an unknown split type", () => {
        expect(splitError(() => computeShares({ total: U, splitType: "items" as "equal", values: [1] }))).toBe("Split type must be equal, fixed, percent or shares.")
    })

    it("formats USDC", () => {
        expect(usdc(42 * U)).toBe("42.00")
        expect(usdc(5 * C)).toBe("0.05")
        expect(usdc(1_234_567 * U + 89 * C)).toBe("1,234,567.89")
    })
})

// ------------------------------------------------------------------ routes

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc"
const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd"
const mixedCase = (w: string) => "0x" + w.slice(2).toUpperCase()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function setup() {
    const clock = { now: 1_000_000 }
    const t = await makeTestApp({ now: () => clock.now })
    const cookie: Record<string, string> = {}
    for (const w of [ALICE, BOB, CAROL, DAVE]) cookie[w] = await t.signIn(w as `0x${string}`)
    const call = async (method: string, path: string, who?: string, body?: unknown) => {
        const headers: Record<string, string> = { "x-fairpay": "1" }
        if (who) headers.cookie = cookie[who]
        if (body !== undefined) headers["content-type"] = "application/json"
        const res = await t.app.request(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await res.text()
        return { status: res.status, body: (text ? JSON.parse(text) : null) as Json }
    }
    const create = async (who: string, input: Record<string, unknown>) => {
        const r = await call("POST", "/bills", who, input)
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        return r.body as Bill
    }
    return { ...t, clock, call, create }
}

const tokenOf = (bill: Bill) => bill.shareUrl!.split("/b/")[1]

const dinner = {
    title: "Dinner",
    total: 45 * U,
    splitType: "equal",
    participants: [{ wallet: mixedCase(BOB), displayName: "Bob" }, { displayName: "Carol" }]
}

describe("bills routes", () => {
    it("creates a bill with the creator first and covered", async () => {
        const t = await setup()
        await t.deps.db.query("UPDATE profiles SET display_name = 'Alice' WHERE wallet = $1", [ALICE])
        const bill = await t.create(ALICE, { ...dinner, note: "Thai place" })
        expect(bill.creator).toBe(ALICE)
        expect(bill.recipient).toBe(ALICE)
        expect(bill.recipientName).toBe("Alice")
        expect(bill.status).toBe("open")
        expect(bill.splitType).toBe("equal")
        expect(bill.source).toBe("manual")
        expect(bill.note).toBe("Thai place")
        expect(bill.shareUrl).toBe(`${t.deps.publicOrigin.replace(/\/+$/, "")}/b/${tokenOf(bill)}`)
        expect(tokenOf(bill)).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(bill.myParticipantId).toBe(bill.participants[0].id)
        expect(bill.participants.map((p) => [p.wallet, p.displayName, p.amount, p.status])).toEqual([
            [ALICE, "Alice", 15 * U, "covered"],
            [BOB, "Bob", 15 * U, "owed"],
            [null, "Carol", 15 * U, "owed"]
        ])
        expect(bill.participants.every((p) => !p.paidPrivately && p.paid === 0 && p.tip === 0 && p.paidAt === null)).toBe(true)
        // Secrets and order refs never leave the server.
        expect(JSON.stringify(bill)).not.toMatch(/secret|order_?ref|share_token/i)

        const acts = await t.deps.db.query<{ wallet: string; kind: string; title: string; link: string }>("SELECT wallet, kind, title, link FROM activity ORDER BY id")
        expect(acts).toEqual([
            { wallet: ALICE, kind: "bill_created", title: 'You split "Dinner"', link: `/bills/${bill.id}` },
            { wallet: BOB, kind: "bill_request", title: "Alice requested 15.00 USDC", link: `/bills/${bill.id}` }
        ])
        const rows = await t.deps.db.query<{ order_ref: string }>("SELECT order_ref FROM bill_participants")
        expect(new Set(rows.map((r) => r.order_ref)).size).toBe(3)
    })

    it("keeps participants in the order they were entered", async () => {
        const t = await setup()
        const names = Array.from({ length: 19 }, (_, i) => `P${i + 1}`)
        const bill = await t.create(ALICE, {
            title: "Trip",
            total: 100 * U,
            splitType: "shares",
            creatorValue: 1,
            participants: names.map((displayName, i) => ({ displayName, value: i + 1 }))
        })
        expect(bill.participants.map((p) => p.displayName)).toEqual(["0xaaaa…aaaa", ...names])
        expect(bill.participants.reduce((s, p) => s + p.amount, 0)).toBe(100 * U)
        const again = await t.call("GET", `/bills/${bill.id}`, ALICE)
        expect(again.body.participants.map((p: Json) => p.id)).toEqual(bill.participants.map((p) => p.id))
    })

    it("marks already-paid people covered and settles when nobody owes anything", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, { ...dinner, participants: [{ wallet: BOB, displayName: "Bob", alreadyPaid: true }, { displayName: "Carol" }] })
        expect(bill.participants.map((p) => p.status)).toEqual(["covered", "covered", "owed"])
        expect(bill.status).toBe("open")
        const acts = await t.deps.db.query<{ title: string }>("SELECT title FROM activity WHERE wallet = $1", [BOB])
        expect(acts.map((a) => a.title)).toEqual(['0xaaaa…aaaa added you to "Dinner"'])

        const all = await t.create(ALICE, { ...dinner, participants: [{ displayName: "Carol", alreadyPaid: true }] })
        expect(all.status).toBe("settled")
        expect(all.settledAt).not.toBeNull()
    })

    it("validates the input with clear messages", async () => {
        const t = await setup()
        const bad = async (input: Record<string, unknown>) => {
            const r = await t.call("POST", "/bills", ALICE, input)
            expect(r.status, JSON.stringify(input)).toBe(400)
            return r.body.error as string
        }
        expect(
            await bad({ ...dinner, splitType: "fixed", creatorValue: 10 * U, participants: [{ displayName: "Bob", value: 20 * U }, { displayName: "Carol", value: 12 * U }] })
        ).toBe("Fixed amounts add up to 42.00 USDC but the total is 45.00 USDC.")
        expect(await bad({ ...dinner, participants: [{ wallet: BOB, displayName: "Bob" }, { wallet: mixedCase(BOB), displayName: "Bob 2" }] })).toMatch(/twice/)
        expect(await bad({ ...dinner, participants: [{ wallet: mixedCase(ALICE), displayName: "Me" }] })).toMatch(/already in the bill/)
        expect(await bad({ ...dinner, participants: [] })).toBe("Add at least one person to split with.")
        expect(await bad({ ...dinner, participants: Array.from({ length: 20 }, (_, i) => ({ displayName: `P${i}` })) })).toBe(
            "A bill can have at most 20 people, including you."
        )
        expect(await bad({ ...dinner, splitType: "items" })).toMatch(/Split type/)
        expect(await bad({ ...dinner, total: 12_345 })).toBe("The total must be a whole number of cents.")
        expect(await bad({ ...dinner, total: 2_000_000 * U })).toBe("The total can be at most 1,000,000.00 USDC.")
        expect(await bad({ ...dinner, total: "45" })).toMatch(/total/i)
        expect(await bad({ ...dinner, title: "" })).toBeTruthy()
        expect(await bad({ ...dinner, title: "x".repeat(81) })).toBeTruthy()
        expect(await bad({ ...dinner, note: "x".repeat(281) })).toBeTruthy()
        expect(await bad({ ...dinner, participants: [{ displayName: "  " }] })).toMatch(/name or a wallet/)
        expect(await bad({ ...dinner, participants: [{ displayName: "x".repeat(61) }] })).toBeTruthy()
        expect(await bad({ ...dinner, participants: [{ wallet: "0x123", displayName: "Bob" }] })).toBeTruthy()
        expect(await bad({ ...dinner, splitType: "percent", participants: [{ displayName: "Bob", value: 5000 }] })).toBe(
            "Percentages add up to 50% but must add up to 100%."
        )
        expect(await bad({ ...dinner, splitType: "shares", participants: [{ displayName: "Bob", value: "2" }] })).toMatch(/whole number/)
        expect((await t.call("POST", "/bills", undefined, dinner)).status).toBe(401)
        expect(await t.deps.db.query("SELECT id FROM bills")).toHaveLength(0)
    })

    it("names a wallet-only participant from their profile or short address", async () => {
        const t = await setup()
        await t.deps.db.query("UPDATE profiles SET display_name = 'Bobby' WHERE wallet = $1", [BOB])
        const bill = await t.create(ALICE, { ...dinner, participants: [{ wallet: BOB }, { wallet: CAROL }] })
        expect(bill.participants.map((p) => p.displayName)).toEqual(["0xaaaa…aaaa", "Bobby", "0xcccc…cccc"])
    })

    it("only shows a bill by id to its people", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const bob = await t.call("GET", `/bills/${bill.id}`, BOB)
        expect(bob.status).toBe(200)
        expect(bob.body.myParticipantId).toBe(bill.participants[1].id)
        expect(bob.body.shareUrl).toBe(bill.shareUrl)
        expect((await t.call("GET", `/bills/${bill.id}`, CAROL)).status).toBe(404)
        expect((await t.call("GET", `/bills/${bill.id}`)).status).toBe(401)
        expect((await t.call("GET", "/bills/b_nope", ALICE)).status).toBe(404)
    })

    it("shows a bill by link with other people's wallets hidden", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const anon = await t.call("GET", `/b/${tokenOf(bill)}`)
        expect(anon.status).toBe(200)
        expect(anon.body.shareUrl).toBeNull()
        expect(anon.body.myParticipantId).toBeNull()
        expect(anon.body.participants.map((p: Json) => [p.wallet, p.displayName, p.status, p.amount])).toEqual([
            [null, "0xaaaa…aaaa", "covered", 15 * U],
            [null, "Bob", "owed", 15 * U],
            [null, "Carol", "owed", 15 * U]
        ])
        const stranger = await t.call("GET", `/b/${tokenOf(bill)}`, CAROL)
        expect(stranger.body.participants.every((p: Json) => p.wallet === null)).toBe(true)
        expect(stranger.body.shareUrl).toBeNull()
        const bob = await t.call("GET", `/b/${tokenOf(bill)}`, BOB)
        expect(bob.body.shareUrl).toBe(bill.shareUrl)
        expect(bob.body.participants[1].wallet).toBe(BOB)
        expect((await t.call("GET", `/b/${"x".repeat(43)}`)).status).toBe(404)
        expect((await t.call("GET", "/b/short")).status).toBe(404)
    })

    it("lets a signed-in link holder claim a name-only seat", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const token = tokenOf(bill)
        const seat = bill.participants[2].id
        const claim = (who: string | undefined, body: Record<string, unknown>) => t.call("POST", `/bills/${bill.id}/claim`, who, body)
        expect((await claim(CAROL, { participantId: seat, t: "x".repeat(43) })).status).toBe(403)
        expect((await claim(CAROL, { participantId: seat })).status).toBe(403)
        expect((await claim(undefined, { participantId: seat, t: token })).status).toBe(401)
        expect((await claim(BOB, { participantId: seat, t: token })).body.error).toMatch(/already have a seat/)
        expect((await claim(ALICE, { participantId: seat, t: token })).status).toBe(409)
        expect((await claim(CAROL, { participantId: bill.participants[1].id, t: token })).body.error).toMatch(/already claimed/)
        expect((await claim(CAROL, { participantId: "p_nope", t: token })).status).toBe(404)

        const r = await claim(CAROL, { participantId: seat, t: token })
        expect(r.status).toBe(200)
        expect(r.body.myParticipantId).toBe(seat)
        expect(r.body.participants[2].wallet).toBe(CAROL)
        expect((await t.call("GET", `/bills/${bill.id}`, CAROL)).status).toBe(200)
        expect((await claim(DAVE, { participantId: seat, t: token })).status).toBe(409)
        expect((await t.call("GET", "/requests", CAROL)).body.incoming.map((s: Json) => s.id)).toEqual([bill.id])
    })

    it("answers 'not yours' and 'missing' with the same 404 (info I2)", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const notMine = await t.call("GET", `/bills/${bill.id}`, DAVE)
        const missing = await t.call("GET", "/bills/b_nope", DAVE)
        expect([notMine.status, missing.status]).toEqual([404, 404])
        expect(notMine.body).toEqual(missing.body)
    })

    it("only lets a link holder claim a seat that still owes and has nothing paid", async () => {
        const t = await setup()
        // Dave is a name-only seat marked already paid outside FairPay: covered, nothing to claim.
        const bill = await t.create(ALICE, { ...dinner, participants: [...dinner.participants, { displayName: "Dave", alreadyPaid: true }] })
        const token = tokenOf(bill)
        const [, , carol, dave] = bill.participants
        expect(dave.status).toBe("covered")
        expect(dave.claimable).toBe(false)
        const claim = (who: string, participantId: string) => t.call("POST", `/bills/${bill.id}/claim`, who, { participantId, t: token })
        const covered = await claim(DAVE, dave.id)
        expect(covered.status).toBe(409)
        expect(covered.body.error).toMatch(/nothing to pay/)

        // A seat someone has paid towards from an unbound wallet stays with that payment.
        await t.deps.db.query("UPDATE bill_participants SET paid = $2 WHERE id = $1", [carol.id, 5 * U])
        const linkView = await t.call("GET", `/b/${token}`)
        expect(linkView.body.participants[2].claimable).toBe(false)
        expect((await claim(DAVE, carol.id)).body.error).toMatch(/already paid towards/)
        expect((await t.deps.db.one<{ wallet: string | null }>("SELECT wallet FROM bill_participants WHERE id = $1", [carol.id]))!.wallet).toBeNull()
    })

    it("lets the creator free a seat that has no payment, which makes it claimable again", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const token = tokenOf(bill)
        const [mine, bob, carol] = bill.participants
        const release = (who: string, pid: string) => t.call("POST", `/bills/${bill.id}/seats/${pid}/release`, who)

        // Dave takes Carol's seat from the link.
        expect((await t.call("POST", `/bills/${bill.id}/claim`, DAVE, { participantId: carol.id, t: token })).status).toBe(200)
        expect((await release(DAVE, carol.id)).status).toBe(403)
        expect((await release(BOB, carol.id)).status).toBe(403)
        expect((await t.call("POST", `/bills/${bill.id}/seats/${carol.id}/release`)).status).toBe(401)
        expect((await release(ALICE, "p_nope")).status).toBe(404)
        expect((await release(ALICE, mine.id)).status).toBe(409)

        const freed = await release(ALICE, carol.id)
        expect(freed.status).toBe(200)
        expect(freed.body.participants[2]).toMatchObject({ displayName: "Carol", wallet: null, claimable: true })
        // Dave is no longer in the bill, and the real Carol can claim her seat.
        expect((await t.call("GET", `/bills/${bill.id}`, DAVE)).status).toBe(404)
        expect((await release(ALICE, carol.id)).status).toBe(409)
        expect((await t.call("POST", `/bills/${bill.id}/claim`, CAROL, { participantId: carol.id, t: token })).status).toBe(200)

        // A seat with a payment in FairPay stays with its wallet.
        await t.deps.db.query("UPDATE bill_participants SET paid = $2 WHERE id = $1", [bob.id, 5 * U])
        const paid = await release(ALICE, bob.id)
        expect(paid.status).toBe(409)
        expect(paid.body.error).toMatch(/has paid towards/)
    })

    it("lists my bills and requests", async () => {
        const t = await setup()
        const a = await t.create(ALICE, dinner)
        t.clock.now += 1000
        const b = await t.create(BOB, { title: "Taxi", total: 10 * U, splitType: "fixed", creatorValue: 4 * U, participants: [{ wallet: ALICE, displayName: "Alice", value: 6 * U }] })

        const mine = (await t.call("GET", "/bills", ALICE)).body as BillSummary[]
        expect(mine.map((s) => [s.id, s.role, s.myDue, s.paidCount, s.participantCount, s.total, s.status])).toEqual([
            [b.id, "participant", 6 * U, 1, 2, 10 * U, "open"],
            [a.id, "creator", 0, 1, 3, 45 * U, "open"]
        ])
        const req = (await t.call("GET", "/requests", ALICE)).body
        expect(req.incoming.map((s: Json) => s.id)).toEqual([b.id])
        expect(req.outgoing.map((s: Json) => s.id)).toEqual([a.id])
        expect((await t.call("GET", "/bills", CAROL)).body).toEqual([])
        expect((await t.call("GET", "/requests")).status).toBe(401)
    })

    it("tells each viewer their own seat and whether they can cancel", async () => {
        const t = await setup()
        const a = await t.create(ALICE, dinner)
        const [aliceSeat, bobSeat] = a.participants
        const summary = async (who: string) => ((await t.call("GET", "/bills", who)).body as BillSummary[]).find((s) => s.id === a.id)!

        expect(await summary(ALICE)).toMatchObject({ role: "creator", myParticipantId: aliceSeat.id, canCancel: true })
        expect(await summary(BOB)).toMatchObject({ role: "participant", myParticipantId: bobSeat.id, canCancel: false, myDue: 15 * U })
        let req = (await t.call("GET", "/requests", BOB)).body
        expect(req.incoming[0]).toMatchObject({ id: a.id, myParticipantId: bobSeat.id, canCancel: false })
        req = (await t.call("GET", "/requests", ALICE)).body
        expect(req.outgoing[0]).toMatchObject({ id: a.id, myParticipantId: aliceSeat.id, canCancel: true })

        // A partial payment in FairPay is enough to block cancelling, as POST /cancel does.
        await t.deps.db.query("UPDATE bill_participants SET paid = $1 WHERE id = $2", [5 * U, bobSeat.id])
        expect((await summary(ALICE)).canCancel).toBe(false)
        expect((await t.call("POST", `/bills/${a.id}/cancel`, ALICE)).status).toBe(409)

        const b = await t.create(ALICE, dinner)
        expect((await t.call("POST", `/bills/${b.id}/cancel`, ALICE)).status).toBe(200)
        expect(((await t.call("GET", "/bills", ALICE)).body as BillSummary[]).find((s) => s.id === b.id)).toMatchObject({ status: "cancelled", canCancel: false })
    })

    it("cancels only for the creator and only before anyone paid", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        expect((await t.call("POST", `/bills/${bill.id}/cancel`, BOB)).status).toBe(403)
        const ok = await t.call("POST", `/bills/${bill.id}/cancel`, ALICE)
        expect(ok.status).toBe(200)
        expect(ok.body.status).toBe("cancelled")
        expect((await t.call("POST", `/bills/${bill.id}/cancel`, ALICE)).status).toBe(409)
        expect((await t.call("GET", "/requests", BOB)).body.incoming).toEqual([])
        expect((await t.call("POST", `/bills/${bill.id}/remind`, ALICE)).status).toBe(409)

        const paid = await t.create(ALICE, dinner)
        await t.deps.db.query("UPDATE bill_participants SET paid = $1, status = 'paid' WHERE id = $2", [15 * U, paid.participants[1].id])
        const no = await t.call("POST", `/bills/${paid.id}/cancel`, ALICE)
        expect(no.status).toBe(409)
        expect(no.body.error).toMatch(/already paid/)
    })

    it("reports private payments without payer details", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const pid = bill.participants[1].id
        await t.deps.db.query("UPDATE bill_participants SET paid = $1, status = 'paid', paid_at = 5 WHERE id = $2", [15 * U, pid])
        await t.deps.db.query(
            `INSERT INTO payments (target_kind, target_id, chain_id, tx_hash, log_index, kind, payer, recipient, amount, block_number, verified_at)
             VALUES ('bill', $1, 10143, $2, 0, 'private', 'pool', $3, $4, 1, 1)`,
            [pid, "0x" + "1".repeat(64), ALICE, 15 * U]
        )
        const view = (await t.call("GET", `/b/${tokenOf(bill)}`)).body
        expect(view.participants[1]).toMatchObject({ status: "paid", paidPrivately: true, paid: 15 * U, paidAt: 5, wallet: null })
        expect(view.participants[2].paidPrivately).toBe(false)
    })

    it("reminds unpaid participants with a wallet, at most every 15 minutes", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, {
            ...dinner,
            participants: [{ wallet: BOB, displayName: "Bob" }, { displayName: "Carol" }, { wallet: DAVE, displayName: "Dave", alreadyPaid: true }]
        })
        expect((await t.call("POST", `/bills/${bill.id}/remind`, BOB)).status).toBe(403)
        const r = await t.call("POST", `/bills/${bill.id}/remind`, ALICE)
        expect(r.body).toEqual({ reminded: 1 })
        const acts = await t.deps.db.query<{ title: string }>("SELECT title FROM activity WHERE wallet = $1 ORDER BY id", [BOB])
        expect(acts.map((a) => a.title)).toEqual(["0xaaaa…aaaa requested 11.25 USDC", "Reminder: 0xaaaa…aaaa requested 11.25 USDC"])
        expect((await t.call("POST", `/bills/${bill.id}/remind`, ALICE)).status).toBe(429)
        t.clock.now += 15 * 60_000
        expect((await t.call("POST", `/bills/${bill.id}/remind`, ALICE)).status).toBe(200)
    })

    it("requires the CSRF header on writes", async () => {
        const t = await setup()
        const res = await t.app.request("/api/bills", {
            method: "POST",
            headers: { cookie: await t.signIn(ALICE as `0x${string}`), "content-type": "application/json" },
            body: JSON.stringify(dinner)
        })
        expect(res.status).toBe(403)
    })

    it("limits each creator to 20 new bills an hour", async () => {
        const t = await setup()
        const solo = { title: "Coffee", total: 2 * U, splitType: "equal", participants: [{ displayName: "Sam" }] }
        for (let i = 0; i < 20; i++) await t.create(ALICE, solo)
        // Invalid input doesn't count, but the 21st real bill is refused.
        expect((await t.call("POST", "/bills", ALICE, { ...solo, total: -1 })).status).toBe(400)
        const over = await t.call("POST", "/bills", ALICE, solo)
        expect(over.status).toBe(429)
        expect(over.body.error).toBe("You can create at most 20 bills an hour. Try again later.")
        expect(await t.deps.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM bills WHERE creator = $1", [ALICE])).toEqual({ n: 20 })
        // Per wallet: someone else is unaffected, and the window resets after an hour.
        await t.create(BOB, solo)
        t.clock.now += 60 * 60_000
        await t.create(ALICE, solo)
    })
})

describe("bills with verified payments (routes/pay.ts)", () => {
    it("shows public and private payments, blocks cancel, and settles when everyone has paid", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const [, bob, carol] = bill.participants

        // Bob pays his share publicly from his own wallet.
        const target = await t.call("GET", `/pay/bill/${bob.id}`, BOB)
        expect(target.status).toBe(200)
        expect(target.body).toMatchObject({ recipient: ALICE, due: 15 * U, expectedPayer: BOB })
        const h1 = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: h1, amount: 15 * U, payer: BOB as Wallet, orderRef: target.body.orderRef, recipient: ALICE as Wallet })
        const s1 = await t.call("POST", `/pay/bill/${bob.id}/settle`, BOB, { txHash: h1 })
        expect(s1.body.status, JSON.stringify(s1.body)).toBe("credited")

        let view = (await t.call("GET", `/bills/${bill.id}`, ALICE)).body as Bill
        expect(view.participants[1]).toMatchObject({ status: "paid", paid: 15 * U, paidPrivately: false })
        expect(view.status).toBe("open")
        const cancel = await t.call("POST", `/bills/${bill.id}/cancel`, ALICE)
        expect(cancel.status).toBe(409)
        expect((await t.call("GET", "/requests", BOB)).body.incoming).toEqual([])

        // Carol's name-only seat is paid privately by whoever holds the link.
        const token = tokenOf(bill)
        const ct = await t.call("GET", `/pay/bill/${carol.id}?t=${token}`)
        expect(ct.status).toBe(200)
        const h2 = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: h2, amount: 15 * U, orderRef: ct.body.orderRef })
        const s2 = await t.call("POST", `/pay/bill/${carol.id}/settle?t=${token}`, undefined, { txHash: h2 })
        expect(s2.body.status, JSON.stringify(s2.body)).toBe("credited")

        view = (await t.call("GET", `/b/${token}`)).body as Bill
        expect(view.status).toBe("settled")
        expect(view.participants.map((p) => [p.status, p.paidPrivately, p.wallet])).toEqual([
            ["covered", false, null],
            ["paid", false, null],
            ["paid", true, null]
        ])
        const mine = (await t.call("GET", "/bills", ALICE)).body as BillSummary[]
        expect(mine[0]).toMatchObject({ status: "settled", paidCount: 3, participantCount: 3 })
        expect((await t.call("GET", "/requests", ALICE)).body.outgoing).toEqual([])
    })

    /** Bob pays publicly; Carol's seat is paid privately a minute later. Returns both tx hashes. */
    async function payBobPublicCarolPrivate(t: Awaited<ReturnType<typeof setup>>, bill: Bill, gapMs = 60_000) {
        const [, bob, carol] = bill.participants
        const token = tokenOf(bill)
        const bt = (await t.call("GET", `/pay/bill/${bob.id}`, BOB)).body
        const pub = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: pub, amount: 15 * U, payer: BOB as Wallet, orderRef: bt.orderRef })
        expect((await t.call("POST", `/pay/bill/${bob.id}/settle`, BOB, { txHash: pub })).body.status).toBe("credited")
        t.clock.now += gapMs
        const ct = (await t.call("GET", `/pay/bill/${carol.id}?t=${token}`)).body
        const priv = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: priv, amount: 15 * U, orderRef: ct.orderRef })
        expect((await t.call("POST", `/pay/bill/${carol.id}/settle?t=${token}`, undefined, { txHash: priv })).body.status).toBe("credited")
        return { pub, priv }
    }

    it("links a public payment's transaction for the bill's people, never a private one or for link holders", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const { pub, priv } = await payBobPublicCarolPrivate(t, bill)

        for (const who of [ALICE, BOB]) {
            const view = (await t.call("GET", `/bills/${bill.id}`, who)).body as Bill
            expect(view.participants.map((p) => [p.status, p.paidPrivately, p.txHash])).toEqual([
                ["covered", false, null],
                ["paid", false, pub],
                ["paid", true, null]
            ])
            expect(JSON.stringify(view)).not.toContain(priv)
        }
        // By link the tx would reveal Bob's wallet (the explorer shows the sender), so nobody
        // outside the bill gets it, signed in or not.
        for (const who of [undefined, DAVE]) {
            const view = (await t.call("GET", `/b/${tokenOf(bill)}`, who)).body as Bill
            expect(view.participants.map((p) => p.txHash)).toEqual([null, null, null])
            expect(JSON.stringify(view)).not.toContain(pub)
            expect(JSON.stringify(view)).not.toContain(priv)
        }
        // A participant opening the link is a member and sees the same as by id.
        expect(((await t.call("GET", `/b/${tokenOf(bill)}`, BOB)).body as Bill).participants[1].txHash).toBe(pub)
    })

    it("hides the public tx of a seat that was partly paid privately", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, { ...dinner, participants: [{ wallet: BOB, displayName: "Bob" }] })
        const bob = bill.participants[1]
        expect(bob.amount).toBe(2250 * C)
        const target = (await t.call("GET", `/pay/bill/${bob.id}`, BOB)).body
        // One 5 USDC private note first, then the rest publicly from Bob's wallet.
        const note = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: note, amount: 5 * U, orderRef: target.orderRef })
        expect((await t.call("POST", `/pay/bill/${bob.id}/settle`, BOB, { txHash: note })).body.status).toBe("credited")
        t.clock.now += 60_000
        const rest = txHash()
        t.chain.verifyResult = paidOnChain({ txHash: rest, amount: 1750 * C, payer: BOB as Wallet, orderRef: target.orderRef })
        expect((await t.call("POST", `/pay/bill/${bob.id}/settle`, BOB, { txHash: rest })).body.status).toBe("credited")

        const view = (await t.call("GET", `/bills/${bill.id}`, ALICE)).body as Bill
        expect(view.participants[1]).toMatchObject({ status: "paid", paidPrivately: true, txHash: null })
        expect(JSON.stringify(view)).not.toContain(rest)
        expect(JSON.stringify(view)).not.toContain(note)
    })

    it("links public payments in activity, but not private ones", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const { pub, priv } = await payBobPublicCarolPrivate(t, bill)

        const alice = (await t.call("GET", "/activity", ALICE)).body as ActivityItem[]
        expect(alice.find((a) => a.title === "Bob paid 15.00 USDC")?.txHash).toBe(pub)
        expect(alice.find((a) => a.title === "Confidential payment received")?.txHash).toBeNull()
        expect(alice.filter((a) => a.txHash).map((a) => a.txHash)).toEqual([pub])
        const bob = (await t.call("GET", "/activity", BOB)).body as ActivityItem[]
        expect(bob.find((a) => a.kind === "payment_sent")?.txHash).toBe(pub)
        expect(bob.filter((a) => a.txHash)).toHaveLength(1)
        for (const items of [alice, bob]) expect(JSON.stringify(items)).not.toContain(priv)
        // Someone else's feed never picks up these payments.
        const dave = (await t.call("GET", "/activity", DAVE)).body as ActivityItem[]
        expect(JSON.stringify(dave)).not.toContain(pub)
    })

    it("shows no activity link when two payments for one bill land in the same moment", async () => {
        const t = await setup()
        const bill = await t.create(ALICE, dinner)
        const { pub, priv } = await payBobPublicCarolPrivate(t, bill, 0)
        const alice = (await t.call("GET", "/activity", ALICE)).body as ActivityItem[]
        // Ambiguous: either payment could be behind either entry, so neither gets a link.
        expect(alice.filter((a) => a.kind === "payment_received").map((a) => a.txHash)).toEqual([null, null])
        expect(JSON.stringify(alice)).not.toContain(priv)
        // Bob's own "You paid" is still unambiguous: only one payment came from his wallet.
        const bob = (await t.call("GET", "/activity", BOB)).body as ActivityItem[]
        expect(bob.find((a) => a.kind === "payment_sent")?.txHash).toBe(pub)
    })
})
