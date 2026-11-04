// The owner's money view: the payout wallet and its balance on-chain, what came in, every
// credited payment with its on-chain proof, invoices, and money that needs a refund. Owner only
// (server/routes/money.ts says why). A confidential payment never shows who paid or their seat.

import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { erc20Abi, getAddress } from "viem"
import type { MoneyInvoice, MoneyPayment, MoneySummary, MoneyTotals, RecheckResult } from "../../../../shared/types"
import { Address, Badge, CopyButton, Money, useWallet } from "../../../components"
import { isTxHash } from "../../../lib/format"
import { errorText, fe } from "../client"
import type { TabProps } from "../Manage"
import { Alert, Chip, istDateTime, Loading, plural, shortHex, toPath } from "../ui"

type Page<T> = { items: T[]; next: string | null; loading: boolean; error: string | null }
const emptyPage = <T,>(): Page<T> => ({ items: [], next: null, loading: true, error: null })

export function PaymentsTab({ view }: TabProps) {
    const id = view.restaurant.id
    const [summary, setSummary] = useState<MoneySummary | null>(null)
    const [summaryError, setSummaryError] = useState<string | null>(null)
    const [payments, setPayments] = useState<Page<MoneyPayment>>(emptyPage)
    const [invoices, setInvoices] = useState<Page<MoneyInvoice>>(emptyPage)

    const loadSummary = useCallback(async () => {
        try {
            setSummary(await fe.money(id))
            setSummaryError(null)
        } catch (e) {
            setSummaryError(errorText(e))
        }
    }, [id])

    const loadPayments = useCallback(
        async (before: string | null) => {
            setPayments((p) => ({ ...p, loading: true, error: null }))
            try {
                const page = await fe.moneyPayments(id, before)
                setPayments((p) => ({ items: before ? [...p.items, ...page.payments] : page.payments, next: page.next, loading: false, error: null }))
            } catch (e) {
                setPayments((p) => ({ ...p, loading: false, error: errorText(e) }))
            }
        },
        [id]
    )

    const loadInvoices = useCallback(
        async (before: string | null) => {
            setInvoices((p) => ({ ...p, loading: true, error: null }))
            try {
                const page = await fe.moneyInvoices(id, before)
                setInvoices((p) => ({ items: before ? [...p.items, ...page.invoices] : page.invoices, next: page.next, loading: false, error: null }))
            } catch (e) {
                setInvoices((p) => ({ ...p, loading: false, error: errorText(e) }))
            }
        },
        [id]
    )

    const refresh = useCallback(() => {
        void loadSummary()
        void loadPayments(null)
        void loadInvoices(null)
    }, [loadSummary, loadPayments, loadInvoices])
    useEffect(refresh, [refresh])

    return (
        <div className="fe-stack fe-money">
            <div className="fe-row-between">
                <h2 className="fe-h2">Payments</h2>
                <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>
                    Refresh
                </button>
            </div>

            {summaryError && <Alert>The summary didn't load: {summaryError}</Alert>}
            {!summary && !summaryError && <Loading label="Loading payments…" />}
            {summary && (
                <>
                    <PayoutSection payout={summary.payout} />
                    <TotalsSection totals={summary.totals} />
                    {summary.attention.length > 0 && <AttentionSection notices={summary.attention} />}
                </>
            )}

            <PaymentLog restaurantId={id} page={payments} more={() => void loadPayments(payments.next)} />
            <InvoiceList page={invoices} more={() => void loadInvoices(invoices.next)} />
        </div>
    )
}

// ------------------------------------------------------------------ payout wallet

function PayoutSection({ payout }: { payout: MoneySummary["payout"] }) {
    const { cfg, publicClient } = useWallet()
    const [balance, setBalance] = useState<{ value: number | null; error: boolean; at: number | null }>({ value: null, error: false, at: null })

    // Read from the chain in this browser, so it is the wallet's balance right now.
    const read = useCallback(async () => {
        setBalance((b) => ({ ...b, error: false }))
        try {
            const v = await publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(payout.wallet)] })
            setBalance({ value: Number(v), error: false, at: Date.now() })
        } catch {
            setBalance((b) => ({ ...b, error: true }))
        }
    }, [publicClient, cfg.token, payout.wallet])
    useEffect(() => {
        void read()
    }, [read])

    return (
        <section className="fe-settings-section" aria-labelledby="fe-pay-out-h">
            <h3 id="fe-pay-out-h" className="fe-h3">
                Payout wallet
            </h3>
            <p className="fe-mono fe-break">{payout.wallet}</p>
            <div className="fe-money-actions">
                <CopyButton text={payout.wallet} label="Copy address" />
                <a className="btn btn-quiet btn-sm" href={`${cfg.explorer}/address/${payout.wallet}`} target="_blank" rel="noreferrer">
                    View on explorer<span className="sr-only"> (opens in a new tab)</span>
                </a>
            </div>
            <dl className="fe-facts">
                <div>
                    <dt>USDC balance</dt>
                    <dd aria-live="polite">
                        {balance.value !== null ? <Money value={balance.value} strong /> : balance.error ? "Couldn't read the chain." : "Reading the chain…"}
                    </dd>
                </div>
                <div>
                    <dt>Confidential payments</dt>
                    <dd>
                        {payout.privatePayments === true ? (
                            <Chip tone="violet">On</Chip>
                        ) : payout.privatePayments === false ? (
                            <Chip tone="muted">Off</Chip>
                        ) : (
                            <Chip tone="muted">Unknown</Chip>
                        )}
                    </dd>
                </div>
            </dl>
            <p className="fe-hint">
                The balance is the whole wallet, read live from Monad testnet
                {balance.at ? ` at ${istDateTime(balance.at)}` : ""}. It includes money from anywhere, not only FairEats.{" "}
                <button type="button" className="fe-link" onClick={() => void read()}>
                    Read again
                </button>
            </p>
            {payout.privatePayments === false && (
                <p className="fe-explain">
                    FairPool only pays verified businesses, and this wallet isn't verified yet, so guests can only pay publicly. Ask FairPay to verify it.
                </p>
            )}
            {payout.privatePayments === null && <p className="fe-explain">We couldn't ask FairPool whether this wallet is verified. Try again shortly.</p>}
        </section>
    )
}

