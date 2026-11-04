// Team pay part 2, the owner's payroll escrow (FairPayroll). Shown in the Team pay tab only when the
// server's deployment has a payroll contract (cfg.payroll); otherwise the tab keeps its "coming
// soon" card. The numbers come from the chain through the server (server/routes/payroll.ts); the
// owner's wallet sends every escrow transaction itself. Salaries and shift pay are public on Monad.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import type { EscrowEvent, EscrowMember, EscrowView, PayPeriodName, PayrollShift, TeamMember, Wallet } from "../../../../shared/types"
import { Badge, Modal, Money, Segmented, Switch, useWallet } from "../../../components"
import { escrowApi } from "../../../lib/api"
import { usdc } from "../../../lib/format"
import { APPROVE_STEPS, approveShifts, endSchedule, ESCROW_STEPS, fundEscrow, PERIOD_ADJ, setSchedule, withdrawEscrow } from "../../../lib/payroll"
import { errorText } from "../client"
import { Alert, istDate, istDateTime, Loading, microToInput, parsePrice, shortHex } from "../ui"
import { EventRow, ScheduleLine, TxRunView, useEscrowTx } from "./escrowUi"
import { ExplorerTx, ROLE_LABEL } from "./TeamPayTab"

const MAX_BATCH = 50
const DAY = 86_400_000
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(Date.now())

/** "7.5" hours → 450 minutes; blank → null; anything else → undefined (invalid). */
function parseHours(s: string): number | null | undefined {
    const t = s.trim()
    if (t === "") return null
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return undefined
    const m = Math.round(Number(t) * 60)
    return m >= 1 && m <= 1440 ? m : undefined
}

const hoursText = (minutes: number | null) => (minutes === null ? "" : `${(minutes / 60).toLocaleString("en-US", { maximumFractionDigits: 2 })} h`)

type ModalState =
    | { kind: "fund" }
    | { kind: "withdraw" }
    | { kind: "setup"; m: EscrowMember }
    | { kind: "end"; m: EscrowMember }
    | { kind: "approve"; shifts: PayrollShift[] }
    | null

