/**
 * Condition ladder and median helper for the deal-detection engine.
 *
 * Pure module — no I/O, no networking, no DB, no Date.now().
 * All money handled here is integer cents; median never emits a float.
 *
 * PRD §7; docs/documentation/deal-engine.md (Condition ladder section).
 */

// ---------------------------------------------------------------------------
// Condition type + rank ladder
// ---------------------------------------------------------------------------

export type Condition =
  | 'Mint'
  | 'Near Mint'
  | 'Slightly Played'
  | 'Moderately Played'
  | 'Played'
  | 'Heavily Played'
  | 'Poor';

/**
 * Rank ladder: higher = better condition. Mint:7 … Poor:1.
 * Exported as a const Record so callers can reference ranks directly when
 * building fixtures, but the canonical access path is conditionRank().
 */
export const CONDITION_RANK: Record<Condition, number> = {
  Mint: 7,
  'Near Mint': 6,
  'Slightly Played': 5,
  'Moderately Played': 4,
  Played: 3,
  'Heavily Played': 2,
  Poor: 1,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the rank for a condition.
 *
 * Throws if the value is not a recognised Condition — an unknown string at
 * this layer is always a bug (the wire is narrowed to Condition upstream),
 * so failing loud is correct. Do NOT return 0 or a sentinel.
 */
export function conditionRank(c: Condition): number {
  const rank = CONDITION_RANK[c];
  if (rank === undefined) {
    throw new Error(`Unknown condition: "${String(c)}"`);
  }
  return rank;
}

/**
 * Return true when condition c is at least as good as the minimum.
 *
 * "At least as good" means the rank is >= the minimum's rank, i.e. a Near
 * Mint copy passes a Near Mint minimum; a Played copy does not.
 */
export function meetsMinCondition(c: Condition, min: Condition): boolean {
  return conditionRank(c) >= conditionRank(min);
}

/**
 * Median of an array of integer-cent values.
 *
 * Sorting is done on a copy so the caller's array is not mutated.
 * Even-length arrays: average of the two middles, rounded to the nearest
 * integer cent (Math.round) — never emits a float.
 *
 * Throws on an empty array; callers guarantee a non-empty cohort, and a
 * silent 0 would corrupt the baseline.
 */
export function median(nums: readonly number[]): number {
  if (nums.length === 0) {
    throw new Error('median() called with an empty array — cohort must be non-empty');
  }

  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    // Odd length: exact middle element.
    return sorted[mid];
  }

  // Even length: average of the two middle elements, rounded to integer cents.
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
