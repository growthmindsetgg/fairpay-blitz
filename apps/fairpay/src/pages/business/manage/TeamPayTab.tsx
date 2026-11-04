// Team pay: the owner pays their staff straight from their own wallet, one USDC transfer each,
// and keeps a verified history. Owner only (server/routes/teamPay.ts). These are public transfers:
// anyone can see on Monad that the owner's wallet paid the staff wallet, and how much. The payroll
// escrow (part 2, EscrowPanel.tsx) appears once the server's deployment has a payroll contract;
// until then its card says "coming soon" and shows no numbers.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { erc20Abi, getAddress } from "viem"
import type { TeamMember, TeamPayout, TeamPayView } from "../../../../shared/types"
import { Badge, CopyButton, Icon, Modal, Money, TxSteps, useWallet, type TxStepsState } from "../../../components"
import { friendly } from "../../../components/errors"
import { teamPayApi } from "../../../lib/api"
import { usdc } from "../../../lib/format"
import { NeedFundsError, PaymentRejectedError } from "../../../lib/payments"
import { forgetSent, payStaff, retrySent, sentPayouts, TEAM_PAY_STEPS, type SentPayout } from "../../../lib/teamPay"
import { sameWallet } from "../../../lib/wallet"
import { errorText } from "../client"
import { EscrowPanel } from "./EscrowPanel"
import type { TabProps } from "../Manage"
import { Alert, istDateTime, Loading, parsePrice, shortHex } from "../ui"
import "./teamPay.css"

export const ROLE_LABEL: Record<TeamMember["role"], string> = { manager: "Manager", chef: "Chef", waiter: "Waiter" }
export const PUBLIC_LINE = "Visible on Monad: your wallet → their wallet, and the amount."
const NOTE_MAX = 140

