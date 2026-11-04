// Pieces shared by the owner's escrow panel (EscrowPanel.tsx) and a staff member's My pay
// (MyEscrow.tsx): running one escrow transaction with visible steps, and the history rows.

import { useRef, useState } from "react"
import type { EscrowEvent, EscrowPosition, EscrowSchedule, Wallet } from "../../../../shared/types"
import { Badge, Icon, Money, TxSteps, useWallet, type TxStepsState } from "../../../components"
import { friendly } from "../../../components/errors"
import { NeedFundsError, PaymentRejectedError } from "../../../lib/payments"
import { PERIOD_LABEL, payrollReason } from "../../../lib/payroll"
import { sameWallet, type ConnectedWallet } from "../../../lib/wallet"
import { istDate, istDateTime, shortHex } from "../ui"
import { ExplorerTx } from "./TeamPayTab"

export type Run = {
    steps: string[]
    current: number
    detail: string | null
    state: TxStepsState
    error?: { text: string; need?: "usdc" | "gas" }
    txHash?: string
    done?: string
}

type Clients = ConnectedWallet["clients"]

/**
 * One escrow transaction at a time: connects the wallet if needed, insists on the expected one
 * (the owner's for the escrow, the staff member's own for a claim), switches to Monad and follows
 * the steps. Resolves true when the transaction went through.
 */
export function useEscrowTx() {
    const { wallet, requestConnect, ensureChain, refreshBalances, faucet } = useWallet()
    const [run, setRun] = useState<Run | null>(null)
    const busy = useRef(false)

    async function go(
        steps: string[],
        who: { expect: Wallet; label: string; reason: string },
        fn: (clients: Clients, onStep: (i: number, detail?: string) => void) => Promise<{ txHash?: string; done: string }>
    ): Promise<boolean> {
        if (busy.current) return false
        let w = wallet
        if (!w) {
            w = await requestConnect({ signIn: false, reason: who.reason })
            if (!w) return false
        }
        if (!sameWallet(w.address, who.expect)) {
            setRun({
                steps,
                current: 0,
                detail: null,
                state: "error",
                error: { text: `The connected wallet (${shortHex(w.address)}) isn't ${who.label} (${shortHex(who.expect)}). Switch to it in your wallet, then try again.` }
            })
            return false
        }
        busy.current = true
        setRun({ steps, current: 0, detail: null, state: "running" })
        try {
            await ensureChain(w)
            const r = await fn(w.clients, (i, detail) => setRun((x) => (x ? { ...x, current: i, detail: detail ?? null } : x)))
            setRun((x) => (x ? { ...x, state: "done", current: x.steps.length - 1, detail: null, txHash: r.txHash, done: r.done } : x))
            void refreshBalances().catch(() => undefined)
            return true
        } catch (e) {
            const error: Run["error"] = { text: payrollReason(e) ?? friendly(e) }
            if (e instanceof NeedFundsError) error.need = e.need
            if (e instanceof PaymentRejectedError) error.text = `FairPay didn't record this: ${e.message}`
            setRun((x) => (x ? { ...x, state: "error", error } : x))
            return false
        } finally {
            busy.current = false
        }
    }

    async function getFunds() {
        try {
            const text = await faucet()
            setRun((r) => (r?.error ? { ...r, error: { ...r.error, text: `${text} Then try again.` } } : r))
        } catch (e) {
            setRun((r) => (r ? { ...r, error: { text: friendly(e) } } : r))
        }
    }

    return { run, setRun, go, getFunds, running: run?.state === "running" }
}

/** The steps of a run, then its result: done with a link, or the error with the faucet when it helps. */
export function TxRunView({ run, label, onBack, onDone, getFunds }: { run: Run; label: string; onBack: () => void; onDone: () => void; getFunds: () => void }) {
    const { cfg } = useWallet()
    return (
        <>
            <TxSteps steps={run.steps} current={run.current} state={run.state} detail={run.detail} label={label} />
            {run.state === "done" && (
                <div className="txresult">
                    <p className="success-text">
                        <Icon name="check" size={18} /> {run.done}
                    </p>
                    {run.txHash && (
                        <a className="link-sm" href={`${cfg.explorer}/tx/${run.txHash}`} target="_blank" rel="noreferrer">
                            View the transaction <Icon name="external" size={14} />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    )}
                    <button type="button" className="btn btn-primary" onClick={onDone}>
                        Done
                    </button>
                </div>
            )}
            {run.state === "error" && run.error && (
                <div className="txresult">
                    <p className="error-text" role="alert">
                        {run.error.text}
                    </p>
                    <div className="row">
                        {run.error.need && cfg.faucet && (
                            <button type="button" className="btn btn-primary btn-sm" onClick={getFunds}>
                                <Icon name="drop" size={16} />
                                Get test {run.error.need === "usdc" ? "USDC" : "funds"}
                            </button>
                        )}
                        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
                            Back
                        </button>
                    </div>
                    {run.error.need && !cfg.faucet && <p className="field-hint">The test faucet is off on this server. Send test USDC or MON to your wallet, then try again.</p>}
                </div>
            )}
        </>
    )
}

// ------------------------------------------------------------------ words

const periodOf = (seconds: number) => (seconds === 86_400 ? "day" : seconds === 604_800 ? "week" : seconds === 2_592_000 ? "month" : null)

