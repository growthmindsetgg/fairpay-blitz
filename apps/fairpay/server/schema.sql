-- FairPay platform schema. Plain Postgres: the same file runs on Supabase (as a migration) and on
-- local PGlite. Every statement is idempotent so it can run at every server start.
--
-- Conventions
--  * Wallet addresses are stored lowercase (CHECK enforced). Compare lowercase.
--  * Money is integer micro-USDC (6 decimals) in BIGINT. Never floats.
--  * Times are BIGINT unix milliseconds.
--  * Ids are short random strings made by the server (server/ids.ts), never sequential, so a URL
--    can't be guessed. Share links use a separate random token.
--  * RLS is enabled with no policies: Supabase's public API (anon/authenticated keys) can read or
--    write nothing. Only the FairPay server, connecting as the database owner, can.

CREATE TABLE IF NOT EXISTS profiles (
    wallet       TEXT PRIMARY KEY CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    display_name TEXT CHECK (char_length(display_name) <= 60),
    email        TEXT CHECK (char_length(email) <= 254),
    bio          TEXT CHECK (char_length(bio) <= 280),
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
);

-- Sign-in with Ethereum. A nonce is single use and expires after 10 minutes.
CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce      TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL,
    used_at    BIGINT
);

-- Only the SHA-256 of the session token is stored, so a database leak doesn't leak sessions.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    wallet     TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_wallet ON sessions (wallet);

CREATE TABLE IF NOT EXISTS friends (
    owner      TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
    wallet     TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    nickname   TEXT NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 60),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (owner, wallet),
    CHECK (owner <> wallet)
);

-- Notifications and history. Text is written by the server; a confidential payment's entry
-- never includes who paid.
CREATE TABLE IF NOT EXISTS activity (
    id         BIGSERIAL PRIMARY KEY,
    wallet     TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    kind       TEXT NOT NULL CHECK (kind IN ('bill_created', 'bill_request', 'payment_received', 'payment_sent', 'bill_settled', 'order_placed', 'order_update', 'staff_added')),
    title      TEXT NOT NULL,
    detail     TEXT,
    link       TEXT,
    read_at    BIGINT,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_by_wallet ON activity (wallet, created_at DESC);

-- ------------------------------------------------------------------ bill splitting (personal)

CREATE TABLE IF NOT EXISTS bills (
    id           TEXT PRIMARY KEY,
    creator      TEXT NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),
    -- Who participants pay. The creator's wallet, unless the bill came from a restaurant order
    -- where someone else paid (then it is that payer).
    recipient    TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
    title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    note         TEXT CHECK (char_length(note) <= 280),
    total        BIGINT NOT NULL CHECK (total > 0),
    split_type   TEXT NOT NULL CHECK (split_type IN ('equal', 'fixed', 'percent', 'shares', 'items')),
    status       TEXT NOT NULL CHECK (status IN ('open', 'settled', 'cancelled')),
    share_token  TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'restaurant_order')),
    order_id     TEXT,
    created_at   BIGINT NOT NULL,
    settled_at   BIGINT
);
CREATE INDEX IF NOT EXISTS bills_by_creator ON bills (creator, created_at DESC);

-- One row per person in a bill. wallet is NULL for someone added by name only; they can claim
-- the seat from the share link after signing in. status 'covered' means they owe nothing in-app
-- (the creator themself, or someone marked as already paid outside FairPay).
CREATE TABLE IF NOT EXISTS bill_participants (
    id           TEXT PRIMARY KEY,
    bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    wallet       TEXT CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
    amount       BIGINT NOT NULL CHECK (amount >= 0),
    -- Extra the payer agreed to add so the share is a whole number of private notes (5 USDC).
    -- It goes to the recipient. Only set before the first payment.
    tip          BIGINT NOT NULL DEFAULT 0 CHECK (tip >= 0),
    paid         BIGINT NOT NULL DEFAULT 0 CHECK (paid >= 0),
    status       TEXT NOT NULL CHECK (status IN ('owed', 'paid', 'covered')),
    order_ref    TEXT NOT NULL UNIQUE CHECK (order_ref ~ '^0x[0-9a-f]{64}$'),
    secret       TEXT NOT NULL,
    paid_at      BIGINT,
    CHECK (paid <= amount + tip),
    UNIQUE (bill_id, wallet)
);
CREATE INDEX IF NOT EXISTS participants_by_wallet ON bill_participants (wallet);

