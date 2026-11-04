import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { shortHex, usdc } from "../lib/format"
import { useWallet, type WalletChoice } from "../lib/wallet"
import { friendly } from "./errors"
import { Icon } from "./Icon"
import { Modal } from "./Modal"

/**
 * The wallet picker dialog. Mounted once near the root; opened through `requestConnect()` from
 * useWallet(), which resolves once a wallet is connected (and signed in when asked).
 */
export function WalletPicker() {
    const { pickerOpen, pickerOptions, resolvePicker, injected, connect, signIn } = useWallet()
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (pickerOpen) {
            setBusy(null)
            setError(null)
        }
    }, [pickerOpen])

    const choose = async (choice: WalletChoice) => {
        setError(null)
        setBusy("Connecting to your wallet…")
        try {
            const w = await connect(choice)
            if (pickerOptions.signIn) {
                setBusy(w.kind === "test" ? "Signing in…" : "Sign the message in your wallet to sign in. It's free and sends nothing.")
                await signIn(w)
            }
            resolvePicker(w)
        } catch (e) {
            setError(friendly(e))
        } finally {
            setBusy(null)
        }
    }

    return (
        <Modal open={pickerOpen} onClose={() => !busy && resolvePicker(null)} title={pickerOptions.signIn ? "Sign in with a wallet" : "Connect a wallet"} dismissible={!busy} size="sm">
            {pickerOptions.reason && <p className="muted">{pickerOptions.reason}</p>}
            <ul className="picker" aria-label="Wallets">
                {injected.map((w) => (
                    <li key={w.info.rdns}>
                        <button type="button" className="picker-option" disabled={!!busy} onClick={() => void choose(w)}>
                            {w.info.icon ? (
                                <img src={w.info.icon} alt="" width={28} height={28} className="picker-icon" />
                            ) : (
                                <span className="picker-icon picker-icon-blank" aria-hidden="true">
                                    <Icon name="wallet" size={18} />
                                </span>
                            )}
                            <span className="picker-text">
                                <span className="picker-name">{w.info.name}</span>
                                <span className="picker-sub">Installed in this browser</span>
                            </span>
                            <Icon name="chevronRight" size={18} />
                        </button>
                    </li>
                ))}
                <li>
                    <button type="button" className="picker-option" disabled={!!busy} onClick={() => void choose("test")}>
                        <span className="picker-icon picker-icon-test" aria-hidden="true">
                            <Icon name="drop" size={18} />
                        </span>
                        <span className="picker-text">
                            <span className="picker-name">Test wallet in this browser</span>
                            <span className="picker-sub">Testnet only. A new key is kept in this browser. Never send real funds to it.</span>
                        </span>
                        <Icon name="chevronRight" size={18} />
                    </button>
                </li>
            </ul>
            {injected.length === 0 && (
                <p className="field-hint">No wallet extension found in this browser. Install one, or try FairPay with a test wallet.</p>
            )}
            <div aria-live="polite" className="picker-status">
                {busy && (
                    <p className="progress">
                        <span className="spinner" aria-hidden="true" />
                        {busy}
                    </p>
                )}
            </div>
            {error && (
                <p className="error-text" role="alert">
                    {error}
                </p>
            )}
            <p className="field-hint">FairPay runs on Monad Testnet with test USDC. Signing in creates a session; it never moves funds.</p>
        </Modal>
    )
}

/**
 * Connect / sign in / account menu. Put it in a header or sidebar.
 * `compact` shows just an avatar-sized chip (phone top bar).
 */
