// Personal bill splitting: create a bill, share it by link, see who has paid. Payments themselves
// go through routes/pay.ts, which verifies them on-chain; this module never marks anything paid.

import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { requireWallet } from "../auth.js"
import { computeShares, MAX_PEOPLE, SplitError, usdc, type ComputableSplit } from "../bills.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { bool, HttpError, optStr, rateLimiter, readJson, str, wallet as walletInput } from "../http.js"
import { newId, newOrderRef, newToken } from "../ids.js"
import { appUrlOf } from "../origin.js"
import type { Bill, BillParticipant, BillSummary, Wallet } from "../../shared/types.js"

const MAX_BODY = 32 * 1024
const MAX_LIST = 200
const REMIND_COOLDOWN_MS = 15 * 60_000
const BILLS_PER_HOUR = 20
const SPLITS: ComputableSplit[] = ["equal", "fixed", "percent", "shares"]
const ID = /^[A-Za-z0-9_-]{1,64}$/
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

type BillRow = {
    id: string
    creator: Wallet
    recipient: Wallet
    title: string
    note: string | null
    total: number
    split_type: Bill["splitType"]
    status: Bill["status"]
    share_token: string
    source: Bill["source"]
    order_id: string | null
    created_at: number
    settled_at: number | null
}

type ParticipantRow = {
    id: string
    wallet: Wallet | null
    display_name: string
    amount: number
    tip: number
    paid: number
    status: BillParticipant["status"]
    paid_at: number | null
    paid_privately: boolean
    /** The latest public payment's tx; null when there is none. */
    public_tx: `0x${string}` | null
}

type SummaryRow = {
    id: string
    title: string
    total: number
    status: Bill["status"]
    creator: Wallet
    recipient: Wallet
    created_at: number
    participant_count: number
    paid_count: number
    my_amount: number | null
    my_tip: number | null
    my_paid: number | null
    my_status: BillParticipant["status"] | null
    my_id: string | null
    any_paid: boolean
}

type ParsedBill = {
    title: string
    note: string | null
    total: number
    splitType: ComputableSplit
    creatorValue: number | undefined
    participants: { wallet: Wallet | null; displayName: string | null; value: number | undefined; alreadyPaid: boolean }[]
}

export function shortAddress(w: string) {
    return `${w.slice(0, 6)}…${w.slice(-4)}`
}

/** Strict body parsing. Every field is checked and capped before anything touches the database. */
function parseCreateBill(body: unknown, creator: Wallet): ParsedBill {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send a JSON body with title, total, splitType and participants.")
    const b = body as Record<string, unknown>
    const title = str(b.title, { min: 1, max: 80, name: "Title" })
    const note = optStr(b.note, { max: 280, name: "Note" })
    if (typeof b.splitType !== "string" || !SPLITS.includes(b.splitType as ComputableSplit)) {
        throw new HttpError(400, "Split type must be equal, fixed, percent or shares.")
    }
    const splitType = b.splitType as ComputableSplit
    if (typeof b.total !== "number" || !Number.isSafeInteger(b.total)) throw new HttpError(400, "The total must be a whole number of micro-USDC.")
    const total = b.total
    const value = (v: unknown, who: string) => {
        if (v === undefined || v === null || splitType === "equal") return undefined
        if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new HttpError(400, `The value for ${who} must be a whole number.`)
        return v
    }
    const creatorValue = value(b.creatorValue, "your own share")
    if (!Array.isArray(b.participants) || b.participants.length === 0) throw new HttpError(400, "Add at least one person to split with.")
    if (b.participants.length > MAX_PEOPLE - 1) throw new HttpError(400, `A bill can have at most ${MAX_PEOPLE} people, including you.`)

    const seen = new Set<string>()
    const participants = b.participants.map((raw, i) => {
        const label = `participant ${i + 1}`
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `Participant ${i + 1} is not valid.`)
        const p = raw as Record<string, unknown>
        let w: Wallet | null = null
        if (p.wallet !== undefined && p.wallet !== null && p.wallet !== "") {
            w = walletInput(p.wallet, `The wallet of ${label}`)
            if (w === creator) throw new HttpError(400, "You are already in the bill. Leave your own wallet out of the participants.")
            if (seen.has(w)) throw new HttpError(400, `${shortAddress(w)} is in the bill twice.`)
            seen.add(w)
        }
        const hasName = typeof p.displayName === "string" && p.displayName.trim() !== ""
        if (!hasName && !w) throw new HttpError(400, `Give ${label} a name or a wallet address.`)
        const displayName = hasName ? str(p.displayName, { min: 1, max: 60, name: `The name of ${label}` }) : null
        const alreadyPaid = p.alreadyPaid === undefined || p.alreadyPaid === null ? false : bool(p.alreadyPaid, `"Already paid" for ${label}`)
        return { wallet: w, displayName, value: value(p.value, displayName ?? label), alreadyPaid }
    })
    return { title, note, total, splitType, creatorValue, participants }
}

