-- CardTrader Deal Scanner — D1 schema (PRD §9)
-- Apply with: npx wrangler d1 execute DB --file=src/db/schema.sql
-- All tables use CREATE TABLE IF NOT EXISTS so re-applying is safe (idempotent).
-- Migrations go in numbered files: src/db/NNNN_description.sql

-- ─── §9 DDL ──────────────────────────────────────────────────────────────────

-- What to scan.
-- Per-ticket override columns (threshold_pct, telegram_*, detection_mode,
-- max_price_cents, min_condition, foil_pref, importance, telegram_enabled)
-- are NULL = inherit from config at scan time. See §9a and resolveEffective().
-- New tickets keep these NULL; the new-ticket form is pre-filled from
-- config.new_ticket_* / config.default_* for display only.
-- type='card' items watch a card by name across sets; cardtrader_id is NULL
-- for those rows.  expansion_filter is a JSON int array (NULL/[] = all sets).
-- allow_graded is NOT NULL (no UI reset offered; not a §9a inheritable column).
CREATE TABLE IF NOT EXISTS watchlist (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'card' = watch by name across sets (cardtrader_id = NULL for these rows)
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

-- Partial unique index for blueprint/expansion items (those that have a cardtrader_id).
-- Replaces the pre-0005 inline UNIQUE(type, cardtrader_id, foil_pref).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_id
  ON watchlist(type, cardtrader_id, foil_pref)
  WHERE cardtrader_id IS NOT NULL;

-- Partial unique index for card-type items keyed on normalized name + foil preference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_card
  ON watchlist(card_name_norm, foil_pref)
  WHERE type = 'card';

-- Found deals — the in-app feed and the dedupe source of truth.
-- UNIQUE(product_id) enforces one deal row + one Telegram push per listing, ever.
-- Upserts must use ON CONFLICT(product_id) DO NOTHING; check meta.changes to find
-- truly-new rows (the ones to push to Telegram). See repo.ts / PRD §7/§13.
CREATE TABLE IF NOT EXISTS deals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id      INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  blueprint_id      INTEGER NOT NULL,
  product_id        INTEGER NOT NULL UNIQUE,          -- dedupe key
  card_name         TEXT    NOT NULL,
  expansion_name    TEXT,
  seller_username   TEXT,
  seller_country    TEXT,
  condition         TEXT,
  language          TEXT,
  foil              INTEGER,                          -- 0/1
  can_sell_via_hub  INTEGER,                          -- 0/1
  quantity          INTEGER,
  price_cents       INTEGER NOT NULL,                 -- integer cents, never float
  currency          TEXT    NOT NULL,
  baseline_cents    INTEGER NOT NULL,                 -- integer cents, never float
  cohort_size       INTEGER NOT NULL,
  discount_pct      INTEGER NOT NULL,
  priority          TEXT    NOT NULL DEFAULT 'normal', -- 'high' | 'normal'
  buy_url           TEXT,
  found_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  seen              INTEGER NOT NULL DEFAULT 0,        -- boolean: 0/1
  dismissed         INTEGER NOT NULL DEFAULT 0,        -- boolean: 0/1
  telegram_sent     INTEGER NOT NULL DEFAULT 0,        -- boolean: 0/1
  telegram_sent_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_found_at ON deals(found_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_open     ON deals(dismissed, found_at DESC);

-- Global config — EXACTLY ONE ROW, id = 1 (enforced by CHECK + the seed below).
-- Holds: (a) deal-logic defaults inherited by NULL-override tickets (§9a),
-- (b) starting values for the new-ticket form, (c) notification globals,
-- (d) appearance, (e) maintenance. All reads/patches target id = 1 only;
-- never INSERT a second row.
CREATE TABLE IF NOT EXISTS config (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),

  -- Deal-logic defaults (§9a — tickets whose override column is NULL fall back here)
  default_threshold_pct         INTEGER NOT NULL DEFAULT 50,
  default_min_condition         TEXT    NOT NULL DEFAULT 'Near Mint',
  cohort_size                   INTEGER NOT NULL DEFAULT 10,
  min_cohort                    INTEGER NOT NULL DEFAULT 5,

  -- Starting values for the new-ticket form (these pre-fill the UI; tickets are born
  -- with override columns NULL, referencing these defaults, not copying them in)
  new_ticket_foil_pref          TEXT    NOT NULL DEFAULT 'any',
  new_ticket_allow_graded       INTEGER NOT NULL DEFAULT 0,
  new_ticket_importance         TEXT    NOT NULL DEFAULT 'normal',
  new_ticket_telegram_enabled   INTEGER NOT NULL DEFAULT 0,

  -- Notification globals
  telegram_min_discount_pct     INTEGER NOT NULL DEFAULT 60,   -- stricter gate than app feed
  quiet_hours_start             INTEGER,                       -- 0-23 local hour, NULL = off
  quiet_hours_end               INTEGER,
  digest_on_quiet_end           INTEGER NOT NULL DEFAULT 1,    -- send held deals when quiet hours end

  -- Appearance
  theme                         TEXT    NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  accent_color                  TEXT    NOT NULL DEFAULT '#f59e0b',
  density                       TEXT    NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable','compact')),
  theme_palette                 TEXT    NOT NULL DEFAULT 'cyan',
  font                          TEXT    NOT NULL DEFAULT 'chakra',

  -- Display currency (informational — no conversion; should match CardTrader account currency)
  currency                      TEXT    NOT NULL DEFAULT 'USD',

  -- Absolute deal floors — both must hold in addition to the % threshold gate
  min_price_cents               INTEGER NOT NULL DEFAULT 200,  -- candidate must cost ≥ $2.00
  min_savings_cents             INTEGER NOT NULL DEFAULT 100,  -- baseline − candidate must be ≥ $1.00

  -- Scan mode (PRD §11 / migration 0003)
  -- 'chunked'  (default) — free-tier safe; rotates a batch of per-card calls each tick.
  -- 'wholeset' (paid fallback) — one big expansion call per item, self-throttled to ~hourly.
  scan_mode                     TEXT    NOT NULL DEFAULT 'chunked',
  -- Max per-card marketplace fetches per chunked run. Default 40 fits inside the free-tier
  -- 50-subrequest cap with headroom for /info + blueprintsExport warm-up calls.
  scan_batch_size               INTEGER NOT NULL DEFAULT 40,

  -- Maintenance / data
  deal_retention_days           INTEGER NOT NULL DEFAULT 30,   -- 0 = keep forever
  timezone                      TEXT             DEFAULT 'Asia/Jerusalem',

  -- Chunked scan cycle tracking (migration 0004)
  -- NULL = no cycle started yet. Reset each time a full sweep through all watched
  -- expansion blueprints completes (scanned_this_cycle >= total) or on first run.
  scan_cycle_started_at         TEXT,

  -- Detection-mode defaults + catalog controls (migration 0005)
  -- default_detection_mode / default_max_price_cents are §9a inheritable defaults.
  default_detection_mode        TEXT    NOT NULL DEFAULT 'discount',  -- 'discount' | 'price'
  default_max_price_cents       INTEGER,                              -- NULL = no absolute cap
  -- catalog_sync_enabled: 0 = off; 1 = background blueprintsExport sync each cron run.
  catalog_sync_enabled          INTEGER NOT NULL DEFAULT 0,
  -- catalog_max_exports_per_run: blueprintsExport calls per tick; keep ≤ free-tier cap.
  catalog_max_exports_per_run   INTEGER NOT NULL DEFAULT 1,

  updated_at                    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Observability — one row per scan run
CREATE TABLE IF NOT EXISTS scan_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at          TEXT,
  watch_items_scanned  INTEGER DEFAULT 0,
  blueprints_scanned   INTEGER DEFAULT 0,
  api_calls            INTEGER DEFAULT 0,
  deals_found          INTEGER DEFAULT 0,
  telegram_sent        INTEGER DEFAULT 0,
  error                TEXT
);

-- Caches — used by the add-card UX and display enrichment
CREATE TABLE IF NOT EXISTS expansions (
  id                    INTEGER PRIMARY KEY,            -- cardtrader expansion id
  game_id               INTEGER NOT NULL,
  code                  TEXT,
  name                  TEXT,
  synced_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  -- blueprints_synced_at: UTC timestamp of last blueprintsExport for this expansion.
  -- NULL = not yet pulled into the local blueprint catalog (catalog-sync cursor, migration 0005).
  blueprints_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS blueprints (
  id             INTEGER PRIMARY KEY,                   -- cardtrader blueprint id
  expansion_id   INTEGER,
  name           TEXT,
  -- name_norm: lowercase/trimmed name for cross-set catalog search (migration 0005).
  name_norm      TEXT,
  scryfall_id    TEXT,
  image_url      TEXT,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_scanned_at TEXT                                  -- NULL = never scanned (chunked mode cursor)
);

CREATE INDEX IF NOT EXISTS idx_blueprints_exp       ON blueprints(expansion_id);
CREATE INDEX IF NOT EXISTS idx_blueprints_name      ON blueprints(name);
-- Normalized-name index for cross-set card-name search (migration 0005).
CREATE INDEX IF NOT EXISTS idx_blueprints_name_norm ON blueprints(name_norm);
-- Rotation index for chunked scan: ORDER BY (last_scanned_at IS NULL) DESC, last_scanned_at ASC
CREATE INDEX IF NOT EXISTS idx_blueprints_exp_scanned ON blueprints(expansion_id, last_scanned_at);

-- ─── Config seed ─────────────────────────────────────────────────────────────
-- The config table enforces CHECK (id = 1) — exactly one row exists, always.
-- INSERT OR IGNORE skips if it already exists (safe to re-run).
-- All NOT NULL columns have DEFAULT values defined above, so specifying only id
-- is enough to materialize the full inheritance baseline.
INSERT OR IGNORE INTO config (id) VALUES (1);