-- ------------------------------------------------------------------ FairEats (business)

CREATE TABLE IF NOT EXISTS images (
    id          TEXT PRIMARY KEY,
    restaurant_id TEXT,
    mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    bytes       BYTEA NOT NULL,
    size        INTEGER NOT NULL CHECK (size > 0 AND size <= 1048576),
    sha256      TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurants (
    id                 TEXT PRIMARY KEY,
    slug               TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 48),
    name               TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    tagline            TEXT CHECK (char_length(tagline) <= 140),
    description        TEXT CHECK (char_length(description) <= 1000),
    cuisine            TEXT CHECK (char_length(cuisine) <= 60),
    address            TEXT CHECK (char_length(address) <= 200),
    city               TEXT CHECK (char_length(city) <= 60),
    -- Indian state or union territory name, the place of supply for GST.
    state              TEXT NOT NULL CHECK (char_length(state) <= 60),
    -- 15-character GSTIN. NULL means not registered: the invoice is a "Bill of Supply" with no GST.
    gstin              TEXT CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
    fssai              TEXT CHECK (fssai ~ '^[0-9]{14}$'),
    -- GST rate in basis points. Restaurant service is 5% (500) without input tax credit.
    gst_rate_bps       INTEGER NOT NULL DEFAULT 500 CHECK (gst_rate_bps IN (0, 500, 1200, 1800)),
    service_charge_bps INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_bps BETWEEN 0 AND 2000),
    owner_wallet       TEXT NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
    payout_wallet      TEXT NOT NULL CHECK (payout_wallet ~ '^0x[0-9a-f]{40}$'),
    cover_image        TEXT,
    hours              TEXT CHECK (char_length(hours) <= 120),
    invoice_prefix     TEXT NOT NULL CHECK (invoice_prefix ~ '^[A-Z0-9]{2,6}$'),
    invoice_seq        INTEGER NOT NULL DEFAULT 0,
    is_demo            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         BIGINT NOT NULL
);

-- Owner is restaurants.owner_wallet and is not listed here.
--  manager: everything except staff owner-transfer and payout wallet
--  chef:    kitchen board (start cooking, mark ready)
--  waiter:  tables and orders (seat guests, mark served)
CREATE TABLE IF NOT EXISTS restaurant_staff (
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    wallet        TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    role          TEXT NOT NULL CHECK (role IN ('manager', 'chef', 'waiter')),
    display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
    added_at      BIGINT NOT NULL,
    PRIMARY KEY (restaurant_id, wallet)
);
CREATE INDEX IF NOT EXISTS staff_by_wallet ON restaurant_staff (wallet);

-- Public profile of a chef, shown to guests. Not an account (a chef may also be staff).
CREATE TABLE IF NOT EXISTS chefs (
    id            TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    title         TEXT CHECK (char_length(title) <= 60),
    bio           TEXT CHECK (char_length(bio) <= 400),
    specialty     TEXT CHECK (char_length(specialty) <= 80),
    years         INTEGER CHECK (years BETWEEN 0 AND 70),
    photo         TEXT,
    on_duty       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS menu_items (
    id            TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    description   TEXT CHECK (char_length(description) <= 280),
    category      TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 40),
    -- Price before GST, micro-USDC. Whole cents only (multiple of 10000).
    price         BIGINT NOT NULL CHECK (price > 0 AND price % 10000 = 0),
    -- "/api/images/<id>" for an upload, or a path under /menu/ for bundled art.
    image         TEXT,
    veg           BOOLEAN NOT NULL DEFAULT TRUE,
    spice         INTEGER NOT NULL DEFAULT 0 CHECK (spice BETWEEN 0 AND 3),
    prep_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (prep_minutes BETWEEN 1 AND 180),
    available     BOOLEAN NOT NULL DEFAULT TRUE,
    -- SAC for restaurant service.
    sac           TEXT NOT NULL DEFAULT '996331' CHECK (sac ~ '^[0-9]{4,8}$'),
    sort          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS menu_by_restaurant ON menu_items (restaurant_id, sort);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id            TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    label         TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 12),
    seats         INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 30),
    status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'reserved', 'closed')),
    order_id      TEXT,
    updated_at    BIGINT NOT NULL,
    UNIQUE (restaurant_id, label)
);

