import { Link } from "react-router-dom"
import { Callout, H3, Section } from "../../components/Prose"
import { APP_URL } from "../../data"

export default function Start() {
    return (
        <>
            <p className="lead g-lead">
                FairPay is a bill-splitting app with optional private payments, and FairEats is its restaurant platform.
                This page takes you from your first sign-in to a paid bill, then shows how a restaurant sets up. It all runs
                on Monad Testnet with test USDC, so nothing you do here costs real money.
            </p>
            <Callout kind="careful">
                the app's server runs on a free plan that sleeps when nobody uses it. If it is asleep, the app shows
                "Starting the server…" for up to a minute while it wakes up. After that it is quick.
            </Callout>
            <p>
                <a className="btn-primary" href={APP_URL}>
                    Open FairPay
                </a>
            </p>

            <Section id="sign-in" title="1. Sign in">
                <p>
                    Press <b>Sign in with a wallet</b> on the home page, or <b>Sign in</b> at the bottom of the sidebar (on a
                    phone, at the top right). Then pick one:
                </p>
                <ul>
                    <li>
                        <strong>A browser wallet</strong> such as MetaMask or Rabby. FairPay finds installed wallets and
                        offers to switch them to Monad Testnet.
                    </li>
                    <li>
                        <strong>Test wallet in this browser.</strong> FairPay makes a new key and keeps it in this browser's
                        storage. It is for testnet only: never send real funds to it, and it is gone if you clear the
                        browser's site data.
                    </li>
                </ul>
                <p>
                    Your wallet signs a sign-in message (Sign-In with Ethereum). Signing creates a session; it never moves
                    funds. The first time, FairPay asks for a display name so people on your bills see a name instead of an
                    address. You can change it later on <b>Profile</b>.
                </p>
            </Section>

            <Section id="test-usdc" title="2. Get test USDC">
                <p>
                    Open the account menu (your name in the sidebar, or your initial at the top right on a phone) and press{" "}
                    <b>Get test USDC</b>. The same button is on <b>Profile</b>. The faucet sends 50
                    test USDC and a little testnet MON for gas. It is rate-limited, so ask once and wait a moment.
                </p>
                <p>
                    Test USDC is a mock token that anyone can mint, and testnet MON has no value. If the faucet is off on
                    the server, the menu doesn't show the button; use a public Monad Testnet faucet for MON instead.
                </p>
            </Section>

            <Section id="create-bill" title="3. Create a bill">
                <ol className="steps">
                    <li>
                        <strong>Press New bill.</strong> Enter what it was for and the total in USDC. Add a note if you like;
                        everyone on the bill can see it.
                    </li>
                    <li>
                        <strong>Add people.</strong> Pick friends, paste a wallet address, or type just a name. Someone added
                        by name gets a seat they claim from the bill's link when they sign in.
                    </li>
                    <li>
                        <strong>Choose how to split.</strong> <b>Simple</b> splits evenly. <b>Advanced</b> splits by exact
                        amounts, percent or shares. The preview on the right shows every share, and where leftover cents go.
                    </li>
                    <li>
                        <strong>Mark anyone who already paid you</strong> outside FairPay with the <b>Already paid</b> switch.
                        Their share shows as Covered.
                    </li>
                    <li>
                        <strong>Press Create bill and get link.</strong> Copy the link into your group chat. It shows names
                        and amounts, not wallet addresses.
                    </li>
                </ol>
                <Callout kind="check">
                    the bill page lists everyone with their share and status (Owes, Covered, Paid), and a bar shows how much
                    has been collected. As the organiser you also get <b>Remind unpaid</b> and <b>Cancel bill</b>.
                </Callout>
            </Section>

            <Section id="pay" title="4. Pay your share">
                <p>
                    Bills you owe on appear under <b>Requests</b> and on the home page with a <b>Pay</b> button. Pressing it
                    shows the amount, who it goes to, and how you can pay. The app shows each step (check your balance, confirm in your
                    wallet, verify on Monad) and only marks the share Paid once it finds the payment on Monad.
                </p>
                <H3 id="public-or-private">Public or private</H3>
                <ul>
                    <li>
                        <strong>Public</strong> pays from your wallet. Anyone can see on-chain that your wallet paid. Bills
                        between friends are always paid this way.
                    </li>
                    <li>
                        <strong>Confidential</strong> (private) pays through the privacy pool. It hides which wallet paid; it
                        doesn't hide the amount. It works only for verified businesses, such as a FairEats restaurant whose
                        payout wallet is allowlisted.
                    </li>
                </ul>
                <p>
                    Private payments use 5 USDC notes from your private balance. If you don't have enough, the app offers to
                    add them first; adding notes is a public transaction from your wallet, so add them well before you pay.
                    If a share isn't a whole number of notes, the last note pays a little more, the extra goes to the
                    restaurant as a tip, and the app says so before you pay. Back up your notes on <b>Profile</b>: they live
                    in this browser, and whoever has them can spend them.
                </p>
                <p>
                    More on how this works: <Link to="/guide/how-it-works#private-payments">Private payments, explained simply</Link>.
                </p>
            </Section>

            <Section id="faireats" title="5. FairEats for restaurants">
                <p>
                    Open <b>Business</b>, then <b>FairEats</b>, and press <b>Register your restaurant</b>.
                </p>
                <ol className="steps">
                    <li>
                        <strong>Register.</strong> Enter the name, cuisine, address, city and state, and the number of
                        tables and seats. The GSTIN and FSSAI numbers are optional; a GSTIN is checked before it is saved.
                        With a GSTIN, guests get a Tax Invoice with CGST and SGST; without one, a Bill of Supply.
                    </li>
                    <li>
                        <strong>Add the menu</strong> on the <b>Menu</b> tab: dishes with photos, categories, veg and spice
                        marks, prep time and availability.
                    </li>
                    <li>
                        <strong>Set up tables, chefs and staff.</strong> Staff are added by wallet and role, and each role
                        sees only the tabs it can use.
                    </li>
                    <li>
                        <strong>Check Settings:</strong> GST rate, service charge and the payout wallet, which must be the
                        owner's own wallet.
                    </li>
                    <li>
                        <strong>Share the storefront link</strong> from <b>Overview</b>, on a table card or a QR code.
                    </li>
                    <li>
                        <strong>Run the kitchen</strong> from the <b>Kitchen</b> tab: paid orders appear there, and you move
                        them through Start cooking, Ready and Served. It updates every 5 seconds.
                    </li>
                </ol>
                <Callout kind="privacy">
                    guests can pay a restaurant privately only when its payout wallet is on the privacy pool's allowlist. The
                    directory shows a "Private payments" badge on those restaurants. A new restaurant takes public payments
                    until it is added.
                </Callout>
            </Section>

            <Section id="guests" title="6. Order at a table">
                <ol className="steps">
                    <li>
                        <strong>Open the restaurant</strong> from FairEats or its storefront link. The demo restaurant is
                        Saffron Table in Bengaluru.
                    </li>
                    <li>
                        <strong>Add dishes for each guest.</strong> Use the guest switch above the menu, then press{" "}
                        <b>Choose table and payment</b>.
                    </li>
                    <li>
                        <strong>Pick a free table and how to pay:</strong> <b>One person pays the whole bill</b>, or{" "}
                        <b>Everyone pays their own share</b>. With one payer, they can then split it with friends as a
                        FairPay bill.
                    </li>
                    <li>
                        <strong>Place the order</strong> and send the order link to the table, so each person pays from their
                        own phone. Unpaid orders are released after 15 minutes.
                    </li>
                    <li>
                        <strong>Follow it</strong> from paid to cooking, ready and served, then open the GST invoice. It has
                        its own link and a Print button.
                    </li>
                </ol>
                <p>
                    Want to see the whole flow without a wallet first? <Link to="/guide/demo">Try the simulated demo</Link>.
                </p>
            </Section>
        </>
    )
}
