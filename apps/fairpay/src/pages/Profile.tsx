import { poolSupportsWithdraw } from "@fairpay/sdk"
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { CopyButton } from "../components/CopyLink"
import { friendly } from "../components/errors"
import { Input, Textarea } from "../components/Field"
import { Icon } from "../components/Icon"
import { Money } from "../components/Money"
import { TxSteps, type TxStepsState } from "../components/TxSteps"
import { PageHeader, SignInGate, useTitle } from "../components/Page"
import { api } from "../lib/api"
import { plural, shortHex, usdc } from "../lib/format"
import {
    BackupError,
    exportNotes,
    loadNotes,
    NeedFundsError,
    poolSize,
    reconcileNotes,
    restoreNotes,
    subscribeNotes,
    topUp,
    withdrawOne,
    WITHDRAW_STEPS,
    type StoredNote
} from "../lib/payments"
import { useWallet } from "../lib/wallet"

export function Profile() {
    useTitle("Profile")
    return (
        <div className="content">
            <PageHeader title="Profile" description="Your name, your wallet, and your private balance for confidential payments." />
            <SignInGate title="Sign in to see your profile">
                <div className="profile-grid">
                    <ProfileForm />
                    <WalletCard />
                    <PrivateBalance />
                </div>
            </SignInGate>
        </div>
    )
}

function ProfileForm() {
    const { me, refreshMe } = useWallet()
    const [displayName, setDisplayName] = useState(me?.profile.displayName ?? "")
    const [email, setEmail] = useState(me?.profile.email ?? "")
    const [bio, setBio] = useState(me?.profile.bio ?? "")
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
    const [emailError, setEmailError] = useState<string | null>(null)

    const save = async (e: FormEvent) => {
        e.preventDefault()
        setMsg(null)
        setEmailError(null)
        const em = email.trim()
        if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return setEmailError("That email address doesn't look right.")
        setSaving(true)
        try {
            await api.updateMe({ displayName: displayName.trim() || null, email: em || null, bio: bio.trim() || null })
            await refreshMe()
            setMsg({ text: "Profile saved." })
        } catch (err) {
            setMsg({ text: friendly(err), error: true })
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="card" aria-labelledby="profile-h">
            <div className="card-head">
                <h2 className="card-title" id="profile-h">
                    About you
                </h2>
            </div>
            <form className="form-grid" onSubmit={save} noValidate>
                <Input label="Display name" value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} hint="Shown to people on your bills instead of your wallet address." autoComplete="nickname" />
                <Input label="Email" optional type="email" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} hint="Private. Never shown to anyone else." error={emailError} autoComplete="email" />
                <Textarea label="Bio" optional value={bio} maxLength={280} onChange={(e) => setBio(e.target.value)} rows={3} />
                <div className="row">
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                        {saving ? "Saving…" : "Save profile"}
                    </button>
                    <div aria-live="polite">{msg && <p className={msg.error ? "error-text" : "success-text"}>{msg.text}</p>}</div>
                </div>
            </form>
        </section>
    )
}

