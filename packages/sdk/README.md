# @fairpay/sdk

Public and private payments with merchant-side verification on Monad.

- **Public**: the customer pays from their wallet. Fully transparent.
- **Private**: the customer pays from a zero-knowledge pool. The chain shows that *someone in the pool* paid the merchant, not which wallet.
- **Verification**: the merchant checks a payment against the chain, not against a "success" message from the browser. Both paths emit the same `PaymentReceived(orderRef, recipient, payer, amount)` event, so they share one verification path.

> **Status: unaudited.** The contracts keep a deposit cap and pause switch for this reason. Read [SECURITY.md](../../SECURITY.md) before handling real funds.

## Install

```bash
npm install @fairpay/sdk viem
```

Until it is published to npm, install the packed tarball:

```bash
cd packages/sdk && npm run build && npm pack
npm install /path/to/fairpay-sdk-0.1.0.tgz viem
```

## Concepts

| Term | Meaning |
|---|---|
| `orderRef` | Opaque `bytes32` for one participant's share of one order: `keccak256(orderId, participantId, secret)`. The secret stays off-chain. Must be non-zero. |
| Note | The right to spend one pool deposit (one denomination, e.g. 5 USDC). Behaves like a private key: whoever has it can spend it; losing it loses the deposit. |
| Group | The pool's Merkle tree of deposit commitments. A proof shows the note is one of its members without saying which. |
| Relayer | Your backend submits private payments from its own wallet, so the customer's wallet never touches the payment transaction. It cannot redirect funds. |

## API at a glance

| Function | Side | What it does |
|---|---|---|
| `randomSecret()`, `createOrderRef({ orderId, participantId, secret })` | backend | Make a share reference. |
| `payPublic(deployment, clients, { merchant, amount, orderRef })` | browser | Approve the exact amount, then `FairPay.directPay`. |
| `createNote(deployment)`, `serializeNote(note)`, `parseNote(text)` | browser | Create and store notes. |
| `depositNote(deployment, clients, note)` | browser | Deposit one denomination against a note. |
| `depositNotes(deployment, clients, notes, options?)` | browser | Deposit several notes: one approval, then one `FairPoolBatcher.depositMany` per 20 notes (or one atomic EIP-5792 batch). |
| `walletSupportsAtomic(clients, chainId)` | browser | Whether the wallet reports EIP-5792 atomic batching as `supported` on that chain. |
| `isNoteSpent(deployment, publicClient, note)` | browser | Whether the note's nullifier is used. |
| `fetchGroup(deployment, publicClient, options?)` | browser | Rebuild the tree from `Deposit` logs; checked against the on-chain root. |
| `groupFromCommitments(deployment, publicClient, commitments)` | browser | Rebuild the tree from an indexer's list; checked against `knownRoots`. |
| `createPrivatePayment(deployment, publicClient, { note, merchant, orderRef, group? })` | browser | Build the proof. |
| `submitToRelayer(url, request)` | browser | POST the proof to your relayer. |
| `createRelayer(deployment, clients).handle(body)` (from `@fairpay/sdk/relayer`) | backend | Validate, simulate and submit a private payment. |
| `verifyPaymentTx(deployment, publicClient, params)` | backend | Verify one payment transaction. |
| `findPayments(deployment, publicClient, { orderRef, merchant?, fromBlock })` | backend | Find payments for a reference by scanning logs. |
| `paymentMessage(merchant, orderRef)` | either | The proof message, `keccak256(merchant, orderRef)` as a field element. |

## Usage

```ts
import { createPublicClient, createWalletClient, custom, http } from "viem"
import { monadTestnet } from "viem/chains"
import * as fairpay from "@fairpay/sdk"

const deployment: fairpay.FairPayDeployment = {
  chainId: 10143,
  token: "0x…",        // USDC (or MockUSDC on testnet)
  fairPay: "0x…",
  pool: "0x…",
  poolDeployBlock: 0n, // block the pool was deployed in
  batcher: "0x…"      // optional FairPoolBatcher: several notes per transaction
}
const publicClient = createPublicClient({ chain: monadTestnet, transport: http() })
const walletClient = createWalletClient({ chain: monadTestnet, transport: custom(window.ethereum), account })
const clients = { publicClient, walletClient }
```