-- payment_mode
--  'one_pays': one share for the whole total. After paying, the payer can turn it into a bill so
--              the others pay them back (bills.source = 'restaurant_order', recipient = payer).
--  'split':    one share per guest; each pays the restaurant directly. Cooking starts when all
--              shares are paid.
CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    restaurant_id      TEXT NOT NULL REFERENCES restaurants(id),
    table_id           TEXT REFERENCES restaurant_tables(id),
    placed_by          TEXT CHECK (placed_by ~ '^0x[0-9a-f]{40}$'),
    guests             INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 20),
    payment_mode       TEXT NOT NULL CHECK (payment_mode IN ('one_pays', 'split')),
    status             TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'cooking', 'ready', 'served', 'cancelled')),
    subtotal           BIGINT NOT NULL CHECK (subtotal > 0),
    service_charge     BIGINT NOT NULL DEFAULT 0 CHECK (service_charge >= 0),
    -- Intra-state supply: CGST + SGST (half the rate each). Inter-state: IGST. Restaurants are
    -- almost always intra-state, so IGST is 0 unless the place of supply differs.
    cgst               BIGINT NOT NULL DEFAULT 0 CHECK (cgst >= 0),
    sgst               BIGINT NOT NULL DEFAULT 0 CHECK (sgst >= 0),
    igst               BIGINT NOT NULL DEFAULT 0 CHECK (igst >= 0),
    round_off          BIGINT NOT NULL DEFAULT 0,
    total              BIGINT NOT NULL CHECK (total > 0),
    gst_rate_bps       INTEGER NOT NULL,
    chef_id            TEXT,
    est_ready_at       BIGINT,
    invoice_no         TEXT UNIQUE,
    share_token        TEXT NOT NULL UNIQUE,
    split_bill_id      TEXT,
    created_at         BIGINT NOT NULL,
    paid_at            BIGINT,
    cooking_started_at BIGINT,
    ready_at           BIGINT,
    served_at          BIGINT,
    CHECK (total = subtotal + service_charge + cgst + sgst + igst + round_off)
);
CREATE INDEX IF NOT EXISTS orders_by_restaurant ON orders (restaurant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    unit_price BIGINT NOT NULL CHECK (unit_price > 0),
    qty        INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 50),
    guest      INTEGER NOT NULL CHECK (guest >= 1),
    sac        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_by_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_shares (
    id         TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    guest      INTEGER NOT NULL CHECK (guest >= 1),
    label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
    amount     BIGINT NOT NULL CHECK (amount > 0),
    tip        BIGINT NOT NULL DEFAULT 0 CHECK (tip >= 0),
    paid       BIGINT NOT NULL DEFAULT 0 CHECK (paid >= 0),
    status     TEXT NOT NULL CHECK (status IN ('owed', 'paid')),
    order_ref  TEXT NOT NULL UNIQUE CHECK (order_ref ~ '^0x[0-9a-f]{64}$'),
    secret     TEXT NOT NULL,
    paid_at    BIGINT,
    CHECK (paid <= amount + tip),
    UNIQUE (order_id, guest)
);

-- ------------------------------------------------------------------ payments (both kinds)

-- One verified on-chain payment, credited to a bill participant or an order share. Keyed by
-- (chain_id, tx_hash, log_index) so one transfer can never pay two things. Append-only.
CREATE TABLE IF NOT EXISTS payments (
    id           BIGSERIAL PRIMARY KEY,
    target_kind  TEXT NOT NULL CHECK (target_kind IN ('bill', 'order')),
    target_id    TEXT NOT NULL,
    chain_id     INTEGER NOT NULL,
    tx_hash      TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index    INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('public', 'private')),
    -- For a private payment this is the pool contract, never the person.
    payer        TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    amount       BIGINT NOT NULL CHECK (amount > 0),
    block_number BIGINT NOT NULL,
    verified_at  BIGINT NOT NULL,
    UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS payments_by_target ON payments (target_kind, target_id);

