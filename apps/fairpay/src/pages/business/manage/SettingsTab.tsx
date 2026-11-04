import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import type { Restaurant, Wallet } from "../../../../shared/types"
import { errorText, fe, type RestaurantInput } from "../client"
import { isValidGstin, stateCode, stateOptions } from "../gstx"
import type { TabProps } from "../Manage"
import { Alert, Chip, ImagePicker, isWallet, percent } from "../ui"
import { Field } from "./MenuTab"
import { useMe } from "../../../lib/wallet"

const GST_RATES = [0, 500, 1200, 1800]

export function SettingsTab({ view, patch }: TabProps) {
    const r = view.restaurant
    const save = async (body: RestaurantInput) => {
        const saved = await fe.update(r.id, body)
        patch((v) => ({ ...v, restaurant: saved ? { ...v.restaurant, ...saved } : { ...v.restaurant, ...(body as Partial<Restaurant>) } }))
    }
    return (
        <div className="fe-stack fe-settings">
            <h2 className="fe-h2">Settings</h2>
            <ProfileSection r={r} save={save} />
            <TaxSection r={r} save={save} />
            <PayoutSection r={r} save={save} isOwner={view.role === "owner"} />
        </div>
    )
}

type SectionProps = { r: Restaurant; save: (body: RestaurantInput) => Promise<void> }

function Section({ id, title, children, onSubmit, busy, done, error, submitLabel }: {
    id: string
    title: string
    children: ReactNode
    onSubmit?: (e: FormEvent) => void
    busy?: boolean
    done?: boolean
    error?: string | null
    submitLabel?: string
}) {
    return (
        <section className="fe-settings-section" aria-labelledby={`${id}-h`}>
            <h3 id={`${id}-h`} className="fe-h3">
                {title}
            </h3>
            {onSubmit ? (
                <form className="fe-form" onSubmit={onSubmit} noValidate>
                    {children}
                    {error && <Alert>Not saved: {error}</Alert>}
                    <div className="fe-form-actions">
                        <button type="submit" className="btn btn-primary" disabled={busy}>
                            {busy ? "Saving…" : (submitLabel ?? "Save")}
                        </button>
                        <span className="fe-saved" role="status">
                            {done ? "Saved." : ""}
                        </span>
                    </div>
                </form>
            ) : (
                children
            )}
        </section>
    )
}

function useSaver(save: (b: RestaurantInput) => Promise<void>) {
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const run = async (body: RestaurantInput) => {
        setBusy(true)
        setDone(false)
        setError(null)
        try {
            await save(body)
            setDone(true)
        } catch (e) {
            setError(errorText(e))
        } finally {
            setBusy(false)
        }
    }
    return { busy, done, error, run, clear: () => setDone(false) }
}

