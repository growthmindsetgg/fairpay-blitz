import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

// Amounts are integer micro-USDC. One currency. A payment row is keyed by
// (chain_id, tx_hash, log_index) so one on-chain payment can never settle two shares.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    table_no           INTEGER NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'cooking', 'served')),
    total              INTEGER NOT NULL CHECK (total > 0),
    created_at         INTEGER NOT NULL,
    paid_at            INTEGER,
    cooking_started_at INTEGER,
    ready_at           INTEGER
);

CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(id),
    item_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    unit_price INTEGER NOT NULL CHECK (unit_price > 0),
    qty        INTEGER NOT NULL CHECK (qty > 0),
    guest      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL REFERENCES orders(id),
    guest      INTEGER NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    paid       INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
    secret     TEXT NOT NULL,
    order_ref  TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL CHECK (status IN ('requested', 'executed', 'verified')),
    UNIQUE (order_id, guest)
);

CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY,
    share_id     TEXT NOT NULL REFERENCES shares(id),
    chain_id     INTEGER NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('public', 'private')),
    payer        TEXT NOT NULL,
    amount       INTEGER NOT NULL CHECK (amount > 0),
    block_number INTEGER NOT NULL,
    verified_at  INTEGER NOT NULL,
    UNIQUE (chain_id, tx_hash, log_index)
);

-- Payments the chain confirms for a share that were not credited to it (the share was already
-- paid, or the amount was wrong). The merchant holds these funds; staff refund them from here.
-- amount is TEXT because it is whatever the payer sent, not bounded by a share's price.
CREATE TABLE IF NOT EXISTS uncredited_payments (
    id           INTEGER PRIMARY KEY,
    share_id     TEXT NOT NULL REFERENCES shares(id),
    chain_id     INTEGER NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('public', 'private')),
    payer        TEXT NOT NULL,
    amount       TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    recorded_at  INTEGER NOT NULL,
    UNIQUE (chain_id, tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS faucet_claims (
    address    TEXT PRIMARY KEY,
    claimed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS order_items_by_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS payments_by_share ON payments (share_id);
CREATE INDEX IF NOT EXISTS orders_by_status ON orders (status, created_at);

-- Defence in depth for databases created before these rules were enforced in code: a share can
-- never be credited more than it costs, and a recorded payment is never rewritten or removed.
CREATE TRIGGER IF NOT EXISTS shares_paid_within_amount
BEFORE UPDATE OF paid ON shares
WHEN NEW.paid > NEW.amount OR NEW.paid < OLD.paid
BEGIN
    SELECT RAISE(ABORT, 'share paid out of range');
END;

CREATE TRIGGER IF NOT EXISTS payments_immutable
BEFORE UPDATE ON payments
BEGIN
    SELECT RAISE(ABORT, 'payments are append-only');
END;

CREATE TRIGGER IF NOT EXISTS payments_undeletable
BEFORE DELETE ON payments
BEGIN
    SELECT RAISE(ABORT, 'payments are append-only');
END;
`

/** SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY. */
export function isUniqueViolation(err: unknown) {
    const code = (err as { errcode?: number } | null)?.errcode
    return code === 2067 || code === 1555
}

export function openDb(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(SCHEMA)
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    if (fk.foreign_keys !== 1) throw new Error("SQLite foreign key enforcement is unavailable")
    return db
}

export type Db = ReturnType<typeof openDb>

/** Runs fn inside a transaction. node:sqlite is synchronous, so nothing else interleaves. */
export function tx<T>(db: Db, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE")
    try {
        const out = fn()
        db.exec("COMMIT")
        return out
    } catch (err) {
        // SQLite rolls back by itself on some errors (SQLITE_FULL, SQLITE_IOERR); a second
        // ROLLBACK would then throw and hide the original error.
        if (db.isTransaction) db.exec("ROLLBACK")
        throw err
    }
}
