import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { Hash } from "viem"
import type { PayKind, PayTarget } from "../../shared/types"
import { api } from "../lib/api"
import { plural, usdc } from "../lib/format"
import {
    forgetPending,
    loadNotes,
    NeedFundsError,
    NotEnoughNotesError,
    payTargetPrivate,
    payTargetPublic,
    pendingPayment,
    PRIVATE_STEPS,
    PUBLIC_STEPS,
    PaymentRejectedError,
    reconcileNotes,
    retryPending,
    subscribeNotes,
    topUp
} from "../lib/payments"
import { sameWallet, useWallet } from "../lib/wallet"
import { Address, Money } from "./Money"
import { Badge } from "./Badge"
import { friendly } from "./errors"
import { Icon } from "./Icon"
import { Modal } from "./Modal"
import { TxSteps, type TxStepsState } from "./TxSteps"

export type PayShareProps = {
    kind: PayKind
    /** Bill participant id or order share id. */
    id: string
    /** The bill's or order's share token (`?t=`), when the viewer arrived by link. */
    token?: string | null
    /** Called once the server has verified the payment on-chain. */
    onPaid?: (target: PayTarget) => void
}

type Mode = "public" | "private"
type Run = {
    title: string
    steps: string[]
    current: number
    detail: string | null
    state: TxStepsState
    footnote?: string
    error?: { text: string; need?: "usdc" | "gas"; notes?: { have: number; need: number } }
    txHash?: Hash
    done?: string
}

/**
 * Pay one share (a bill participant's part, or a guest's share of a restaurant order).
 * Loads GET /pay/:kind/:id, offers Public / Confidential, runs the payment in staged steps and
 * asks the server to verify it, retrying while the chain catches up.
 */
