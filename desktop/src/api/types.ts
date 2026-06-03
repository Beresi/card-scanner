// Wire types — snake_case to match the JSON exactly.
// Money fields are integer cents (number). Booleans from D1 are 0|1.

export type Priority = 'high' | 'normal';
export type Foil = 0 | 1 | null;
export type DbBool = 0 | 1;
export type WatchItemType = 'blueprint' | 'expansion' | 'card';
export type DetectionMode = 'discount' | 'price';
export type Theme = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type Importance = 'low' | 'normal' | 'high';
export type Condition =
  | 'Mint'
  | 'Near Mint'
  | 'Slightly Played'
  | 'Moderately Played'
  | 'Played'
  | 'Heavily Played'
  | 'Poor';
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
  // 2nd-cheapest qualifying copy at scan time (gap-gate baseline); NULL on legacy rows.
  second_cheapest_cents: number | null;
  // % the candidate was below second_cheapest_cents; NULL on legacy rows, 0 in price mode.
  gap_pct: number | null;
  cohort_size: number;
  discount_pct: number;

  priority: Priority;
  buy_url: string | null;

  // SQLite UTC datetimes ('YYYY-MM-DD HH:MM:SS')
  found_at: string;

  seen: DbBool;
  dismissed: DbBool;
  // Lifecycle (migration 0009): 'open' = active; 'sold' = listing gone;
  // 'expired' = still listed but no longer the qualifying candidate.
  status: 'open' | 'sold' | 'expired';
  retired_at: string | null;
  telegram_sent: DbBool;
  telegram_sent_at: string | null;
}

// ---------------------------------------------------------------------------
// Config — the single-row config table
// ---------------------------------------------------------------------------
export interface Config {
  // Scan / deal detection
  default_discount_pct: number;
  default_min_condition: string;
  cohort_size: number;
  min_cohort: number;
  // §9a inheritable gap gate (migration 0009): min % the cheapest copy must be
  // below the 2nd-cheapest qualifying copy.
  default_min_gap_pct: number;
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

  // Detection mode defaults (§9a inheritable per-ticket)
  default_detection_mode: DetectionMode;
  default_max_price_cents: number | null;

  // Catalog sync
  catalog_sync_enabled: DbBool;
  catalog_max_exports_per_run: number;

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
  cardtrader_id: number | null;
  label: string;
  game_id: number | null;

  // Override columns — NULL means "inherit from config"
  min_condition: string | null;
  foil_pref: FoilPref | null;
  allow_graded: DbBool | null;
  min_discount_pct: number | null;
  // §9a override (NULL = inherit config.default_min_gap_pct)
  min_gap_pct: number | null;
  importance: Importance | null;
  telegram_enabled: DbBool | null;
  telegram_min_discount_pct: number | null;
  telegram_max_price_cents: number | null;   // cents
  telegram_min_savings_cents: number | null; // cents

  // Detection mode override (NULL = inherit config.default_detection_mode)
  detection_mode: DetectionMode | null;
  // Absolute-price cap override (NULL = inherit config.default_max_price_cents)
  max_price_cents: number | null;

