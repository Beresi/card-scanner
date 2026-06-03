/**
 * conditions.ts — canonical CardTrader 7-grade condition vocabulary.
 *
 * Single source of truth for condition values, dropdown options, and
 * compact badge labels. Import from here — never hardcode condition
 * strings inline in components.
 */

import type { Condition } from '../api/types';

/** Full ordered list of canonical condition values, best → worst. */
export const CONDITION_VALUES: Condition[] = [
  'Mint',
  'Near Mint',
  'Slightly Played',
  'Moderately Played',
  'Played',
  'Heavily Played',
  'Poor',
];

/** Dropdown option list — value IS the canonical name; label is the same. */
export const CONDITION_OPTIONS: { value: Condition; label: string }[] = CONDITION_VALUES.map(
  (v) => ({ value: v, label: v }),
);

/**
 * Short badge labels for compact table / deal-card display.
 * 'Mint'->'M', 'Near Mint'->'NM', 'Slightly Played'->'SP',
 * 'Moderately Played'->'MP', 'Played'->'PL', 'Heavily Played'->'HP', 'Poor'->'PO'
 */
export const CONDITION_SHORT: Record<Condition, string> = {
  Mint:              'M',
  'Near Mint':       'NM',
  'Slightly Played': 'SP',
  'Moderately Played': 'MP',
  Played:            'PL',
  'Heavily Played':  'HP',
  Poor:              'PO',
};

/**
 * conditionShort — look up a compact badge label from any string.
 * Falls back to the raw string (trimmed to 4 chars) if unknown.
 */
export function conditionShort(condition: string | null | undefined): string {
  if (!condition) return '?';
  return (CONDITION_SHORT as Record<string, string>)[condition] ?? condition.slice(0, 4);
}
