/**
 * Deal-detection engine — pure function, no I/O, no DB, no Date.now().
 *
 * Given one blueprint's cheapest-25 marketplace listings and fully-resolved
 * effective settings (NULL inheritance already applied upstream by
 * resolveEffective, PRD §9a), decides whether the cheapest qualifying copy
 * is an underpriced deal and by how much.
 *
 * Two detection modes (settings.detection_mode):
 *  - 'discount' (default): filter → price-sort → thin-market guard → median
 *    baseline of the next-cheapest cohort (candidate excluded) → threshold gate.
 *  - 'price': filter → price-sort → candidate = cheapest passing copy → deal
 *    when candidate.cents <= settings.max_price_cents. No thin-market guard;
 *    no floor gates. Self-baseline encoding for the deals row (see below).
 *
 * All money is integer cents throughout — no floats. The authoritative verdict
 * gate is the cents comparison, not the rounded discountPct.
 *
 * PRD §7; docs/documentation/deal-engine.md.
 */

import type { Product } from '../cardtrader/types';
import type { EffectiveSettings } from '../db/types';
import { conditionRank, median, CONDITION_RANK, type Condition } from './conditions';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DealResult {
  /** The candidate (cheapest qualifying) listing. */
  product: Product;
  /** Median of the cohort, integer cents — never a float. */
  baselineCents: number;
  /**
   * Price of the 2nd-cheapest qualifying copy, integer cents — the price you'd
   * actually pay if you missed the candidate. This is the gap-gate baseline.
   * In price mode there is no cohort, so this equals the candidate price.
   */
  secondCheapestCents: number;
  /**
   * Math.round((1 - candidate.cents / secondCheapestCents) * 100) — how far the
   * candidate is below the next-available copy. 0 in price mode.
   */
  gapPct: number;
  /**
   * Mean (rounded integer cents) of the next-4-cheapest qualifying copies
   * (the 2nd–5th cheapest). A middle-ground baseline between "next copy" and the
   * full-cohort median. In price mode this equals the candidate price.
   */
  avg4Cents: number;
  /** Actual cohort length used (may be < cohort_size if market is thin). */
  cohortSize: number;
  /** Math.round((1 - candidate.cents / baseline) * 100) */
  discountPct: number;
  /** baselineCents - candidate.price.cents, integer cents. */
  savingsCents: number;
}

// ---------------------------------------------------------------------------
// Defensive condition narrowing
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true iff the string is a key of the condition ladder.
 *
 * Used before calling conditionRank() on untrusted wire data — one malformed
 * listing must not crash the whole blueprint (conditionRank throws on unknown
 * by contract). Unknown condition strings are silently dropped from filtered.
 */
function isCondition(s: string): s is Condition {
  return Object.prototype.hasOwnProperty.call(CONDITION_RANK, s);
}

// ---------------------------------------------------------------------------
// Foil matching helper
// ---------------------------------------------------------------------------

