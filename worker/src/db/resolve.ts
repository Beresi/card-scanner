/**
 * §9a Inheritance resolver — the ONE place the inherit/override rule lives.
 *
 * `resolveEffective(ticket, config)` maps a raw WatchlistRow + the single
 * ConfigRow into a NULL-free EffectiveSettings shape that the deal engine
 * and Telegram routing consume.
 *
 * Rules (use `??`, never `||` — 0 is a valid override):
 *  - Nullable override columns: ticket value ?? config fallback.
 *  - NOT NULL ticket columns: pass through as-is (no config fallback).
 *  - Config-only columns (cohort_size, min_cohort): always from config.
 *  - 0/1 boolean columns: converted to real booleans here.
 *  - telegram_max_price_cents / telegram_min_savings_cents: null = unbounded,
 *    no config fallback — pass through as null when absent.
 *
 * PRD §9a; docs/documentation/data-model.md.
 */

import type { Condition } from '../scan/conditions';
import type { WatchlistRow, ConfigRow, EffectiveSettings } from './types';

/**
 * Resolve the effective settings for a single watchlist ticket.
 *
 * Pure function — no I/O, no side effects. Safe to call in tests without
 * any D1 setup.
 */
export function resolveEffective(
  ticket: WatchlistRow,
  config: ConfigRow,
): EffectiveSettings {
  return {
    // min_condition: NOT NULL in schema (always set), but typed as `string`
    // on WatchlistRow because D1 returns raw text. Cast to Condition here;
    // the CHECK constraint guarantees the value is valid.
    min_condition: ticket.min_condition as Condition,

    // foil_pref: NOT NULL — no config fallback.
    foil_pref: ticket.foil_pref,

    // allow_graded: NOT NULL 0/1 — convert to boolean.
    allow_graded: ticket.allow_graded === 1,

    // threshold_pct: nullable override — NULL → inherit config default.
    // Uses `??` so that an explicit 0 is honored (0 = "flag every listing").
    threshold_pct: ticket.threshold_pct ?? config.default_threshold_pct,

    // cohort_size / min_cohort / min_price_cents / min_savings_cents:
    // config-only, no per-ticket override column.
    cohort_size: config.cohort_size,
    min_cohort: config.min_cohort,
    min_price_cents: config.min_price_cents,
    min_savings_cents: config.min_savings_cents,

    // importance: NOT NULL — no config fallback.
    importance: ticket.importance,

    // telegram_enabled: NOT NULL 0/1 — convert to boolean.
    telegram_enabled: ticket.telegram_enabled === 1,

    // telegram_min_discount_pct: nullable override — NULL → inherit config global.
    telegram_min_discount_pct:
      ticket.telegram_min_discount_pct ?? config.telegram_min_discount_pct,

    // telegram_max_price_cents: nullable, no config fallback.
    // null = no price cap; an explicit 0 would mean "never eligible" (valid override).
    telegram_max_price_cents: ticket.telegram_max_price_cents,

    // telegram_min_savings_cents: nullable, no config fallback.
    // null = no savings floor; an explicit 0 means any positive savings qualifies.
    telegram_min_savings_cents: ticket.telegram_min_savings_cents,
  };
}
