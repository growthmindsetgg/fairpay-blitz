import { Link } from "react-router-dom"
import { CodeBlock } from "../../components/CodeBlock"
import { Callout, Section, YouNeed } from "../../components/Prose"

const API: [string, string, string][] = [
    ["randomSecret(), createOrderRef({ orderId, participantId, secret })", "backend", "Make a share reference."],
    ["payPublic(deployment, clients, { merchant, amount, orderRef })", "browser", "Approve the exact amount, then FairPay.directPay."],
    ["createNote(deployment), serializeNote(note), parseNote(text)", "browser", "Create and store notes."],
    ["depositNote(deployment, clients, note)", "browser", "Deposit one denomination against a note."],
    ["isNoteSpent(deployment, publicClient, note)", "browser", "Whether the note's nullifier is used."],
    ["fetchGroup(deployment, publicClient, options?)", "browser", "Rebuild the tree from Deposit logs; checked against the on-chain root."],
    [
        "groupFromCommitments(deployment, publicClient, commitments)",
        "browser",
        "Rebuild the tree from an indexer's list; checked against knownRoots."
    ],
    ["createPrivatePayment(deployment, publicClient, { note, merchant, orderRef, group? })", "browser", "Build the proof."],
    ["submitToRelayer(url, request)", "browser", "POST the proof to your relayer."],
    [
        "createRelayer(deployment, clients).handle(body)",
        "backend",
        "Validate, simulate and submit a private payment. Import from @fairpay/sdk/relayer."
    ],
    ["verifyPaymentTx(deployment, publicClient, params)", "backend", "Verify one payment transaction."],
    ["findPayments(deployment, publicClient, { orderRef, merchant?, fromBlock })", "backend", "Find payments for a reference by scanning logs."],
    ["paymentMessage(merchant, orderRef)", "either", "The proof message, keccak256(merchant, orderRef) as a field element."]
]

const ERRORS = ["WRONG_CHAIN", "INVALID_INPUT", "NO_POOL", "GROUP_MISMATCH", "NOTE_NOT_FOUND", "NOTE_SPENT", "NOT_MERCHANT", "RELAYER_REJECTED", "RELAYER_TIMEOUT", "RELAYER_BUSY", "RELAYER_UNFUNDED"]

