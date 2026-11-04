import { useRef } from "react"
import { Link } from "react-router-dom"
import { TableArt } from "../components/TableArt"
import { CodeBlock } from "../components/CodeBlock"
import { PrivacyFlow } from "../components/PrivacyFlow"
import { BrowserShot, PhoneShot } from "../components/Shot"
import { Ext } from "../components/Ext"
import { AlertGlyph, CheckGlyph, CopyGlyph, InfoGlyph, LockGlyph, SignGlyph } from "../components/Glyphs"
import { APP_URL, CHAIN_ID, CONTRACTS, DEMO_TABLE_URL, POOL_ADDRESS, PROOF_TXS, addressUrl, short, txUrl, type ProofTx } from "../data"
import { useCopy } from "../lib/hooks"
import { PAGE_META } from "../meta"

const VERIFY_SNIPPET = `const result = await fairpay.verifyPaymentTx(
  deployment,
  publicClient,
  {
    txHash, orderRef, merchant,
    amount: share.amount,
    expectedPayer: share.wallet, // public payments only
    minConfirmations: 2n,
  },
)
if (result.status === "verified") releaseOrder(shareId)`

const POINTS = [
    {
        title: "Split it your way",
        body: "Evenly, by exact amounts, by percent or by shares. Leftover cents land in a stated, predictable place."
    },
    {
        title: "One link per bill",
        body: "Send it to the group. Friends without a wallet get a name-only seat and claim it when they sign in."
    },
    {
        title: "Paid means verified",
        body: "A share shows as paid only after FairPay finds the payment on Monad. Nobody can just tick a box."
    },
    {
        title: "Private at restaurants",
        body: "At verified businesses you can pay through a privacy pool, so your wallet isn't linked to the payment."
    }
]

const BILL_STEPS = [
    {
        title: "Create the bill.",
        body: "Enter what it was for and the total in USDC, then add people from your friends, by wallet address or by name. The preview shows every share before you save."
    },
    {
        title: "Share one link.",
        body: "Copy the bill's link into your group chat. It shows names and amounts, never wallet addresses. Anyone added by name claims their seat from the link."
    },
    {
        title: "Everyone pays their part.",
        body: "Each person pays their own share from their own wallet, in test USDC on Monad. Send a reminder to whoever hasn't paid yet."
    },
    {
        title: "The bill settles itself.",
        body: "Each share turns Paid once FairPay finds the payment on-chain. Mark anyone who paid you some other way as Covered. When nothing is left to collect, the bill is settled."
    }
]

const SPLITS = [
    ["Evenly", "Everyone owes the same."],
    ["Exact amounts", "Type each person's part; it must add up."],
    ["Percent", "For uneven shares of a big bill."],
    ["Shares", "Two shares for the couple, one for each friend."]
]

const GUESTS = [
    "Open the restaurant's page from a table card or link, and pick a free table.",
    "Add dishes for each guest at the table. GST and any service charge are shown before you order.",
    "Choose how to pay: one person pays the whole bill, or everyone pays their own share.",
    "Pay publicly, or privately if the restaurant is verified for private payments.",
    "Follow the order from paid to cooking, ready and served, then open the invoice."
]

const RESTAURANTS = [
    "Register in a few minutes: name, address, state, and an optional GSTIN that is checked before it is saved.",
    "Build the menu with photos, categories, veg and spice marks, prep time and availability.",
    "Set up tables and seats, and see at a glance which ones are free.",
    "Run the kitchen board: start cooking, mark ready, mark served. It updates every 5 seconds.",
    "Add chefs with profiles and staff by wallet and role. Payouts go to the owner's own wallet."
]

const COMPARE: [string, string, string][] = [
    ["Your wallet address", "In the payment", "Only in the earlier top-up, not in the payment"],
    ["The amount", "Visible", "Visible (always whole 5 USDC notes)"],
    ["The restaurant's address", "Visible", "Visible"],
    ["What you ordered", "A reference code only", "A reference code only"],
    ["Which top-up paid", "Not applicable", "Hidden among the other deposits in the pool"]
]