export function EscrowPanel({ restaurantId, owner, staff }: { restaurantId: string; owner: Wallet; staff: TeamMember[] }) {
    const [data, setData] = useState<EscrowView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [older, setOlder] = useState<{ items: EscrowEvent[]; next: string | null; loading: boolean; error: string | null }>({ items: [], next: null, loading: false, error: null })
    const [modal, setModal] = useState<ModalState>(null)
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)

    const load = useCallback(async () => {
        try {
            const v = await escrowApi.view(restaurantId)
            setData(v)
            setOlder({ items: [], next: v.next, loading: false, error: null })
            setError(null)
        } catch (e) {
            setError(errorText(e))
        }
    }, [restaurantId])
    useEffect(() => {
        void load()
    }, [load])

    const more = async () => {
        if (!older.next) return
        setOlder((o) => ({ ...o, loading: true, error: null }))
        try {
            const page = await escrowApi.history(restaurantId, older.next)
            setOlder((o) => ({ items: [...o.items, ...page.events], next: page.next, loading: false, error: null }))
        } catch (e) {
            setOlder((o) => ({ ...o, loading: false, error: errorText(e) }))
        }
    }

    const setMember = async (m: EscrowMember, body: { shiftRate?: number | null; autoPay?: boolean }) => {
        setNotice(null)
        try {
            await escrowApi.setMember(restaurantId, m.wallet, body)
            await load()
            return true
        } catch (e) {
            setNotice({ text: errorText(e), error: true })
            return false
        }
    }

    if (error && !data) return <Alert>The payroll escrow didn't load: {error}</Alert>
    if (!data) return <Loading label="Reading the payroll escrow…" />
    const a = data.account
    const events = [...data.events, ...older.items]

    return (
        <>
            <section className="fe-section fe-escrow" aria-labelledby="fe-escrow-h">
                <div className="fe-row-between">
                    <h3 id="fe-escrow-h" className="fe-h3">
                        Payroll escrow
                    </h3>
                    <div className="fe-money-actions">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: "fund" })}>
                            Add to escrow
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={a.available === 0} onClick={() => setModal({ kind: "withdraw" })}>
                            Withdraw available
                        </button>
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => void load()}>
                            Refresh
                        </button>
                    </div>
                </div>
                <p className="fe-hint">
                    Set pay aside for your team. Staff claim it with their own wallets, and you can't withdraw pay they have earned. Schedules, shift pay
                    and claims are public on Monad: anyone can see who is paid how much.
                    {data.sharedWith > 0 &&
                        ` This escrow belongs to your wallet, so it is shared with your ${data.sharedWith === 1 ? "other restaurant" : `${data.sharedWith} other restaurants`}.`}
                </p>
                {error && <Alert>Couldn't refresh: {error}</Alert>}
                <div aria-live="polite">{notice && <Alert tone={notice.error ? "error" : "ok"}>{notice.text}</Alert>}</div>
                <dl className="fe-stats fe-money-stats">
                    <div className="fe-stat-wide">
                        <dt>In the escrow</dt>
                        <dd>
                            <Money value={a.balance} />
                        </dd>
                        <span className="fe-stat-note">Read from Monad {istDateTime(data.readAt)}.</span>
                    </div>
                    <div className="fe-stat-wide">
                        <dt>Available</dt>
                        <dd>
                            <Money value={a.available} />
                        </dd>
                        <span className="fe-stat-note">Yours to withdraw or spend on shifts.</span>
                    </div>
                    <div className="fe-stat-wide">
                        <dt>Owed to staff</dt>
                        <dd>
                            <Money value={a.owed} />
                        </dd>
                        <span className="fe-stat-note">Set aside or earned. Not withdrawable.</span>
                    </div>
                    <div className="fe-stat-wide">
                        <dt>Runway</dt>
                        <dd>{a.shortfall > 0 ? "Short" : a.runwayUntil ? istDate(a.runwayUntil) : "No schedules"}</dd>
                        <span className="fe-stat-note">
                            {a.shortfall > 0
                                ? `Pay is set aside only until ${istDateTime(a.fundedUntil)}.`
                                : a.runwayUntil
                                  ? `Covers pay until ${istDateTime(a.runwayUntil)} at ${usdc(a.payPerDay)} a day.`
                                  : "Schedules you set up are paid from here."}
                        </span>
                    </div>
                </dl>
                {a.shortfall > 0 && (
                    <Alert>
                        Your staff have earned {usdc(a.shortfall)} more than the escrow holds. It stays owed to them; add at least that much to catch up. Until
                        then you can't add or change schedules.
                    </Alert>
                )}
            </section>

            <PaySetup
                data={data}
                onSetup={(m) => setModal({ kind: "setup", m })}
                onEnd={(m) => setModal({ kind: "end", m })}
                onAutoPay={(m, on) => void setMember(m, { autoPay: on })}
            />

            <Shifts restaurantId={restaurantId} data={data} staff={staff} reload={load} onApprove={(shifts) => setModal({ kind: "approve", shifts })} />

            <section className="fe-section" aria-labelledby="fe-escrow-hist-h">
                <h3 id="fe-escrow-hist-h" className="fe-h3">
                    Escrow history
                </h3>
                <p className="fe-hint">Every escrow event on Monad for your wallet, newest first, a few seconds after it happens. Direct payments are under Payout history.</p>
                {events.length === 0 ? (
                    <div className="fe-empty">
                        <p>
                            <strong>Nothing yet.</strong> Add to the escrow to start.
                        </p>
                    </div>
                ) : (
                    <ol className="fe-money-list">
                        {events.map((e) => (
                            <EventRow key={e.id} e={e} />
                        ))}
                    </ol>
                )}
                {older.error && <Alert>Older events didn't load: {older.error}</Alert>}
                {older.loading && <Loading label="Loading events…" />}
                {older.next && !older.loading && (
                    <button type="button" className="btn btn-secondary" onClick={() => void more()}>
                        Show older events
                    </button>
                )}
            </section>

            <EscrowModal
                state={modal}
                data={data}
                owner={owner}
                restaurantId={restaurantId}
                onClose={() => setModal(null)}
                onChanged={() => void load()}
                setMember={setMember}
            />
        </>
    )
}

// ------------------------------------------------------------------ pay setup per person