export default function Sdk() {
    return (
        <>
            <p className="lead g-lead">
                <code>@fairpay/sdk</code> gives you public and private payments plus merchant-side verification. These
                examples come from the SDK's README. Use the addresses from <Link to="/#proof">Contract addresses</Link> for
                Monad Testnet.
            </p>

            <YouNeed>
                <ul>
                    <li>
                        The packed <code>@fairpay/sdk</code> tarball, until it is on npm, and <code>viem</code>.
                    </li>
                    <li>
                        The FairPay contract addresses for Monad Testnet, listed under{" "}
                        <Link to="/#proof">Contract addresses</Link>.
                    </li>
                </ul>
            </YouNeed>

            <Section id="install" title="Install">
                <p>Until it is on npm, install the packed tarball.</p>
                <CodeBlock
                    label="bash"
                    code={`cd packages/sdk && npm run build && npm pack
npm install /path/to/fairpay-sdk-0.1.0.tgz viem`}
                />
            </Section>

            <Section id="clients" title="Set up clients">
                <CodeBlock
                    label="TypeScript"
                    code={`import {
  createPublicClient, createWalletClient, custom, http,
} from "viem"
import { monadTestnet } from "viem/chains"
import * as fairpay from "@fairpay/sdk"

const deployment: fairpay.FairPayDeployment = {
  chainId: 10143,
  token: "0x…",        // USDC (or MockUSDC on testnet)
  fairPay: "0x…",
  pool: "0x…",
  poolDeployBlock: 0n  // block the pool was deployed in
}
const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
})
const walletClient = createWalletClient({
  chain: monadTestnet,
  transport: custom(window.ethereum),
  account,
})
const clients = { publicClient, walletClient }`}
                />
                <p>
                    Every function that touches the chain checks the chain id first and throws <code>WRONG_CHAIN</code>{" "}
                    otherwise.
                </p>
            </Section>

            <Section id="create-reference" title="1. Backend: create the share reference">
                <CodeBlock
                    label="TypeScript · backend"
                    code={`const secret = fairpay.randomSecret() // store with the participant row
const orderRef = fairpay.createOrderRef({
  orderId: "FE-001",
  participantId: "p2",
  secret,
})`}
                />
            </Section>

            <Section id="pay-publicly" title="2a. Browser: pay publicly">
                <CodeBlock
                    label="TypeScript · browser"
                    code={`const { txHash } = await fairpay.payPublic(deployment, clients, {
  merchant,
  amount: 12_500_000n,
  orderRef,
})
// send txHash to your backend for verification`}
                />
                <p>
                    <code>payPublic</code> approves only the exact amount, never an unlimited allowance.
                </p>
            </Section>

            <Section id="pay-privately" title="2b. Browser: pay privately">
                <CodeBlock
                    label="TypeScript · browser"
                    code={`// Ahead of time (the further ahead, the better the privacy):
// top up the private balance.
const note = fairpay.createNote(deployment)
// store BEFORE depositing
localStorage.setItem("note", fairpay.serializeNote(note))
await fairpay.depositNote(deployment, clients, note)

// At checkout: prove and hand the payment to the relayer.
// Takes a few seconds.
const request = await fairpay.createPrivatePayment(
  deployment,
  publicClient,
  { note, merchant, orderRef },
)
const { txHash } = await fairpay.submitToRelayer("/api/relay", request)`}
                />
                <Callout kind="privacy">
                    a share must be a multiple of the note size. Paying a larger share with several notes sent together can
                    link them. <code>localStorage</code> is only an example: anything that can read that storage can spend
                    the notes. Offer users a backup.
                </Callout>
            </Section>

            <Section id="relayer-route" title="3. Backend: the relayer route">
                <CodeBlock
                    label="TypeScript · backend"
                    code={`import { createRelayer } from "@fairpay/sdk/relayer"

const relayer = createRelayer(deployment, {
  publicClient,
  walletClient: relayerWallet,
})

export async function POST(req: Request) {
  try {
    return Response.json(await relayer.handle(await req.json()))
  } catch (e) {
    console.error(e)
    return Response.json(
      { error: "payment could not be submitted" },
      { status: 400 },
    )
  }
}`}
                />
                <p>
                    Put rate limiting and your own checks in front of it (is this an open order of yours, does it still owe
                    money?). The relayer pays gas for every request it sends. Map errors to fixed messages: raw errors can
                    contain your RPC URL and the relayer's balance. <code>apps/<wbr />faireats/<wbr />server/<wbr />app.ts</code> is a complete
                    example.
                </p>
            </Section>

            <Section id="verify" title="4. Backend: verify before releasing the order">
                <CodeBlock
                    label="TypeScript · backend"
                    code={`const result = await fairpay.verifyPaymentTx(
  deployment,
  publicClient,
  {
    txHash, orderRef, merchant,
    amount: share.amount,
    expectedPayer: share.wallet, // checked for public payments only
    minConfirmations: 2n,        // default 1
  },
)
if (result.status === "verified") {
  // INSERT with UNIQUE (chain_id, tx_hash, log_index)
  // so one payment can never settle two shares
  await db.payments.insert({ ...result.payment, shareId })
}`}
                />
                <p>
                    <code>result.status</code> is <code>verified</code>, <code>pending</code> or <code>rejected</code> (with a{" "}
                    <code>reason</code>). Never mark a share paid from a client-side "success" message.
                </p>
            </Section>

            <Section id="api" title="API at a glance">
                <div className="table-scroll" tabIndex={0} role="region" aria-label="SDK functions, scrolls sideways">
                    {/* Explicit roles keep rows and cells announced when phones stack the rows (display: block). */}
                    <table className="g-table api" role="table">
                        <caption className="sr-only">SDK functions</caption>
                        <thead role="rowgroup">
                            <tr role="row">
                                <th scope="col" role="columnheader">
                                    Function
                                </th>
                                <th scope="col" role="columnheader">
                                    Side
                                </th>
                                <th scope="col" role="columnheader">
                                    What it does
                                </th>
                            </tr>
                        </thead>
                        <tbody role="rowgroup">
                            {API.map(([fn, side, what]) => (
                                <tr key={fn} role="row">
                                    <td role="cell">
                                        <code>{fn}</code>
                                    </td>
                                    <td role="cell" data-label="Side">
                                        {side}
                                    </td>
                                    <td role="cell">{what}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Section>

            <Section id="errors" title="Errors">
                <p>
                    SDK errors are <code>FairPayError</code> with a <code>code</code>:{" "}
                    {ERRORS.map((e, i) => (
                        <span key={e}>
                            <code>{e}</code>
                            {i < ERRORS.length - 1 ? ", " : "."}
                        </span>
                    ))}
                </p>
            </Section>
        </>
    )
}
