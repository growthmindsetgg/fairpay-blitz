import { useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import type { Invoice } from "../../../shared/types"
import { CopyButton } from "../../components"
import { usdcNumber } from "../../lib/format"
import { useWallet } from "../../lib/wallet"
import "../../styles/business.css"
import { ApiError, errorText, fe } from "./client"
import { absoluteUrl, Alert, istDateTime, Loading, percent, shortHex, toPath, usdc } from "./ui"

// Past tense only once the bill is paid; a preview or a cancelled order says how it was to be paid.
const PAYMENT_MODE: Record<Invoice["paymentMode"], { paid: string; unpaid: string }> = {
    one_pays: { paid: "One guest paid the whole bill", unpaid: "One guest pays the whole bill" },
    split: { paid: "Each guest paid their own share", unpaid: "Each guest pays their own share" }
}

export function InvoicePage() {
    const { token = "" } = useParams()
    const { cfg } = useWallet()
    const navigate = useNavigate()
    // "default" means this page was opened directly (a shared link), so there's no in-app page to go back to.
    const cameFromApp = useLocation().key !== "default"
    const [inv, setInv] = useState<Invoice | null>(null)
    const [error, setError] = useState<{ status: number; message: string } | null>(null)

    const load = useCallback(async () => {
        try {
            setInv(await fe.invoice(token))
            setError(null)
        } catch (e) {
            setError({ status: e instanceof ApiError ? e.status : 0, message: errorText(e) })
        }
    }, [token])
    useEffect(() => {
        void load()
    }, [load])
    useEffect(() => {
        if (inv) document.title = `${inv.kind === "tax_invoice" ? "Tax Invoice" : "Bill of Supply"} ${inv.invoiceNo ?? ""} · ${inv.supplier.name}`
    }, [inv])

    if (!inv)
        return (
            <div className="fe fe-page fe-narrow">
                {error ? (
                    <div className="fe-state">
                        <h1>{error.status === 404 ? "We can't find that invoice" : "The invoice didn't load"}</h1>
                        <Alert>{error.status === 404 ? "The link may be incomplete. Copy it again from the order page." : error.message}</Alert>
                        {error.status !== 404 && (
                            <button className="btn btn-secondary" onClick={() => void load()}>
                                Try again
                            </button>
                        )}
                    </div>
                ) : (
                    <Loading label="Loading the invoice…" />
                )}
            </div>
        )

    const tax = inv.kind === "tax_invoice"
    const s = inv.supplier
    const igst = inv.igst.amount > 0
    const link = absoluteUrl(toPath(inv.shareUrl || `/i/${token}`))
    const paid = inv.status !== "awaiting_payment" && inv.status !== "cancelled"
    const placeCode = s.stateCode

    return (
        <div className="fe fe-page fe-inv-page">
            <div className="fe-inv-actions fe-noprint">
                {/* The invoice token is read-only and separate from the order's share token, so it can't open the order. */}
                {cameFromApp && (
                    <button type="button" className="btn btn-quiet btn-sm fe-inv-back" onClick={() => navigate(-1)}>
                        Back
                    </button>
                )}
                <CopyButton text={link} label="Copy link" className="btn btn-secondary btn-sm" />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
                    Print
                </button>
            </div>

            {inv.status === "cancelled" && <Alert>This order was cancelled. The document below is not a valid invoice.</Alert>}
            {inv.status === "awaiting_payment" && (
                <Alert tone="info">The bill isn't fully paid yet, so no invoice number has been issued. This is a preview.</Alert>
            )}

            <article className="fe-inv" aria-labelledby="fe-inv-title">
                <header className="fe-inv-head">
                    <div className="fe-inv-supplier">
                        <p className="fe-inv-name">{s.name}</p>
                        {(s.address || s.city) && <p>{[s.address, s.city].filter(Boolean).join(", ")}</p>}
                        <p>
                            {s.state}
                            {s.stateCode && <> (State code {s.stateCode})</>}
                        </p>
                        <dl className="fe-inv-ids">
                            <div>
                                <dt>GSTIN</dt>
                                <dd className="fe-mono">{s.gstin ?? "Not registered"}</dd>
                            </div>
                            {s.fssai && (
                                <div>
                                    <dt>FSSAI Lic. No.</dt>
                                    <dd className="fe-mono">{s.fssai}</dd>
                                </div>
                            )}
                        </dl>
                    </div>
                    <div className="fe-inv-doc">
                        <h1 id="fe-inv-title" className="fe-inv-title">
                            {tax ? "Tax Invoice" : "Bill of Supply"}
                        </h1>
                        <dl className="fe-inv-meta">
                            <div>
                                <dt>Invoice no.</dt>
                                <dd className="fe-mono">{inv.invoiceNo ?? (paid ? "Pending" : "Not issued")}</dd>
                            </div>
                            <div>
                                <dt>Date</dt>
                                <dd>{istDateTime(inv.issuedAt)} IST</dd>
                            </div>
                            <div>
                                <dt>Place of supply</dt>
                                <dd>
                                    {inv.placeOfSupply}
                                    {placeCode && ` (${placeCode})`}
                                </dd>
                            </div>
                            {inv.table && (
                                <div>
                                    <dt>Table</dt>
                                    <dd>{inv.table}</dd>
                                </div>
                            )}
                            <div>
                                <dt>Order</dt>
                                <dd className="fe-mono">{inv.orderId}</dd>
                            </div>
                        </dl>
                    </div>
                </header>

                <div className="fe-inv-scroll" tabIndex={0} role="region" aria-label="Invoice lines">
                    <table className="fe-inv-lines">
                        <caption className="sr-only">Items, amounts in USDC</caption>
                        <thead>
                            <tr>
                                <th scope="col" className="fe-c-n">
                                    #
                                </th>
                                <th scope="col">Description</th>
                                <th scope="col" className="fe-c-sac">
                                    SAC
                                </th>
                                <th scope="col" className="fe-c-r">
                                    Qty
                                </th>
                                <th scope="col" className="fe-c-r">
                                    Rate
                                </th>
                                <th scope="col" className="fe-c-r">
                                    Taxable value
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {inv.lines.map((l, i) => (
                                <tr key={i}>
                                    <td className="fe-c-n">{i + 1}</td>
                                    <td>
                                        {l.name}
                                        {/* Narrow screens fold the SAC column in here so the amounts fit. */}
                                        <span className="fe-inv-sac-inline fe-mono">
                                            SAC {l.sac}
                                        </span>
                                    </td>
                                    <td className="fe-mono fe-c-sac">{l.sac}</td>
                                    <td className="fe-c-r fe-num">{l.qty}</td>
                                    <td className="fe-c-r fe-num">{usdcNumber(l.rate)}</td>
                                    <td className="fe-c-r fe-num">{usdcNumber(l.taxable)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="fe-inv-bottom">
                    <div className="fe-inv-words">
                        <p className="fe-label-sm">Amount in words</p>
                        <p className="fe-inv-words-text">{inv.amountInWords}</p>
                        <p className="fe-label-sm">Payment</p>
                        <p>{PAYMENT_MODE[inv.paymentMode][paid ? "paid" : "unpaid"]}.</p>
                    </div>
                    <table className="fe-inv-totals">
                        <caption className="sr-only">Totals in USDC</caption>
                        <tbody>
                            <tr>
                                <th scope="row">Subtotal</th>
                                <td className="fe-num">{usdcNumber(inv.subtotal)}</td>
                            </tr>
                            {inv.serviceCharge > 0 && (
                                <tr>
                                    <th scope="row">Service charge @ {percent(inv.serviceChargeBps)}</th>
                                    <td className="fe-num">{usdcNumber(inv.serviceCharge)}</td>
                                </tr>
                            )}
                            {tax && (
                                <tr>
                                    <th scope="row">Taxable value</th>
                                    <td className="fe-num">{usdcNumber(inv.taxableValue)}</td>
                                </tr>
                            )}
                            {tax && !igst && (
                                <>
                                    <tr>
                                        <th scope="row">CGST @ {percent(inv.cgst.rateBps)}</th>
                                        <td className="fe-num">{usdcNumber(inv.cgst.amount)}</td>
                                    </tr>
                                    <tr>
                                        <th scope="row">SGST @ {percent(inv.sgst.rateBps)}</th>
                                        <td className="fe-num">{usdcNumber(inv.sgst.amount)}</td>
                                    </tr>
                                </>
                            )}
                            {tax && igst && (
                                <tr>
                                    <th scope="row">IGST @ {percent(inv.igst.rateBps)}</th>
                                    <td className="fe-num">{usdcNumber(inv.igst.amount)}</td>
                                </tr>
                            )}
                            <tr>
                                <th scope="row">Round off</th>
                                <td className="fe-num">{usdcNumber(inv.roundOff)}</td>
                            </tr>
                            <tr className="fe-inv-total">
                                <th scope="row">Total (USDC)</th>
                                <td className="fe-num">{usdcNumber(inv.total)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <section className="fe-inv-payments" aria-labelledby="fe-inv-pay-h">
                    <h2 id="fe-inv-pay-h" className="fe-label-sm">
                        Payments received
                    </h2>
                    {inv.payments.length === 0 ? (
                        <p className="fe-muted">
                            {inv.demo
                                ? "None. This is a demo order: it came with the demo restaurant and was marked paid without any payment."
                                : "No payments yet."}
                        </p>
                    ) : (
                        <ul>
                            {inv.payments.map((p, i) => (
                                <li key={i}>
                                    <span>{p.label}</span>
                                    <span className="fe-num">{usdc(p.amount)}</span>
                                    <span className="fe-inv-how">
                                        {p.private ? (
                                            "Paid confidentially"
                                        ) : p.txHash ? (
                                            <>
                                                Paid on Monad Testnet,{" "}
                                                <a href={`${cfg.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer" className="fe-mono" title={p.txHash}>
                                                    tx {shortHex(p.txHash)}
                                                    <span className="sr-only"> (opens in a new tab)</span>
                                                </a>
                                            </>
                                        ) : (
                                            "Paid on Monad Testnet"
                                        )}
                                    </span>
                                    <span className="fe-muted">{istDateTime(p.at)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <footer className="fe-inv-foot">
                    {!tax && <p>Supplier not registered under GST{s.gstin ? " for this supply" : ""}. No GST charged.</p>}
                    {tax && <p>Restaurant service, SAC 996331. GST at {percent(inv.cgst.rateBps + inv.sgst.rateBps + inv.igst.rateBps)} without input tax credit.</p>}
                    <p>Prices in test USDC on Monad Testnet. No real money changed hands.</p>
                    <p>Computer-generated document. No signature required.</p>
                    <p className="fe-inv-link fe-mono">{link}</p>
                </footer>
            </article>
        </div>
    )
}