Every function that touches the chain first checks that the RPC (and wallet, if given) is on `deployment.chainId`, and throws `WRONG_CHAIN` otherwise. Writes are simulated first and sent with a gas limit close to the estimate, because Monad charges for the gas limit, not the gas used.

### 1. Backend: create the share reference

```ts
const secret = fairpay.randomSecret()            // store with the participant row
const orderRef = fairpay.createOrderRef({ orderId: "FE-001", participantId: "p2", secret })
```

### 2a. Browser: pay publicly

```ts
const { txHash } = await fairpay.payPublic(deployment, clients, { merchant, amount: 12_500_000n, orderRef })
// send txHash to your backend for verification
```

`payPublic` approves only the exact amount, never an unlimited allowance. It rejects a malformed or zero `orderRef`, a non-positive amount, and a merchant equal to the FairPay contract before sending the approval, so the payer does not pay gas for an approval the contract would then refuse to use.

### 2b. Browser: pay privately

```ts
// Ahead of time (the further ahead, the better the privacy): top up the private balance.
const note = fairpay.createNote(deployment)
localStorage.setItem("note", fairpay.serializeNote(note))   // store BEFORE depositing
await fairpay.depositNote(deployment, clients, note)

// At checkout: prove and hand the payment to the relayer. Takes a few seconds.
const request = await fairpay.createPrivatePayment(deployment, publicClient, { note, merchant, orderRef })
const { txHash } = await fairpay.submitToRelayer("/api/relay", request)
```

To add several notes at once, use `depositNotes`. Store every note first:

```ts
const notes = Array.from({ length: 11 }, () => fairpay.createNote(deployment))
saveAll(notes.map(fairpay.serializeNote))                    // store BEFORE depositing
const { deposits, transactions } = await fairpay.depositNotes(deployment, clients, notes, {
  onProgress: (p) => console.log(p),                         // "plan" first: approve?, deposits, confirmations
  onDeposited: (done) => markDeposited(done)                 // per confirmed transaction
})
// deposits[i] = { txHash, index } for notes[i]
```

How many wallet confirmations it takes:

| Deployment and wallet | 11 notes | 25 notes |
|---|---|---|
| `depositNote` once per note | 22 (approve + deposit each) | 50 |
| `depositNotes` without `batcher` | 12 (one approval, then one deposit each) | 26 |
| `depositNotes` with `batcher` | 2 (approve, `depositMany`) | 3 |
| `depositNotes` with `batcher`, allowance already enough | 1 | 2 |
| `depositNotes` with `batcher`, wallet reports EIP-5792 `atomic: supported` | 1 (atomic `wallet_sendCalls`) | 1 |

The approval is for the exact total, and only when the current allowance is short. The atomic path is used only for browser (JSON-RPC) accounts whose `wallet_getCapabilities` answers `atomic.status === "supported"` for the deployment's chain; `ready` (the wallet would first ask to upgrade the account to a smart account) and local private-key accounts get separate transactions, as does `{ atomic: "never" }`. If the wallet refuses the batch for any reason other than the user declining, it falls back to separate transactions; that is safe even if the batch landed after all, because a commitment can only be deposited once.

Before asking the wallet for anything, `depositNotes` refuses a paused pool (`POOL_PAUSED`), more notes than the deposit cap leaves (`POOL_FULL`), duplicate notes or notes for another pool, and a `batcher` whose `pool()` or `token()` differs from the deployment (`INVALID_INPUT`). If a later transaction fails, the notes of earlier transactions are already deposited and were reported through `onDeposited`.

A share must be a multiple of the pool denomination; pay a larger share with several notes. Submit them at different times, or they can be linked.

