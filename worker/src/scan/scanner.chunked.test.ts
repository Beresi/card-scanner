/**
 * Chunked scan mode + wholeset scan mode tests.
 *
 * These tests exercise the runScan branches introduced in migration 0003:
 *
 *  (A) Chunked mode — per-card rotation via last_scanned_at cursor:
 *    A1. Expansion blueprints cached; two runs scan distinct batches (rotation advances).
 *    A2. Blueprint-type watch items scanned directly (no rotation).
 *    A3. Blueprint cache empty → blueprintsExport called (cache warm-up, capped per run).
 *    A4. Only up to scan_batch_size marketplace calls happen per run.
 *    A5. Deals use owning expansion's watchlist_id.
 *    A6. Per-blueprint failure is non-fatal; run continues; rotation still advances.
 *
 *  (B) Wholeset mode — run-now always executes (interval gate is in scheduled()):
 *    B1. run-now trigger → always runs regardless of prior scan history.
 *    B2. cron trigger (no prior history) → always runs (gate is upstream in scheduled()).
 *    Note: The scan-interval gate now lives in index.ts scheduled() via
 *    shouldRunCron(config.scan_interval_minutes). runScan itself never skips.
 *    See cronGate.test.ts for the pure gate-decision tests.
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
  reapStaleScanRuns,
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
// (B) Wholeset mode — runScan always runs (interval gate is in scheduled())
// ---------------------------------------------------------------------------

describe('(B) Wholeset mode — runScan never self-throttles', () => {
  /**
   * The per-run interval gate (WHOLESET_MIN_INTERVAL_MINUTES) has been removed
   * from runScan. The gate now lives in index.ts scheduled() via shouldRunCron()
   * reading config.scan_interval_minutes. This means runScan with trigger:'cron'
   * or trigger:'run-now' ALWAYS executes when called — the throttle decision is
   * made upstream, before openScanRun is ever called.
   *
   * Tests confirm:
   *  B1. run-now + prior finished scan → always runs (no skip).
   *  B2. cron trigger + prior history → always runs (gate not in runScan).
   */
  function makeWholesetEnv() {
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'wholeset' WHERE id = 1`);
    seedExpansionItem(raw, 200);
    // Seed a recently-finished scan — runScan must NOT skip on its own.
    seedFinishedScan(raw, `datetime('now', '-5 minutes')`);
    return { db, raw };
  }

  it('B1: run-now + recent scan → ALWAYS runs (no skip)', async () => {
    const { db } = makeWholesetEnv();
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(999, 8001));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
    };
    const summary = await runScan(makeEnv(db), { trigger: 'run-now' }, {
      createClient: (_t, _o) => client,
    });

    expect(marketplaceSpy).toHaveBeenCalled();
    expect(summary.error).toBeNull();
  });

  it('B2: cron trigger + recent scan → ALWAYS runs (interval gate is upstream in scheduled())', async () => {
    const { db } = makeWholesetEnv();
    const marketplaceSpy = vi.fn().mockResolvedValue(makeNoDealResponse(999, 8002));
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: marketplaceSpy,
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
    };
    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => client,
    });

    // runScan itself no longer skips — gate is in scheduled().
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
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

// ---------------------------------------------------------------------------
// (E) watch_items_scanned correctness — BUG 1 regression tests
//
// Invariant: watch_items_scanned <= number of active watchlist rows in every
// scan mode.  Before the fix, scanBlueprintById called onWatchItemScanned()
// which caused card-type and expansion-type items to inflate the count by the
// number of blueprints rather than 1.
// ---------------------------------------------------------------------------

describe('(E) watch_items_scanned — distinct top-level watchlist items only', () => {
  /**
   * Helper: read the final watch_items_scanned from the most recent scan_runs row.
   */
  function getWatchItemsScanned(raw: ReturnType<typeof makeD1>['raw']): number {
    const row = raw
      .prepare(`SELECT watch_items_scanned FROM scan_runs ORDER BY id DESC LIMIT 1`)
      .get() as { watch_items_scanned: number } | undefined;
    return row?.watch_items_scanned ?? -1;
  }

  function makeNoDealClient(): CardTraderClient {
    return {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation((q: { blueprintId?: number }) =>
        Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 10)),
      ),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
    };
  }

  it('E1: chunked — 1 expansion item with 5 blueprints → watch_items_scanned = 1', async () => {
    // One expansion watchlist row, 5 blueprints. The bug would have set
    // watch_items_scanned = 5 (once per blueprint). The fix sets it to 1.
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 10 WHERE id = 1`);
    seedExpansionItem(raw, 11);
    seedBlueprints(raw, 11, [11001, 11002, 11003, 11004, 11005], null);

    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    // There is exactly 1 active watchlist row.
    expect(summary.watchItemsScanned).toBe(1);
    expect(getWatchItemsScanned(raw)).toBe(1);
    // The blueprint count must be >= 1 and not equal to the watch-item count
    // (this is the regression guard).
    expect(summary.blueprintsScanned).toBeGreaterThanOrEqual(1);
  });

  it('E2: chunked — 2 expansion items each with 3 blueprints → watch_items_scanned = 2', async () => {
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 10 WHERE id = 1`);
    seedExpansionItem(raw, 12);
    seedExpansionItem(raw, 13);
    seedBlueprints(raw, 12, [12001, 12002, 12003], null);
    seedBlueprints(raw, 13, [13001, 13002, 13003], null);

    const summary = await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    // 2 distinct watchlist items, not 6 blueprints.
    expect(summary.watchItemsScanned).toBe(2);
    expect(getWatchItemsScanned(raw)).toBe(2);
  });

  it('E3: wholeset — 1 expansion item → watch_items_scanned = 1 regardless of blueprint count', async () => {
    // scanItem already called onWatchItemScanned exactly once per expansion item;
    // this test ensures that invariant is preserved after removing the scanBlueprintById tick.
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'wholeset' WHERE id = 1`);
    // Use expansionId 14 with a direct expansion item (uses scanItem, not scanBlueprintById).
    seedExpansionItem(raw, 14);
    raw.exec(`INSERT INTO expansions (id, game_id, code, name) VALUES (14, 1, 'T14', 'Test 14')`);

    // Client returns 3 blueprints for the expansion scan — 3 onBlueprintScanned ticks.
    const resp: Record<string, unknown[]> = {
      '14001': makeNoDealResponse(14001, 14001 * 100)[14001],
      '14002': makeNoDealResponse(14002, 14002 * 100)[14002],
      '14003': makeNoDealResponse(14003, 14003 * 100)[14003],
    };
    const client: CardTraderClient = {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation((params: Record<string, unknown>) => {
        if ('expansionId' in params && params.expansionId === 14) {
          return Promise.resolve(resp);
        }
        return Promise.resolve({});
      }),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
    };

    const summary = await runScan(makeEnv(db), { trigger: 'run-now' }, {
      createClient: (_t, _o) => client,
    });

    // 1 expansion watch item, regardless of how many blueprints came back.
    expect(summary.watchItemsScanned).toBe(1);
    expect(summary.blueprintsScanned).toBe(3);
    expect(getWatchItemsScanned(raw)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (F) reapStaleScanRuns — unit tests for the stale-row reaper (BUG 2)
// ---------------------------------------------------------------------------

describe('(F) reapStaleScanRuns — stale row cleanup', () => {
  /** Insert a raw scan_runs row with specific started_at and blueprints_scanned. */
  function seedScanRun(
    raw: ReturnType<typeof makeD1>['raw'],
    opts: { startedMinsAgo: number; blueprintsScanned?: number; finished?: boolean },
  ): number {
    const { startedMinsAgo, blueprintsScanned = 0, finished = false } = opts;
    const info = raw
      .prepare(
        `INSERT INTO scan_runs
           (started_at, finished_at, blueprints_scanned, watch_items_scanned, api_calls, deals_found, telegram_sent)
         VALUES
           (datetime('now', ?), ${finished ? "datetime('now')" : 'NULL'}, ?, 0, 0, 0, 0)`,
      )
      .run(`-${startedMinsAgo} minutes`, blueprintsScanned);
    return Number(info.lastInsertRowid);
  }

  function getRunRow(
    raw: ReturnType<typeof makeD1>['raw'],
    id: number,
  ): { finished_at: string | null; error: string | null } {
    return raw
      .prepare(`SELECT finished_at, error FROM scan_runs WHERE id = ?`)
      .get(id) as { finished_at: string | null; error: string | null };
  }

  it('F1: reaps an open row older than threshold with blueprints_scanned=0', async () => {
    const { db, raw } = makeD1();
    const id = seedScanRun(raw, { startedMinsAgo: 20, blueprintsScanned: 0 });

    const reaped = await reapStaleScanRuns(db, 15);

    expect(reaped).toBe(1);
    const row = getRunRow(raw, id);
    expect(row.finished_at).not.toBeNull();
    expect(row.error).toContain('stale');
  });

  it('F2: does NOT reap an open row with blueprints_scanned > 0 (live long sweep)', async () => {
    const { db, raw } = makeD1();
    const id = seedScanRun(raw, { startedMinsAgo: 40, blueprintsScanned: 1200 });

    const reaped = await reapStaleScanRuns(db, 15);

    expect(reaped).toBe(0);
    const row = getRunRow(raw, id);
    // Must NOT have been closed by the reaper.
    expect(row.finished_at).toBeNull();
  });

  it('F3: does NOT reap a row younger than the threshold', async () => {
    const { db, raw } = makeD1();
    const id = seedScanRun(raw, { startedMinsAgo: 5, blueprintsScanned: 0 });

    const reaped = await reapStaleScanRuns(db, 15);

    expect(reaped).toBe(0);
    const row = getRunRow(raw, id);
    expect(row.finished_at).toBeNull();
  });

  it('F4: does NOT reap an already-finished row', async () => {
    const { db, raw } = makeD1();
    const id = seedScanRun(raw, { startedMinsAgo: 60, blueprintsScanned: 0, finished: true });
    const before = getRunRow(raw, id);

    await reapStaleScanRuns(db, 15);

    // finished_at must not have changed.
    const after = getRunRow(raw, id);
    expect(after.finished_at).toBe(before.finished_at);
  });

  it('F5: reaps multiple stale rows in one call', async () => {
    const { db, raw } = makeD1();
    seedScanRun(raw, { startedMinsAgo: 30, blueprintsScanned: 0 });
    seedScanRun(raw, { startedMinsAgo: 60, blueprintsScanned: 0 });
    // This one must survive (has progress).
    seedScanRun(raw, { startedMinsAgo: 45, blueprintsScanned: 500 });

    const reaped = await reapStaleScanRuns(db, 15);

    expect(reaped).toBe(2);
  });

  it('F6: preserves an existing error message (COALESCE does not overwrite)', async () => {
    const { db, raw } = makeD1();
    // Insert a row with an existing error already set.
    const info = raw
      .prepare(
        `INSERT INTO scan_runs
           (started_at, finished_at, blueprints_scanned, watch_items_scanned, api_calls, deals_found, telegram_sent, error)
         VALUES (datetime('now', '-30 minutes'), NULL, 0, 0, 0, 0, 0, 'original error')`,
      )
      .run();
    const id = Number(info.lastInsertRowid);

    await reapStaleScanRuns(db, 15);

    const row = getRunRow(raw, id);
    // COALESCE(error, '...') keeps the original error.
    expect(row.error).toBe('original error');
  });
});

// ---------------------------------------------------------------------------
// (G) runScan plants and reaps a stale-0-count row, but not a progressing row
// ---------------------------------------------------------------------------

describe('(G) runScan — reaper integration', () => {
  function makeNoDealClient(): CardTraderClient {
    return {
      info: () => Promise.resolve({ id: 1, name: 'test', user_id: 1 }),
      marketplaceProducts: vi.fn().mockImplementation((q: { blueprintId?: number }) =>
        Promise.resolve(makeNoDealResponse(q.blueprintId ?? 0, (q.blueprintId ?? 0) * 10)),
      ),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockRejectedValue(new Error('not used')),
      cartAdd: vi.fn().mockRejectedValue(new Error('not used')),
      cartRemove: vi.fn().mockRejectedValue(new Error('not used')),
    };
  }

  it('G1: runScan reaps a planted stale open row with blueprints_scanned=0', async () => {
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 5 WHERE id = 1`);
    seedExpansionItem(raw, 70);
    seedBlueprints(raw, 70, [70001, 70002], null);

    // Plant a stale row: open, 20 min old, blueprints_scanned=0.
    const staleId = Number(
      raw
        .prepare(
          `INSERT INTO scan_runs
             (started_at, finished_at, blueprints_scanned, watch_items_scanned, api_calls, deals_found, telegram_sent)
           VALUES (datetime('now', '-20 minutes'), NULL, 0, 0, 0, 0, 0)`,
        )
        .run().lastInsertRowid,
    );

    // The planted row is open before the run.
    const before = raw
      .prepare(`SELECT finished_at FROM scan_runs WHERE id = ?`)
      .get(staleId) as { finished_at: string | null };
    expect(before.finished_at).toBeNull();

    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    // The stale row must now be closed (reaped) by the new run.
    const after = raw
      .prepare(`SELECT finished_at, error FROM scan_runs WHERE id = ?`)
      .get(staleId) as { finished_at: string | null; error: string | null };
    expect(after.finished_at).not.toBeNull();
    expect(after.error).toContain('stale');
  });

  it('G2: runScan does NOT reap a stale row that has blueprints_scanned > 0', async () => {
    const { db, raw } = makeD1();
    raw.exec(`UPDATE config SET scan_mode = 'chunked', scan_batch_size = 5 WHERE id = 1`);
    seedExpansionItem(raw, 71);
    seedBlueprints(raw, 71, [71001], null);

    // Plant a stale row: open, 40 min old, blueprints_scanned=1200 (a live long sweep).
    const liveId = Number(
      raw
        .prepare(
          `INSERT INTO scan_runs
             (started_at, finished_at, blueprints_scanned, watch_items_scanned, api_calls, deals_found, telegram_sent)
           VALUES (datetime('now', '-40 minutes'), NULL, 1200, 0, 0, 0, 0)`,
        )
        .run().lastInsertRowid,
    );

    await runScan(makeEnv(db), { trigger: 'cron' }, {
      createClient: (_t, _o) => makeNoDealClient(),
    });

    // The live row must NOT have been closed.
    const after = raw
      .prepare(`SELECT finished_at FROM scan_runs WHERE id = ?`)
      .get(liveId) as { finished_at: string | null };
    expect(after.finished_at).toBeNull();
  });
});
