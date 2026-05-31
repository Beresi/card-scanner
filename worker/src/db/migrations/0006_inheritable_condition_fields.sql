-- Migration 0006 — make min_condition, foil_pref, importance, telegram_enabled
-- nullable §9a override columns on the watchlist table.
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0006_inheritable_condition_fields.sql
--
-- NOTE: SQLite cannot drop NOT NULL constraints or DEFAULT clauses in place.
-- Strategy: rebuild watchlist as watchlist_new with the corrected column
-- definitions, copy all rows preserving existing values (which become sticky
-- explicit overrides — they are NOT auto-nulled), drop old table, rename, and
-- recreate partial unique indexes.
--
-- This migration is one-shot; do not re-run against a DB that has already been
-- migrated.  Safe to skip if you are applying schema.sql from scratch.
--
-- Changes to watchlist:
--   min_condition      TEXT             (was NOT NULL DEFAULT 'Near Mint')
--   foil_pref          TEXT CHECK (...)  (was NOT NULL DEFAULT 'any' CHECK ...)
--   importance         TEXT CHECK (...)  (was NOT NULL DEFAULT 'normal' CHECK ...)
--   telegram_enabled   INTEGER           (was NOT NULL DEFAULT 0)
-- NULL on any of these now means "inherit from config at scan time" (§9a).
-- CHECKs on foil_pref and importance are preserved; NULL satisfies a CHECK.
-- allow_graded remains NOT NULL (no UI reset offered).

-- ─── watchlist table rebuild ──────────────────────────────────────────────────
-- SQLite cannot ALTER CHECK constraints or change column nullability in place.
-- Strategy: create watchlist_new with the full desired definition, copy all rows,
-- drop the old table, rename new → watchlist, then recreate indexes.

CREATE TABLE IF NOT EXISTS watchlist_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  type                        TEXT    NOT NULL CHECK (type IN ('blueprint','expansion','card')),
  cardtrader_id               INTEGER,                   -- blueprint_id or expansion_id; NULL for type='card'
  label                       TEXT    NOT NULL,          -- card or set name for display
  game_id                     INTEGER NOT NULL DEFAULT 1,
  -- §9a nullable override — NULL → inherit config.default_min_condition at scan time
  min_condition               TEXT,
  -- §9a nullable override — NULL → inherit config.new_ticket_foil_pref at scan time
  foil_pref                   TEXT    CHECK (foil_pref IN ('any','foil','nonfoil')),
  allow_graded                INTEGER NOT NULL DEFAULT 0,
  threshold_pct               INTEGER,                   -- NULL → use config.default_threshold_pct
  -- §9a nullable override — NULL → inherit config.new_ticket_importance at scan time
  importance                  TEXT    CHECK (importance IN ('high','normal')),
  -- §9a nullable override — NULL → inherit config.new_ticket_telegram_enabled at scan time
  telegram_enabled            INTEGER,
  telegram_min_discount_pct   INTEGER,                   -- NULL → use config.telegram_min_discount_pct
  telegram_max_price_cents    INTEGER,                   -- NULL → no cap
  telegram_min_savings_cents  INTEGER,                   -- NULL → no floor
  active                      INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- §9a nullable override columns (migration 0005)
  detection_mode              TEXT,                      -- NULL → use config.default_detection_mode ('discount'|'price')
  max_price_cents             INTEGER,                   -- NULL → use config.default_max_price_cents
  -- card-type identity columns (migration 0005)
  card_name_norm              TEXT,                      -- normalized name for type='card' items
  expansion_filter            TEXT                       -- JSON int array of expansion_ids; NULL/[] = all sets
);

-- Copy all existing rows, preserving every explicit value.
-- Existing rows keep their current min_condition / foil_pref / importance /
-- telegram_enabled values — these become sticky explicit overrides, NOT
-- auto-nulled.  Only truly new rows (created after this migration) will be
-- born NULL (inheriting).
INSERT INTO watchlist_new (
  id, type, cardtrader_id, label, game_id,
  min_condition, foil_pref, allow_graded, threshold_pct,
  importance, telegram_enabled,
  telegram_min_discount_pct, telegram_max_price_cents, telegram_min_savings_cents,
  active, created_at, updated_at,
  detection_mode, max_price_cents, card_name_norm, expansion_filter
)
SELECT
  id, type, cardtrader_id, label, game_id,
  min_condition, foil_pref, allow_graded, threshold_pct,
  importance, telegram_enabled,
  telegram_min_discount_pct, telegram_max_price_cents, telegram_min_savings_cents,
  active, created_at, updated_at,
  detection_mode, max_price_cents, card_name_norm, expansion_filter
FROM watchlist;

DROP TABLE watchlist;
ALTER TABLE watchlist_new RENAME TO watchlist;

-- Recreate partial unique indexes (same definitions as post-0005 state).

-- Partial unique index for blueprint/expansion items (those that have a cardtrader_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_id
  ON watchlist(type, cardtrader_id, foil_pref)
  WHERE cardtrader_id IS NOT NULL;

-- Partial unique index for card-type items keyed on normalized name + foil preference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_card
  ON watchlist(card_name_norm, foil_pref)
  WHERE type = 'card';
