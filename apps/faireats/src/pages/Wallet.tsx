import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { parseNote } from "../notes"
import { api, usdc } from "../api"
import { DEMO } from "../components/demo"
import { friendly } from "../components/errors"
import { BackupError, exportNotes, loadNotes, reconcileNotes, restoreNotes, subscribeNotes, topUp, type StoredNote } from "../payments"
import { useWallet } from "../wallet"

export function WalletPage() {
    const { cfg, deployment, publicClient, wallet, balances, chooseDemoWallet, connectBrowserWallet, disconnect, refreshBalances } =
        useWallet()
    const [notes, setNotes] = useState<StoredNote[]>(() => loadNotes(deployment))
    const [busy, setBusy] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [error, setError] = useState<{ at: "wallet" | "notes"; text: string } | null>(null)
    const [copied, setCopied] = useState(false)
    const [pool, setPool] = useState<{ deposits: number; mine: number } | null | "error">(null)
    const inFlight = useRef(false)
    const fileInput = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const update = () => setNotes(loadNotes(deployment))
        const off = subscribeNotes(deployment, update)
        void reconcileNotes(deployment, publicClient).then(update, () => undefined)
        return off
    }, [deployment, publicClient])

    // Counted from the restaurant's list of deposits. Spent deposits still count: a proof never
    // says which deposit it came from.
    const loadPool = async () => {
        try {
            const list = new Set(await api.commitments())
            const mine = loadNotes(deployment).filter((n) => {
                try {
                    return list.has(String(parseNote(n.note).identity.commitment))
                } catch {
                    return false
                }
            }).length
            setPool({ deposits: list.size, mine })
        } catch {
            setPool("error")
        }
    }
    const depositCount = notes.filter((n) => n.depositTx).length
    useEffect(() => {
        void loadPool()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deployment, depositCount])

    const run = async (label: string, fn: () => Promise<string | void>, at: "wallet" | "notes" = "notes") => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(label)
        setError(null)
        setMessage(null)
        try {
            const done = await fn()
            if (done) setMessage(done)
        } catch (e) {
            setError({ at, text: friendly(e) })
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

    const download = () => {
        const blob = new Blob([exportNotes(deployment)], { type: "application/json" })
        const a = document.createElement("a")
        a.href = URL.createObjectURL(blob)
        a.download = "faireats-notes-backup.json"
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
                r.added ? `Restored ${r.added} ${r.added === 1 ? "note" : "notes"}.` : "No new notes in that backup.",
                r.duplicates ? `${r.duplicates} already on this device.` : "",
                r.skipped ? `${r.skipped} unreadable or for another pool, skipped.` : ""
            ]
            return parts.filter(Boolean).join(" ")
        })
    }

    const copyAddress = async () => {
        if (!wallet) return
        try {
            await navigator.clipboard.writeText(wallet.address)
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
        } catch {
            setCopied(false)
        }
    }

    const denom = Number(cfg.denomination)
    const walletBusy = busy === "Connecting…" || busy === "Sending test funds…"
    return (
        <main className="wrap page" id="main">
            <h1>Your wallet</h1>

            {!wallet ? (
                <section className="card" aria-labelledby="choose-h">
                    <h2 id="choose-h">Choose how to pay</h2>
                    <p>
                        The demo wallet lives in this browser and gets free test funds. Use your own wallet if you already have MON on Monad
                        Testnet.
                    </p>
                    <div className="actions">
                        <button className="btn" onClick={() => chooseDemoWallet()}>
                            Use a demo wallet
                        </button>
                        <button
                            className="btn quiet"
                            disabled={!!busy}
                            onClick={() => run("Connecting…", async () => void (await connectBrowserWallet()), "wallet")}
                        >
                            Connect browser wallet
                        </button>
                    </div>
                    <p className={busy === "Connecting…" ? "progress" : "sr-only"} role="status">
                        {busy === "Connecting…" ? "Connecting…" : ""}
                    </p>
                    {error?.at === "wallet" && (
                        <p className="error" role="alert">
                            {error.text}
                        </p>
                    )}
                </section>
            ) : (
                <section className="card" aria-labelledby="wallet-h">
                    <h2 id="wallet-h">{DEMO ? "Demo wallet (simulated)" : wallet.kind === "demo" ? "Demo wallet" : "Browser wallet"}</h2>
                    {DEMO && <p className="callout">This wallet is simulated. It has no key and holds nothing.</p>}
                    <div className="address-row">
                        <p className="mono">{wallet.address}</p>
                        <button className="btn small quiet" onClick={copyAddress}>
                            {copied ? "Copied" : "Copy address"}
                        </button>
                    </div>
                    <p className="sr-only" role="status">
                        {copied ? "Address copied" : busy === "Sending test funds…" ? busy : ""}
                    </p>
                    <div className="stat-row">
                        <div>
                            <strong>{balances ? usdc(balances.usdc) : "…"}</strong>
                            <span className="hint">public balance</span>
                        </div>
                        <div>
                            <strong>{balances ? (Number(balances.mon) / 1e18).toFixed(3) : "…"} MON</strong>
                            <span className="hint">for gas</span>
                        </div>
                    </div>
                    <div className="actions">
                        <button
                            className="btn"
                            disabled={!!busy}
                            onClick={() =>
                                run(
                                    "Sending test funds…",
                                    async () => {
                                        const r = await api.faucet(wallet.address)
                                        return `Added ${r.minted} test USDC${Number(r.gasSent) > 0 ? ` and ${r.gasSent} MON for gas` : ""}.`
                                    },
                                    "wallet"
                                )
                            }
                        >
                            {busy === "Sending test funds…" ? "Sending test funds…" : "Get test funds"}
                        </button>
                        <a className="btn quiet" href={`${cfg.explorer}/address/${wallet.address}`} target="_blank" rel="noreferrer">
                            {DEMO ? "View simulated record" : "View on explorer"}
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <button className="linkish" disabled={!!busy} onClick={disconnect}>
                            Switch wallet
                        </button>
                    </div>
                    {error?.at === "wallet" && (
                        <p className="error" role="alert">
                            {error.text}
                        </p>
                    )}
                </section>
            )}

            <section className="card" aria-labelledby="private-h">
                <h2 id="private-h">Private balance</h2>
                <p>
                    Notes are {usdc(denom)} each. Adding a note is visible on-chain; paying with it is not linked back to you. Add notes
                    ahead of time so your payment blends in with everyone else's.
                </p>
                <div className="stat-row">
                    <div>
                        <strong>{usdc(unspent.length * denom)}</strong>
                        <span className="hint">
                            {unspent.length} {unspent.length === 1 ? "note" : "notes"} ready
                        </span>
                    </div>
                    <div>
                        <strong>{spent.length}</strong>
                        <span className="hint">spent</span>
                    </div>
                    {unconfirmed.length > 0 && (
                        <div>
                            <strong>{unconfirmed.length}</strong>
                            <span className="hint">not confirmed in the pool yet</span>
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

                <div className="pool-size" role="group" aria-labelledby="pool-h">
                    <h3 id="pool-h">Who you blend in with</h3>
                    {pool === null ? (
                        <p className="hint">Counting deposits in the pool…</p>
                    ) : pool === "error" ? (
                        <p className="hint">
                            We couldn't count the pool's deposits right now.{" "}
                            <button className="linkish" onClick={() => void loadPool()}>
                                Try again
                            </button>
                        </p>
                    ) : (
                        <>
                            <p>
                                You blend in with{" "}
                                <strong>
                                    {pool.deposits - pool.mine} other {pool.deposits - pool.mine === 1 ? "deposit" : "deposits"}
                                </strong>
                                {DEMO ? " (simulated)" : ""}. Yours: {pool.mine}. A private payment proves it came from one of the pool's
                                deposits without saying which.
                            </p>
                            {pool.deposits - pool.mine < 10 && (
                                <p className="warn">Fewer than 10 is a small crowd: timing alone can point to you.</p>
                            )}
                            <p className="hint">
                                More deposits from other people, and more time between adding and paying, make a payment harder to link to
                                you. Counted from this restaurant's list of pool deposits.
                            </p>
                        </>
                    )}
                </div>

                <p className={busy && !walletBusy ? "progress" : "sr-only"} role="status">
                    {busy && !walletBusy ? busy : ""}
                </p>
                {busy && !walletBusy ? null : (
                    <>
                        <div className="actions">
                            {[1, 3].map((k) => (
                                <button
                                    key={k}
                                    className="btn quiet"
                                    disabled={!wallet || !!busy}
                                    onClick={() =>
                                        run("Adding…", async () => {
                                            await topUp(deployment, wallet!.clients, k, (s) => setBusy(s))
                                            return `Added ${k} ${k === 1 ? "note" : "notes"} to your private balance.`
                                        })
                                    }
                                >
                                    Add {usdc(k * denom)} to private balance
                                </button>
                            ))}
                        </div>
                        <p className="hint">Adding is visible on-chain. Add early, pay later.</p>
                        <div className="actions">
                            <button className={unspent.length > 0 ? "btn" : "btn quiet"} disabled={notes.length === 0} onClick={download}>
                                Back up notes
                            </button>
                            <button className="btn quiet" onClick={() => fileInput.current?.click()}>
                                Restore from backup
                            </button>
                            <input
                                ref={fileInput}
                                type="file"
                                accept=".json,application/json"
                                className="sr-only"
                                tabIndex={-1}
                                aria-hidden="true"
                                onChange={restore}
                            />
                        </div>
                    </>
                )}
                {!wallet && <p className="hint">Choose a wallet above to add notes.</p>}
                <p className="callout">
                    Notes are stored only in this browser. Whoever has them can spend them, and clearing site data deletes them. Back them
                    up if they hold anything you care about, and keep the backup file private.
                </p>
                <div aria-live="polite">{message && <p className="badge verified">{message}</p>}</div>
                {error?.at === "notes" && (
                    <p className="error" role="alert">
                        {error.text}
                    </p>
                )}
            </section>
        </main>
    )
}
