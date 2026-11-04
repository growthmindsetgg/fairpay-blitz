# FairPay

Private payments and bill splitting on Monad: split any bill, pay your share publicly or confidentially through a zero-knowledge privacy pool, plus FairEats for restaurants and a payroll escrow for staff.

- **Website:** https://fairpay-blitz.vercel.app
- **App:** https://fairpay-blitz.vercel.app/pay/
- **Simulated demo (no wallet needed):** https://fairpay-blitz.vercel.app/app/
- **Network:** Monad Testnet (chain id 10143)
- **Repo:** https://github.com/growthmindsetgg/fairpay-blitz (branch `main`)

Testnet only. The code is unaudited. It uses a mintable test USDC (MockUSDC), never real money. The app's faucet gives you test USDC and a little MON.

## Deployed contracts (Monad Testnet)

Network: **Monad Testnet** (chain id 10143). Every contract is source-verified on the explorer.

| Contract | Address |
|---|---|
| MockUSDC (test USDC, 6 decimals) | [`0x6c4A96CAdB1Bd44464edB1237027F23f89Ce3dC7`](https://testnet.monadexplorer.com/address/0x6c4A96CAdB1Bd44464edB1237027F23f89Ce3dC7) |
| FairPay router | [`0x4a4cBDd78356f47a2F43932456f80fEaA6205596`](https://testnet.monadexplorer.com/address/0x4a4cBDd78356f47a2F43932456f80fEaA6205596) |
| FairPool (privacy pool, 5 USDC notes) | [`0x3a7aAe15F71300D09bc268330eF393a023017A92`](https://testnet.monadexplorer.com/address/0x3a7aAe15F71300D09bc268330eF393a023017A92) |
| MonadSemaphoreVerifier | [`0x32D75baE7EeBE945cC747d7250630033DB82E03E`](https://testnet.monadexplorer.com/address/0x32D75baE7EeBE945cC747d7250630033DB82E03E) |
| PoseidonT3 (hash library) | [`0x1966F53eD3074C92Bbdd42Ede68E811d2c13476F`](https://testnet.monadexplorer.com/address/0x1966F53eD3074C92Bbdd42Ede68E811d2c13476F) |
| FairPoolBatcher | [`0x55BbEF68c10907Fd66DC528c8973564FC17e9034`](https://testnet.monadexplorer.com/address/0x55BbEF68c10907Fd66DC528c8973564FC17e9034) |
| FairPayroll (staff payroll escrow) | [`0x5B9BC2fE53504948e6a3FA62a80D730fE20F7Eeb`](https://testnet.monadexplorer.com/address/0x5B9BC2fE53504948e6a3FA62a80D730fE20F7Eeb) |

The same addresses are in [`packages/contracts/deployments/monadTestnet.json`](packages/contracts/deployments/monadTestnet.json).

### Verified live

Two real payments, made through the live app at https://fairpay-blitz.vercel.app/pay/:

| Payment | Transaction | Sent by |
|---|---|---|
| Public: a bill share paid from the guest's own wallet | [`0xa96621a0…d7eaccaa`](https://testnet.monadexplorer.com/tx/0xa96621a0e8ba54c5d1b16c5a709112acde78b55cb4762f7be8c0f2b7d7eaccaa) | the guest's wallet |
| Confidential: a FairEats order at Saffron Table, one 5 USDC note | [`0x5cf84225…a4030e`](https://testnet.monadexplorer.com/tx/0x5cf84225acb9ef5e9ae49de814d6555044a27fef8c24a97450c7f4a3b6d4030e) | the relayer, so the guest's wallet doesn't appear |

The confidential payment went through the previous FairPool (`0xDFc96e6EEe7Fc7C197b48d8e688Dbb06845C8c85`), which had no withdraw function; the pool above replaced it on 4 Nov 2026.

## What it does

### Split bills

Create a bill, add friends by wallet or by name, and split it equally, by fixed amounts, by percentages, by shares or by items. Each bill has a share link. Everyone pays their own share from their own wallet, and the bill shows who has paid. A share counts as paid only after the server has checked the payment on-chain.

### Confidential payments

A confidential payment hides which wallet paid. It does not hide the amount: each note is exactly 5 USDC. The pool only pays allowlisted businesses, so bills between friends are paid publicly and restaurant shares can be paid confidentially.

How it works:

1. **Deposit.** You add notes to the FairPool privacy pool. Each note is a 5 USDC deposit tied to a secret that stays in your browser. The deposit is public; what you do with it later is not.
2. **Prove.** To pay, your browser builds a zero-knowledge proof (Semaphore v4) that you own one of the deposits in the pool, without saying which one. The proof is bound to the merchant and the order.
3. **Relay.** The server's relayer submits the proof and pays the gas, so your wallet does not appear in the payment transaction. The relayer cannot redirect the money: the proof fixes the merchant and the order.
4. **Verify.** FairPool pays the merchant through the FairPay router, which emits a `PaymentReceived` event. The server checks that event on-chain (order reference, merchant, amount, chain, canonical block, confirmations) before it marks the share paid. A note can be spent only once.

### FairEats

Under Business > FairEats, restaurants list themselves with menus and tables. Guests order at a table, then one person pays or everyone pays their own dishes, publicly or confidentially. Each order gets an Indian GST invoice.

### Merchant Payments view

The restaurant owner's Payments tab shows the payout wallet and its live USDC balance, totals (public vs confidential, tips), every payment with its on-chain proof and a re-check button, invoices, a CSV export, and money that needs a refund. A confidential payment never shows who paid.

### Team pay and payroll escrow

The owner can pay staff straight from their wallet (a public USDC transfer the server checks on-chain). With the FairPayroll escrow the owner funds an escrow, sets salary schedules or approves shifts, and staff claim what they have earned from their own wallets. The owner can never withdraw money owed to staff. An optional auto-pay keeper claims on staff's behalf. Salaries and claims are public on-chain, and the app says so.

## How it works

```
            ┌─────────── payment rails ──────────────┐
customer ──►│ public : wallet  ─────────────► FairPay │──► PaymentReceived(orderRef, merchant, payer, amount)
            │ private: ZK proof ► FairPool ► FairPay │                │
            └────────────────────────────────────────┘                ▼
                                                     server: verifyPaymentTx() checks it on-chain
```

- **Contracts** (Solidity, Hardhat): `FairPay` (non-custodial payment router), `FairPool` (Semaphore v4 privacy pool, fixed 5 USDC notes, allowlisted merchants), `MonadSemaphoreVerifier` (the Semaphore verifier adapted to Monad's precompile gas prices), `FairPoolBatcher` (adds several notes in one transaction), `FairPayroll` (staff payroll escrow with no owner or admin).
- **SDK** (`@fairpay/sdk`, TypeScript + viem): order references, public and confidential payments, notes, tree loading, relayer, payroll, and `verifyPaymentTx` for merchant-side verification.
- **Server** (Hono on Node): wallet sign-in (Sign-In with Ethereum), bills, restaurants, orders, invoices, the relayer, the faucet, a deposit indexer and a payroll event indexer. Data lives in Postgres: Supabase when `DATABASE_URL` is set, otherwise a local PGlite database.
- **App** (React 19 + Vite): the FairPay web app. Proofs are built in the browser.
- **Website** (Vite, static, on Vercel): landing page, guide, a simulated demo at `/app/`, and the app at `/pay/`. Vercel forwards `/api/*` to the server on Render (https://fairpay-ed8y.onrender.com).

## Repo layout

| Path | What it is |
|---|---|
| `packages/contracts` | Hardhat project with the contracts, tests and deploy scripts. Not an npm workspace: run `npm install` inside it. |
| `packages/sdk` | `@fairpay/sdk`. Build it (`npm run build:sdk`) before anything that imports it. |
| `apps/fairpay` | The main app: server (`server/`), React app (`src/`), shared types, tests. Plan and API contract: [PLATFORM.md](apps/fairpay/PLATFORM.md). Schema: [schema.sql](apps/fairpay/server/schema.sql). |
| `apps/faireats` | FairEats as a standalone demo. Its in-browser simulated build is the website's `/app/`. |
| `apps/site` | The public website, published to Vercel. |
| `render.yaml` | Render Blueprint for the `fairpay` server. |

## Run it locally

You need Node 24 and npm. Use testnet keys only. Never use a key that holds real funds.

```bash
git clone https://github.com/growthmindsetgg/fairpay-blitz.git
cd fairpay-blitz
npm install
npm run build:sdk
```

### Tests

```bash
npm run test:fairpay                                         # FairPay app tests: in-memory database, fake chain, no network
npm run typecheck -w fairpay-app                             # typecheck the app
cd packages/contracts && npm install && npx hardhat test     # contract tests, in-process, with real proofs
```

The SDK's end-to-end tests (`npm test -w @fairpay/sdk`) and the FairEats node tests (`npm test`) need a local Hardhat node with the contracts deployed: run `npx hardhat node` in `packages/contracts`, then `npm run deploy:local` there. Without a node, the FairEats node tests skip.

### Start the app

```bash
cp apps/fairpay/.env.example apps/fairpay/.env
npm run dev:fairpay
```

Open http://localhost:5174 (the API runs on http://127.0.0.1:8788). The app reads the contract addresses from `packages/contracts/deployments/monadTestnet.json`.

Settings in `apps/fairpay/.env` (all optional for a local run):

| Name | What it does |
|---|---|
| `DATABASE_URL` | Supabase connection string. Leave it empty and the app uses a local PGlite database in `apps/fairpay/data/pg`. |
| `DATABASE_CA` | Needed with a Supabase `DATABASE_URL`: `certs/supabase-root-2021.crt` (in the repo). |
| `RELAYER_KEY` | Testnet wallet that submits confidential payments and pays their gas. Without it, confidential payments are off. |
| `FAUCET_KEY` | Testnet wallet behind the faucet (test USDC and a little MON). Must differ from `RELAYER_KEY`. |
| `MERCHANT_ADDRESS` | Payout wallet of the demo restaurant. It must be allowlisted on FairPool to take confidential payments. |
| `DEMO_OWNER_WALLET` | Your wallet, so you can manage the demo restaurant. Defaults to `MERCHANT_ADDRESS`. |
| `KEEPER_KEY` | Auto-pay keeper for the payroll escrow. Its own wallet, different from the other two keys. |

When `apps/fairpay/.env` doesn't set `RELAYER_KEY`, `FAUCET_KEY` or `MERCHANT_ADDRESS`, the app reads them from `apps/faireats/.env`. Without any keys the app still runs: you can sign in, split bills and pay publicly from your own wallet.

Each relayed confidential payment costs the relayer about 0.15 MON in gas, so give the relayer wallet a few testnet MON.

### Deploy the contracts yourself (optional)

```bash
cd packages/contracts
export DEPLOYER_KEY=0x...            # testnet-only key with some MON
export MERCHANTS=0xYourPayoutWallet  # merchants to allowlist, comma-separated
npm run deploy:testnet               # MockUSDC, FairPay, verifier, PoseidonT3, FairPool, FairPoolBatcher
npm run deploy:payroll:testnet       # FairPayroll
```

`npm run deploy:batcher:testnet` adds a new FairPoolBatcher to an existing pool.

The scripts write the addresses to `deployments/monadTestnet.json`, which the app reads. With no `TOKEN_ADDRESS` a MockUSDC is deployed. Set `OWNER_ADDRESS` to hand ownership to a Safe.

## Deploy

The server runs on Render with Supabase. The website and the app's pages run on Vercel. Step by step: [DEPLOY.md](DEPLOY.md).

## Security

The code is unaudited and runs on testnet only. The privacy model, what each party sees, the guarantees and the known limits are in [SECURITY.md](SECURITY.md).
