/**
 * Shared D1 row types and derived shapes for the Card // Broker backend.
 *
 * THREE layers are distinguished:
 *  1. Raw D1 row types (`WatchlistRow`, `ConfigRow`) — columns exactly as
 *     SQLite returns them: booleans are `0 | 1`, nullable columns carry `| null`.
 *     These are what `repo.ts` receives from `.first()` / `.all()` before any
 *     conversion.  The repo converts `0 | 1` to real booleans at its boundary;
 *     types above this layer (e.g. `EffectiveSettings`) use real booleans.
 *  2. `EffectiveSettings` — the resolved, NULL-free shape produced by
 *     `resolveEffective(ticket, config)` (§9a).  Consumed by the deal engine
 *     and Telegram routing.
 *  3. `DealInsert` — what the scanner hands `repo.upsertDeal`.  Real JS types
 *     (boolean, number, string); the repo converts booleans back to 0/1 before
 *     binding to the D1 statement.
 *
 * Money is integer cents throughout — never floats.
 * All timestamp strings are UTC (`datetime('now')` in SQLite).
 *
 * PRD §9 / §9a; docs/documentation/data-model.md.
 */

import type { Condition } from '../scan/conditions';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type FoilPref = 'any' | 'foil' | 'nonfoil';

export type Importance = 'high' | 'normal';

/** Detection mode for deal evaluation (§9a inheritable). */
export type DetectionMode = 'discount' | 'price';

// ---------------------------------------------------------------------------
// Raw D1 row types
// ---------------------------------------------------------------------------

/**
 * Every column in the `watchlist` table, typed as D1 returns them.
 *
 * Nullability matches `schema.sql` exactly:
 *  - `threshold_pct`, `telegram_min_discount_pct`, `telegram_max_price_cents`,
 *    `telegram_min_savings_cents`, `detection_mode`, `max_price_cents`,
 *    `min_condition`, `foil_pref`, `importance`, `telegram_enabled` are nullable
 *    override columns (no `NOT NULL` in the DDL). NULL means "inherit from config
 *    at scan time" (§9a).
 *  - `card_name_norm` and `expansion_filter` are nullable; only populated for
 *    `type='card'` items.
 *  - `cardtrader_id` is nullable — card-type items have no CardTrader blueprint/
 *    expansion id.
 *  - `allow_graded` and `active` are `NOT NULL DEFAULT` — always present.
 *  - Boolean columns (`allow_graded`, `active`) are stored as `0 | 1`; nullable
 *    boolean columns (`telegram_enabled`) are stored as `0 | 1 | null`; the repo
 *    converts `0 | 1` to real booleans at its boundary.
 */
export interface WatchlistRow {
  id: number;
  type: 'blueprint' | 'expansion' | 'card';  // 'card' = watch by name across sets (migration 0005)
  cardtrader_id: number | null;               // blueprint_id or expansion_id; NULL for type='card'
  label: string;
  game_id: number;
  min_condition: string | null;     // §9a nullable override — NULL → inherit config.default_min_condition
  foil_pref: FoilPref | null;      // §9a nullable override — NULL → inherit config.new_ticket_foil_pref
  allow_graded: 0 | 1;             // NOT NULL DEFAULT 0
  threshold_pct: number | null;    // nullable — NULL → inherit config.default_threshold_pct
  importance: Importance | null;   // §9a nullable override — NULL → inherit config.new_ticket_importance
  telegram_enabled: 0 | 1 | null; // §9a nullable override — NULL → inherit config.new_ticket_telegram_enabled
  telegram_min_discount_pct: number | null;  // nullable — NULL → inherit config.telegram_min_discount_pct
  telegram_max_price_cents: number | null;   // nullable — NULL → no cap (no config fallback)
  telegram_min_savings_cents: number | null; // nullable — NULL → no floor (no config fallback)
  active: 0 | 1;                   // NOT NULL DEFAULT 1
  created_at: string;              // UTC TEXT, datetime('now')
  updated_at: string;              // UTC TEXT, datetime('now')
  // §9a nullable override columns (migration 0005)
  detection_mode: string | null;   // nullable — NULL → inherit config.default_detection_mode
  max_price_cents: number | null;  // nullable — NULL → inherit config.default_max_price_cents
  // Card-type identity columns (migration 0005; only set for type='card')
  card_name_norm: string | null;   // normalized name; NULL for non-card types
  expansion_filter: string | null; // JSON int array of expansion_ids; NULL/[] = all sets
}

