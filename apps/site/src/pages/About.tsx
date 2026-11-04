import { Link } from "react-router-dom"
import { Callout, H3, Section } from "../components/Prose"
import { Ext } from "../components/Ext"
import { APP_URL, CHAIN_ID, CONTRACTS, EXPLORER, MORE_CONTRACTS, addressUrl, short } from "../data"
import { PAGE_META } from "../meta"

// Who makes FairPay (and who doesn't), what "testnet" and "unaudited" mean here, the live
// contracts, and what the site and the app store, so visitors can judge it before signing in.

const ALL_CONTRACTS = [...CONTRACTS, ...MORE_CONTRACTS]
const EXPLORER_HOST = new URL(EXPLORER).host

export function AboutPage() {
    const meta = PAGE_META["/about"]
    return (
        <>
            <title>{meta.title}</title>
            <meta name="description" content={meta.description} />
            <div className="wrap about">
                <article className="guide" id="top">
                    <header className="g-intro">
                        <h1>About FairPay</h1>
                    </header>
                    <p className="lead g-lead">
                        FairPay is an independent project for splitting bills with friends and paying restaurants, with
                        Confidential payments at verified businesses. It runs only on Monad Testnet, with test USDC, and it
                        has not been audited.
                    </p>

                    <Section id="what-it-is" title="What FairPay is">
                        <p>
                            FairPay is a bill-splitting app. You create a bill, send one link, and each person pays their own
                            share in test USDC from their own wallet. A share turns Paid only once FairPay finds the payment
                            on Monad, so nobody can just tick a box.
                        </p>
                        <p>
                            Its Business section holds FairEats, where restaurants list menus and tables, guests order and
                            split the bill at the table, and the restaurant issues GST invoices. At a verified business a
                            guest can pay confidentially: the payment goes through a privacy pool, so the chain doesn't link it
                            to their wallet. Bills between friends are paid publicly.
                        </p>
                        <p>
                            The contracts and the SDK are part of the same project. The <Link to="/guide">guide</Link>{" "}
                            explains how they work and how to run them yourself, and the source code is on{" "}
                            <Ext href="https://github.com/growthmindsetgg/fairpay-blitz">GitHub</Ext>.
                        </p>
                    </Section>

                    <Section id="independent" title="An independent testnet project">
                        <ul>
                            <li>
                                <strong>Independent.</strong> FairPay is built on Monad. It is not made, run or endorsed by
                                the Monad Foundation, and it is not affiliated with it.
                            </li>
                            <li>
                                <strong>Testnet only.</strong> Everything runs on Monad Testnet (chain {CHAIN_ID}). Test USDC
                                is a mock token that anyone can mint. It has no value.
                            </li>
                            <li>
                                <strong>Unaudited.</strong> Nobody independent has audited the contracts, the SDK or the app.{" "}
                                <Link to="/guide/security">Security and limitations</Link> lists what is known.
                            </li>
                        </ul>
                        <Callout kind="careful">
                            Never send real funds to a FairPay wallet or contract, and don't sign in with a wallet that holds
                            any. Use a new wallet, or the test wallet built into the app.
                        </Callout>
                    </Section>

                    <Section id="contracts" title="The contracts on Monad Testnet">
                        <p>
                            These are the deployed contracts. Each address opens on the Monad Testnet explorer (
                            {EXPLORER_HOST}), where you can read the contract and every transaction it has handled.
                        </p>
                        <dl className="about-contracts">
                            {ALL_CONTRACTS.map((c) => (
                                <div key={c.address}>
                                    <dt>{c.name}</dt>
                                    <dd>
                                        <Ext href={addressUrl(c.address)} hint={`${c.name} on the Monad explorer`} className="mono about-addr">
                                            <span aria-hidden="true" title={c.address}>
                                                {short(c.address, 10, 8)}
                                            </span>
                                            <span className="sr-only">{c.address}</span>
                                        </Ext>
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </Section>

                    <Section id="privacy" title="Privacy">
                        <H3 id="privacy-site">This website</H3>
                        <p>
                            Every page, font and image comes from this site. It makes no third-party requests, has no
                            analytics or trackers, and its pages set no cookies. Each page sends one request to{" "}
                            <code>/api/health</code> on this same address, to wake the app's server early. It carries no
                            cookies and its answer is ignored.
                        </p>
                        <H3 id="privacy-app">The FairPay app</H3>
                        <p>
                            When you sign in to <a href={APP_URL}>the app</a>, its server keeps a sign-in session for your
                            wallet address, and what you add: your name, friends, bills and shares, and for FairEats,
                            restaurants, menus, orders and invoices. They are stored in the app's database. Like any web
                            server, it also sees connection details such as your IP address.
                        </p>
                        <p>
                            The test wallet's key and your Confidential notes stay in your browser's local storage, on your
                            device. They are not sent to FairPay's server. Clearing this site's data in your browser deletes
                            them, and nobody can recover them for you.
                        </p>
                        <p>
                            Payments themselves are public records on Monad Testnet, like any blockchain transaction. A
                            Confidential payment hides which wallet paid, not the amount or the business that was paid.
                        </p>
                    </Section>
                </article>
            </div>
        </>
    )
}