const LIMITS = [
    ["Testnet only.", "Everything runs on Monad Testnet with test USDC that anyone can mint. Nothing here has value."],
    ["Not audited.", "No independent audit of the contracts, the SDK or the app."],
    [
        "Not invisible.",
        "FairPay's server sees connection details such as your IP address. Adding notes right before you pay can link the two by timing."
    ],
    ["Private only at verified businesses.", "The pool pays only allowlisted payout wallets, so bills between friends are paid publicly."],
    ["Fixed note size.", "Private payments use 5 USDC notes with no change. If a share isn't a whole number of notes, the last note's extra goes to the restaurant as a tip, and the app says so first."],
    ["A sleepy free server.", "The app runs on a free plan. After a quiet spell, the first visit takes about 50 seconds while it wakes up."]
]

function Addr({ value, hint }: { value: string; hint: string }) {
    return (
        <Ext href={addressUrl(value)} hint={hint} className="mono addr">
            <span aria-hidden="true" title={value}>
                {short(value)}
            </span>
            <span className="sr-only">{value}</span>
        </Ext>
    )
}

function ProofRow({ t, onCopy, copied }: { t: ProofTx; onCopy: (t: ProofTx, el: HTMLElement | null) => void; copied: boolean }) {
    const hashRef = useRef<HTMLSpanElement>(null)
    const isPrivate = t.kind === "Private"
    return (
        <tr role="row">
            <td className="p-payment" role="cell">
                <span className={`kind ${isPrivate ? "is-private" : "is-public"}`}>
                    {isPrivate ? <LockGlyph /> : <CheckGlyph />}
                    {t.kind}
                </span>
                <span className="p-note">{t.note}</span>
            </td>
            <td className="p-tx" role="cell" data-label="Transaction">
                <span className="p-tx-row">
                    <Ext href={txUrl(t.hash)} hint="transaction on the Monad explorer" className="mono hash">
                        <span aria-hidden="true" title={t.hash} ref={hashRef}>
                            {short(t.hash)}
                        </span>
                        <span className="sr-only">{t.hash}</span>
                        <span className="ext-mark" aria-hidden="true">
                            ↗
                        </span>
                    </Ext>
                    <button type="button" className="btn-copy-ink" onClick={() => onCopy(t, hashRef.current)}>
                        {copied ? <CheckGlyph /> : <CopyGlyph />}
                        <span className="sr-only">Copy hash {short(t.hash)}</span>
                    </button>
                </span>
            </td>
            <td className="p-from" role="cell" data-label="Sent by">
                {/* One wrapper, so the stacked layout's grid sees one value next to the "Sent by" label. */}
                <span className="p-sender">
                    <span className="p-label">{t.fromLabel}</span> <Addr value={t.from} hint={`${t.fromLabel} on the Monad explorer`} />
                </span>
            </td>
            <td className="p-to" role="cell" data-label="Sent to">
                {t.toLabel}
            </td>
        </tr>
    )
}