export function PayShare({ kind, id, token, onPaid }: PayShareProps) {
    const { cfg, deployment, publicClient, wallet, requestConnect, ensureChain, refreshBalances, faucet } = useWallet()
    const [target, setTarget] = useState<PayTarget | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [mode, setMode] = useState<Mode>("public")
    const [run, setRun] = useState<Run | null>(null)
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
    const [unspent, setUnspent] = useState(() => loadNotes(deployment).filter((n) => n.depositTx && !n.spentTx).length)
    const [checking, setChecking] = useState(false)
    const busy = useRef(false)
    const onPaidRef = useRef(onPaid)
    onPaidRef.current = onPaid

    const load = useCallback(async () => {
        setLoadError(null)
        try {
            const t = await api.payTarget(kind, id, token)
            setTarget(t)
            return t
        } catch (e) {
            setLoadError(friendly(e))
            return null
        }
    }, [kind, id, token])

    // A payment sent earlier (then a reload or lost connection) is checked before offering to pay again.
    const checkPending = useCallback(async () => {
        if (!pendingPayment(deployment, kind, id)) return
        setChecking(true)
        setNotice(null)
        try {
            const t = await retryPending(deployment, kind, id, token)
            if (t) {
                setTarget(t)
                setNotice({ text: "Your earlier payment is verified." })
                onPaidRef.current?.(t)
            }
        } catch (e) {
            setNotice({ text: `We couldn't confirm a payment you sent earlier: ${friendly(e)}`, error: true })
        } finally {
            setChecking(false)
        }
    }, [deployment, kind, id, token])

    useEffect(() => {
        void load().then(() => checkPending())
    }, [load, checkPending])

    // Keep the notes count live (other tabs, the Profile page).
    useEffect(() => {
        const update = () => setUnspent(loadNotes(deployment).filter((n) => n.depositTx && !n.spentTx).length)
        const off = subscribeNotes(deployment, update)
        return off
    }, [deployment])

    const privatePossible = !!target?.private.possible && !!cfg.relayer
    useEffect(() => {
        if (privatePossible) void reconcileNotes(deployment, publicClient).catch(() => undefined)
    }, [privatePossible, deployment, publicClient])

    // A share tied to a wallet this viewer can't pay from publicly: start on Confidential when that works.
    const publicLockedOut = !!target && publicBlocked(target, wallet?.address)
    useEffect(() => {
        if (publicLockedOut && privatePossible) setMode("private")
    }, [publicLockedOut, privatePossible])

    if (loadError)
        return (
            <div className="payshare">
                <p className="error-text" role="alert">
                    {loadError}
                </p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                    Try again
                </button>
            </div>
        )
    if (!target)
        return (
            <div className="payshare" aria-busy="true">
                <p className="progress">
                    <span className="spinner" aria-hidden="true" />
                    Loading the amount due…
                </p>
            </div>
        )

    const settled = target.status !== "owed" || target.due <= 0
    // Without a relayer key the server can't send private payments, whatever the recipient allows.
    const priv: PayTarget["private"] = cfg.relayer
        ? target.private
        : { possible: false, reason: "Confidential payments are switched off on this server right now (no relayer). Pay publicly instead." }
    const needNotes = priv.possible ? priv.notes : 0
    // Notes are whole 5 USDC each, so a private payment can be a little more than the share (the rest is a tip).
    const privateTotal = priv.possible ? priv.notes * Number(deployment.denomination) : target.due
    const denom = Number(deployment.denomination)
    // Public payments are checked against the share's wallet; private ones don't name a payer.
    const payerMismatch = mode === "public" && publicLockedOut

    const finish = (t: PayTarget, txHash: Hash | undefined, how: Mode) => {
        setTarget(t)
        setRun((r) =>
            r
                ? {
                      ...r,
                      state: "done",
                      current: r.steps.length - 1,
                      detail: null,
                      txHash,
                      done:
                          how === "private"
                              ? "Paid confidentially. FairPay verified the payment on Monad; your wallet isn't linked to it."
                              : "Paid. FairPay verified the payment on Monad."
                  }
                : r
        )
        void refreshBalances().catch(() => undefined)
        onPaidRef.current?.(t)
    }

    const fail = (e: unknown) => {
        const err: Run["error"] = { text: friendly(e) }
        if (e instanceof NeedFundsError) err.need = e.need
        if (e instanceof NotEnoughNotesError) err.notes = { have: e.have, need: e.need }
        if (e instanceof PaymentRejectedError) err.text = `FairPay didn't count this payment: ${e.message}`
        setRun((r) => (r ? { ...r, state: "error", error: err } : r))
    }

    const pay = async () => {
        if (busy.current) return
        busy.current = true
        setNotice(null)
        try {
            if (mode === "public") {
                let w = wallet
                if (!w) {
                    w = await requestConnect({ signIn: false, reason: "Connect the wallet you want to pay with." })
                    if (!w) return
                }
                if (publicBlocked(target, w.address)) {
                    setNotice({ text: LOCKED_TEXT, error: true })
                    return
                }
                setRun({ title: `Pay ${usdc(target.due)}`, steps: PUBLIC_STEPS, current: 0, detail: null, state: "running" })
                await ensureChain(w)
                const r = await payTargetPublic(deployment, w.clients, target, token, (i, detail) =>
                    setRun((x) => (x ? { ...x, current: i, detail: detail ?? null } : x))
                )
                finish(r.target, r.txHash, "public")
            } else {
                setRun({
                    title: `Pay ${usdc(privateTotal)} confidentially`,
                    steps: PRIVATE_STEPS,
                    current: 0,
                    detail: null,
                    state: "running",
                    footnote: "Building the proof usually takes 5 to 15 seconds. Keep this tab open."
                })
                const r = await payTargetPrivate(deployment, publicClient, target, token, (i, detail) =>
                    setRun((x) => (x ? { ...x, current: i, detail: detail ?? null } : x))
                )
                finish(r.target, r.txHash, "private")
            }
        } catch (e) {
            fail(e)
        } finally {
            busy.current = false
        }
    }

    const addNotes = async (count: number) => {
        if (busy.current) return
        let w = wallet
        if (!w) {
            w = await requestConnect({ signIn: false, reason: "Connect the wallet that pays for the notes. Adding notes is visible on-chain." })
            if (!w) return
        }
        busy.current = true
        const privacy = "Adding notes is a public transaction from your wallet. Paying with them later is not linked to it."
        setRun({
            title: `Add ${usdc(count * denom)} to your private balance`,
            steps: ["Check your balance", "Deposit from your wallet"],
            current: 0,
            detail: null,
            state: "running",
            footnote: privacy
        })
        try {
            await ensureChain(w)
            // The steps arrive with the plan: how many confirmations depends on the allowance and the wallet.
            await topUp(deployment, w.clients, count, (p) =>
                setRun((r) =>
                    r
                        ? { ...r, steps: p.steps, current: p.current, detail: p.detail || null, footnote: p.summary ? `${p.summary} ${privacy}` : privacy }
                        : r
                )
            )
            setRun((r) => (r ? { ...r, state: "done", current: r.steps.length - 1, detail: null, done: `Added ${plural(count, "note")} to your private balance.` } : r))
            void refreshBalances().catch(() => undefined)
        } catch (e) {
            fail(e)
        } finally {
            busy.current = false
        }
    }

    const getFunds = async () => {
        try {
            const text = await faucet()
            setRun((r) => (r ? { ...r, error: r.error ? { ...r.error, text: `${text} Then try again.` } : r.error } : r))
        } catch (e) {
            setRun((r) => (r ? { ...r, error: { text: friendly(e) } } : r))
        }
    }

    const closeRun = () => setRun(null)

    return (
        <section className="payshare" aria-label="Pay this share">
            <div className="payshare-head">
                <div>
                    <p className="payshare-label">{settled ? "Amount" : "Amount due"}</p>
                    <p className="payshare-amount">
                        <Money value={settled ? target.amount + target.tip : target.due} />
                    </p>
                    {target.tip > 0 && (
                        <p className="field-hint">
                            Includes a <Money value={target.tip} /> tip for {target.recipientName}.
                        </p>
                    )}
                </div>
                {settled && <Badge tone={target.status === "covered" ? "neutral" : "verified"}>{target.status === "covered" ? "Covered" : "Paid"}</Badge>}
            </div>
            <p className="payshare-to">
                To <strong>{target.recipientName}</strong> <Address value={target.recipient} href={`${cfg.explorer}/address/${target.recipient}`} />
            </p>

            {checking && (
                <p className="progress" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Checking a payment you already sent…
                </p>
            )}

            {settled ? (
                <p className="muted">
                    {target.status === "covered" ? "This share is covered. Nothing to pay." : "This share is paid and verified on Monad. Nothing more to do."}
                </p>
            ) : (
                <>
                    <fieldset className="paymode" disabled={checking}>
                        <legend className="field-label">How do you want to pay?</legend>
                        <label className="paymode-option" data-checked={mode === "public" || undefined} data-disabled={publicLockedOut || undefined}>
                            <input
                                type="radio"
                                name={`mode-${kind}-${id}`}
                                checked={mode === "public"}
                                disabled={publicLockedOut}
                                onChange={() => setMode("public")}
                                aria-describedby={publicLockedOut ? `lock-${kind}-${id}` : undefined}
                            />
                            <span className="paymode-text">
                                <span className="paymode-title">Public</span>
                                <span className="paymode-desc">Paid from your wallet. Anyone can see on-chain that your wallet paid.</span>
                                {publicLockedOut && (
                                    <span className="paymode-why" id={`lock-${kind}-${id}`}>
                                        {LOCKED_TEXT}
                                        {target.expectedPayer && (
                                            <>
                                                {" "}
                                                It's tied to <Address value={target.expectedPayer} />.
                                            </>
                                        )}
                                    </span>
                                )}
                            </span>
                        </label>
                        <label className="paymode-option is-private" data-checked={mode === "private" || undefined} data-disabled={!priv.possible || undefined}>
                            <input
                                type="radio"
                                name={`mode-${kind}-${id}`}
                                checked={mode === "private"}
                                disabled={!priv.possible}
                                onChange={() => setMode("private")}
                                aria-describedby={`why-${kind}-${id}`}
                            />
                            <span className="paymode-text">
                                <span className="paymode-title">
                                    <Icon name="lock" size={15} /> Confidential
                                </span>
                                <span className="paymode-desc">
                                    Hides who paid: your wallet isn't linked to the payment. It doesn't hide the amount; each note is {usdc(denom)}.
                                </span>
                                <span className="paymode-why" id={`why-${kind}-${id}`}>
                                    {priv.possible ? (
                                        <>
                                            Uses {plural(priv.notes, "note")} ({usdc(priv.notes * denom)}).
                                            {priv.tip > 0 && (
                                                <>
                                                    {" "}
                                                    {usdc(priv.tip)} more than your share goes to {target.recipientName} as a tip.
                                                </>
                                            )}
                                        </>
                                    ) : (
                                        priv.reason
                                    )}
                                </span>
                            </span>
                        </label>
                    </fieldset>

                    {mode === "private" && priv.possible && unspent < needNotes && (
                        <div className="callout callout-private">
                            <p>
                                You have {plural(unspent, "note")} ready and this needs {needNotes}. Add {needNotes - unspent} more first.
                            </p>
                            <p className="field-hint">
                                Adding notes is visible on-chain. Adding them well before you pay makes the payment harder to link to you.
                            </p>
                            <div className="row">
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void addNotes(needNotes - unspent)}>
                                    Add {usdc((needNotes - unspent) * denom)} to private balance
                                </button>
                                <Link to="/profile" className="link-sm">
                                    Manage private balance
                                </Link>
                            </div>
                        </div>
                    )}

                    {payerMismatch && (
                        <p className="callout callout-warn">
                            {LOCKED_TEXT}
                            {priv.possible ? " You can still pay it confidentially." : ""}
                        </p>
                    )}

                    <div className="payshare-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={checking || payerMismatch || (mode === "private" && (!priv.possible || unspent < needNotes))}
                            onClick={() => void pay()}
                        >
                            {mode === "private" ? <Icon name="lock" size={18} /> : null}
                            {mode === "public" && !wallet
                                ? `Connect wallet to pay ${usdc(target.due)}`
                                : `Pay ${usdc(mode === "private" ? privateTotal : target.due)}`}
                        </button>
                    </div>
                </>
            )}

            <div aria-live="polite">
                {notice && <p className={notice.error ? "error-text" : "success-text"}>{notice.text}</p>}
            </div>
            {notice?.error && pendingPayment(deployment, kind, id) && (
                <div className="row">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void checkPending()}>
                        Check again
                    </button>
                    <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                            forgetPending(deployment, kind, id)
                            setNotice(null)
                        }}
                    >
                        Forget it
                    </button>
                </div>
            )}

            <Modal open={!!run} onClose={closeRun} title={run?.title ?? ""} dismissible={run?.state !== "running"}>
                {run && (
                    <>
                        <TxSteps steps={run.steps} current={run.current} state={run.state} detail={run.detail} footnote={run.state === "running" ? run.footnote : undefined} />
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
                                <button type="button" className="btn btn-primary" onClick={closeRun}>
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
                                    {run.error.notes && (
                                        <Link to="/profile" className="btn btn-secondary btn-sm">
                                            Add notes on your profile
                                        </Link>
                                    )}
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={closeRun}>
                                        Close
                                    </button>
                                </div>
                                {run.error.need && !cfg.faucet && <p className="field-hint">The test faucet is off on this server. Send test USDC to your wallet, then try again.</p>}
                            </div>
                        )}
                    </>
                )}
            </Modal>
        </section>
    )
}

const LOCKED_TEXT = "This share is tied to another wallet. Sign in with that wallet to pay it."

/**
 * Whether a public payment from `address` would be refused. The server only reveals the share's
 * wallet to that wallet and the bill's creator/recipient, so a locked share with no wallet shown
 * belongs to someone else. When the wallet is known and nothing is connected yet, connecting is allowed.
 */
function publicBlocked(target: PayTarget, address: string | undefined) {
    if (!target.payerLocked) return false
    if (!target.expectedPayer) return true
    return !!address && !sameWallet(address, target.expectedPayer)
}

/**
 * A "Pay" button that opens PayShare in a dialog. Handy for lists with one button per share.
 */
export function PayButton({ label = "Pay", className = "btn btn-primary btn-sm", ...props }: PayShareProps & { label?: string; className?: string }) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button type="button" className={className} onClick={() => setOpen(true)}>
                {label}
            </button>
            <Modal open={open} onClose={() => setOpen(false)} title="Pay your share">
                {open && <PayShare {...props} />}
            </Modal>
        </>
    )
}
