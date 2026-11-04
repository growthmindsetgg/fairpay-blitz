// My pay, escrow part: what this restaurant's owner has set aside for the signed-in staff member in
// the payroll escrow (FairPayroll), read from the chain by the server. They claim with their own
// wallet; the money goes straight to it. Shown only when the deployment has a payroll contract.

import { useCallback, useEffect, useState } from "react"
import type { EscrowEvent, MyEscrowView } from "../../../../shared/types"
import { Badge, Modal, Money, useWallet } from "../../../components"
import { escrowApi } from "../../../lib/api"
import { usdc } from "../../../lib/format"
import { claimEscrow, ESCROW_STEPS, leavePayroll } from "../../../lib/payroll"
import { errorText } from "../client"
import { Alert, istDateTime, Loading } from "../ui"
import { EventRow, PositionTiles, ScheduleLine, TxRunView, useEscrowTx } from "./escrowUi"
import { ExplorerTx } from "./TeamPayTab"

export function MyEscrow({ restaurantId, restaurantName }: { restaurantId: string; restaurantName: string }) {
    const { deployment, me } = useWallet()
    const [data, setData] = useState<MyEscrowView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [older, setOlder] = useState<{ items: EscrowEvent[]; next: string | null; loading: boolean }>({ items: [], next: null, loading: false })
    const [open, setOpen] = useState<null | "claim" | "leave">(null)
    const tx = useEscrowTx()

    const load = useCallback(async () => {
        try {
            const v = await escrowApi.mine(restaurantId)
            setData(v)
            setOlder({ items: [], next: v.next, loading: false })
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
        setOlder((o) => ({ ...o, loading: true }))
        try {
            const page = await escrowApi.mineHistory(restaurantId, older.next)
            setOlder((o) => ({ items: [...o.items, ...page.events], next: page.next, loading: false }))
        } catch (e) {
            setOlder((o) => ({ ...o, loading: false }))
            setError(errorText(e))
        }
    }

    if (error && !data) return <Alert>Your escrow pay didn't load: {error}</Alert>
    if (!data) return <Loading label="Reading your escrow pay…" />
    const p = data.position
    const events = [...data.events, ...older.items]
    const mine = me?.profile.wallet
    const who = mine ? { expect: mine, label: "the wallet you signed in with", reason: "Connect your wallet to claim your pay." } : null
    const empty = p.earned === 0 && !data.schedule && data.shifts.length === 0 && events.length === 0

    const start = (what: "claim" | "leave") => {
        tx.setRun(null)
        setOpen(what)
        if (!who) return
        if (what === "claim") {
            void tx.go(ESCROW_STEPS, who, async (clients, step) => ({
                txHash: await claimEscrow(deployment, clients, data.employer, step),
                done: "Claimed. The pay is in your wallet."
            }))
        }
    }
    const close = () => {
        if (tx.running) return
        setOpen(null)
        void load()
    }

    return (
        <section className="fe-section" aria-labelledby="fe-myescrow-h">
            <div className="fe-row-between">
                <h3 id="fe-myescrow-h" className="fe-h3">
                    Payroll escrow
                </h3>
                <div className="fe-money-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={p.claimable === 0 || !who} onClick={() => start("claim")}>
                        {p.claimable > 0 ? `Claim ${usdc(p.claimable)}` : "Nothing to claim"}
                    </button>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => void load()}>
                        Refresh
                    </button>
                </div>
            </div>
            <p className="fe-hint">
                Pay {restaurantName}'s owner set aside for you. Claim it with your own wallet; it goes straight there. Your schedule, shift pay and
                claims are public on Monad.
            </p>
            {error && <Alert>Couldn't refresh: {error}</Alert>}
            {empty ? (
                <div className="fe-empty">
                    <p>
                        <strong>No escrow pay yet.</strong> When the owner approves your shifts or sets a pay schedule, it shows up here.
                    </p>
                </div>
            ) : (
                <>
                    <PositionTiles p={p} />
                    <p>
                        {data.schedule ? (
                            <>
                                Your pay schedule: <ScheduleLine s={data.schedule} />.
                            </>
                        ) : (
                            <span className="fe-muted">No pay schedule running.</span>
                        )}
                        {data.autoPay && " Auto-pay is on: FairPay sends what you can claim to your wallet for you, now and then."}
                    </p>
                    {p.shortfall > 0 && (
                        <Alert tone="info">
                            {usdc(p.shortfall)} you earned isn't funded yet. It stays owed to you and becomes claimable when the owner adds money.
                        </Alert>
                    )}
                    {data.schedule && p.shortfall > 0 && (
                        <p className="fe-explain">
                            If the owner doesn't fund the escrow, you can leave the payroll. Your unfunded pay then joins the shared repayment pool, which
                            the owner's next funding pays before any schedule that is still running.
                        </p>
                    )}
                    {data.schedule && (
                        <p>
                            <button type="button" className="fe-link" onClick={() => start("leave")}>
                                Leave this restaurant's payroll
                            </button>
                        </p>
                    )}
                </>
            )}

            {data.shifts.length > 0 && (
                <>
                    <h4 className="fe-h3">Your shifts</h4>
                    <ul className="fe-money-list">
                        {data.shifts.map((s) => (
                            <li key={s.id} className="fe-money-row">
                                <div className="fe-money-top">
                                    <span>
                                        {s.workDate}
                                        {s.minutes !== null && <span className="fe-hint"> · {(s.minutes / 60).toLocaleString("en-US", { maximumFractionDigits: 2 })} h</span>}
                                        {s.note && <span className="fe-hint fe-break"> · “{s.note}”</span>}
                                    </span>
                                    <span className="fe-money-badges">
                                        <span className="fe-num">
                                            <Money value={s.amount} />
                                        </span>
                                        {s.status === "approved" ? <Badge tone="verified">Approved</Badge> : <Badge tone="warn">Waiting for approval</Badge>}
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
                </>
            )}

            {events.length > 0 && (
                <>
                    <h4 className="fe-h3">Escrow history</h4>
                    <ol className="fe-money-list">
                        {events.map((e) => (
                            <EventRow key={e.id} e={e} mine />
                        ))}
                    </ol>
                    {older.loading && <Loading label="Loading events…" />}
                    {older.next && !older.loading && (
                        <button type="button" className="btn btn-secondary" onClick={() => void more()}>
                            Show older events
                        </button>
                    )}
                </>
            )}

            <Modal open={open !== null} onClose={close} title={open === "leave" ? "Leave this restaurant's payroll" : "Claim your pay"} dismissible={!tx.running}>
                {tx.run ? (
                    <TxRunView run={tx.run} label="Escrow transaction progress" onBack={() => (open === "claim" ? close() : tx.setRun(null))} onDone={close} getFunds={() => void tx.getFunds()} />
                ) : open === "leave" ? (
                    <div className="fe-stack">
                        <p>
                            This ends your pay schedule with {restaurantName} now. Pay for the time you worked is settled: completed periods in full and the
                            period in progress pro rata, to the second. What the escrow holds for it becomes claimable here. What isn't funded joins the
                            shared repayment pool: the owner's next funding pays that pool first, shared pro rata between everyone owed, before any running
                            schedule. Nothing more is earned on this schedule afterwards, and only the owner can start a new one.
                        </p>
                        <div className="fe-money-actions">
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() =>
                                    who &&
                                    void tx.go(ESCROW_STEPS, who, async (clients, step) => ({
                                        txHash: await leavePayroll(deployment, clients, data.employer, step),
                                        done: "You left the payroll. Your pay for the time worked is settled."
                                    }))
                                }
                            >
                                End my schedule
                            </button>
                            <button type="button" className="btn btn-quiet" onClick={close}>
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <Loading label="Opening your wallet…" />
                )}
            </Modal>
        </section>
    )
}
