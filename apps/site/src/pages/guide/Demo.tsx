import { Link } from "react-router-dom"
import { Callout } from "../../components/Prose"
import { APP_URL, DEMO_URL } from "../../data"

export default function Demo() {
    return (
        <>
            <p className="lead g-lead">
                You'll order for a table of three, pay one share publicly and one privately, then watch the kitchen start.
                Everything is simulated in your browser: no wallet, no tokens, and no calls to a blockchain, relayer or
                server.
            </p>
            <Callout kind="careful">
                this is a simulation of the original single-restaurant FairEats app, not the FairPay app. To split real
                bills and pay with test USDC on Monad Testnet, <a href={APP_URL}>open FairPay</a> and follow{" "}
                <Link to="/guide/start">Get started with the app</Link>.
            </Callout>
            <ol className="steps">
                <li>
                    <strong>Open the demo.</strong> Go to <a href={DEMO_URL}>/app/</a>. The bar at the top says "Simulated
                    demo" and links to the real app. It stays on every screen.
                </li>
                <li>
                    <strong>Set the table.</strong> In "Your table", choose table 4 and press <kbd>+</kbd> until it shows 3
                    guests.
                </li>
                <li>
                    <strong>Order for each guest.</strong> With "Guest 1" selected, add Saffron biryani. Select "Guest 2"
                    and add Burrata &amp; peaches. Select "Guest 3" and add Lemon risotto. On a phone, the guest switch
                    stays at the top of the menu while you scroll.
                </li>
                <li>
                    <strong>Place the order.</strong> Press <b>Place order</b>. You land on the table page with three share
                    cards: 15, 10 and 20 USDC.
                </li>
                <li>
                    <strong>Pay guest 1 publicly.</strong> On Guest 1's card press <b>Pay 15.00 USDC publicly</b>. The demo
                    wallet already has 50 test USDC. Watch the steps: confirm in wallet, send, verify.
                </li>
                <li>
                    <strong>Pay guest 2 privately.</strong> On Guest 2's card, inside the violet "Pay privately" box, press{" "}
                    <b>Pay 10.00 USDC privately</b>. The demo wallet already holds two 5 USDC notes. Watch the four steps:
                    check notes, build proof, relayer sends, verified. In the demo no proof is built; the steps are timed to
                    show the order of events.
                </li>
                <li>
                    <strong>Look at the table.</strong> Seat 1 is green with a check. Seat 2 is violet with a lock. Open
                    "Simulated receipt" on Guest 2's card: the sender is the relayer, and the payer is the pool.
                </li>
                <li>
                    <strong>Pay guest 3</strong> either way.
                </li>
                <li>
                    <strong>Open the kitchen.</strong> Press <b>Open the kitchen screen</b>. If asked for a PIN, enter{" "}
                    <code>demo-kitchen</code> (shown in the demo bar) and press <b>Open the kitchen screen</b>. Table 4's
                    ticket reads "All 3 shares verified (simulated)". Press <b>Start cooking table 4</b>.
                </li>
                <li>
                    <strong>Serve it.</strong> In the demo the cook timer is shortened to 20 seconds. When it ends, press{" "}
                    <b>Mark table 4 served</b>. You have 5 seconds to undo.
                </li>
            </ol>
            <Callout kind="check">the table page now says "Served. Enjoy." and every seat is filled.</Callout>
            <p>
                To start again, press <b>Reset demo</b> in the demo bar. It clears the simulated orders, wallet and notes
                from this browser.
            </p>
            <p>
                To start with more guests, add <code>?guests=</code> to the link: <a href={`${DEMO_URL}?guests=3`}>/app/?guests=3</a>{" "}
                opens the menu with three guests at the table. Any number from 1 to 8 works.
            </p>
            <p>
                <a className="btn-primary" href={DEMO_URL}>
                    Open the simulated demo
                </a>
            </p>
        </>
    )
}
