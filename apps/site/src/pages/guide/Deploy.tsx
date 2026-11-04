import { CodeBlock } from "../../components/CodeBlock"
import { Callout, H3, Section, YouNeed } from "../../components/Prose"
import { Ext } from "../../components/Ext"

export default function Deploy() {
    return (
        <>
            <YouNeed>
                <ul>
                    <li>A Render account and a Supabase project (both have free tiers).</li>
                    <li>
                        A fork or clone of the{" "}
                        <Ext href="https://github.com/growthmindsetgg/fairpay-blitz">growthmindsetgg/<wbr />fairpay-blitz</Ext>{" "}
                        repository.
                    </li>
                    <li>Throwaway testnet wallets for the relayer and the faucet, and an allowlisted payout address.</li>
                </ul>
            </YouNeed>

            <Section id="deploy" title="Deploy the apps on Render" toTop>
                <p>
                    The <code>render.yaml</code> Blueprint in the repository defines two web services. The contracts already
                    run on Monad Testnet and need no hosting.{" "}
                    <Ext href="https://github.com/growthmindsetgg/fairpay-blitz/blob/main/DEPLOY.md">DEPLOY.md</Ext> in the
                    repository has every detail; this is the short version.
                </p>
                {/* Fits at every width (rows stack below 640). Explicit roles keep rows announced when stacked. */}
                <table className="g-table" role="table">
                    <caption className="sr-only">The two services in render.yaml</caption>
                    <thead role="rowgroup">
                        <tr role="row">
                            <th scope="col" role="columnheader">
                                Service
                            </th>
                            <th scope="col" role="columnheader">
                                What it runs
                            </th>
                        </tr>
                    </thead>
                    <tbody role="rowgroup">
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                <code>fairpay</code>
                            </th>
                            <td role="cell">
                                The FairPay app (<code>apps/fairpay/Dockerfile</code>). Free plan; its data lives in Supabase,
                                so restarts and redeploys lose nothing.
                            </td>
                        </tr>
                        <tr role="row">
                            <th scope="row" role="rowheader">
                                <code>faireats</code>
                            </th>
                            <td role="cell">
                                The standalone FairEats app (root <code>Dockerfile</code>). Free plan with no disk, so its
                                database starts empty after every restart. Leave it out if you only want FairPay.
                            </td>
                        </tr>
                    </tbody>
                </table>
                <Callout kind="careful">
                    don't let two running services share one relayer or faucet key: each keeps its transactions in order only
                    inside its own process, so they can clash on nonces. Give each service its own testnet wallets, or run
                    only one. Never use a key that holds real funds.
                </Callout>
                <ol className="steps">
                    <li>
                        <strong>Create the Supabase database.</strong> Make a project, press <b>Connect</b> and copy the{" "}
                        <b>Session pooler</b> connection string. Download Supabase's CA certificate from the database
                        settings (SSL Configuration). The app creates its own tables on first start.
                    </li>
                    <li>
                        <strong>Create the Blueprint on Render.</strong> Choose <b>New</b>, then <b>Blueprint</b>, pick the
                        repository and keep the branch <code>main</code>. Allow Render to read only this repository.
                    </li>
                    <li>
                        <strong>Enter the secrets</strong> for <code>fairpay</code>: <code>DATABASE_URL</code> (the pooler
                        string), <code>DATABASE_CA</code> (the certificate, for example as a secret file),{" "}
                        <code>PUBLIC_ORIGIN</code>, <code>RELAYER_KEY</code>, <code>FAUCET_KEY</code>,{" "}
                        <code>MERCHANT_ADDRESS</code> and, optionally, <code>DEMO_OWNER_WALLET</code> so you can manage the
                        demo restaurant. For <code>faireats</code>: <code>RELAYER_KEY</code>, <code>FAUCET_KEY</code>,{" "}
                        <code>MERCHANT_ADDRESS</code> and a long random <code>KITCHEN_PIN</code>.
                    </li>
                    <li>
                        <strong>Point it at this website.</strong> People open the app on this website at{" "}
                        <code>/pay/</code>, and the website forwards <code>/api</code> to the Render service (next
                        section). In the <code>fairpay</code> service's <b>Environment</b> tab set{" "}
                        <code>PUBLIC_ORIGIN</code> to <code>https://<wbr />fairpay-blitz<wbr />.vercel<wbr />.app</code>{" "}
                        (exactly, no trailing slash), <code>PUBLIC_APP_PATH</code> to <code>/pay</code> and{" "}
                        <code>TRUST_PROXY_HOPS</code> to <code>4</code>, then redeploy. Sign-in messages must name this
                        address. The server refuses to start in production without <code>PUBLIC_ORIGIN</code> and{" "}
                        <code>DATABASE_URL</code>.
                    </li>
                    <li>
                        <strong>Check it.</strong> Open <code>/api/config</code> on the website: it should say{" "}
                        <code>"storage":"supabase"</code> and report whether the relayer is ready. Open{" "}
                        <code>/api/whoami</code>: it should show your own IP address. Then open <code>/pay/</code>, sign in
                        and open <b>Business</b>, <b>FairEats</b>.
                    </li>
                </ol>
                <Callout kind="check">
                    the footer of the app says "Data: Supabase". The first start on a new database scans the privacy pool
                    from its deploy block, so private payments wait several minutes; later restarts resume at once.
                </Callout>

                <H3 id="after-live">After it is live</H3>
                <ul>
                    <li>
                        <strong>Updates:</strong> every push to <code>main</code> redeploys both services.
                    </li>
                    <li>
                        <strong>Sleep:</strong> free instances sleep when idle. The first visit after that takes about 50
                        seconds; the app shows "Starting the server…" meanwhile.
                    </li>
                    <li>
                        <strong>Gas:</strong> each private payment costs the relayer about 0.15 MON, and the node wants about
                        0.26 MON on hand before it accepts one. Top up the relayer and faucet wallets when the logs say
                        "insufficient balance".
                    </li>
                    <li>
                        <strong>Logs:</strong> in each service's Logs tab. Keys are never logged.
                    </li>
                    <li>
                        <strong>Pausing:</strong> use <b>Suspend</b>. Deleting the <code>fairpay</code> service leaves its data
                        in Supabase.
                    </li>
                </ul>
                <p>
                    What is in the images: built from <code>node:24-bookworm-slim</code>, run as the unprivileged{" "}
                    <code>node</code> user. <code>.dockerignore</code> keeps every <code>.env</code> file, the local
                    databases and <code>node_modules</code> out. Prices change; check{" "}
                    <Ext href="https://render.com/pricing">render.com/pricing</Ext> and{" "}
                    <Ext href="https://supabase.com/pricing">supabase.com/pricing</Ext>.
                </p>
            </Section>

            <Section id="deploy-site" title="Publish this website on Vercel">
                <p>
                    The pages you are reading, the simulated demo at <code>/app/</code> and the FairPay app's pages at{" "}
                    <code>/pay/</code> are static files. They contain no server, no database and no keys, so they can live
                    on Vercel. The app's server runs on Render, and Vercel forwards every <code>/api</code> request to it,
                    so visitors only ever see this website's address.
                </p>
                <p>
                    The live copy is at <a href="https://fairpay-blitz.vercel.app">fairpay-blitz.vercel.app</a>. To publish a
                    new version, sign in to the Vercel CLI once (<code>npx vercel login</code>), then run from the
                    repository root:
                </p>
                <CodeBlock label="bash" code={`npm run deploy:vercel`} />
                <p>
                    This builds the site and the demo, packs <code>apps/site/dist</code> into Vercel's prebuilt format (
                    <code>apps/<wbr />site/<wbr />.vercel/<wbr />output</code>) and uploads only those static files. Vercel runs no build of its
                    own, and no source code or <code>.env</code> file is uploaded. The headers and rewrites come from{" "}
                    <code>apps/site/vercel.json</code>: <code>/guide</code> to the site, <code>/app/*</code> to the demo,{" "}
                    <code>/pay/*</code> to the app, <code>/api/*</code> to the app's server on Render, a strict
                    Content-Security-Policy (the app's pages get the few extra permissions its in-browser prover needs),
                    HSTS, <code>nosniff</code>, a referrer policy and a permissions policy that turns off camera,
                    microphone and location. Never add wallet keys to the Vercel project; the only setting it may hold is
                    the optional <code>PROXY_SECRET</code>. Set the same value on the Render <code>fairpay</code> service;
                    Vercel then adds it to every forwarded <code>/api</code> request as a header, so the server can tell
                    requests that came through this website.
                </p>
                <Callout kind="check">
                    open the deployed URL. <code>/</code> shows the landing page, <code>/guide</code> this guide, and{" "}
                    <code>/app/</code> the demo with the "Simulated demo" bar on top, and <code>/pay/</code> the app. In the
                    browser's network panel, the site and the demo make no requests to any other host; the app talks only to
                    this website, the Monad testnet RPC and, for a private payment, the proving files at{" "}
                    <code>snark-artifacts.pse.dev</code>.
                </Callout>
            </Section>
        </>
    )
}
