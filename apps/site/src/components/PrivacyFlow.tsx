import { CHAIR_N } from "./tablePlan"

// How a private payment travels, as an ordered list that reflows on narrow screens. The break
// between the pool and the browser marks where the chain loses the link to the payer's wallet.

const NODES: { title: string; line: string; onPrivatePath: boolean }[] = [
    { title: "Your wallet", line: "Adds 5 USDC notes to the pool. This step is public.", onPrivatePath: false },
    { title: "Privacy pool", line: "Holds your notes among everyone else's.", onPrivatePath: false },
    { title: "Your browser", line: "Builds a zero-knowledge proof that you own a note.", onPrivatePath: true },
    { title: "Relayer", line: "Sends the payment and pays the gas. It can refuse, but it can't redirect it.", onPrivatePath: true },
    { title: "Restaurant", line: "Gets paid. FairPay verifies the payment on-chain, like any other.", onPrivatePath: true }
]

function Marker() {
    // One chair from the logo, cropped to its own box.
    return (
        <svg className="flow-marker" viewBox="12.5 3.5 23 8" aria-hidden="true" focusable="false">
            <path d={CHAIR_N} />
        </svg>
    )
}

export function PrivacyFlow() {
    return (
        <ol className="flow" aria-label="How a private payment travels">
            {NODES.map((n, i) => (
                <FlowItem key={n.title} n={n} withBreak={i === 2} />
            ))}
        </ol>
    )
}

function FlowItem({ n, withBreak }: { n: (typeof NODES)[number]; withBreak: boolean }) {
    return (
        <>
            {withBreak && (
                <li className="flow-break" aria-label="The link to your wallet ends here">
                    <span className="flow-break-label" aria-hidden="true">
                        The link to your wallet ends here
                    </span>
                </li>
            )}
            <li className={`flow-node${n.onPrivatePath ? " is-private" : ""}`}>
                <Marker />
                <p className="flow-title">{n.title}</p>
                <p className="flow-line">{n.line}</p>
            </li>
        </>
    )
}