/**
 * Every column in the `config` table (`id = 1` row), typed as D1 returns them.
 *
 * All columns are `NOT NULL` except `quiet_hours_start`, `quiet_hours_end`,
 * and `timezone` (no `NOT NULL` in the DDL).
 * Boolean columns (`new_ticket_allow_graded`, `new_ticket_telegram_enabled`,
 * `digest_on_quiet_end`) are stored as `0 | 1`.
 */
export interface ConfigRow {
  id: 1;

  // Deal-logic defaults (§9a — tickets with NULL override columns fall back here)
  default_threshold_pct: number;   // NOT NULL DEFAULT 50
  default_min_condition: string;   // NOT NULL DEFAULT 'Near Mint'
  cohort_size: number;             // NOT NULL DEFAULT 10
  min_cohort: number;              // NOT NULL DEFAULT 5

  // New-ticket form starters (pre-fill only; new tickets are born with override columns NULL)
  new_ticket_foil_pref: FoilPref;          // NOT NULL DEFAULT 'any'
  new_ticket_allow_graded: 0 | 1;          // NOT NULL DEFAULT 0
  new_ticket_importance: Importance;        // NOT NULL DEFAULT 'normal'
  new_ticket_telegram_enabled: 0 | 1;      // NOT NULL DEFAULT 0

  // Notification globals
  telegram_min_discount_pct: number;        // NOT NULL DEFAULT 60
  quiet_hours_start: number | null;         // nullable — 0-23 local hour, NULL = off
  quiet_hours_end: number | null;           // nullable
  digest_on_quiet_end: 0 | 1;              // NOT NULL DEFAULT 1

  // Appearance
  theme: 'light' | 'dark' | 'system';      // NOT NULL DEFAULT 'system', CHECK constraint
  accent_color: string;                     // NOT NULL DEFAULT '#f59e0b'
  density: 'comfortable' | 'compact';       // NOT NULL DEFAULT 'comfortable', CHECK constraint
  theme_palette: string;                    // NOT NULL DEFAULT 'cyan'
  font: string;                             // NOT NULL DEFAULT 'chakra'

  // Display currency (informational — no conversion; matches CardTrader account currency)
  currency: string;                        // NOT NULL DEFAULT 'USD'

  // Absolute deal floors (config-level, global)
  min_price_cents: number;                 // NOT NULL DEFAULT 200
  min_savings_cents: number;               // NOT NULL DEFAULT 100

  // Scan mode (migration 0003)
  scan_mode: string;                       // NOT NULL DEFAULT 'chunked' | 'wholeset'
  scan_batch_size: number;                 // NOT NULL DEFAULT 40

  // Maintenance / data
  deal_retention_days: number;             // NOT NULL DEFAULT 30
  timezone: string | null;                 // nullable DEFAULT 'Asia/Jerusalem'

  // Chunked scan cycle tracking (migration 0004)
  // NULL = no cycle started. Set at the start of each new sweep; reset when sweep completes.
  scan_cycle_started_at: string | null;

  // Detection-mode defaults + catalog controls (migration 0005)
  // default_detection_mode / default_max_price_cents are §9a inheritable defaults.
  default_detection_mode: string;          // NOT NULL DEFAULT 'discount' ('discount' | 'price')
  default_max_price_cents: number | null;  // nullable — NULL = no absolute cap
  catalog_sync_enabled: 0 | 1;            // NOT NULL DEFAULT 0
  catalog_max_exports_per_run: number;     // NOT NULL DEFAULT 1