function PaySetup({
    data,
    onSetup,
    onEnd,
    onAutoPay
}: {
    data: EscrowView
    onSetup: (m: EscrowMember) => void
    onEnd: (m: EscrowMember) => void
    onAutoPay: (m: EscrowMember, on: boolean) => void
}) {
    return (
        <section className="fe-section" aria-labelledby="fe-escrow-setup-h">
            <h3 id="fe-escrow-setup-h" className="fe-h3">
                Pay from the escrow <span className="fe-count">{data.members.length}</span>
            </h3>
            <p className="fe-hint">
                Per shift: you approve shifts below. Schedule: pay every day, week or 30 days, claimable as each period completes.
                {data.keeper ? " Auto-pay: FairPay sends claimable pay to their wallet for them, paying the gas." : " Auto-pay isn't available on this server."}
            </p>
            {data.members.length === 0 ? (
                <div className="fe-empty">
                    <p>
                        <strong>No staff yet.</strong> Add people in Staff first.
                    </p>
                </div>
            ) : (
                <div className="fe-table-wrap">
                    <table className="fe-data fe-team-table fe-escrow-table">
                        <caption className="sr-only">Escrow pay for each person</caption>
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Pay</th>
                                <th scope="col">Claimable</th>
                                <th scope="col">Earned</th>
                                <th scope="col">Next pay</th>
                                <th scope="col">Auto-pay</th>
                                <th scope="col">
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.members.map((m) => {
                                const name = m.name ?? shortHex(m.wallet)
                                return (
                                    <tr key={m.wallet}>
                                        <td className="fe-escrow-name">
                                            {name}
                                            <span className="fe-hint">{m.role ? ROLE_LABEL[m.role] : "Left the staff"}</span>
                                        </td>
                                        <td>
                                            {m.schedule ? (
                                                <ScheduleLine s={m.schedule} />
                                            ) : m.shiftRate ? (
                                                <>
                                                    Per shift · <Money value={m.shiftRate} />
                                                </>
                                            ) : (
                                                <span className="fe-muted">None</span>
                                            )}
                                            {m.pending.count > 0 && (
                                                <span className="fe-hint">
                                                    {" "}
                                                    · {m.pending.count === 1 ? "1 shift" : `${m.pending.count} shifts`} to approve
                                                </span>
                                            )}
                                        </td>
                                        <td className="fe-num">
                                            <Money value={m.position.claimable} />
                                        </td>
                                        <td className="fe-num">
                                            <Money value={m.position.earned} />
                                            {m.position.shortfall > 0 && <span className="fe-hint fe-escrow-sub">{usdc(m.position.shortfall)} not funded</span>}
                                        </td>
                                        <td className="fe-escrow-nowrap">{m.position.nextPayAt ? istDate(m.position.nextPayAt) : <span className="fe-muted">—</span>}</td>
                                        <td>
                                            <Switch
                                                label={`Auto-pay ${name}`}
                                                hideLabel
                                                checked={m.autoPay}
                                                disabled={(!data.keeper && !m.autoPay) || !m.onStaff}
                                                onChange={(on) => onAutoPay(m, on)}
                                            />
                                        </td>
                                        <td className="fe-td-action">
                                            <div className="fe-money-actions">
                                                {m.onStaff && (
                                                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSetup(m)}>
                                                        Pay setup<span className="sr-only"> for {name}</span>
                                                    </button>
                                                )}
                                                {m.schedule && (
                                                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => onEnd(m)}>
                                                        End schedule<span className="sr-only"> for {name}</span>
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    )
}

// ------------------------------------------------------------------ shifts

function Shifts({
    restaurantId,
    data,
    staff,
    reload,
    onApprove
}: {
    restaurantId: string
    data: EscrowView
    staff: TeamMember[]
    reload: () => Promise<void>
    onApprove: (shifts: PayrollShift[]) => void
}) {
    const rates = useMemo(() => new Map(data.members.map((m) => [m.wallet, m.shiftRate])), [data.members])
    const [who, setWho] = useState<string>("")
    const [date, setDate] = useState(istToday)
    const [hours, setHours] = useState("")
    const [amount, setAmount] = useState("")
    const [note, setNote] = useState("")
    const [tried, setTried] = useState(false)
    const [saving, setSaving] = useState(false)
    const [formError, setFormError] = useState<string | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())

    // Keep only selections that are still pending.
    useEffect(() => {
        setSelected((s) => new Set([...s].filter((id) => data.pendingShifts.some((x) => x.id === id))))
    }, [data.pendingShifts])

    const pick = (w: string) => {
        setWho(w)
        const rate = rates.get(w as Wallet)
        if (rate) setAmount(microToInput(rate))
    }

    const micro = parsePrice(amount)
    const minutes = parseHours(hours)
    const errs = {
        who: who ? null : "Pick who worked.",
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? null : "Pick the day.",
        hours: minutes === undefined ? "Hours like 8 or 7.5, up to 24." : null,
        amount: micro === null ? "Enter the pay for this shift in USDC, e.g. 20." : null,
        note: [...note.trim()].length > 140 ? "Keep the note to 140 characters." : null
    }
    const err = (k: keyof typeof errs) => (tried ? errs[k] : null)

    async function add(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (Object.values(errs).some(Boolean) || micro === null || minutes === undefined) return
        setSaving(true)
        setFormError(null)
        try {
            await escrowApi.addShift(restaurantId, { wallet: who as Wallet, workDate: date, minutes, note: note.trim() || null, amount: micro })
            setHours("")
            setNote("")
            setTried(false)
            await reload()
        } catch (e2) {
            setFormError(errorText(e2))
        } finally {
            setSaving(false)
        }
    }

    async function remove(s: PayrollShift) {
        setFormError(null)
        try {
            await escrowApi.removeShift(restaurantId, s.id)
            await reload()
        } catch (e2) {
            setFormError(errorText(e2))
        }
    }

    const pending = data.pendingShifts
    const chosen = pending.filter((s) => selected.has(s.id))
    const total = chosen.reduce((t, s) => t + s.amount, 0)
    const toggle = (id: string, on: boolean) =>
        setSelected((s) => {
            const n = new Set(s)
            if (on) n.add(id)
            else n.delete(id)
            return n
        })
    const onStaff = staff.filter((s) => s.wallet !== data.employer)

    return (
        <section className="fe-section" aria-labelledby="fe-escrow-shifts-h">
            <h3 id="fe-escrow-shifts-h" className="fe-h3">
                Shifts <span className="fe-count">{pending.length}</span>
            </h3>
            <p className="fe-hint">
                Add the shifts people worked, then approve up to {MAX_BATCH} at once with one wallet confirmation. Approved pay moves from your available
                money to theirs at once, and they can claim it.
            </p>
            <form className="fe-escrow-shift-form" onSubmit={(e) => void add(e)} noValidate>
                <div className="fe-field">
                    <label htmlFor="es-who">Who</label>
                    <select id="es-who" className="input select" value={who} onChange={(e) => pick(e.target.value)} aria-invalid={err("who") ? true : undefined}>
                        <option value="">Pick a person</option>
                        {onStaff.map((s) => (
                            <option key={s.wallet} value={s.wallet}>
                                {s.displayName} ({ROLE_LABEL[s.role].toLowerCase()})
                            </option>
                        ))}
                    </select>
                    {err("who") && <span className="fe-field-error">{err("who")}</span>}
                </div>
                <div className="fe-field">
                    <label htmlFor="es-date">Day</label>
                    <input id="es-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={err("date") ? true : undefined} />
                    {err("date") && <span className="fe-field-error">{err("date")}</span>}
                </div>
                <div className="fe-field">
                    <label htmlFor="es-hours">
                        Hours <span className="fe-opt">(optional)</span>
                    </label>
                    <input id="es-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="8" aria-invalid={err("hours") ? true : undefined} />
                    {err("hours") && <span className="fe-field-error">{err("hours")}</span>}
                </div>
                <div className="fe-field">
                    <label htmlFor="es-amount">Pay (USDC)</label>
                    <input id="es-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20.00" aria-invalid={err("amount") ? true : undefined} />
                    {err("amount") && <span className="fe-field-error">{err("amount")}</span>}
                </div>
                <div className="fe-field fe-escrow-note">
                    <label htmlFor="es-note">
                        Note <span className="fe-opt">(optional, stays in FairPay)</span>
                    </label>
                    <input id="es-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} placeholder="Dinner service" aria-invalid={err("note") ? true : undefined} />
                    {err("note") && <span className="fe-field-error">{err("note")}</span>}
                </div>
                <div className="fe-form-actions">
                    <button type="submit" className="btn btn-secondary" disabled={saving}>
                        {saving ? "Adding…" : "Add shift"}
                    </button>
                </div>
            </form>
            {formError && <Alert>{formError}</Alert>}

            {pending.length > 0 && (
                <>
                    <div className="fe-table-wrap">
                        <table className="fe-data fe-team-table">
                            <caption className="sr-only">Shifts waiting for approval</caption>
                            <thead>
                                <tr>
                                    <th scope="col">
                                        <input
                                            type="checkbox"
                                            aria-label="Select the first 50 shifts"
                                            checked={chosen.length > 0 && chosen.length === Math.min(pending.length, MAX_BATCH)}
                                            onChange={(e) => setSelected(new Set(e.target.checked ? pending.slice(0, MAX_BATCH).map((s) => s.id) : []))}
                                        />
                                    </th>
                                    <th scope="col">Day</th>
                                    <th scope="col">Who</th>
                                    <th scope="col">Hours</th>
                                    <th scope="col">Pay</th>
                                    <th scope="col">
                                        <span className="sr-only">Remove</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {pending.map((s) => (
                                    <tr key={s.id}>
                                        <td>
                                            <input
                                                type="checkbox"
                                                aria-label={`Select ${s.name}'s shift on ${s.workDate}`}
                                                checked={selected.has(s.id)}
                                                disabled={!selected.has(s.id) && chosen.length >= MAX_BATCH}
                                                onChange={(e) => toggle(s.id, e.target.checked)}
                                            />
                                        </td>
                                        <td>{s.workDate}</td>
                                        <td>
                                            {s.name}
                                            {s.note && <span className="fe-hint fe-break"> · “{s.note}”</span>}
                                        </td>
                                        <td>{hoursText(s.minutes) || <span className="fe-muted">—</span>}</td>
                                        <td className="fe-num">
                                            <Money value={s.amount} />
                                        </td>
                                        <td className="fe-td-action">
                                            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void remove(s)}>
                                                Remove<span className="sr-only"> {s.name}'s shift on {s.workDate}</span>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {total > data.account.available && chosen.length > 0 && (
                        <p className="fe-explain">
                            These come to {usdc(total)} and {usdc(data.account.available)} is available. Add to the escrow first.
                        </p>
                    )}
                    <div className="fe-money-actions">
                        <button type="button" className="btn btn-primary" disabled={chosen.length === 0} onClick={() => onApprove(chosen)}>
                            {chosen.length === 0 ? "Pick shifts to approve" : `Approve ${chosen.length === 1 ? "1 shift" : `${chosen.length} shifts`} · ${usdc(total)}`}
                        </button>
                    </div>
                </>
            )}

            {data.approvedShifts.length > 0 && (
                <details className="fe-escrow-approved">
                    <summary>Recently approved ({data.approvedShifts.length})</summary>
                    <ul className="fe-money-list">
                        {data.approvedShifts.map((s) => (
                            <li key={s.id} className="fe-money-row">
                                <div className="fe-money-top">
                                    <span>
                                        {s.workDate} · {s.name}
                                        {s.minutes !== null && <span className="fe-hint"> · {hoursText(s.minutes)}</span>}
                                    </span>
                                    <span className="fe-num">
                                        <Money value={s.amount} />
                                    </span>
                                </div>
                                {s.approved && (
                                    <p className="fe-muted">
                                        Approved {istDateTime(s.approved.at)} · <ExplorerTx hash={s.approved.txHash} />
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    )
}

// ------------------------------------------------------------------ modals

function EscrowModal({
    state,
    data,
    owner,
    restaurantId,
    onClose,
    onChanged,
    setMember
}: {
    state: ModalState
    data: EscrowView
    owner: Wallet
    restaurantId: string
    onClose: () => void
    onChanged: () => void
    setMember: (m: EscrowMember, body: { shiftRate?: number | null; autoPay?: boolean }) => Promise<boolean>
}) {
    const { deployment } = useWallet()
    const tx = useEscrowTx()
    const ownerWho = { expect: owner, label: "this restaurant's owner wallet", reason: "Connect this restaurant's owner wallet to use the payroll escrow." }

    // A fresh form each time it opens.
    const key = state ? `${state.kind}:${"m" in state ? state.m.wallet : ""}` : ""
    useEffect(() => {
        tx.setRun(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    if (!state) return null
    const close = () => {
        if (tx.running) return
        onClose()
    }
    const titles: Record<NonNullable<ModalState>["kind"], string> = {
        fund: "Add to the escrow",
        withdraw: "Withdraw available money",
        setup: "Pay setup",
        end: "End schedule",
        approve: "Approve shifts"
    }
    const title = "m" in state ? `${titles[state.kind]}: ${state.m.name ?? shortHex(state.m.wallet)}` : titles[state.kind]
    const finished = () => {
        onChanged()
        onClose()
    }

    return (
        <Modal open onClose={close} title={title} dismissible={!tx.running}>
            {tx.run ? (
                <TxRunView run={tx.run} label="Escrow transaction progress" onBack={() => tx.setRun(null)} onDone={finished} getFunds={() => void tx.getFunds()} />
            ) : state.kind === "fund" ? (
                <FundForm
                    data={data}
                    onCancel={onClose}
                    onSubmit={(amount) =>
                        void tx.go(ESCROW_STEPS, ownerWho, async (clients, step) => ({
                            txHash: await fundEscrow(deployment, clients, amount, step),
                            done: `Added ${usdc(amount)} to the escrow.`
                        }))
                    }
                />
            ) : state.kind === "withdraw" ? (
                <div className="fe-stack">
                    <p>
                        Withdraw everything available now, about <strong>{usdc(data.account.available)}</strong>, to your wallet. Pay set aside for your
                        staff, and pay they have earned, stays in the escrow.
                    </p>
                    <div className="fe-money-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() =>
                                void tx.go(ESCROW_STEPS, ownerWho, async (clients, step) => ({
                                    txHash: await withdrawEscrow(deployment, clients, step),
                                    done: "Withdrew the available money to your wallet."
                                }))
                            }
                        >
                            Withdraw available
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : state.kind === "end" ? (
                <div className="fe-stack">
                    <p>
                        {state.m.name ?? "This person"}'s schedule ({state.m.schedule && <ScheduleLine s={state.m.schedule} />}) stops now. Pay for the time
                        they worked is settled: completed periods in full and the period in progress pro rata, to the second. It stays claimable for them
                        {data.account.shortfall > 0 ? ", and what the escrow can't cover yet stays owed as debt that your next funding pays first" : ""}. What
                        was set aside beyond that returns to your available money.
                    </p>
                    <div className="fe-money-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() =>
                                void tx.go(ESCROW_STEPS, ownerWho, async (clients, step) => ({
                                    txHash: await endSchedule(deployment, clients, { employee: state.m.wallet, name: state.m.name ?? "them" }, step),
                                    done: `Ended the schedule. Pay for the time worked is settled.`
                                }))
                            }
                        >
                            End schedule now
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : state.kind === "approve" ? (
                <div className="fe-stack">
                    <p>
                        Approve {state.shifts.length === 1 ? "1 shift" : `${state.shifts.length} shifts`} for{" "}
                        <strong>{usdc(state.shifts.reduce((t, s) => t + s.amount, 0))}</strong> in one transaction. The pay moves from your available
                        money to each person at once; they can claim it right away. It can't be undone.
                    </p>
                    <div className="fe-money-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() =>
                                void tx.go(APPROVE_STEPS, ownerWho, async (clients, step) => {
                                    const r = await approveShifts(deployment, clients, restaurantId, state.shifts, step)
                                    return { txHash: r.txHash, done: `Approved ${r.shifts.length === 1 ? "1 shift" : `${r.shifts.length} shifts`}. FairPay verified it on Monad.` }
                                })
                            }
                        >
                            Approve
                        </button>
                        <button type="button" className="btn btn-quiet" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <SetupForm
                    m={state.m}
                    data={data}
                    onCancel={onClose}
                    onSaveRate={async (rate) => {
                        if (await setMember(state.m, { shiftRate: rate })) onClose()
                    }}
                    onSchedule={(p) =>
                        void tx.go(ESCROW_STEPS, ownerWho, async (clients, step) => ({
                            txHash: await setSchedule(deployment, clients, { employee: state.m.wallet, name: state.m.name ?? "them", ...p }, step),
                            done: state.m.schedule ? "Changed the schedule. The old one is settled up to now." : "The schedule is set."
                        }))
                    }
                />
            )}
        </Modal>
    )
}

function FundForm({ data, onSubmit, onCancel }: { data: EscrowView; onSubmit: (amount: number) => void; onCancel: () => void }) {
    const [amount, setAmount] = useState("")
    const [tried, setTried] = useState(false)
    const micro = parsePrice(amount)
    const suggestions = [
        ...(data.account.shortfall > 0 ? [{ label: "The shortfall", amount: data.account.shortfall }] : []),
        ...data.suggestions.filter((s) => s.amount > 0).map((s) => ({ label: `Pay for the next ${s.days} days`, amount: s.amount }))
    ]
    // Round suggestions up to whole cents, which the amount field takes.
    const cents = (m: number) => Math.ceil(m / 10_000) * 10_000
    return (
        <form
            className="fe-stack fe-team-form"
            noValidate
            onSubmit={(e) => {
                e.preventDefault()
                setTried(true)
                if (micro !== null) onSubmit(micro)
            }}
        >
            <div className="fe-field">
                <label htmlFor="es-fund">Amount (USDC)</label>
                <input id="es-fund" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" aria-invalid={tried && micro === null ? true : undefined} />
                {tried && micro === null && <span className="fe-field-error">Enter an amount in USDC, e.g. 100 (up to 100,000).</span>}
            </div>
            {suggestions.length > 0 ? (
                <div className="fe-escrow-suggest" role="group" aria-label="Suggested amounts">
                    {suggestions.map((s) => (
                        <button key={s.label} type="button" className="btn btn-secondary btn-sm" onClick={() => setAmount(microToInput(cents(s.amount)))}>
                            {s.label}: {usdc(cents(s.amount))}
                        </button>
                    ))}
                </div>
            ) : (
                <p className="fe-hint">No schedules are running, so there is no suggestion. Add what you plan to approve for shifts.</p>
            )}
            <p className="fe-hint">Your wallet may ask twice: once to allow exactly this amount, once to add it. New money first covers any pay your staff are owed.</p>
            <div className="fe-money-actions">
                <button type="submit" className="btn btn-primary">
                    {micro !== null ? `Add ${usdc(micro)}` : "Add"}
                </button>
                <button type="button" className="btn btn-quiet" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    )
}

type Mode = "none" | "shift" | "schedule"

function SetupForm({
    m,
    data,
    onCancel,
    onSaveRate,
    onSchedule
}: {
    m: EscrowMember
    data: EscrowView
    onCancel: () => void
    onSaveRate: (rate: number | null) => Promise<void>
    onSchedule: (p: { amountPerPeriod: number; period: PayPeriodName; start: number | null }) => void
}) {
    const [mode, setMode] = useState<Mode>(m.schedule ? "schedule" : m.shiftRate ? "shift" : "none")
    const [rate, setRate] = useState(m.shiftRate ? microToInput(m.shiftRate) : "")
    const [amount, setAmount] = useState(m.schedule ? microToInput(m.schedule.amountPerPeriod) : "")
    const [period, setPeriod] = useState<PayPeriodName>(m.schedule?.period ?? "week")
    const [when, setWhen] = useState<"now" | "date">("now")
    const [date, setDate] = useState(istToday)
    const [tried, setTried] = useState(false)
    const [saving, setSaving] = useState(false)
    const name = m.name ?? "this person"
    const changing = !!m.schedule
    const rateMicro = parsePrice(rate)
    const amountMicro = parsePrice(amount)
    const startMs = when === "date" ? Date.parse(`${date}T00:00:00+05:30`) : null
    const now = Date.now()
    const startErr =
        when === "date" && (startMs === null || Number.isNaN(startMs) || startMs < now - 30 * DAY || startMs > now + 30 * DAY || (m.endedAt !== null && startMs < m.endedAt))
            ? `Pick a day within 30 days of today${m.endedAt ? `, not before ${istDate(m.endedAt)} when the last schedule ended` : ""}.`
            : null
    const short = data.account.shortfall > 0

    async function save(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (mode === "shift") {
            if (rateMicro === null) return
            setSaving(true)
            await onSaveRate(rateMicro)
            setSaving(false)
        } else if (mode === "none") {
            setSaving(true)
            await onSaveRate(null)
            setSaving(false)
        } else {
            if (amountMicro === null || startErr) return
            onSchedule({ amountPerPeriod: amountMicro, period, start: changing ? null : startMs })
        }
    }

    return (
        <form className="fe-stack fe-team-form" onSubmit={(e) => void save(e)} noValidate>
            <Segmented<Mode>
                label="How you pay them from the escrow"
                value={mode}
                onChange={setMode}
                options={[
                    { value: "none", label: "None" },
                    { value: "shift", label: "Per shift" },
                    { value: "schedule", label: "Schedule" }
                ]}
            />
            {mode === "none" && (
                <p className="fe-hint">
                    No default pay for {name}. You can still pay them with Pay now.
                    {changing && " Their schedule keeps running until you end it (End schedule)."}
                </p>
            )}
            {mode === "shift" && (
                <>
                    <div className="fe-field">
                        <label htmlFor="es-rate">Pay per shift (USDC)</label>
                        <input id="es-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="20.00" aria-invalid={tried && rateMicro === null ? true : undefined} />
                        {tried && rateMicro === null && <span className="fe-field-error">Enter an amount in USDC, e.g. 20.</span>}
                    </div>
                    <p className="fe-hint">
                        Shifts you add for {name} start at this amount; you can change each one. You approve shifts in batches.
                        {changing && " Their schedule keeps running until you end it."}
                    </p>
                </>
            )}
            {mode === "schedule" && (
                <>
                    <div className="fe-grid2">
                        <div className="fe-field">
                            <label htmlFor="es-amt">Amount per period (USDC)</label>
                            <input id="es-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150.00" aria-invalid={tried && amountMicro === null ? true : undefined} />
                            {tried && amountMicro === null && <span className="fe-field-error">Enter an amount in USDC, e.g. 150.</span>}
                        </div>
                        <Segmented<PayPeriodName>
                            label="Every"
                            value={period}
                            onChange={setPeriod}
                            options={[
                                { value: "day", label: "Day" },
                                { value: "week", label: "Week" },
                                { value: "month", label: "30 days" }
                            ]}
                        />
                    </div>
                    {changing ? (
                        <p className="fe-explain">
                            Changing the schedule settles the current one up to now: completed periods in full and the period in progress pro rata. The new
                            terms start now.
                        </p>
                    ) : (
                        <>
                            <Segmented<"now" | "date">
                                label="Starts"
                                value={when}
                                onChange={setWhen}
                                options={[
                                    { value: "now", label: "Now" },
                                    { value: "date", label: "On a day" }
                                ]}
                            />
                            {when === "date" && (
                                <div className="fe-field">
                                    <label htmlFor="es-start">Start day (India time, midnight)</label>
                                    <input id="es-start" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={tried && startErr ? true : undefined} />
                                    {tried && startErr && <span className="fe-field-error">{startErr}</span>}
                                    <span className="fe-hint">Up to 30 days back (that back pay is set aside at once) or 30 days ahead.</span>
                                </div>
                            )}
                        </>
                    )}
                    <p className="fe-hint">
                        {PERIOD_ADJ[period]} pay becomes claimable as each period completes. While it runs, pay is set aside second by second from your
                        available money; you can't withdraw it. {amountMicro !== null && `About ${usdc(Math.ceil(amountMicro / (period === "day" ? 1 : period === "week" ? 7 : 30)))} a day.`}
                    </p>
                    {short && <Alert>The escrow is short of what your staff earned. Add the shortfall first; until then schedules can't be set or changed.</Alert>}
                </>
            )}
            <div className="fe-money-actions">
                <button type="submit" className="btn btn-primary" disabled={saving || (mode === "schedule" && short)}>
                    {mode === "schedule" ? (changing ? "Change schedule" : "Start schedule") : saving ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn btn-quiet" onClick={onCancel}>
                    Cancel
                </button>
            </div>
            {mode === "schedule" && <Badge tone="warn">Public on Monad: the amount and period</Badge>}
        </form>
    )
}
