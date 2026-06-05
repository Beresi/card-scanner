/**
 * Tests for resolveEffective() — the §9a inheritance resolver.
 *
 * All fixtures are built inline; no D1, no network, no file I/O.
 * Covers:
 *  1. Nullable override (min_discount_pct) inherits config default when NULL.
 *  2. Explicit override (min_discount_pct = 60) is sticky.
 *  3. min_discount_pct = 100 is honored — proves `??` not `||` (0 is valid for the old field; 100 is now the "any listing qualifies" value).
 *  4. telegram_max_price_cents / telegram_min_savings_cents pass through as
 *     null (no config fallback).
 *  5. 0/1 boolean columns (allow_graded, telegram_enabled) convert to real
 *     booleans.
 *  6. min_condition NULL → inherits config.default_min_condition.
 *  7. foil_pref NULL → inherits config.new_ticket_foil_pref.
 *  8. importance NULL → inherits config.new_ticket_importance.
 *  9. telegram_enabled NULL → inherits config.new_ticket_telegram_enabled;
 *     explicit 0 is honored (proves `??` not `||`).
 * 15. min_condition normalisation — legacy codes map to canonical names; unknown
 *     values coerce to 'Near Mint' (no throw).
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
  default_discount_pct: 50,
  default_min_condition: 'Near Mint',
  cohort_size: 10,
  min_cohort: 5,
  default_min_gap_pct: 15,
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
  scan_mode: 'chunked',
  scan_batch_size: 40,
  scan_cycle_started_at: null,
  // Migration 0005 additions
  default_detection_mode: 'discount',
  default_max_price_cents: null,
  catalog_sync_enabled: 0,
  catalog_max_exports_per_run: 1,
  // Migration 0011 addition
  scan_interval_minutes: 60,
  updated_at: '2025-01-01T00:00:00Z',
};

/** Minimal valid WatchlistRow — all §9a override columns NULL (born inheriting). */
const INHERITING_TICKET: WatchlistRow = {
  id: 1,
  type: 'blueprint',
  cardtrader_id: 100,
  label: 'Black Lotus',
  game_id: 1,
  min_condition: null,                    // §9a nullable override (migration 0006) — NULL
  foil_pref: null,                        // §9a nullable override (migration 0006) — NULL
  allow_graded: 0,
  min_discount_pct: null,                  // nullable override — NULL
  min_gap_pct: null,                       // §9a nullable override (migration 0009) — NULL
  importance: null,                       // §9a nullable override (migration 0006) — NULL
  telegram_enabled: null,                 // §9a nullable override (migration 0006) — NULL
  telegram_min_discount_pct: null,        // nullable override — NULL
  telegram_max_price_cents: null,         // nullable, no config fallback
  telegram_min_savings_cents: null,       // nullable, no config fallback
  active: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  // Migration 0005 additions — NULL = inherit config at scan time
  detection_mode: null,
  max_price_cents: null,
  card_name_norm: null,
  expansion_filter: null,
};

// ---------------------------------------------------------------------------
// 1. Nullable min_discount_pct NULL → inherits config.default_discount_pct
// ---------------------------------------------------------------------------

describe('resolveEffective — min_discount_pct inheritance', () => {
  it('inherits config.default_discount_pct when ticket.min_discount_pct is null', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_discount_pct).toBe(50); // BASE_CONFIG.default_discount_pct
  });

  it('reflects a later config change — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_discount_pct: 45 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.min_discount_pct).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit min_discount_pct = 60 is sticky regardless of config default
// ---------------------------------------------------------------------------

describe('resolveEffective — explicit override is sticky', () => {
  it('keeps ticket.min_discount_pct = 60 even when config default is 50', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_discount_pct: 60 };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 50
    expect(result.min_discount_pct).toBe(60);
  });

  it('keeps ticket.min_discount_pct = 60 even when config default changes to 45', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_discount_pct: 60 };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_discount_pct: 45 };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.min_discount_pct).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 3. min_discount_pct = 0 is honored — proves `??` not `||` (0 = any copy at or below median qualifies)
// ---------------------------------------------------------------------------

