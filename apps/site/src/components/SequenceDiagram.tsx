// Phone, restaurant server and Monad Testnet as three lanes. Teal marks the
// private path only. The numbered list above it in the guide carries the same information as text.

const X = { phone: 80, server: 340, chain: 600 }
const TOP = 56

type Msg = { y: number; from: keyof typeof X; to: keyof typeof X; label: string; private?: boolean; dashed?: boolean; labelX?: number }

const MSGS: Msg[] = [
    { y: 96, from: "phone", to: "server", label: "dishes per guest" },
    // Labelled between phone and server, so the server's lifeline does not cross the text.
    { y: 146, from: "phone", to: "chain", label: "public: approve + directPay", labelX: (X.phone + X.server) / 2 },
    { y: 196, from: "phone", to: "server", label: "private: proof", private: true },
    { y: 196, from: "server", to: "chain", label: "relayer: pool.pay", private: true },
    { y: 246, from: "phone", to: "server", label: "tx hash" },
    { y: 286, from: "chain", to: "server", label: "PaymentReceived (read)", dashed: true }
]

export function SequenceDiagram() {
    return (
        <div className="diagram-scroll" tabIndex={0} role="group" aria-label="Sequence diagram, scrolls sideways on small screens">
            <svg
                className="sequence-svg"
                viewBox="0 0 680 380"
                role="img"
                aria-label="Sequence: the phone sends dishes to the FairPay server, which sets prices, shares and order references. A public payment goes from the phone straight to FairPay on Monad. A private payment goes from the phone to the server as a proof, and the relayer sends it to FairPool, which pays through FairPay. The phone sends the transaction hash to the server, which reads the PaymentReceived event from Monad. When all shares are verified, the order goes to the kitchen."
            >
                <defs>
                    <marker id="arr-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                        <path d="M0 0L10 5L0 10z" fill="#16112E" />
                    </marker>
                    <marker id="arr-private" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                        <path d="M0 0L10 5L0 10z" fill="#008DA6" />
                    </marker>
                </defs>
                {(
                    [
                        ["phone", "Phone"],
                        ["server", "FairPay server"],
                        ["chain", "Monad Testnet"]
                    ] as const
                ).map(([k, label]) => (
                    <g key={k}>
                        <rect x={X[k] - 78} y={12} width={156} height={34} rx={17} fill={k === "chain" ? "#16112E" : "#FFFFFF"} stroke="#16112E" strokeWidth="1.5" />
                        <text x={X[k]} y={34} textAnchor="middle" className={k === "chain" ? "sq-lane on-ink" : "sq-lane"}>
                            {label}
                        </text>
                        <line x1={X[k]} y1={TOP} x2={X[k]} y2={360} stroke="#7E78A0" strokeWidth="1.5" strokeDasharray="3 5" />
                    </g>
                ))}
                {MSGS.map((m, i) => {
                    const x1 = X[m.from]
                    const x2 = X[m.to]
                    const dir = x2 > x1 ? 1 : -1
                    const color = m.private ? "#008DA6" : "#16112E"
                    const mid = m.labelX ?? (x1 + x2) / 2
                    return (
                        <g key={i}>
                            <line
                                x1={x1 + dir * 4}
                                y1={m.y}
                                x2={x2 - dir * 6}
                                y2={m.y}
                                stroke={color}
                                strokeWidth="2"
                                strokeDasharray={m.dashed ? "6 4" : undefined}
                                markerEnd={`url(#${m.private ? "arr-private" : "arr-ink"})`}
                            />
                            <text x={mid} y={m.y - 8} textAnchor="middle" className={m.private ? "sq-msg private" : "sq-msg"}>
                                {m.label}
                            </text>
                        </g>
                    )
                })}
                <text x={X.server + 10} y={118} className="sq-note">
                    prices, shares, orderRefs
                </text>
                <text x={X.chain - 10} y={170} textAnchor="end" className="sq-note">
                    FairPay
                </text>
                <text x={X.chain - 10} y={220} textAnchor="end" className="sq-note private">
                    FairPool → FairPay
                </text>
                <text x={X.server + 10} y={304} className="sq-note">
                    verifyPaymentTx
                </text>
                <rect x={X.server - 134} y={316} width={268} height={34} rx={8} fill="#E1F3E9" stroke="#1E7A4E" strokeWidth="1.5" />
                <text x={X.server} y={338} textAnchor="middle" className="sq-msg basil">
                    all shares verified → kitchen
                </text>
            </svg>
        </div>
    )
}
