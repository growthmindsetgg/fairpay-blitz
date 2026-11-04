import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom"
import type { Role } from "../../../shared/types"
import { useTitle, WalletButton } from "../../components"
import { useSession } from "../../lib/wallet"
import "../../styles/business.css"
import { ApiError, errorText, fe, type ManageView } from "./client"
import { TabBar, type TabDef } from "./kit"
import { ChefsTab } from "./manage/ChefsTab"
import { KitchenTab } from "./manage/KitchenTab"
import { MenuTab } from "./manage/MenuTab"
import { OverviewTab } from "./manage/OverviewTab"
import { PaymentsTab } from "./manage/PaymentsTab"
import { SettingsTab } from "./manage/SettingsTab"
import { StaffTab } from "./manage/StaffTab"
import { TablesTab } from "./manage/TablesTab"
import { MyPayTab } from "./manage/MyPayTab"
import { TeamPayTab } from "./manage/TeamPayTab"
import { Alert, Chip, Loading } from "./ui"

type TabKey = "overview" | "menu" | "tables" | "kitchen" | "payments" | "chefs" | "staff" | "settings" | "team" | "mypay"

const LABEL: Record<TabKey, string> = {
    overview: "Overview",
    menu: "Menu",
    tables: "Tables",
    kitchen: "Kitchen",
    payments: "Payments",
    chefs: "Chefs",
    staff: "Staff",
    settings: "Settings",
    team: "Team pay",
    mypay: "My pay"
}

// Mirrors the server's rules, so nobody sees a tab whose actions would all answer 403. Payments and
// Team pay are the owner's alone: the payout wallet is the owner's own (server/routes/money.ts),
// and team pay leaves the owner's wallet (server/routes/teamPay.ts). Staff see their own My pay.
const TABS_FOR: Record<Role, TabKey[]> = {
    owner: ["overview", "menu", "tables", "kitchen", "payments", "team", "chefs", "staff", "settings"],
    manager: ["overview", "menu", "tables", "kitchen", "chefs", "staff", "settings", "mypay"],
    chef: ["overview", "kitchen", "mypay"],
    waiter: ["overview", "tables", "kitchen", "mypay"]
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", manager: "Manager", chef: "Chef", waiter: "Waiter" }

export type TabProps = {
    view: ManageView
    /** Replace part of the view after a successful change (no refetch needed). */
    patch: (fn: (v: ManageView) => ManageView) => void
    reload: () => Promise<void>
}

export function Manage() {
    const { id = "" } = useParams()
    const { me, loading } = useSession()
    const location = useLocation()
    const [params, setParams] = useSearchParams()
    const [view, setView] = useState<ManageView | null>(null)
    const [error, setError] = useState<{ status: number; message: string } | null>(null)
    useTitle(view ? `${view.restaurant.name} · Manage` : "Manage restaurant")
    const created = (location.state as { created?: boolean; tableError?: string | null } | null) ?? null

    const reload = useCallback(async () => {
        try {
            const v = await fe.manage(id)
            setView(v)
            setError(null)
        } catch (e) {
            setError({ status: e instanceof ApiError ? e.status : 0, message: errorText(e) })
        }
    }, [id])

    // Refetch when the signed-in wallet changes: the role (and the tabs) depend on it.
    const wallet = me?.profile.wallet ?? null
    useEffect(() => {
        if (!loading) void reload()
    }, [reload, wallet, loading])

    const patch = useCallback((fn: (v: ManageView) => ManageView) => setView((v) => (v ? fn(v) : v)), [])

    const tabs = useMemo<TabDef<TabKey>[]>(() => (view ? TABS_FOR[view.role].map((k) => ({ key: k, label: LABEL[k] })) : []), [view])
    const asked = params.get("tab") as TabKey | null
    const current: TabKey = tabs.some((t) => t.key === asked) ? (asked as TabKey) : "overview"
    const setTab = (k: TabKey) =>
        setParams(
            (p) => {
                const n = new URLSearchParams(p)
                if (k === "overview") n.delete("tab")
                else n.set("tab", k)
                return n
            },
            { replace: true }
        )

    if (!view) {
        if (!loading && (error?.status === 401 || (!me && error)))
            return (
                <div className="fe fe-page fe-narrow">
                    <p className="fe-crumb">
                        <Link to="/business/faireats">FairEats</Link>
                    </p>
                    <h1>Manage restaurant</h1>
                    <div className="fe-signin">
                        <p>Sign in with the wallet that owns or works at this restaurant.</p>
                        <WalletButton />
                    </div>
                </div>
            )
        return (
            <div className="fe fe-page">
                <p className="fe-crumb">
                    <Link to="/business/faireats">FairEats</Link>
                </p>
                {error ? (
                    <div className="fe-state">
                        <h1>{error.status === 403 ? "You don't work here" : error.status === 404 ? "We can't find that restaurant" : "The dashboard didn't load"}</h1>
                        <Alert>
                            {error.status === 403
                                ? "This wallet isn't the owner or on the staff of this restaurant. Ask the owner to add you in Staff."
                                : error.message}
                        </Alert>
                        {error.status !== 403 && error.status !== 404 && (
                            <button className="btn btn-secondary" onClick={() => void reload()}>
                                Try again
                            </button>
                        )}
                    </div>
                ) : (
                    <Loading label="Loading the dashboard…" />
                )}
            </div>
        )
    }

    const r = view.restaurant
    const props: TabProps = { view, patch, reload }
    return (
        <div className="fe fe-page fe-manage">
            <p className="fe-crumb">
                <Link to="/business/faireats">FairEats</Link>
            </p>
            <header className="fe-head fe-head--manage">
                <div>
                    <h1>{r.name}</h1>
                    <p className="fe-head-meta">
                        <Chip tone="muted">{ROLE_LABEL[view.role]}</Chip>
                        {r.privatePayments && <Chip tone="violet">Confidential payments</Chip>}
                        {r.isDemo && <Chip tone="muted">Demo</Chip>}
                    </p>
                </div>
                <Link className="btn btn-secondary" to={`/r/${r.slug}`}>
                    Open storefront
                </Link>
            </header>
            {created?.created && (
                <Alert tone="ok">
                    {r.name} is registered. Next: add dishes in Menu, then share your storefront link with guests.
                </Alert>
            )}
            {created?.tableError && <Alert>{created.tableError}</Alert>}

            <TabBar tabs={tabs} current={current} onChange={setTab} label="Restaurant dashboard" idBase="fe-m" />
            <section
                className="fe-panel"
                role="tabpanel"
                id={`fe-m-panel-${current}`}
                aria-labelledby={`fe-m-tab-${current}`}
                tabIndex={0}
            >
                {current === "overview" && <OverviewTab {...props} goTo={(k) => setTab(k as TabKey)} canSee={(k) => tabs.some((t) => t.key === k)} />}
                {current === "menu" && <MenuTab {...props} />}
                {current === "tables" && <TablesTab {...props} />}
                {current === "kitchen" && <KitchenTab {...props} />}
                {current === "payments" && <PaymentsTab {...props} />}
                {current === "chefs" && <ChefsTab {...props} />}
                {current === "staff" && <StaffTab {...props} />}
                {current === "settings" && <SettingsTab {...props} />}
                {current === "team" && <TeamPayTab {...props} />}
                {current === "mypay" && <MyPayTab {...props} />}
            </section>
        </div>
    )
}
