import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import type { CreateBillInput, Friend, Wallet } from "../../shared/types"
import { friendly } from "../components/errors"
import { Input, Segmented, Switch, Textarea } from "../components/Field"
import { Icon } from "../components/Icon"
import { Money } from "../components/Money"
import { PageHeader, SignInGate, useTitle } from "../components/Page"
import { api } from "../lib/api"
import { isWallet, shortHex } from "../lib/format"
import { MAX_PEOPLE, parseCents, parsePercent, parseWeight, previewShares } from "../lib/split"
import { sameWallet, useWallet } from "../lib/wallet"

type AdvancedType = "fixed" | "percent" | "shares"

// Where rounding leftovers land, matching server/bills.ts for each split type.
const LEFTOVER_HINT: Record<"equal" | AdvancedType, string> = {
    equal: "Leftover cents go to the first people on the list, starting with you.",
    fixed: "Amounts are used exactly as entered, so they must add up to the total.",
    percent: "Leftover cents go to the last person with a percentage above zero.",
    shares: "Leftover cents go to the first people on the list with a share above zero."
}
type Person = { key: string; wallet?: Wallet; displayName: string; value: string; alreadyPaid: boolean }

let seq = 0
const newKey = () => `p${++seq}`

export function NewBill() {
    useTitle("New bill")
    return (
        <div className="content">
            <PageHeader
                title="New bill"
                description="Add what the bill came to and who shared it. Everyone gets a link to pay their part to you."
                back={
                    <Link to="/">
                        <Icon name="chevronLeft" size={14} /> Home
                    </Link>
                }
            />
            <SignInGate title="Sign in to split a bill" reason="Bills are paid to the wallet you sign in with, so sign in first. It's free.">
                <NewBillForm />
            </SignInGate>
        </div>
    )
}

