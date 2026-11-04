import { useMemo, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useTitle, WalletButton } from "../../components"
import { useSession } from "../../lib/wallet"
import "../../styles/business.css"
import { errorText, fe } from "./client"
import { isValidGstin, stateCode, stateOptions } from "./gstx"
import { Alert, Loading } from "./ui"

type Form = {
    name: string
    tagline: string
    cuisine: string
    address: string
    city: string
    state: string
    gstin: string
    fssai: string
    tables: string
    seats: string
    hours: string
}

const EMPTY: Form = {
    name: "",
    tagline: "",
    cuisine: "",
    address: "",
    city: "",
    state: "",
    gstin: "",
    fssai: "",
    tables: "8",
    seats: "4",
    hours: ""
}

export function Register() {
    useTitle("Register your restaurant")
    const { me, loading, refresh } = useSession()
    const navigate = useNavigate()
    const states = useMemo(stateOptions, [])
    const [f, setF] = useState<Form>(EMPTY)
    const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
    const touch = (k: keyof Form) => () => setTouched((t) => ({ ...t, [k]: true }))

    const gstin = f.gstin.trim().toUpperCase()
    const gstinCode = stateCode(f.state)
    const errors: Partial<Record<keyof Form, string>> = {}
    if (!f.name.trim()) errors.name = "Enter the restaurant's name."
    if (!f.state) errors.state = "Choose the state. It is the place of supply on GST invoices."
    if (gstin) {
        if (gstin.length !== 15) errors.gstin = `A GSTIN has 15 characters. This has ${gstin.length}.`
        else if (!isValidGstin(gstin)) errors.gstin = "That GSTIN doesn't check out. Check for a typo."
        else if (gstinCode && gstin.slice(0, 2) !== gstinCode)
            errors.gstin = `This GSTIN is registered in state code ${gstin.slice(0, 2)}, but ${f.state} is ${gstinCode}.`
    }
    if (f.fssai.trim() && !/^\d{14}$/.test(f.fssai.trim())) errors.fssai = "An FSSAI licence number is 14 digits."
    const tables = Number(f.tables)
    const seats = Number(f.seats)
    if (!Number.isInteger(tables) || tables < 1 || tables > 100) errors.tables = "Between 1 and 100 tables. You can add more later."
    if (!Number.isInteger(seats) || seats < 1 || seats > 30) errors.seats = "Between 1 and 30 seats."
    const gstinOk = gstin.length === 15 && !errors.gstin

    const show = (k: keyof Form) => (touched[k] ? errors[k] : undefined)

    async function submit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setTouched(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, true])))
        if (Object.keys(errors).length) {
            const first = Object.keys(errors)[0]
            document.getElementById(`reg-${first}`)?.focus()
            return
        }
        setError(null)
        setBusy("Registering the restaurant…")
        const opt = (s: string) => s.trim() || null
        try {
            const r = await fe.register({
                name: f.name.trim(),
                tagline: opt(f.tagline),
                cuisine: opt(f.cuisine),
                address: opt(f.address),
                city: opt(f.city),
                state: f.state,
                gstin: gstin || null,
                fssai: opt(f.fssai),
                hours: opt(f.hours),
                // The server creates the tables in the same transaction as the restaurant.
                tables: tables,
                seats
            })
            let tableError: string | null = null
            // Fallback: add any tables the server didn't create (older servers ignore `tables`).
            let existing = 0
            try {
                existing = (await fe.manage(r.id)).tables.length
            } catch {
                existing = 0
            }
            for (let i = existing + 1; i <= tables; i++) {
                setBusy(`Setting up table ${i} of ${tables}…`)
                try {
                    await fe.addTable(r.id, { label: String(i), seats })
                } catch (err) {
                    tableError = `Table ${i} wasn't created: ${errorText(err)} Add the rest in the Tables tab.`
                    break
                }
            }
            // The sidebar and directory list "your restaurants" from the session; refresh it.
            void refresh().catch(() => undefined)
            navigate(`/business/faireats/manage/${r.id}`, { state: { created: true, tableError } })
        } catch (err) {
            setError(errorText(err))
            setBusy(null)
        }
    }

    if (!me && loading)
        return (
            <div className="fe fe-page fe-narrow">
                <Loading label="Checking your sign-in…" />
            </div>
        )
    if (!me)
        return (
            <div className="fe fe-page fe-narrow">
                <p className="fe-crumb">
                    <Link to="/business/faireats">FairEats</Link>
                </p>
                <h1>Register your restaurant</h1>
                <div className="fe-signin">
                    <p>
                        Sign in with your wallet first. The wallet that registers becomes the owner, and payouts go to it until you
                        change the payout wallet.
                    </p>
                    <WalletButton />
                </div>
            </div>
        )

    return (
        <div className="fe fe-page fe-narrow">
            <p className="fe-crumb">
                <Link to="/business/faireats">FairEats</Link>
            </p>
            <h1>Register your restaurant</h1>
            <p className="fe-lead">
                You become the owner. Guests pay the payout wallet, which starts as the wallet you're signed in with. You add the menu,
                chefs and staff after this.
            </p>

            <form className="fe-form" onSubmit={submit} noValidate>
                <fieldset className="fe-fieldset">
                    <legend>The restaurant</legend>
                    <TextField id="name" label="Name" value={f.name} onChange={set("name")} onBlur={touch("name")} error={show("name")} max={80} required />
                    <TextField id="tagline" label="Tagline" value={f.tagline} onChange={set("tagline")} max={140} optional hint="One line guests see under the name." />
                    <TextField id="cuisine" label="Cuisine" value={f.cuisine} onChange={set("cuisine")} max={60} optional hint="For example: South Indian, coastal" />
                    <TextField id="hours" label="Hours" value={f.hours} onChange={set("hours")} max={120} optional hint="For example: 12–3 pm, 7–11 pm. Closed Mondays." />
                </fieldset>

                <fieldset className="fe-fieldset">
                    <legend>Address</legend>
                    <TextField id="address" label="Street address" value={f.address} onChange={set("address")} max={200} optional autoComplete="street-address" />
                    <div className="fe-grid2">
                        <TextField id="city" label="City" value={f.city} onChange={set("city")} max={60} optional autoComplete="address-level2" />
                        <div className="fe-field">
                            <label htmlFor="reg-state">State or union territory</label>
                            <select
                                id="reg-state"
                                value={f.state}
                                onChange={set("state")}
                                onBlur={touch("state")}
                                aria-invalid={show("state") ? true : undefined}
                                aria-describedby={show("state") ? "reg-state-e" : undefined}
                                required
                            >
                                <option value="">Choose…</option>
                                {states.map((s) => (
                                    <option key={s.code + s.name} value={s.name}>
                                        {s.name} ({s.code})
                                    </option>
                                ))}
                            </select>
                            {show("state") && (
                                <span className="fe-field-error" id="reg-state-e">
                                    {show("state")}
                                </span>
                            )}
                        </div>
                    </div>
                </fieldset>

                <fieldset className="fe-fieldset">
                    <legend>Tax and licence</legend>
                    <div className="fe-field">
                        <label htmlFor="reg-gstin">
                            GSTIN <span className="fe-opt">optional</span>
                        </label>
                        <input
                            id="reg-gstin"
                            className="fe-mono"
                            value={f.gstin}
                            onChange={(e) => setF((x) => ({ ...x, gstin: e.target.value.toUpperCase().replace(/\s/g, "") }))}
                            maxLength={15}
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={gstin.length === 15 && errors.gstin ? true : touched.gstin && errors.gstin ? true : undefined}
                            aria-describedby="reg-gstin-h reg-gstin-s"
                            onBlur={touch("gstin")}
                        />
                        <span className="fe-hint" id="reg-gstin-h">
                            With a GSTIN, guests get a Tax Invoice with CGST and SGST. Without one, they get a Bill of Supply with no GST.
                        </span>
                        <span
                            id="reg-gstin-s"
                            aria-live="polite"
                            className={gstinOk ? "fe-field-ok" : errors.gstin && (touched.gstin || gstin.length === 15) ? "fe-field-error" : "sr-only"}
                        >
                            {gstinOk
                                ? `Valid GSTIN${gstinCode ? ` for ${f.state}` : ""}.`
                                : errors.gstin && (touched.gstin || gstin.length === 15)
                                  ? errors.gstin
                                  : ""}
                        </span>
                    </div>
                    <TextField
                        id="fssai"
                        label="FSSAI licence number"
                        value={f.fssai}
                        onChange={(e) => setF((x) => ({ ...x, fssai: e.target.value.replace(/\D/g, "").slice(0, 14) }))}
                        onBlur={touch("fssai")}
                        error={show("fssai")}
                        optional
                        mono
                        inputMode="numeric"
                        hint="14 digits. Printed on invoices."
                    />
                </fieldset>

                <fieldset className="fe-fieldset">
                    <legend>Tables</legend>
                    <div className="fe-grid2">
                        <TextField id="tables" label="Number of tables" value={f.tables} onChange={set("tables")} onBlur={touch("tables")} error={show("tables")} type="number" min={1} maxNum={100} />
                        <TextField id="seats" label="Seats per table" value={f.seats} onChange={set("seats")} onBlur={touch("seats")} error={show("seats")} type="number" min={1} maxNum={30} hint="You can change each table later." />
                    </div>
                </fieldset>

                {error && <Alert>The restaurant wasn't registered: {error}</Alert>}
                <div className="fe-form-actions">
                    <button className="btn btn-primary" type="submit" disabled={busy !== null}>
                        {busy ?? "Register restaurant"}
                    </button>
                    <Link className="btn btn-quiet" to="/business/faireats">
                        Cancel
                    </Link>
                </div>
                <p className="sr-only" role="status" aria-live="polite">
                    {busy ?? ""}
                </p>
            </form>
        </div>
    )
}