CREATE OR REPLACE FUNCTION fairpay_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'payments are append-only';
END
$$;
DROP TRIGGER IF EXISTS payments_no_update ON payments;
CREATE TRIGGER payments_no_update BEFORE UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION fairpay_append_only();

-- Read-only invoice link, separate from the order's share token (which can pay and split).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_token TEXT;
UPDATE orders SET invoice_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') WHERE invoice_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_token ON orders (invoice_token);

-- The restaurant's payout wallet when the order was placed. Guests are shown this address, so
-- payments are verified against it even if the owner changes the payout wallet mid-order. NULL
-- for orders placed before the column existed: those use the restaurant's current payout wallet.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payout_wallet TEXT CHECK (payout_wallet ~ '^0x[0-9a-f]{40}$');

-- ------------------------------------------------------------------ privacy-pool deposit indexer

-- The deposit indexer's progress (server/chain.ts), one row per pool, so a restart or a free-plan
-- instance waking up with an empty disk resumes where it stopped instead of rescanning the pool
-- from its deploy block. last_block is the last block fully scanned (NULL: start at the deploy
-- block). Saves lock this row; last_block only moves back when the indexer rewinds on purpose
-- (a reorg or a missing deposit).
CREATE TABLE IF NOT EXISTS pool_indexer_state (
    chain_id   INTEGER NOT NULL,
    pool       TEXT NOT NULL CHECK (pool ~ '^0x[0-9a-f]{40}$'),
    last_block BIGINT CHECK (last_block >= 0),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (chain_id, pool)
);

-- Every pool deposit the indexer has seen, by leaf index. Public on-chain data (the commitment is
-- a decimal field element), served to browsers, which check it against the pool's root.
CREATE TABLE IF NOT EXISTS pool_deposits (
    chain_id     INTEGER NOT NULL,
    pool         TEXT NOT NULL CHECK (pool ~ '^0x[0-9a-f]{40}$'),
    idx          INTEGER NOT NULL CHECK (idx >= 0),
    commitment   TEXT NOT NULL CHECK (commitment ~ '^[0-9]{1,78}$'),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    PRIMARY KEY (chain_id, pool, idx)
);

-- ------------------------------------------------------------------ Team pay (owner pays staff)

-- One verified ERC-20 transfer of the deployment's token from a restaurant's owner to one of its
-- staff, sent straight from the owner's wallet (routes/teamPay.ts). Public on-chain: the owner's
-- wallet, the staff wallet and the amount. The name and role are copied at payment time so the
-- history still reads right after someone leaves the staff. Keyed like payments, append-only.
CREATE TABLE IF NOT EXISTS team_payouts (
    id             BIGSERIAL PRIMARY KEY,
    restaurant_id  TEXT NOT NULL REFERENCES restaurants(id),
    chain_id       INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index      INTEGER NOT NULL CHECK (log_index >= 0),
    payer          TEXT NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
    recipient      TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
    recipient_name TEXT NOT NULL CHECK (char_length(recipient_name) BETWEEN 1 AND 60),
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('manager', 'chef', 'waiter')),
    amount         BIGINT NOT NULL CHECK (amount > 0),
    note           TEXT CHECK (char_length(note) <= 140),
    block_number   BIGINT NOT NULL CHECK (block_number >= 0),
    verified_at    BIGINT NOT NULL,
    UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS team_payouts_by_restaurant ON team_payouts (restaurant_id, id DESC);
CREATE INDEX IF NOT EXISTS team_payouts_by_recipient ON team_payouts (recipient, restaurant_id, id DESC);
DROP TRIGGER IF EXISTS team_payouts_no_update ON team_payouts;
CREATE TRIGGER team_payouts_no_update BEFORE UPDATE OR DELETE ON team_payouts
    FOR EACH ROW EXECUTE FUNCTION fairpay_append_only();

-- ------------------------------------------------------------------ Team pay part 2: payroll escrow
-- Only used when the deployment has a FairPayroll contract (server/payroll.ts). The escrow itself
-- is on-chain; these tables hold the event history, pending shifts and the owner's settings.

-- How far the FairPayroll event indexer got, so a restart resumes instead of rescanning.
CREATE TABLE IF NOT EXISTS payroll_indexer_state (
    chain_id   INTEGER NOT NULL,
    contract   TEXT NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
    last_block BIGINT CHECK (last_block >= 0),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (chain_id, contract)
);

