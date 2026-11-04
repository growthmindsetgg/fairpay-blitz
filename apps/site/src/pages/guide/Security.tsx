import { Callout, Section } from "../../components/Prose"

export default function Security() {
    return (
        <>
            <p className="lead g-lead">
                FairPay is a testnet prototype. The contracts, the SDK and the app are unaudited. Here's what the privacy
                covers and what it doesn't.
            </p>
            <Callout kind="careful">
                do not hold meaningful funds in the pool. Everything in this project runs on Monad Testnet with a test token
                anyone can mint.
            </Callout>

            <Section id="guarantees" title="What the design guarantees">
                <p>Each of these is enforced in code and covered by a test or review.</p>
                <ul>
                    <li>
                        <strong>A note is spent once.</strong> The pool records a one-time nullifier per note.
                    </li>
                    <li>
                        <strong>A payment cannot be redirected.</strong> The proof is bound to the merchant and the order
                        reference. Someone who copies a proof still pays the same merchant for the same order.
                    </li>
                    <li>
                        <strong>Proofs don't work on another chain or pool.</strong> The proof scope includes the chain id,
                        pool address and note size.
                    </li>
                    <li>
                        <strong>The owner cannot take pooled funds.</strong> There is no withdraw function.
                    </li>
                    <li>
                        <strong>The merchant trusts only the chain.</strong> Verification checks the receipt, contract,
                        chain, reference, merchant, amount, payer and that the block is canonical.
                    </li>
                    <li>
                        <strong>One payment settles one share.</strong> The server stores each payment under a unique key
                        and settles one share at a time.
                    </li>
                    <li>
                        <strong>The browser's view of the pool is checked.</strong> A rebuilt tree must match a root the pool
                        has recorded.
                    </li>
                </ul>
            </Section>

            <Section id="trust" title="Who you trust, and for what">
                <ul>
                    <li>
                        <strong>The contract owner</strong> can pause the contracts, change the deposit cap and the merchant
                        list, and give up ownership. Because there is no withdraw path, pausing can freeze deposits. The
                        owner cannot move funds.
                    </li>
                    <li>
                        <strong>The relayer</strong> can refuse to send your payment. It cannot steal or redirect it.
                    </li>
                    <li>
                        <strong>FairPay's server</strong> runs the relayer and the deposit list, and decides when a share
                        is paid. It cannot spend your notes, but it sees connection metadata.
                    </li>
                    <li>
                        <strong>The RPC provider</strong> is trusted to be available, not honest. It sees your IP address and
                        every request.
                    </li>
                    <li>
                        <strong>Semaphore</strong> v4.14.5 circuits and verifier (audited upstream), with one Monad-specific
                        change to how gas is forwarded to precompiles. Proof files are fetched from{" "}
                        <code>snark-artifacts<wbr />.pse<wbr />.dev</code> at runtime; a production setup should self-host and pin them.
                    </li>
                </ul>
            </Section>

            <Section id="limitations" title="Known limitations" toTop>
                <ul>
                    <li>
                        <strong>Small crowd.</strong> A private payment hides you only among the deposits in the tree your
                        proof used. On a demo pool that can be a handful of people.
                    </li>
                    <li>
                        <strong>The server can shrink the crowd further</strong> by serving different browsers
                        different-length deposit lists and watching which tree a payment uses.
                    </li>
                    <li>
                        <strong>Timing and amount.</strong> Topping up right before paying, or paying a 15 USDC share with
                        three notes back to back, can link them.
                    </li>
                    <li>
                        <strong>Network metadata.</strong> FairPay's server sees your IP on every request, including faucet
                        and relay requests; the RPC provider sees it on deposits.
                    </li>
                    <li>
                        <strong>Notes live in browser storage.</strong> Clearing site data without a backup loses them.
                        Extensions or scripts on the page could read them.
                    </li>
                    <li>
                        <strong>The built-in test wallet keeps its key in browser storage.</strong> Testnet only.
                    </li>
                    <li>
                        <strong>Fixed 5 USDC notes,</strong> no change.
                    </li>
                    <li>
                        <strong>No exit path.</strong> Notes can only pay allowlisted merchants, and deposits can be frozen by
                        the owner.
                    </li>
                    <li>
                        <strong>Few confirmations.</strong> The FairPay app waits for 2 by default (<code>PAYMENT_CONFIRMATIONS</code>).
                        Raise it for anything of value.
                    </li>
                    <li>
                        <strong>One server process.</strong> Rate limits and locks are in memory.
                    </li>
                </ul>
            </Section>

            <Section id="before-mainnet" title="Before anything like mainnet">
                <p>
                    An independent audit; owner keys in a Safe; self-hosted, hash-pinned proving files; a monitored,
                    rate-limited relayer; no demo wallet or faucet; a confirmation depth that matches Monad's finality; legal
                    review of running a privacy pool where you operate.
                </p>
            </Section>

            <Section id="about-the-demo" title="About the demo on this site">
                <p>
                    The demo at <code>/app/</code> simulates the original FairEats server and the chain in your browser. It is
                    not the FairPay app. It holds no keys and builds no proofs, and the site's Content-Security-Policy only
                    allows it to load files from this site. Simulated receipts are labelled "simulated". The only explorer links
                    they show go to a real example transaction, and those links are labelled as such.
                </p>
            </Section>

            <Section id="reporting" title="Reporting">
                <p>Report vulnerabilities privately to the maintainers, not in a public issue.</p>
            </Section>
        </>
    )
}
