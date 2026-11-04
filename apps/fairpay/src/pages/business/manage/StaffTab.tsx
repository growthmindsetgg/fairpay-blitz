import { useState, type FormEvent } from "react"
import type { StaffMember, Wallet } from "../../../../shared/types"
import { useMe } from "../../../lib/wallet"
import { errorText, fe } from "../client"
import { ConfirmButton } from "../kit"
import type { TabProps } from "../Manage"
import { Alert, Chip, istDate, isWallet, shortHex } from "../ui"

type StaffRole = StaffMember["role"]

const ROLE_INFO: Record<StaffRole, { label: string; does: string }> = {
    manager: { label: "Manager", does: "Everything except staff managers and the payout wallet" },
    chef: { label: "Chef", does: "Kitchen board: sees tickets cook and finish by themselves; can start cooking" },
    waiter: { label: "Waiter", does: "Tables and serving: set table status, mark served" }
}

export function StaffTab({ view, patch }: TabProps) {
    const rid = view.restaurant.id
    const me = useMe()
    const isOwner = view.role === "owner"
    const canManage = (r: StaffRole) => isOwner || (view.role === "manager" && r !== "manager")
    const roles: StaffRole[] = isOwner ? ["manager", "chef", "waiter"] : ["chef", "waiter"]

    const [wallet, setWallet] = useState("")
    const [name, setName] = useState("")
    const [role, setRole] = useState<StaffRole>("waiter")
    const [tried, setTried] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState("")

    const w = wallet.trim().toLowerCase()
    const errs = {
        wallet: !isWallet(w)
            ? "Paste a wallet address: 0x followed by 40 hex characters."
            : view.staff.some((s) => s.wallet === w)
              ? "This wallet is already on the staff."
              : me && me.profile.wallet.toLowerCase() === w && isOwner
                ? "That's you, the owner."
                : null,
        name: !name.trim() ? "Enter a name so the team knows who this is." : null
    }

    async function add(e: FormEvent) {
        e.preventDefault()
        setTried(true)
        if (errs.wallet || errs.name) {
            document.getElementById(errs.wallet ? "st-wallet" : "st-name")?.focus()
            return
        }
        setBusy("add")
        setError(null)
        try {
            const saved = await fe.addStaff(rid, { wallet: w as Wallet, role, displayName: name.trim() })
            const member: StaffMember = saved ?? { wallet: w as Wallet, role, displayName: name.trim(), addedAt: Date.now() }
            patch((v) => ({ ...v, staff: [...v.staff.filter((s) => s.wallet !== member.wallet), member] }))
            setStatus(`${member.displayName} added as ${ROLE_INFO[member.role].label.toLowerCase()}.`)
            setWallet("")
            setName("")
            setTried(false)
        } catch (e2) {
            setError(`Not added: ${errorText(e2)}`)
        } finally {
            setBusy(null)
        }
    }

    async function remove(s: StaffMember) {
        setBusy(s.wallet)
        setError(null)
        try {
            await fe.removeStaff(rid, s.wallet)
            patch((v) => ({ ...v, staff: v.staff.filter((x) => x.wallet !== s.wallet) }))
            setStatus(`${s.displayName} removed.`)
        } catch (e2) {
            setError(`${s.displayName} wasn't removed: ${errorText(e2)}`)
        } finally {
            setBusy(null)
        }
    }

    const err = (k: keyof typeof errs) => (tried ? errs[k] : null)
    const order: StaffRole[] = ["manager", "chef", "waiter"]
    const staff = [...view.staff].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.displayName.localeCompare(b.displayName))

    return (
        <div className="fe-stack">
            <h2 className="fe-h2">Staff</h2>
            <p className="fe-hint">
                Staff sign in with their own wallet and see this dashboard with the tabs their role needs.
                {!isOwner && " Managers can add and remove chefs and waiters."}
            </p>
            <p className="sr-only" role="status" aria-live="polite">
                {status}
            </p>
            {error && <Alert>{error}</Alert>}

            <div className="fe-table-wrap">
                <table className="fe-data">
                    <caption className="sr-only">Staff at {view.restaurant.name}</caption>
                    <thead>
                        <tr>
                            <th scope="col">Name</th>
                            <th scope="col">Wallet</th>
                            <th scope="col">Role</th>
                            <th scope="col">Added</th>
                            <th scope="col">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {isOwner && me && (
                            <tr>
                                <td>{me.profile.displayName || "You"}</td>
                                <td className="fe-mono" title={me.profile.wallet}>
                                    {shortHex(me.profile.wallet)}
                                </td>
                                <td>
                                    <Chip tone="muted">Owner</Chip>
                                </td>
                                <td>–</td>
                                <td />
                            </tr>
                        )}
                        {staff.map((s) => (
                            <tr key={s.wallet}>
                                <td>{s.displayName}</td>
                                <td className="fe-mono" title={s.wallet}>
                                    <span aria-hidden="true">{shortHex(s.wallet)}</span>
                                    <span className="sr-only">{s.wallet}</span>
                                </td>
                                <td>{ROLE_INFO[s.role].label}</td>
                                <td>{istDate(s.addedAt)}</td>
                                <td className="fe-td-action">
                                    {canManage(s.role) && (
                                        <ConfirmButton
                                            confirmText={`Remove ${s.displayName}?`}
                                            onConfirm={() => void remove(s)}
                                            disabled={busy === s.wallet}
                                            className="btn btn-quiet btn-sm fe-danger-text"
                                        >
                                            Remove<span className="sr-only"> {s.displayName}</span>
                                        </ConfirmButton>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {staff.length === 0 && (
                            <tr>
                                <td colSpan={5} className="fe-muted">
                                    No staff yet. Add the people who run the floor and the kitchen.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <form className="fe-inline-form" onSubmit={add} noValidate>
                <h3 className="fe-h3">Add someone</h3>
                <div className="fe-field">
                    <label htmlFor="st-wallet">Wallet address</label>
                    <input
                        id="st-wallet"
                        className="fe-mono"
                        value={wallet}
                        onChange={(e) => setWallet(e.target.value)}
                        placeholder="0x…"
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={err("wallet") ? true : undefined}
                        aria-describedby={err("wallet") ? "st-wallet-e" : undefined}
                    />
                    {err("wallet") && (
                        <span className="fe-field-error" id="st-wallet-e">
                            {err("wallet")}
                        </span>
                    )}
                </div>
                <div className="fe-grid2">
                    <div className="fe-field">
                        <label htmlFor="st-name">Name</label>
                        <input
                            id="st-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={60}
                            aria-invalid={err("name") ? true : undefined}
                            aria-describedby={err("name") ? "st-name-e" : undefined}
                        />
                        {err("name") && (
                            <span className="fe-field-error" id="st-name-e">
                                {err("name")}
                            </span>
                        )}
                    </div>
                    <div className="fe-field">
                        <label htmlFor="st-role">Role</label>
                        <select id="st-role" value={role} onChange={(e) => setRole(e.target.value as StaffRole)} aria-describedby="st-role-h">
                            {roles.map((r) => (
                                <option key={r} value={r}>
                                    {ROLE_INFO[r].label}
                                </option>
                            ))}
                        </select>
                        <span className="fe-hint" id="st-role-h">
                            {ROLE_INFO[role].does}.
                        </span>
                    </div>
                </div>
                <div className="fe-form-actions">
                    <button type="submit" className="btn btn-primary" disabled={busy === "add"}>
                        {busy === "add" ? "Adding…" : "Add to staff"}
                    </button>
                </div>
            </form>
        </div>
    )
}