export function TeamPayTab({ view }: TabProps) {
    const id = view.restaurant.id
    const { deployment, cfg } = useWallet()
    const [data, setData] = useState<TeamPayView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [older, setOlder] = useState<{ items: TeamPayout[]; next: string | null; loading: boolean; error: string | null }>({
        items: [],
        next: null,
        loading: false,
        error: null
    })
    const [paying, setPaying] = useState<TeamMember | null>(null)
    const [sent, setSent] = useState<SentPayout[]>(() => sentPayouts(deployment, id))
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)

    const load = useCallback(async () => {
        try {
            const v = await teamPayApi.view(id)
            setData(v)
            setOlder({ items: [], next: v.next, loading: false, error: null })
            setError(null)
        } catch (e) {
            setError(errorText(e))
        }
    }, [id])

    // Payouts sent earlier (then a reload or a lost connection) are checked before anything else.
    const checkSent = useCallback(
        async (only?: SentPayout) => {
            const list = only ? [only] : sentPayouts(deployment, id)
            if (list.length === 0) return
            setNotice(null)
            let recorded = 0
            for (const p of list) {
                try {
                    await retrySent(deployment, p)
                    recorded++
                } catch (e) {
                    setNotice({ text: `We couldn't confirm the ${usdc(p.amount)} you sent to ${p.name}: ${friendly(e)}`, error: true })
                }
            }
            setSent(sentPayouts(deployment, id))
            if (recorded > 0) {
                setNotice((n) => n ?? { text: recorded === 1 ? "Your earlier payment is verified and recorded." : `${recorded} earlier payments are verified and recorded.` })
                void load()
            }
        },
        [deployment, id, load]
    )

    useEffect(() => {
        void load().then(() => checkSent())
    }, [load, checkSent])

    const more = async () => {
        if (!older.next) return
        setOlder((o) => ({ ...o, loading: true, error: null }))
        try {
            const page = await teamPayApi.payouts(id, older.next)
            setOlder((o) => ({ items: [...o.items, ...page.payouts], next: page.next, loading: false, error: null }))
        } catch (e) {
            setOlder((o) => ({ ...o, loading: false, error: errorText(e) }))
        }
    }

    const order: TeamMember["role"][] = ["manager", "chef", "waiter"]
    const staff = data ? [...data.staff].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.displayName.localeCompare(b.displayName)) : []
    const payouts = data ? [...data.payouts, ...older.items] : []

    return (
        <div className="fe-stack fe-money fe-team">
            <div className="fe-row-between">
                <h2 className="fe-h2">Team pay</h2>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                    Refresh
                </button>
            </div>
            <p className="fe-hint">
                Pay your staff straight from your wallet in USDC. Each payment is one public transfer: anyone can see on Monad that your wallet paid
                their wallet, and how much. FairPay checks it on-chain before it shows up in the history.
            </p>

            {error && <Alert>Team pay didn't load: {error}</Alert>}
            {!data && !error && <Loading label="Loading your team…" />}

            <div aria-live="polite">
                {notice && <Alert tone={notice.error ? "error" : "ok"}>{notice.text}</Alert>}
            </div>
            {sent.length > 0 && (
                <section className="fe-section" aria-labelledby="fe-team-sent-h">
                    <h3 id="fe-team-sent-h" className="fe-h3">
                        Sent, not confirmed yet <span className="fe-count">{sent.length}</span>
                    </h3>
                    <p className="fe-hint">These left your wallet but FairPay hasn't recorded them yet. Check again before paying the same person twice.</p>
                    <ul className="fe-money-list">
                        {sent.map((p) => (
                            <li key={p.txHash} className="fe-money-row fe-money-row--warn">
                                <div className="fe-money-top">
                                    <strong>
                                        <Money value={p.amount} /> to {p.name}
                                    </strong>
                                    <Badge tone="warn">Pending</Badge>
                                </div>
                                <p className="fe-muted">
                                    Sent {istDateTime(p.at)} · <ExplorerTx hash={p.txHash} />
                                </p>
                                <div className="fe-money-actions">
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void checkSent(p)}>
                                        Check again
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-quiet btn-sm"
                                        onClick={() => {
                                            forgetSent(deployment, p.txHash)
                                            setSent(sentPayouts(deployment, id))
                                        }}
                                    >
                                        Forget it
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {data && (
                <>
                    <dl className="fe-stats fe-money-stats fe-team-cards">
                        <OwnerBalance owner={data.owner} />
                        {!cfg.payroll && (
                            <div className="fe-stat-wide fe-team-soon">
                                <dt>Payroll escrow</dt>
                                <dd>Coming soon</dd>
                                <span className="fe-stat-note">Set pay aside for the team ahead of payday. Not available yet.</span>
                            </div>
                        )}
                    </dl>

                    <TeamList staff={staff} onPay={setPaying} />
                    {cfg.payroll && <EscrowPanel restaurantId={id} owner={data.owner} staff={staff} />}
                    <PayoutHistory restaurantId={id} payouts={payouts} next={older.next} loading={older.loading} error={older.error} more={() => void more()} />
                </>
            )}

            {data && (
                <PayPanel
                    restaurantId={id}
                    owner={data.owner}
                    member={paying}
                    onClose={() => setPaying(null)}
                    onSent={() => setSent(sentPayouts(deployment, id))}
                    onRecorded={() => {
                        setSent(sentPayouts(deployment, id))
                        void load()
                    }}
                />
            )}
        </div>
    )
}

// ------------------------------------------------------------------ the owner's wallet

function OwnerBalance({ owner }: { owner: TeamPayView["owner"] }) {
    const { cfg, publicClient } = useWallet()
    const [balance, setBalance] = useState<{ value: number | null; error: boolean; at: number | null }>({ value: null, error: false, at: null })

    // Read from the chain in this browser, so it is the wallet's balance right now.
    const read = useCallback(async () => {
        setBalance((b) => ({ ...b, error: false }))
        try {
            const v = await publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] })
            setBalance({ value: Number(v), error: false, at: Date.now() })
        } catch {
            setBalance((b) => ({ ...b, error: true }))
        }
    }, [publicClient, cfg.token, owner])
    useEffect(() => {
        void read()
    }, [read])

    return (
        <div className="fe-stat-wide">
            <dt>Your wallet</dt>
            <dd aria-live="polite">{balance.value !== null ? <Money value={balance.value} /> : balance.error ? "Couldn't read" : "Reading…"}</dd>
            <span className="fe-stat-note">
                <span className="fe-mono" title={owner}>
                    {shortHex(owner)}
                </span>
                {balance.at ? ` · live at ${istDateTime(balance.at)}` : ""}.{" "}
                <button type="button" className="fe-link" onClick={() => void read()}>
                    Read again
                </button>
            </span>
        </div>
    )
}

// ------------------------------------------------------------------ team

function TeamList({ staff, onPay }: { staff: TeamMember[]; onPay: (m: TeamMember) => void }) {
    return (
        <section className="fe-section" aria-labelledby="fe-team-list-h">
            <h3 id="fe-team-list-h" className="fe-h3">
                Team <span className="fe-count">{staff.length}</span>
            </h3>
            {staff.length === 0 ? (
                <div className="fe-empty">
                    <p>
                        <strong>No staff yet.</strong> Add people in Staff, then pay them here.
                    </p>
                </div>
            ) : (
                <div className="fe-table-wrap">
                    <table className="fe-data fe-team-table">
                        <caption className="sr-only">Staff you can pay</caption>
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Role</th>
                                <th scope="col">Wallet</th>
                                <th scope="col">Paid here</th>
                                <th scope="col">
                                    <span className="sr-only">Pay</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {staff.map((s) => (
                                <tr key={s.wallet}>
                                    <td>{s.displayName}</td>
                                    <td>{ROLE_LABEL[s.role]}</td>
                                    <td className="fe-mono" title={s.wallet}>
                                        <span aria-hidden="true">{shortHex(s.wallet)}</span>
                                        <span className="sr-only">{s.wallet}</span>
                                    </td>
                                    <td className="fe-num">
                                        {s.payCount > 0 ? (
                                            <>
                                                <Money value={s.paidTotal} />
                                                <span className="fe-hint"> · {s.payCount === 1 ? "1 payment" : `${s.payCount} payments`}</span>
                                            </>
                                        ) : (
                                            <span className="fe-muted">Nothing yet</span>
                                        )}
                                    </td>
                                    <td className="fe-td-action">
                                        <button type="button" className="btn btn-primary btn-sm" onClick={() => onPay(s)}>
                                            Pay now<span className="sr-only"> {s.displayName}</span>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    )
}

// ------------------------------------------------------------------ pay now

type Run = { steps: string[]; current: number; detail: string | null; state: TxStepsState; error?: { text: string; need?: "usdc" | "gas" }; txHash?: string; done?: string }

function PayPanel({
    restaurantId,
    owner,
    member,
    onClose,
    onSent,
    onRecorded
}: {
    restaurantId: string
    owner: TeamPayView["owner"]
    member: TeamMember | null
    onClose: () => void
    onSent: () => void
    onRecorded: () => void
}) {
    const { cfg, deployment, wallet, requestConnect, ensureChain, refreshBalances, faucet } = useWallet()
    const [amount, setAmount] = useState("")
    const [note, setNote] = useState("")
    const [tried, setTried] = useState(false)
    const [formError, setFormError] = useState<string | null>(null)
    const [run, setRun] = useState<Run | null>(null)
    const busy = useRef(false)

    // A fresh form for each person.
    useEffect(() => {
        setAmount("")
        setNote("")
        setTried(false)
        setFormError(null)
        setRun(null)
    }, [member?.wallet])

    if (!member) return null
    const micro = parsePrice(amount)
    const errs = {
        amount: micro === null ? "Enter an amount in USDC, e.g. 25 or 12.50 (up to 100,000)." : null,
        note: [...note.trim()].length > NOTE_MAX ? `Keep the note to ${NOTE_MAX} characters.` : null
    }
    const wrongWallet = !!wallet && !sameWallet(wallet.address, owner)

    async function pay(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (busy.current || !member) return
        if (errs.amount || errs.note || micro === null) {
            document.getElementById(errs.amount ? "tp-amount" : "tp-note")?.focus()
            return
        }
        setFormError(null)
        let w = wallet
        if (!w) {
            w = await requestConnect({ signIn: false, reason: "Connect this restaurant's owner wallet to pay your team." })
            if (!w) return
        }
        if (!sameWallet(w.address, owner)) {
            setFormError(`The connected wallet isn't this restaurant's owner wallet (${shortHex(owner)}). Switch to it in your wallet, then try again.`)
            return
        }
        busy.current = true
        setRun({ steps: TEAM_PAY_STEPS, current: 0, detail: null, state: "running" })
        try {
            await ensureChain(w)
            const r = await payStaff(
                deployment,
                w.clients,
                { restaurantId, wallet: member.wallet, name: member.displayName, amount: micro, note: note.trim() || null },
                (i, detail) => setRun((x) => (x ? { ...x, current: i, detail: detail ?? null } : x))
            )
            setRun((x) =>
                x
                    ? {
                          ...x,
                          state: "done",
                          current: x.steps.length - 1,
                          detail: null,
                          txHash: r.txHash,
                          done: `Paid ${usdc(micro)} to ${member.displayName}. FairPay verified the transfer on Monad.`
                      }
                    : x
            )
            void refreshBalances().catch(() => undefined)
            onRecorded()
        } catch (e2) {
            const err: Run["error"] = { text: friendly(e2) }
            if (e2 instanceof NeedFundsError) err.need = e2.need
            if (e2 instanceof PaymentRejectedError) err.text = `FairPay didn't record this payment: ${e2.message}`
            setRun((x) => (x ? { ...x, state: "error", error: err } : x))
            onSent()
        } finally {
            busy.current = false
        }
    }

    const getFunds = async () => {
        try {
            const text = await faucet()
            setRun((r) => (r?.error ? { ...r, error: { ...r.error, text: `${text} Then try again.` } } : r))
        } catch (e2) {
            setRun((r) => (r ? { ...r, error: { text: friendly(e2) } } : r))
        }
    }

    const close = () => {
        if (run?.state === "running") return
        onClose()
    }
    const err = (k: keyof typeof errs) => (tried ? errs[k] : null)

    return (
        <Modal open={!!member} onClose={close} title={`Pay ${member.displayName}`} dismissible={run?.state !== "running"}>
            {run ? (
                <>
                    <TxSteps steps={run.steps} current={run.current} state={run.state} detail={run.detail} label="Team payment progress" />
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
                            <button type="button" className="btn btn-primary" onClick={onClose}>
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
                                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void getFunds()}>
                                        <Icon name="drop" size={16} />
                                        Get test {run.error.need === "usdc" ? "USDC" : "funds"}
                                    </button>
                                )}
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRun(null)}>
                                    Back
                                </button>
                            </div>
                            {run.error.need && !cfg.faucet && <p className="field-hint">The test faucet is off on this server. Send test USDC or MON to your wallet, then try again.</p>}
                        </div>
                    )}
                </>
            ) : (
                <form className="fe-stack fe-team-form" onSubmit={(e) => void pay(e)} noValidate>
                    <p className="fe-team-to">
                        To <strong>{member.displayName}</strong> ({ROLE_LABEL[member.role].toLowerCase()}){" "}
                        <span className="fe-mono fe-break">{member.wallet}</span> <CopyButton text={member.wallet} label="Copy address" />
                    </p>
                    <div className="fe-field">
                        <label htmlFor="tp-amount">Amount (USDC)</label>
                        <input
                            id="tp-amount"
                            inputMode="decimal"
                            autoComplete="off"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="25.00"
                            aria-invalid={err("amount") ? true : undefined}
                            aria-describedby={err("amount") ? "tp-amount-e" : undefined}
                        />
                        {err("amount") && (
                            <span className="fe-field-error" id="tp-amount-e">
                                {err("amount")}
                            </span>
                        )}
                    </div>
                    <div className="fe-field">
                        <label htmlFor="tp-note">
                            Note <span className="fe-hint">(optional, {NOTE_MAX - [...note.trim()].length} left)</span>
                        </label>
                        <input
                            id="tp-note"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            maxLength={NOTE_MAX + 20}
                            placeholder="October wages"
                            aria-invalid={err("note") ? true : undefined}
                            aria-describedby={`tp-note-h${err("note") ? " tp-note-e" : ""}`}
                        />
                        <span className="fe-hint" id="tp-note-h">
                            {member.displayName} sees it in their activity. It stays in FairPay, not on-chain.
                        </span>
                        {err("note") && (
                            <span className="fe-field-error" id="tp-note-e">
                                {err("note")}
                            </span>
                        )}
                    </div>
                    <p className="callout callout-warn fe-team-public">
                        <Icon name="info" size={16} /> {PUBLIC_LINE}
                    </p>
                    {wrongWallet && (
                        <p className="fe-explain">
                            The connected wallet ({shortHex(wallet!.address)}) isn't this restaurant's owner wallet ({shortHex(owner)}). Switch wallets to pay.
                        </p>
                    )}
                    {formError && <Alert>{formError}</Alert>}
                    <div className="fe-money-actions">
                        <button type="submit" className="btn btn-primary" disabled={wrongWallet}>
                            {!wallet ? "Connect wallet to pay" : micro !== null ? `Pay ${usdc(micro)}` : "Pay"}
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </form>
            )}
        </Modal>
    )
}