function WalletCard() {
    const { me, wallet, balances, cfg, faucet, requestConnect, disconnect, mismatch, signIn } = useWallet()
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

    const run = async (label: string, fn: () => Promise<string | void>) => {
        setBusy(label)
        setMsg(null)
        try {
            const r = await fn()
            if (r) setMsg({ text: r })
        } catch (e) {
            setMsg({ text: friendly(e), error: true })
        } finally {
            setBusy(null)
        }
    }

    return (
        <section className="card" aria-labelledby="wallet-h">
            <div className="card-head">
                <h2 className="card-title" id="wallet-h">
                    Wallet
                </h2>
                {wallet && <span className="badge">{wallet.kind === "test" ? "Test wallet · testnet only" : wallet.name}</span>}
            </div>
            <div className="stack">
                <div className="stack-sm">
                    <p className="field-label">Signed in as</p>
                    <div className="address-row">
                        <span className="mono">{me?.profile.wallet}</span>
                        {me && <CopyButton text={me.profile.wallet} label="Copy address" />}
                    </div>
                </div>
                {mismatch && wallet && (
                    <div className="callout callout-warn">
                        <p>Your connected wallet is a different address from the one you signed in with.</p>
                        <div>
                            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run("Signing in…", async () => void (await signIn(wallet)))}>
                                Sign in with the connected wallet
                            </button>
                        </div>
                    </div>
                )}
                {wallet ? (
                    <>
                        <div className="stat-grid">
                            <div className="stat">
                                <span className="stat-label">Public balance</span>
                                <span className="stat-value">{balances ? usdc(Number(balances.usdc)) : "…"}</span>
                            </div>
                            <div className="stat">
                                <span className="stat-label">For gas</span>
                                <span className="stat-value">{balances ? `${(Number(balances.mon) / 1e18).toFixed(3)} MON` : "…"}</span>
                            </div>
                        </div>
                        <div className="row">
                            {cfg.faucet && (
                                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run("Sending test funds…", faucet)}>
                                    <Icon name="drop" size={16} />
                                    {busy === "Sending test funds…" ? busy : "Get test USDC"}
                                </button>
                            )}
                            <a className="btn btn-secondary btn-sm" href={`${cfg.explorer}/address/${wallet.address}`} target="_blank" rel="noreferrer">
                                View on explorer
                                <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                            <button type="button" className="btn btn-quiet btn-sm" onClick={disconnect}>
                                Disconnect
                            </button>
                        </div>
                        {wallet.kind === "test" && (
                            <p className="callout callout-warn">
                                This test wallet's key is kept in this browser only. It's for Monad Testnet. Never send real funds to it.
                            </p>
                        )}
                    </>
                ) : (
                    <div className="stack-sm">
                        <p className="muted">No wallet is connected in this browser. Connect one to pay, add notes or get test funds.</p>
                        <div>
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => void requestConnect({ signIn: false })}>
                                <Icon name="wallet" size={16} />
                                Connect a wallet
                            </button>
                        </div>
                    </div>
                )}
                <div aria-live="polite">{msg && <p className={msg.error ? "error-text" : "success-text"}>{msg.text}</p>}</div>
            </div>
        </section>
    )
}

