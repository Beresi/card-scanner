/**
 * Test utilities — shared helpers for RTL + Vitest component tests.
 *
 * renderWithProviders wraps in QueryClientProvider (fresh client per call,
 * retry:false + gcTime:0 so errors surface immediately) and EffectsProvider.
 *
 * The api/client module is mocked via vi.mock() in each test file; these
 * fixtures are the canonical typed shapes used across multiple tests.
 */

import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EffectsProvider } from '../effects/EffectsContext';
import type { Config, Deal, Health, ScanRun, WatchItem } from '../api/types';

// ---------------------------------------------------------------------------
// renderWithProviders
// ---------------------------------------------------------------------------

/**
 * Render `ui` inside a fresh QueryClient + EffectsProvider.
 *
 * A fresh QueryClient is created for every call (no cross-test cache bleed).
 * retry:false means failed queries surface immediately; gcTime:0 keeps
 * inactive queries out of cache between renders in the same test.
 */
export function renderWithProviders(
  ui: ReactNode,
  { client }: { client?: QueryClient } = {},
) {
  const qc =
    client ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

  return render(
    <QueryClientProvider client={qc}>
      <EffectsProvider>{ui}</EffectsProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Fixtures — typed static data for the three failing test files
// ---------------------------------------------------------------------------

/** Config fixture — all fields including theme_palette and font. Money is integer cents. */
export const FIXTURE_CONFIG: Config = {
  default_threshold_pct: 50,
  default_min_condition: 'NM',
  cohort_size: 10,
  min_cohort: 5,
  currency: 'USD',
  min_price_cents: 200,
  min_savings_cents: 100,
  new_ticket_foil_pref: 'any',
  new_ticket_allow_graded: 0,
  new_ticket_importance: 'normal',
  new_ticket_telegram_enabled: 0,
  telegram_min_discount_pct: 60,
  quiet_hours_start: 23,
  quiet_hours_end: 7,
  digest_on_quiet_end: 1,
  theme: 'dark',
  theme_palette: 'cyan',
  font: 'chakra',
  accent_color: '#22d3ee',
  density: 'comfortable',
  scan_mode: 'chunked',
  scan_batch_size: 40,
  default_detection_mode: 'discount',
  default_max_price_cents: null,
  catalog_sync_enabled: 0,
  catalog_max_exports_per_run: 1,
  deal_retention_days: 30,
  timezone: 'UTC',
  updated_at: '2026-05-30 10:00:00',
};

/** Health fixture — ok:true, db_ok:true (scanner online). */
export const FIXTURE_HEALTH: Health = {
  ok: true,
  service: 'cardtrader-deal-scanner',
  ts: '2026-05-30T10:00:00.000Z',
  db_ok: true,
  last_scan_at: '2026-05-30 09:00:00',
  last_scan_finished_at: '2026-05-30 09:01:30',
  last_scan_error: null,
  deals_found: 3,
  telegram_sent: 1,
  api_calls: 42,
  scan_mode: 'chunked',
  scan_total: 120,
  scan_done: 40,
};

/** ScanRun fixtures — one clean run, one with an error. */
export const FIXTURE_SCAN_RUNS: ScanRun[] = [
  {
    id: 2,
    started_at: '2026-05-30 09:00:00',
    finished_at: '2026-05-30 09:01:30',
    watch_items_scanned: 10,
    blueprints_scanned: 8,
    api_calls: 42,
    deals_found: 3,
    telegram_sent: 1,
    error: null,
  },
  {
    id: 1,
    started_at: '2026-05-30 08:00:00',
    finished_at: '2026-05-30 08:01:00',
    watch_items_scanned: 10,
    blueprints_scanned: 8,
    api_calls: 38,
    deals_found: 0,
    telegram_sent: 0,
    error: 'CardTrader API 401: unauthorized',
  },
];

/** Deal fixtures — 2 open deals (1 high-priority, 1 normal). Money is integer cents. */
export const FIXTURE_DEALS: Deal[] = [
  {
    id: 1,
    watchlist_id: 1,
    blueprint_id: 100501,
    product_id: 9001,
    card_name: 'Ragavan, Nimble Pilferer',
    expansion_name: 'Modern Horizons 2',
    seller_username: 'seller1',
    seller_country: 'DE',
    condition: 'NM',
    language: 'en',
    foil: 0,
    can_sell_via_hub: 1,
    quantity: 1,
    price_cents: 1600,    // 16c — integer cents; baseline 3200c = 50% off
    currency: 'USD',
    baseline_cents: 3200,
    cohort_size: 10,
    discount_pct: 50,
    priority: 'high',
    buy_url: 'https://www.cardtrader.com/cards/100501',
    found_at: '2026-05-30 09:01:00',
    seen: 0,
    dismissed: 0,
    telegram_sent: 1,
    telegram_sent_at: '2026-05-30 09:01:05',
  },
  {
    id: 2,
    watchlist_id: 2,
    blueprint_id: 100701,
    product_id: 9002,
    card_name: 'The One Ring',
    expansion_name: 'LotR: Tales of Middle-earth',
    seller_username: 'seller2',
    seller_country: 'US',
    condition: 'NM',
    language: 'en',
    foil: 0,
    can_sell_via_hub: 0,
    quantity: 2,
    price_cents: 3200,   // integer cents
    currency: 'USD',
    baseline_cents: 7000,
    cohort_size: 10,
    discount_pct: 54,
    priority: 'normal',
    buy_url: 'https://www.cardtrader.com/cards/100701',
    found_at: '2026-05-30 09:00:45',
    seen: 0,
    dismissed: 0,
    telegram_sent: 0,
    telegram_sent_at: null,
  },
];

/**
 * WatchItem fixtures used by the inspector §9a tests.
 *
 * INHERITING item (id=101): threshold_pct null → falls back to config default 50%.
 * OVERRIDING item  (id=102): threshold_pct=55 → shows reset affordance.
 */
export const FIXTURE_WATCH_INHERITING: WatchItem = {
  id: 101,
  type: 'blueprint',
  cardtrader_id: 100701,
  label: 'The One Ring',
  game_id: 1,
  // threshold_pct null → INHERITING (falls back to config.default_threshold_pct = 50)
  min_condition: 'NM',       // overriding
  foil_pref: null,
  allow_graded: 0,
  threshold_pct: null,       // INHERITING
  importance: 'high',
  telegram_enabled: 1,
  telegram_min_discount_pct: null,
  telegram_max_price_cents: null,
  telegram_min_savings_cents: null,
  detection_mode: null,
  max_price_cents: null,
  card_name_norm: null,
  expansion_filter: null,
  active: 1,
  created_at: '2026-05-25 10:00:00',
  updated_at: '2026-05-25 10:00:00',
};

export const FIXTURE_WATCH_OVERRIDING: WatchItem = {
  id: 102,
  type: 'blueprint',
  cardtrader_id: 100501,
  label: 'Ragavan, Nimble Pilferer',
  game_id: 1,
  // threshold_pct set → OVERRIDING (shows reset button)
  min_condition: null,       // inheriting
  foil_pref: 'nonfoil',
  allow_graded: 0,
  threshold_pct: 55,         // OVERRIDING
  importance: 'high',
  telegram_enabled: 1,
  telegram_min_discount_pct: null,
  telegram_max_price_cents: null,
  telegram_min_savings_cents: null,
  detection_mode: null,
  max_price_cents: null,
  card_name_norm: null,
  expansion_filter: null,
  active: 1,
  created_at: '2026-05-20 08:00:00',
  updated_at: '2026-05-20 08:00:00',
};