// ------------------------------------------------------------------ history

export function ExplorerTx({ hash }: { hash: string }) {
    const { cfg } = useWallet()
    return (
        <a href={`${cfg.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>
            View transaction<span className="sr-only"> on the Monad explorer (opens in a new tab)</span>
        </a>
    )
}

function PayoutHistory({
    restaurantId,
    payouts,
    next,
    loading,
    error,
    more
}: {
    restaurantId: string
    payouts: TeamPayout[]
    next: string | null
    loading: boolean
    error: string | null
    more: () => void
}) {
    return (
        <section className="fe-section" aria-labelledby="fe-team-hist-h">
            <div className="fe-row-between">
                <h3 id="fe-team-hist-h" className="fe-h3">
                    Payout history
                </h3>
                {payouts.length > 0 && (
                    <a className="btn btn-quiet btn-sm" href={teamPayApi.csvUrl(restaurantId)} download>
                        Download CSV
                    </a>
                )}
            </div>
            <p className="fe-hint">Every team payment FairPay verified on-chain, newest first.</p>
            {payouts.length === 0 ? (
                <div className="fe-empty">
                    <p>
                        <strong>No team payments yet.</strong> Use Pay now next to someone to send them USDC from your wallet.
                    </p>
                </div>
            ) : (
                <ol className="fe-money-list">
                    {payouts.map((p) => (
                        <PayoutRow key={p.id} p={p} />
                    ))}
                </ol>
            )}
            {error && <Alert>Older payments didn't load: {error}</Alert>}
            {loading && <Loading label="Loading payments…" />}
            {next && !loading && (
                <button type="button" className="btn btn-secondary" onClick={more}>
                    Show older payments
                </button>
            )}
        </section>
    )
}

export function PayoutRow({ p, mine = false }: { p: TeamPayout; mine?: boolean }) {
    return (
        <li className="fe-money-row">
            <div className="fe-money-top">
                <span className="fe-num fe-money-amt">
                    <Money value={p.amount} />
                </span>
                <span className="fe-money-badges">
                    <Badge>Public</Badge>
                    <Badge tone="verified">Verified</Badge>
                </span>
            </div>
            <p className="fe-money-meta">
                {mine ? (
                    <span>
                        From <span className="fe-mono" title={p.payer}>{shortHex(p.payer)}</span>
                    </span>
                ) : (
                    <>
                        <span>{p.recipient.name}</span>
                        <span>{ROLE_LABEL[p.recipient.role]}</span>
                        <span className="fe-mono" title={p.recipient.wallet}>
                            {shortHex(p.recipient.wallet)}
                        </span>
                    </>
                )}
            </p>
            {p.note && <p className="fe-break">“{p.note}”</p>}
            <p className="fe-muted">
                {istDateTime(p.at)} · Block {p.proof.blockNumber} · <ExplorerTx hash={p.proof.txHash} />
            </p>
        </li>
    )
}
