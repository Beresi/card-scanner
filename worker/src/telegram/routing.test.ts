/**
 * PRD §16 acceptance tests for the Telegram routing predicate (cases 7/8/9),
 * plus the optional price-cap / savings-floor gates, the product_id dedupe, and
 * the quiet-hours wrap-around helper.
 *
 * All fixtures are inline; the predicate is pure (no I/O, no Date.now()), so the
 * injected current hour and quiet window make every case deterministic.
 *
 * Money is integer cents throughout.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldNotify,
  inQuietHours,
  type RoutableDeal,
  type RoutingSettings,
} from './routing';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Resolved settings with the global Telegram threshold (60%), nothing else. */
const BASE_EFF: RoutingSettings = {
  importance: 'normal',
  telegram_enabled: false,
  telegram_min_discount_pct: 60, // global default per §8
  telegram_max_price_cents: null, // no cap
  telegram_min_savings_cents: null, // no floor
};

/** A deal at the given discount; price/baseline give a 1000c savings by default. */
function makeDeal(discountPct: number, overrides: Partial<RoutableDeal> = {}): RoutableDeal {
  return {
    discount_pct: discountPct,
    price_cents: 1000,
    baseline_cents: 2000,
    telegram_sent: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §16 Case 7 — Routing: app only
// ---------------------------------------------------------------------------

describe('§16 case 7 — telegram_enabled=false, normal, 52% off → app only', () => {
  it('does not send (fails the opt-in criterion)', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: false, importance: 'normal' };
    const decision = shouldNotify(makeDeal(52), eff);
    expect(decision.send).toBe(false);
    expect(decision.priority).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// §16 Case 8 — Routing: high importance bypasses the discount gate
// ---------------------------------------------------------------------------

describe('§16 case 8 — high importance, 51% off (below global 60%) → fires', () => {
  it('sends even below the Telegram threshold (high bypasses the gate)', () => {
    const eff: RoutingSettings = { ...BASE_EFF, importance: 'high', telegram_enabled: false };
    const decision = shouldNotify(makeDeal(51), eff);
    expect(decision.send).toBe(true);
    expect(decision.priority).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// §16 Case 9 — Routing: steep global discount
// ---------------------------------------------------------------------------

describe('§16 case 9 — telegram_enabled=true at the global threshold', () => {
  it('fires at 65% off (≥ global 60%)', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true };
    expect(shouldNotify(makeDeal(65), eff).send).toBe(true);
  });

  it('does NOT fire at 52% off (below global 60%) — app only', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true };
    expect(shouldNotify(makeDeal(52), eff).send).toBe(false);
  });

  it('fires exactly at the threshold (60% ≥ 60%)', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true };
    expect(shouldNotify(makeDeal(60), eff).send).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-item override threshold
// ---------------------------------------------------------------------------

describe('per-item telegram_min_discount_pct override', () => {
  it('a stricter override (70) blocks a 65% deal', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true, telegram_min_discount_pct: 70 };
    expect(shouldNotify(makeDeal(65), eff).send).toBe(false);
  });

  it('an override of 0 fires on any deal (proves >= and that 0 is honored)', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true, telegram_min_discount_pct: 0 };
    expect(shouldNotify(makeDeal(1), eff).send).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optional price cap / savings floor
// ---------------------------------------------------------------------------

describe('optional price cap (telegram_max_price_cents)', () => {
  const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true, telegram_max_price_cents: 1500 };

  it('sends when price is at/under the cap', () => {
    expect(shouldNotify(makeDeal(65, { price_cents: 1500 }), eff).send).toBe(true);
  });

  it('blocks when price exceeds the cap', () => {
    expect(shouldNotify(makeDeal(65, { price_cents: 1501 }), eff).send).toBe(false);
  });
});

describe('optional savings floor (telegram_min_savings_cents)', () => {
  // savings = baseline - price.
  const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true, telegram_min_savings_cents: 1000 };

  it('sends when savings meets the floor (2000-1000=1000 ≥ 1000)', () => {
    expect(shouldNotify(makeDeal(65, { price_cents: 1000, baseline_cents: 2000 }), eff).send).toBe(true);
  });

  it('blocks when savings is below the floor (1800-1000=800 < 1000)', () => {
    expect(shouldNotify(makeDeal(65, { price_cents: 1000, baseline_cents: 1800 }), eff).send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dedupe — one push per product_id, ever
// ---------------------------------------------------------------------------

describe('dedupe (telegram_sent)', () => {
  it('blocks an otherwise-eligible deal that was already sent', () => {
    const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true };
    expect(shouldNotify(makeDeal(65, { telegram_sent: true }), eff).send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours — predicate gate + wrap-around helper
// ---------------------------------------------------------------------------

describe('quiet-hours gate in shouldNotify', () => {
  const eff: RoutingSettings = { ...BASE_EFF, telegram_enabled: true };

  it('holds an eligible deal during quiet hours', () => {
    expect(shouldNotify(makeDeal(65), eff, 2, { start: 22, end: 6 }).send).toBe(false);
  });

  it('sends an eligible deal outside quiet hours', () => {
    expect(shouldNotify(makeDeal(65), eff, 12, { start: 22, end: 6 }).send).toBe(true);
  });

  it('ignores quiet hours when no current hour is injected', () => {
    expect(shouldNotify(makeDeal(65), eff, undefined, { start: 22, end: 6 }).send).toBe(true);
  });
});

describe('inQuietHours wrap-around', () => {
  it('same-day window [1,6): 1..5 quiet, 0 and 6 not', () => {
    expect(inQuietHours(0, { start: 1, end: 6 })).toBe(false);
    expect(inQuietHours(1, { start: 1, end: 6 })).toBe(true);
    expect(inQuietHours(5, { start: 1, end: 6 })).toBe(true);
    expect(inQuietHours(6, { start: 1, end: 6 })).toBe(false);
  });

  it('wrap-around window [22,6): 22,23,0..5 quiet, 6..21 not', () => {
    expect(inQuietHours(22, { start: 22, end: 6 })).toBe(true);
    expect(inQuietHours(0, { start: 22, end: 6 })).toBe(true);
    expect(inQuietHours(5, { start: 22, end: 6 })).toBe(true);
    expect(inQuietHours(6, { start: 22, end: 6 })).toBe(false);
    expect(inQuietHours(12, { start: 22, end: 6 })).toBe(false);
  });

  it('degenerate window (start === end) is never quiet', () => {
    expect(inQuietHours(3, { start: 5, end: 5 })).toBe(false);
  });
});
