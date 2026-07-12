-- Migration 0012 — permanent purchase ledger.
--
-- Records every deal the owner confirms they BOUGHT, so the dashboard can show
-- cumulative savings over time. Deliberately a STANDALONE table with NO foreign
-- key to deals/watchlist: it holds snapshot columns only, so it survives BOTH
-- the deal prune job (pruneDeals deletes by found_at) AND the watchlist
-- cascade-delete (deleteWatchlist hard-deletes deals WHERE watchlist_id=?).
-- Money is integer cents; bought_at is UTC.
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL,            -- snapshot of the bought listing (no UNIQUE/FK)
  card_name       TEXT    NOT NULL,
  expansion_name  TEXT,
  condition       TEXT,
  foil            INTEGER,                      -- 0/1
  language        TEXT,
  paid_cents      INTEGER NOT NULL,             -- = deal.price_cents
  saved_cents     INTEGER NOT NULL,             -- (second_cheapest_cents ?? baseline_cents) - price_cents
  currency        TEXT    NOT NULL,
  bought_at       TEXT    NOT NULL DEFAULT (datetime('now'))  -- UTC
);
CREATE INDEX IF NOT EXISTS idx_purchases_bought_at ON purchases(bought_at DESC);
