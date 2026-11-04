import { useCallback, useEffect, useState, type FormEvent } from "react"
import type { Friend, Wallet } from "../../shared/types"
import { EmptyState } from "../components/EmptyState"
import { friendly } from "../components/errors"
import { Input } from "../components/Field"
import { Icon } from "../components/Icon"
import { Address } from "../components/Money"
import { ErrorNote, Loading, PageHeader, SignInGate, useTitle } from "../components/Page"
import { api } from "../lib/api"
import { isWallet } from "../lib/format"
import { sameWallet, useWallet } from "../lib/wallet"

export function Friends() {
    useTitle("Friends")
    return (
        <div className="content content-narrow">
            <PageHeader title="Friends" description="Save the people you split with, so adding them to a bill is one tap." />
            <SignInGate title="Sign in to see your friends">
                <FriendList />
            </SignInGate>
        </div>
    )
}

function FriendList() {
    const { me } = useWallet()
    const [friends, setFriends] = useState<Friend[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [wallet, setWallet] = useState("")
    const [nickname, setNickname] = useState("")
    const [formError, setFormError] = useState<{ field: "wallet" | "nickname" | "form"; text: string } | null>(null)
    const [saving, setSaving] = useState(false)
    const [removing, setRemoving] = useState<string | null>(null)
    const [msg, setMsg] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            setFriends(await api.friends())
        } catch (e) {
            setError(friendly(e))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const add = async (e: FormEvent) => {
        e.preventDefault()
        setFormError(null)
        setMsg(null)
        const w = wallet.trim()
        const n = nickname.trim()
        if (!isWallet(w)) return setFormError({ field: "wallet", text: "Enter a wallet address: 0x followed by 40 letters and numbers." })
        if (me && sameWallet(w, me.profile.wallet)) return setFormError({ field: "wallet", text: "That's your own wallet." })
        if (!n) return setFormError({ field: "nickname", text: "Give them a name you'll recognise." })
        setSaving(true)
        try {
            await api.addFriend(w.toLowerCase() as Wallet, n)
            setWallet("")
            setNickname("")
            setMsg(`Saved ${n}.`)
            await load()
        } catch (err) {
            setFormError({ field: "form", text: friendly(err) })
        } finally {
            setSaving(false)
        }
    }

    const remove = async (f: Friend) => {
        setRemoving(f.wallet)
        setMsg(null)
        try {
            await api.removeFriend(f.wallet)
            setFriends((fs) => fs?.filter((x) => x.wallet !== f.wallet) ?? null)
            setMsg(`Removed ${f.nickname}.`)
        } catch (err) {
            setError(friendly(err))
        } finally {
            setRemoving(null)
        }
    }

    return (
        <>
            <section className="card" aria-labelledby="add-h">
                <div className="card-head">
                    <h2 className="card-title" id="add-h">
                        Add a friend
                    </h2>
                </div>
                <form className="form-grid" onSubmit={add} noValidate>
                    <div className="form-grid form-grid-2">
                        <Input label="Name" value={nickname} maxLength={60} onChange={(e) => setNickname(e.target.value)} placeholder="Asha" error={formError?.field === "nickname" ? formError.text : null} />
                        <Input
                            label="Wallet address"
                            value={wallet}
                            onChange={(e) => setWallet(e.target.value)}
                            placeholder="0x…"
                            spellCheck={false}
                            autoComplete="off"
                            error={formError?.field === "wallet" ? formError.text : null}
                        />
                    </div>
                    <div className="row">
                        <button type="submit" className="btn btn-primary" disabled={saving}>
                            <Icon name="plus" size={18} />
                            {saving ? "Saving…" : "Save friend"}
                        </button>
                        <span className="field-hint">Only you see this list and the names you give.</span>
                    </div>
                    {formError?.field === "form" && (
                        <p className="error-text" role="alert">
                            {formError.text}
                        </p>
                    )}
                </form>
            </section>

            <div aria-live="polite">{msg && <p className="success-text">{msg}</p>}</div>

            <section className="card card-flush" aria-labelledby="list-h">
                <div className="card-head">
                    <h2 className="card-title" id="list-h">
                        Your friends
                    </h2>
                </div>
                {error ? (
                    <div className="card">
                        <ErrorNote message={error} onRetry={() => void load()} />
                    </div>
                ) : !friends ? (
                    <div className="card">
                        <Loading />
                    </div>
                ) : friends.length === 0 ? (
                    <EmptyState icon="users" title="No friends saved yet">
                        <p>Add someone's wallet address above. Next time you split a bill, they're one tap away.</p>
                    </EmptyState>
                ) : (
                    <ul className="list">
                        {friends.map((f) => (
                            <li key={f.wallet} className="list-row">
                                <span className="person" aria-hidden="true">
                                    {f.nickname.charAt(0).toUpperCase()}
                                </span>
                                <span className="list-main">
                                    <span className="list-title">{f.nickname}</span>
                                    <span className="list-sub">
                                        <Address value={f.wallet} />
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    className="btn btn-quiet btn-sm"
                                    disabled={removing === f.wallet}
                                    onClick={() => void remove(f)}
                                    aria-label={`Remove ${f.nickname}`}
                                >
                                    <Icon name="trash" size={16} />
                                    <span aria-hidden="true">{removing === f.wallet ? "Removing…" : "Remove"}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    )
}