// ------------------------------------------------------------------ totals

function TotalsSection({ totals }: { totals: MoneySummary["totals"] }) {
    const tile = (label: string, t: MoneyTotals) => (
        <div className="fe-stat-wide">
            <dt>{label}</dt>
            <dd className="fe-num">
                <Money value={t.received} />
            </dd>
            <span className="fe-stat-note">
                {plural(t.count, "payment")}: <Money value={t.public} unit={false} /> public, <Money value={t.private} unit={false} /> confidential
            </span>
            <span className="fe-stat-note">
                {t.tips > 0 ? (
                    <>
                        Includes <Money value={t.tips} /> in tips
                    </>
                ) : (
                    "No tips"
                )}
            </span>
        </div>
    )
    return (
        <section aria-labelledby="fe-pay-tot-h" className="fe-section">
            <h3 id="fe-pay-tot-h" className="fe-h3">
                Received
            </h3>
            <dl className="fe-stats fe-money-stats">
                {tile("Today", totals.today)}
                {tile("Last 7 days", totals.week)}
                {tile("All time", totals.all)}
            </dl>
            <p className="fe-hint">
                Credited payments to this restaurant, in India time. Tips are the extra on a guest's last confidential note: notes are 5 USDC each, so
                the last one can pay a little more than the share.
            </p>
        </section>
    )
}

// ------------------------------------------------------------------ needs attention

function AttentionSection({ notices }: { notices: MoneySummary["attention"] }) {
    const { cfg } = useWallet()
    return (
        <section aria-labelledby="fe-pay-att-h" className="fe-section">
            <h3 id="fe-pay-att-h" className="fe-h3">
                Needs attention <span className="fe-count">{notices.length}</span>
            </h3>
            <p className="fe-hint">This money reached your wallet but wasn't counted for an order. Check each one and refund it if it isn't owed to you.</p>
            <ul className="fe-money-list">
                {notices.map((n) => (
                    <li key={n.id} className="fe-money-row fe-money-row--warn">
                        <div className="fe-money-top">
                            <strong>{n.title}</strong>
                            <Badge tone={n.kind === "refund" ? "error" : "warn"}>{n.kind === "refund" ? "Refund needed" : "Not counted"}</Badge>
                        </div>
                        {n.detail && <p className="fe-break">{n.detail}</p>}
                        <p className="fe-muted">
                            {istDateTime(n.at)}
                            {isTxHash(n.txHash) && (
                                <>
                                    {" · "}
                                    <a href={`${cfg.explorer}/tx/${n.txHash}`} target="_blank" rel="noreferrer" title={n.txHash}>
                                        View transaction<span className="sr-only"> on the Monad explorer (opens in a new tab)</span>
                                    </a>
                                </>
                            )}
                        </p>
                    </li>
                ))}
            </ul>
        </section>
    )
}

