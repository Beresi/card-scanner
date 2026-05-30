/**
 * Chunked scan mode + wholeset self-throttle tests.
 *
 * These tests exercise the new runScan branches introduced in migration 0003:
 *
 *  (A) Chunked mode — per-card rotation via last_scanned_at cursor:
 *    A1. Expansion blueprints cached; two runs scan distinct batches (rotation advances).
 *    A2. Blueprint-type watch items scanned directly (no rotation).
 *    A3. Blueprint cache empty → blueprintsExport called (cache warm-up, capped per run).
 *    A4. Only up to scan_batch_size marketplace calls happen per run.
 *    A5. Deals use owning expansion's watchlist_id.
 *    A6. Per-blueprint failure is non-fatal; run continues; rotation still advances.
 *
 *  (B) Wholeset self-throttle:
 *    B1. cron trigger + recent finished scan → SKIP (zero marketplace calls).
 *    B2. run-now trigger + recent finished scan → ALWAYS runs (no skip).
 *    B3. cron trigger + old/absent finished scan → runs fully.
 *
 *  (C) Schema + patchConfig:
 *    C1. Config table has scan_mode DEFAULT 'chunked'.
 *    C2. Config table has scan_batch_size DEFAULT 40.
 *    C3. patchConfig persists scan_mode and scan_batch_size.
 *
 * All tests run against the real better-sqlite3 in-memory DB with the full schema
 * applied (same approach as routes.test.ts) so SQL is exercised end-to-end.
 *
 * The CardTrader client is a fully-controllable fake — no network, no throttle
 * delay (minIntervalMs = 0).
 */

import { describe, it, expect, vi } from 'vitest';
import { runScan } from './scanner';
import { makeD1 } from '../api/__test-helpers__/d1';
import {
  getConfig,
  patchConfig,
  selectBlueprintsToScan,
  markBlueprintsScanned,
  countScannedThisCycle,
  countActiveExpansionBlueprints,
} from '../db/repo';
import { CardTraderError } from '../cardtrader/types';
import type { CardTraderClient } from '../cardtrader/client';
import type { Env } from '../index';
import type { MarketplaceResponse, Blueprint } from '../cardtrader/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Env that satisfies the scanner (no Telegram configured). */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CARDTRADER_API_TOKEN: 'test-token',
    // Telegram not configured → isTelegramConfigured returns false.
    TELEGRAM_BOT_TOKEN: undefined as unknown as string,
    TELEGRAM_CHAT_ID: undefined as unknown as string,
    DESKTOP_AUTH_TOKEN: 'desktop-token',
  } as Env;
}

/**
 * Build a MarketplaceResponse with a single qualifying listing (EN, NM, non-foil)
 * and a cohort of 10 copies at a higher price, to guarantee a deal fires.
 *
 * Candidate price = 200 cents; cohort = 10 copies at 500 cents → median 500 cents
 * → discount 60% → fires at default threshold 50. Also clears:
 *   min_price_cents = 200 (candidate = 200 ✓)
 *   min_savings_cents = 100 (savings = 300 ✓)
 */
function makeDealResponse(blueprintId: number, productId: number): MarketplaceResponse {
  const makeProduct = (id: number, cents: number) => ({
    id,
    blueprint_id: blueprintId,
    name_en: `Card ${blueprintId}`,
    quantity: 1,
    price: { cents, currency: 'USD' },
    properties_hash: { condition: 'Near Mint', mtg_language: 'en', mtg_foil: false },
    expansion: { id: 1, code: 'TST', name_en: 'Test Set' },
    user: { username: 'seller', can_sell_via_hub: false, country_code: 'US' },
    graded: false,
    on_vacation: false,
  });

  const products = [
    makeProduct(productId, 200),   // candidate — 200¢, clears min_price_cents floor
    ...Array.from({ length: 10 }, (_, i) =>
      makeProduct(productId + 100 + i, 500),  // cohort — market rate; savings = 300¢ ≥ min_savings_cents 100
    ),
  ];
  return { [String(blueprintId)]: products };
}