`parseNote` only accepts notes in the format `serializeNote` writes: a positive chain id, a pool address, and a key that is base64 of exactly 32 bytes. Semaphore's `Identity.import` accepts any string (including `""`) and derives a valid identity from it, which anyone could recompute and spend; `parseNote` refuses such keys with `INVALID_INPUT`.

`localStorage` is only an example. Wherever you keep notes, anything that can read that storage can spend them. Offer users a backup.

### 2c. Loading the tree

`createPrivatePayment` needs the pool's Merkle tree. Without a `group` it calls `fetchGroup`, which scans every `Deposit` log from `poolDeployBlock` in chunks of 100 blocks (Monad's public RPC rejects larger `eth_getLogs` ranges; change it with `{ chunkSize }`) and checks the rebuilt root and count against the pool at the same block. On a long-lived pool that is slow.

If your backend indexes deposits, pass its list instead:

```ts
const { commitments } = await fetch("/api/pool/commitments").then((r) => r.json())
const group = await fairpay.groupFromCommitments(deployment, publicClient, commitments)
const request = await fairpay.createPrivatePayment(deployment, publicClient, { note, merchant, orderRef, group })
```

The indexer is not trusted: `groupFromCommitments` throws `GROUP_MISMATCH` unless the list rebuilds a root the pool has recorded in `knownRoots`. Only the real deposit list in order, or a prefix of it, produces such a root. It throws `NOTE_NOT_FOUND` later (in `createPrivatePayment`) if your note is not in the list, for example because the indexer has not caught up with a fresh deposit; wait and retry.

Accepting a prefix keeps payments working while the indexer lags, but it has a privacy cost: the proof's anonymity set is the prefix, and a malicious indexer could serve different prefix lengths to different clients and recognise them by the root their payment uses. See [SECURITY.md](../../SECURITY.md).

### 3. Backend: the relayer route

```ts
import { createRelayer } from "@fairpay/sdk/relayer"

const relayer = createRelayer(deployment, { publicClient, walletClient: relayerWallet })

export async function POST(req: Request) {
  // Put rate limiting and your own business checks in front of this: is the orderRef an open
  // order of yours, does it still owe money? The relayer pays gas for every request it sends.
  try {
    return Response.json(await relayer.handle(await req.json()))
  } catch (e) {
    console.error(e)
    // Map known FairPayError codes to fixed messages. Raw errors can contain your RPC URL and
    // the relayer's address and balance.
    return Response.json({ error: "payment could not be submitted" }, { status: 400 })
  }
}
```

`handle` treats the body as untrusted. It requires the deployment's chain and pool, a merchant address, a `bytes32` `orderRef`, and proof fields written as canonical decimal uint256 strings (no leading zeros, at most 2^256 - 1). Canonical numbers matter: the relayer refuses a second request for a nullifier that is already being submitted, and `"07"` and `"7"` would otherwise be two keys for one nullifier. Each request is simulated before it is sent, so invalid proofs, spent notes and unlisted merchants cost no gas. `handle` resolves only after the transaction succeeded on-chain.

[`apps/faireats/server/app.ts`](../../apps/faireats/server/app.ts) is a complete example with rate limits, a per-share hold and error mapping.

### 4. Backend: verify before releasing the order

```ts
const result = await fairpay.verifyPaymentTx(deployment, publicClient, {
  txHash, orderRef, merchant,
  amount: share.amount,
  expectedPayer: share.wallet,   // checked for public payments only
  minConfirmations: 2n           // default 1
})
if (result.status === "verified") {
  // INSERT with UNIQUE (chain_id, tx_hash, log_index) so one payment can never settle two shares
  await db.payments.insert({ ...result.payment, shareId })
}
```

