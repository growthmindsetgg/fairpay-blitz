# FairEats

A restaurant demo built on [`@fairpay/sdk`](../../packages/sdk). Guests order at a table, each guest pays for their own dishes publicly or privately, and the kitchen sees an order only after every share is verified on-chain.

**Testnet only.** It runs against the FairPay contracts on Monad Testnet (chain 10143) with a MockUSDC anyone can mint. The demo wallet and the faucet exist only so people can try it without their own funds; neither belongs in a real deployment. The code is unaudited: read [SECURITY.md](../../SECURITY.md).

## Run

From the repository root:

```bash
npm install
cp apps/faireats/.env.example apps/faireats/.env   # testnet-only keys, see below
npm run dev        # builds the SDK, then API on 127.0.0.1:8787 and Vite on http://localhost:5173
npm start          # builds the SDK and the frontend, then serves both on http://127.0.0.1:8787
```

In development Vite proxies `/api` to the API server, and the API restarts when a file in `server/` changes. The server always binds to `127.0.0.1`; put a reverse proxy in front of it to expose it.

### Configuration (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `RELAYER_KEY` | yes | Private key of the wallet that submits private payments. Pays gas only. Keep a small MON balance. |
| `FAUCET_KEY` | yes | Private key of the wallet that mints test USDC and sends test MON for the demo faucet. |
| `MERCHANT_ADDRESS` | yes | The restaurant's payout address. Must be allowlisted on `FairPool` for private payments. |
| `KITCHEN_PIN` | yes | Staff PIN for the kitchen screen, at least 6 characters. |
| `PORT` | no | API port, default 8787. |
| `HOST` | no | Listen address, default `127.0.0.1`. The container image sets `0.0.0.0`. |
| `RPC_URL` | no | Default `https://testnet-rpc.monad.xyz`. Its origin is added to the page's `connect-src`. |
| `DEPLOYMENT_FILE` | no | Contract addresses, default `packages/contracts/deployments/monadTestnet.json`. |
| `DB_FILE` | no | SQLite file, default `apps/faireats/data/faireats.db`. |
| `TRUST_PROXY_HOPS` | no | Number of reverse proxies that append to `X-Forwarded-For`. Default 0 (use the socket address). Never set it higher than the real number, or clients can choose their own rate-limit key. Check it with `GET /api/whoami`, which shows the client address the server sees. |
| `INDEXER_CONFIRMATIONS` | no | Blocks a deposit needs on top of it before the indexer serves it. Default 2. |

Use keys that hold nothing but testnet funds. The server refuses to start if a required variable is missing or malformed.

## How it works

```
browser (src/)                         server (server/)                          Monad Testnet
──────────────                         ────────────────                          ─────────────
Menu: pick dishes per guest  ── POST /api/orders ──►  prices from menu.ts, one share
                                                       and orderRef per guest
Order: Pay (public)   ── payPublic ─────────────────────────────────────────────►  FairPay
                      ── POST /api/shares/:id/payments {txHash} ──► verifyPaymentTx ◄──┘
Order: Pay privately  ── GET /api/pool/commitments ◄── deposit indexer ◄── Deposit logs
   proof built here   ── POST /api/relay {proof} ──►  relayer guard ── pay() ──► FairPool ► FairPay
                                                       credits the payment itself
Kitchen (PIN)         ── GET /api/kitchen every 3 s ─►  paid / cooking orders
```

### Orders and shares (`service.ts`, `menu.ts`, `db.ts`)

- The menu and prices live on the server. The browser sends dish ids, quantities and which guest each dish belongs to (up to 8 guests, 12 tables). Every price is a whole number of 5 USDC notes, so every share can be paid with notes.
- Each guest's total becomes a share with its own random secret and `orderRef = createOrderRef(orderId, shareId, secret)`. Only the opaque `orderRef` ever goes on-chain.
- Amounts are stored as integer micro-USDC in SQLite (`node:sqlite`) with foreign keys and CHECK constraints.

### Verification

The browser only sends a transaction hash. `submitPayment` then:

1. Runs one submission per share at a time, so two transactions submitted together cannot both be credited against the same amount owed.
2. Calls `verifyPaymentTx` with the amount still owed. For a share larger than one note, a private payment of exactly one note is also accepted. The SDK checks success, contract, `orderRef`, merchant, amount and that the receipt's block is canonical. FairEats uses the SDK's default of 1 confirmation.
3. Re-reads the share and order inside the write transaction, inserts the payment under `UNIQUE (chain_id, tx_hash, log_index)`, updates what is paid, and marks the order `paid` once every share is verified.