describe('resolveEffective — zero is a valid override (nullish coalescing)', () => {
  it('honors min_discount_pct = 0, does NOT fall back to config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_discount_pct: 0 };
    // If `||` were used instead of `??`, 0 would be treated as falsy and
    // BASE_CONFIG.default_discount_pct (50) would be returned instead.
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_discount_pct).toBe(0);
    expect(result.min_discount_pct).not.toBe(50);
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
// 7. Explicit §9a override values pass through from ticket (sticky when set)
// ---------------------------------------------------------------------------

describe('resolveEffective — explicit ticket override values are sticky', () => {
  it('explicit min_condition overrides config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'Slightly Played' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'Near Mint'
    expect(result.min_condition).toBe('Slightly Played');
  });

  it('explicit foil_pref overrides config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, foil_pref: 'foil' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'any'
    expect(result.foil_pref).toBe('foil');
  });

  it('explicit importance overrides config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, importance: 'high' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'normal'
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

// ---------------------------------------------------------------------------
// 9. detection_mode inheritance (migration 0005)
// ---------------------------------------------------------------------------

describe('resolveEffective — detection_mode inheritance (migration 0005)', () => {
  it('NULL on ticket → inherits config.default_detection_mode', () => {
    // INHERITING_TICKET.detection_mode = null; BASE_CONFIG.default_detection_mode = 'discount'
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.detection_mode).toBe('discount');
  });

  it('reflects a config change to default_detection_mode — moving baseline', () => {
    // If the config default changes to 'price', all inheriting tickets switch automatically.
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_detection_mode: 'price' };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.detection_mode).toBe('price');
  });

  it("explicit ticket detection_mode 'price' is sticky — overrides config default", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, detection_mode: 'price' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'discount'
    expect(result.detection_mode).toBe('price');
  });

  it("explicit ticket detection_mode 'discount' stays 'discount' even when config default changes", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, detection_mode: 'discount' };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_detection_mode: 'price' };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.detection_mode).toBe('discount');
  });
});

// ---------------------------------------------------------------------------
// 10. max_price_cents inheritance (migration 0005)
// ---------------------------------------------------------------------------

describe('resolveEffective — max_price_cents inheritance (migration 0005)', () => {
  it('NULL on ticket → inherits config.default_max_price_cents', () => {
    // BASE_CONFIG.default_max_price_cents = null → effective max_price_cents = null
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.max_price_cents).toBeNull();
  });

  it('NULL on ticket → inherits a non-null config default (moving baseline)', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_max_price_cents: 500 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.max_price_cents).toBe(500); // integer cents
  });

  it('explicit max_price_cents 0 on ticket is honored — NOT treated as missing (proves ??)', () => {
    // If `||` were used instead of `??`, 0 would be falsy and fall through to config.
    // With `??`, 0 is a valid explicit value and must be returned as-is.
    const ticket: WatchlistRow = { ...INHERITING_TICKET, max_price_cents: 0 };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_max_price_cents: 500 };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.max_price_cents).toBe(0);
    expect(result.max_price_cents).not.toBe(500);
  });

  it('explicit max_price_cents value is sticky — overrides config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, max_price_cents: 999 };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_max_price_cents: 500 };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.max_price_cents).toBe(999); // integer cents
  });
});

// ---------------------------------------------------------------------------
// 11. min_condition inheritance (migration 0006)
// ---------------------------------------------------------------------------

describe('resolveEffective — min_condition inheritance (migration 0006)', () => {
  it('NULL on ticket → inherits config.default_min_condition', () => {
    // INHERITING_TICKET.min_condition = null; BASE_CONFIG.default_min_condition = 'Near Mint'
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_condition).toBe('Near Mint');
  });

  it('reflects a config change to default_min_condition — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, default_min_condition: 'Slightly Played' };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.min_condition).toBe('Slightly Played');
  });

  it('explicit ticket min_condition is sticky — overrides config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'Slightly Played' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'Near Mint'
    expect(result.min_condition).toBe('Slightly Played');
  });
});

// ---------------------------------------------------------------------------
// 12. foil_pref inheritance (migration 0006)
// ---------------------------------------------------------------------------

describe('resolveEffective — foil_pref inheritance (migration 0006)', () => {
  it('NULL on ticket → inherits config.new_ticket_foil_pref', () => {
    // INHERITING_TICKET.foil_pref = null; BASE_CONFIG.new_ticket_foil_pref = 'any'
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.foil_pref).toBe('any');
  });

  it('reflects a config change to new_ticket_foil_pref — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, new_ticket_foil_pref: 'foil' };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.foil_pref).toBe('foil');
  });

  it("explicit ticket foil_pref 'nonfoil' is sticky — overrides config default", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, foil_pref: 'nonfoil' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'any'
    expect(result.foil_pref).toBe('nonfoil');
  });
});

// ---------------------------------------------------------------------------
// 13. importance inheritance (migration 0006)
// ---------------------------------------------------------------------------

describe('resolveEffective — importance inheritance (migration 0006)', () => {
  it('NULL on ticket → inherits config.new_ticket_importance', () => {
    // INHERITING_TICKET.importance = null; BASE_CONFIG.new_ticket_importance = 'normal'
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.importance).toBe('normal');
  });

  it('reflects a config change to new_ticket_importance — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, new_ticket_importance: 'high' };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.importance).toBe('high');
  });

  it("explicit ticket importance 'high' is sticky — overrides config default", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, importance: 'high' };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 'normal'
    expect(result.importance).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// 14. telegram_enabled inheritance (migration 0006)
