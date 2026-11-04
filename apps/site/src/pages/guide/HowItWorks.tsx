import { Link } from "react-router-dom"
import { Callout, H3, Section } from "../../components/Prose"
import { Ext } from "../../components/Ext"
import { SequenceDiagram } from "../../components/SequenceDiagram"
import { POOL_ADDRESS, PROOF_TXS, addressUrl, txUrl } from "../../data"

const PRIVATE_TXS = PROOF_TXS.filter((t) => t.kind === "Private")

export default function HowItWorks() {
    return (
        <>
            <Section id="how-a-table-pays" title="How a table pays" toTop>
                <p>
                    This is what happens in the FairPay app when a table at a FairEats restaurant pays, step by step. A bill
                    between friends works the same way, with public payments only. The browser only ever sends the server a
                    transaction hash; every fact the server relies on comes from the chain.
                </p>
                <ol className="steps">
                    <li>
                        <strong>Guests order.</strong> The phone sends dish ids, quantities and which guest each dish is
                        for. The server looks up the prices, adds GST and any service charge, and splits the total by what
                        each guest ordered (or evenly), in whole cents that always add up to the total.
                    </li>
                    <li>
                        <strong>The server makes one share per guest</strong> (or per person on a bill). Each share gets a
                        random secret and a reference: <code>orderRef = keccak256(orderId, shareId, secret)</code>. Only the
                        reference ever goes on-chain. It reveals nothing about the order.
                    </li>
                    <li>
                        <strong>Each guest pays.</strong>
                        <ul>
                            <li>
                                <b>Public:</b> the browser approves the exact amount and calls <code>FairPay.directPay</code>.
                                The guest's wallet is the payer.
                            </li>
                            <li>
                                <b>Private:</b> the browser builds one zero-knowledge proof per 5 USDC note and posts it to
                                the relayer on FairPay's server. The relayer calls <code>FairPool.pay</code>, which pays
                                through <code>FairPay</code>. The pool is the payer.
                            </li>
                        </ul>
                    </li>
                    <li>
                        <strong>The browser sends the transaction hash.</strong> That is all it sends.
                    </li>
                    <li>
                        <strong>The server verifies on-chain.</strong> <code>verifyPaymentTx</code> checks that the
                        transaction succeeded, that exactly one <code>PaymentReceived</code> event from the FairPay contract
                        carries this reference and merchant, that the amount matches, and that the receipt's block is the
                        canonical block at that height. It stores the payment under a unique{" "}
                        <code>(chain id, tx hash, log index)</code>, so one payment can never pay two shares.
                    </li>
                    <li>
                        <strong>The kitchen gets the order</strong> once every share is verified. Staff move it through{" "}
                        <b>Start cooking</b>, <b>Ready</b> and <b>Served</b> on the kitchen board, and the GST invoice is
                        issued. On a bill, the share simply turns Paid.
                    </li>
                </ol>
                <p>
                    If a payment was sent but is not confirmed yet, the app remembers it and checks it again before it lets
                    you pay a second time. This stops double payments after a reload or a dropped connection.
                </p>
                <SequenceDiagram />
            </Section>

            <Section id="private-payments" title="Private payments, explained simply" toTop>
                <p className="lead-s">
                    A private payment proves "one of these notes is mine and unspent" without saying which one. The app
                    calls it a Confidential payment.
                </p>
                <H3 id="everyday-version">An everyday version</H3>
                <p>
                    Think of a jar of identical tokens at the front desk. Earlier, you bought a token and dropped a sealed
                    slip into the jar that only you can match. At the table, you show the waiter a proof that one of the
                    slips in the jar is yours and has not been used, without pulling it out. The waiter knows the bill is
                    paid. They do not know which slip, so they cannot tell when you bought it or from which wallet.
                </p>
                <H3 id="in-fairpay-terms">In FairPay terms</H3>
                <ul>
                    <li>
                        <strong>Adding notes is public.</strong> You deposit 5 USDC into the pool for each note. The chain
                        records your wallet and the deposit. Your browser keeps the note's secret.
                    </li>
                    <li>
                        <strong>Paying is private.</strong> Your browser builds a proof that your note is in the pool and has
                        not been spent. The proof is tied to this restaurant and this share, so nobody can redirect it.
                    </li>
                    <li>
                        <strong>The relayer sends it.</strong> The relayer on FairPay's server pays the gas and submits the
                        proof. Your wallet never touches this transaction.
                    </li>
                    <li>
                        <strong>The pool spends the note once.</strong> Each note has a one-time marker (a nullifier). Using
                        it twice fails.
                    </li>
                    <li>
                        <strong>Only verified businesses.</strong> The pool pays only allowlisted payout wallets, such as a
                        FairEats restaurant's, so bills between friends are paid publicly. If a share isn't a whole number
                        of notes, the last note pays a little more and the extra goes to the restaurant as a tip; the app
                        says so before you pay.
                    </li>
                </ul>
                <Callout kind="privacy">
                    how private a payment is depends on the crowd. You are hidden among the other deposits in the pool when
                    you paid. On a testnet pool that can be a handful of people. Fewer than 10 is a small crowd: timing
                    alone can point to you.
                </Callout>
                <H3 id="habits">Habits that keep it private</H3>
                <ul>
                    <li>
                        <strong>Add notes well before you pay.</strong> Topping up and paying a minute later makes the two
                        easy to link.
                    </li>
                    <li>
                        <strong>Prefer shares of one note when you can.</strong> A 15 USDC share is three notes sent back to
                        back, which can be linked to each other.
                    </li>
                    <li>
                        <strong>Back up your notes</strong> on the Profile page. A note works like cash: whoever has the file
                        can spend it, and losing it loses the deposit.
                    </li>
                </ul>
                <p>
                    <strong>What private does not hide:</strong> the amount, the restaurant, the time, and anything
                    FairPay's server sees about your connection (such as your IP address). The{" "}
                    <Link to="/guide/security">Security and limitations</Link> section has the full list.
                </p>
                <p>
                    See it for real:{" "}
                    {PRIVATE_TXS.length > 0 ? (
                        <>
                            {PRIVATE_TXS.map((t, i) => (
                                <span key={t.hash}>
                                    {i > 0 && ", "}
                                    <Ext href={txUrl(t.hash)} hint={`real private payment ${i + 1}`}>
                                        private payment {i + 1}
                                    </Ext>
                                </span>
                            ))}
                            . In each, the sender is the relayer, not the guest.
                        </>
                    ) : (
                        <>
                            open the{" "}
                            <Ext href={addressUrl(POOL_ADDRESS)} hint="privacy pool on the Monad explorer">
                                privacy pool
                            </Ext>{" "}
                            on the Monad explorer. Every private payment it makes is sent by the relayer, not the guest.
                        </>
                    )}
                </p>
            </Section>
        </>
    )
}
