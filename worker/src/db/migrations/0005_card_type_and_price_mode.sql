-- Migration 0005 — add card-type watchlist support + price-mode detection fields
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0005_card_type_and_price_mode.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN will error if the column already exists.
-- This migration is one-shot; do not re-run against a DB that has already been migrated.
-- Safe to skip if you are applying schema.sql from scratch (the columns are already there).
--
-- Changes:
--   config:    default_detection_mode, default_max_price_cents, catalog_sync_enabled,
--              catalog_max_exports_per_run
--   watchlist: REBUILT as watchlist_new — adds 'card' to the type CHECK, makes
--              cardtrader_id nullable (card items have no CardTrader id), adds
--              detection_mode, max_price_cents, card_name_norm, expansion_filter,
--              and replaces the inline UNIQUE(type,cardtrader_id,foil_pref) with two
--              partial unique indexes.
--   blueprints: name_norm TEXT + idx_blueprints_name_norm
--   expansions: blueprints_synced_at TEXT (catalog-sync cursor; NULL = not yet pulled)

-- ─── config additions ────────────────────────────────────────────────────────

-- default_detection_mode: §9a inheritable default; 'discount' matches existing behaviour.
ALTER TABLE config ADD COLUMN default_detection_mode TEXT NOT NULL DEFAULT 'discount';

-- default_max_price_cents: §9a inheritable default; NULL = no absolute cap.
ALTER TABLE config ADD COLUMN default_max_price_cents INTEGER;

-- catalog_sync_enabled: 0 = off (default); 1 = background sync active each cron run.
ALTER TABLE config ADD COLUMN catalog_sync_enabled INTEGER NOT NULL DEFAULT 0;

-- catalog_max_exports_per_run: how many blueprintsExport calls to make per cron tick.
-- Keep small (default 1) to stay within the free-tier 50-subrequest cap.
ALTER TABLE config ADD COLUMN catalog_max_exports_per_run INTEGER NOT NULL DEFAULT 1;

-- ─── watchlist table rebuild ──────────────────────────────────────────────────
-- SQLite cannot ALTER CHECK constraints or change column nullability in place.
-- Strategy: create watchlist_new with the full desired definition, copy all rows,
-- drop the old table, rename new → watchlist, then recreate indexes.

CREATE TABLE IF NOT EXISTS watchlist_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'card' added to type CHECK; cardtrader_id now nullable (card items have none)
  type                        TEXT    NOT NULL CHECK (type IN ('blueprint','expansion','card')),
  cardtrader_id               INTEGER,                   -- blueprint_id or expansion_id; NULL for type='card'
  label                       TEXT    NOT NULL,          -- card or set name for display
  game_id                     INTEGER NOT NULL DEFAULT 1,
  min_condition               TEXT    NOT NULL DEFAULT 'Near Mint',
  foil_pref                   TEXT    NOT NULL DEFAULT 'any' CHECK (foil_pref IN ('any','foil','nonfoil')),
  allow_graded                INTEGER NOT NULL DEFAULT 0,
  threshold_pct               INTEGER,                   -- NULL → use config.default_threshold_pct
  importance                  TEXT    NOT NULL DEFAULT 'normal' CHECK (importance IN ('high','normal')),
  telegram_enabled            INTEGER NOT NULL DEFAULT 0,
  telegram_min_discount_pct   INTEGER,                   -- NULL → use config.telegram_min_discount_pct
  telegram_max_price_cents    INTEGER,                   -- NULL → no cap
  telegram_min_savings_cents  INTEGER,                   -- NULL → no floor
  active                      INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- New §9a nullable override columns — NULL → inherit config at scan time
  detection_mode              TEXT,                      -- NULL → use config.default_detection_mode ('discount'|'price')
  max_price_cents             INTEGER,                   -- NULL → use config.default_max_price_cents
  -- New card-type identity columns
  card_name_norm              TEXT,                      -- normalized name for type='card' items
  expansion_filter            TEXT                       -- JSON int array of expansion_ids; NULL/[] = all sets
);

-- Copy all existing rows; new nullable columns default to NULL automatically.
INSERT INTO watchlist_new (
  id, type, cardtrader_id, label, game_id, min_condition, foil_pref,
  allow_graded, threshold_pct, importance, telegram_enabled,
  telegram_min_discount_pct, telegram_max_price_cents, telegram_min_savings_cents,
  active, created_at, updated_at
)
SELECT
  id, type, cardtrader_id, label, game_id, min_condition, foil_pref,
  allow_graded, threshold_pct, importance, telegram_enabled,
  telegram_min_discount_pct, telegram_max_price_cents, telegram_min_savings_cents,
  active, created_at, updated_at
FROM watchlist;

DROP TABLE watchlist;
ALTER TABLE watchlist_new RENAME TO watchlist;

-- Partial unique index for blueprint/expansion items (those that have a cardtrader_id).
-- Replaces the old inline UNIQUE(type, cardtrader_id, foil_pref).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_id
  ON watchlist(type, cardtrader_id, foil_pref)
  WHERE cardtrader_id IS NOT NULL;

-- Partial unique index for card-type items keyed on normalized name + foil preference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_card
  ON watchlist(card_name_norm, foil_pref)
  WHERE type = 'card';

-- ─── blueprints addition ─────────────────────────────────────────────────────

-- name_norm: normalized (lowercase, trimmed) card name for cross-set catalog search.
ALTER TABLE blueprints ADD COLUMN name_norm TEXT;

CREATE INDEX IF NOT EXISTS idx_blueprints_name_norm ON blueprints(name_norm);

-- ─── expansions addition ─────────────────────────────────────────────────────

-- blueprints_synced_at: UTC timestamp of the last blueprintsExport for this expansion.
-- NULL = not yet pulled into the local blueprint catalog (catalog-sync cursor).
ALTER TABLE expansions ADD COLUMN blueprints_synced_at TEXT;