Re-submitting a transaction already counted for that share returns the current state (200). A different transaction for a share that is already paid returns 409 "This share is already paid." and is not counted. A transaction that is not mined or confirmed yet returns 202 `pending`; the browser remembers it and offers "check again" instead of paying twice.

### Private payments and the relayer guard (`app.ts`)

The guest's browser builds the proof (`createPrivatePayment`) and posts it to `/api/relay`. The relayer pays gas, so before calling the SDK relayer the server requires:

- the merchant in the request to be this restaurant's `MERCHANT_ADDRESS`,
- the `orderRef` to belong to a share of an order still awaiting payment,
- that share to still owe at least one note after counting relays already in flight for it (the server holds that note's slot until the relay finishes),
- fewer than 4 relays in flight overall, and at most 12 relay requests per minute per client address.

After the transaction succeeds the server credits the payment to the share itself, then releases the hold; the browser also submits the hash, which is idempotent. Relayer and RPC errors are logged on the server, and clients get fixed messages ("This note has already been spent.", "The pool changed while your proof was built. Try again.", and so on).

### Deposit indexer (`indexer.ts`)

Rebuilding the pool tree from logs in the browser means scanning from the deploy block in 100-block chunks, which is slow. The server indexes `Deposit` events into SQLite and serves the commitments at `GET /api/pool/commitments`. The browser does not trust that list: `groupFromCommitments` checks the rebuilt root against the pool's `knownRoots`.

A wrong list cannot steal anything, but it stops private payments, so the indexer:

- only reads blocks with `INDEXER_CONFIRMATIONS` blocks on top,
- drops a deposit and everything after it when a reorg puts a different commitment at that index,
- compares its count with the pool's `depositCount` at the indexed block, drops extras and rescans from the last good deposit when some are missing,
- reindexes from scratch when the chain is shorter than what it indexed (a restarted local node) or the deployment changed,
- serves only the gap-free run of deposits from index 0, and backs off on RPC errors.

### Notes in the browser (`payments.ts`, `pages/Wallet.tsx`)

- **Top up** creates a note, saves it to `localStorage` before depositing, then deposits it. Notes are kept per chain and pool.
- Notes are checked against the chain to confirm deposits and mark spent notes. A note is removed only when the wallet rejected the deposit signature, so nothing was sent; otherwise notes are never deleted automatically. If the browser is not saving site data, top-up refuses to deposit.
- One note operation runs at a time, across tabs where the browser supports Web Locks, so two payments never pick the same note.
- **Back up notes** downloads a JSON file; **Restore** reads one back (size, format, chain and pool checked). The backup can spend the notes: keep it private.
- Paying a share of N notes builds and relays N proofs one after another.

### Demo wallet and faucet (testnet only)

- **Demo wallet**: a private key generated in the browser and stored in `localStorage` (`faireats.demoKey`). Anything that can read that storage controls the wallet. Use it only with test funds. Users can connect their own browser wallet instead.
- **Faucet** (`POST /api/faucet`): mints 50 MockUSDC to the address, and sends 0.15 MON if the address has less than 0.1 MON. Limits: once per address per 30 minutes (stored in the `faucet_claims` table, so a restart does not reset it), 3 per hour per client address, 60 per hour overall, 3 in flight. Faucet transactions are sent one at a time so their nonces never collide. A failed payout undoes the claim.

### Kitchen (`pages/Kitchen.tsx`)

- Open `/kitchen` and enter the PIN. It is kept in `sessionStorage` for that tab only and sent as `X-Kitchen-PIN`.
- The screen polls `GET /api/kitchen` every 3 seconds and lists `paid` and `cooking` orders from the last 6 hours.
- **Start** works only on a `paid` order and sets a one-minute timer. **Mark served** works only once the timer has run out.
- PINs are compared in constant time. Only wrong PINs count against the limit: 10 per 15 minutes per client address and 60 per hour overall. Once locked out, even the right PIN is refused until the window ends, so polling with the right PIN never locks the kitchen out.

### HTTP hardening (`app.ts`, `net.ts`)

- `POST /api/*` must send `Content-Type: application/json` (415 otherwise); bodies over 16 KB get 413. Browsers cannot send JSON cross-site without a CORS preflight, and the API never approves one.
- Content-Security-Policy allows scripts from the app only (plus `wasm-unsafe-eval` for the prover), `blob:` workers for the prover threads, and network access to the app, the Monad RPC, `RPC_URL` and `snark-artifacts.pse.dev` (proving artifacts). Frames are denied and no referrer is sent.
- Rate limits are fixed windows kept in memory (at most 10,000 keys; expired windows are dropped first, then the oldest). IPv6 clients are counted per /64. All `/api` routes share 600 requests per minute per client address; orders are limited to 20 and payment submissions to 60 per minute.
- Unexpected errors return a generic message; details stay in the server log.
- On SIGINT or SIGTERM the server stops taking requests, waits for relays, faucet sends and the indexer to finish, then closes the database.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/config` | Chain id, RPC URL, explorer, contract addresses, denomination, merchant, restaurant, max guests. |
| `GET /api/menu` | Restaurant and menu. |
| `GET /api/pool/commitments` | Indexed deposit commitments, in order. |
| `POST /api/orders` | Create an order: `{ table, guests, items: [{ id, qty, guest }] }`. |
| `GET /api/orders/:id` | Order with items, shares, `orderRef`s and counted payments. |
| `POST /api/shares/:id/payments` | Submit `{ txHash }` for a share. 200 counted, 202 pending, 409 not accepted. |
| `POST /api/relay` | Submit a private payment request (proof). |
| `POST /api/faucet` | Testnet faucet: `{ address }`. |
| `GET /api/kitchen` | Kitchen queue (PIN). |
| `POST /api/kitchen/orders/:id/start` | Start cooking a paid order (PIN). |
| `POST /api/kitchen/orders/:id/served` | Mark a ready order served (PIN). |

Anyone with an order link can read that order, including its share references and payments. Order and share ids are random UUIDs.

## Test

The tests in `test/server.test.ts` need a local Hardhat node with the contracts deployed (run `npx hardhat node` in `packages/contracts`, then `MERCHANTS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/deploy.ts --network localhost` there; that address is a public Hardhat test account); they read `packages/contracts/deployments/localhost.json`. Without a node they are skipped with a message and the run still passes.

```bash
cd apps/faireats
npx vitest run               # 78 tests; without a node the 12 in server.test.ts skip
npx tsc -p tsconfig.json     # typecheck
```

- `test/server.test.ts` (12, against the node): orders, public and private payments end to end, the kitchen flow, and settlement races (one transaction submitted twice at once, two payments racing for one share, one transaction for two shares, an unseen transaction answered with 202).
- `test/hardening.test.ts` (48, no chain needed): rate limiter, client address parsing, HTTP hardening, kitchen PIN lockout, relay guard, faucet limits, database rules, deposit indexer repair.
- `test/demo.test.ts` (12, no chain needed): the in-browser demo server used by the website build (`npm run build:demo`): orders, simulated public and private payments, the kitchen flow, reset and demo notes.

## Known limitations

- **Kitchen trust is per IP address.** After a correct PIN, that address is trusted for 12 hours so a global lockout cannot shut the real kitchen out. Anyone sharing the kitchen's public IP (same Wi-Fi behind NAT) shares that trust and can keep guessing the PIN at the per-address rate. Put the kitchen on its own network for real use.
- **Small anonymity set.** A private payment hides the guest among the deposits in the tree the proof used. On a demo pool that can be very few people.
- **The server sees metadata.** It sees the client IP on faucet requests (with the wallet address) and on relay requests (with the `orderRef`), and could serve different browsers different-length commitment lists to tell their payments apart. Privacy is from the public chain, not from the restaurant.
- **Timing correlation.** Topping up right before paying, or paying one share with several notes back to back (which this app does), can link deposits to payments.
- **Notes and the demo key live in `localStorage`.** Clearing site data without a backup loses the notes and the deposits behind them. Malicious extensions or scripts on the origin could read them.
- **Fixed denomination.** Everything is priced in 5 USDC notes; there are no change notes.
- **One confirmation.** Payments count after 1 confirmation plus the SDK's canonical-block check. Raise it before handling anything of value.
- **One process.** Rate limits, relay holds and per-share locks are in memory; running several instances would need a shared store.
- **Unaudited.** See [SECURITY.md](../../SECURITY.md).