/** Private notes for confidential payments, kept in this browser. Ported from FairEats' wallet page. */
function PrivateBalance() {
    const { cfg, deployment, publicClient, wallet, balances, refreshBalances, requestConnect, ensureChain, faucet } = useWallet()
    const [notes, setNotes] = useState<StoredNote[]>(() => loadNotes(deployment))
    const [busy, setBusy] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [pool, setPool] = useState<{ deposits: number; mine: number } | null | "error">(null)
    const [withdrawable, setWithdrawable] = useState<boolean | null>(null)
    const [wd, setWd] = useState<WithdrawRun | null>(null)
    const inFlight = useRef(false)
    const fileInput = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const update = () => setNotes(loadNotes(deployment))
        const off = subscribeNotes(deployment, update)
        void reconcileNotes(deployment, publicClient).then(update, () => undefined)
        return off
    }, [deployment, publicClient])

    const loadPool = async () => {
        try {
            setPool(await poolSize(deployment))
        } catch {
            setPool("error")
        }
    }
    const depositCount = notes.filter((n) => n.depositTx).length
    useEffect(() => {
        void loadPool()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deployment, depositCount])

    // An older pool has no withdraw: the button stays off with a plain reason instead of failing.
    useEffect(() => {
        let live = true
        setWithdrawable(null)
        poolSupportsWithdraw(deployment, publicClient).then(
            (ok) => live && setWithdrawable(ok),
            // A network hiccup isn't "unsupported": let the click try, and show the real error then.
            () => live && setWithdrawable(true)
        )
        return () => {
            live = false
        }
    }, [deployment, publicClient])

    const run = async (label: string, fn: () => Promise<string | void>) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(label)
        setError(null)
        setMessage(null)
        try {
            const done = await fn()
            if (done) setMessage(done)
        } catch (e) {
            setError(friendly(e))
        } finally {
            inFlight.current = false
            setBusy(null)
            setNotes(loadNotes(deployment))
            void refreshBalances().catch(() => undefined)
        }
    }

    const unspent = notes.filter((n) => n.depositTx && !n.spentTx)
    const spent = notes.filter((n) => n.spentTx)
    const unconfirmed = notes.filter((n) => !n.depositTx)
    const denom = Number(deployment.denomination)

    const add = (k: number) =>
        run("Adding…", async () => {
            let w = wallet
            if (!w) {
                w = await requestConnect({ signIn: false, reason: "Connect the wallet that pays for the notes. Adding notes is visible on-chain." })
                if (!w) return
            }
            await ensureChain(w)
            // One line: how many confirmations to expect, then what to confirm now.
            await topUp(deployment, w.clients, k, (p) =>
                setBusy(p.summary && p.detail !== p.summary ? `${p.summary} ${p.detail}` : p.detail || "Checking your balance…")
            )
            return `Added ${plural(k, "note")} to your private balance.`
        })

    const withdraw = async () => {
        if (inFlight.current) return
        let w = wallet
        if (!w) {
            w = await requestConnect({ signIn: false, reason: `Connect the wallet that should receive the ${usdc(denom)}. Withdrawing is visible on-chain.` })
            if (!w) return
        }
        inFlight.current = true
        setBusy(WITHDRAWING)
        setError(null)
        setMessage(null)
        setWd({ steps: WITHDRAW_STEPS, current: 0, detail: null, state: "running" })
        try {
            await ensureChain(w)
            const r = await withdrawOne(deployment, w.clients, (current, detail) => setWd((x) => (x ? { ...x, current, detail: detail ?? null } : x)))
            setWd((x) => (x ? { ...x, state: "done", current: x.steps.length - 1, detail: null, txHash: r.txHash } : x))
            setMessage(`Withdrew ${usdc(denom)} to ${shortHex(r.recipient)}.`)
        } catch (e) {
            setWd((x) => (x ? { ...x, state: "error", need: e instanceof NeedFundsError ? e.need : undefined } : x))
            setError(friendly(e))
        } finally {
            inFlight.current = false
            setBusy(null)
            setNotes(loadNotes(deployment))
            void refreshBalances().catch(() => undefined)
        }
    }

    const getGas = () =>
        run("Sending test funds…", async () => {
            const text = await faucet()
            setWd(null)
            return `${text} Then try again.`
        })

    const noGas = !!wallet && balances !== null && balances.mon === 0n
    const withdrawOff =
        withdrawable === false
            ? "This pool can't withdraw notes yet."
            : unspent.length === 0
              ? "No notes ready to withdraw."
              : noGas
                ? "Your wallet needs a little MON for gas."
                : null

    const download = () => {
        const blob = new Blob([exportNotes(deployment)], { type: "application/json" })
        const a = document.createElement("a")
        a.href = URL.createObjectURL(blob)
        a.download = "fairpay-notes-backup.json"
        document.body.appendChild(a)
        a.click()
        a.remove()
        // Revoking right away can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }

    const restore = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        e.target.value = ""
        if (!file) return
        void run("Checking the backup…", async () => {
            if (file.size > 1_000_000) throw new BackupError("That file is too large to be a notes backup.")
            const r = await restoreNotes(deployment, publicClient, await file.text())
            const parts = [
                r.added ? `Restored ${plural(r.added, "note")}.` : "No new notes in that backup.",
                r.duplicates ? `${r.duplicates} already in this browser.` : "",
                r.skipped ? `${r.skipped} unreadable or for another pool, skipped.` : ""
            ]
            return parts.filter(Boolean).join(" ")
        })
    }

    return (
        <section className="card span-2" aria-labelledby="private-h">
            <div className="card-head">
                <h2 className="card-title" id="private-h">
                    <Icon name="lock" size={18} className="inline-icon" /> Confidential balance
                </h2>
            </div>
            <div className="stack">
                <p className="muted">
                    Confidential payments use notes of {usdc(denom)} each. A confidential payment hides which wallet paid; it doesn't hide the
                    amount. Adding a note is a public transaction from your wallet; paying with it later isn't linked back to you. Confidential
                    payments are available at verified businesses.
                </p>
                <div className="stat-grid">
                    <div className="stat">
                        <span className="stat-label">Ready to spend</span>
                        <span className="stat-value">
                            <Money value={unspent.length * denom} />
                        </span>
                        <span className="stat-sub">
                            {plural(unspent.length, "note")} × {usdc(denom)}
                        </span>
                    </div>
                    <div className="stat">
                        <span className="stat-label">Spent</span>
                        <span className="stat-value">{spent.length}</span>
                        <span className="stat-sub">{spent.length === 1 ? "note" : "notes"}</span>
                    </div>
                    {unconfirmed.length > 0 && (
                        <div className="stat">
                            <span className="stat-label">Waiting for the pool</span>
                            <span className="stat-value">{unconfirmed.length}</span>
                            <span className="stat-sub">not confirmed yet</span>
                        </div>
                    )}
                </div>
                {notes.some((n) => n.depositTx) && (
                    <div className="note-strip" aria-hidden="true">
                        {notes
                            .filter((n) => n.depositTx)
                            .map((n, i) => (
                                <span key={i} className="note-chip" data-spent={!!n.spentTx} />
                            ))}
                    </div>
                )}

                <div className="stack-sm" role="group" aria-labelledby="pool-h">
                    <h3 id="pool-h" className="field-label">
                        Who you blend in with
                    </h3>
                    {pool === null ? (
                        <p className="field-hint">Counting deposits in the pool…</p>
                    ) : pool === "error" ? (
                        <p className="field-hint">
                            We couldn't count the pool's deposits right now.{" "}
                            <button type="button" className="linkish" onClick={() => void loadPool()}>
                                Try again
                            </button>
                        </p>
                    ) : (
                        <>
                            <p className="muted">
                                You blend in with <strong>{plural(pool.deposits - pool.mine, "other deposit")}</strong>. Yours: {pool.mine}. A private
                                payment proves it came from one of the pool's deposits without saying which.
                            </p>
                            {pool.deposits - pool.mine < 10 && <p className="callout callout-warn">Fewer than 10 is a small crowd: timing alone can point to you.</p>}
                            <p className="field-hint">More deposits from other people, and more time between adding and paying, make a payment harder to link to you.</p>
                        </>
                    )}
                </div>

                <div aria-live="polite">
                    {busy && busy !== WITHDRAWING && (
                        <p className="progress">
                            <span className="spinner" aria-hidden="true" />
                            {busy}
                        </p>
                    )}
                </div>

                <div className="row">
                    {[1, 3].map((k) => (
                        <button key={k} type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void add(k)}>
                            Add {usdc(k * denom)}
                        </button>
                    ))}
                    <span className="field-hint">Adding is visible on-chain. Add early, pay later.</span>
                </div>
                <div className="stack-sm" role="group" aria-labelledby="withdraw-h">
                    <h3 id="withdraw-h" className="field-label">
                        Withdraw
                    </h3>
                    <p className="field-hint">Moves one note's {usdc(denom)} back to your wallet. This is a normal transaction from your wallet, so it is public.</p>
                    <div className="row">
                        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || withdrawOff !== null || withdrawable === null} onClick={() => void withdraw()}>
                            {busy === WITHDRAWING ? "Withdrawing…" : `Withdraw ${usdc(denom)} to my wallet`}
                        </button>
                        {withdrawOff ? (
                            <span className="field-hint">{withdrawOff}</span>
                        ) : (
                            wallet && <span className="field-hint">To {shortHex(wallet.address)}. Gas is about 0.15 MON.</span>
                        )}
                    </div>
                    {wd && (
                        <>
                            <TxSteps steps={wd.steps} current={wd.current} state={wd.state} detail={wd.detail} label="Withdrawal progress" footnote={wd.state === "running" ? "Keep this tab open." : undefined} />
                            {wd.state === "done" && wd.txHash && (
                                <p className="field-hint">
                                    <a href={`${cfg.explorer}/tx/${wd.txHash}`} target="_blank" rel="noreferrer">
                                        View the withdrawal on the explorer<span className="sr-only"> (opens in a new tab)</span>
                                    </a>
                                </p>
                            )}
                            {wd.state === "error" && wd.need === "gas" && cfg.faucet && (
                                <div>
                                    <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void getGas()}>
                                        Get test funds
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="row">
                    <button type="button" className={unspent.length > 0 ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"} disabled={notes.length === 0 || !!busy} onClick={download}>
                        Back up notes
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => fileInput.current?.click()}>
                        Restore from backup
                    </button>
                    <input ref={fileInput} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={restore} />
                </div>
                <p className="callout callout-private">
                    Notes are stored only in this browser. Whoever has them can spend them, and clearing site data deletes them. Back them up if
                    they hold anything you care about, and keep the backup file private.
                </p>
                <div aria-live="polite">
                    {message && <p className="success-text">{message}</p>}
                    {error && (
                        <p className="error-text" role="alert">
                            {error}
                        </p>
                    )}
                </div>
            </div>
        </section>
    )
}

const WITHDRAWING = "withdrawing"

type WithdrawRun = { steps: string[]; current: number; detail: string | null; state: TxStepsState; txHash?: string; need?: "usdc" | "gas" }
