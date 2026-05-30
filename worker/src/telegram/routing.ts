/**
 * Telegram anti-spam routing — the pure §8 should-notify predicate.
 *
 * This is the decision layer: given one new deal and the resolved (§9a)
 * effective settings for its watch item, decide whether it pushes to Telegram.
 * The in-app feed already shows EVERY deal; Telegram is the strict, opt-in
 * subset (PRD §8). That split is the product's core anti-spam value.
 *
 * INVARIANTS (do not violate):
 *  - PURE. No `fetch`, no DB, no `Date.now()`. The current local hour is
 *    INJECTED so the function stays deterministic and unit-testable (§16).
 *  - Money is integer cents throughout — never floats. `savings_cents` is a
 *    plain integer subtraction; no division happens here.
 *  - `priority` is returned regardless of `send` — it is written to the deal
 *    row even when the deal is held/skipped.
 *
 * Sending, batching, and message formatting live in `notifier.ts` (the only
 * I/O module). This file decides; it never sends.
 *
 * PRD §8; §16 cases 7/8/9; docs/documentation/telegram.md.
 */

import type { EffectiveSettings, Importance } from '../db/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The minimal deal shape the predicate needs. A real `DealInsert` satisfies
 * this structurally; `telegram_sent` is the dedupe key (criterion 4) — a
 * freshly-inserted deal passes `false`.
 */
export interface RoutableDeal {
  discount_pct: number; // integer percent from the deal engine
  price_cents: number; // integer cents (the candidate listing price)
  baseline_cents: number; // integer cents (the median baseline)
  telegram_sent: boolean; // already pushed for this product_id? → dedupe
}

/**
 * The subset of `EffectiveSettings` that routing reads. Resolved upstream by
 * `resolveEffective` (§9a) — NULL overrides have already fallen back to config
 * defaults, except the two cap/floor fields which stay `null` (= unbounded).
 */
export type RoutingSettings = Pick<
  EffectiveSettings,
  | 'importance'
  | 'telegram_enabled'
  | 'telegram_min_discount_pct'
  | 'telegram_max_price_cents'
  | 'telegram_min_savings_cents'
>;

/** Inclusive-start, exclusive-end local-hour window for quiet hours. */
export interface QuietHours {
  start: number; // 0-23 local hour
  end: number; // 0-23 local hour
}

/** The routing decision. `priority` is set whether or not we send. */
export interface RoutingDecision {
  send: boolean;
  priority: Importance;
}

// ---------------------------------------------------------------------------
// shouldNotify — the §8 decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a new deal should push to Telegram (PRD §8).
 *
 * A deal pushes only if ALL hold, evaluated in order:
 *  1. Opt-in: the item has `telegram_enabled` OR `importance === 'high'`.
 *  2. Discount gate: `high` importance BYPASSES it; otherwise
 *     `discount_pct >= telegram_min_discount_pct` (per-item override, else the
 *     global default — stricter than the app's 50% feed threshold).
 *  3. Optional caps (only when set, i.e. not null):
 *       - `price_cents <= telegram_max_price_cents`
 *       - `savings_cents (= baseline_cents - price_cents) >= telegram_min_savings_cents`
 *  4. Dedupe: not already sent for this product_id (`telegram_sent === false`).
 *  5. Quiet hours (optional): if a window is configured and the injected local
 *     hour is inside it, HOLD (the digest mechanism is deferred — see plan).
 *
 * @param currentHourLocal injected local hour (0-23); omit to skip the gate.
 * @param quiet quiet-hours window; null/omitted to skip the gate.
 */
export function shouldNotify(
  deal: RoutableDeal,
  eff: RoutingSettings,
  currentHourLocal?: number,
  quiet?: QuietHours | null,
): RoutingDecision {
  const isHigh = eff.importance === 'high';
  const priority: Importance = isHigh ? 'high' : 'normal';

  // 1. Opt-in: enabled OR high importance.
  if (!eff.telegram_enabled && !isHigh) {
    return { send: false, priority };
  }

  // 2. Discount gate: high importance bypasses; otherwise clear the (stricter)
  //    Telegram threshold. `>=` so an exact-threshold deal still fires.
  if (!isHigh && deal.discount_pct < eff.telegram_min_discount_pct) {
    return { send: false, priority };
  }

  // 3. Optional price cap (only when set). null = no cap.
  if (
    eff.telegram_max_price_cents !== null &&
    deal.price_cents > eff.telegram_max_price_cents
  ) {
    return { send: false, priority };
  }

  // 3. Optional savings floor (only when set). null = no floor.
  //    savings = baseline - candidate, integer cents (never a float).
  if (eff.telegram_min_savings_cents !== null) {
    const savingsCents = deal.baseline_cents - deal.price_cents;
    if (savingsCents < eff.telegram_min_savings_cents) {
      return { send: false, priority };
    }
  }

  // 4. Dedupe: one push per product_id, ever.
  if (deal.telegram_sent) {
    return { send: false, priority };
  }

  // 5. Quiet hours (optional). If active, hold — the deal still lives in the
  //    app feed, and the §8 digest can resend it later (mechanism deferred).
  if (
    quiet &&
    currentHourLocal !== undefined &&
    inQuietHours(currentHourLocal, quiet)
  ) {
    return { send: false, priority };
  }

  return { send: true, priority };
}

// ---------------------------------------------------------------------------
// inQuietHours — pure quiet-window check (handles midnight wrap-around)
// ---------------------------------------------------------------------------

/**
 * Is `hour` inside the quiet window `[start, end)`?
 *
 * Handles wrap-around: a window of 22→6 means 22,23,0..5 are quiet. A window
 * where start === end is treated as empty (no quiet hours), matching the
 * "configure both or neither" convention.
 */
export function inQuietHours(hour: number, quiet: QuietHours): boolean {
  const { start, end } = quiet;
  if (start === end) {
    return false; // degenerate window → quiet hours effectively off
  }
  if (start < end) {
    // Same-day window, e.g. 1→6 → 1,2,3,4,5 quiet.
    return hour >= start && hour < end;
  }
  // Wrap-around window, e.g. 22→6 → 22,23,0,1,2,3,4,5 quiet.
  return hour >= start || hour < end;
}