function NewBillForm() {
    const { me } = useWallet()
    const navigate = useNavigate()
    const [title, setTitle] = useState("")
    const [totalStr, setTotalStr] = useState("")
    const [note, setNote] = useState("")
    const [mode, setMode] = useState<"simple" | "advanced">("simple")
    const [advType, setAdvType] = useState<AdvancedType>("fixed")
    const [creatorValue, setCreatorValue] = useState("")
    const [people, setPeople] = useState<Person[]>([])
    const [friends, setFriends] = useState<Friend[] | null>(null)
    const [addName, setAddName] = useState("")
    const [addWallet, setAddWallet] = useState("")
    const [addError, setAddError] = useState<string | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [touched, setTouched] = useState(false)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        api.friends()
            .then(setFriends)
            .catch(() => setFriends([]))
    }, [])

    const splitType = mode === "simple" ? "equal" : advType
    const total = parseCents(totalStr)
    const full = people.length + 1 >= MAX_PEOPLE

    const parseValue = (s: string) => (advType === "fixed" ? parseCents(s) : advType === "percent" ? parsePercent(s) : parseWeight(s))

    const preview = useMemo(() => {
        if (total === null || total <= 0) return { ok: false as const, error: "Enter the total to see each share." }
        if (people.length === 0) return { ok: false as const, error: "Add at least one person to split with." }
        if (splitType === "equal") return previewShares({ total, splitType, values: people.map(() => 0) })
        const values = people.map((p) => parseValue(p.value))
        return previewShares({
            total,
            splitType,
            creatorValue: parseValue(creatorValue),
            values,
            names: people.map((p) => p.displayName)
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [total, people, splitType, creatorValue, advType])

    const changeAdvType = (t: AdvancedType) => {
        setAdvType(t)
        // Shares start at 1 each, which is an even split; amounts and percentages start empty.
        const start = t === "shares" ? "1" : ""
        setCreatorValue(start)
        setPeople((ps) => ps.map((p) => ({ ...p, value: start })))
    }

    const addPerson = (p: Omit<Person, "key" | "value" | "alreadyPaid">) => {
        setPeople((ps) => [...ps, { ...p, key: newKey(), value: splitType === "shares" ? "1" : "", alreadyPaid: false }])
    }

    const toggleFriend = (f: Friend) => {
        const existing = people.find((p) => sameWallet(p.wallet, f.wallet))
        if (existing) setPeople((ps) => ps.filter((p) => p.key !== existing.key))
        else if (!full) addPerson({ wallet: f.wallet, displayName: f.nickname })
    }

    const onAdd = (e?: FormEvent) => {
        e?.preventDefault()
        setAddError(null)
        const name = addName.trim()
        const w = addWallet.trim()
        if (w && !isWallet(w)) return setAddError("That doesn't look like a wallet address. It should start with 0x and have 40 more characters.")
        if (w && me && sameWallet(w, me.profile.wallet)) return setAddError("That's your own wallet. You're already on the bill.")
        if (w && people.some((p) => sameWallet(p.wallet, w))) return setAddError("That wallet is already on the bill.")
        if (!name && !w) return setAddError("Enter a name, a wallet address, or both.")
        if (name.length > 60) return setAddError("Keep the name under 60 characters.")
        if (full) return setAddError(`A bill can have at most ${MAX_PEOPLE} people, including you.`)
        const friend = w ? friends?.find((f) => sameWallet(f.wallet, w)) : undefined
        addPerson({ wallet: w ? (w.toLowerCase() as Wallet) : undefined, displayName: name || friend?.nickname || shortHex(w) })
        setAddName("")
        setAddWallet("")
    }

    const update = (key: string, patch: Partial<Person>) => setPeople((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)))

    const titleError = touched && !title.trim() ? "Give the bill a name, like “Dinner at Saffron Table”." : null
    const totalError = touched && (total === null || total <= 0) ? "Enter the total in USDC, with up to 2 decimals." : null

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        setTouched(true)
        setSubmitError(null)
        if (!title.trim() || total === null || total <= 0) return
        if (!preview.ok) return setSubmitError(preview.error)
        const input: CreateBillInput = {
            title: title.trim(),
            note: note.trim() || undefined,
            total,
            splitType,
            participants: people.map((p) => ({
                wallet: p.wallet,
                displayName: p.displayName,
                value: splitType === "equal" ? undefined : (parseValue(p.value) ?? undefined),
                alreadyPaid: p.alreadyPaid || undefined
            })),
            creatorValue: splitType === "equal" ? undefined : (parseValue(creatorValue) ?? undefined)
        }
        setSaving(true)
        try {
            const bill = await api.createBill(input)
            navigate(`/bills/${encodeURIComponent(bill.id)}`, { state: { created: true } })
        } catch (err) {
            setSubmitError(friendly(err))
        } finally {
            setSaving(false)
        }
    }

    const unit = advType === "fixed" ? "USDC" : advType === "percent" ? "%" : "shares"
    const valueLabel = advType === "fixed" ? "Amount" : advType === "percent" ? "Percent" : "Shares"
    const shares = preview.ok ? preview.shares : null

    return (
        <form className="newbill-layout" onSubmit={submit} noValidate>
            <div className="stack">
                <section className="card" aria-labelledby="bill-h">
                    <div className="card-head">
                        <h2 className="card-title" id="bill-h">
                            The bill
                        </h2>
                    </div>
                    <div className="form-grid">
                        <div className="form-grid form-grid-2">
                            <Input label="What was it for?" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Dinner on Friday" error={titleError} required />
                            <Input
                                label="Total"
                                value={totalStr}
                                inputMode="decimal"
                                autoComplete="off"
                                onChange={(e) => setTotalStr(e.target.value)}
                                placeholder="0.00"
                                suffix="USDC"
                                error={totalError}
                                required
                            />
                        </div>
                        <Textarea label="Note" optional value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} hint="Everyone on the bill can see this." rows={2} />
                    </div>
                </section>

                <section className="card" aria-labelledby="people-h">
                    <div className="card-head">
                        <h2 className="card-title" id="people-h">
                            Who's splitting
                        </h2>
                        <span className="field-hint">
                            {people.length + 1} of {MAX_PEOPLE} people
                        </span>
                    </div>

                    <div className="stack">
                        <Segmented
                            label="How to split"
                            value={mode}
                            onChange={(m) => {
                                setMode(m)
                                if (m === "advanced") changeAdvType(advType)
                            }}
                            options={[
                                { value: "simple", label: "Simple: split evenly" },
                                { value: "advanced", label: "Advanced" }
                            ]}
                        />
                        {mode === "advanced" && (
                            <Segmented
                                label="Split by"
                                value={advType}
                                onChange={changeAdvType}
                                options={[
                                    { value: "fixed", label: "Amounts" },
                                    { value: "percent", label: "Percent" },
                                    { value: "shares", label: "Shares" }
                                ]}
                            />
                        )}

                        <ul className="people" aria-label="People on this bill">
                            <li>
                                <div className="person-row">
                                    <span className="person" data-me="" aria-hidden="true">
                                        {(me?.profile.displayName || "Y").charAt(0).toUpperCase()}
                                    </span>
                                    <span className="person-name">
                                        <strong>You</strong>
                                        <span className="field-hint">Your part is covered: you paid the bill.</span>
                                    </span>
                                    {mode === "advanced" && (
                                        <div className="person-controls">
                                            <Input
                                                label={`${valueLabel} for you`}
                                                hideLabel
                                                value={creatorValue}
                                                inputMode={advType === "shares" ? "numeric" : "decimal"}
                                                onChange={(e) => setCreatorValue(e.target.value)}
                                                suffix={unit}
                                                placeholder="0"
                                            />
                                        </div>
                                    )}
                                </div>
                            </li>
                            {people.map((p) => (
                                <li key={p.key}>
                                    <div className="person-row">
                                        <span className="person" aria-hidden="true">
                                            {p.displayName.charAt(0).toUpperCase()}
                                        </span>
                                        <span className="person-name">
                                            <strong>{p.displayName}</strong>
                                            <span className="field-hint">
                                                {p.wallet ? <span className="mono">{shortHex(p.wallet)}</span> : "No wallet yet: they claim this seat from the link"}
                                            </span>
                                        </span>
                                        <div className="person-controls">
                                            {mode === "advanced" && (
                                                <Input
                                                    label={`${valueLabel} for ${p.displayName}`}
                                                    hideLabel
                                                    value={p.value}
                                                    inputMode={advType === "shares" ? "numeric" : "decimal"}
                                                    onChange={(e) => update(p.key, { value: e.target.value })}
                                                    suffix={unit}
                                                    placeholder="0"
                                                />
                                            )}
                                            <Switch label="Already paid" checked={p.alreadyPaid} onChange={(v) => update(p.key, { alreadyPaid: v })} />
                                        </div>
                                        <button
                                            type="button"
                                            className="btn btn-quiet btn-icon btn-sm"
                                            aria-label={`Remove ${p.displayName}`}
                                            onClick={() => setPeople((ps) => ps.filter((x) => x.key !== p.key))}
                                        >
                                            <Icon name="close" size={18} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>

                        {friends && friends.length > 0 && (
                            <div className="stack-sm">
                                <p className="field-label" id="friends-l">
                                    Add friends
                                </p>
                                <div className="chips" role="group" aria-labelledby="friends-l">
                                    {friends.map((f) => {
                                        const on = people.some((p) => sameWallet(p.wallet, f.wallet))
                                        return (
                                            <button key={f.wallet} type="button" className="chip" aria-pressed={on} disabled={!on && full} onClick={() => toggleFriend(f)}>
                                                {on ? <Icon name="check" size={14} /> : <Icon name="plus" size={14} />}
                                                <span>{f.nickname}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        )}

                        <div className="add-person" role="group" aria-labelledby="add-l">
                            <p className="field-label" id="add-l">
                                Add someone else
                            </p>
                            <div className="add-person-row">
                                <Input label="Name" value={addName} maxLength={60} onChange={(e) => setAddName(e.target.value)} placeholder="Asha" onKeyDown={(e) => e.key === "Enter" && onAdd(e)} />
                                <Input
                                    label="Wallet address"
                                    optional
                                    value={addWallet}
                                    onChange={(e) => setAddWallet(e.target.value)}
                                    placeholder="0x…"
                                    spellCheck={false}
                                    autoComplete="off"
                                    onKeyDown={(e) => e.key === "Enter" && onAdd(e)}
                                />
                                <button type="button" className="btn btn-secondary" onClick={() => onAdd()} disabled={full}>
                                    <Icon name="plus" size={18} />
                                    Add
                                </button>
                            </div>
                            <p className="field-hint">No address? Add a name only. They can claim the seat when they open the link and sign in.</p>
                            {addError && (
                                <p className="error-text" role="alert">
                                    {addError}
                                </p>
                            )}
                        </div>
                    </div>
                </section>
            </div>

            <aside className="newbill-side stack" aria-labelledby="preview-h">
                <section className="card">
                    <div className="card-head">
                        <h2 className="card-title" id="preview-h">
                            Each share
                        </h2>
                    </div>
                    <div aria-live="polite">
                        {shares ? (
                            <>
                                <ul className="preview-list">
                                    <li>
                                        <span className="preview-name">You (covered)</span>
                                        <Money value={shares[0] ?? 0} />
                                    </li>
                                    {people.map((p, i) => (
                                        <li key={p.key}>
                                            <span className="preview-name">
                                                {p.displayName}
                                                {p.alreadyPaid && <span className="field-hint"> · already paid</span>}
                                            </span>
                                            <Money value={shares[i + 1] ?? 0} />
                                        </li>
                                    ))}
                                </ul>
                                <div className="preview-total">
                                    <span>Still to collect</span>
                                    <Money value={people.reduce((s, p, i) => s + (p.alreadyPaid ? 0 : (shares[i + 1] ?? 0)), 0)} />
                                </div>
                            </>
                        ) : (
                            <p className="muted">{preview.ok ? "" : preview.error}</p>
                        )}
                    </div>
                    <p className="field-hint mt-3">
                        Shares are worked out the same way the server stores them. {LEFTOVER_HINT[splitType]}
                    </p>
                </section>
                <div className="stack-sm">
                    <button type="submit" className="btn btn-primary btn-block" disabled={saving}>
                        {saving ? "Creating the bill…" : "Create bill and get link"}
                    </button>
                    <div aria-live="polite">
                        {submitError && (
                            <p className="error-text" role="alert">
                                {submitError}
                            </p>
                        )}
                    </div>
                    <p className="field-hint">Payments between friends are public on Monad. Confidential payments are for verified businesses today.</p>
                </div>
            </aside>
        </form>
    )
}