function Proof() {
    const { state, key, copy } = useCopy()
    const onCopy = (t: ProofTx, el: HTMLElement | null) => copy(t.hash, el, t.hash)
    return (
        <section id="proof" className="band-ink on-ink" aria-labelledby="proof-title">
            <div className="wrap">
                <div className="proof-head">
                    <h2 id="proof-title">Verified on Monad Testnet</h2>
                    {PROOF_TXS.length > 0 ? (
                        <p className="lead">
                            Real payments with test USDC, made with the contracts below. Open any of them on the
                            explorer and check who sent it.
                        </p>
                    ) : (
                        <p className="lead">
                            Every payment is a public transaction on Monad Testnet, with test USDC. Open the{" "}
                            <Ext href={addressUrl(POOL_ADDRESS)} hint="privacy pool on the Monad explorer">
                                privacy pool
                            </Ext>{" "}
                            on the explorer: each private payment is sent by the restaurant's relayer, never by the
                            guest's wallet.
                        </p>
                    )}
                </div>

                {PROOF_TXS.length > 0 && (
                    <>
                        {/* Explicit roles keep rows and cells announced when the stacked layout below 1024 sets display: block. */}
                        <table className="proof" role="table">
                            <caption>
                                Every private payment comes from the relayer, so the chain shows the relayer, never the guest's
                                wallet.
                            </caption>
                            <thead role="rowgroup">
                                <tr role="row">
                                    <th scope="col" role="columnheader">
                                        Payment
                                    </th>
                                    <th scope="col" role="columnheader">
                                        Transaction
                                    </th>
                                    <th scope="col" role="columnheader">
                                        Sent by
                                    </th>
                                    <th scope="col" role="columnheader">
                                        Sent to
                                    </th>
                                </tr>
                            </thead>
                            <tbody role="rowgroup">
                                {PROOF_TXS.map((t) => (
                                    <ProofRow key={t.hash} t={t} onCopy={onCopy} copied={state === "copied" && key === t.hash} />
                                ))}
                            </tbody>
                        </table>
                        <p className="sr-only" role="status">
                            {state === "copied" ? "Hash copied" : state === "manual" ? "Press Ctrl+C to copy" : ""}
                        </p>
                    </>
                )}

                <h3 className="contracts-title">Contracts on chain {CHAIN_ID}</h3>
                <dl className="contracts">
                    {CONTRACTS.map((c) => (
                        <div key={c.address}>
                            <dt>{c.name}</dt>
                            <dd>
                                <Addr value={c.address} hint={`${c.name} on the Monad explorer`} />
                            </dd>
                        </div>
                    ))}
                </dl>

                <p className="fine">Unaudited testnet software with test USDC. Don't use it with real money.</p>
            </div>
        </section>
    )
}

