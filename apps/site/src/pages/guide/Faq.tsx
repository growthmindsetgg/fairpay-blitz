import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Section } from "../../components/Prose"
import { Ext } from "../../components/Ext"

const FAQ: [string, ReactNode][] = [
    [
        "Is this real money?",
        "No. The FairPay app runs on Monad Testnet with test USDC that anyone can mint, and the simulated demo on this site moves nothing at all."
    ],
    [
        "Why is the app slow to open?",
        "Its server runs on Render's free plan, which puts it to sleep after a quiet spell. The app then shows “Starting the server…” for up to a minute while it wakes up; after that it is quick."
    ],
    [
        "Can I use my own wallet?",
        "Yes. Sign in with a browser wallet such as MetaMask or Rabby, or use the built-in test wallet, which keeps a new testnet-only key in your browser."
    ],
    [
        "Why can't I pay a friend privately?",
        "The privacy pool only pays allowlisted businesses, such as a verified FairEats restaurant. Bills between friends are paid publicly, and the app says so."
    ],
    [
        "Does the demo talk to a blockchain?",
        <>
            No. The simulated demo at <code>/app/</code> makes no outside requests at all. The{" "}
            <Link to="/#proof">proof section</Link> links to real transactions, and the FairPay app makes real ones on Monad
            Testnet.
        </>
    ],
    [
        "Can the restaurant see who paid privately?",
        "Not from the chain. The payment comes from the pool and is sent by the relayer. FairPay's server can still see connection details such as your IP address, and a small pool is a small crowd."
    ],
    [
        "Why does the kitchen wait for every share?",
        "When everyone pays their own share, the order reaches the kitchen board only after every share is paid and verified on-chain, not when a phone says so."
    ],
    [
        "Why 5 USDC notes?",
        "Identical notes are what make them hard to tell apart. If a share isn't a whole number of notes, the last note pays a little more, the extra goes to the restaurant as a tip, and the app tells you before you pay."
    ],
    ["Why add notes ahead of time?", "Adding notes is public. If you add notes and pay a minute later, the timing links the two."],
    [
        "What happens if I close the tab during a payment?",
        "The app remembers a payment that was sent but not confirmed, and checks it again before letting you pay a second time."
    ],
    [
        "Why doesn't the demo build a real proof?",
        "Building one needs the proving files (several megabytes) and a live pool on-chain. The demo shows the same steps in the same order, with short simulated waits. In the FairPay app, a real proof usually takes a few seconds on a laptop."
    ],
    [
        "Is it audited?",
        <>
            No. See <Link to="/guide/security">Security and limitations</Link>.
        </>
    ],
    [
        "Where is the code?",
        <>
            In the public{" "}
            <Ext href="https://github.com/growthmindsetgg/fairpay-blitz">fairpay-blitz repository on GitHub</Ext> (
            <code>apps/fairpay</code>, <code>packages/contracts</code>, <code>packages/sdk</code>, <code>apps/faireats</code>
            ).
        </>
    ]
]

const GLOSSARY: [string, string][] = [
    ["Anonymity set", "The deposits your private payment could have come from. Bigger is better."],
    ["Bill", "An amount split between people, with one share each and a link to pay it."],
    ["Canonical block", "The block the chain currently agrees on at a given height. Receipts from replaced blocks don't count."],
    ["Confidential", "The app's name for a private payment through the pool."],
    ["Covered", "A share the organiser marked as settled outside FairPay, or their own part of the bill."],
    ["Denomination", "The fixed note size, 5 USDC."],
    ["GSTIN", "An Indian GST registration number. With one, FairEats issues a Tax Invoice; without one, a Bill of Supply."],
    ["Kitchen board", "The restaurant's view of paid orders, from cooking to ready to served."],
    ["MockUSDC", "The testnet token used here. Anyone can mint it. It has no value."],
    ["MON", "Monad's native token, used for gas. Testnet MON has no value."],
    ["Note", "The right to spend one 5 USDC deposit in the pool. Works like cash: whoever has it can spend it."],
    ["Nullifier", "A one-time marker revealed when a note is spent, so it can't be spent again. It doesn't say which note."],
    ["orderRef", "A random-looking 32-byte reference for one share. The only order detail that goes on-chain."],
    ["Pool", "The FairPool contract that holds deposits and accepts private payments."],
    ["Proof", "A short zero-knowledge proof that you own an unspent note in the pool, built in your browser."],
    [
        "Relayer",
        "The service that sends private payments and pays their gas, so your wallet stays out of them. It can refuse, but not redirect."
    ],
    ["Seat", "A place on a bill added by name only. Whoever opens the link and signs in can claim it."],
    ["Share", "One person's part of a bill or an order."],
    ["Testnet", "A practice copy of the Monad network. Nothing on it has value."],
    ["Verified", "FairPay found the payment on-chain and it matched the share."]
]

export default function Faq() {
    return (
        <>
            <Section id="faq" title="FAQ" toTop>
                <div className="faq">
                    {FAQ.map(([q, a]) => (
                        <div key={q} className="faq-item">
                            <h3>{q}</h3>
                            <p>{a}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section id="glossary" title="Glossary">
                <dl className="glossary">
                    {GLOSSARY.map(([term, def]) => (
                        <div key={term}>
                            <dt>{term}</dt>
                            <dd>{def}</dd>
                        </div>
                    ))}
                </dl>
            </Section>
        </>
    )
}
