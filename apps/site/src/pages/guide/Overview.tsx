import { Link } from "react-router-dom"
import { Section } from "../../components/Prose"
import { APP_URL } from "../../data"

export default function Overview() {
    return (
        <>
            <p className="lead g-lead">
                This guide covers the whole project: how to use the FairPay app, how payments and private payments work,
                and how to run, test, deploy and build on it. FairPay is a testnet prototype. Nothing here is audited.
            </p>
            <ul className="start-here">
                <li>
                    New here? <Link to="/guide/start">Get started with the app</Link>, or{" "}
                    <a href={APP_URL}>open FairPay</a> straight away.
                </li>
                <li>
                    No wallet handy? <Link to="/guide/demo">Try the simulated demo</Link>.
                </li>
                <li>
                    Want to run it? <Link to="/guide/run">Run it locally</Link>.
                </li>
                <li>
                    Building a checkout? <Link to="/guide/sdk">Use the SDK</Link>.
                </li>
                <li>
                    Deciding whether to trust it? <Link to="/guide/security">Security and limitations</Link>.
                </li>
            </ul>

            <Section id="what-it-is" title="What FairPay is">
                <p>
                    FairPay is a bill-splitting app for friends, with payments in test USDC on Monad Testnet. A share only
                    shows as paid after FairPay finds the payment on-chain. Its <strong>Business</strong> section holds
                    FairEats, where restaurants list menus and tables, guests order and split the bill at the table, and
                    the restaurant issues Indian GST invoices.
                </p>
                <p>The project has four parts:</p>
                {/* Fits at every width (rows stack below 640), so no .table-scroll region. The explicit
                    roles keep rows and cells announced when the stacked layout sets display: block. */}
                <table className="g-table" role="table">
                    <caption className="sr-only">FairPay's four parts</caption>
                    <thead role="rowgroup">
                        <tr role="row">
                            <th scope="col" role="columnheader">
                                Part
                            </th>
                            <th scope="col" role="columnheader">
                                What it does
                            </th>
                        </tr>
                    </thead>
                    <tbody role="rowgroup">
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                FairPay app <code>apps/fairpay</code>
                            </th>
                            <td role="cell">
                                Bill splitting (evenly, by amounts, percent or shares) with share links, seat claims and
                                reminders, plus FairEats: restaurant registration, menus, tables, a kitchen board, orders
                                and GST invoices. Live on this website at <a href={APP_URL}>/pay/</a>.
                            </td>
                        </tr>
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                Contracts <code>packages/contracts</code>
                            </th>
                            <td role="cell">
                                <code>FairPay</code> routes a payment to an allowlisted merchant and emits one{" "}
                                <code>PaymentReceived</code> event. <code>FairPool</code> is a privacy pool built on Semaphore
                                v4 with a fixed 5 USDC note size. <code>MonadSemaphoreVerifier</code> checks the
                                zero-knowledge proofs on Monad.
                            </td>
                        </tr>
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                SDK <code>@fairpay/sdk</code>
                            </th>
                            <td role="cell">
                                Creates order references, pays publicly or privately, runs a relayer, and verifies payments
                                against the chain.
                            </td>
                        </tr>
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                FairEats demo <code>apps/faireats</code>
                            </th>
                            <td role="cell">
                                The original single-restaurant app, "Saffron Table". Its simulated build is the{" "}
                                <Link to="/guide/demo">demo on this site</Link>, which runs in your browser with no wallet.
                            </td>
                        </tr>
                    </tbody>
                </table>
                <p>There are two ways to pay:</p>
                <ul>
                    <li>
                        <strong>Public.</strong> You pay from your wallet. Anyone looking at the chain sees your wallet, who
                        you paid and the amount. Bills between friends are paid this way.
                    </li>
                    <li>
                        <strong>Private</strong> (Confidential in the app). You pay with 5 USDC notes you added to the pool
                        earlier. Your browser builds a proof that you own the notes, and a relayer sends the payment, so it
                        does not contain your wallet. This works when you pay a verified business, such as a FairEats
                        restaurant whose payout wallet is allowlisted.
                    </li>
                </ul>
                <p>
                    Either way, FairPay does not trust your browser. It only marks a share paid after it finds the payment
                    on-chain.
                </p>
            </Section>
        </>
    )
}