// ---------------------------------------------------------------------------

describe('resolveEffective — telegram_enabled inheritance (migration 0006)', () => {
  it('NULL on ticket → inherits config.new_ticket_telegram_enabled (0 = false)', () => {
    // INHERITING_TICKET.telegram_enabled = null; BASE_CONFIG.new_ticket_telegram_enabled = 0
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.telegram_enabled).toBe(false);
    expect(typeof result.telegram_enabled).toBe('boolean');
  });

  it('reflects a config change to new_ticket_telegram_enabled = 1 — moving baseline', () => {
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, new_ticket_telegram_enabled: 1 };
    const result = resolveEffective(INHERITING_TICKET, updatedConfig);
    expect(result.telegram_enabled).toBe(true);
  });

  it('explicit telegram_enabled = 0 is honored — NOT treated as missing (proves ??)', () => {
    // If `||` were used instead of `??`, 0 would be falsy and fall through to config.
    // With `??`, 0 is a valid explicit value (meaning "never notify") and must be honored.
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_enabled: 0 };
    const updatedConfig: ConfigRow = { ...BASE_CONFIG, new_ticket_telegram_enabled: 1 };
    const result = resolveEffective(ticket, updatedConfig);
    expect(result.telegram_enabled).toBe(false); // 0 is sticky, not overridden by config=1
  });

  it('explicit telegram_enabled = 1 is sticky — overrides config default 0', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_enabled: 1 };
    const result = resolveEffective(ticket, BASE_CONFIG); // config default = 0
    expect(result.telegram_enabled).toBe(true);
  });

  it('explicit telegram_enabled = 1 converts to boolean true', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, telegram_enabled: 1 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.telegram_enabled).toBe(true);
    expect(typeof result.telegram_enabled).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 15. min_condition normalisation — legacy codes and unknown values (Task 1b)
// ---------------------------------------------------------------------------

describe('resolveEffective — min_condition normalisation (migration 0007 defence)', () => {
  it("legacy code 'LP' on ticket normalises to 'Slightly Played' (no throw)", () => {
    // 'LP' is the TCGplayer code that was previously stored by the desktop.
    // It must not reach conditionRank() as-is — resolveEffective normalises it first.
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'LP' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Slightly Played');
  });

  it("legacy code 'NM' on ticket normalises to 'Near Mint' (no throw)", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'NM' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Near Mint');
  });

  it("legacy code 'MP' on ticket normalises to 'Moderately Played' (no throw)", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'MP' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Moderately Played');
  });

  it("legacy code 'HP' on ticket normalises to 'Heavily Played' (no throw)", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'HP' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Heavily Played');
  });

  it("legacy code 'D' on ticket normalises to 'Poor' (no throw)", () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'D' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Poor');
  });

  it("unknown string on ticket coerces to 'Near Mint' (no throw)", () => {
    // An entirely unrecognised value (e.g. from a future client bug) must not
    // throw and must not kill the scan — it falls back to the safest default.
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'GarbageValue' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Near Mint');
  });

  it("canonical value 'Slightly Played' on ticket is left unchanged", () => {
    // Already-canonical values must pass through the normaliser unchanged.
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_condition: 'Slightly Played' };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_condition).toBe('Slightly Played');
  });

  it("legacy code 'LP' on config.default_min_condition normalises to 'Slightly Played'", () => {
    // If the config row itself has a stale legacy code, it must also be normalised.
    const legacyConfig: ConfigRow = { ...BASE_CONFIG, default_min_condition: 'LP' };
    // Ticket inherits (null) — so the raw value comes from config.
    const result = resolveEffective(INHERITING_TICKET, legacyConfig);
    expect(result.min_condition).toBe('Slightly Played');
  });
});

// ---------------------------------------------------------------------------
// §9a gap-gate inheritance (migration 0009)
// ---------------------------------------------------------------------------

describe('resolveEffective — min_gap_pct §9a inheritance', () => {
  it('NULL override inherits config.default_min_gap_pct', () => {
    const result = resolveEffective(INHERITING_TICKET, BASE_CONFIG);
    expect(result.min_gap_pct).toBe(BASE_CONFIG.default_min_gap_pct); // 15
  });

  it('explicit override is honored over the config default', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_gap_pct: 25 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_gap_pct).toBe(25);
  });

  it('explicit 0 is honored (uses ??, not ||) — gap gate disabled for this item', () => {
    const ticket: WatchlistRow = { ...INHERITING_TICKET, min_gap_pct: 0 };
    const result = resolveEffective(ticket, BASE_CONFIG);
    expect(result.min_gap_pct).toBe(0);
  });
});