  // Card-type fields (only populated when type === 'card')
  card_name_norm: string | null;
  // JSON-serialised int[] of expansion_ids; NULL/empty = all sets
  expansion_filter: string | null;
  // Derived server-side (not a stored column): a representative blueprint id for
  // a card-type watch, matched from the catalog by card_name_norm. Used to build
  // the /cards/{id}/versions link. NULL when the card's set isn't synced yet.
  repr_blueprint_id?: number | null;

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
  // Count of active watch items — optional so older workers stay compatible
  active_watch_count?: number;
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
//
// Three variants:
//   blueprint/expansion — require cardtrader_id
//   card                — require card_name; expansion_filter is optional int[]
// ---------------------------------------------------------------------------

/** Shared optional override columns — omit to inherit from config (§9a born-inheriting) */
type WatchItemOverrides = Partial<Pick<
  WatchItem,
  | 'min_condition'
  | 'foil_pref'
  | 'allow_graded'
  | 'min_discount_pct'
  | 'min_gap_pct'
  | 'importance'
  | 'telegram_enabled'
  | 'telegram_min_discount_pct'
  | 'telegram_max_price_cents'
  | 'telegram_min_savings_cents'
  | 'detection_mode'
  | 'max_price_cents'
>>;

/** POST body for blueprint or expansion items (cardtrader_id required) */
export type WatchItemCreateBlueprintOrExpansion = {
  type: 'blueprint' | 'expansion';
  cardtrader_id: number;
  label: string;
  game_id?: number;
} & WatchItemOverrides;

/** POST body for card items (watched by name across printings; no cardtrader_id) */
export type WatchItemCreateCard = {
  type: 'card';
  card_name: string;
  /** Optional set restriction — int[] of expansion_ids; omit/empty = all sets */
  expansion_filter?: number[];
  label?: string;
  game_id?: number;
} & WatchItemOverrides;

export type WatchItemCreate = WatchItemCreateBlueprintOrExpansion | WatchItemCreateCard;

// ---------------------------------------------------------------------------
// WatchItemPatch — body for PATCH /api/watchlist/:id
// All fields optional; detection_mode/max_price_cents can be sent as null to reset to inherit
// ---------------------------------------------------------------------------
export type WatchItemPatch = Partial<Pick<
  WatchItem,
  | 'label'
  | 'active'
  | 'min_condition'
  | 'foil_pref'
  | 'allow_graded'
  | 'min_discount_pct'
  | 'min_gap_pct'
  | 'importance'
  | 'telegram_enabled'
  | 'telegram_min_discount_pct'
  | 'telegram_max_price_cents'
  | 'telegram_min_savings_cents'
  | 'detection_mode'
  | 'max_price_cents'
>> & {
  /** Pass number[] to set; pass null to clear (all sets); omit to leave unchanged */
  expansion_filter?: number[] | null;
};

// ---------------------------------------------------------------------------
// ResettableField — columns that PATCH /api/watchlist/:id/reset accepts
// ---------------------------------------------------------------------------
export type ResettableField =
  | 'min_discount_pct'
  | 'min_gap_pct'
  | 'telegram_min_discount_pct'
  | 'detection_mode'
  | 'max_price_cents';

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

/**
 * One result from GET /api/resolve/cards?q=
 * Distinct card names matched across all locally-cached blueprints.
 */
export interface ResolveCard {
  name: string;
  /** Total number of printings (blueprint rows) matching this name */
  printings: number;
  /** Number of distinct sets containing this card */
  sets: number;
}

/**
 * Response from GET /api/resolve/catalog-progress
 * Shows how many sets have been pulled into the local blueprint catalog.
 */
export interface CatalogProgress {
  total: number;
  synced: number;
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

// ---------------------------------------------------------------------------
// Cart — types mirrored from the worker contract
// Money fields are integer cents; currency is an ISO 4217 string.
// ---------------------------------------------------------------------------

/** A monetary amount: integer cents + ISO 4217 currency string. */
export interface Money {
  cents: number;
  currency: string;
}

/**
 * Optional enrichment attached server-side to a cart item by joining against
 * our deals / blueprints cache. Present when the worker recognises the product.
 * Website-added items may have no meta — render defensively.
 */
export interface CartItemMeta {
  source: 'deal' | 'name';
  blueprint_id?: number;
  image_url?: string | null;
  expansion_name?: string | null;
  condition?: string | null;
  language?: string | null;
  foil?: 0 | 1 | null;
  available_quantity?: number | null;
}

/** One line item inside a subcart. */
export interface CartItem {
  quantity: number;
  price_cents: number;
  price_currency: string;
  product: {
    id: number;
    name_en: string;
  };
  meta?: CartItemMeta;
}

/**
 * One seller's sub-cart within the overall cart.
 * The live CardTrader API carries NO money on subcarts — only seller + items.
 * Derive a per-seller subtotal by summing line items at the display edge.
 */
export interface Subcart {
  id: number;
  seller: {
    id: number;
    username: string;
  };
  via_cardtrader_zero?: boolean;
  cart_items: CartItem[];
}

/**
 * The top-level cart returned by GET /api/cart.
 * All money lives here (not on subcarts); every money field is optional —
 * an empty cart omits them.
 */
export interface Cart {
  id: number;
  total?: Money;
  subtotal?: Money;
  shipping_cost?: Money;
  safeguard_fee_amount?: Money;
  ct_zero_fee_amount?: Money;
  payment_method_fee_fixed_amount?: Money;
  payment_method_fee_percentage_amount?: Money;
  subcarts: Subcart[];
}
