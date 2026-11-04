import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import type { MenuItem } from "../../../../shared/types"
import { errorText, fe, type MenuInput } from "../client"
import { ConfirmButton, Drawer, Switch } from "../kit"
import type { TabProps } from "../Manage"
import { Alert, DishImage, ImagePicker, microToInput, parsePrice, SPICE_LABEL, SpiceMark, usdc, VegMark } from "../ui"

const DEFAULT_CATEGORIES = ["Small plates", "Mains", "Breads", "Rice", "Sweet", "Drinks"]

/** Menu order: by sort, then by name so equal sorts are still stable. */
function ordered(menu: MenuItem[]) {
    return [...menu].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

export function MenuTab({ view, patch }: TabProps) {
    const rid = view.restaurant.id
    const menu = useMemo(() => ordered(view.menu), [view.menu])
    const categories = useMemo(() => [...new Set(menu.map((i) => i.category))], [menu])
    const [editing, setEditing] = useState<MenuItem | "new" | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [status, setStatus] = useState("")

    const replace = (item: MenuItem) => patch((v) => ({ ...v, menu: v.menu.map((m) => (m.id === item.id ? item : m)) }))

    async function toggle(item: MenuItem, available: boolean) {
        setError(null)
        setBusy(item.id)
        replace({ ...item, available })
        try {
            const saved = await fe.updateItem(rid, item.id, { available })
            replace(saved ?? { ...item, available })
            setStatus(`${item.name} is ${available ? "available" : "marked sold out"}.`)
        } catch (e) {
            replace(item)
            setError(`${item.name} wasn't updated: ${errorText(e)}`)
        } finally {
            setBusy(null)
        }
    }

    /** Moves an item one place within its category, then renumbers the whole menu in steps of 10. */
    async function move(item: MenuItem, dir: -1 | 1) {
        const inCat = menu.filter((m) => m.category === item.category)
        const i = inCat.findIndex((m) => m.id === item.id)
        const j = i + dir
        if (j < 0 || j >= inCat.length) return
        const other = inCat[j]
        const list = [...menu]
        const a = list.findIndex((m) => m.id === item.id)
        const b = list.findIndex((m) => m.id === other.id)
        ;[list[a], list[b]] = [list[b], list[a]]
        const renumbered = list.map((m, k) => ({ ...m, sort: (k + 1) * 10 }))
        const changed = renumbered.filter((m) => menu.find((x) => x.id === m.id)?.sort !== m.sort)
        const before = view.menu
        patch((v) => ({ ...v, menu: renumbered }))
        setBusy(item.id)
        setError(null)
        try {
            await Promise.all(changed.map((m) => fe.updateItem(rid, m.id, { sort: m.sort })))
            setStatus(`${item.name} moved ${dir < 0 ? "up" : "down"}.`)
            // Keep focus on the same control after the list re-renders.
            requestAnimationFrame(() => document.getElementById(`mv-${dir < 0 ? "up" : "dn"}-${item.id}`)?.focus())
        } catch (e) {
            patch((v) => ({ ...v, menu: before }))
            setError(`The new order wasn't saved: ${errorText(e)}`)
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="fe-stack">
            <div className="fe-row-between">
                <h2 className="fe-h2">Menu</h2>
                <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                    Add dish
                </button>
            </div>
            <p className="sr-only" role="status" aria-live="polite">
                {status}
            </p>
            {error && <Alert>{error}</Alert>}

            {menu.length === 0 ? (
                <div className="fe-empty">
                    <h3>No dishes yet</h3>
                    <p>Add dishes with a price, a photo and how long they take. Guests see them on your storefront right away.</p>
                    <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                        Add your first dish
                    </button>
                </div>
            ) : (
                categories.map((cat) => {
                    const items = menu.filter((m) => m.category === cat)
                    return (
                        <section key={cat} className="fe-menu-cat" aria-labelledby={`mc-${slug(cat)}`}>
                            <h3 id={`mc-${slug(cat)}`} className="fe-h3">
                                {cat} <span className="fe-count">{items.length}</span>
                            </h3>
                            <ul className="fe-menu-rows">
                                {items.map((item, i) => (
                                    <li key={item.id} className={`fe-menu-row${item.available ? "" : " is-off"}`}>
                                        <DishImage item={item} className="fe-thumb" />
                                        <div className="fe-menu-main">
                                            <p className="fe-menu-name">
                                                <VegMark veg={item.veg} />
                                                <span>{item.name}</span>
                                                <SpiceMark level={item.spice} />
                                            </p>
                                            <p className="fe-menu-meta">
                                                <span className="fe-num">{usdc(item.price)}</span>
                                                <span>{item.prepMinutes} min</span>
                                                {!item.available && <span className="fe-sold">Sold out</span>}
                                            </p>
                                        </div>
                                        <div className="fe-menu-actions">
                                            <Switch
                                                checked={item.available}
                                                onChange={(v) => void toggle(item, v)}
                                                label={`${item.name} available`}
                                                hideLabel
                                                disabled={busy === item.id}
                                            />
                                            <span className="fe-reorder">
                                                <button
                                                    type="button"
                                                    id={`mv-up-${item.id}`}
                                                    className="fe-icon-btn"
                                                    aria-label={`Move ${item.name} up`}
                                                    disabled={i === 0 || busy !== null}
                                                    onClick={() => void move(item, -1)}
                                                >
                                                    <Arrow up />
                                                </button>
                                                <button
                                                    type="button"
                                                    id={`mv-dn-${item.id}`}
                                                    className="fe-icon-btn"
                                                    aria-label={`Move ${item.name} down`}
                                                    disabled={i === items.length - 1 || busy !== null}
                                                    onClick={() => void move(item, 1)}
                                                >
                                                    <Arrow />
                                                </button>
                                            </span>
                                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(item)}>
                                                Edit<span className="sr-only"> {item.name}</span>
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )
                })
            )}

            <Drawer open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add dish" : "Edit dish"}>
                {editing !== null && (
                    <ItemForm
                        key={editing === "new" ? "new" : editing.id}
                        restaurantId={rid}
                        item={editing === "new" ? null : editing}
                        categories={[...new Set([...categories, ...DEFAULT_CATEGORIES])]}
                        nextSort={(menu.at(-1)?.sort ?? 0) + 10}
                        onSaved={(saved, isNew) => {
                            patch((v) => ({ ...v, menu: isNew ? [...v.menu, saved] : v.menu.map((m) => (m.id === saved.id ? saved : m)) }))
                            setStatus(`${saved.name} ${isNew ? "added" : "saved"}.`)
                            setEditing(null)
                        }}
                        onDeleted={(item) => {
                            patch((v) => ({ ...v, menu: v.menu.filter((m) => m.id !== item.id) }))
                            setStatus(`${item.name} removed from the menu.`)
                            setEditing(null)
                        }}
                    />
                )}
            </Drawer>
        </div>
    )
}

function ItemForm({
    restaurantId,
    item,
    categories,
    nextSort,
    onSaved,
    onDeleted
}: {
    restaurantId: string
    item: MenuItem | null
    categories: string[]
    nextSort: number
    onSaved: (item: MenuItem, isNew: boolean) => void
    onDeleted: (item: MenuItem) => void
}) {
    const [name, setName] = useState(item?.name ?? "")
    const [description, setDescription] = useState(item?.description ?? "")
    const [category, setCategory] = useState(item?.category ?? categories[0] ?? "Mains")
    const [price, setPrice] = useState(item ? microToInput(item.price) : "")
    const [veg, setVeg] = useState(item?.veg ?? true)
    const [spice, setSpice] = useState(item?.spice ?? 0)
    const [prep, setPrep] = useState(String(item?.prepMinutes ?? 15))
    const [available, setAvailable] = useState(item?.available ?? true)
    const [image, setImage] = useState<string | null>(item?.image ?? null)
    const [uploading, setUploading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [tried, setTried] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const priceMicro = parsePrice(price)
    const prepN = Number(prep)
    const errs = {
        name: !name.trim() ? "Enter a name." : null,
        category: !category.trim() ? "Enter a category." : null,
        price: priceMicro === null ? "Enter a price in USDC, like 4.50. Whole cents only." : null,
        prep: !Number.isInteger(prepN) || prepN < 1 || prepN > 180 ? "Between 1 and 180 minutes." : null
    }
    const invalid = Object.values(errs).some(Boolean)
    const err = (k: keyof typeof errs) => (tried ? errs[k] : null)

    async function save(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (invalid || saving || uploading) {
            const first = (Object.keys(errs) as (keyof typeof errs)[]).find((k) => errs[k])
            if (first) document.getElementById(`it-${first}`)?.focus()
            return
        }
        setSaving(true)
        setError(null)
        const body: MenuInput = {
            name: name.trim(),
            description: description.trim() || null,
            category: category.trim(),
            price: priceMicro as number,
            image,
            veg,
            spice,
            prepMinutes: prepN,
            available
        }
        try {
            const saved = item ? await fe.updateItem(restaurantId, item.id, body) : await fe.addItem(restaurantId, { ...body, sort: nextSort })
            onSaved(saved, !item)
        } catch (e2) {
            setError(errorText(e2))
            setSaving(false)
        }
    }

    async function remove() {
        if (!item) return
        setSaving(true)
        setError(null)
        try {
            await fe.deleteItem(restaurantId, item.id)
            onDeleted(item)
        } catch (e2) {
            setError(errorText(e2))
            setSaving(false)
        }
    }

    return (
        <form className="fe-form" onSubmit={save} noValidate>
            <ImagePicker restaurantId={restaurantId} value={image} onChange={setImage} label="Dish photo" onBusy={setUploading} />
            <Field id="it-name" label="Name" error={err("name")}>
                <input id="it-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-invalid={err("name") ? true : undefined} aria-describedby={err("name") ? "it-name-e" : undefined} />
            </Field>
            <Field id="it-description" label="Description" optional hint="Up to 280 characters.">
                <textarea id="it-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={3} aria-describedby="it-description-h" />
            </Field>
            <div className="fe-grid2">
                <Field id="it-category" label="Category" error={err("category")}>
                    <input id="it-category" list="it-categories" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} aria-invalid={err("category") ? true : undefined} aria-describedby={err("category") ? "it-category-e" : undefined} />
                    <datalist id="it-categories">
                        {categories.map((c) => (
                            <option key={c} value={c} />
                        ))}
                    </datalist>
                </Field>
                <Field id="it-price" label="Price in USDC" error={err("price")} hint="Before GST.">
                    <input id="it-price" className="fe-num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="4.50" aria-invalid={err("price") ? true : undefined} aria-describedby={`it-price-h${err("price") ? " it-price-e" : ""}`} />
                </Field>
            </div>
            <div className="fe-grid2">
                <Field id="it-prep" label="Prep time, minutes" error={err("prep")} hint="Used for the guest's wait estimate.">
                    <input id="it-prep" type="number" min={1} max={180} value={prep} onChange={(e) => setPrep(e.target.value)} aria-invalid={err("prep") ? true : undefined} aria-describedby={`it-prep-h${err("prep") ? " it-prep-e" : ""}`} />
                </Field>
                <fieldset className="fe-field fe-radios">
                    <legend>Diet</legend>
                    <label>
                        <input type="radio" name="it-veg" checked={veg} onChange={() => setVeg(true)} /> <VegMark veg /> Vegetarian
                    </label>
                    <label>
                        <input type="radio" name="it-veg" checked={!veg} onChange={() => setVeg(false)} /> <VegMark veg={false} /> Non-vegetarian
                    </label>
                </fieldset>
            </div>
            <fieldset className="fe-field fe-segmented">
                <legend>Spice</legend>
                <div>
                    {SPICE_LABEL.map((l, i) => (
                        <label key={l}>
                            <input type="radio" name="it-spice" checked={spice === i} onChange={() => setSpice(i)} />
                            <span>{l}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <Switch checked={available} onChange={setAvailable} label="Available to order" />

            {error && <Alert>The dish wasn't saved: {error}</Alert>}
            <div className="fe-form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
                    {saving ? "Saving…" : uploading ? "Waiting for the photo…" : item ? "Save dish" : "Add dish"}
                </button>
                {item && (
                    <ConfirmButton confirmText={`Delete ${item.name}?`} onConfirm={() => void remove()} disabled={saving}>
                        Delete
                    </ConfirmButton>
                )}
            </div>
        </form>
    )
}

export function Field({
    id,
    label,
    error,
    hint,
    optional,
    children
}: {
    id: string
    label: string
    error?: string | null
    hint?: string
    optional?: boolean
    children: ReactNode
}) {
    return (
        <div className="fe-field">
            <label htmlFor={id}>
                {label} {optional && <span className="fe-opt">optional</span>}
            </label>
            {children}
            {hint && (
                <span className="fe-hint" id={`${id}-h`}>
                    {hint}
                </span>
            )}
            {error && (
                <span className="fe-field-error" id={`${id}-e`}>
                    {error}
                </span>
            )}
        </div>
    )
}

function Arrow({ up }: { up?: boolean }) {
    return (
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={up ? undefined : { transform: "rotate(180deg)" }}>
            <path d="M8 3.5 3.5 8.5h3V12.5h3V8.5h3Z" fill="currentColor" />
        </svg>
    )
}

function slug(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}
