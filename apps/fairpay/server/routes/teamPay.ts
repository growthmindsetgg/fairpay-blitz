// FairEats Team pay: the owner pays a staff member straight from their own wallet, with one
// ERC-20 transfer of the deployment's USDC, and FairPay keeps a verified history. No contract of
// ours holds the money (a payroll escrow is part 2). Mounted by restaurantRoutes.
//
// Owner only, like the money view (routes/money.ts): every /team-pay endpoint answers anyone else
// with the same 404 as an unknown restaurant id. The one exception is /team-pay/mine, where a staff
// member reads the payments they received from this restaurant.
//
// The browser sends the transaction hash after the wallet sent it; the server records nothing it
// hasn't checked on-chain (server/transfers.ts): the transaction succeeded in a canonical block
// with the payments' confirmations, and its only Transfer of the deployment's token moved exactly
// the amount from the restaurant owner's wallet to a wallet on this restaurant's staff. One
// transfer is recorded once: UNIQUE(chain_id, tx_hash, log_index), and the table is append-only.
//
// Privacy: these are public transfers. Anyone can see on Monad that the owner's wallet paid the
// staff wallet and how much. Nothing here touches guests' orders or payments.

import { Hono } from "hono"
import { FairPayError } from "@fairpay/sdk"
import { getAddress, type Hash } from "viem"
import type { StaffMember, TeamMember, TeamPayout, TeamPayRecordResult, TeamPayView, Wallet } from "../../shared/types.js"
import { requireWallet } from "../auth.js"
import type { AppEnv, Db, Deps } from "../context.js"
import { fmtUsdc, getRestaurant, loadStaff, roleFor, type RestaurantRow } from "../faireats.js"
import { HttpError, int, limit, optStr, rateLimiter, readJson, wallet as walletInput } from "../http.js"
import type { TransferResult } from "../transfers.js"
import { addActivity } from "./activity.js"

const PAGE = 25
const MAX_PAGE = 100
const MAX_CSV_ROWS = 10_000
const PAYOUT_ID = /^[1-9][0-9]{0,15}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/
/** 100,000 USDC in micro-USDC: far above any testnet wage, far below 2^53. */
export const MAX_TEAM_PAYOUT = 100_000 * 1_000_000
const CENT = 10_000

/** Not found and not the owner get the same answer, so restaurant ids can't be probed. */
async function requireOwner(db: Db, id: string, me: Wallet): Promise<RestaurantRow> {
    const r = await getRestaurant(db, id)
    if (!r || r.owner_wallet !== me) throw new HttpError(404, "No restaurant with that id.")
    return r
}