export function WalletButton({ compact = false, placement = "down" }: { compact?: boolean; placement?: "down" | "up" }) {
    const { me, meLoading, wallet, balances, mismatch, requestConnect, signIn, signOut, disconnect, faucet, cfg } = useWallet()
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
    const root = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (!open) return
        const onDoc = (e: MouseEvent) => {
            if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false)
                trigger.current?.focus()
            }
        }
        document.addEventListener("mousedown", onDoc)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDoc)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

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

    if (meLoading) return <span className="wallet-btn-skeleton" aria-hidden="true" />

    // Signed out: one button. With a wallet already connected we can sign straight away.
    if (!me) {
        return (
            <div className="wallet-btn" ref={root}>
                <button
                    type="button"
                    className={compact ? "btn btn-primary btn-sm" : "btn btn-primary btn-block"}
                    disabled={!!busy}
                    onClick={() => void (wallet ? run("Signing in…", async () => void (await signIn(wallet))) : requestConnect({ signIn: true }))}
                >
                    <Icon name="wallet" size={18} />
                    {busy ?? "Sign in"}
                </button>
                {msg?.error && (
                    <p className="error-text wallet-btn-error" role="alert">
                        {msg.text}
                    </p>
                )}
            </div>
        )
    }

    const name = me.profile.displayName || shortHex(me.profile.wallet)
    const initial = (me.profile.displayName || "").trim().charAt(0).toUpperCase() || me.profile.wallet.slice(2, 3).toUpperCase()

    return (
        <div className={`wallet-btn${compact ? " is-compact" : ""}`} ref={root}>
            <button
                ref={trigger}
                type="button"
                className="account-chip"
                aria-expanded={open}
                aria-haspopup="true"
                onClick={() => setOpen((o) => !o)}
            >
                <span className="avatar" aria-hidden="true">
                    {initial}
                </span>
                {!compact && (
                    <span className="account-text">
                        <span className="account-name">{name}</span>
                        <span className="account-sub">
                            {mismatch ? "Wallet changed" : wallet ? (balances ? usdc(Number(balances.usdc)) : wallet.name) : "No wallet connected"}
                        </span>
                    </span>
                )}
                {mismatch && <span className="dot dot-warn" aria-hidden="true" />}
                <span className="sr-only">Account menu for {name}</span>
                {!compact && <Icon name="chevronDown" size={16} />}
            </button>
            {open && (
                <div className={`menu menu-${placement}`} role="group" aria-label="Account">
                    <div className="menu-head">
                        <span className="menu-title">{name}</span>
                        <span className="mono menu-sub" title={me.profile.wallet}>
                            Signed in as {shortHex(me.profile.wallet)}
                        </span>
                    </div>
                    {mismatch && wallet && (
                        <div className="menu-note">
                            <p>
                                Your wallet switched to <span className="mono">{shortHex(wallet.address)}</span>. Sign in again to act as that wallet.
                            </p>
                            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run("Signing in…", async () => void (await signIn(wallet)))}>
                                Sign in as {shortHex(wallet.address)}
                            </button>
                        </div>
                    )}
                    {wallet ? (
                        <div className="menu-section">
                            <div className="menu-row">
                                <span className="muted">{wallet.kind === "test" ? "Test wallet (testnet only)" : wallet.name}</span>
                                <span className="money">{balances ? usdc(Number(balances.usdc)) : "…"}</span>
                            </div>
                            {cfg.faucet && (
                                <button type="button" className="menu-item" disabled={!!busy} onClick={() => void run("Sending test funds…", faucet)}>
                                    <Icon name="drop" size={18} />
                                    {busy === "Sending test funds…" ? busy : "Get test USDC"}
                                </button>
                            )}
                        </div>
                    ) : (
                        <button type="button" className="menu-item" onClick={() => void requestConnect({ signIn: false, reason: "Connect the wallet you want to pay with." })}>
                            <Icon name="wallet" size={18} />
                            Connect a wallet to pay
                        </button>
                    )}
                    <Link className="menu-item" to="/profile" onClick={() => setOpen(false)}>
                        <Icon name="user" size={18} />
                        Profile and private balance
                    </Link>
                    {wallet && (
                        <button
                            type="button"
                            className="menu-item"
                            onClick={() => {
                                disconnect()
                                setMsg(null)
                            }}
                        >
                            <Icon name="wallet" size={18} />
                            Disconnect wallet
                        </button>
                    )}
                    <button
                        type="button"
                        className="menu-item"
                        disabled={!!busy}
                        onClick={() =>
                            void run("Signing out…", async () => {
                                await signOut()
                                setOpen(false)
                            })
                        }
                    >
                        <Icon name="logout" size={18} />
                        Sign out
                    </button>
                    <div aria-live="polite">{msg && <p className={msg.error ? "error-text menu-msg" : "menu-msg"}>{msg.text}</p>}</div>
                </div>
            )}
        </div>
    )
}
