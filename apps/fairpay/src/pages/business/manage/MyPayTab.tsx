// My pay: what this restaurant's owner paid the signed-in staff member through Team pay, newest
// first, each with its transaction. Only their own payments (GET /restaurants/:id/team-pay/mine).

import { useCallback, useEffect, useState } from "react"
import type { TeamPayout } from "../../../../shared/types"
import { useWallet } from "../../../components"
import { teamPayApi } from "../../../lib/api"
import { errorText } from "../client"
import type { TabProps } from "../Manage"
import { Alert, Loading } from "../ui"
import { MyEscrow } from "./MyEscrow"
import { PayoutRow } from "./TeamPayTab"
import "./teamPay.css"

export function MyPayTab({ view }: TabProps) {
    const id = view.restaurant.id
    const { cfg } = useWallet()
    const [page, setPage] = useState<{ items: TeamPayout[]; next: string | null; loading: boolean; error: string | null }>({
        items: [],
        next: null,
        loading: true,
        error: null
    })

    const load = useCallback(
        async (before: string | null) => {
            setPage((p) => ({ ...p, loading: true, error: null }))
            try {
                const r = await teamPayApi.mine(id, before)
                setPage((p) => ({ items: before ? [...p.items, ...r.payouts] : r.payouts, next: r.next, loading: false, error: null }))
            } catch (e) {
                setPage((p) => ({ ...p, loading: false, error: errorText(e) }))
            }
        },
        [id]
    )
    useEffect(() => {
        void load(null)
    }, [load])

    return (
        <div className="fe-stack fe-money fe-team">
            <div className="fe-row-between">
                <h2 className="fe-h2">My pay</h2>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(null)}>
                    Refresh
                </button>
            </div>
            {cfg.payroll && <MyEscrow restaurantId={id} restaurantName={view.restaurant.name} />}
            {cfg.payroll && <h3 className="fe-h3">Direct payments</h3>}
            <p className="fe-hint">
                Payments {view.restaurant.name} sent to your wallet in USDC. Each is a public transfer: anyone can see on Monad the owner's wallet, your
                wallet and the amount. The note is only in FairPay.
            </p>
            {page.error && <Alert>Your payments didn't load: {page.error}</Alert>}
            {!page.loading && !page.error && page.items.length === 0 && (
                <div className="fe-empty">
                    <p>
                        <strong>No payments yet.</strong> When the owner pays you through Team pay, it shows up here and in your activity.
                    </p>
                </div>
            )}
            {page.items.length > 0 && (
                <ol className="fe-money-list">
                    {page.items.map((p) => (
                        <PayoutRow key={p.id} p={p} mine />
                    ))}
                </ol>
            )}
            {page.loading && <Loading label="Loading your payments…" />}
            {page.next && !page.loading && (
                <button type="button" className="btn btn-secondary" onClick={() => void load(page.next)}>
                    Show older payments
                </button>
            )}
        </div>
    )
}
