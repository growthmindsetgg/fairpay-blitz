# FairPay app: design and API

FairPay is a **bill-splitting app** for friends, with **optional confidential payments** on Monad
Testnet. A **Business** section in the sidebar lists platforms built on it. The first one is
**FairEats**: restaurants list themselves, guests order at a table, and the bill is paid one of two
ways (one person pays, or everyone pays their own share), with Indian GST invoices.

Design goals:
- Every "paid" state is **verified on-chain by the server**. Nothing is self-attested.
- Wallet sign-in with a nonce (SIWE, EIP-4361) → an httpOnly session. Only the server writes to the database (Supabase with RLS locked down).
- Bills have a **share link with a copy button**.
- The database schema is the single source of truth (`server/schema.sql`).
- Split types, a requests inbox, a staged transaction modal, a Normal/Confidential toggle, and honest privacy wording.
- A wallet picker (EIP-6963) and real error messages.

## What "confidential" means here (say it exactly this way in the UI)

A confidential payment goes through the FairPay privacy pool:
- **It hides who paid.** The payer's wallet is not linked to the payment.
- **It does not hide the amount.** Each note is exactly 5 USDC.
- **Recipients must be verified businesses.** FairPool pays only allowlisted merchants.

So:
- **Restaurant shares** can be paid privately when the restaurant's payout wallet is allowlisted. `Restaurant.privatePayments` and `PayTarget.private` report this.
- **Shares between friends** (bills) are paid publicly. The UI explains that confidential payments are for verified businesses today.
- **When the amount isn't a whole number of 5 USDC notes**, the last note pays a little more. The server records the difference as a tip to the recipient when it verifies that note, and the UI says so before paying. Nothing is stored in advance, so nobody can inflate someone else's share.

Never write "anonymous", "untraceable", or "hides the amount".

## Stack and layout (`apps/fairpay`)

- Server: Hono on Node, port 8788. Web: Vite + React 19 + react-router 7, port 5174, which proxies `/api`.
- Database: Postgres through `server/db.ts`.
  - With `DATABASE_URL` set: postgres.js connects to Supabase (ssl required).
  - Without it: PGlite, persisted in `data/pg`.
  - Tests use in-memory PGlite. `server/schema.sql` runs at startup (idempotent).
- Chain: `@fairpay/sdk` + viem. Deployment from `packages/contracts/deployments/monadTestnet.json`.
- Env: `apps/fairpay/.env`. It falls back to `apps/faireats/.env` for RELAYER_KEY, FAUCET_KEY and MERCHANT_ADDRESS. Never print or commit keys.
- Shared types: `shared/types.ts` (API shapes), `shared/gst.ts` (tax maths, used by server and browser), `shared/money.ts` (format/parse USDC).

## Code layout

| Area | Files |
|---|---|
| **Server core** | `server/env.ts`, `db.ts`, `ids.ts`, `auth.ts`, `http.ts` (errors, rate limits, security headers, CSRF), `chain.ts`, `app.ts`, `index.ts`, `routes/me.ts`, `routes/friends.ts`, `routes/activity.ts`, `routes/pay.ts`, `routes/chain.ts`, `shared/money.ts`, `test/core.test.ts`, `test/pay.test.ts`, `test/helpers.ts` |
| **Bills server** | `server/routes/bills.ts`, `server/bills.ts` (split maths), `test/bills.test.ts` |
| **FairEats server** | `server/routes/restaurants.ts`, `server/routes/orders.ts`, `server/routes/images.ts`, `server/faireats.ts`, `server/seed.ts`, `shared/gst.ts`, `public/menu/*`, `test/faireats.test.ts`, `test/gst.test.ts` |
| **Team pay server** | `server/routes/teamPay.ts`, `server/routes/payroll.ts`, `server/payroll.ts`, `server/transfers.ts`, `test/teamPay.test.ts`, `test/payroll.test.ts` |
| **Web core + bills** | `src/main.tsx`, `src/App.tsx`, `src/lib/*` (api, wallet, payments, notes, format), `src/components/*`, `src/pages/*` except `src/pages/business/*`, `src/styles/*` except `src/styles/business.css` |
| **FairEats web** | `src/pages/business/*`, `src/styles/business.css` |