`result.status` is `verified`, `pending` (not mined, not enough confirmations, or the receipt's block is not the canonical block at that height) or `rejected` (with a `reason`).

`verifyPaymentTx` trusts only the chain. The transaction must have succeeded; exactly one `PaymentReceived` event from the FairPay contract must carry this `orderRef` and merchant; the amount must match exactly; for public payments the payer must match `expectedPayer` if given. A private payment has the pool as its payer (`payment.kind === "private"`). It also fetches the block at the receipt's height and returns `pending` unless its hash equals the receipt's block hash, so a receipt from a reorged-out block or a lagging node behind a load balancer is not counted. That check does not replace waiting for finality: choose `minConfirmations` for the value at stake.

Never mark a share paid from a client-side "success" message. Settle one share at a time, or re-check what is still owed inside the database transaction that records the payment.

`findPayments(deployment, publicClient, { orderRef, merchant, fromBlock })` recovers payments whose transaction hash was lost, or sums several notes paying one share. It re-checks every returned log itself (contract address, `orderRef`, recipient, all fields present, not removed), so an RPC that ignores the address or topic filters cannot make other contracts' events count. It does not check confirmations or block canonicality; pass a result's `txHash` through `verifyPaymentTx` before relying on it.

Both functions throw `INVALID_INPUT` before any network call when the `orderRef` is not a `bytes32` or the merchant is not an address (and `verifyPaymentTx` when the transaction hash is malformed).

## Errors

All SDK-raised errors are `FairPayError` with a `code`: `WRONG_CHAIN`, `INVALID_INPUT`, `NO_POOL`, `GROUP_MISMATCH`, `NOTE_NOT_FOUND`, `NOTE_SPENT`, `NOT_MERCHANT`, `POOL_FULL`, `POOL_PAUSED`, `RELAYER_REJECTED`, `RELAYER_TIMEOUT`, `RELAYER_BUSY`, `RELAYER_UNFUNDED`. Errors from viem (RPC failures, user rejections) pass through, and `depositNote` and `depositNotes` throw a plain `Error` if a deposit reverts. Inside the relayer, a failure before anything was sent is `RELAYER_UNFUNDED` (the relayer wallet can't cover gas), `RELAYER_BUSY` (the node refused the nonce or is rate limiting; retry), `RELAYER_TIMEOUT` without a `txHash` (no answer from the RPC, so the transaction may or may not have gone out), or `RELAYER_REJECTED` with the revert name or viem's short message. Once the relayer has sent a transaction, its errors carry `txHash`: `RELAYER_TIMEOUT` means no receipt arrived in time (the payment may still land, so settle that hash), and `RELAYER_REJECTED` with a `txHash` means it reverted on-chain, for example because someone sent the same proof first (`findPayments` finds that payment).

## Development

The end-to-end tests need a local Hardhat node with the contracts deployed. They read `../contracts/deployments/localhost.json` and write to that chain (mint, deposit, pay), so do not run them while another suite uses the same node.

```bash
# terminal 1
cd packages/contracts && npx hardhat node
# terminal 2
cd packages/contracts && MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/deploy.ts --network localhost
cd ../sdk && npm run build && npm test   # 42 tests: 22 without the node, 20 with it
```

The suite covers order references; public payment and verification (wrong amount, merchant, reference or payer; a stale receipt from a non-canonical block; an RPC that drops filters and serves forged logs; malformed references); notes (round-trip, bad keys, chain ids and bodies); deposits and tree rebuilding from logs and from indexer lists; depositing several notes (11 notes in 2 transactions, 1 with an allowance, 21 in 3, without a batcher, the deposit-cap check, a batched note spent through the relayer); relayed private payment verified as private; spent notes; and relayer input validation.

`scripts/live-check.ts` runs one public and one relayed private payment against a live deployment. `scripts/live-batch-deposit.ts` funds a throwaway wallet from a faucet key (`FAUCET_KEY` in the environment), deposits several notes through the batcher, re-reads them on-chain and sweeps the leftovers back.

`test/deposit.test.ts`, `test/nonce.test.ts` and `test/payroll.test.ts` run without a node: `depositNotes` against a fake chain and wallet (plans, chunking, the atomic batch and its fallbacks, refusals), the relayer's nonce handling, and the FairPayroll ABI and helpers.
