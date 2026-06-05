/**
 * Tests for shouldRunCron() — the pure heartbeat-gate helper.
 *
 * The cron now fires every minute; shouldRunCron() decides whether enough
 * minutes have elapsed since the last run started before a new scan is allowed.
 *
 * Cases covered:
 *  - No prior run (null) → always run
 *  - Elapsed time < interval → skip
 *  - Elapsed time exactly equal to interval → run (boundary is inclusive)
 *  - Elapsed time > interval → run
 *  - Default interval (60 minutes)
 *  - Minimum interval (1 minute)
 */

import { describe, it, expect } from 'vitest';
import { shouldRunCron } from './cronGate';

/** Build a UTC SQLite datetime string (without 'Z') offset by `deltaMinutes`. */
function isoMinsAgo(nowMs: number, deltaMinutes: number): string {
  const ms = nowMs - deltaMinutes * 60_000;
  // Produce "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now') format, no 'Z').
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0); // fixed reference point

describe('shouldRunCron — no prior run', () => {
  it('returns true when lastStartedAtIso is null (first ever scan)', () => {
    expect(shouldRunCron(null, 60, NOW)).toBe(true);
  });
});

describe('shouldRunCron — too soon', () => {
  it('returns false when elapsed < interval (1 minute in, 60-min interval)', () => {
    const last = isoMinsAgo(NOW, 1);
    expect(shouldRunCron(last, 60, NOW)).toBe(false);
  });

  it('returns false when elapsed < interval (59 minutes in, 60-min interval)', () => {
    const last = isoMinsAgo(NOW, 59);
    expect(shouldRunCron(last, 60, NOW)).toBe(false);
  });

  it('returns false when elapsed < interval (30 minutes in, 60-min interval)', () => {
    const last = isoMinsAgo(NOW, 30);
    expect(shouldRunCron(last, 60, NOW)).toBe(false);
  });

  it('returns false for 5-min interval with only 4 minutes elapsed', () => {
    const last = isoMinsAgo(NOW, 4);
    expect(shouldRunCron(last, 5, NOW)).toBe(false);
  });
});

describe('shouldRunCron — boundary: exactly at interval', () => {
  it('returns true when elapsed === interval (60 of 60 minutes)', () => {
    const last = isoMinsAgo(NOW, 60);
    expect(shouldRunCron(last, 60, NOW)).toBe(true);
  });

  it('returns true when elapsed === interval (1 of 1 minute)', () => {
    const last = isoMinsAgo(NOW, 1);
    expect(shouldRunCron(last, 1, NOW)).toBe(true);
  });

  it('returns true when elapsed === interval (1440 of 1440 minutes)', () => {
    const last = isoMinsAgo(NOW, 1440);
    expect(shouldRunCron(last, 1440, NOW)).toBe(true);
  });
});

describe('shouldRunCron — overdue (elapsed > interval)', () => {
  it('returns true when elapsed > interval (90 of 60 minutes)', () => {
    const last = isoMinsAgo(NOW, 90);
    expect(shouldRunCron(last, 60, NOW)).toBe(true);
  });

  it('returns true when elapsed > interval (120 of 60 minutes)', () => {
    const last = isoMinsAgo(NOW, 120);
    expect(shouldRunCron(last, 60, NOW)).toBe(true);
  });

  it('returns true when elapsed >> interval (long gap, e.g. Worker was down)', () => {
    const last = isoMinsAgo(NOW, 1440);
    expect(shouldRunCron(last, 60, NOW)).toBe(true);
  });
});

describe('shouldRunCron — minimum interval (1 minute)', () => {
  it('returns false at 0 minutes elapsed with 1-minute interval', () => {
    // Simulate a run that just started (< 1 min ago).
    const last = isoMinsAgo(NOW, 0); // exactly now — 0 minutes elapsed
    // 0 >= 1 is false
    expect(shouldRunCron(last, 1, NOW)).toBe(false);
  });

  it('returns true at exactly 1 minute elapsed with 1-minute interval', () => {
    const last = isoMinsAgo(NOW, 1);
    expect(shouldRunCron(last, 1, NOW)).toBe(true);
  });
});