The schema (`server/schema.sql`), `server/context.ts` and `shared/types.ts` are shared by all of them.

## Server wiring

`createApp(deps: Deps & { routes: RouteModule[] })` mounts each module under `/api`. A module looks like `export function billRoutes(deps: Deps): Hono<AppEnv>`, for example `billRoutes`, `restaurantRoutes`, `orderRoutes` and `imageRoutes`.

- **`auth.ts` middleware** reads the `fp_session` cookie and sets `c.var.wallet` (or null). It exports `requireWallet(c): Wallet`, which throws 401.
- **`http.ts`** exports `HttpError(status, message)`, `readJson(c, maxBytes)`, and the input checks `str(v, {min, max})`, `int(v, {min, max})`, `wallet(v)` and `bool(v)`.
  - Mutating requests (POST/PUT/PATCH/DELETE) must carry the header `x-fairpay: 1`, or the server answers 403. Custom headers force a CORS preflight and no CORS is allowed, so this blocks CSRF.
  - Errors are JSON `{ error: string }`.
- **`ids.ts`**:
  - `newId(prefix)` makes an id like `b_` plus 16 base32 characters from `crypto.randomBytes`.
  - `newToken()` makes a 32-byte base64url token.
  - `newOrderRef()` returns `{ orderRef, secret }`, using the SDK's `createOrderRef` and `randomSecret`.
- **`db.ts`** exports `openDb(): Promise<Db>`, which picks postgres.js or PGlite and applies `schema.sql`. It also exports `memoryDb()` for tests.
- **`chain.ts`** implements `Chain` and the relayer and faucet.
- **`test/helpers.ts`** exports:
  - `makeTestApp({ chain? })`, which returns `{ app, deps, signIn(wallet) }`.
  - `signIn(wallet)` inserts a session directly and returns the cookie header.
  - `fakeChain`, whose `verify` result and `isMerchant` set the test controls.

## API (all JSON, under `/api`)

Auth and profile:
- `GET  /config` → `PublicConfig`
- `GET  /whoami` → `{ ip, proxy }`: the address this caller's rate limits use, and whether the request came through the website's proxy (`"off"` without `PROXY_SECRET`, else `"yes"`/`"no"`). For checking `TRUST_PROXY_HOPS` (DEPLOY.md).
- `GET  /auth/nonce` → `{ nonce }`
- `POST /auth/verify {message, signature}`:
  - Checks the SIWE message's domain = host of PUBLIC_ORIGIN, uri origin = PUBLIC_ORIGIN, chainId 10143, an issuedAt no older than 10 min, and an unused nonce.
  - Verifies with viem's `verifySiweMessage`, which also handles smart-wallet ERC-1271 signatures.
  - Sets an `fp_session` cookie: httpOnly, SameSite=Lax, Secure when the origin is https, 7 days.
  - Returns `Me`.
- `POST /auth/logout`
- `GET  /me` → `Me` (401 if signed out)
- `PUT  /me {displayName?, email?, bio?}` → `Profile`
- `GET  /profiles/:wallet` → `{ wallet, displayName }` (public, no email)
- `GET/POST/DELETE /friends`
- `GET /activity`, `POST /activity/read`. A payment entry carries `txHash` (for an explorer link) only when it reports a public payment, matched to the single payment credited in the same moment for that bill or restaurant. Confidential payments never get one.

