import { useState, type FormEvent } from "react"
import type { Chef } from "../../../../shared/types"
import { errorText, fe, type ChefInput } from "../client"
import { ConfirmButton, Drawer, Switch } from "../kit"
import type { TabProps } from "../Manage"
import { Alert, Avatar, ImagePicker } from "../ui"
import { Field } from "./MenuTab"

export function ChefsTab({ view, patch }: TabProps) {
    const rid = view.restaurant.id
    const [editing, setEditing] = useState<Chef | "new" | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [status, setStatus] = useState("")

    const replace = (c: Chef) => patch((v) => ({ ...v, chefs: v.chefs.map((x) => (x.id === c.id ? c : x)) }))

    async function duty(c: Chef, onDuty: boolean) {
        setBusy(c.id)
        setError(null)
        replace({ ...c, onDuty })
        try {
            const saved = await fe.updateChef(rid, c.id, { onDuty })
            replace(saved ?? { ...c, onDuty })
            setStatus(`${c.name} is ${onDuty ? "on duty" : "off duty"}.`)
        } catch (e) {
            replace(c)
            setError(`${c.name} wasn't updated: ${errorText(e)}`)
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="fe-stack">
            <div className="fe-row-between">
                <h2 className="fe-h2">Chefs</h2>
                <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                    Add chef
                </button>
            </div>
            <p className="fe-hint">
                Guests see these profiles on your storefront and on their order. When cooking starts, an on-duty chef is put on the ticket.
            </p>
            <p className="sr-only" role="status" aria-live="polite">
                {status}
            </p>
            {error && <Alert>{error}</Alert>}

            {view.chefs.length === 0 ? (
                <div className="fe-empty">
                    <h3>No chef profiles yet</h3>
                    <p>Add the people cooking: a photo, their title and what they're known for.</p>
                    <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                        Add a chef
                    </button>
                </div>
            ) : (
                <ul className="fe-chef-admin">
                    {view.chefs.map((c) => (
                        <li key={c.id} className="fe-chef-row">
                            <Avatar src={c.photo} name={c.name} size={56} />
                            <div className="fe-chef-main">
                                <p className="fe-chef-name">{c.name}</p>
                                <p className="fe-muted">{[c.title, c.specialty, c.years != null ? `${c.years} years` : null].filter(Boolean).join(" · ")}</p>
                            </div>
                            <div className="fe-chef-actions">
                                <Switch checked={c.onDuty} onChange={(v) => void duty(c, v)} label="On duty" disabled={busy === c.id} />
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(c)}>
                                    Edit<span className="sr-only"> {c.name}</span>
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <Drawer open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add chef" : "Edit chef"}>
                {editing !== null && (
                    <ChefForm
                        key={editing === "new" ? "new" : editing.id}
                        restaurantId={rid}
                        chef={editing === "new" ? null : editing}
                        onSaved={(c, isNew) => {
                            patch((v) => ({ ...v, chefs: isNew ? [...v.chefs, c] : v.chefs.map((x) => (x.id === c.id ? c : x)) }))
                            setStatus(`${c.name} ${isNew ? "added" : "saved"}.`)
                            setEditing(null)
                        }}
                        onDeleted={(c) => {
                            patch((v) => ({ ...v, chefs: v.chefs.filter((x) => x.id !== c.id) }))
                            setStatus(`${c.name} removed.`)
                            setEditing(null)
                        }}
                    />
                )}
            </Drawer>
        </div>
    )
}

function ChefForm({
    restaurantId,
    chef,
    onSaved,
    onDeleted
}: {
    restaurantId: string
    chef: Chef | null
    onSaved: (c: Chef, isNew: boolean) => void
    onDeleted: (c: Chef) => void
}) {
    const [name, setName] = useState(chef?.name ?? "")
    const [title, setTitle] = useState(chef?.title ?? "")
    const [specialty, setSpecialty] = useState(chef?.specialty ?? "")
    const [years, setYears] = useState(chef?.years != null ? String(chef.years) : "")
    const [bio, setBio] = useState(chef?.bio ?? "")
    const [photo, setPhoto] = useState<string | null>(chef?.photo ?? null)
    const [onDuty, setOnDuty] = useState(chef?.onDuty ?? true)
    const [uploading, setUploading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [tried, setTried] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const y = years.trim() === "" ? null : Number(years)
    const errs = {
        name: !name.trim() ? "Enter the chef's name." : null,
        years: y !== null && (!Number.isInteger(y) || y < 0 || y > 70) ? "A whole number from 0 to 70." : null
    }
    const err = (k: keyof typeof errs) => (tried ? errs[k] : null)

    async function save(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (errs.name || errs.years || saving || uploading) {
            document.getElementById(errs.name ? "ch-name" : "ch-years")?.focus()
            return
        }
        setSaving(true)
        setError(null)
        const body: ChefInput = {
            name: name.trim(),
            title: title.trim() || null,
            specialty: specialty.trim() || null,
            years: y,
            bio: bio.trim() || null,
            photo,
            onDuty
        }
        try {
            const saved = chef ? await fe.updateChef(restaurantId, chef.id, body) : await fe.addChef(restaurantId, body)
            onSaved(saved, !chef)
        } catch (e2) {
            setError(errorText(e2))
            setSaving(false)
        }
    }

    async function remove() {
        if (!chef) return
        setSaving(true)
        try {
            await fe.deleteChef(restaurantId, chef.id)
            onDeleted(chef)
        } catch (e2) {
            setError(errorText(e2))
            setSaving(false)
        }
    }

    return (
        <form className="fe-form" onSubmit={save} noValidate>
            <ImagePicker restaurantId={restaurantId} value={photo} onChange={setPhoto} label="Photo" shape="square" onBusy={setUploading} />
            <Field id="ch-name" label="Name" error={err("name")}>
                <input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-invalid={err("name") ? true : undefined} aria-describedby={err("name") ? "ch-name-e" : undefined} />
            </Field>
            <div className="fe-grid2">
                <Field id="ch-title" label="Title" optional>
                    <input id="ch-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="Head chef" />
                </Field>
                <Field id="ch-years" label="Years cooking" optional error={err("years")}>
                    <input id="ch-years" type="number" min={0} max={70} value={years} onChange={(e) => setYears(e.target.value)} aria-invalid={err("years") ? true : undefined} aria-describedby={err("years") ? "ch-years-e" : undefined} />
                </Field>
            </div>
            <Field id="ch-specialty" label="Specialty" optional>
                <input id="ch-specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={80} placeholder="Coastal curries" />
            </Field>
            <Field id="ch-bio" label="Bio" optional hint="Up to 400 characters.">
                <textarea id="ch-bio" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={400} rows={4} aria-describedby="ch-bio-h" />
            </Field>
            <Switch checked={onDuty} onChange={setOnDuty} label="On duty" />
            {error && <Alert>The profile wasn't saved: {error}</Alert>}
            <div className="fe-form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
                    {saving ? "Saving…" : uploading ? "Waiting for the photo…" : chef ? "Save chef" : "Add chef"}
                </button>
                {chef && (
                    <ConfirmButton confirmText={`Remove ${chef.name}?`} onConfirm={() => void remove()} disabled={saving}>
                        Remove
                    </ConfirmButton>
                )}
            </div>
        </form>
    )
}
