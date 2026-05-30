// Wire types — snake_case to match the JSON exactly.
// Money fields are integer cents (number). Booleans from D1 are 0|1.

export type Priority = 'high' | 'normal';
export type Foil = 0 | 1 | null;
export type DbBool = 0 | 1;
export type WatchItemType = 'blueprint' | 'expansion';
export type Theme = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type Importance = 'low' | 'normal' | 'high';
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'D';
export type FoilPref = 'any' | 'foil' | 'nonfoil';
export type ThemePalette = 'cyan' | 'obsidian' | 'matrix' | 'synthwave';
export type FontChoice = 'chakra' | 'orbitron' | 'rajdhani' | 'system';
export type ScanMode = 'chunked' | 'wholeset';

// ---------------------------------------------------------------------------
// Deal — the primary data type consumed by the Deal Feed view
// ---------------------------------------------------------------------------
export interface Deal {
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
  foil: Foil;
  can_sell_via_hub: DbBool | null;
  quantity: number | null;

  // Money — all integer cents; currency carried alongside
  price_cents: number;
  currency: string;
  baseline_cents: number;
  cohort_size: number;
  discount_pct: number;

  priority: Priority;
  buy_url: string | null;

  // SQLite UTC datetimes ('YYYY-MM-DD HH:MM:SS')
  found_at: string;

  seen: DbBool;
  dismissed: DbBool;
  telegram_sent: DbBool;
  telegram_sent_at: string | null;
}

// ---------------------------------------------------------------------------
// Config — the single-row config table
// ---------------------------------------------------------------------------
export interface Config {
  // Scan / deal detection
  default_threshold_pct: number;
  default_min_condition: string;
  cohort_size: number;
  min_cohort: number;
  currency: string;
  min_price_cents: number;
  min_savings_cents: number;

  // New-ticket defaults (displayed as inherit baseline in the watchlist inspector)
  new_ticket_foil_pref: FoilPref;
  new_ticket_allow_graded: DbBool;
  new_ticket_importance: Importance;
  new_ticket_telegram_enabled: DbBool;

  // Telegram
  telegram_min_discount_pct: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  digest_on_quiet_end: DbBool;

  // Display / UI
  theme: Theme;
  theme_palette: ThemePalette;
  font: FontChoice;
  accent_color: string;
  density: Density;

  // Scan mode
  scan_mode: ScanMode;
  scan_batch_size: number;

  // Maintenance
  deal_retention_days: number;
  timezone: string | null;

  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// WatchItem — one row of the watchlist table
// ---------------------------------------------------------------------------
export interface WatchItem {
  id: number;
  type: WatchItemType;
  cardtrader_id: number;
  label: string;
  game_id: number | null;

  // Override columns — NULL means "inherit from config"
  min_condition: string | null;
  foil_pref: FoilPref | null;
  allow_graded: DbBool | null;
  threshold_pct: number | null;
  importance: Importance | null;
  telegram_enabled: DbBool | null;
  telegram_min_discount_pct: number | null;
  telegram_max_price_cents: number | null;   // cents
  telegram_min_savings_cents: number | null; // cents

  active: DbBool;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Health — enriched shape returned by GET /api/health
// ---------------------------------------------------------------------------
export interface Health {
  ok: boolean;
  service: string;
  ts: string;
  db_ok: boolean;
  last_scan_at: string | null;
  last_scan_finished_at: string | null;
  last_scan_error: string | null;
  deals_found: number | null;
  telegram_sent: number | null;
  api_calls: number | null;
  // Chunked-scan progress (added with chunked-rotation backend)
  scan_mode: ScanMode;
  scan_total: number;
  scan_done: number;
}

// ---------------------------------------------------------------------------
// ScanRun — one row of the scan_runs table, returned by GET /api/scan/runs
// ---------------------------------------------------------------------------
export interface ScanRun {
  id: number;
  started_at: string;            // SQLite UTC datetime 'YYYY-MM-DD HH:MM:SS'
  finished_at: string | null;
  watch_items_scanned: number;
  blueprints_scanned: number;
  api_calls: number;
  deals_found: number;
  telegram_sent: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// WatchItemCreate — body for POST /api/watchlist
// Required core fields + optional override columns (omit to inherit from config)
// ---------------------------------------------------------------------------
export type WatchItemCreate = {
  type: WatchItemType;
  cardtrader_id: number;
  label: string;
  game_id?: number;
} & Partial<Pick<
  WatchItem,
  | 'min_condition'
  | 'foil_pref'
  | 'allow_graded'
  | 'threshold_pct'
  | 'importance'
  | 'telegram_enabled'
  | 'telegram_min_discount_pct'
  | 'telegram_max_price_cents'
  | 'telegram_min_savings_cents'
>>;

// ---------------------------------------------------------------------------
// ResettableField — the two columns that PATCH /api/watchlist/:id/reset accepts
// ---------------------------------------------------------------------------
export type ResettableField = 'threshold_pct' | 'telegram_min_discount_pct';

// ---------------------------------------------------------------------------
// Resolve — search results from the expansion / blueprint resolve cache
// ---------------------------------------------------------------------------

/** One expansion (set) result from GET /api/resolve/expansions?q= */
export interface ResolveExpansion {
  id: number;
  game_id: number;
  code: string;
  name: string;
}

/** One blueprint (card) result from GET /api/resolve/blueprints?expansion_id=&q= */
export interface ResolveBlueprint {
  id: number;
  expansion_id: number;
  name: string;
  image_url: string | null;
}

// ---------------------------------------------------------------------------
// ScanNowResult — response body of POST /api/scan/run-now
// ---------------------------------------------------------------------------
export interface ScanNowResult {
  ok: boolean;
  scan_run_id?: number;
  deals_found?: number;
  telegram_sent?: number;
  error?: string;
}
