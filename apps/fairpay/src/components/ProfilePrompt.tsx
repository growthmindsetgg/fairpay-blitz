import { useEffect, useRef, useState, type FormEvent } from "react"
import { api } from "../lib/api"
import { safeStorage, useWallet } from "../lib/wallet"
import { friendly } from "./errors"
import { Input } from "./Field"
import { Modal } from "./Modal"

// Once dismissed (or saved), never asked again in this browser. safeStorage wraps localStorage in
// try/catch, so blocked site data just means the prompt can show again next sign-in.
const DISMISSED_KEY = "fairpay.profilePrompt.dismissed"
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Asks for a display name right after a wallet signs in without one, so people on their bills see
 * a name instead of an address. Only after a sign-in in this tab, not when a saved session loads.
 */
export function ProfilePrompt() {
    const { me, meLoading, pickerOpen, refreshMe } = useWallet()
    const [pending, setPending] = useState(false)
    const [open, setOpen] = useState(false)
    const [name, setName] = useState("")
    const [email, setEmail] = useState("")
    const [nameError, setNameError] = useState<string | null>(null)
    const [emailError, setEmailError] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    // null until the first session check finishes; then whether the tab was signed out.
    const signedOut = useRef<boolean | null>(null)

    const wallet = me?.profile.wallet ?? null
    const hasName = !!me?.profile.displayName?.trim()

    useEffect(() => {
        if (meLoading) return
        if (signedOut.current === true && wallet && !hasName && safeStorage.get(DISMISSED_KEY) !== "1") setPending(true)
        if (!wallet) setPending(false)
        signedOut.current = !wallet
    }, [meLoading, wallet, hasName])

    // Wait for the wallet picker to close, so the two dialogs don't stack.
    useEffect(() => {
        if (pending && !pickerOpen) {
            setPending(false)
            setName("")
            setEmail("")
            setNameError(null)
            setEmailError(null)
            setError(null)
            setOpen(true)
        }
    }, [pending, pickerOpen])

    useEffect(() => {
        if (!wallet) setOpen(false)
    }, [wallet])

    const dismiss = () => {
        if (saving) return
        safeStorage.set(DISMISSED_KEY, "1")
        setOpen(false)
    }

    const save = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        const n = name.trim()
        const em = email.trim()
        setNameError(n ? null : "Enter a name to save, or choose Not now.")
        setEmailError(em && !EMAIL.test(em) ? "That email address doesn't look right." : null)
        if (!n || (em && !EMAIL.test(em))) return
        setSaving(true)
        try {
            // Only send email when one was typed: sending null would clear an existing one.
            await api.updateMe(em ? { displayName: n, email: em } : { displayName: n })
            safeStorage.set(DISMISSED_KEY, "1")
            await refreshMe().catch(() => null)
            setOpen(false)
        } catch (err) {
            setError(friendly(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <Modal open={open} onClose={dismiss} title="What should people call you?" size="sm" dismissible={!saving}>
            <form className="stack" onSubmit={(e) => void save(e)} noValidate>
                <p className="muted">People on your bills see this name instead of your wallet address. You can change it any time in Profile.</p>
                <Input
                    label="Display name"
                    value={name}
                    maxLength={60}
                    required
                    autoFocus
                    autoComplete="nickname"
                    onChange={(e) => setName(e.target.value)}
                    error={nameError}
                />
                <Input
                    label="Email"
                    optional
                    type="email"
                    value={email}
                    maxLength={254}
                    autoComplete="email"
                    onChange={(e) => setEmail(e.target.value)}
                    hint="Private. Never shown to anyone else."
                    error={emailError}
                />
                {error && (
                    <p className="error-text" role="alert">
                        {error}
                    </p>
                )}
                <div className="row">
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={saving} onClick={dismiss}>
                        Not now
                    </button>
                </div>
            </form>
        </Modal>
    )
}
