import { CodeBlock } from "../../components/CodeBlock"
import { Callout, Section, YouNeed } from "../../components/Prose"

export default function Run() {
    return (
        <>
            <YouNeed>
                <ul>
                    <li>Node.js 22 or later (the containers use Node 24), npm and Git.</li>
                    <li>
                        For payments: two throwaway testnet wallets with a little Monad Testnet MON (one for the relayer,
                        one for the faucet), and a restaurant payout address that is allowlisted on the pool.
                    </li>
                </ul>
            </YouNeed>

            <Section id="fairpay-app" title="Run the FairPay app">
                <ol className="steps">
                    <li>
                        <strong>Install dependencies</strong> from the repository root.
                        <CodeBlock label="bash" code="npm install" />
                    </li>
                    <li>
                        <strong>Start it.</strong>
                        <CodeBlock label="bash" code="npm run dev:fairpay" />
                        <p>
                            This builds the SDK, starts the API on <code>127.0.0.1:8788</code> and the web app on{" "}
                            <code>http://localhost:5174</code>.
                        </p>
                    </li>
                </ol>
                <p>
                    With no settings, the app keeps its data in a built-in local database (<code>apps/fairpay/data</code>)
                    and runs with the relayer and faucet off: you can sign in, split bills and browse FairEats, but private
                    payments and the test USDC faucet are off. To turn them on, put testnet-only <code>RELAYER_KEY</code>, <code>FAUCET_KEY</code> and{" "}
                    <code>MERCHANT_ADDRESS</code> in <code>apps/fairpay/.env</code>. If that file doesn't set them, the
                    app reads them from <code>apps/faireats/.env</code>. <code>MERCHANT_ADDRESS</code> also creates the demo
                    restaurant, Saffron Table, on first start. The server refuses to start if the relayer and faucet keys
                    are the same.
                </p>
                <Callout kind="check">
                    open <code>http://localhost:5174</code>. You should see "Split the bill. Everyone pays their part." and
                    the footer should say "Data: local database". Tests: <code>npm run test:fairpay</code>.
                </Callout>
            </Section>

            <Section id="set-up" title="Run the standalone FairEats app">
                <Callout kind="careful">
                    use keys that hold only testnet funds. Never paste a key that holds real money into <code>.env</code>,
                    and never commit <code>.env</code>.
                </Callout>
                <ol className="steps">
                    <li>
                        <strong>Install dependencies</strong> from the repository root.
                        <CodeBlock label="bash" code="npm install" />
                    </li>
                    <li>
                        <strong>Create your environment file.</strong>
                        <CodeBlock label="bash" code="cp apps/faireats/.env.example apps/faireats/.env" />
                        <p>On Windows PowerShell:</p>
                        <CodeBlock label="PowerShell" code="Copy-Item apps/faireats/.env.example apps/faireats/.env" />
                    </li>
                    <li>
                        <strong>Fill in the four required values</strong> in <code>apps/faireats/.env</code>:
                        <CodeBlock
                            label="apps/faireats/.env"
                            code={`RELAYER_KEY=0xYOUR_TESTNET_RELAYER_KEY
FAUCET_KEY=0xYOUR_TESTNET_FAUCET_KEY
MERCHANT_ADDRESS=0xYOUR_ALLOWLISTED_PAYOUT_ADDRESS
KITCHEN_PIN=choose-at-least-6-characters`}
                        />
                        <p>
                            Optional: <code>PORT</code> (default 8787), <code>RPC_URL</code> (default{" "}
                            <code>https://<wbr />testnet-rpc<wbr />.monad<wbr />.xyz</code>), <code>DB_FILE</code>, <code>TRUST_PROXY_HOPS</code>,{" "}
                            <code>INDEXER_CONFIRMATIONS</code>. The server refuses to start if a required value is missing
                            or malformed.
                        </p>
                    </li>
                    <li>
                        <strong>Start the app in development mode.</strong>
                        <CodeBlock label="bash" code="npm run dev" />
                        <p>
                            This builds the SDK, starts the API on <code>127.0.0.1:8787</code> and Vite on{" "}
                            <code>http://localhost:5173</code>.
                        </p>
                    </li>
                </ol>
                <Callout kind="check">
                    open <code>http://localhost:5173</code>. You should see "Tonight at Saffron Table" and the menu. The
                    kitchen is at <code>http://<wbr />localhost:5173/<wbr />kitchen</code> with your <code>KITCHEN_PIN</code>.
                </Callout>
            </Section>

            <Section id="production-build" title="Production build of FairEats locally">
                <CodeBlock label="bash" code="npm start" />
                <p>
                    This builds the SDK and the frontend, then serves both on <code>http://127.0.0.1:8787</code> with the
                    strict Content-Security-Policy.
                </p>
            </Section>

            <Section id="build-site" title="Build this website and the demo locally">
                <p>
                    The pages you are reading and the demo at <code>/app/</code> are one static build. It needs no{" "}
                    <code>.env</code> and no keys.
                </p>
                <CodeBlock
                    label="bash"
                    code={`npm install
npm run build:vercel
npm run preview -w site`}
                />
                <p>
                    <code>build:vercel</code> builds the SDK, builds FairEats in demo mode (
                    <code>npm run build:demo -w faireats</code>, output <code>apps/<wbr />faireats/<wbr />dist-demo</code>), builds this
                    site into <code>apps/site/dist</code>, then copies the demo into <code>apps/site/dist/app</code> and
                    checks the output for anything that looks like a key.
                </p>
                <Callout kind="check">
                    open <code>http://localhost:5182</code> for the site and <code>http://<wbr />localhost:5182/<wbr />app/</code> for the
                    demo. Stop the preview with <kbd>Ctrl</kbd>+<kbd>C</kbd>.
                </Callout>
                <p>
                    To work on the site with live reload, run <code>npm run dev -w site</code> (port 5181). The demo is not
                    served in this mode; build it as above.
                </p>
            </Section>
        </>
    )
}
