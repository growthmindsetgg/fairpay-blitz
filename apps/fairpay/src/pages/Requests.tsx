import { useCallback, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import type { BillSummary } from "../../shared/types"
import { EmptyState } from "../components/EmptyState"
import { friendly } from "../components/errors"
import { Icon } from "../components/Icon"
import { ErrorNote, Loading, PageHeader, SignInGate, useTitle } from "../components/Page"
import { Tabs } from "../components/Tabs"
import { api } from "../lib/api"
import { BillList } from "./Home"

type Tab = "incoming" | "outgoing"

export function Requests() {
    useTitle("Requests")
    return (
        <div className="content">
            <PageHeader title="Requests" description="Bills waiting on you, and bills where you're waiting on others." />
            <SignInGate title="Sign in to see your requests">
                <RequestTabs />
            </SignInGate>
        </div>
    )
}

function RequestTabs() {
    const [params, setParams] = useSearchParams()
    const tab: Tab = params.get("tab") === "outgoing" ? "outgoing" : "incoming"
    const [data, setData] = useState<{ incoming: BillSummary[]; outgoing: BillSummary[] } | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            setData(await api.requests())
        } catch (e) {
            setError(friendly(e))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const setTab = (t: Tab) => setParams(t === "incoming" ? {} : { tab: t }, { replace: true })

    return (
        <section className="card">
            <Tabs
                label="Requests"
                value={tab}
                onChange={setTab}
                items={[
                    { id: "incoming", label: "You owe", count: data?.incoming.length },
                    { id: "outgoing", label: "Owed to you", count: data?.outgoing.length }
                ]}
            >
                {error ? (
                    <ErrorNote message={error} onRetry={() => void load()} title="We couldn't load your requests" />
                ) : !data ? (
                    <Loading />
                ) : tab === "incoming" ? (
                    data.incoming.length ? (
                        <BillList bills={data.incoming} onChanged={load} />
                    ) : (
                        <EmptyState icon="inbox" title="You don't owe anyone">
                            <p>When a friend adds you to a bill, it shows up here with your share and a Pay button.</p>
                        </EmptyState>
                    )
                ) : data.outgoing.length ? (
                    <BillList bills={data.outgoing} onChanged={load} />
                ) : (
                    <EmptyState
                        icon="receipt"
                        title="Nobody owes you"
                        action={
                            <Link to="/bills/new" className="btn btn-primary">
                                <Icon name="plus" size={18} />
                                New bill
                            </Link>
                        }
                    >
                        <p>Bills you created that are still waiting on someone show up here, so you can send a reminder.</p>
                    </EmptyState>
                )}
            </Tabs>
        </section>
    )
}