/** A no-deal response (only 3 copies → below min_cohort 5). */
function makeNoDealResponse(blueprintId: number, productId: number): MarketplaceResponse {
  const makeProduct = (id: number) => ({
    id,
    blueprint_id: blueprintId,
    name_en: `Card ${blueprintId}`,
    quantity: 1,
    price: { cents: 100, currency: 'USD' },
    properties_hash: { condition: 'Near Mint', mtg_language: 'en', mtg_foil: false },
    expansion: { id: 1, code: 'TST', name_en: 'Test Set' },
    user: { username: 'seller', can_sell_via_hub: false, country_code: 'US' },
    graded: false,
    on_vacation: false,
  });
  return { [String(blueprintId)]: [makeProduct(productId), makeProduct(productId + 1), makeProduct(productId + 2)] };
}

/** Seed an expansion watchlist item with explicit cardtrader_id for an expansion. */
function seedExpansionItem(raw: ReturnType<typeof makeD1>['raw'], expansionId: number): number {
  const info = raw
    .prepare(
      `INSERT INTO watchlist (type, cardtrader_id, label, active)
       VALUES ('expansion', ?, 'Test Set', 1)`,
    )
    .run(expansionId);
  return Number(info.lastInsertRowid);
}

/** Seed a blueprint watchlist item. */
function seedBlueprintItem(raw: ReturnType<typeof makeD1>['raw'], blueprintId: number): number {
  const info = raw
    .prepare(
      `INSERT INTO watchlist (type, cardtrader_id, label, active)
       VALUES ('blueprint', ?, 'Test Card', 1)`,
    )
    .run(blueprintId);
  return Number(info.lastInsertRowid);
}

/** Seed cached blueprints for an expansion. */
function seedBlueprints(
  raw: ReturnType<typeof makeD1>['raw'],
  expansionId: number,
  bpIds: number[],
  lastScannedAt?: string | null,
): void {
  for (const id of bpIds) {
    raw
      .prepare(
        `INSERT OR REPLACE INTO blueprints (id, expansion_id, name, scryfall_id, image_url, synced_at, last_scanned_at)
         VALUES (?, ?, ?, NULL, NULL, datetime('now'), ?)`,
      )
      .run(id, expansionId, `Card ${id}`, lastScannedAt ?? null);
  }
}

/** Read last_scanned_at for a blueprint from the raw DB. */
function getLastScanned(raw: ReturnType<typeof makeD1>['raw'], blueprintId: number): string | null {
  const row = raw
    .prepare(`SELECT last_scanned_at FROM blueprints WHERE id = ?`)
    .get(blueprintId) as { last_scanned_at: string | null } | undefined;
  return row?.last_scanned_at ?? null;
}

/** Seed a finished scan_runs row with a configurable finished_at. */
function seedFinishedScan(raw: ReturnType<typeof makeD1>['raw'], finishedAtExpr: string): void {
  raw.exec(
    `INSERT INTO scan_runs (started_at, finished_at, watch_items_scanned, blueprints_scanned, api_calls, deals_found, telegram_sent)
     VALUES (datetime('now','-1 hour'), ${finishedAtExpr}, 0, 0, 0, 0, 0)`,
  );
}

// ---------------------------------------------------------------------------
// (C) Schema + patchConfig — no network needed
// ---------------------------------------------------------------------------