  updated_at: string;                      // UTC TEXT, datetime('now')
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * The counter fields written to `scan_runs` when a run closes.
 * Also used by API route responses (GET /api/health, GET /api/scan/runs).
 */
export interface ScanCounts {
  watch_items_scanned: number;
  blueprints_scanned: number;
  api_calls: number;
  deals_found: number;
  telegram_sent: number;
}

/**
 * Every column in the `scan_runs` table, typed as D1 returns them.
 *
 * Used by GET /api/health (latest run) and GET /api/scan/runs (recent history).
 * `finished_at` and `error` are nullable — a run in progress has no finished_at;
 * a clean run has no error.  All count columns default to 0 in the schema.
 */
export interface ScanRunRow {
  id: number;
  started_at: string;           // UTC TEXT
  finished_at: string | null;   // UTC TEXT, NULL while run is in progress
  watch_items_scanned: number;
  blueprints_scanned: number;
  api_calls: number;
  deals_found: number;
  telegram_sent: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// §9a resolved shape
// ---------------------------------------------------------------------------

/**
 * Effective settings for a single watchlist item after §9a inheritance is
 * applied.  Produced by `resolveEffective(ticket, config)` — the ONE place
 * the inheritance rule lives.
 *
 * Contains NO nulls on the deal-logic or routing fields; the two Telegram cap
 * columns are `| null` because they have no config fallback (NULL = unbounded).
 *
 * Consumed by:
 *  - `scan/dealEngine` — min_condition, foil_pref, allow_graded, threshold_pct,
 *    cohort_size, min_cohort, detection_mode, max_price_cents (deal-logic fields).
 *  - `telegram/routing` — importance, telegram_enabled, telegram_min_discount_pct,
 *    telegram_max_price_cents, telegram_min_savings_cents (Phase-2 routing fields).
 *
 * Uses real JS booleans; booleans have already been converted from 0/1 by the
 * repo before this shape is constructed.
 */
export interface EffectiveSettings {
  min_condition: Condition;
  foil_pref: FoilPref;
  allow_graded: boolean;
  threshold_pct: number;
  cohort_size: number;         // from config only (no per-ticket override column)
  min_cohort: number;          // from config only (no per-ticket override column)
  min_price_cents: number;     // from config only — candidate must cost ≥ this
  min_savings_cents: number;   // from config only — baseline − candidate must be ≥ this
  importance: Importance;
  telegram_enabled: boolean;
  telegram_min_discount_pct: number;
  telegram_max_price_cents: number | null;    // null = no cap (no config fallback)
  telegram_min_savings_cents: number | null;  // null = no floor (no config fallback)
  // §9a inheritable detection-mode fields (migration 0005)
  detection_mode: DetectionMode;              // §9a — ticket ?? config.default_detection_mode
  max_price_cents: number | null;             // §9a — ticket ?? config.default_max_price_cents; null = no cap
}

// ---------------------------------------------------------------------------
// Deal insert shape
// ---------------------------------------------------------------------------

/**
 * What the scanner hands `repo.upsertDeal` for each candidate deal.
 * Maps to the insertable columns of the `deals` table.
 *
 * Uses real JS types (boolean, number, string) with `| null` where the column
 * is nullable in the schema.  The repo converts booleans to `0 | 1` before
 * binding to the D1 prepared statement.
 *
 * Money is integer cents (`price_cents`, `baseline_cents`).
 * `discount_pct` is the pre-computed integer percent (no float).
 */
export interface DealInsert {
  watchlist_id: number;
  blueprint_id: number;
  product_id: number;
  card_name: string;
  expansion_name: string | null;
  seller_username: string | null;
  seller_country: string | null;
  condition: string | null;
  language: string | null;
  foil: boolean | null;
  can_sell_via_hub: boolean | null;
  quantity: number | null;
  price_cents: number;        // integer cents, never float
  currency: string;
  baseline_cents: number;     // integer cents, never float
  cohort_size: number;
  discount_pct: number;       // integer percent
  priority: Importance;
  buy_url: string | null;
}

// ---------------------------------------------------------------------------
// Deal row (read shape from the `deals` table)
// ---------------------------------------------------------------------------

/**
 * Every column in the `deals` table, typed as D1 returns them.
 *
 * Boolean columns (`foil`, `can_sell_via_hub`, `seen`, `dismissed`,
 * `telegram_sent`) are stored as `0 | 1`; nullable columns carry `| null`.
 * Money is integer cents.  Timestamps are UTC strings.
 */
export interface DealRow {
  id: number;
  watchlist_id: number;
  blueprint_id: number;
  product_id: number;
  card_name: string;
  expansion_name: string | null;
  seller_username: string | null;
  seller_country: string | null;
  condition: string | null;
  language: string | null;
  foil: 0 | 1 | null;
  can_sell_via_hub: 0 | 1 | null;
  quantity: number | null;
  price_cents: number;
  currency: string;
  baseline_cents: number;
  cohort_size: number;
  discount_pct: number;
  priority: Importance;
  buy_url: string | null;
  found_at: string;            // UTC TEXT
  seen: 0 | 1;
  dismissed: 0 | 1;
  telegram_sent: 0 | 1;
  telegram_sent_at: string | null;
}

// ---------------------------------------------------------------------------
// Watchlist insert shape
// ---------------------------------------------------------------------------

/**
 * Shape for inserting a new watchlist row.
 *
 * Required: the identifying columns that the route must supply.
 *   - blueprint/expansion: type + cardtrader_id + label.
 *   - card: type + card_name_norm + label (cardtrader_id omitted / null).
 * Optional: columns that have NOT NULL DEFAULT values in the schema — the SQL
 *   INSERT omits absent ones so the DB defaults apply (born inheriting §9a).
 * All nullable §9a override columns default to NULL; new items are born inheriting.
 *
 * Boolean columns use `0 | 1` to match the row convention; the route layer
 * converts real JS booleans to 0/1 before constructing this type.
 */
export interface WatchlistInsert {
  // Required for all types
  type: 'blueprint' | 'expansion' | 'card';
  label: string;

