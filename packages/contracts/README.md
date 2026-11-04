# FairPay contracts

Solidity contracts for FairPay: public and confidential (zero-knowledge) payments to businesses, plus a payroll escrow for restaurant staff. Built with Hardhat and Semaphore v4, deployed on Monad Testnet.

**Testnet only. The contracts are unaudited.** Never use keys that hold real funds.

## Contracts

| Contract | What it does |
|---|---|
| `FairPay` | Non-custodial payment router. Every payment, public or confidential, ends here and emits one `PaymentReceived` event with an opaque order reference, so off-chain verification only needs that event. Rejects fee-on-transfer tokens and calls on any chain other than the one it was deployed on. Owner can pause. |
| `FairPool` | Fixed-denomination privacy pool (5 USDC notes). A customer deposits against a Semaphore identity commitment and later pays an allowlisted merchant with a zero-knowledge membership proof that cannot be linked to the deposit. Keeps its own Merkle tree and nullifier set; the proof's message commits to (merchant, order), and its scope is bound to the chain, pool and denomination. The owner manages the merchant allowlist, a deposit cap and pause, and has no function that moves pooled funds. |
| `MonadSemaphoreVerifier` | The Semaphore v4.14.5 Groth16 verifier, same maths and keys, with one change: it forwards all gas to the BN254 precompiles instead of the fixed Ethereum amounts (200 / 8,000 / 241,333). Monad prices these precompiles higher (ecMul about 30,000 gas), so the stock verifier runs out of gas and rejects every proof. Precompiles are fixed-cost and cannot re-enter, so forwarding all gas is safe. |
| `PoseidonT3` | Poseidon hash library from `poseidon-solidity`, linked into `FairPool` for its Merkle tree. |
| `FairPoolBatcher` | Deposits up to 20 notes into the pool in one transaction (one approval, one confirmation). No owner, no storage, never holds funds after a call; the whole batch reverts if any deposit fails. |
| `FairPayroll` | Payroll escrow: any wallet is an employer that funds an escrow and pays staff by approved shifts or by daily / weekly / monthly schedules. Money owed to staff is reserved before the employer can withdraw; ending or changing a schedule pays the period in progress pro rata; unfunded pay becomes debt shared pro rata between employees. No owner, admin, pause or upgrade. |
| `MockUSDC` (`contracts/test/Mocks.sol`) | 6-decimal test token used as USDC on testnet (`mUSDC`). |

## Deployment: Monad Testnet

Network: Monad Testnet, chain id `10143`, RPC `https://testnet-rpc.monad.xyz`, explorer https://testnet.monadexplorer.com. Every contract below is source-verified (Sourcify full match).

| Name | Address |
|---|---|
| Token (`MockUSDC`) | [`0x6c4A96CAdB1Bd44464edB1237027F23f89Ce3dC7`](https://testnet.monadexplorer.com/address/0x6c4A96CAdB1Bd44464edB1237027F23f89Ce3dC7) |
| `FairPay` | [`0x4a4cBDd78356f47a2F43932456f80fEaA6205596`](https://testnet.monadexplorer.com/address/0x4a4cBDd78356f47a2F43932456f80fEaA6205596) |
| `FairPool` | [`0xDFc96e6EEe7Fc7C197b48d8e688Dbb06845C8c85`](https://testnet.monadexplorer.com/address/0xDFc96e6EEe7Fc7C197b48d8e688Dbb06845C8c85) |
| `MonadSemaphoreVerifier` | [`0x32D75baE7EeBE945cC747d7250630033DB82E03E`](https://testnet.monadexplorer.com/address/0x32D75baE7EeBE945cC747d7250630033DB82E03E) |
| `PoseidonT3` | [`0x1966F53eD3074C92Bbdd42Ede68E811d2c13476F`](https://testnet.monadexplorer.com/address/0x1966F53eD3074C92Bbdd42Ede68E811d2c13476F) |
| `FairPoolBatcher` | [`0x4d6c7A394C056e108F085B0D885C98657E28C028`](https://testnet.monadexplorer.com/address/0x4d6c7A394C056e108F085B0D885C98657E28C028) |
| `FairPayroll` | [`0x5B9BC2fE53504948e6a3FA62a80D730fE20F7Eeb`](https://testnet.monadexplorer.com/address/0x5B9BC2fE53504948e6a3FA62a80D730fE20F7Eeb) |

Pool settings: denomination `5000000` (5 USDC), deposit cap 200. Allowlisted merchant payout wallets: `0x20835c231a5AB47e0a19591EA23F20CAC1556d25`, `0xAC84A0eDa131997849C51b0A1f815f730e7b6a20`.

The machine-readable copy, with the deploy blocks indexers start from (`poolDeployBlock`, `batcherDeployBlock`, `payrollDeployBlock`), is [`deployments/monadTestnet.json`](deployments/monadTestnet.json). The SDK and the apps read addresses from that file.

## Build and test

This package is not an npm workspace; install inside it:

```sh
cd packages/contracts
npm install
npx hardhat compile
npx hardhat test        # 139 tests on the in-process Hardhat network
```

The test suite covers the router, the pool (real Semaphore proofs, double spends, redirection, tampered proofs, solvency), the batcher, and the payroll escrow, including model-based fuzzing and adversarial suites.

## Deploy

The config reads keys from the environment only (`DEPLOYER_KEY`); it does not load `.env` itself. See `.env.example`.

```sh
# 1. Token (a MockUSDC unless TOKEN_ADDRESS is set), FairPay, verifier, PoseidonT3, FairPool, FairPoolBatcher
MERCHANTS=0xMerchant1,0xMerchant2 npx hardhat run scripts/deploy.ts --network monadTestnet
# 2. FairPayroll for the same token
npx hardhat run scripts/deploy-payroll.ts --network monadTestnet
```

Optional settings for `deploy.ts`: `TOKEN_ADDRESS`, `OWNER_ADDRESS` (ownership is then offered with Ownable2Step and must be accepted), `DENOMINATION`, `MAX_DEPOSITS`. Before the pool is deployed, the script checks a real Semaphore proof against the new verifier on the target chain and stops if it is rejected. Each script writes `deployments/<network>.json`.

Other scripts:

- `scripts/deploy-batcher.ts` deploys a new `FairPoolBatcher` for the pool in the deployments file and records it as `batcher`.
- `scripts/set-merchant.ts` allowlists (or, with `ALLOWED=false`, removes) a merchant: `MERCHANT=0x... npx hardhat run scripts/set-merchant.ts --network monadTestnet`. Only the pool owner can do this.

Monad charges the full gas limit of a transaction, so the scripts keep gas limits close to the estimate.

## Verify

`hardhat.config.ts` verifies through Sourcify for the Monad explorers. Pass the constructor arguments; the library address in `FairPool` is read from its bytecode.

```sh
npx hardhat verify --network monadTestnet --contract contracts/FairPool.sol:FairPool <pool> <token> <fairPay> <verifier> 5000000 200 <owner>
npx hardhat verify --network monadTestnet --contract contracts/FairPayroll.sol:FairPayroll <payroll> <token>
```
