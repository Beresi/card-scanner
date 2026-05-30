/**
 * Deal-detection engine — pure function, no I/O, no DB, no Date.now().
 *
 * Given one blueprint's cheapest-25 marketplace listings and fully-resolved
 * effective settings (NULL inheritance already applied upstream by
 * resolveEffective, PRD §9a), decides whether the cheapest qualifying copy
 * is an underpriced deal and by how much.
 *
 * Algorithm: filter → price-sort ascending → thin-market guard → median
 * baseline of the next-cheapest cohort (candidate excluded) → threshold gate.
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
 * Returns a DealResult when ALL three conditions hold:
 *  1. Candidate price ≤ threshold_pct % of the cohort median (% gate).
 *  2. Candidate price ≥ min_price_cents (absolute price floor — suppresses bulk/penny-card
 *     false positives where the savings are trivially small in dollar terms).
 *  3. (Baseline − candidate) ≥ min_savings_cents (absolute savings floor — same guard).
 *
 * The authoritative verdict is the integer-cents comparison for all three conditions;
 * the rounded discountPct is informational only and never gates the verdict.
 *
 * Returns null on thin-market or no-deal.
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
  // 3. Thin-market guard: need candidate PLUS at least min_cohort comparators.
  // ------------------------------------------------------------------
  if (sorted.length < settings.min_cohort + 1) {return null;}

  // ------------------------------------------------------------------
  // 4. Candidate is sorted[0]; cohort is the NEXT cheapest (candidate excluded).
  //    Cohort slice starts at index 1 — never 0. Including the candidate
  //    would drag the baseline toward the very price being tested.
  // ------------------------------------------------------------------
  const candidate = sorted[0];
  const cohort = sorted.slice(1, 1 + settings.cohort_size);
  if (cohort.length < settings.min_cohort) {return null;}

  // ------------------------------------------------------------------
  // 5. Median baseline — integer cents, never a float.
  // ------------------------------------------------------------------
  const baselineCents = median(cohort.map((p) => p.price.cents));

  // ------------------------------------------------------------------
  // 6. Discount + verdict.
  //
  //    All three conditions must hold (integer-cents comparisons only —
  //    NEVER branch on the rounded discountPct):
  //      a) % gate:          candidate.price.cents <= (threshold_pct/100) * baseline
  //      b) price floor:     candidate.price.cents >= min_price_cents
  //      c) savings floor:   savingsCents          >= min_savings_cents
  //
  //    Floors (b) and (c) suppress bulk/penny-card false positives where
  //    the absolute saving is trivially small even if the % looks large.
  // ------------------------------------------------------------------
  const savingsCents = baselineCents - candidate.price.cents;
  const discountPct = Math.round(
    (1 - candidate.price.cents / baselineCents) * 100,
  );

  const isDeal =
    candidate.price.cents <= (settings.threshold_pct / 100) * baselineCents &&
    candidate.price.cents >= settings.min_price_cents &&
    savingsCents >= settings.min_savings_cents;

  if (!isDeal) {return null;}

  return {
    product: candidate,
    baselineCents,
    cohortSize: cohort.length,
    discountPct,
    savingsCents,
  };
}
