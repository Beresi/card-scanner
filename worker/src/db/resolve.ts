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

import { normalizeCondition } from '../scan/conditions';
import type { WatchlistRow, ConfigRow, EffectiveSettings, DetectionMode } from './types';

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
    // min_condition: §9a nullable override — NULL → inherit config.default_min_condition.
    // Routed through normalizeCondition so that legacy TCGplayer codes ('LP', 'NM', etc.)
    // stored in stale DB rows are silently mapped to canonical CardTrader names, and any
    // truly unrecognised value is coerced to 'Near Mint' (with a console.warn) instead of
    // throwing inside conditionRank() and killing the scan for this blueprint.
    min_condition: (() => {
      const raw = ticket.min_condition ?? config.default_min_condition;
      const normalised = normalizeCondition(raw);
      if (normalised !== raw) {
        console.warn(
          `[resolveEffective] min_condition "${raw}" is not a canonical Condition — ` +
          `coerced to "${normalised}". Run migration 0007 to fix stored values.`,
        );
      }
      return normalised;
    })(),

    // foil_pref: §9a nullable override — NULL → inherit config.new_ticket_foil_pref.
    // Uses `??` so that any explicit FoilPref value is always honored.
    foil_pref: ticket.foil_pref ?? config.new_ticket_foil_pref,

    // allow_graded: NOT NULL 0/1 — convert to boolean.
    allow_graded: ticket.allow_graded === 1,

    // min_discount_pct: nullable override — NULL → inherit config default.
    // Uses `??` so that an explicit 0 is honored (0 = "any copy at or below the median qualifies").
    min_discount_pct: ticket.min_discount_pct ?? config.default_discount_pct,

    // min_gap_pct: §9a nullable override — NULL → inherit config.default_min_gap_pct.
    // Uses `??` so an explicit 0 is honored (0 = "any copy below the 2nd-cheapest qualifies").
    min_gap_pct: ticket.min_gap_pct ?? config.default_min_gap_pct,

    // cohort_size / min_cohort / min_price_cents / min_savings_cents:
    // config-only, no per-ticket override column.
    cohort_size: config.cohort_size,
    min_cohort: config.min_cohort,
    min_price_cents: config.min_price_cents,
    min_savings_cents: config.min_savings_cents,

    // importance: §9a nullable override — NULL → inherit config.new_ticket_importance.
    // Uses `??` so that an explicit Importance value is always honored.
    importance: ticket.importance ?? config.new_ticket_importance,

    // telegram_enabled: §9a nullable override — NULL → inherit config.new_ticket_telegram_enabled.
    // Uses `??` (NOT `||`) so that an explicit 0 ("never notify") is always honored.
    telegram_enabled: (ticket.telegram_enabled ?? config.new_ticket_telegram_enabled) === 1,

    // telegram_min_discount_pct: nullable override — NULL → inherit config global.
    telegram_min_discount_pct:
      ticket.telegram_min_discount_pct ?? config.telegram_min_discount_pct,

    // telegram_max_price_cents: nullable, no config fallback.
    // null = no price cap; an explicit 0 would mean "never eligible" (valid override).
    telegram_max_price_cents: ticket.telegram_max_price_cents,

    // telegram_min_savings_cents: nullable, no config fallback.
    // null = no savings floor; an explicit 0 means any positive savings qualifies.
    telegram_min_savings_cents: ticket.telegram_min_savings_cents,

    // detection_mode: nullable override — NULL → inherit config default.
    // Uses `??` so that an explicit value is always honored (migration 0005).
    detection_mode: (ticket.detection_mode ?? config.default_detection_mode) as DetectionMode,

    // max_price_cents: nullable override — NULL → inherit config default.
    // null = no absolute price cap; an explicit 0 would mean "never eligible".
    max_price_cents: ticket.max_price_cents ?? config.default_max_price_cents,
  };
}