// ------------------------------------------------------------------ payment log

function PaymentLog({ restaurantId, page, more }: { restaurantId: string; page: Page<MoneyPayment>; more: () => void }) {
    return (
        <section aria-labelledby="fe-pay-log-h" className="fe-section">
            <div className="fe-row-between">
                <h3 id="fe-pay-log-h" className="fe-h3">
                    Payment log
                </h3>
                {page.items.length > 0 && (
                    <a className="btn btn-quiet btn-sm" href={fe.moneyCsvUrl(restaurantId)} download>
                        Download CSV
                    </a>
                )}
            </div>
            <p className="fe-hint">
                Every payment FairPay verified on-chain and credited, newest first. Open a payment for its proof: the PaymentReceived event that
                paid your wallet.
            </p>
            {page.error && <Alert>The payment log didn't load: {page.error}</Alert>}
            {!page.loading && !page.error && page.items.length === 0 && (
                <div className="fe-empty">
                    <p>
                        <strong>No payments yet.</strong> When guests pay for an order, each payment appears here with its transaction.
                    </p>
                </div>
            )}
            {page.items.length > 0 && (
                <ol className="fe-money-list">
                    {page.items.map((p) => (
                        <PaymentRow key={p.id} restaurantId={restaurantId} p={p} />
                    ))}
                </ol>
            )}
            {page.loading && <Loading label="Loading payments…" />}
            {page.next && !page.loading && (
                <button type="button" className="btn btn-secondary" onClick={more}>
                    Show older payments
                </button>
            )}
        </section>
    )
}

function orderLabel(p: MoneyPayment) {
    const parts = [p.order.table ? `Table ${p.order.table}` : "Order", p.order.invoiceNo ?? p.order.id]
    return parts.join(" · ")
}

function PaymentRow({ restaurantId, p }: { restaurantId: string; p: MoneyPayment }) {
    const { cfg } = useWallet()
    const [check, setCheck] = useState<{ busy: boolean; result: RecheckResult | null; error: string | null }>({ busy: false, result: null, error: null })
    const priv = p.kind === "private"
    const tx = p.proof && isTxHash(p.proof.txHash) ? p.proof.txHash : null

    async function recheck() {
        setCheck({ busy: true, result: null, error: null })
        try {
            setCheck({ busy: false, result: await fe.recheckPayment(restaurantId, p.id), error: null })
        } catch (e) {
            setCheck({ busy: false, result: null, error: errorText(e) })
        }
    }

    const who = priv ? (
        "Confidential (paid from the pool)"
    ) : p.payer ? (
        <Address value={p.payer} href={`${cfg.explorer}/address/${p.payer}`} />
    ) : (
        "Hidden: this share was also paid confidentially"
    )

    return (
        <li className="fe-money-row">
            <div className="fe-money-top">
                <span className="fe-num fe-money-amt">
                    <Money value={p.amount} />
                </span>
                <span className="fe-money-badges">
                    {priv ? <Badge tone="private">Confidential</Badge> : <Badge>Public</Badge>}
                    <Badge tone="verified">Verified</Badge>
                </span>
            </div>
            <p className="fe-money-meta">
                <span>{orderLabel(p)}</span>
                {p.share && <span>{p.share}</span>}
                {p.tip > 0 && (
                    <span>
                        Tip <Money value={p.tip} />
                    </span>
                )}
            </p>
            <p className="fe-muted">
                {istDateTime(p.at)} · {who}
            </p>
            <details className="fe-proof">
                <summary>
                    Proof<span className="sr-only"> for the {priv ? "confidential" : "public"} payment at {istDateTime(p.at)}</span>
                </summary>
                {p.proof ? (
                    <dl className="fe-proof-fields">
                        <div>
                            <dt>Event</dt>
                            <dd>PaymentReceived on FairPay</dd>
                        </div>
                        <div>
                            <dt>Order reference</dt>
                            <dd className="fe-mono fe-break">{p.proof.orderRef}</dd>
                        </div>
                        <div>
                            <dt>Recipient</dt>
                            <dd className="fe-mono fe-break">{p.recipient}</dd>
                        </div>
                        <div>
                            <dt>Payer</dt>
                            <dd className={priv || p.payer ? "fe-mono fe-break" : undefined}>{priv ? `FairPool ${cfg.pool}` : (p.payer ?? "Hidden")}</dd>
                        </div>
                        <div>
                            <dt>Amount</dt>
                            <dd>
                                <Money value={p.amount} />
                                {p.tip > 0 && (
                                    <>
                                        {" "}
                                        (tip <Money value={p.tip} />)
                                    </>
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt>Block</dt>
                            <dd className="fe-mono">{p.proof.blockNumber}</dd>
                        </div>
                        <div>
                            <dt>Transaction</dt>
                            <dd className="fe-mono fe-break">
                                {tx ? (
                                    <a href={`${cfg.explorer}/tx/${tx}`} target="_blank" rel="noreferrer">
                                        {tx}
                                        <span className="sr-only"> on the Monad explorer (opens in a new tab)</span>
                                    </a>
                                ) : (
                                    p.proof.txHash
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt>Log index</dt>
                            <dd className="fe-mono">{p.proof.logIndex}</dd>
                        </div>
                        <div>
                            <dt>Verified</dt>
                            <dd>{istDateTime(p.at)}</dd>
                        </div>
                    </dl>
                ) : (
                    <p className="fe-explain">
                        This guest's share was paid partly in public and partly confidentially. Its transactions would tie the public payer to the
                        confidential part, so they aren't shown. FairPay verified it on-chain at {istDateTime(p.at)}, and you can check it again.
                    </p>
                )}
                <div className="fe-money-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void recheck()} disabled={check.busy}>
                        {check.busy ? "Checking…" : "Re-check on-chain"}
                    </button>
                </div>
                <div aria-live="polite">
                    {check.result && (
                        <p className="fe-status-line">
                            <Badge tone={check.result.status === "verified" ? "verified" : check.result.status === "pending" ? "warn" : "error"}>
                                {check.result.status === "verified" ? "Still verified" : check.result.status === "pending" ? "Pending" : "Not confirmed"}
                            </Badge>
                            <span>
                                {check.result.reason ?? "The chain confirms this payment."} Checked {istDateTime(check.result.checkedAt)}.
                            </span>
                        </p>
                    )}
                    {check.error && <Alert>{check.error}</Alert>}
                </div>
            </details>
        </li>
    )
}

// ------------------------------------------------------------------ invoices

function InvoiceList({ page, more }: { page: Page<MoneyInvoice>; more: () => void }) {
    return (
        <section aria-labelledby="fe-pay-inv-h" className="fe-section">
            <h3 id="fe-pay-inv-h" className="fe-h3">
                Invoices
            </h3>
            {page.error && <Alert>The invoices didn't load: {page.error}</Alert>}
            {!page.loading && !page.error && page.items.length === 0 && <p className="fe-muted">No invoices yet. An order gets one when it is fully paid.</p>}
            {page.items.length > 0 && (
                <div className="fe-table-wrap">
                    <table className="fe-data fe-money-inv">
                        <caption className="sr-only">Invoices, newest first</caption>
                        <thead>
                            <tr>
                                <th scope="col">Number</th>
                                <th scope="col">Issued</th>
                                <th scope="col">Order</th>
                                <th scope="col">Total</th>
                                <th scope="col">
                                    <span className="sr-only">Open</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {page.items.map((i) => (
                                <tr key={i.orderId}>
                                    <td className="fe-mono">{i.invoiceNo}</td>
                                    <td>{istDateTime(i.issuedAt)}</td>
                                    <td>
                                        {i.table ? `Table ${i.table}` : "No table"} · <span title={i.orderId}>{shortHex(i.orderId, 8, 4)}</span>
                                        {i.kind === "bill_of_supply" && <span className="fe-hint"> · Bill of supply</span>}
                                    </td>
                                    <td className="fe-num">
                                        <Money value={i.total} />
                                    </td>
                                    <td className="fe-td-action">
                                        {i.url && (
                                            <Link className="btn btn-quiet btn-sm" to={toPath(i.url)}>
                                                Open<span className="sr-only"> invoice {i.invoiceNo}</span>
                                            </Link>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {page.loading && <Loading label="Loading invoices…" />}
            {page.next && !page.loading && (
                <button type="button" className="btn btn-secondary" onClick={more}>
                    Show older invoices
                </button>
            )}
        </section>
    )
}
