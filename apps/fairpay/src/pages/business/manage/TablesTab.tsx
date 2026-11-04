import { useState, type FormEvent } from "react"
import type { Table } from "../../../../shared/types"
import { errorText, fe } from "../client"
import { ConfirmButton } from "../kit"
import type { TabProps } from "../Manage"
import { Alert, TABLE_STATUS, TableChip } from "../ui"

const STATUSES: Table["status"][] = ["available", "occupied", "reserved", "closed"]

function byLabel(a: Table, b: Table) {
    return a.label.localeCompare(b.label, undefined, { numeric: true })
}

export function TablesTab({ view, patch, reload }: TabProps) {
    const rid = view.restaurant.id
    const canEdit = view.role === "owner" || view.role === "manager"
    const tables = [...view.tables].sort(byLabel)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [status, setStatus] = useState("")
    const [label, setLabel] = useState("")
    const [seats, setSeats] = useState("4")

    const replace = (t: Table) => patch((v) => ({ ...v, tables: v.tables.map((x) => (x.id === t.id ? t : x)) }))

    async function setTableStatus(t: Table, s: Table["status"]) {
        if (s === t.status) return
        setBusy(t.id)
        setError(null)
        try {
            const saved = await fe.setTableStatus(rid, t.id, s)
            replace(saved ?? { ...t, status: s })
            setStatus(`Table ${t.label} is now ${TABLE_STATUS[s].toLowerCase()}.`)
        } catch (e) {
            setError(`Table ${t.label} wasn't changed: ${errorText(e)}`)
            void reload()
        } finally {
            setBusy(null)
        }
    }

    async function remove(t: Table) {
        setBusy(t.id)
        setError(null)
        try {
            await fe.deleteTable(rid, t.id)
            patch((v) => ({ ...v, tables: v.tables.filter((x) => x.id !== t.id) }))
            setStatus(`Table ${t.label} removed.`)
        } catch (e) {
            setError(`Table ${t.label} wasn't removed: ${errorText(e)}`)
        } finally {
            setBusy(null)
        }
    }

    async function changeSeats(t: Table, n: number) {
        if (!Number.isInteger(n) || n < 1 || n > 30 || n === t.seats) return
        setBusy(t.id)
        setError(null)
        try {
            const saved = await fe.updateTable(rid, t.id, { seats: n })
            replace(saved ?? { ...t, seats: n })
            setStatus(`Table ${t.label} now seats ${n}.`)
        } catch (e) {
            setError(`Table ${t.label} wasn't changed: ${errorText(e)}`)
        } finally {
            setBusy(null)
        }
    }

    const nextLabel = () => {
        const nums = view.tables.map((t) => Number(t.label)).filter((n) => Number.isInteger(n))
        return String(nums.length ? Math.max(...nums) + 1 : view.tables.length + 1)
    }

    async function add(e: FormEvent) {
        e.preventDefault()
        const l = (label.trim() || nextLabel()).slice(0, 12)
        const n = Number(seats)
        if (!Number.isInteger(n) || n < 1 || n > 30) {
            setError("Seats must be between 1 and 30.")
            return
        }
        if (view.tables.some((t) => t.label.toLowerCase() === l.toLowerCase())) {
            setError(`There is already a table ${l}.`)
            return
        }
        setBusy("add")
        setError(null)
        try {
            const t = await fe.addTable(rid, { label: l, seats: n })
            patch((v) => ({ ...v, tables: [...v.tables, t] }))
            setStatus(`Table ${l} added.`)
            setLabel("")
        } catch (e2) {
            setError(`The table wasn't added: ${errorText(e2)}`)
        } finally {
            setBusy(null)
        }
    }

    const free = view.tables.filter((t) => t.status === "available").length
    return (
        <div className="fe-stack">
            <div className="fe-row-between">
                <h2 className="fe-h2">Tables</h2>
                <p className="fe-muted">
                    {free} of {view.tables.length} free
                </p>
            </div>
            <p className="sr-only" role="status" aria-live="polite">
                {status}
            </p>
            {error && <Alert>{error}</Alert>}
            <p className="fe-hint">
                A table becomes occupied when guests order at it and free again when the order is served. A table with an order that
                hasn't been served can't be set free.
            </p>

            {tables.length === 0 ? (
                <div className="fe-empty">
                    <h3>No tables yet</h3>
                    <p>{canEdit ? "Add tables below. Guests choose a free one when they order." : "The owner or a manager adds tables."}</p>
                </div>
            ) : (
                <ul className="fe-table-grid">
                    {tables.map((t) => (
                        <li key={t.id} className={`fe-table-card is-${t.status}`}>
                            <div className="fe-table-top">
                                <span className="fe-table-label">
                                    <span className="sr-only">Table </span>
                                    {t.label}
                                </span>
                                <TableChip status={t.status} />
                            </div>
                            <SeatRing seats={t.seats} />
                            <div className="fe-table-controls">
                                <label className="fe-label-sm" htmlFor={`ts-${t.id}`}>
                                    Status
                                </label>
                                <select
                                    id={`ts-${t.id}`}
                                    value={t.status}
                                    disabled={busy === t.id}
                                    onChange={(e) => void setTableStatus(t, e.target.value as Table["status"])}
                                >
                                    {STATUSES.map((s) => (
                                        <option key={s} value={s}>
                                            {TABLE_STATUS[s]}
                                        </option>
                                    ))}
                                </select>
                                {canEdit ? (
                                    <>
                                        <label className="fe-label-sm" htmlFor={`tn-${t.id}`}>
                                            Seats
                                        </label>
                                        <input
                                            id={`tn-${t.id}`}
                                            type="number"
                                            min={1}
                                            max={30}
                                            defaultValue={t.seats}
                                            disabled={busy === t.id}
                                            onBlur={(e) => void changeSeats(t, Number(e.target.value))}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                                            }}
                                        />
                                    </>
                                ) : null}
                            </div>
                            {canEdit && (
                                <ConfirmButton
                                    confirmText={`Remove table ${t.label}?`}
                                    onConfirm={() => void remove(t)}
                                    disabled={busy === t.id || t.status === "occupied"}
                                    className="btn btn-quiet btn-sm fe-danger-text"
                                >
                                    Remove<span className="sr-only"> table {t.label}</span>
                                </ConfirmButton>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {canEdit && (
                <form className="fe-inline-form" onSubmit={add}>
                    <h3 className="fe-h3">Add a table</h3>
                    <div className="fe-inline-fields">
                        <div className="fe-field">
                            <label htmlFor="nt-label">
                                Label <span className="fe-opt">optional</span>
                            </label>
                            <input id="nt-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={12} placeholder={nextLabel()} />
                        </div>
                        <div className="fe-field">
                            <label htmlFor="nt-seats">Seats</label>
                            <input id="nt-seats" type="number" min={1} max={30} value={seats} onChange={(e) => setSeats(e.target.value)} />
                        </div>
                        <button type="submit" className="btn btn-secondary" disabled={busy === "add"}>
                            {busy === "add" ? "Adding…" : "Add table"}
                        </button>
                    </div>
                </form>
            )}
        </div>
    )
}

/** Chairs drawn around a round table, as on a floor plan. Decorative: the seat count is in text too. */
export function SeatRing({ seats, size = 64 }: { seats: number; size?: number }) {
    const n = Math.min(seats, 12)
    return (
        <div className="fe-seat-ring">
            <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
                <circle cx="32" cy="32" r="14" className="t" />
                {Array.from({ length: n }, (_, i) => {
                    const a = (i / n) * Math.PI * 2 - Math.PI / 2
                    return <circle key={i} cx={32 + Math.cos(a) * 24} cy={32 + Math.sin(a) * 24} r="4.5" className="c" />
                })}
            </svg>
            <span>{seats} seats</span>
        </div>
    )
}