function ProfileSection({ r, save }: SectionProps) {
    const states = useMemo(stateOptions, [])
    const [f, setF] = useState({
        name: r.name,
        tagline: r.tagline ?? "",
        description: r.description ?? "",
        cuisine: r.cuisine ?? "",
        hours: r.hours ?? "",
        address: r.address ?? "",
        city: r.city ?? "",
        state: r.state
    })
    const [cover, setCover] = useState<string | null>(r.coverImage)
    const [uploading, setUploading] = useState(false)
    const s = useSaver(save)
    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
        s.clear()
        setF((x) => ({ ...x, [k]: e.target.value }))
    }
    const nameErr = !f.name.trim() ? "The restaurant needs a name." : null

    return (
        <Section
            id="set-profile"
            title="Storefront"
            busy={s.busy || uploading}
            done={s.done}
            error={s.error}
            onSubmit={(e) => {
                e.preventDefault()
                if (nameErr) return document.getElementById("sp-name")?.focus()
                const opt = (v: string) => v.trim() || null
                void s.run({
                    name: f.name.trim(),
                    tagline: opt(f.tagline),
                    description: opt(f.description),
                    cuisine: opt(f.cuisine),
                    hours: opt(f.hours),
                    address: opt(f.address),
                    city: opt(f.city),
                    state: f.state,
                    coverImage: cover
                })
            }}
        >
            <ImagePicker restaurantId={r.id} value={cover} onChange={(u) => (s.clear(), setCover(u))} label="Cover photo" onBusy={setUploading} />
            <Field id="sp-name" label="Name" error={nameErr}>
                <input id="sp-name" value={f.name} onChange={set("name")} maxLength={80} aria-invalid={nameErr ? true : undefined} aria-describedby={nameErr ? "sp-name-e" : undefined} />
            </Field>
            <Field id="sp-tagline" label="Tagline" optional>
                <input id="sp-tagline" value={f.tagline} onChange={set("tagline")} maxLength={140} />
            </Field>
            <Field id="sp-description" label="About" optional hint="Up to 1000 characters.">
                <textarea id="sp-description" value={f.description} onChange={set("description")} maxLength={1000} rows={4} aria-describedby="sp-description-h" />
            </Field>
            <div className="fe-grid2">
                <Field id="sp-cuisine" label="Cuisine" optional>
                    <input id="sp-cuisine" value={f.cuisine} onChange={set("cuisine")} maxLength={60} />
                </Field>
                <Field id="sp-hours" label="Hours" optional>
                    <input id="sp-hours" value={f.hours} onChange={set("hours")} maxLength={120} />
                </Field>
            </div>
            <Field id="sp-address" label="Street address" optional>
                <input id="sp-address" value={f.address} onChange={set("address")} maxLength={200} />
            </Field>
            <div className="fe-grid2">
                <Field id="sp-city" label="City" optional>
                    <input id="sp-city" value={f.city} onChange={set("city")} maxLength={60} />
                </Field>
                <Field id="sp-state" label="State or union territory" hint="The place of supply on invoices.">
                    <select id="sp-state" value={f.state} onChange={set("state")} aria-describedby="sp-state-h">
                        {!states.some((x) => x.name === f.state) && <option value={f.state}>{f.state}</option>}
                        {states.map((x) => (
                            <option key={x.code + x.name} value={x.name}>
                                {x.name} ({x.code})
                            </option>
                        ))}
                    </select>
                </Field>
            </div>
        </Section>
    )
}

