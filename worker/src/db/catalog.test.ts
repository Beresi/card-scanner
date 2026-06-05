/**
 * Unit tests for selectNextCatalogExpansions — the catalog-sync cursor that
 * decides which expansions the hourly cron re-pulls blueprints for.
 *
 * The durable freshness contract (the fix for the "found the set but can't
 * search its cards" bug):
 *   - Never-synced sets (blueprints_synced_at IS NULL) are always picked first,
 *     regardless of age or how new the set is.
 *   - Stale re-checks (synced > refreshDays ago) are limited to the newest
 *     `newSetCount` sets by id — this un-freezes recently-released sparse sets
 *     without re-pulling the whole stable back-catalogue every week.
 *   - Sets synced WITHIN the window are skipped (no wasted CardTrader calls).
 *   - Stale OLD sets (outside the new-set window) are left frozen.
 *   - Only game_id = 1 (MTG) is ever considered.
 */

import { describe, it, expect } from 'vitest';
import { makeD1 } from '../api/__test-helpers__/d1';
import { selectNextCatalogExpansions } from './repo';
import type Database from 'better-sqlite3';

const REFRESH_DAYS = 7;
// Large enough that every seeded set counts as "new" unless a test overrides it.
const NEW_SET_COUNT = 1000;

/** Seed one expansion row with an explicit blueprints_synced_at (SQLite expr or NULL). */
function seedExpansion(
  raw: Database.Database,
  fields: { id: number; game_id?: number; code?: string; name?: string; bpSyncedAt?: string | null },
): void {
  const { id, game_id = 1, code = `c${id}`, name = `Set ${id}`, bpSyncedAt = null } = fields;
  const bpVal =
    bpSyncedAt === null
      ? 'NULL'
      : bpSyncedAt.startsWith('datetime(')
        ? bpSyncedAt
        : `'${bpSyncedAt}'`;
  raw.exec(
    `INSERT INTO expansions (id, game_id, code, name, blueprints_synced_at)
     VALUES (${id}, ${game_id}, '${code}', '${name}', ${bpVal})`,
  );
}

describe('selectNextCatalogExpansions — freshness cursor', () => {
  it('returns [] when limit <= 0', async () => {
    const { db } = makeD1();
    expect(await selectNextCatalogExpansions(db, 0, REFRESH_DAYS, NEW_SET_COUNT)).toEqual([]);
    expect(await selectNextCatalogExpansions(db, -3, REFRESH_DAYS, NEW_SET_COUNT)).toEqual([]);
  });

  it('picks never-synced (NULL) sets', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 10, bpSyncedAt: null });
    seedExpansion(raw, { id: 11, bpSyncedAt: null });
    const ids = await selectNextCatalogExpansions(db, 10, REFRESH_DAYS, NEW_SET_COUNT);
    expect(ids.sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('re-picks a new set synced longer ago than refreshDays (un-freeze)', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 20, bpSyncedAt: "datetime('now','-30 days')" });
    const ids = await selectNextCatalogExpansions(db, 10, REFRESH_DAYS, NEW_SET_COUNT);
    expect(ids).toEqual([20]);
  });

  it('skips a set synced within the refresh window (no wasted calls)', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 30, bpSyncedAt: "datetime('now','-2 days')" });
    const ids = await selectNextCatalogExpansions(db, 10, REFRESH_DAYS, NEW_SET_COUNT);
    expect(ids).toEqual([]);
  });

  it('prioritises never-synced over stale, then stalest-first', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 40, bpSyncedAt: "datetime('now','-10 days')" }); // stale, less old
    seedExpansion(raw, { id: 41, bpSyncedAt: "datetime('now','-40 days')" }); // stale, oldest
    seedExpansion(raw, { id: 42, bpSyncedAt: null });                          // never synced
    seedExpansion(raw, { id: 43, bpSyncedAt: "datetime('now','-1 days')" });   // fresh → excluded
    const ids = await selectNextCatalogExpansions(db, 10, REFRESH_DAYS, NEW_SET_COUNT);
    // 42 (NULL) first, then 41 (oldest), then 40; 43 excluded.
    expect(ids).toEqual([42, 41, 40]);
  });

  it('honours the limit', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 50, bpSyncedAt: null });
    seedExpansion(raw, { id: 51, bpSyncedAt: null });
    seedExpansion(raw, { id: 52, bpSyncedAt: null });
    const ids = await selectNextCatalogExpansions(db, 2, REFRESH_DAYS, NEW_SET_COUNT);
    expect(ids).toHaveLength(2);
  });

  it('ignores non-MTG (game_id != 1) sets', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 60, game_id: 2, bpSyncedAt: null });            // not MTG
    seedExpansion(raw, { id: 61, game_id: 5, bpSyncedAt: "datetime('now','-99 days')" }); // not MTG, stale
    seedExpansion(raw, { id: 62, game_id: 1, bpSyncedAt: null });            // MTG
    const ids = await selectNextCatalogExpansions(db, 10, REFRESH_DAYS, NEW_SET_COUNT);
    expect(ids).toEqual([62]);
  });

  // --- new-set window behaviour ---

  it('re-checks a stale set INSIDE the new-set window but freezes one OUTSIDE it', async () => {
    const { db, raw } = makeD1();
    // 10 sets; newSetCount = 3 → only the 3 highest ids (300,301,302) are "new".
    for (let i = 0; i < 10; i++) {
      seedExpansion(raw, { id: 200 + i, bpSyncedAt: "datetime('now','-30 days')" });
    }
    const ids = await selectNextCatalogExpansions(db, 50, REFRESH_DAYS, 3);
    // Only the newest 3 ids re-checked; the older 7 stale sets stay frozen.
    expect(ids).toEqual([209, 208, 207]);
  });

  it('still backfills a never-synced OLD set even when outside the new-set window', async () => {
    const { db, raw } = makeD1();
    seedExpansion(raw, { id: 500, bpSyncedAt: null });                          // old, never synced
    seedExpansion(raw, { id: 900, bpSyncedAt: "datetime('now','-1 days')" });   // new, fresh
    seedExpansion(raw, { id: 901, bpSyncedAt: "datetime('now','-1 days')" });   // new, fresh
    // newSetCount = 2 → window is {900, 901}; id 500 is outside it but NULL, so it must still appear.
    const ids = await selectNextCatalogExpansions(db, 50, REFRESH_DAYS, 2);
    expect(ids).toEqual([500]);
  });
});