Payments, one endpoint set for both kinds; kind is `bill` or `order`:
- `GET  /pay/:kind/:id` → `PayTarget`. Bill shares need the viewer to be the creator, the participant, or the holder of the bill's share token (`?t=`). Order shares need the order's share token (`?t=`) or the viewer to be restaurant staff.
- `POST /pay/:kind/:id/round-up` answers 410: tips are settled automatically on the last private note.
- `PayTarget.expectedPayer` is shown only to that wallet, the bill creator and the recipient; others get `payerLocked: true`.
- `PayTarget.orderRef` is `null` unless the viewer may pay the share now: it is owed and open, and it is unbound, bound to the viewer, or payable confidentially. (The reference finds the share's payments on-chain, and a public payment names its payer.)
- An order share's recipient is the payout wallet saved on the order when it was placed (`orders.payout_wallet`), or the restaurant's current one when the order has none saved.
- `POST /pay/:kind/:id/settle {txHash}` → `SettleResult`:
  - Verifies with `chain.verify({txHash, orderRef, merchant: recipient, amount: due, expectedPayer})`. The chain needs `PAYMENT_CONFIRMATIONS` (default 2 on Monad testnet, 0 on 31337) before a payment counts; until then the answer is `pending` (HTTP 202) and the browser asks again.
  - A share that is paid, covered or closed, a payment from a wallet other than the seat's, and the part of a payment above what was left are never credited. The transaction is still checked, and a real payment gets a "Payment not counted" activity row (a cancelled order: "Refund needed") for the recipient or restaurant owner, once per transaction.
  - Records a `payments` row and updates `paid`/`status` in one transaction, under a per-target lock.
  - Afterwards:
    - When every bill participant is paid or covered, set `bills.status='settled'`.
    - When every order share is paid, set `orders.status='paid'`, `paid_at`, and an `est_ready_at` from the wait-time rule below.
  - Writes activity rows. A private payment's text never names the payer.
  - Idempotent: the same tx a second time returns `credited` with no double credit.
- `POST /relay` (private payment relayer), `GET /pool/commitments`, `POST /faucet {address}`, with the same rate limits as FairEats.

Bills:
- `POST /bills CreateBillInput` → `Bill` (signed in)
  - Split maths in `server/bills.ts`:
    - equal: an even split with the remainder in micro-USDC spread one unit at a time from the first person.
    - fixed: must sum to total.
    - percent: basis points summing to 10000, remainder to the last person.
    - shares: integer weights.
  - The creator is a participant with status `covered`, and so is anyone marked `alreadyPaid`.
  - At most 20 people.
  - An activity row goes to each participant with a wallet.
- `GET /bills` → `BillSummary[]` (mine: created or participating). Each summary has the viewer's `myParticipantId` and `canCancel` (creator, open, nobody has paid in-app), so lists can offer Pay, Remind and Cancel without loading every bill.
- `GET /bills/:id` (creator or participant) and `GET /b/:token` (anyone with the link; hides other participants' wallets, showing names and status only) → `Bill`
  - A participant paid publicly has `txHash` for an explorer link, for the creator and participants only: the transaction shows the payer's wallet, so link holders never get it. A seat with any private payment never gets one.
  - Someone who is not in the bill gets the same 404 as for a bill that doesn't exist.
- `POST /bills/:id/claim {participantId, t}`: a signed-in user with the link takes a name-only seat that has no wallet yet, still owes (`owed`, not `covered`) and has nothing paid. Anything else is a 409.
- `POST /bills/:id/seats/:participantId/release` (creator) → `Bill`: takes the wallet off a seat (claimed by the wrong person, or added with the wrong wallet). The name stays and the seat can be claimed again. Refused (409) for the creator's own seat and for a seat with any payment in FairPay. The bill page shows **Free this seat** to the creator.
- `POST /bills/:id/cancel` (creator, only while nobody has paid in-app)
- `POST /bills/:id/remind` (creator): adds an activity row for each unpaid participant. No email is sent.
- `GET /requests` → `{ incoming: BillSummary[], outgoing: BillSummary[] }`

FairEats:
- `GET  /restaurants` → `Restaurant[]` (public directory)
- `GET  /restaurants/:slug` → `StorefrontView` (public). Tables show status only, never order ids.
- `POST /restaurants` (signed in): register. The caller becomes the owner and the payout wallet defaults to them. The slug is taken from the name and must be unique. The invoice prefix comes from the name.
- `PUT  /restaurants/:id` (owner/manager; only the owner may change `payoutWallet`, and only to the wallet they are signed in with, which proves they control it; registering checks the same). Anything else is a 400.
- `GET  /restaurants/:id/manage` → `{ restaurant, menu, chefs, tables, staff, role }` (staff)
- `GET  /restaurants/:id/stats?range=today|7d|30d|mtd` → `RestaurantStats` (staff, like the orders list). Counted in SQL in India time by when orders were placed; the demo's sample orders are left out. `money` (public, confidential, tips) is the owner's only, null for other roles.
- `POST/PUT/DELETE /restaurants/:id/menu[/:itemId]` (owner/manager)
- `POST/PUT/DELETE /restaurants/:id/chefs[/:chefId]` (owner/manager)
- `POST/PUT/DELETE /restaurants/:id/tables[/:tableId]` (owner/manager). `PUT .../tables/:tableId/status {status}` is open to waiter, manager and owner. A table with an unserved order can't be set available.
- `GET/POST/DELETE /restaurants/:id/staff[/:wallet]` (owner; managers may add or remove chefs and waiters)
- `POST /restaurants/:id/images` (owner/manager): raw body up to 1 MB. At most 25 MB per restaurant (413) and 30 new images an hour per wallet and 60 per client address (429).
  - PNG, JPEG or WebP only, checked by magic bytes, never by the client's content-type.
  - Returns `{ url: "/api/images/<id>" }`.
- `GET  /images/:id`: served with the stored mime, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable`, and `Content-Security-Policy: default-src 'none'`.
- `POST /orders CreateOrderInput` (signed in or not):
  - Prices come from the database, never from the client.
  - The table must be available, and is then set to occupied with this order id.
  - One guest may hold at most 2 unpaid orders per restaurant: counted per signed-in wallet, or per client address without signing in (429 beyond that). The restaurant's own staff aren't capped. An order with nothing paid is cancelled after 15 minutes, which frees its table.
  - Saves the restaurant's payout wallet on the order; its shares are paid to that wallet.
  - Computes GST with `shared/gst.ts` and creates shares. one_pays → 1 share "Whole table". split → one share per guest, by items or equal.
  - Returns `{ order: Order, token }`. The client navigates to `/o/:id?t=token`.
- `GET  /orders/:id?t=` → `Order` (token holder or staff)
- `POST /orders/:id/split-bill {participants:[{wallet?, displayName}]}`:
  - Only for one_pays orders once paid. The caller must be the actual payer: the wallet that paid publicly (from the payments row), or for a private payment the signed-in wallet that placed the order.
  - Creates a bill (source `restaurant_order`, recipient = caller, split equal by default, or `items` using guest numbers) and sets `orders.split_bill_id`.
  - Inserts the bill directly with SQL; it does not go through the bills routes.
- `GET  /restaurants/:id/orders?status=` (staff) → `Order[]`
- `POST /orders/:id/status {status}` (staff):
  - The kitchen runs itself (`advanceKitchen` in `server/faireats.ts`): a fully paid, verified order starts cooking at once (`cooking_started_at` = `paid_at`, an on-duty chef as below), becomes ready when its cook time is up, and is served 1 minute after ready (which frees the table). It runs lazily on every read of the order, the kitchen list, the storefront, the manage view and the stats, and on payment; each step is one UPDATE guarded by status and time (idempotent, never backwards, never for unpaid orders) and records the time the step was due, so a server that slept catches up truthfully. The buttons below still let staff act earlier.
  - Chef: paid→cooking (sets `cooking_started_at`, `chef_id` = an on-duty chef if not set, `est_ready_at` = now + cook time) and cooking→ready.
  - Waiter: ready→served. Serving frees the table, setting it to available with no order.
  - Owner and manager can do any of these, and can cancel an order while awaiting payment, which frees the table.
- `GET  /i/:token` → `Invoice` (public, read-only, via the order's separate `invoice_token`; the share token can pay and split, so it is never used for invoices). Payment lines carry `txHash` only for restaurant staff and the wallet that placed the order, and never for a share that also had a confidential payment; a confidential line is labelled "Confidential payment", not with the guest's name.

Team pay (`server/routes/teamPay.ts`, `server/routes/payroll.ts`). Owner only unless marked; everyone else gets the same 404 as an unknown id:
- `GET /restaurants/:id/team-pay` → `TeamPayView`; `GET .../team-pay/payouts?before=`, `.../payouts.csv`; `POST .../team-pay {wallet, amount, note?, txHash}` records a direct USDC transfer from the owner's wallet after it verifies (202 while pending). `GET .../team-pay/mine` (staff): their own direct payouts.
- Payroll escrow (FairPayroll). Only when the deployment has `payroll`; otherwise 503 "The payroll escrow isn't set up on this server yet." (after the auth check) and `/config` has no `payroll`. Amounts are micro-USDC, times milliseconds.
  - `GET .../team-pay/escrow` → `EscrowView`: the owner's account (balance, available, owed, shortfall, fundedUntil, runwayUntil, payPerDay), each staff member's position, schedule, shift rate, auto-pay and pending shifts (plus people who left with pay or a schedule), pending and recently approved shifts, `fundingNeeded` suggestions for 7 and 30 days, `keeper`, `sharedWith` (other restaurants of the same owner wallet) and the first page of history. All read from the chain at one block.
  - `GET .../team-pay/escrow/history?before=&limit=` → `EscrowEventPage` (indexed events for the owner's wallet, newest first, without the repeating `Underfunded`).
  - `POST .../team-pay/shifts {wallet, workDate: "YYYY-MM-DD", minutes?, note?, amount}` → 201 `PayrollShift` (pending; staff only, whole cents, at most 500 pending). `DELETE .../team-pay/shifts/:shiftId` removes a pending one (409 once approved).
  - `POST .../team-pay/shifts/approve {txHash}` → `ShiftApproveResult`: after the owner's `approveShifts` transaction, marks approved exactly the pending shifts its `ShiftApproved` events match; 202 "pending" until confirmed, "rejected" when it approved none of this restaurant's shifts. The indexer also marks them from the chain.
  - `PUT .../team-pay/members/:wallet {shiftRate?: number | null, autoPay?: boolean}` (staff wallet). `autoPay: true` is a 409 without a keeper (`KEEPER_KEY`).
  - `GET .../team-pay/escrow/mine` (staff, or anyone with escrow shifts or events from this owner) → `MyEscrowView`; `GET .../escrow/mine/history?before=`.
  - The browser sends escrow transactions itself with the SDK (`fundPayroll`, `withdrawPayroll(max)`, `approveShifts`, `setPaySchedule` with start 0 for changes, `endPaySchedule`, `claimPay`, `resignPayroll`); the keeper uses `claimPayFor`.

**Invoice numbers:** assigned when the order is first fully paid. The format is `PREFIX/FY/000123`, where FY is the Indian financial year (Apr–Mar), e.g. `2026-27`, and the number comes from `restaurants.invoice_seq` incremented in the same transaction. A Tax Invoice needs a GSTIN; without one it's a Bill of Supply with no GST lines.

**Wait time rule** (`estimateReadyAt(db, orderId, now)` in `server/faireats.ts`, used by settle):
- cook time = the longest `prep_minutes` among the order's items, kept within 5 to 10 minutes (`COOK_MIN_MINUTES`, `COOK_MAX_MINUTES`); orders already in the kitchen don't add to it;
- est = now + cook time; an order is ready at `cooking_started_at` + cook time and served 1 minute later (`SERVE_AFTER_READY_MS`);
- unpaid orders show the same cook time as `expectedWaitMinutes`.

`Order.waitMinutes` is recomputed on read as `max(0, ceil((est_ready_at - now)/60000))`.

## GST rules (`shared/gst.ts`)

`computeBill({ lines: [{unitPrice, qty}], gstRateBps, serviceChargeBps, intraState: true })` → `{ subtotal, serviceCharge, taxable, cgst, sgst, igst, roundOff, total }`
- service charge = subtotal × bps / 10000, rounded to a cent (10000 micro). It is taxable.
- tax = taxable × rate. Intra-state: CGST = SGST = half the rate each, each rounded to a cent. Inter-state: IGST.
- round_off brings the total to a whole cent (it is usually 0). total = sum of all of the above.
- Also exports:
  - `STATE_CODES` (GST state codes: Karnataka 29, Maharashtra 27, Delhi 07, …, all states and UTs);
  - `isValidGstin(gstin)`, which checks format plus the check digit;
  - `amountInWords(micro)`, e.g. "Twenty-one USDC and fifty cents only".

Splitting an order's total across guests by items:
- each guest pays the fraction of the total that their items are of the subtotal, so service charge and tax are shared in proportion;
- largest remainder in whole cents: each exact share is rounded down, and the leftover cents go one each to the guests rounded down the most;
- no share is negative, and shares always sum to total (`splitOrder` throws otherwise, and the routes answer 409).

## Demo restaurant (`server/seed.ts`, runs at startup if no demo restaurant exists)

- **Saffron Table:** Indiranagar, Bengaluru, Karnataka. Demo GSTIN `29AAACF1234A1ZB` (with a valid check digit). FSSAI is a 14-digit demo number.
- GST 5%, service charge 0%.
- Owner = DEMO_OWNER_WALLET or MERCHANT_ADDRESS. Payout = MERCHANT_ADDRESS (already allowlisted for private payments). `is_demo = true`.
- 12 tables (labels 1–12; seats 2/4/6), with 3 seeded as occupied by a fake in-progress order so availability is visible.
- 2 chefs with bios (head chef and sous chef).
- About 10 menu items across Small plates, Mains, Sweet and Drinks, priced in USDC. Prices are set so dish + 5% GST lands on whole USDC.
- Each item has a bundled illustration at `public/menu/<id>.svg`. These are hand-made flat food illustrations in the brand palette, with no text and no external refs. Served as static files, they load through `<img>`, which is safe.

## Web app

Design: the FairPay brand (`apps/site/public/brand/BRAND.md`, the logos, and the self-hosted fonts in `apps/site/public/fonts`) and the website's design notes in `apps/site`.
- This is an app, not a landing page: dense, calm, legible.
- Sidebar on desktop, bottom nav on phones.
- Visible keyboard focus, reduced motion respected, no horizontal scroll at 360 px.
- No third-party requests: no Google Fonts, no CDNs.

Routes:
- `/`: home. When signed out: what FairPay does plus Connect wallet. When signed in: what you owe, what you're owed, recent bills, and a New bill button.
- `/bills/new`: create a split.
  - Simple (equal) / Advanced (fixed, percent, shares), with participants from friends or pasted addresses.
  - A live preview of each share; "already paid" toggles.
- `/bills/:id` and `/b/:token`: the bill.
  - Participants with status (Paid / Paid privately / Owes).
  - The Pay button opens `PayShare`. The creator also gets Copy link, Remind and Cancel.
- `/requests`: incoming/outgoing tabs. `/friends`, `/activity`.
- `/profile`: name, email and bio, the wallet, and the private notes balance with backup and restore.
  - Adding notes (here and from `PayShare`) uses the SDK's `depositNotes`: with `PublicConfig.batcher` set, one approval and one `FairPoolBatcher.depositMany` per 20 notes, or one atomic EIP-5792 batch on a wallet that supports it. The dialog says how many confirmations to expect ("Approve once, then confirm one deposit") and shows progress per transaction. Every note is saved in the browser before the first prompt; notes are dropped again only when nothing could have been sent (a declined prompt, or a refusal before any prompt).
  - Withdrawing a note ("Withdraw 5 USDC to my wallet", one note per click) uses the SDK's `withdrawNote`: the proof is built in the browser and the connected wallet sends `FairPool.withdraw` itself, so it is public and pays its own gas (about 0.15 MON). The note shares its nullifier with payments, so once withdrawn it is marked spent locally and on-chain (`nullifierSpent`). A pool without `withdraw` (checked with `WITHDRAW_REF`) keeps the button off. The server needs nothing new: `/pool/commitments` lists deposits only, and a `Withdrawal` is never counted as a payment.
- Sidebar section **Business** → **FairEats** (`/business/faireats`):
  - `/business/faireats`: directory of restaurants (cards: cover, cuisine, city, tables available of total, "Private payments" badge), plus **Register your restaurant**.
  - `/business/faireats/new`: registration form (name, cuisine, address, city, state dropdown, GSTIN optional with validation, FSSAI optional, tables count and seats).
  - `/business/faireats/manage/:id`: owner/staff dashboard with tabs:
    - **Overview:** tables total, available and occupied, then sales for Today / 7 days / 30 days / This month from `/stats`: revenue, paid orders, average order, guests, cancellations, revenue by day and busiest hours (inline SVG, `charts.tsx`), top dishes and table turnover; the owner also sees how the orders were paid (public, confidential, tips).
    - A wallet with restaurants that signs in on Home (or opens Home already signed in, once per tab session) is taken to its dashboard, or to "Your restaurants" when it has several (`src/lib/landing.ts`). Deep links are never redirected. Home also shows a "Your restaurant" card.
    - **Menu:** add, edit, reorder, availability, image upload with preview, veg/spice, prep time.
    - **Tables:** seat grid, set the status of each.
    - **Kitchen:** live orders board, polling every 5 s, with Start cooking / Ready / Served.
    - **Chefs:** profiles with photos.
    - **Staff:** add by wallet and role.
    - **Settings:** GST, GSTIN, service charge, payout wallet.

    Tabs the role can't use are hidden.
  - `/r/:slug`: storefront.
    - Cover, name, cuisine, chef cards, a "N of M tables free" grid (occupied tables shown unavailable), and a menu with images grouped by category.
    - A cart with per-guest assignment, then choose table, guests and payment mode ("One person pays" / "Everyone pays their share"), then Place order.
  - `/o/:id?t=`: order.
    - Status timeline (awaiting payment → paid → cooking → ready → served), chef card, and estimated wait in minutes.
    - Shares, each with a `PayShare` button and a copy-link for the others at the table.
    - For one_pays after payment: **Split with friends**, which creates a bill.
    - A link to the invoice.
  - `/i/:token`: printable GST invoice (Tax Invoice / Bill of Supply) with Copy link and Print. Print CSS is included.

**Shared components:**
- `PayShare({ kind, id, token?, onPaid })`:
  - Loads `GET /pay/...` and shows the amount, the recipient, and a Public/Confidential choice.
  - Confidential is disabled with the reason when it isn't possible, and states how many notes it uses and any tip.
  - Runs the payment with staged steps, then calls settle and retries while it's pending.
- `TxSteps` (staged modal), `Money` (formats micro-USDC), `CopyLink`, `WalletButton` (connect / sign in / account menu).
- `useMe()` (current user or null), and `api` in `src/lib/api.ts`, which always sends `x-fairpay: 1` and credentials.

**Wallet** (`src/lib/wallet.tsx`):
- Discover injected wallets with EIP-6963 (fall back to `window.ethereum`), plus "Test wallet in this browser" (a generated key in localStorage, testnet only, labelled as such).
- Switch to or add Monad Testnet.
- Sign in with SIWE: nonce → `createSiweMessage` → sign → `/auth/verify`.
- A faucet button for test USDC.

## Conventions

- TypeScript strict, 4-space indent, no semicolons, double quotes, short comments that explain why.
- Validate every input on the server and cap string lengths. Money is integers only. Never trust a client price or amount.
- Never log or return secrets, session tokens, note contents or order secrets. `secret` and `order_ref` stay server-side, except that a PayTarget returns `orderRef`, which the payer needs.
- Tests: vitest with in-memory PGlite and a fake chain. No network in tests.
