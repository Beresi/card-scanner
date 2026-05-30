/**
 * Telemetry selectors — derived statistics computed from MOCK_DEALS.
 * These are pure functions so they can be called from hooks.ts or directly
 * by the right-rail telemetry component.
 *
 * "Open" means: not dismissed (seen status is not filtered out).
 */
import { savings } from '../lib/format';
import type { Deal } from '../api/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscountHistogram {
  /** Count of open deals with discount_pct in [40, 49] */
  bucket40: number;
  /** Count of open deals with discount_pct in [50, 59] */
  bucket50: number;
  /** Count of open deals with discount_pct in [60, 69] */
  bucket60: number;
  /** Count of open deals with discount_pct >= 70 */
  bucket70plus: number;
}

export interface TelemetryStats {
  /** Total open (non-dismissed) deals */
  openDeals: number;
  /** Open deals the user hasn't seen yet */
  unseenDeals: number;
  /** Sum of savings() over all open deals, in cents */
  potentialSavingsCents: number;
  /** Number of scan runs today (UTC day) */
  scansToday: number;
  /** Discount-bucket histogram */
  histogram: DiscountHistogram;
}

// ---------------------------------------------------------------------------
// Individual selectors
// ---------------------------------------------------------------------------

/** Open deals = not dismissed */
export function selectOpenDeals(deals: Deal[]): Deal[] {
  return deals.filter((d) => d.dismissed === 0);
}

/** Unseen open deals */
export function selectUnseenCount(deals: Deal[]): number {
  return deals.filter((d) => d.dismissed === 0 && d.seen === 0).length;
}

/**
 * Sum of savings (baseline - price) over all open deals, in cents.
 * savings() is from lib/format and is the canonical derivation.
 */
export function selectPotentialSavingsCents(deals: Deal[]): number {
  return selectOpenDeals(deals).reduce(
    (acc, d) => acc + savings(d.baseline_cents, d.price_cents),
    0,
  );
}

/**
 * Count how many scan runs started today (UTC calendar day).
 * Pass the scan run list; each run has a started_at SQLite UTC datetime.
 */
export function selectScansToday(
  scanRuns: Array<{ started_at: string }>,
): number {
  const todayUTC = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  return scanRuns.filter((r) => r.started_at.startsWith(todayUTC)).length;
}

/** Discount bucket histogram over open deals */
export function selectHistogram(deals: Deal[]): DiscountHistogram {
  const open = selectOpenDeals(deals);
  return open.reduce<DiscountHistogram>(
    (acc, d) => {
      if (d.discount_pct >= 70) acc.bucket70plus++;
      else if (d.discount_pct >= 60) acc.bucket60++;
      else if (d.discount_pct >= 50) acc.bucket50++;
      else if (d.discount_pct >= 40) acc.bucket40++;
      return acc;
    },
    { bucket40: 0, bucket50: 0, bucket60: 0, bucket70plus: 0 },
  );
}

/** All telemetry stats in one call */
export function selectTelemetry(
  deals: Deal[],
  scanRuns: Array<{ started_at: string }>,
): TelemetryStats {
  return {
    openDeals: selectOpenDeals(deals).length,
    unseenDeals: selectUnseenCount(deals),
    potentialSavingsCents: selectPotentialSavingsCents(deals),
    scansToday: selectScansToday(scanRuns),
    histogram: selectHistogram(deals),
  };
}