function foilMatches(
  isFoil: boolean,
  pref: EffectiveSettings['foil_pref'],
): boolean {
  if (pref === 'any') {return true;}
  return pref === 'foil' ? isFoil : !isFoil;
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Evaluate one blueprint's listings against resolved effective settings.
 *
 * Dispatches on settings.detection_mode:
 *
 * 'discount' (default) — Returns a DealResult when ALL three conditions hold:
 *  1. Candidate price is at least min_discount_pct % BELOW the cohort median (% gate).
 *  2. Candidate price ≥ min_price_cents (absolute price floor — suppresses bulk/penny-card
 *     false positives where the savings are trivially small in dollar terms).
 *  3. (Baseline − candidate) ≥ min_savings_cents (absolute savings floor — same guard).
 *
 *  The authoritative verdict is the integer-cents comparison for all three conditions;
 *  the rounded discountPct is informational only and never gates the verdict.
 *
 *  Returns null on thin-market or no-deal.
 *
 * 'price' — Returns a DealResult when candidate.price.cents <= settings.max_price_cents.
 *  No thin-market guard (a single listing can still be a deal).
 *  Returns null when settings.max_price_cents is null (no ceiling configured).
 *
 * Pure: same inputs → same output. No side effects.
 */
export function evaluateBlueprint(
  products: Product[],
  settings: EffectiveSettings,
): DealResult | null {
  // ------------------------------------------------------------------
  // 1. Filter the cheapest-25 down to qualifying copies.
  //    DEFENSIVE: properties_hash.condition is an untrusted wire string.
  //    If it is not a key of the condition ladder, DROP the listing so
  //    one malformed listing does not crash the blueprint.
  // ------------------------------------------------------------------
  const filtered = products.filter((p) => {
    if (p.properties_hash.mtg_language !== 'en') {return false;}
    if (p.on_vacation !== false) {return false;}
    if (!settings.allow_graded && p.graded !== false) {return false;}
    if (p.quantity < 1) {return false;}

    // Foil check before condition so a foil-excluded listing is dropped early.
    if (!foilMatches(p.properties_hash.mtg_foil, settings.foil_pref)) {return false;}

    // Defensive condition narrowing — unknown string → drop, do NOT call conditionRank.
    const cond = p.properties_hash.condition;
    if (!isCondition(cond)) {return false;}

    // Keep if condition rank meets or exceeds the minimum.
    return conditionRank(cond) >= conditionRank(settings.min_condition);
  });

  // ------------------------------------------------------------------
  // 2. Price-sort ascending by integer cents (copy — never mutate input).
  // ------------------------------------------------------------------
  const sorted = [...filtered].sort((a, b) => a.price.cents - b.price.cents);

  // ------------------------------------------------------------------
  // 3. Branch on detection mode.
  // ------------------------------------------------------------------
  if (settings.detection_mode === 'price') {
    return evaluatePriceMode(sorted, settings);
  }

  // Default: 'discount' mode — original 3-gate path.
  return evaluateDiscountMode(sorted, settings);
}

// ---------------------------------------------------------------------------
// Discount mode (default)
// ---------------------------------------------------------------------------

/**
 * Original discount-mode evaluation — thin-market guard, cohort median
 * baseline, and 3-gate verdict (%, price floor, savings floor).
 *
 * Receives the already-filtered, price-sorted array from evaluateBlueprint.
 */
function evaluateDiscountMode(
  sorted: Product[],
  settings: EffectiveSettings,
): DealResult | null {
  // ------------------------------------------------------------------
  // Thin-market guard: need candidate PLUS at least min_cohort comparators.
  // ------------------------------------------------------------------
  if (sorted.length < settings.min_cohort + 1) {return null;}

  // ------------------------------------------------------------------
  // Candidate is sorted[0]; cohort is the NEXT cheapest (candidate excluded).
  //    Cohort slice starts at index 1 — never 0. Including the candidate
  //    would drag the baseline toward the very price being tested.
  // ------------------------------------------------------------------
  const candidate = sorted[0];
  const cohort = sorted.slice(1, 1 + settings.cohort_size);
  if (cohort.length < settings.min_cohort) {return null;}

  // ------------------------------------------------------------------
  // Median baseline — integer cents, never a float.
  // ------------------------------------------------------------------
  const baselineCents = median(cohort.map((p) => p.price.cents));

  // ------------------------------------------------------------------
  // Gap-to-next baseline — the 2nd-cheapest qualifying copy (cohort[0] ===
  // sorted[1]). This is the price you'd actually pay if you missed the
  // candidate. cohort is guaranteed non-empty here (median() above would have
  // thrown otherwise), so cohort[0] always exists.
  // ------------------------------------------------------------------
  const secondCheapestCents = cohort[0].price.cents;
  const gapPct = Math.round(
    (1 - candidate.price.cents / secondCheapestCents) * 100,
  );

  // Average of the next-4-cheapest (2nd–5th). cohort is guaranteed non-empty;
  // take up to 4 (a thin cohort that still cleared min_cohort may have fewer).
  const next4 = cohort.slice(0, 4).map((p) => p.price.cents);
  const avg4Cents = Math.round(next4.reduce((sum, c) => sum + c, 0) / next4.length);

  // ------------------------------------------------------------------
  // Discount + verdict.
  //
  //    All FOUR conditions must hold (integer-cents comparisons only —
  //    NEVER branch on the rounded discountPct/gapPct):
  //      a) % gate:          candidate.price.cents <= (1 - min_discount_pct/100) * baseline
  //                          i.e. candidate is at least min_discount_pct% BELOW the median.
  //                          min_discount_pct=0 means "any copy at or below the median qualifies".
  //      b) gap gate:        candidate.price.cents <= (1 - min_gap_pct/100) * secondCheapest
  //                          i.e. candidate is at least min_gap_pct% below the NEXT-available
  //                          copy. Kills tightly-packed ladders where the median makes a
  //                          penny-cheaper copy look like a big discount. min_gap_pct=0 disables.
  //      c) price floor:     candidate.price.cents >= min_price_cents
  //      d) savings floor:   savingsCents          >= min_savings_cents
  //
  //    Floors (c) and (d) suppress bulk/penny-card false positives where
  //    the absolute saving is trivially small even if the % looks large.
  // ------------------------------------------------------------------
  const savingsCents = baselineCents - candidate.price.cents;
  const discountPct = Math.round(
    (1 - candidate.price.cents / baselineCents) * 100,
  );

  const isDeal =
    candidate.price.cents <= (1 - settings.min_discount_pct / 100) * baselineCents &&
    candidate.price.cents <= (1 - settings.min_gap_pct / 100) * secondCheapestCents &&
    candidate.price.cents >= settings.min_price_cents &&
    savingsCents >= settings.min_savings_cents;

  if (!isDeal) {return null;}

  return {
    product: candidate,
    baselineCents,
    secondCheapestCents,
    gapPct,
    avg4Cents,
    cohortSize: cohort.length,
    discountPct,
    savingsCents,
  };
}

// ---------------------------------------------------------------------------
// Price mode
// ---------------------------------------------------------------------------

/**
 * Absolute-price detection mode — fires when the cheapest qualifying copy
 * is at or below the configured price ceiling.
 *
 * Key differences from discount mode:
 *  - No thin-market guard: a single listing qualifies (there is no cohort
 *    median to compute, so the market depth is irrelevant).
 *  - Anti-penny floors (min_price_cents, min_savings_cents) do NOT apply:
 *    the explicit ceiling IS the price intent, and min_savings_cents is
 *    meaningless without a discount baseline.
 *  - If settings.max_price_cents is null, there is no ceiling to test against
 *    and the item has no actionable price mode configured — return null.
 *
 * Self-baseline encoding for the deals row:
 *  - baselineCents        = candidate.price.cents  (self-reference; no external median)
 *  - secondCheapestCents  = candidate.price.cents  (gap gate N/A in price mode)
 *  - gapPct               = 0                       (no gap relative to a next copy)
 *  - avg4Cents            = candidate.price.cents  (no cohort to average)
 *  - discountPct          = 0                       (no discount relative to a baseline)
 *  - savingsCents         = 0                       (no savings relative to a baseline)
 *  - cohortSize           = sorted.length           (informational: total passing listings)
 *
 * The Telegram discount gate will not fire for price-mode deals (discountPct=0);
 * the importance bypass or a per-item telegram_max_price_cents cap are the
 * relevant Telegram controls for price-mode items.
 *
 * Receives the already-filtered, price-sorted array from evaluateBlueprint.
 */
function evaluatePriceMode(
  sorted: Product[],
  settings: EffectiveSettings,
): DealResult | null {
  // Price mode requires a ceiling; without one there is nothing to test.
  if (settings.max_price_cents === null) {return null;}

  // No listings pass the condition/foil/graded filters → no candidate.
  if (sorted.length === 0) {return null;}

  const candidate = sorted[0];
  const isDeal = candidate.price.cents <= settings.max_price_cents;

  if (!isDeal) {return null;}

  // Self-baseline: baseline = candidate price, discount = 0, savings = 0.
  // The gap gate does not apply in price mode (the ceiling IS the intent), so
  // secondCheapest self-references the candidate and gapPct = 0.
  // cohortSize = total passing listings (informational; includes candidate).
  return {
    product: candidate,
    baselineCents: candidate.price.cents,
    secondCheapestCents: candidate.price.cents,
    gapPct: 0,
    avg4Cents: candidate.price.cents,
    cohortSize: sorted.length,
    discountPct: 0,
    savingsCents: 0,
  };
}