export function TextField({
    id,
    label,
    value,
    onChange,
    onBlur,
    error,
    hint,
    optional,
    required,
    max,
    type = "text",
    min,
    maxNum,
    mono,
    inputMode,
    autoComplete,
    prefix = "reg"
}: {
    id: string
    label: string
    value: string
    onChange: (e: { target: { value: string } }) => void
    onBlur?: () => void
    error?: string
    hint?: string
    optional?: boolean
    required?: boolean
    max?: number
    type?: "text" | "number"
    min?: number
    maxNum?: number
    mono?: boolean
    inputMode?: "numeric" | "decimal" | "text"
    autoComplete?: string
    prefix?: string
}) {
    const fid = `${prefix}-${id}`
    const describedBy = [hint && `${fid}-h`, error && `${fid}-e`].filter(Boolean).join(" ") || undefined
    return (
        <div className="fe-field">
            <label htmlFor={fid}>
                {label} {optional && <span className="fe-opt">optional</span>}
            </label>
            <input
                id={fid}
                className={mono ? "fe-mono" : undefined}
                type={type}
                value={value}
                onChange={onChange}
                onBlur={onBlur}
                maxLength={type === "text" ? max : undefined}
                min={min}
                max={maxNum}
                inputMode={inputMode}
                autoComplete={autoComplete ?? "off"}
                required={required}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
            />
            {hint && (
                <span className="fe-hint" id={`${fid}-h`}>
                    {hint}
                </span>
            )}
            {error && (
                <span className="fe-field-error" id={`${fid}-e`}>
                    {error}
                </span>
            )}
        </div>
    )
}