function TaxSection({ r, save }: SectionProps) {
    const [gstin, setGstin] = useState(r.gstin ?? "")
    const [fssai, setFssai] = useState(r.fssai ?? "")
    const [rate, setRate] = useState(r.gstRateBps)
    const [service, setService] = useState(String(r.serviceChargeBps / 100))
    const s = useSaver(save)

    const g = gstin.trim().toUpperCase()
    const code = stateCode(r.state)
    const gstinErr = !g
        ? null
        : g.length !== 15
          ? `A GSTIN has 15 characters. This has ${g.length}.`
          : !isValidGstin(g)
            ? "That GSTIN doesn't check out. Check for a typo."
            : code && g.slice(0, 2) !== code
              ? `This GSTIN is for state code ${g.slice(0, 2)}, but the restaurant is in ${r.state} (${code}).`
              : null
    const fssaiErr = fssai.trim() && !/^\d{14}$/.test(fssai.trim()) ? "An FSSAI licence number is 14 digits." : null
    const svcN = Number(service)
    const svcErr = service.trim() === "" || !/^\d{1,2}(\.\d{1,2})?$/.test(service.trim()) || svcN > 20 ? "From 0 to 20 percent." : null

    return (
        <Section
            id="set-tax"
            title="Tax"
            busy={s.busy}
            done={s.done}
            error={s.error}
            onSubmit={(e) => {
                e.preventDefault()
                if (gstinErr || fssaiErr || svcErr) {
                    document.getElementById(gstinErr ? "sx-gstin" : fssaiErr ? "sx-fssai" : "sx-service")?.focus()
                    return
                }
                void s.run({ gstin: g || null, fssai: fssai.trim() || null, gstRateBps: rate, serviceChargeBps: Math.round(svcN * 100) })
            }}
        >
            <Field id="sx-gstin" label="GSTIN" optional error={gstinErr} hint="Without a GSTIN, guests get a Bill of Supply and no GST is charged.">
                <input
                    id="sx-gstin"
                    className="fe-mono"
                    value={gstin}
                    onChange={(e) => (s.clear(), setGstin(e.target.value.toUpperCase().replace(/\s/g, "")))}
                    maxLength={15}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={gstinErr ? true : undefined}
                    aria-describedby={`sx-gstin-h${gstinErr ? " sx-gstin-e" : ""}`}
                />
            </Field>
            {g.length === 15 && !gstinErr && <p className="fe-field-ok">Valid GSTIN for {r.state}.</p>}
            <Field id="sx-fssai" label="FSSAI licence number" optional error={fssaiErr}>
                <input
                    id="sx-fssai"
                    className="fe-mono"
                    inputMode="numeric"
                    value={fssai}
                    onChange={(e) => (s.clear(), setFssai(e.target.value.replace(/\D/g, "").slice(0, 14)))}
                    aria-invalid={fssaiErr ? true : undefined}
                    aria-describedby={fssaiErr ? "sx-fssai-e" : undefined}
                />
            </Field>
            <div className="fe-grid2">
                <Field id="sx-rate" label="GST rate" hint="Restaurant service is usually 5% without input tax credit.">
                    <select id="sx-rate" value={rate} onChange={(e) => (s.clear(), setRate(Number(e.target.value)))} aria-describedby="sx-rate-h">
                        {GST_RATES.map((b) => (
                            <option key={b} value={b}>
                                {percent(b)}
                                {b > 0 ? ` (CGST ${percent(b / 2)} + SGST ${percent(b / 2)})` : ""}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field id="sx-service" label="Service charge, %" error={svcErr} hint="Optional, added before GST and taxed with the food.">
                    <input
                        id="sx-service"
                        className="fe-num"
                        inputMode="decimal"
                        value={service}
                        onChange={(e) => (s.clear(), setService(e.target.value))}
                        aria-invalid={svcErr ? true : undefined}
                        aria-describedby={`sx-service-h${svcErr ? " sx-service-e" : ""}`}
                    />
                </Field>
            </div>
            {!g && rate > 0 && <p className="fe-callout">No GSTIN is set, so invoices are a Bill of Supply. Add a GSTIN to charge GST.</p>}
        </Section>
    )
}

function PayoutSection({ r, save, isOwner }: SectionProps & { isOwner: boolean }) {
    const me = useMe()
    const s = useSaver(save)
    // The server only accepts the wallet you're signed in with: signing in proves you control it,
    // so nobody can point their restaurant at another business's verified wallet.
    const mine = me?.profile.wallet.toLowerCase() ?? null
    const changed = mine !== null && mine !== r.payoutWallet.toLowerCase()

    const explain = (
        <div className="fe-explain">
            <p>
                Guests pay this wallet. <strong>Confidential payments</strong> go through the FairPay privacy pool: it hides which wallet paid,
                but not the amount (each note is exactly 5 USDC). The pool only pays verified businesses, so private payments work once
                FairPay has verified this payout wallet.
            </p>
            <p className="fe-status-line">
                {r.privatePayments ? (
                    <>
                        <Chip tone="violet">Confidential payments on</Chip> This payout wallet is verified. Guests can choose to pay confidentially.
                    </>
                ) : (
                    <>
                        <Chip tone="muted">Confidential payments off</Chip> This wallet isn't verified yet, so guests pay publicly. Changing the
                        wallet means it has to be verified again.
                    </>
                )}
            </p>
        </div>
    )

    if (!isOwner)
        return (
            <Section id="set-payout" title="Payout wallet">
                <p className="fe-mono fe-break">{r.payoutWallet}</p>
                <p className="fe-hint">Only the owner can change the payout wallet.</p>
                {explain}
            </Section>
        )

    if (!changed)
        return (
            <Section id="set-payout" title="Payout wallet">
                <p className="fe-mono fe-break">{r.payoutWallet}</p>
                <p className="fe-hint">Payouts go to the wallet you're signed in with. To be paid at another wallet, sign in with it and register the restaurant from there.</p>
                {explain}
            </Section>
        )

    return (
        <Section
            id="set-payout"
            title="Payout wallet"
            busy={s.busy}
            done={s.done}
            error={s.error}
            submitLabel="Pay out to my wallet"
            onSubmit={(e) => {
                e.preventDefault()
                void s.run({ payoutWallet: mine as Wallet })
            }}
        >
            <p className="fe-mono fe-break">{r.payoutWallet}</p>
            <p className="fe-hint">
                Guests pay the wallet above. Switch payouts to the wallet you're signed in with, <span className="fe-mono fe-break">{mine}</span>? New guests'
                payments go there once you save.
            </p>
            {explain}
        </Section>
    )
}