export function LandingPage() {
    const meta = PAGE_META["/"]
    return (
        <>
            <title>{meta.title}</title>
            <meta name="description" content={meta.description} />

            <section className="hero" aria-labelledby="hero-title">
                <div className="wrap">
                    <div className="hero-copy">
                        <h1 id="hero-title">Split the bill with friends. Pay restaurants privately.</h1>
                        <div className="hero-side">
                            <p className="lead">
                                FairPay splits any bill and tracks who has paid, checking every payment on Monad. At FairEats
                                restaurants, guests order from the table, split the bill and can pay without linking their
                                wallet.
                            </p>
                            <div className="cta-row">
                                <a className="btn-primary" href={APP_URL}>
                                    Open FairPay
                                </a>
                                <Link className="btn-secondary" to="/guide/start">
                                    Get started
                                </Link>
                            </div>
                            <p className="disclosure">
                                The app runs on a free server, so the first visit can take about 50 seconds to wake it up.
                            </p>
                        </div>
                    </div>
                    <ul className="trust" aria-label="Before you start">
                        <li>
                            <SignGlyph className="glyph trust-glyph" />
                            <p>
                                <strong>No account or email.</strong> You sign in with a wallet signature. It costs nothing
                                and sends no transaction.
                            </p>
                        </li>
                        <li>
                            <CheckGlyph className="glyph trust-glyph is-verified" />
                            <p>
                                <strong>Checked on-chain.</strong> A share counts as paid only once FairPay finds the payment
                                on Monad. Public payments link to their transaction on the explorer.
                            </p>
                        </li>
                        <li>
                            <AlertGlyph className="glyph trust-glyph is-warn" />
                            <p>
                                <strong>Testnet and unaudited.</strong> Test USDC only, with no value. Never send real funds
                                to a FairPay wallet or contract.
                            </p>
                        </li>
                        <li>
                            <InfoGlyph className="glyph trust-glyph" />
                            <p>
                                <strong>Independent project.</strong> Built on Monad, not made or endorsed by the Monad
                                Foundation. <Link to="/about">About FairPay</Link>
                            </p>
                        </li>
                    </ul>
                    <div className="hero-stage">
                        <BrowserShot
                            name="bill"
                            path="/bills/…"
                            eager
                            alt="The FairPay app on a desktop: a bill called Goa villa, 3 nights, for 480 USDC. Three of five people have paid or are covered. The people list shows Priya as organiser, Meera and Kabir as covered, and Arjun and Sana still owing 96 USDC each. A side panel has the share link with a Copy link button, Remind unpaid and Cancel bill."
                        />
                        <PhoneShot
                            name="home"
                            eager
                            className="hero-phone"
                            sizes="(min-width: 1024px) 248px, (min-width: 640px) 22vw, 240px"
                            alt="The FairPay app on a phone: Hi, Priya. You owe 12 USDC on one bill, and seven shares are waiting on others across three bills. Recent bills list Cab to the airport with a Pay button, then Concert tickets with Remind and Cancel."
                        />
                    </div>
                    <p className="hero-demo-link">
                        No wallet handy? <a href={DEMO_TABLE_URL}>Try the simulated table demo</a>. It runs in your browser
                        and moves no money.
                    </p>
                </div>
            </section>

            <section className="section points-sec" aria-label="What FairPay does">
                <div className="wrap">
                    <ul className="points">
                        {POINTS.map((p) => (
                            <li key={p.title}>
                                <h2>{p.title}</h2>
                                <p>{p.body}</p>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>

            <section id="product" className="section section-rule" aria-labelledby="product-title">
                <div className="wrap">
                    <div className="sec-head sec-head-wide">
                        <h2 id="product-title">Split any bill with friends</h2>
                        <p className="lead">
                            A trip, a dinner, the rent. Create a bill, send one link, and watch the shares come in.
                        </p>
                    </div>
                    <div className="feature">
                        <ol className="steps-list">
                            {BILL_STEPS.map((s) => (
                                <li key={s.title}>
                                    <h3>{s.title}</h3>
                                    <p>{s.body}</p>
                                </li>
                            ))}
                        </ol>
                        <div className="feature-visual">
                            <BrowserShot
                                name="new-bill"
                                path="/bills/new"
                                sizes="(min-width: 1264px) 690px, (min-width: 1024px) 56vw, calc(100vw - 32px)"
                                alt="The New bill form: Weekend groceries, 72.60 USDC, split evenly. Kabir, Sana and Meera are added by name with Already paid switches. The Each share panel shows 18.15 USDC per person and 54.45 USDC still to collect, above a Create bill and get link button."
                            />
                            <PhoneShot
                                name="bill"
                                className="feature-phone"
                                sizes="(min-width: 1024px) 200px, (min-width: 640px) 22vw, 200px"
                                alt="A bill on a phone: the people list with Priya as organiser, Arjun and Sana with seats not claimed yet and owing 96 USDC, and Meera and Kabir covered."
                            />
                        </div>
                    </div>
                    <div className="splits">
                        <h3>Four ways to split</h3>
                        <dl>
                            {SPLITS.map(([k, v]) => (
                                <div key={k}>
                                    <dt>{k}</dt>
                                    <dd>{v}</dd>
                                </div>
                            ))}
                        </dl>
                        <p className="splits-note">
                            <strong>One person paid?</strong> At a restaurant, one guest can pay the whole bill and then
                            split it with friends from the order page. The others settle up with them through FairPay.
                        </p>
                    </div>
                </div>
            </section>

            <section id="faireats" className="section section-rule" aria-labelledby="faireats-title">
                <div className="wrap">
                    <div className="sec-head sec-head-wide">
                        <h2 id="faireats-title">FairEats: order at the table, split, pay</h2>
                        <p className="lead">
                            FairEats is the restaurant platform inside FairPay, under Business. Restaurants list their menu
                            and tables; guests order from their phones and each pays their own share.
                        </p>
                    </div>

                    <div className="duo">
                        <article className="duo-item" aria-labelledby="guests-title">
                            <BrowserShot
                                name="order"
                                path="/o/…"
                                sizes="(min-width: 1264px) 588px, (min-width: 1024px) 48vw, calc(100vw - 32px)"
                                className="duo-desk"
                                alt="A FairEats order at Saffron Table: Table 5, three guests, split three ways, awaiting payment. An order link for the table with Copy link, then three shares, Arjun 20 USDC, Priya 19.99 USDC and Meera 24.99 USDC, each with its own Pay button. On the right, what each guest ordered with CGST and SGST and a 64.98 USDC total."
                            />
                            <PhoneShot
                                name="order"
                                className="duo-phone"
                                sizes="240px"
                                alt="A FairEats order on a phone: Table 5, three guests, split three ways. Three shares left to pay; the kitchen starts when every share is paid. A status timeline from awaiting payment to served, and an expected wait of about 37 minutes."
                            />
                            <h3 id="guests-title">For guests</h3>
                            <ol className="ticks">
                                {GUESTS.map((g) => (
                                    <li key={g}>{g}</li>
                                ))}
                            </ol>
                        </article>
                        <article className="duo-item" aria-labelledby="rest-title">
                            <BrowserShot
                                name="kitchen"
                                path="/business/faireats/manage/…"
                                sizes="(min-width: 1264px) 588px, (min-width: 1024px) 48vw, calc(100vw - 32px)"
                                className="duo-desk"
                                alt="The restaurant dashboard for Saffron Table on the Kitchen tab: columns Paid, Cooking, Ready and Served. Table 7 waits with a Start cooking button; tables 3 and 10 are cooking with Mark ready buttons and chef Asha Rao."
                            />
                            <PhoneShot
                                name="kitchen"
                                className="duo-phone"
                                sizes="240px"
                                alt="The Saffron Table dashboard on a phone, Kitchen tab: the Paid column holds table 7, four guests, with Onion pakora, Miso ramen, Lemon risotto and Masala chai and a Start cooking button."
                            />
                            <h3 id="rest-title">For restaurants</h3>
                            <ol className="ticks">
                                {RESTAURANTS.map((g) => (
                                    <li key={g}>{g}</li>
                                ))}
                            </ol>
                        </article>
                    </div>

                    <div className="invoice-row">
                        <div className="invoice-copy">
                            <h3>GST invoices, ready to share</h3>
                            <p>
                                When a bill is fully paid, FairEats numbers and issues the invoice. With a GSTIN it is a Tax
                                Invoice with CGST and SGST (or IGST), place of supply, SAC codes and the amount in words;
                                without one it is a Bill of Supply. Each invoice has its own link and prints cleanly.
                            </p>
                            <p className="fine">
                                Amounts are in test USDC. Saffron Table is a demo restaurant with a demo GSTIN.
                            </p>
                        </div>
                        <div className="invoice-visual">
                            <PhoneShot
                                name="storefront"
                                sizes="(min-width: 640px) 220px, 42vw"
                                alt="The Saffron Table storefront on a phone: the guest switch reads Adding for Guest 1, above an Onion pakora card with a photo, 4.76 USDC, a veg mark, spice level, 10 minutes and an Add for Guest 1 button."
                            />
                            <PhoneShot
                                name="invoice"
                                sizes="(min-width: 640px) 220px, 42vw"
                                alt="A GST tax invoice on a phone: Saffron Table, Indiranagar, Bengaluru, Karnataka, state code 29, with GSTIN and FSSAI numbers, invoice number ST/2026-27/000002, place of supply Karnataka, table 7, and the items with SAC codes, quantities and rates."
                            />
                        </div>
                    </div>
                    <p className="sec-link">
                        <Link to="/guide/start#faireats">Set up a restaurant on FairEats</Link>
                    </p>
                </div>
            </section>

            <section id="privacy" className="section section-rule" aria-labelledby="privacy-title">
                <div className="wrap split">
                    <div className="split-head">
                        <h2 id="privacy-title">Private payments, explained simply</h2>
                        <p className="lead">
                            Private (the app calls it Confidential) doesn't mean invisible. It means the chain can't connect
                            your wallet to this payment.
                        </p>
                        <p className="split-note">
                            It works when you pay a verified business, such as a FairEats restaurant whose payout wallet is
                            on the pool's allowlist. Bills between friends are paid publicly.
                        </p>
                    </div>
                    <div className="split-body">
                        <PrivacyFlow />
                        <div className="table-scroll compare-wrap">
                            {/* Explicit roles keep rows and cells announced when the stacked layout below 640 sets display: block. */}
                            <table className="compare" role="table">
                                <caption className="sr-only">What a public and a private payment record on-chain</caption>
                                <thead role="rowgroup">
                                    <tr role="row">
                                        <th scope="col" role="columnheader">
                                            <span className="sr-only">What is recorded</span>
                                        </th>
                                        <th scope="col" role="columnheader">
                                            Public payment
                                        </th>
                                        <th scope="col" role="columnheader" className="col-private">
                                            <LockGlyph /> Private payment
                                        </th>
                                    </tr>
                                </thead>
                                <tbody role="rowgroup">
                                    {COMPARE.map(([what, pub, priv]) => (
                                        <tr key={what} role="row">
                                            <th scope="row" role="rowheader">
                                                {what}
                                            </th>
                                            <td role="cell" data-label="Public">
                                                {pub}
                                            </td>
                                            <td role="cell" data-label="Private" className="col-private">
                                                {priv}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="callout privacy">
                            <LockGlyph />
                            <p>
                                Privacy here is from the public chain. FairPay's server still sees your connection (for
                                example your IP address), and a small pool means a small crowd to hide in. Add notes well
                                before you pay.
                            </p>
                        </div>
                        <p className="sec-link">
                            <Link to="/guide/how-it-works#private-payments">How private payments work</Link>
                        </p>
                    </div>
                </div>
            </section>

            <Proof />

            <section id="limits" className="section" aria-labelledby="not-title">
                <div className="wrap split">
                    <div className="split-head">
                        <h2 id="not-title">What to know before you try it</h2>
                        <p className="sec-link">
                            <Link to="/guide/security">Security and limitations in full</Link>
                        </p>
                    </div>
                    <dl className="split-body limits">
                        {LIMITS.map(([head, body]) => (
                            <div key={head}>
                                <dt>{head}</dt>
                                <dd>{body}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </section>

            <section id="developers" className="section section-rule" aria-labelledby="dev-title">
                <div className="wrap split split-5">
                    <div className="split-head">
                        <h2 id="dev-title">Build it into your own checkout</h2>
                        <p className="lead">
                            <code>@fairpay/sdk</code> does the payment and the check. Your backend creates a reference, the
                            browser pays, and your backend verifies against the chain before it releases anything.
                        </p>
                        <ul className="facts">
                            <li>Public and private payments emit the same event, so you verify both the same way.</li>
                            <li>Approvals are for the exact amount, never unlimited.</li>
                            <li>The relayer can refuse to send a payment, but it cannot redirect one.</li>
                        </ul>
                        <p className="sec-link">
                            <Link to="/guide/sdk">Read the integration guide</Link>
                        </p>
                    </div>
                    <div className="split-body">
                        <CodeBlock label="Backend · TypeScript" code={VERIFY_SNIPPET} />
                    </div>
                </div>
            </section>

            <section className="final" aria-labelledby="final-title">
                <div className="wrap final-grid">
                    <TableArt seats={["public", "private", "public", "public"]} table={4} ready className="table-art final-table" />
                    <div className="final-copy">
                        <h2 id="final-title">Split your next bill on FairPay.</h2>
                        <p className="lead">
                            Sign in with a browser wallet or the built-in test wallet, get test USDC from the faucet, and
                            create a bill. It's free, and nothing on testnet has value.
                        </p>
                        <div className="cta-row">
                            <a className="btn-primary" href={APP_URL}>
                                Open FairPay
                            </a>
                            <Link className="btn-secondary" to="/guide/start">
                                Read the getting-started guide
                            </Link>
                        </div>
                    </div>
                </div>
            </section>
        </>
    )
}
