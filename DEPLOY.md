# Deploy FairPay

FairPay has four parts in the cloud:

| Part | Where | What |
|---|---|---|
| Contracts | Monad Testnet (chain 10143) | Already deployed; no hosting needed. Addresses are in [README.md](README.md) and `packages/contracts/deployments/monadTestnet.json`. |
| Server | [Render](https://render.com), service `fairpay` | The FairPay API, built from `apps/fairpay/Dockerfile` by the `render.yaml` Blueprint. Live at https://fairpay-ed8y.onrender.com. |
| Database | [Supabase](https://supabase.com) (Postgres) | Every bill, order, payment and the indexers' progress. |
| Website and app pages | Vercel | https://fairpay.business, with the app at https://fairpay.business/pay/ and the simulated demo at `/app/`. |

People open the app on the website. Vercel serves the app's pages and forwards every `/api` request to the `fairpay` service on Render, so visitors never see a Render address. See [The website serves the app](#the-website-serves-the-app-pay).

The Docker image also runs on any host that runs containers (Railway, Fly.io, a VPS).

**Testnet only.** Use throwaway testnet keys. Never use a key that holds real funds.

## Before you start

1. **The server needs `DATABASE_URL` and `PUBLIC_ORIGIN`.** The image runs with `NODE_ENV=production`, and in production the server refuses to start without either one (`apps/fairpay/server/env.ts`, `apps/fairpay/server/origin.ts`). It says why in Render's Logs tab. Create the Supabase database first (next section). `PUBLIC_ORIGIN` is the website's address, `https://fairpay.business`, because that is where people open the app.
2. **Give each running server its own relayer and faucet wallets.** A server keeps its own transactions in order only inside its own process: the faucet sends one transaction at a time (`apps/fairpay/server/chain.ts`) and the SDK queues the relayer's sends per account (`packages/sdk/src/chain.ts`). Nothing coordinates two servers. If two servers (for example a local one and Render) send from the same wallet at the same moment, they can pick the same nonce and one transaction fails. A new wallet only needs some test MON. `RELAYER_KEY` and `FAUCET_KEY` must be different keys, or the server refuses to start.

## What it costs

- **Render:** the `fairpay` service runs on the free plan. Its data is in Supabase, so a restart or redeploy loses nothing. A free instance sleeps after 15 idle minutes, and the first visit after that is slow while it wakes (see [Keep it awake](#keep-it-awake-optional)).
- **Supabase:** the free tier is enough. Check [supabase.com/pricing](https://supabase.com/pricing).
- **Vercel:** the free tier is enough for the website.

## Create the database (Supabase)

Locally the app uses a built-in PGlite database in `apps/fairpay/data/pg`. In the cloud it uses Supabase. Everything the server keeps lives there, including the deposit indexer's progress (tables `pool_indexer_state` and `pool_deposits`), so the container needs no disk and a restarted instance resumes from the last saved block.

1. **Create the project.** Sign in at https://supabase.com, choose **New project**, and pick a region near the Render service (the Blueprint uses Frankfurt) and a strong database password. When it is ready, press **Connect** and copy the **Session pooler** connection string. It looks like `postgresql://postgres.<project>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.

   You don't need to create any tables. The server creates them on first start and locks every table against Supabase's public API (row level security on, no policies). Only the FairPay server can read or write.

2. **Supabase's CA certificate.** The server checks the database's TLS certificate, so nobody on the network path can pose as the database and read the password. Supabase signs its certificates with its own CA, so the server needs that CA as `DATABASE_CA`:
   - The repo has it: `apps/fairpay/certs/supabase-root-2021.crt` ("Supabase Root 2021 CA", valid to 2031, the same public certificate for every Supabase project, no key in it). Locally, put `DATABASE_CA=certs/supabase-root-2021.crt` in `apps/fairpay/.env`. A relative path is looked up in `apps/fairpay`, then the repo root.
   - You can also download it from the Supabase dashboard: **Project Settings → Database → SSL Configuration → Download certificate**.
   - `DATABASE_CA` takes either a file path or the certificate text (the lines from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`). On Render, use a secret file (step 3 below).
   - Without it the server refuses to start and says "DATABASE_CA is not set". With the wrong one it says "Could not verify the database's TLS certificate". Check that `DATABASE_URL` uses the host from Supabase's Connect dialog.

3. **Try it locally (optional).** Put `DATABASE_URL=...` and `DATABASE_CA=certs/supabase-root-2021.crt` in `apps/fairpay/.env`. `npm run check:db` connects once and says whether the database and its certificate are fine, without starting the server. `npm run dev:fairpay` then logs `database: supabase`. A local server with `DATABASE_URL` works on the live data, and with `RELAYER_KEY` it sends from the same relayer wallet as Render, so give it its own keys (see "Before you start").

The first start on a new database scans the privacy pool from its deploy block. Confidential payments work once that scan has caught up, which can take several minutes. Later restarts resume at once.

## Create the Render service

1. **Create a Render account** at [render.com](https://render.com) with your GitHub account. When Render asks which repositories it may read, choose `growthmindsetgg/fairpay-blitz`.

2. **Create the Blueprint.** Choose **New → Blueprint**, pick `growthmindsetgg/fairpay-blitz` and the branch `main`. Render reads `render.yaml` and shows one free web service, `fairpay`.

3. **Enter the settings.** Render asks for every value marked `sync: false`:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The Supabase Session pooler string from the section above. |
   | `DATABASE_CA` | `/etc/secrets/supabase-ca.crt`. Then, in the service's **Environment** tab under **Secret Files**, add a file named `supabase-ca.crt` with the contents of `apps/fairpay/certs/supabase-root-2021.crt`. (Or paste the certificate text itself as the value.) |
   | `PUBLIC_ORIGIN` | `https://fairpay.business`: the address people open the app at, no path, no trailing slash. |
   | `PROXY_SECRET` | Optional. The same value as the Vercel project's `PROXY_SECRET` (see [Proxy secret](#proxy-secret-optional)). |
   | `RELAYER_KEY` | Testnet wallet that submits confidential payments and pays their gas. |
   | `FAUCET_KEY` | Testnet wallet behind the faucet. A different key from `RELAYER_KEY`. |
   | `MERCHANT_ADDRESS` | Payout wallet of the demo restaurant. It must be allowlisted on FairPool. |
   | `DEMO_OWNER_WALLET` | Optional: your own wallet, so you can manage the demo restaurant. Defaults to `MERCHANT_ADDRESS`. |

   The Blueprint already sets `PUBLIC_APP_PATH=/pay` (share, order and invoice links are `PUBLIC_ORIGIN` + this path) and `TRUST_PROXY_HOPS=4` (see step 5). Optionally add `KEEPER_KEY` (the payroll escrow's auto-pay keeper, its own wallet) and `PAYMENT_CONFIRMATIONS`.

   Click **Apply**. The first build takes a few minutes. Set the service's health check path to `/api/health` if Render hasn't picked it up from `render.yaml`.

4. **Point the website at the service.** Copy the service's address from the top of its Render page. If it is not `https://fairpay-ed8y.onrender.com`, change the `/api/:path*` rewrite's destination in `apps/site/vercel.json` to it and publish the website again (`npm run deploy:vercel`).

   Sign-in messages must name exactly the address people open the app at, so a wrong `PUBLIC_ORIGIN` makes every sign-in fail. When the server starts it logs `Public origin: https://fairpay.business (app at /pay/)`; check that it matches. If the website moves to another domain, change `PUBLIC_ORIGIN` to it. With `PUBLIC_APP_PATH` set, the Render address doesn't show the app itself: its pages redirect to the website.

5. **Check the visitor address the server sees.** Rate limits count by visitor address, so the server must find the real one in `X-Forwarded-For`. `TRUST_PROXY_HOPS` is the number of proxies in front of the server that add to that header. Through the website there are 4: Vercel (2 hops), Cloudflare and Render's load balancer. Check it after deploying:

   ```bash
   curl https://fairpay.business/api/whoami
   ```

   It must show your own public IP address (search "what is my ip" to compare). If it shows another address, change `TRUST_PROXY_HOPS` by one and check again. Never set it higher than the real count, or visitors can choose their own rate-limit key.

   One gap remains: Vercel's external rewrite keeps a visitor's own `X-Forwarded-For`, so a visitor who sends one through the website can pick their per-address rate-limit key. The global caps still hold (faucet 60 claims an hour, 4 relays at a time). See SECURITY.md (S1).

6. **Check it works.** Open https://fairpay.business/api/config. It should say `"storage":"supabase"` and `"relayerReady":true`. Then open https://fairpay.business/pay/, sign in, and open Business > FairEats.

## The website serves the app (/pay/)

- **Pages.** `npm run build:vercel` also runs `npm run build:pay -w fairpay-app`, which builds the React app with Vite `base: "/pay/"` into `apps/fairpay/dist-site`. `apps/site/scripts/assemble.mjs` copies it to `apps/site/dist/pay`. The router reads its basename from the build, so `/pay/bills/new`, `/pay/b/<token>` and `/pay/r/<slug>` all work, and `apps/site/vercel.json` sends every `/pay/*` path to `/pay/index.html`. The ordinary build (`npm run build -w fairpay-app`, the Docker image and `npm run dev:fairpay`) serves the app at `/`.
- **API.** `apps/site/vercel.json` rewrites `/api/:path*` to `https://fairpay-ed8y.onrender.com/api/:path*`. To the browser the API is on the website's own origin, so the session cookie (`fp_session`, `HttpOnly`, `SameSite=Lax`, `Secure`), the `x-fairpay` CSRF header and Sign-In with Ethereum all work. Vercel is told not to cache these answers (`x-vercel-enable-rewrite-caching: 0`), and the server sends `Cache-Control: no-store`.
- **Server settings on Render.** `PUBLIC_ORIGIN=https://fairpay.business` (sign-in checks it), `PUBLIC_APP_PATH=/pay` (links) and `TRUST_PROXY_HOPS=4`. If the Render address changes, change the rewrite in `apps/site/vercel.json` and publish the website again.
- **Old addresses.** The site moved from the Vercel project's own `.vercel.app` address to the custom domain `fairpay.business` (both are domains of the Vercel project `fairpay-blitz`). The `redirects` in `apps/site/vercel.json` send every request for the old `.vercel.app` host or `www.fairpay.business` to `https://fairpay.business` with a permanent 308, same path and query, `/api/*` included, before any other route, so a stale tab can never sign in against an origin the server rejects.
- **Headers.** The landing page, guide and `/app/` demo keep a strict Content-Security-Policy. Only `/pay/*` gets what the app needs on top: `'wasm-unsafe-eval'` and `blob:` workers for the in-browser prover, and `connect-src` for the Monad testnet RPC (`https://testnet-rpc.monad.xyz`) and the proving files (`https://snark-artifacts.pse.dev`). These are the same rules the app's own server sends. If you change the server's `RPC_URL`, add the new RPC's origin to the `/pay` policy in `apps/site/vercel.json` too.
- **Waking up.** When the Render service is asleep, the app shows "Starting the server…" and keeps asking for up to three minutes. Every website page also pings `/api/health` once on load, so a sleeping instance starts waking early. Vercel waits up to 120 seconds for one answer ([Vercel](https://vercel.com/docs/errors/ROUTER_EXTERNAL_TARGET_ERROR)); Render usually wakes in about 50.

### Proxy secret (optional)

Without it, anyone who finds the Render address can call the API directly with a forged `X-Forwarded-For` and so step around the per-address rate limits (the overall limits still apply). With it, the server can tell requests that came through Vercel from ones that didn't, and reads the real address of each:

1. Make a long random value, for example with `openssl rand -hex 32`. It is not a wallet key, but keep it private.
2. In Vercel, open the project's **Settings → Environment Variables** and add `PROXY_SECRET` with that value (Production).
3. In Render, open the `fairpay` service's **Environment** tab and add `PROXY_SECRET` with the same value.
4. Publish the website: `npm run deploy:vercel`. It turns the header on by default (it runs `vercel-output.mjs` with `PROXY_SECRET_HEADER=1`). Vercel then adds `x-fairpay-proxy: <the secret>` to every request it forwards, filling it in itself, so the value never appears in the repository or the uploaded files ([Vercel: restricting your origin to Vercel traffic](https://vercel.com/docs/rewrites#restricting-your-origin-to-vercel-traffic)). If the Vercel project has no `PROXY_SECRET`, publish with `PROXY_SECRET_HEADER=0 npm run deploy:vercel` (PowerShell: `$env:PROXY_SECRET_HEADER=0; npm run deploy:vercel`).
5. Check `https://fairpay.business/api/whoami`. It must say `"proxy":"yes"` and show your own address. `"proxy":"no"` means the two values differ or the website was published without the header; nothing breaks, but every visitor then shares Vercel's addresses for rate limits, so fix it or remove `PROXY_SECRET` from Render. `"proxy":"off"` means Render has no `PROXY_SECRET`.

## Publish the website

`npm run deploy:vercel` checks the Vercel sign-in, builds the website with the app at `/pay/` and the simulated demo at `/app/` (`npm run build:vercel`), packs it with the proxy secret header on, and uploads it to production. It publishes to the Vercel project set in `apps/site/scripts/deploy.mjs` (`PROJECT_NAME`); change that to publish to your own. Run `npm run vercel:login` once per computer. The script installs a pinned Vercel CLI into `apps/site/.vercel/cli` (gitignored) instead of using `npx`, which can fail with npm `ECOMPROMISED` ("Lock compromised") on slow disks. `npm run deploy:vercel -- --skip-build` reuses the last build.

## After it is live

- **Updates:** every push to `main` rebuilds and redeploys the Render service. The website (and with it the app's pages at `/pay/`) changes only when you run `npm run deploy:vercel`.
- **Logs:** in the service's **Logs** tab. Keys are never written to the logs.
- **Gas:** the faucet and relayer wallets spend testnet MON. Each confidential payment costs the relayer about 0.15 MON (Monad charges the whole gas limit, about 1.44M), and the node wants about 0.26 MON on hand before it accepts one. Keep the faucet wallet above 10 MON so Monad's reserve-balance rule never blocks its transfers. Top the wallets up from a Monad testnet faucet when they run low or the logs show "insufficient balance".
- **Pausing:** use **Suspend** in the service settings. Deleting the service leaves its data in Supabase.
- **Backups:** the data is in your Supabase project, which backs it up.

### Keep it awake (optional)

A free Render instance sleeps after 15 idle minutes. To keep it awake, let Supabase call the health check every 10 minutes. In the Supabase SQL editor, enable the `pg_cron` and `pg_net` extensions, then run:

```sql
select cron.schedule('wake-fairpay', '*/10 * * * *',
  $$select net.http_get('https://fairpay-ed8y.onrender.com/api/health')$$);
```

That uses up to 744 of Render's 750 free hours a month, so run no other free Render service on the same account. Check recent runs with `select * from cron.job_run_details order by start_time desc limit 5`, and stop it with `select cron.unschedule('wake-fairpay')`.

## What is in the image

- **Built from:** `apps/fairpay/Dockerfile`, starting from `node:24-bookworm-slim`, built from the repo root. It runs a bundled server (`npm run build:server -w fairpay-app` → `apps/fairpay/dist-server/index.mjs`).
- **Never copied in:** `.dockerignore` keeps out every `.env` file, local databases (`**/data`, `*.db`) and `node_modules`. Keys and `DATABASE_URL` exist only in Render's settings.
- **Runs as:** the unprivileged `node` user. The image writes nothing to disk.
- **Listens on:** `0.0.0.0:8788` inside the container, reached only through Render's proxy. A local run listens on `127.0.0.1` only.
