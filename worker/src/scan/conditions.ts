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
// Canonical condition set (exported for validation in route handlers)
// ---------------------------------------------------------------------------

/**
 * All recognised CardTrader 7-grade condition names, in rank order (best → worst).
 * Use this array to validate incoming strings before storing or passing to the engine.
 */
export const CONDITIONS: readonly Condition[] = [
  'Mint',
  'Near Mint',
  'Slightly Played',
  'Moderately Played',
  'Played',
  'Heavily Played',
  'Poor',
] as const;

/**
 * Legacy TCGplayer 5-grade codes → canonical CardTrader 7-grade names.
 * Kept here as a defence-in-depth mapping; the DB migration converts stored
 * rows so this should never be needed in production after migration 0007.
 */
const LEGACY_CODE_MAP: Record<string, Condition> = {
  NM: 'Near Mint',
  LP: 'Slightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  D:  'Poor',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an arbitrary string to a Condition.
 *
 * - If it is already a canonical name → return it unchanged.
 * - If it is a legacy TCGplayer code → map to the canonical name.
 * - Otherwise → return 'Near Mint' (the safest default).
 *
 * This is a pure function — no I/O. The console.warn for unrecognised values
 * lives in the caller (resolve.ts) so that this module stays side-effect free.
 */
export function normalizeCondition(s: string): Condition {
  if ((CONDITION_RANK as Record<string, number>)[s] !== undefined) {
    return s as Condition;
  }
  const mapped = LEGACY_CODE_MAP[s];
  if (mapped !== undefined) {
    return mapped;
  }
  return 'Near Mint';
}

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
