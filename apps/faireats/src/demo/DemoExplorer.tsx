import { Link, useParams } from "react-router-dom"
import { getAddress, isAddress } from "viem"
import { chain, shortDemoId } from "./chain"
import { DEMO_MERCHANT, DEMO_RELAYER, DEMO_WALLET, REAL } from "./config"
import "./demo.css"

const usdc = (micro: number) => `${(micro / 1_000_000).toFixed(2)} USDC`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-5)}`

function nameOf(address: string) {
    if (!isAddress(address)) return address === "pool" ? "the privacy pool" : address
    const a = getAddress(address)
    if (a === DEMO_WALLET) return `Demo wallet ${short(a)}`
    if (a === DEMO_MERCHANT) return "Saffron Table"
    if (a === DEMO_RELAYER) return "the restaurant's relayer"
    return short(a)
}

const REAL_CONTRACTS: Record<string, string> = {
    [getAddress(REAL.pool)]: "privacy pool",
    [getAddress(REAL.fairPay)]: "FairPay contract",
    [getAddress(REAL.token)]: "test USDC token",
    [getAddress(REAL.verifier)]: "proof verifier"
}

function RealLink() {
    return (
        <p>
            Simulated. In the real app this links to the Monad explorer.{" "}
            <a href={`${REAL.explorer}/address/${REAL.pool}`} target="_blank" rel="noreferrer">
                See the real privacy pool and its payments on Monad Testnet<span className="demo-sr"> (opens in a new tab)</span>
            </a>
        </p>
    )
}

/**
 * Where the app's explorer links lead in the demo. Simulated hashes exist on no chain, so they
 * never link to the real explorer; this page explains what the simulated transaction did.
 */
export function DemoExplorer() {
    const rest = useParams()["*"] ?? ""
    const [kind, id = ""] = rest.split("/")

    if (kind === "address" && isAddress(id)) {
        const a = getAddress(id)
        const real = REAL_CONTRACTS[a]
        if (real)
            return (
                <main className="wrap page demo-explorer" id="main">
                    <h1>Real {real} on Monad Testnet</h1>
                    <p className="mono">{a}</p>
                    <p>This contract is real. The demo does not use it; the real FairEats app does.</p>
                    <p>
                        <a href={`${REAL.explorer}/address/${a}`} target="_blank" rel="noreferrer">
                            Open it on the Monad explorer<span className="demo-sr"> (opens in a new tab)</span>
                        </a>
                    </p>
                    <Link to="/">Back to the menu</Link>
                </main>
            )
        const b = chain.balances(a)
        return (
            <main className="wrap page demo-explorer" id="main">
                <h1>Simulated address</h1>
                <p className="mono">{a}</p>
                <p>
                    {a === DEMO_WALLET
                        ? "This wallet is simulated. It has no key and holds nothing."
                        : "This address exists only in the demo running in your browser."}
                </p>
                <dl className="demo-receipt">
                    <dt>Simulated balance</dt>
                    <dd>
                        {usdc(Number(b.usdc))} · {(Number(b.mon) / 1e18).toFixed(3)} MON
                    </dd>
                </dl>
                <RealLink />
                <Link to="/">Back to the menu</Link>
            </main>
        )
    }

    const tx = kind === "tx" ? chain.tx(id) : undefined
    if (!tx)
        return (
            <main className="wrap page demo-explorer" id="main">
                <h1>Simulated receipt not found</h1>
                <p>This demo transaction is not in this browser. It may have been cleared with Reset demo.</p>
                <RealLink />
                <Link to="/">Back to the menu</Link>
            </main>
        )

    const title =
        tx.kind === "public"
            ? "Public payment"
            : tx.kind === "private"
              ? "Private payment"
              : tx.kind === "deposit"
                ? "Note added to the privacy pool"
                : "Test funds"
    return (
        <main className="wrap page demo-explorer" id="main">
            <p className="demo-explorer__eyebrow">Simulated receipt · {shortDemoId(tx.hash)}</p>
            <h1>{title}</h1>
            <dl className="demo-receipt">
                {tx.kind === "private" ? (
                    <>
                        <dt>From</dt>
                        <dd>the restaurant's relayer</dd>
                        <dt>Payer in the event</dt>
                        <dd>the privacy pool</dd>
                        <dt>To</dt>
                        <dd>Saffron Table</dd>
                        <dt>Amount</dt>
                        <dd>{usdc(tx.amount)}</dd>
                        <dt>Your wallet</dt>
                        <dd>not in this payment</dd>
                    </>
                ) : (
                    <>
                        <dt>From</dt>
                        <dd>{nameOf(tx.from)}</dd>
                        <dt>To</dt>
                        <dd>{nameOf(tx.to)}</dd>
                        <dt>Amount</dt>
                        <dd>{usdc(tx.amount)}</dd>
                        {tx.kind === "public" && (
                            <>
                                <dt>Event</dt>
                                <dd>PaymentReceived</dd>
                            </>
                        )}
                    </>
                )}
                <dt>When</dt>
                <dd>{new Date(tx.at).toLocaleString()}</dd>
            </dl>
            <RealLink />
            <Link to="/">Back to the menu</Link>
        </main>
    )
}