-- Every FairPayroll event the indexer read from confirmed blocks. Public on-chain data. Amounts are
-- decimal strings (uint256); `args` holds every argument the same way.
CREATE TABLE IF NOT EXISTS payroll_events (
    id           BIGSERIAL PRIMARY KEY,
    chain_id     INTEGER NOT NULL,
    contract     TEXT NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_time   BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index    INTEGER NOT NULL CHECK (log_index >= 0),
    event        TEXT NOT NULL CHECK (event IN ('Funded', 'Withdrawn', 'ShiftApproved', 'ScheduleSet', 'ScheduleEnded', 'Claimed', 'Shortfall', 'Underfunded', 'DebtBacked', 'DebtRepaid', 'Resigned')),
    employer     TEXT NOT NULL CHECK (employer ~ '^0x[0-9a-f]{40}$'),
    employee     TEXT CHECK (employee ~ '^0x[0-9a-f]{40}$'),
    caller       TEXT CHECK (caller ~ '^0x[0-9a-f]{40}$'),
    shift_id     TEXT CHECK (shift_id ~ '^0x[0-9a-f]{64}$'),
    amount       TEXT NOT NULL CHECK (amount ~ '^[0-9]{1,78}$'),
    args         JSONB NOT NULL,
    UNIQUE (chain_id, contract, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS payroll_events_by_employer ON payroll_events (chain_id, contract, employer, id DESC);
CREATE INDEX IF NOT EXISTS payroll_events_by_employee ON payroll_events (chain_id, contract, employee, employer, id DESC);
DROP TRIGGER IF EXISTS payroll_events_no_update ON payroll_events;
CREATE TRIGGER payroll_events_no_update BEFORE UPDATE OR DELETE ON payroll_events
    FOR EACH ROW EXECUTE FUNCTION fairpay_append_only();

-- Shifts the owner entered for a staff member. 'pending' until the chain shows the owner's
-- ShiftApproved event for exactly this shift_id, employee and amount; then 'approved' with its proof.
-- shift_id is keccak256 of a random server id, unique per (chain, contract, employer).
CREATE TABLE IF NOT EXISTS payroll_shifts (
    id                 TEXT PRIMARY KEY,
    restaurant_id      TEXT NOT NULL REFERENCES restaurants(id),
    chain_id           INTEGER NOT NULL,
    contract           TEXT NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
    employer           TEXT NOT NULL CHECK (employer ~ '^0x[0-9a-f]{40}$'),
    employee           TEXT NOT NULL CHECK (employee ~ '^0x[0-9a-f]{40}$'),
    employee_name      TEXT NOT NULL CHECK (char_length(employee_name) BETWEEN 1 AND 60),
    shift_id           TEXT NOT NULL CHECK (shift_id ~ '^0x[0-9a-f]{64}$'),
    work_date          TEXT NOT NULL CHECK (work_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    minutes            INTEGER CHECK (minutes BETWEEN 1 AND 1440),
    note               TEXT CHECK (char_length(note) <= 140),
    amount             BIGINT NOT NULL CHECK (amount > 0),
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
    created_at         BIGINT NOT NULL,
    approved_tx        TEXT CHECK (approved_tx ~ '^0x[0-9a-f]{64}$'),
    approved_block     BIGINT,
    approved_log_index INTEGER,
    approved_at        BIGINT,
    UNIQUE (chain_id, contract, employer, shift_id)
);
CREATE INDEX IF NOT EXISTS payroll_shifts_by_restaurant ON payroll_shifts (restaurant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_shifts_by_employee ON payroll_shifts (employee, restaurant_id, created_at DESC);

-- The owner's per-person settings: a default amount per shift, and auto-pay (the keeper calls
-- claimFor for this person when they have something to claim). Off unless the owner turns it on.
CREATE TABLE IF NOT EXISTS payroll_settings (
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    wallet        TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
    shift_rate    BIGINT CHECK (shift_rate > 0),
    auto_pay      BOOLEAN NOT NULL DEFAULT false,
    updated_at    BIGINT NOT NULL,
    PRIMARY KEY (restaurant_id, wallet)
);

-- Lock down Supabase's public API. Harmless on plain Postgres.
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE chefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_indexer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_indexer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