  // Required for blueprint/expansion; omitted (or null) for card
  cardtrader_id?: number | null;

  // Required for card type; omitted for blueprint/expansion
  card_name_norm?: string | null;

  // Optional — schema provides NOT NULL DEFAULT values
  game_id?: number;
  min_condition?: string;
  foil_pref?: FoilPref;
  allow_graded?: 0 | 1;
  importance?: Importance;
  telegram_enabled?: 0 | 1;
  active?: 0 | 1;

  // §9a nullable override columns — NULL → inherit config at scan time
  threshold_pct?: number | null;
  telegram_min_discount_pct?: number | null;
  // §9a nullable override columns (migration 0005) — NULL → inherit config at scan time
  detection_mode?: string | null;
  max_price_cents?: number | null;

  // No-fallback nullable columns — NULL → no cap / no floor
  telegram_max_price_cents?: number | null;
  telegram_min_savings_cents?: number | null;

  // Card-type identity column (migration 0005) — JSON int array; NULL/[] = all sets
  expansion_filter?: string | null;
}

// ---------------------------------------------------------------------------
// Cache row shapes (expansions + blueprints tables)
// ---------------------------------------------------------------------------

/**
 * Row shape for the `expansions` cache table.
 * Used by `searchExpansions` and the add-card UX.
 */
export interface ExpansionRow {
  id: number;
  game_id: number;
  code: string | null;
  name: string | null;
  synced_at: string;
  /** UTC timestamp of last blueprintsExport for this expansion; NULL = not yet catalog-synced. */
  blueprints_synced_at: string | null;
}

/**
 * Row shape for the `blueprints` cache table.
 * Used by `searchBlueprints`, the add-card UX, and the chunked scan rotation.
 */
export interface BlueprintRow {
  id: number;
  expansion_id: number | null;
  name: string | null;
  /** Normalized (lowercase, trimmed) name for cross-set card-name search (migration 0005). */
  name_norm: string | null;
  image_url: string | null;
  /** UTC timestamp of last chunked-mode scan attempt; NULL = never scanned. */
  last_scanned_at: string | null;
}