/** "per week", "per day", "every 30 days". */
export function scheduleText(s: EscrowSchedule) {
    return s.period === "month" ? "every 30 days" : `per ${PERIOD_LABEL[s.period]}`
}

/** "12.00 USDC per week, since 5 Nov" */
export function ScheduleLine({ s }: { s: EscrowSchedule }) {
    return (
        <>
            <Money value={s.amountPerPeriod} /> {scheduleText(s)}
            <span className="fe-hint"> · {s.start > Date.now() ? "starts" : "since"} {istDate(s.start)}</span>
        </>
    )
}

/** The position tiles both views show. */
export function PositionTiles({ p }: { p: EscrowPosition }) {
    return (
        <dl className="fe-stats fe-money-stats">
            <div className="fe-stat-wide">
                <dt>Claimable now</dt>
                <dd>
                    <Money value={p.claimable} />
                </dd>
                <span className="fe-stat-note">Funded and ready to claim.</span>
            </div>
            <div className="fe-stat-wide">
                <dt>Earned, not claimed</dt>
                <dd>
                    <Money value={p.earned} />
                </dd>
                <span className="fe-stat-note">{p.shortfall > 0 ? `${usdcText(p.shortfall)} of it isn't funded yet; it stays owed.` : "All of it is funded."}</span>
            </div>
            <div className="fe-stat-wide">
                <dt>Next pay date</dt>
                <dd>{p.nextPayAt ? istDate(p.nextPayAt) : "None"}</dd>
                <span className="fe-stat-note">{p.nextPayAt ? `A schedule period completes ${istDateTime(p.nextPayAt)}.` : "No pay schedule running."}</span>
            </div>
        </dl>
    )
}

const usdcText = (micro: number) => `${(micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`

/** What an event says, from the owner's side or the staff member's ("mine"). */
function eventText(e: EscrowEvent, mine: boolean): { title: string; badge?: { tone: "verified" | "warn" | "info" | "neutral"; text: string }; note?: string } {
    const who = e.employee ? (e.employee.name ?? shortHex(e.employee.wallet)) : "someone"
    switch (e.kind) {
        case "funded":
            return { title: "Added to the escrow" }
        case "withdrawn":
            return { title: "Withdrawn from the escrow" }
        case "shift_approved":
            return { title: mine ? "Shift pay approved" : `Shift approved for ${who}` }
        case "schedule_set": {
            const p = periodOf(e.detail.period ?? 0)
            const per = p ? (p === "month" ? "every 30 days" : `per ${p}`) : ""
            const start = e.detail.start ? ` from ${istDate(e.detail.start)}` : ""
            const up = e.detail.upfront ? ` · ${usdcText(e.detail.upfront)} back pay set aside` : ""
            return { title: mine ? `Pay schedule set ${per}${start}` : `Schedule for ${who} ${per}${start}`, note: up ? up.slice(3) : undefined }
        }
        case "schedule_ended": {
            const debt = e.detail.debt ?? 0
            return {
                title: mine ? "Pay schedule ended; time worked settled" : `Schedule for ${who} ended; time worked settled`,
                badge: debt > 0 ? { tone: "warn", text: `${usdcText(debt)} owed` } : undefined
            }
        }
        case "claimed":
            return e.autoPaid
                ? { title: mine ? "Auto-paid to your wallet" : `Auto-paid to ${who}`, badge: { tone: "info", text: "Auto-pay" } }
                : { title: mine ? "You claimed" : `${who} claimed` }
        case "shortfall":
            return { title: mine ? "Part of your pay wasn't funded yet" : `${who}'s claim was short`, badge: { tone: "warn", text: "Stays owed" } }
        case "underfunded":
            return { title: "The escrow is short", badge: { tone: "warn", text: "Shortfall" } }
        case "debt_backed":
            return { title: "New funds covered unpaid pay" }
        case "debt_repaid":
            return { title: mine ? "Unpaid pay was covered; you can claim it" : `Unpaid pay covered for ${who}` }
        case "resigned":
            return { title: mine ? "You left the payroll" : `${who} left the payroll`, badge: { tone: "neutral", text: "Left" } }
    }
}

export function EventRow({ e, mine = false }: { e: EscrowEvent; mine?: boolean }) {
    const t = eventText(e, mine)
    return (
        <li className="fe-money-row">
            <div className="fe-money-top">
                <span className="fe-num fe-money-amt">
                    {e.kind === "resigned" ? <span className="fe-muted">No amount</span> : <Money value={e.amount} />}
                    {e.kind === "schedule_set" && <span className="fe-hint"> per period</span>}
                </span>
                <span className="fe-money-badges">
                    {t.badge && <Badge tone={t.badge.tone}>{t.badge.text}</Badge>}
                    <Badge tone="verified">On-chain</Badge>
                </span>
            </div>
            <p className="fe-money-meta">
                <span>{t.title}</span>
            </p>
            {t.note && <p className="fe-hint">{t.note}</p>}
            <p className="fe-muted">
                {e.at ? istDateTime(e.at) : "Time unknown"} · Block {e.proof.blockNumber} · <ExplorerTx hash={e.proof.txHash} />
            </p>
        </li>
    )
}
