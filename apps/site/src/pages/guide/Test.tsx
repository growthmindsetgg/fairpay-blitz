import { CodeBlock } from "../../components/CodeBlock"
import { Callout, Section, YouNeed } from "../../components/Prose"

export default function Test() {
    return (
        <>
            <YouNeed>
                <ul>
                    <li>
                        The repository installed (<code>npm install</code> at the root).
                    </li>
                    <li>
                        For the SDK end-to-end tests and the node-backed FairEats tests, a local Hardhat node with the contracts
                        deployed. The contract, SDK unit and FairPay app tests need no node and no network.
                    </li>
                </ul>
            </YouNeed>

            <Section id="suites" title="Run each suite">
                <ol className="steps">
                    <li>
                        <strong>FairPay app tests</strong> (bills, payments, FairEats and GST maths, with an in-memory
                        database and a fake chain).
                        <CodeBlock label="bash" code="npm run test:fairpay" />
                    </li>
                    <li>
                        <strong>Contract tests</strong> (run in-process).
                        <CodeBlock label="bash" code="cd packages/contracts && npm install && npx hardhat test" />
                    </li>
                    <li>
                        <strong>Start a local node</strong> in a second terminal and leave it running.
                        <CodeBlock label="bash" code="cd packages/contracts && npx hardhat node" />
                    </li>
                    <li>
                        <strong>Deploy the contracts to it.</strong>
                        <CodeBlock
                            label="bash"
                            code={`cd packages/contracts
MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \\
  npx hardhat run scripts/deploy.ts --network localhost`}
                        />
                        <p>On PowerShell, set the variable first, then run the same command without the prefix:</p>
                        <CodeBlock
                            label="PowerShell"
                            code={`$env:MERCHANTS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
npx hardhat run scripts/deploy.ts --network localhost`}
                        />
                        <p>That address is a well-known public Hardhat test account, not anyone's wallet.</p>
                    </li>
                    <li>
                        <strong>SDK tests</strong> (unit tests and tests against the node), from the repository root.
                        <CodeBlock
                            label="bash"
                            code={`npm run build:sdk
npm test -w @fairpay/sdk`}
                        />
                    </li>
                    <li>
                        <strong>Standalone FairEats tests.</strong> Without a node, the tests that need one skip with a message and the run still passes.
                        <CodeBlock label="bash" code="npm test" />
                    </li>
                    <li>
                        <strong>Typecheck the apps.</strong>
                        <CodeBlock
                            label="bash"
                            code={`npm run typecheck -w fairpay-app
cd apps/faireats && npx tsc -p tsconfig.json`}
                        />
                    </li>
                </ol>
                <Callout kind="careful">
                    the SDK and FairEats suites write to the local chain (mint, deposit, pay). Run them one at a time against
                    a node nothing else is using.
                </Callout>
                <Callout kind="check">each command ends with all tests passing (or, without a node, skipped with a message).</Callout>
            </Section>
        </>
    )
}