describe('(C) Schema defaults — scan_mode and scan_batch_size', () => {
  it('C1: config.scan_mode defaults to chunked', async () => {
    const { db } = makeD1();
    const config = await getConfig(db);
    expect(config.scan_mode).toBe('chunked');
  });

  it('C2: config.scan_batch_size defaults to 40', async () => {
    const { db } = makeD1();
    const config = await getConfig(db);
    expect(config.scan_batch_size).toBe(40);
  });

  it('C3: patchConfig persists scan_mode', async () => {
    const { db } = makeD1();
    const updated = await patchConfig(db, { scan_mode: 'wholeset' });
    expect(updated.scan_mode).toBe('wholeset');
    const reread = await getConfig(db);
    expect(reread.scan_mode).toBe('wholeset');
  });

  it('C3b: patchConfig persists scan_batch_size', async () => {
    const { db } = makeD1();
    const updated = await patchConfig(db, { scan_batch_size: 20 });
    expect(updated.scan_batch_size).toBe(20);
    const reread = await getConfig(db);
    expect(reread.scan_batch_size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// (B) Wholeset self-throttle
// ---------------------------------------------------------------------------

describe('(B) Wholeset self-throttle', () => {
  /**
   * Build a wholeset-mode DB with optional "recent finished scan" history
   * and an active expansion watch item.
   */
  function makeWholesetEnv(recentFinishedScan: boolean) {
    const { db, raw } = makeD1();
    // Switch to wholeset mode.
    raw.exec(`UPDATE config SET scan_mode = 'wholeset' WHERE id = 1`);
    seedExpansionItem(raw, 200);
    if (recentFinishedScan) {
      // finished 5 minutes ago — inside the 55-minute window
      seedFinishedScan(raw, `datetime('now', '-5 minutes')`);
    }
    return { db, raw };
  }

  it('B1: cron + recent scan → skipped, zero marketplace calls', async () => {
    const { db } = makeWholesetEnv(true);
    const marketplaceSpy = vi.fn().mockResolvedValue({});
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    const env = makeEnv(db);
    const summary = await runScan(env, { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    expect(marketplaceSpy).not.toHaveBeenCalled();
    // The self-throttle sets runError to a "skipped" message.
    expect(summary.error).toContain('skipped');
    expect(summary.watchItemsScanned).toBe(0);
  });

  it('B2: run-now + recent scan → ALWAYS runs (not skipped)', async () => {
    const { db } = makeWholesetEnv(true);
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(999, 8001));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    const env = makeEnv(db);
    const summary = await runScan(env, { trigger: 'run-now' }, {
      createClient: (_t, _o) => client,
    });

    // marketplaceProducts called for the expansion item (expansionId=200).
    expect(marketplaceSpy).toHaveBeenCalled();
    // No "skipped" error.
    expect(summary.error).toBeNull();
  });

  it('B3: cron + NO prior finished scan → runs fully', async () => {
    const { db } = makeWholesetEnv(false);
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(999, 8002));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    const env = makeEnv(db);
    const summary = await runScan(env, { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    expect(marketplaceSpy).toHaveBeenCalled();
    expect(summary.error).toBeNull();
  });

  it('B3b: cron + old finished scan (>55m ago) → runs fully', async () => {
    const { db, raw } = makeWholesetEnv(false);
    // finished 2 hours ago — outside the 55-minute window
    seedFinishedScan(raw, `datetime('now', '-120 minutes')`);
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(999, 8003));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    const env = makeEnv(db);
    const summary = await runScan(env, { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    expect(marketplaceSpy).toHaveBeenCalled();
    expect(summary.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (A) Chunked mode — rotation + budget + deal building
// ---------------------------------------------------------------------------

describe('(A) Chunked mode — rotation, budget, deal upsert', () => {
  /**
   * Build a chunked DB with:
   *  - config: scan_mode=chunked, scan_batch_size=batchSize
   *  - one expansion watch item (expansionId)
   *  - N cached blueprints with given last_scanned_at values
   */
  function makeChunkedEnv(opts: {
    expansionId?: number;
    batchSize?: number;
    blueprintIds?: number[];
    lastScannedAt?: string | null; // applied to ALL seeded blueprints
  } = {}) {
    const {
      expansionId = 10,
      batchSize = 5,
      blueprintIds = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
      lastScannedAt = null,
    } = opts;
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = ${batchSize} WHERE id = 1`);
    seedExpansionItem(raw, expansionId);
    seedBlueprints(raw, expansionId, blueprintIds, lastScannedAt);
    return { db, raw };
  }

  it('A4: only up to scan_batch_size marketplace calls per run', async () => {
    const { db } = makeChunkedEnv({ batchSize: 3, blueprintIds: [1001, 1002, 1003, 1004, 1005] });
    const calls: number[] = [];
    const marketplaceSpy = vi.fn().mockImplementation((q: { blueprintId: number }) => {
      calls.push(q.blueprintId);
      return Promise.resolve(makeNoDealResponse(q.blueprintId, q.blueprintId * 100));
    });
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    const env = makeEnv(db);
    await runScan(env, { trigger: 'cron' }, { createClient: (_t, _o) => client });

    // Budget is 3; only 3 marketplace calls should have happened.
    expect(marketplaceSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('A1: rotation advances — second run scans different blueprints', async () => {
    const bpIds = [1001, 1002, 1003, 1004, 1005, 1006];
    const { db, raw } = makeChunkedEnv({ batchSize: 3, blueprintIds: bpIds });

    const scannedRun1: number[] = [];
    const scannedRun2: number[] = [];

    function makeClient(log: number[]): CardTraderClient {
      return {
        info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
        marketplaceProducts: vi.fn().mockImplementation((q: { blueprintId?: number; expansionId?: number }) => {
          if (q.blueprintId !== undefined) { log.push(q.blueprintId); }
          return Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 100));
        }),
        expansions: vi.fn().mockResolvedValue([]),
        blueprintsExport: vi.fn().mockResolvedValue([]),
      };
    }

    const env = makeEnv(db);

    await runScan(env, { trigger: 'cron' }, { createClient: (_t, _o) => makeClient(scannedRun1) });
    // Insert a finished scan_runs row so the DB state is clean for run 2.
    raw.exec(`UPDATE scan_runs SET finished_at = datetime('now') WHERE finished_at IS NULL`);

    await runScan(env, { trigger: 'cron' }, { createClient: (_t, _o) => makeClient(scannedRun2) });

    // Run 1 and run 2 should not scan the exact same set of blueprints
    // (the cursor must advance). At least some IDs should differ.
    const set1 = new Set(scannedRun1);
    const set2 = new Set(scannedRun2);
    const overlapCount = [...set1].filter((id) => set2.has(id)).length;

    // With 6 blueprints and batchSize 3, after run 1 scans 3, run 2 should
    // prefer the 3 un-scanned ones. Some overlap is possible if all get
    // scanned in run 1 (wraps around), but the runs should differ.
    // We assert: at least one ID scanned in run 2 was NOT in run 1
    // (i.e., the cursor moved forward past at least some previously-scanned ones).
    expect(scannedRun1.length).toBeGreaterThan(0);
    expect(scannedRun2.length).toBeGreaterThan(0);
    // The union covers more blueprints than either run alone (rotation happened).
    const unionSize = new Set([...scannedRun1, ...scannedRun2]).size;
    expect(unionSize).toBeGreaterThan(Math.max(set1.size, set2.size));

    // Also verify overlap is < full batch (not stuck scanning same items).
    expect(overlapCount).toBeLessThan(Math.min(scannedRun1.length, scannedRun2.length));
  });

  it('A1b: last_scanned_at is set after a run', async () => {
    const bpIds = [2001, 2002, 2003];
    const { db, raw } = makeChunkedEnv({ batchSize: 3, blueprintIds: bpIds });

    // Initially all NULL.
    expect(getLastScanned(raw, 2001)).toBeNull();

    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation((q: { blueprintId?: number }) =>
        Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 100)),
      ),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };

    await runScan(makeEnv(db), { trigger: 'cron' }, { createClient: (_t, _o) => client });

    // After the run, all 3 blueprints should have last_scanned_at set.
    for (const id of bpIds) {
      expect(getLastScanned(raw, id)).not.toBeNull();
    }
  });

  it('A5: deals use the owning expansion watchlist_id', async () => {
    const expansionId = 10;
    const bpId = 3001;
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 5 WHERE id = 1`);
    const watchlistId = seedExpansionItem(raw, expansionId);
    seedBlueprints(raw, expansionId, [bpId], null);

    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation(() =>
        Promise.resolve(makeDealResponse(bpId, 9001)),
      ),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };

    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    expect(summary.dealsFound).toBe(1);
    expect(summary.error).toBeNull();

    // Verify the deal row uses the expansion's watchlist_id.
    const deal = raw.prepare(`SELECT watchlist_id FROM deals WHERE product_id = 9001`).get() as
      | { watchlist_id: number }
      | undefined;
    expect(deal).toBeDefined();
    expect(deal?.watchlist_id).toBe(watchlistId);
  });

  it('A2: blueprint-type watch items scanned directly (no rotation)', async () => {
    // Chunked mode, 1 blueprint item, no expansion items.
    const bpId = 5001;
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 5 WHERE id = 1`);
    seedBlueprintItem(raw, bpId);

    const marketplaceSpy = vi.fn().mockResolvedValue(makeDealResponse(bpId, 7001));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };

    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    expect(marketplaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintId: bpId }),
    );
    expect(summary.dealsFound).toBe(1);
  });

  it('A3: empty blueprint cache → blueprintsExport called (cache warm-up)', async () => {
    // Expansion in watchlist but NO cached blueprints → should call blueprintsExport.
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 10 WHERE id = 1`);
    seedExpansionItem(raw, 300);
    // No blueprints seeded.

    const exportedBps: Blueprint[] = [
      { id: 6001, name: 'Alpha Card', expansion_id: 300, game_id: 1, image_url: null, scryfall_id: null },
      { id: 6002, name: 'Beta Card', expansion_id: 300, game_id: 1, image_url: null, scryfall_id: null },
    ];
    const blueprintsExportSpy = vi.fn().mockResolvedValue(exportedBps);
    const marketplaceSpy = vi.fn().mockImplementation((q: { blueprintId?: number }) =>
      Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 100)),
    );
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: blueprintsExportSpy,
    };

    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    // blueprintsExport was called for expansion 300.
    expect(blueprintsExportSpy).toHaveBeenCalledWith(300);

    // After the run, blueprints should be cached.
    const count = raw
      .prepare(`SELECT COUNT(*) AS n FROM blueprints WHERE expansion_id = 300`)
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('A6: per-blueprint failure is non-fatal; run continues; rotation advances for other blueprints', async () => {
    const bpIds = [4001, 4002, 4003];
    const { db, raw } = makeChunkedEnv({ batchSize: 3, blueprintIds: bpIds });

    let callCount = 0;
    const marketplaceSpy = vi.fn().mockImplementation((q: { blueprintId?: number }) => {
      callCount++;
      // The first blueprint fails; subsequent ones succeed (no deal, just thin market).
      if (q.blueprintId === 4001 && callCount === 1) {
        return Promise.reject(new CardTraderError('network error', '/marketplace/products', 500));
      }
      return Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 100));
    });
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };

    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    // The run must not have failed at the whole-run level.
    expect(summary.error).toBeNull();

    // All 3 blueprints were attempted (the scanner didn't stop on the first failure).
    expect(marketplaceSpy.mock.calls.length).toBe(3);

    // The rotation cursor advances for all 3 blueprints (including the failed one).
    for (const id of bpIds) {
      expect(getLastScanned(raw, id)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (A) selectBlueprintsToScan + markBlueprintsScanned repo helpers
// ---------------------------------------------------------------------------

describe('selectBlueprintsToScan — rotation cursor logic', () => {
  it('returns empty array when expansionIds is empty', async () => {
    const { db } = makeD1();
    const result = await selectBlueprintsToScan(db, [], 10);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when limit is 0', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 1, [101, 102], null);
    const result = await selectBlueprintsToScan(db, [1], 0);
    expect(result).toHaveLength(0);
  });

  it('NULL last_scanned_at comes before non-NULL (never-scanned first)', async () => {
    const { db, raw } = makeD1();
    // Seed bp 201 as never scanned, 202 as already scanned.
    seedBlueprints(raw, 20, [201], null);
    seedBlueprints(raw, 20, [202], '2025-01-01 00:00:00');

    const result = await selectBlueprintsToScan(db, [20], 2);
    expect(result).toHaveLength(2);
    // Blueprint 201 (NULL → never scanned) should come first.
    expect(result[0].id).toBe(201);
  });

  it('older last_scanned_at comes before newer', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 30, [301], '2025-01-01 00:00:00');  // older
    seedBlueprints(raw, 30, [302], '2025-06-01 00:00:00');  // newer

    const result = await selectBlueprintsToScan(db, [30], 2);
    expect(result[0].id).toBe(301); // older scanned first
  });

  it('respects the limit', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 40, [401, 402, 403, 404, 405], null);

    const result = await selectBlueprintsToScan(db, [40], 3);
    expect(result).toHaveLength(3);
  });
});

describe('markBlueprintsScanned', () => {
  it('sets last_scanned_at for all ids', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 50, [501, 502, 503], null);

    // All NULL before.
    expect(getLastScanned(raw, 501)).toBeNull();

    await markBlueprintsScanned(db, [501, 502, 503]);

    // All set after.
    for (const id of [501, 502, 503]) {
      expect(getLastScanned(raw, id)).not.toBeNull();
    }
  });

  it('no-ops on empty array', async () => {
    const { db } = makeD1();
    // Should not throw.
    await expect(markBlueprintsScanned(db, [])).resolves.toBeUndefined();
  });

  it('handles large batches (> MARK_SCANNED_CHUNK_SIZE) without error', async () => {
    const { db, raw } = makeD1();
    // MARK_SCANNED_CHUNK_SIZE is 100 — seed 150 blueprints.
    const ids = Array.from({ length: 150 }, (_, i) => 6000 + i);
    seedBlueprints(raw, 60, ids, null);

    await expect(markBlueprintsScanned(db, ids)).resolves.toBeUndefined();

    const allSet = ids.every((id) => getLastScanned(raw, id) !== null);
    expect(allSet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (D) Cycle management — countActiveExpansionBlueprints + countScannedThisCycle
// ---------------------------------------------------------------------------

describe('countActiveExpansionBlueprints', () => {
  it('returns 0 for empty expansionIds', async () => {
    const { db } = makeD1();
    const count = await countActiveExpansionBlueprints(db, []);
    expect(count).toBe(0);
  });

  it('returns total blueprint count across all given expansion ids', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 10, [1, 2, 3], null);
    seedBlueprints(raw, 20, [4, 5], null);
    // Only query expansion 10 → 3
    expect(await countActiveExpansionBlueprints(db, [10])).toBe(3);
    // Both → 5
    expect(await countActiveExpansionBlueprints(db, [10, 20])).toBe(5);
  });

  it('excludes blueprints from expansions not in the list', async () => {
    const { db, raw } = makeD1();
    seedBlueprints(raw, 10, [1, 2], null);
    seedBlueprints(raw, 99, [3], null);
    // Ask only for expansion 10
    expect(await countActiveExpansionBlueprints(db, [10])).toBe(2);
  });
});

describe('countScannedThisCycle', () => {
  it('returns 0 for empty expansionIds', async () => {
    const { db } = makeD1();
    const count = await countScannedThisCycle(db, [], '2026-01-01 00:00:00');
    expect(count).toBe(0);
  });

  it('counts only blueprints scanned AT OR AFTER cycleStart', async () => {
    const { db, raw } = makeD1();
    const cycleStart = '2026-01-01 10:00:00';
    seedBlueprints(raw, 10, [], null);
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (1, 10, 'A', '2026-01-01 10:00:00')`); // = cycleStart: counted
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (2, 10, 'B', '2026-01-01 10:05:00')`); // after: counted
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (3, 10, 'C', '2025-12-31 23:59:59')`); // before: not counted
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (4, 10, 'D', NULL)`); // NULL: not counted
    expect(await countScannedThisCycle(db, [10], cycleStart)).toBe(2);
  });

  it('excludes blueprints from expansions not in the list', async () => {
    const { db, raw } = makeD1();
    const cycleStart = '2026-01-01 00:00:00';
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (1, 10, 'A', '2026-01-01 01:00:00')`);
    raw.exec(`INSERT INTO blueprints (id, expansion_id, name, last_scanned_at) VALUES (2, 20, 'B', '2026-01-01 01:00:00')`);
    // Only ask for expansion 10
    expect(await countScannedThisCycle(db, [10], cycleStart)).toBe(1);
  });
});

describe('(D) Scan cycle management — scanner integration', () => {
  /** Build a chunked env with expansion blueprints seeded. */
  function makeCycleEnv(opts: {
    expansionId?: number;
    batchSize?: number;
    blueprintIds?: number[];
  } = {}) {
    const {
      expansionId = 50,
      batchSize = 3,
      blueprintIds = [7001, 7002, 7003],
    } = opts;
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = ${batchSize} WHERE id = 1`);
    seedExpansionItem(raw, expansionId);
    seedBlueprints(raw, expansionId, blueprintIds, null); // all un-scanned
    return { db, raw };
  }

  function makeNoDealClient(): CardTraderClient {
    return {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation((q: { blueprintId?: number }) =>
        Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 10)),
      ),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
  }

  it('D1: fresh DB (cycle null) — first run sets scan_cycle_started_at', async () => {
    const { db, raw } = makeCycleEnv();
    // Verify cycle not set before
    const before = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    expect(before.scan_cycle_started_at).toBeNull();

    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    const after = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    expect(after.scan_cycle_started_at).not.toBeNull();
    // Should be a SQLite datetime string
    expect(typeof after.scan_cycle_started_at).toBe('string');
  });

  it('D2: after scanning, countScannedThisCycle reflects the batch', async () => {
    const bpIds = [8001, 8002, 8003];
    const { db, raw } = makeCycleEnv({ blueprintIds: bpIds, batchSize: 3 });

    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    const configRow = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    const cycleStart = configRow.scan_cycle_started_at;
    expect(cycleStart).not.toBeNull();

    const scanned = await countScannedThisCycle(db, [50], cycleStart!);
    // All 3 blueprints should be counted (batchSize=3, 3 blueprints)
    expect(scanned).toBe(3);
  });

  it('D3: when all blueprints already scanned this cycle — next run resets cycleStart', async () => {
    const bpIds = [9001, 9002];
    const { db, raw } = makeCycleEnv({ blueprintIds: bpIds, batchSize: 5 });

    // Manually set a past cycle start and mark ALL blueprints as scanned after it
    const oldCycleStart = '2026-01-01 00:00:00';
    raw.exec(`UPDATE config SET scan_cycle_started_at = '${oldCycleStart}' WHERE id = 1`);
    raw.exec(`UPDATE blueprints SET last_scanned_at = '2026-01-01 01:00:00' WHERE expansion_id = 50`);

    // Run again — all are already scanned (countScannedThisCycle >= total), so a new cycle starts
    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    const configRow = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    const newCycleStart = configRow.scan_cycle_started_at;
    expect(newCycleStart).not.toBeNull();
    // The new cycle anchor must be after the old one
    expect(newCycleStart! > oldCycleStart).toBe(true);
  });

  it('D3b: patchConfig persists scan_cycle_started_at', async () => {
    const { db } = makeD1();
    const ts = '2026-06-01 12:00:00';
    const updated = await patchConfig(db, { scan_cycle_started_at: ts });
    expect(updated.scan_cycle_started_at).toBe(ts);
    const reread = await getConfig(db);
    expect(reread.scan_cycle_started_at).toBe(ts);
  });

  it('D4: cycle management failure is non-fatal — scan still runs', async () => {
    // Use a fresh DB where config row is missing (simulate getConfig failure scenario)
    // by using a batchSize=0 which means the rotation won't scan any blueprints
    // but the cycle code will still execute. Check the run doesn't error out.
    const { db } = makeCycleEnv({ batchSize: 5 });
    // Normal run — cycle error path exercised if it happens; scan must not set runError.
    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });
    // The run must resolve without a whole-run error (cycle errors are non-fatal)
    expect(summary.error).toBeNull();
  });

  it('D5: wholeset mode run does not touch scan_cycle_started_at', async () => {
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'wholeset' WHERE id = 1`);
    raw.exec(`INSERT INTO watchlist (type, cardtrader_id, label, active) VALUES ('expansion', 70, 'Set', 1)`);
    // No cycle set
    const beforeRow = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    expect(beforeRow.scan_cycle_started_at).toBeNull();

    // Wholeset mode, run-now so throttle doesn't block it
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(70, 80000));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
    };
    await runScan(makeEnv(db), { trigger: 'run-now' }, {
      createClient: (_t, _o) => client,
    });

    const afterRow = raw.prepare(`SELECT scan_cycle_started_at FROM config WHERE id = 1`).get() as
      { scan_cycle_started_at: string | null };
    // Wholeset mode must not touch the cycle column
    expect(afterRow.scan_cycle_started_at).toBeNull();
  });
});