async function profileNames(db: Db, wallets: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(wallets)]
    const names = new Map<string, string>()
    if (unique.length === 0) return names
    const params = unique.map((_, i) => `$${i + 1}`).join(", ")
    const rows = await db.query<{ wallet: string; display_name: string | null }>(
        `SELECT wallet, display_name FROM profiles WHERE wallet IN (${params})`,
        unique
    )
    for (const r of rows) if (r.display_name) names.set(r.wallet, r.display_name)
    return names
}

function sameToken(a: string, b: string) {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

export function billRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    const origin = appUrlOf(deps)
    // Each bill pings every participant's activity feed, so one wallet can't create them endlessly.
    const createLimit = rateLimiter(BILLS_PER_HOUR, 60 * 60_000, deps.now)

    async function loadBill(q: Db, where: "id" | "share_token", key: string) {
        const bill = await q.one<BillRow>(`SELECT * FROM bills WHERE ${where} = $1`, [key])
        if (!bill) return undefined
        // Participants are stored with ids sorted to match the order they were entered (see
        // POST /bills), so ORDER BY id keeps the creator first and the rest in input order.
        const participants = await q.query<ParticipantRow>(
            `SELECT p.id, p.wallet, p.display_name, p.amount, p.tip, p.paid, p.status, p.paid_at,
                    EXISTS (SELECT 1 FROM payments y WHERE y.target_kind = 'bill' AND y.target_id = p.id AND y.kind = 'private') AS paid_privately,
                    (SELECT y.tx_hash FROM payments y WHERE y.target_kind = 'bill' AND y.target_id = p.id AND y.kind = 'public'
                     ORDER BY y.id DESC LIMIT 1) AS public_tx
             FROM bill_participants p WHERE p.bill_id = $1
             ORDER BY (p.wallet IS NOT NULL AND p.wallet = $2) DESC, p.id COLLATE "C"`,
            [bill.id, bill.recipient]
        )
        return { bill, participants }
    }

    async function loadById(id: string) {
        if (!ID.test(id)) throw new HttpError(404, "No bill with that id.")
        const found = await loadBill(db, "id", id)
        if (!found) throw new HttpError(404, "No bill with that id.")
        return found
    }

    const isMember = (bill: BillRow, participants: ParticipantRow[], viewer: Wallet | null) =>
        viewer !== null && (bill.creator === viewer || bill.recipient === viewer || participants.some((p) => p.wallet === viewer))

    /**
     * The API shape. `full` is for the creator and participants; a link holder (full = false)
     * sees names and status but not other people's wallets, and gets no share URL.
     */
    async function view(bill: BillRow, participants: ParticipantRow[], viewer: Wallet | null, full: boolean): Promise<Bill> {
        const names = await profileNames(db, [bill.recipient])
        const mine = viewer ? participants.find((p) => p.wallet === viewer) : undefined
        return {
            id: bill.id,
            creator: bill.creator,
            recipient: bill.recipient,
            recipientName: names.get(bill.recipient) ?? shortAddress(bill.recipient),
            title: bill.title,
            note: bill.note,
            total: Number(bill.total),
            splitType: bill.split_type,
            status: bill.status,
            source: bill.source,
            orderId: bill.order_id,
            shareUrl: full ? `${origin}/b/${bill.share_token}` : null,
            createdAt: Number(bill.created_at),
            settledAt: bill.settled_at === null ? null : Number(bill.settled_at),
            participants: participants.map((p) => ({
                id: p.id,
                wallet: full || (viewer !== null && p.wallet === viewer) ? p.wallet : null,
                displayName: p.display_name,
                amount: Number(p.amount),
                tip: Number(p.tip),
                paid: Number(p.paid),
                status: p.status,
                paidPrivately: Boolean(p.paid_privately),
                paidAt: p.paid_at === null ? null : Number(p.paid_at),
                claimable: p.wallet === null && p.status === "owed" && Number(p.paid) === 0 && bill.status === "open",
                // A public tx names the payer's wallet, so link holders (who don't see wallets) get
                // none. A seat with any private note gets none either: its public tx would tie the
                // payer to the private part too.
                txHash: full && !p.paid_privately && p.public_tx ? p.public_tx : null
            })),
            myParticipantId: mine?.id ?? null
        }
    }

    async function summaries(me: Wallet): Promise<BillSummary[]> {
        const rows = await db.query<SummaryRow>(
            `SELECT b.id, b.title, b.total, b.status, b.creator, b.recipient, b.created_at,
                    (SELECT count(*)::int FROM bill_participants x WHERE x.bill_id = b.id) AS participant_count,
                    (SELECT count(*)::int FROM bill_participants x WHERE x.bill_id = b.id AND x.status IN ('paid', 'covered')) AS paid_count,
                    EXISTS (SELECT 1 FROM bill_participants x WHERE x.bill_id = b.id AND x.paid > 0) AS any_paid,
                    me.id AS my_id, me.amount AS my_amount, me.tip AS my_tip, me.paid AS my_paid, me.status AS my_status
             FROM bills b
             LEFT JOIN bill_participants me ON me.bill_id = b.id AND me.wallet = $1
             WHERE b.creator = $1 OR b.recipient = $1 OR me.id IS NOT NULL
             ORDER BY b.created_at DESC, b.id
             LIMIT ${MAX_LIST}`,
            [me]
        )
        return rows.map((r) => {
            const owes = r.status === "open" && r.my_status === "owed"
            return {
                id: r.id,
                title: r.title,
                total: Number(r.total),
                status: r.status,
                role: r.creator === me || r.recipient === me ? "creator" : "participant",
                myDue: owes ? Math.max(0, Number(r.my_amount) + Number(r.my_tip) - Number(r.my_paid)) : 0,
                paidCount: Number(r.paid_count),
                participantCount: Number(r.participant_count),
                createdAt: Number(r.created_at),
                myParticipantId: r.my_id ?? null,
                // Same rule as POST /bills/:id/cancel, so lists only offer Cancel when it would work.
                canCancel: r.creator === me && r.status === "open" && !r.any_paid
            }
        })
    }

    async function activity(q: Db, w: Wallet, kind: "bill_created" | "bill_request", title: string, detail: string | null, billId: string) {
        await q.query("INSERT INTO activity (wallet, kind, title, detail, link, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
            w,
            kind,
            title.slice(0, 200),
            detail === null ? null : detail.slice(0, 400),
            `/bills/${billId}`,
            deps.now()
        ])
    }

    app.post("/bills", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const input = parseCreateBill(await readJson(c, MAX_BODY), me)
        let amounts: number[]
        try {
            amounts = computeShares({
                total: input.total,
                splitType: input.splitType,
                values: input.participants.map((p) => p.value),
                creatorValue: input.creatorValue,
                names: input.participants.map((p, i) => p.displayName ?? `participant ${i + 1}`)
            })
        } catch (err) {
            if (err instanceof SplitError) throw new HttpError(400, err.message)
            throw err
        }
        // Counted per creator wallet (not IP), after validation so typos don't use up the allowance.
        if (!createLimit.hit(me)) throw new HttpError(429, `You can create at most ${BILLS_PER_HOUR} bills an hour. Try again later.`)

        const names = await profileNames(db, [me, ...input.participants.flatMap((p) => (p.wallet ? [p.wallet] : []))])
        const nameOf = (w: Wallet) => names.get(w) ?? shortAddress(w)
        const creatorName = nameOf(me)
        const people = [
            { wallet: me as Wallet | null, displayName: creatorName, covered: true },
            ...input.participants.map((p) => ({
                wallet: p.wallet,
                displayName: p.displayName ?? nameOf(p.wallet!),
                covered: p.alreadyPaid
            }))
        ].map((p, i) => ({ ...p, amount: amounts[i], covered: p.covered || amounts[i] === 0 }))

        // Random ids, sorted, then handed out in entry order: the database has no position column,
        // and this lets ORDER BY id return people in the order they were entered.
        const ids = people.map(() => newId("p")).sort()
        const billId = newId("b")
        const token = newToken()
        const now = deps.now()
        // Nothing to collect in-app when everyone is covered (all settled outside FairPay).
        const settled = people.every((p) => p.covered)
        const refs = ids.map((pid) => newOrderRef(billId, pid))

        await db.tx(async (q) => {
            await q.query(
                `INSERT INTO bills (id, creator, recipient, title, note, total, split_type, status, share_token, source, created_at, settled_at)
                 VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, $10)`,
                [billId, me, input.title, input.note, input.total, input.splitType, settled ? "settled" : "open", token, now, settled ? now : null]
            )
            for (const [i, p] of people.entries()) {
                await q.query(
                    `INSERT INTO bill_participants (id, bill_id, wallet, display_name, amount, status, order_ref, secret)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [ids[i], billId, p.wallet, p.displayName, p.amount, p.covered ? "covered" : "owed", refs[i].orderRef.toLowerCase(), refs[i].secret]
                )
            }
            await activity(q, me, "bill_created", `You split "${input.title}"`, `${usdc(input.total)} USDC between ${people.length} people`, billId)
            for (const p of people.slice(1)) {
                if (!p.wallet) continue
                if (p.covered) await activity(q, p.wallet, "bill_request", `${creatorName} added you to "${input.title}"`, "Nothing to pay in FairPay.", billId)
                else await activity(q, p.wallet, "bill_request", `${creatorName} requested ${usdc(p.amount)} USDC`, input.title, billId)
            }
        })

        const created = (await loadBill(db, "id", billId))!
        return c.json(await view(created.bill, created.participants, me, true), 201)
    })

    app.get("/bills", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        return c.json(await summaries(me))
    })

    app.get("/requests", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const all = (await summaries(me)).filter((s) => s.status === "open")
        return c.json({
            incoming: all.filter((s) => s.role === "participant" && s.myDue > 0),
            outgoing: all.filter((s) => s.role === "creator" && s.paidCount < s.participantCount)
        })
    })

    app.get("/bills/:id", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const { bill, participants } = await loadById(c.req.param("id"))
        // The same answer as a missing id, so ids can't be probed.
        if (!isMember(bill, participants, me)) throw new HttpError(404, "No bill with that id.")
        return c.json(await view(bill, participants, me, true))
    })

    app.get("/b/:token", async (c) => {
        const token = c.req.param("token")
        const found = TOKEN.test(token) ? await loadBill(db, "share_token", token) : undefined
        if (!found) throw new HttpError(404, "This bill link is not valid.")
        const viewer = (c.get("wallet")?.toLowerCase() as Wallet | undefined) ?? null
        return c.json(await view(found.bill, found.participants, viewer, isMember(found.bill, found.participants, viewer)))
    })

    app.post("/bills/:id/claim", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const id = c.req.param("id")
        const b = await readJson(c, MAX_BODY)
        if (typeof b.participantId !== "string" || !ID.test(b.participantId)) throw new HttpError(400, "Choose which name is you.")
        if (typeof b.t !== "string" || !TOKEN.test(b.t)) throw new HttpError(403, "Open the bill from its share link to claim a name.")
        const { bill, participants } = await loadById(id)
        if (!sameToken(b.t, bill.share_token)) throw new HttpError(403, "Open the bill from its share link to claim a name.")
        if (bill.status !== "open") throw new HttpError(409, `This bill is ${bill.status}.`)
        if (bill.creator === me || bill.recipient === me) throw new HttpError(409, "You created this bill, so you can't take another seat in it.")
        if (participants.some((p) => p.wallet === me)) throw new HttpError(409, "You already have a seat in this bill.")
        const seat = participants.find((p) => p.id === b.participantId)
        if (!seat) throw new HttpError(404, "That name is not in this bill.")
        if (seat.wallet !== null) throw new HttpError(409, "Someone has already claimed that name.")
        // Only a seat that still owes and has nothing paid: claiming binds who may pay it publicly,
        // and claiming a covered seat would only make the claimer a member who sees every wallet.
        if (seat.status !== "owed") throw new HttpError(409, "That seat has nothing to pay, so there is nothing to claim.")
        if (Number(seat.paid) > 0) throw new HttpError(409, "Someone has already paid towards that seat, so it can't be claimed.")
        try {
            // The WHERE repeats every check, so two simultaneous claims of one seat (or a claim
            // racing a payment or a cancel) end in a clean conflict.
            const rows = await db.query(
                `UPDATE bill_participants SET wallet = $1
                 WHERE id = $2 AND bill_id = $3 AND wallet IS NULL AND status = 'owed' AND paid = 0
                   AND EXISTS (SELECT 1 FROM bills WHERE id = $3 AND status = 'open')
                 RETURNING id`,
                [me, seat.id, bill.id]
            )
            if (rows.length === 0) throw new HttpError(409, "That seat can't be claimed any more. Reload the bill.")
        } catch (err) {
            if (err instanceof HttpError) throw err
            // UNIQUE (bill_id, wallet): this wallet claimed another seat at the same moment.
            if (/unique|duplicate/i.test(String((err as Error)?.message))) throw new HttpError(409, "You already have a seat in this bill.")
            throw err
        }
        const fresh = (await loadBill(db, "id", bill.id))!
        return c.json(await view(fresh.bill, fresh.participants, me, true))
    })

    /**
     * The creator frees a seat someone holds (claimed by the wrong person, or added with the wrong
     * wallet): the name stays and the seat is claimable again. Only while nothing has been paid
     * towards it, because a payment is tied to the wallet that made it.
     */
    app.post("/bills/:id/seats/:participantId/release", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const { bill } = await loadById(c.req.param("id"))
        if (bill.creator !== me) throw new HttpError(403, "Only the person who created this bill can free a seat.")
        const pid = c.req.param("participantId")
        if (!ID.test(pid)) throw new HttpError(404, "That seat is not in this bill.")
        await db.tx(async (q) => {
            // The bill, then the seat: the order settle (routes/pay.ts) locks them in, so a payment
            // being credited right now either lands first (and blocks this) or waits for it.
            await q.query("SELECT 1 FROM bills WHERE id = $1 FOR UPDATE", [bill.id])
            const seat = await q.one<{ wallet: Wallet | null; paid: number }>(
                "SELECT wallet, paid FROM bill_participants WHERE id = $1 AND bill_id = $2 FOR UPDATE",
                [pid, bill.id]
            )
            if (!seat) throw new HttpError(404, "That seat is not in this bill.")
            if (seat.wallet === null) throw new HttpError(409, "Nobody holds that seat.")
            if (seat.wallet === bill.creator || seat.wallet === bill.recipient) throw new HttpError(409, "That's your own seat.")
            const paidHere = await q.one("SELECT 1 FROM payments WHERE target_kind = 'bill' AND target_id = $1 LIMIT 1", [pid])
            if (Number(seat.paid) > 0 || paidHere) throw new HttpError(409, "Someone has paid towards that seat in FairPay, so it can't be freed.")
            await q.query("UPDATE bill_participants SET wallet = NULL WHERE id = $1", [pid])
        })
        const fresh = (await loadBill(db, "id", bill.id))!
        return c.json(await view(fresh.bill, fresh.participants, me, true))
    })

    app.post("/bills/:id/cancel", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const { bill } = await loadById(c.req.param("id"))
        if (bill.creator !== me) throw new HttpError(403, "Only the person who created this bill can cancel it.")
        if (bill.status !== "open") throw new HttpError(409, `This bill is already ${bill.status}.`)
        await db.tx(async (q) => {
            // Lock the bill, then its participant rows: the same order settle (routes/pay.ts) takes
            // them, so they can't deadlock, and a payment being credited right now either lands
            // before this check or waits and then sees the bill is no longer open.
            const fresh = await q.one<{ status: string }>("SELECT status FROM bills WHERE id = $1 FOR UPDATE", [bill.id])
            const seats = await q.query<{ paid: number }>("SELECT paid FROM bill_participants WHERE bill_id = $1 FOR UPDATE", [bill.id])
            if (fresh && fresh.status !== "open") throw new HttpError(409, `This bill is already ${fresh.status}.`)
            if (seats.some((s) => Number(s.paid) > 0)) throw new HttpError(409, "Someone has already paid in FairPay, so this bill can't be cancelled.")
            await q.query("UPDATE bills SET status = 'cancelled' WHERE id = $1", [bill.id])
        })
        const fresh = (await loadBill(db, "id", bill.id))!
        return c.json(await view(fresh.bill, fresh.participants, me, true))
    })

    app.post("/bills/:id/remind", async (c) => {
        const me = requireWallet(c).toLowerCase() as Wallet
        const { bill, participants } = await loadById(c.req.param("id"))
        if (bill.creator !== me) throw new HttpError(403, "Only the person who created this bill can send reminders.")
        if (bill.status !== "open") throw new HttpError(409, `This bill is ${bill.status}.`)
        const now = deps.now()
        const last = await db.one<{ at: number }>(
            "SELECT max(created_at) AS at FROM activity WHERE kind = 'bill_request' AND link = $1 AND title LIKE 'Reminder:%'",
            [`/bills/${bill.id}`]
        )
        if (last?.at !== null && last?.at !== undefined && now - Number(last.at) < REMIND_COOLDOWN_MS) {
            const wait = Math.ceil((REMIND_COOLDOWN_MS - (now - Number(last.at))) / 60_000)
            throw new HttpError(429, `You sent a reminder recently. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`)
        }
        const unpaid = participants.filter((p) => p.wallet && p.status === "owed" && p.amount + p.tip - p.paid > 0)
        const names = await profileNames(db, [me])
        const from = names.get(me) ?? shortAddress(me)
        await db.tx(async (q) => {
            for (const p of unpaid) {
                await activity(q, p.wallet!, "bill_request", `Reminder: ${from} requested ${usdc(p.amount + p.tip - p.paid)} USDC`, bill.title, bill.id)
            }
        })
        return c.json({ reminded: unpaid.length })
    })

    return app
}
