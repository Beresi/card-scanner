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
  accent_color: string;
  density: Density;

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
// Health — loose shape; the Worker may add fields without breaking the UI
// ---------------------------------------------------------------------------
export interface Health {
  status: 'ok' | 'degraded' | 'error';
  token_ok: boolean;
  db_ok: boolean;
  last_scan_at: string | null;
  last_scan_error: string | null;
  // Permit additional fields the backend may send
  [key: string]: unknown;
}