function pageSize(v: string | undefined) {
    if (v === undefined || v === "") return PAGE
    if (!/^[0-9]{1,3}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PAGE) throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE}.`)
    return Number(v)
}

function beforeId(v: string | undefined) {
    if (v === undefined) return null
    if (!PAYOUT_ID.test(v)) throw new HttpError(400, "before must be a payout id.")
    return Number(v)
}

type PayoutRow = {
    id: number
    restaurant_id: string
    chain_id: number
    tx_hash: Hash
    log_index: number
    payer: Wallet
    recipient: Wallet
    recipient_name: string
    recipient_role: StaffMember["role"]
    amount: number
    note: string | null
    block_number: number
    verified_at: number
}

function toPayout(r: PayoutRow): TeamPayout {
    return {
        id: Number(r.id),
        at: Number(r.verified_at),
        amount: Number(r.amount),
        note: r.note,
        recipient: { wallet: r.recipient, name: r.recipient_name, role: r.recipient_role },
        payer: r.payer,
        proof: { chainId: Number(r.chain_id), txHash: r.tx_hash, logIndex: Number(r.log_index), blockNumber: Number(r.block_number) }
    }
}

/** A page of payouts, newest first. `extra` narrows it (e.g. to one recipient) with $3 onwards. */
async function payoutPage(db: Db, restaurantId: string, size: number, before: number | null, extra?: { sql: string; params: unknown[] }) {
    const params: unknown[] = [restaurantId, before ?? Number.MAX_SAFE_INTEGER, ...(extra?.params ?? [])]
    const rows = await db.query<PayoutRow>(
        `SELECT * FROM team_payouts WHERE restaurant_id = $1 AND id < $2${extra ? ` AND ${extra.sql}` : ""} ORDER BY id DESC LIMIT ${size + 1}`,
        params
    )
    const payouts = rows.slice(0, size).map(toPayout)
    return { payouts, next: rows.length > size ? String(payouts[payouts.length - 1]!.id) : null }
}

/** micro-USDC as a plain decimal for spreadsheets: 5000000 -> "5.000000". */
const usdcCell = (micro: number) => `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`

/** A CSV cell. Text that a spreadsheet would run as a formula gets a leading apostrophe. */
function csvCell(v: string | number | null) {
    let s = v === null ? "" : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Where a staff member's Team pay notes link: their own "My pay" tab. */
export const myPayLink = (restaurantId: string) => `/business/faireats/manage/${restaurantId}?tab=mypay`

export function teamPayRoutes(deps: Deps): Hono<AppEnv> {
    const { db } = deps
    const app = new Hono<AppEnv>()
    // Recording a payout costs several RPC calls, and the browser asks again every 2 seconds while
    // the chain confirms (about 30 a minute for one payout).
    const limits = {
        record: rateLimiter(60, 60_000, deps.now),
        recordWallet: rateLimiter(60, 60_000, deps.now),
        csv: rateLimiter(10, 60_000, deps.now)
    }

    app.get("/restaurants/:id/team-pay", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        const [staff, sums, page] = await Promise.all([
            loadStaff(db, r.id),
            db.query<{ recipient: Wallet; total: number; n: number; last: number }>(
                `SELECT recipient, COALESCE(SUM(amount), 0)::bigint AS total, COUNT(*)::int AS n, MAX(verified_at) AS last
                 FROM team_payouts WHERE restaurant_id = $1 GROUP BY recipient`,
                [r.id]
            ),
            payoutPage(db, r.id, PAGE, null)
        ])
        const byWallet = new Map(sums.map((s) => [s.recipient, s]))
        const members: TeamMember[] = staff.map((s) => {
            const x = byWallet.get(s.wallet)
            return { ...s, paidTotal: Number(x?.total ?? 0), payCount: Number(x?.n ?? 0), lastPaidAt: x ? Number(x.last) : null }
        })
        const body: TeamPayView = { owner: r.owner_wallet, staff: members, ...page }
        return c.json(body)
    })

    app.get("/restaurants/:id/team-pay/payouts", async (c) => {
        const me = requireWallet(c)
        const r = await requireOwner(db, c.req.param("id"), me)
        return c.json(await payoutPage(db, r.id, pageSize(c.req.query("limit")), beforeId(c.req.query("before"))))
    })

    app.get("/restaurants/:id/team-pay/payouts.csv", async (c) => {
        const me = requireWallet(c)
        limit(c, limits.csv, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const rows = await db.query<PayoutRow>(`SELECT * FROM team_payouts WHERE restaurant_id = $1 ORDER BY id DESC LIMIT ${MAX_CSV_ROWS}`, [r.id])
        const head = ["verified_at_utc", "name", "role", "wallet", "amount_usdc", "note", "payer", "chain_id", "tx_hash", "log_index", "block"]
        const lines = rows.map(toPayout).map((p) =>
            [
                new Date(p.at).toISOString(),
                p.recipient.name,
                p.recipient.role,
                p.recipient.wallet,
                usdcCell(p.amount),
                p.note,
                p.payer,
                p.proof.chainId,
                p.proof.txHash,
                p.proof.logIndex,
                p.proof.blockNumber
            ]
                .map(csvCell)
                .join(",")
        )
        const day = new Date(deps.now()).toISOString().slice(0, 10)
        c.header("Content-Type", "text/csv; charset=utf-8")
        c.header("Content-Disposition", `attachment; filename="${r.slug}-team-pay-${day}.csv"`)
        return c.body([head.join(","), ...lines].join("\r\n") + "\r\n")
    })

    // A staff member's own payments from this restaurant. Current staff, or anyone this restaurant
    // has paid; everyone else gets the same 404 as an unknown id.
    app.get("/restaurants/:id/team-pay/mine", async (c) => {
        const me = requireWallet(c)
        const r = await getRestaurant(db, c.req.param("id"))
        if (!r) throw new HttpError(404, "No restaurant with that id.")
        const page = await payoutPage(db, r.id, pageSize(c.req.query("limit")), beforeId(c.req.query("before")), { sql: "recipient = $3", params: [me] })
        if (page.payouts.length === 0) {
            const role = await roleFor(db, r.id, me)
            if (role === null || role === "owner") throw new HttpError(404, "No restaurant with that id.")
        }
        return c.json(page)
    })

    // Body: { wallet, amount (micro-USDC, whole cents), note?, txHash }. Answers 202 "pending" while
    // the chain hasn't confirmed the transfer; the browser asks again with the same body.
    app.post("/restaurants/:id/team-pay", async (c) => {
        limit(c, limits.record)
        const me = requireWallet(c)
        limit(c, limits.recordWallet, me)
        const r = await requireOwner(db, c.req.param("id"), me)
        const b = await readJson(c, 4 * 1024)
        const to = walletInput(b.wallet, "Staff wallet")
        const amount = int(b.amount, { min: CENT, max: MAX_TEAM_PAYOUT, name: "Amount" })
        if (amount % CENT !== 0) throw new HttpError(400, "Amount must be whole cents.")
        const note = optStr(b.note, { max: 140, name: "Note" })
        if (typeof b.txHash !== "string" || !HASH32.test(b.txHash)) throw new HttpError(400, "txHash must be a transaction hash.")
        const txHash = b.txHash.toLowerCase() as Hash
        const chainId = deps.chain.deployment.chainId

        // Already recorded (a retry whose answer was lost, or a second tab): the same answer again.
        const replay = await findRecorded(db, chainId, txHash)
        if (replay) return c.json(replayResult(replay, r.id, to, amount))

        const staff = await db.one<{ role: StaffMember["role"]; display_name: string }>(
            "SELECT role, display_name FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2",
            [r.id, to]
        )
        if (!staff) throw new HttpError(400, "That wallet isn't on this restaurant's staff.")

        let v: TransferResult
        try {
            v = await deps.chain.verifyTransfer({ txHash, from: getAddress(r.owner_wallet), to: getAddress(to), amount: BigInt(amount) })
        } catch (err) {
            if (err instanceof FairPayError && err.code === "INVALID_INPUT") throw new HttpError(400, "Malformed payment.")
            console.error("team pay verification:", err instanceof Error ? err.message.split("\n")[0] : err)
            throw new HttpError(502, "Could not check the payment on-chain right now. Try again shortly.")
        }
        if (v.status === "pending") {
            const body: TeamPayRecordResult = { status: "pending", reason: "Waiting for the transaction to be confirmed." }
            return c.json(body, 202)
        }
        if (v.status === "rejected") {
            const body: TeamPayRecordResult = { status: "rejected", reason: `Not recorded: ${v.reason}.` }
            return c.json(body)
        }
        const t = v.transfer
        if (t.chainId !== chainId) return c.json({ status: "rejected", reason: "Not recorded: wrong chain." } satisfies TeamPayRecordResult)

        const now = deps.now()
        const result = await db.tx(async (q): Promise<TeamPayRecordResult> => {
            // Re-read under a row lock: the staff member must still be on the staff when it is recorded.
            const fresh = await q.one<{ role: StaffMember["role"]; display_name: string }>(
                "SELECT role, display_name FROM restaurant_staff WHERE restaurant_id = $1 AND wallet = $2 FOR UPDATE",
                [r.id, to]
            )
            if (!fresh) return { status: "rejected", reason: "Not recorded: that wallet isn't on this restaurant's staff any more." }
            const row = await q.one<PayoutRow>(
                `INSERT INTO team_payouts (restaurant_id, chain_id, tx_hash, log_index, payer, recipient, recipient_name, recipient_role, amount, note, block_number, verified_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING RETURNING *`,
                [r.id, t.chainId, t.txHash.toLowerCase(), t.logIndex, t.from.toLowerCase(), t.to.toLowerCase(), fresh.display_name, fresh.role, amount, note, Number(t.blockNumber), now]
            )
            if (!row) {
                // Another request recorded it a moment ago.
                const other = await findRecorded(q, chainId, txHash)
                return other ? replayResult(other, r.id, to, amount) : { status: "rejected", reason: "Not recorded: this transaction is already recorded." }
            }
            await addActivity(
                q,
                {
                    wallet: to,
                    kind: "payment_received",
                    title: `You were paid ${fmtUsdc(amount)} USDC by ${r.name}`,
                    detail: note,
                    link: myPayLink(r.id)
                },
                now
            )
            return { status: "recorded", payout: toPayout(row), duplicate: false }
        })
        return c.json(result)
    })

    return app
}

async function findRecorded(db: Db, chainId: number, txHash: Hash) {
    return db.one<PayoutRow>("SELECT * FROM team_payouts WHERE chain_id = $1 AND tx_hash = $2 ORDER BY log_index LIMIT 1", [chainId, txHash.toLowerCase()])
}

/** A transaction that is already recorded: the same payout again, or a refusal when it was another one. */
function replayResult(row: PayoutRow, restaurantId: string, to: Wallet, amount: number): TeamPayRecordResult {
    if (row.restaurant_id === restaurantId && row.recipient === to && Number(row.amount) === amount) {
        return { status: "recorded", payout: toPayout(row), duplicate: true }
    }
    return { status: "rejected", reason: "Not recorded: this transaction is already recorded for another payment." }
}
