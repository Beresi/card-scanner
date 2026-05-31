/**
 * Mock config — the single config row. All fields present and matching the
 * Config interface exactly. Reflects the handoff data.js defaults closely.
 *
 * Note: the handoff data.js had a `currency` field on the config object; that
 * field is NOT on our Config interface (currency lives per-deal row). Dropped.
 */
import type { Config } from '../api/types';
import { minutesAgo } from './utils';

export const MOCK_CONFIG: Config = {
  // Scan / deal detection
  default_threshold_pct: 50,
  default_min_condition: 'NM',
  cohort_size: 10,
  min_cohort: 5,
  currency: 'USD',
  min_price_cents: 200,
  min_savings_cents: 100,

  // New-ticket defaults (displayed as inherit baseline in watchlist inspector)
  new_ticket_foil_pref: 'any',
  new_ticket_allow_graded: 0,
  new_ticket_importance: 'normal',
  new_ticket_telegram_enabled: 0,

  // Telegram
  telegram_min_discount_pct: 60,
  quiet_hours_start: 23,
  quiet_hours_end: 7,
  digest_on_quiet_end: 1,

  // Display / UI
  theme: 'dark',
  theme_palette: 'cyan',
  font: 'chakra',
  accent_color: '#22d3ee',
  density: 'comfortable',

  // Scan mode
  scan_mode: 'chunked',
  scan_batch_size: 40,

  // Detection mode defaults
  default_detection_mode: 'discount',
  default_max_price_cents: null,

  // Catalog sync
  catalog_sync_enabled: 0,
  catalog_max_exports_per_run: 1,

  // Maintenance
  deal_retention_days: 30,
  timezone: 'Asia/Jerusalem',

  updated_at: minutesAgo(5),
};
