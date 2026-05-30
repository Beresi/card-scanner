/**
 * Tests for resolveEffective() — the §9a inheritance resolver.
 *
 * All fixtures are built inline; no D1, no network, no file I/O.
 * Covers:
 *  1. Nullable override (threshold_pct) inherits config default when NULL.
 *  2. Explicit override (threshold_pct = 40) is sticky.
 *  3. threshold_pct = 0 is honored — proves `??` not `||` (0 is valid).
 *  4. telegram_max_price_cents / telegram_min_savings_cents pass through as
 *     null (no config fallback).
 *  5. 0/1 boolean columns (allow_graded, telegram_enabled) convert to real
 *     booleans.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffective } from './resolve';
import type { WatchlistRow, ConfigRow } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid ConfigRow with all deal-logic + telegram defaults. */
const BASE_CONFIG: ConfigRow = {
  id: 1,
  default_threshold_pct: 50,
  default_min_condition: 'Near Mint',
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
  quiet_hours_start: null,
  quiet_hours_end: null,
  digest_on_quiet_end: 1,
  theme: 'system',
  accent_color: '#f59e0b',
  density: 'comfortable',
  theme_palette: 'cyan',
  font: 'chakra',
  deal_retention_days: 30,
  timezone: 'Asia/Jerusalem',
  updated_at: '2025-01-01T00:00:00Z',
};

/** Minimal valid WatchlistRow — all override columns NULL (born inheriting). */
const INHERITING_TICKET: WatchlistRow = {
  id: 1,
  type: 'blueprint',
  cardtrader_id: 100,
  label: 'Black Lotus',
  game_id: 1,
  min_condition: 'Near Mint',
  foil_pref: 'any',
  allow_graded: 0,
  threshold_pct: null,                    // nullable override — NULL
  importance: 'normal',
  telegram_enabled: 0,
  telegram_min_discount_pct: null,        // nullable override — NULL
  telegram_max_price_cents: null,         // nullable, no config fallback
  telegram_min_savings_cents: null,       // nullable, no config fallback
  active: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// 1. Nullable threshold_pct NULL → inherits config.default_threshold_pct
// ---------------------------------------------------------------------------

describe('resolveEffective — threshold_pct inheritance', () => {
  it('inherits config.default_threshold_pct when ticket.threshold_pct is null', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.threshold_pct).toBe(50); // BASE_CONFIG.default_threshold_pct
  });

  it('reflects a later config change — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_threshold_pct: 55 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.threshold_pct).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit threshold_pct = 40 is sticky regardless of config default
// ---------------------------------------------------------------------------

describe('resolveEffective — explicit override is sticky', () => {
  it('keeps ticket.threshold_pct = 40 even when config default is 50', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, threshold_pct: 40 };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 50
    expect(result.threshold_pct).toBe(40);
  });

  it('keeps ticket.threshold_pct = 40 even when config default changes to 55', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, threshold_pct: 40 };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_threshold_pct: 55 };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.threshold_pct).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 3. threshold_pct = 0 is honored — proves `??` not `||`
// ---------------------------------------------------------------------------

describe('resolveEffective — zero is a valid override (nullish coalescing)', () => {
  it('honors threshold_pct = 0, does NOT fall back to config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, threshold_pct: 0 };
    // If `||` were used instead of `??`, 0 would be treated as falsy and
    // BASE_CONFIG.default_threshold_pct (50) would be returned instead.
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.threshold_pct).toBe(0);
    expect(result.threshold_pct).not.toBe(50);
  });

  it('honors telegram_min_discount_pct = 0 — does NOT fall back to config', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_min_discount_pct: 0 };
    const result = resolveEffective(ticket, BASE_CONFIG); // config = 60
    expect(result.telegram_min_discount_pct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. telegram_max_price_cents / telegram_min_savings_cents: null passes through
// ---------------------------------------------------------------------------

describe('resolveEffective — null cap/floor fields pass through (no config fallback)', () => {
  it('telegram_max_price_cents null → null in effective settings', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.telegram_max_price_cents).toBeNull();
  });

  it('telegram_min_savings_cents null → null in effective settings', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.telegram_min_savings_cents).toBeNull();
  });

  it('telegram_max_price_cents explicit value passes through unchanged', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_max_price_cents: 500 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.telegram_max_price_cents).toBe(500);
  });

  it('telegram_min_savings_cents explicit value passes through unchanged', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_min_savings_cents: 200 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.telegram_min_savings_cents).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. 0/1 boolean columns convert to real booleans
// ---------------------------------------------------------------------------

describe('resolveEffective — 0/1 → boolean conversion', () => {
  it('allow_graded = 0 → false', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, allow_graded: 0 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.allow_graded).toBe(false);
    expect(typeof result.allow_graded).toBe('boolean');
  });

  it('allow_graded = 1 → true', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, allow_graded: 1 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.allow_graded).toBe(true);
    expect(typeof result.allow_graded).toBe('boolean');
  });

  it('telegram_enabled = 0 → false', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_enabled: 0 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.telegram_enabled).toBe(false);
    expect(typeof result.telegram_enabled).toBe('boolean');
  });

  it('telegram_enabled = 1 → true', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_enabled: 1 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.telegram_enabled).toBe(true);
    expect(typeof result.telegram_enabled).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 6. Config-only fields always come from config (cohort_size, min_cohort)
// ---------------------------------------------------------------------------

describe('resolveEffective — config-only fields', () => {
  it('cohort_size always comes from config', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.cohort_size).toBe(10); // BASE_CONFIG.cohort_size
  });

  it('min_cohort always comes from config', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_cohort).toBe(5); // BASE_CONFIG.min_cohort
  });
});

// ---------------------------------------------------------------------------
// 7. NOT NULL columns pass through from ticket (no config fallback)
// ---------------------------------------------------------------------------

describe('resolveEffective — NOT NULL ticket columns pass through', () => {
  it('min_condition comes from ticket (cast to Condition)', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'Slightly Played' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Slightly Played');
  });

  it('foil_pref comes from ticket', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, foil_pref: 'foil' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.foil_pref).toBe('foil');
  });

  it('importance comes from ticket', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, importance: 'high' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.importance).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// 8. Config-only deal-floor fields (min_price_cents, min_savings_cents)
// ---------------------------------------------------------------------------

describe('resolveEffective — deal-floor config-only fields', () => {
  it('min_price_cents comes from config', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_price_cents).toBe(200); // BASE_CONFIG.min_price_cents
  });

  it('min_savings_cents comes from config', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_savings_cents).toBe(100); // BASE_CONFIG.min_savings_cents
  });

  it('reflects a config change in min_price_cents — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, min_price_cents: 500 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.min_price_cents).toBe(500);
  });

  it('reflects a config change in min_savings_cents — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, min_savings_cents: 250 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.min_savings_cents).toBe(250);
  });

  it('min_price_cents = 0 is honored (zero is a valid floor)', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, min_price_cents: 0 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.min_price_cents).toBe(0);
  });
});
