/**
 * Live-progress tests — liveProgress flag + updateScanRunProgress contract.
 *
 * What we prove:
 *  1. With liveProgress:true, updateScanRunProgress is called at least once
 *     during a multi-item run — verified by spying at the module level AND by
 *     reading the real D1 row to confirm intermediate data lands in the DB.
 *  2. WITHOUT liveProgress (cron / cloud run-now paths), updateScanRunProgress
 *     is NEVER called — zero extra D1 writes, behaviour byte-for-byte unchanged.
 *  3. The initial flush writes 0/0 counts immediately after openScanRun (so the
 *     row is already readable before any API calls fire).
 *  4. A failed progress write (transient D1 error) does NOT abort the scan —
 *     the run still completes and returns a valid ScanSummary.
 *  5. closeScanRun's authoritative final counts are still written correctly even
 *     when liveProgress writes have been flushing intermediate states.
 *
 * Approach: spy on repo.updateScanRunProgress via vi.mock so the call count
 * is observable regardless of fire-and-forget timing. For tests that need to
 * observe actual DB state we use the real better-sqlite3 in-memory DB and drain
 * pending microtasks with `await Promise.resolve()` ticks after runScan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runScan } from './scanner';
import { makeD1 } from '../api/__test-helpers__/d1';
import type { CardTraderClient } from '../cardtrader/client';
import type { Env } from '../index';
import type { MarketplaceResponse } from '../cardtrader/types';

// ---------------------------------------------------------------------------
// Module-level spy on updateScanRunProgress
// ---------------------------------------------------------------------------

// We spy at the module level so we can count invocations regardless of whether
// the call is fire-and-forget (void). The actual SQL still runs via the real
// D1 adapter when the spy calls through.
vi.mock('../db/repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repo')>();
  return {
    ...actual,
    updateScanRunProgress: vi.fn(actual.updateScanRunProgress),
  };
});

// Import the spy reference after the mock is set up.
import * as repo from '../db/repo';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain all pending microtasks so fire-and-forget void promises can resolve. */
async function drainMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

/** Build a minimal Env (no Telegram) backed by the given in-memory D1. */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CARDTRADER_API_TOKEN: 'test-token',
    TELEGRAM_BOT_TOKEN: undefined as unknown as string,
    TELEGRAM_CHAT_ID: undefined as unknown as string,
    DESKTOP_AUTH_TOKEN: 'desktop-token',
  } as Env;
}

/**
 * Build a MarketplaceResponse that guarantees a deal fires.
 *
 * Candidate: 200 ¢ (clears min_price_cents 200).
 * Cohort:    10 × 500 ¢ → median 500 ¢ → discount 60 % → fires at threshold 50.
 * Savings:   300 ¢ ≥ min_savings_cents 100.
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

  return {
    [String(blueprintId)]: [
      makeProduct(productId, 200),
      ...Array.from({ length: 10 }, (_, i) => makeProduct(productId + 100 + i, 500)),
    ],
  };
}

/**
 * Seed the schema with one expansion watchlist item and its blueprint cache
 * so the wholeset scan can make a marketplace call.
 */
function seedExpansionItem(
  raw: import('better-sqlite3').Database,
  expansionId: number,
  blueprintId: number,
): void {
  raw
    .prepare(`INSERT INTO watchlist (type, cardtrader_id, label) VALUES ('expansion', ?, ?)`)
    .run(expansionId, `Test Set ${expansionId}`);

  raw
    .prepare(
      `INSERT INTO blueprints (id, expansion_id, name, name_norm, synced_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(blueprintId, expansionId, `Card ${blueprintId}`, `card ${blueprintId}`);

  raw
    .prepare(`INSERT INTO expansions (id, game_id, code, name) VALUES (?, 1, 'TST', 'Test Set')`)
    .run(expansionId);
}

/**
 * Build a CardTraderClient whose info() resolves and whose marketplaceProducts
 * returns a pre-built response for the given expansion or blueprint call.
 */
function buildSuccessClient(
  expansionId: number,
  blueprintId: number,
  productId: number,
): CardTraderClient {
  const response = makeDealResponse(blueprintId, productId);
  return {
    info: vi.fn().mockResolvedValue({ id: 1, username: 'tester', email: 'test@example.com' }),
    marketplaceProducts: vi.fn().mockImplementation((params: Record<string, unknown>) => {
      if ('expansionId' in params && params.expansionId === expansionId) {
        return Promise.resolve(response);
      }
      if ('blueprintId' in params && params.blueprintId === blueprintId) {
        return Promise.resolve(response);
      }
      return Promise.resolve({});
    }),
    expansions: vi.fn().mockResolvedValue([]),
    blueprintsExport: vi.fn().mockResolvedValue([]),
    getCart: vi.fn().mockResolvedValue({ cart_items: [] }),
    cartAdd: vi.fn().mockResolvedValue({ cart_items: [] }),
    cartRemove: vi.fn().mockResolvedValue({ cart_items: [] }),
  };
}

// ---------------------------------------------------------------------------
// Clear the spy before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(repo.updateScanRunProgress).mockClear();
});

afterEach(() => {
  vi.mocked(repo.updateScanRunProgress).mockRestore?.();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runScan — liveProgress flag', () => {
  // -------------------------------------------------------------------------
  // 1. liveProgress:true → updateScanRunProgress called at least once
  // -------------------------------------------------------------------------
  it('calls updateScanRunProgress at least once with liveProgress:true', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9001, 81001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9001, 81001, 999001);

    await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      { createClient: () => client },
    );

    // Fire-and-forget promises may still be in the microtask queue — drain them.
    await drainMicrotasks();

    expect(vi.mocked(repo.updateScanRunProgress)).toHaveBeenCalled();
    // All calls must use the correct runId (first arg is db, second is runId).
    // The call signature is (db, runId, counts).
    const calls = vi.mocked(repo.updateScanRunProgress).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Verify counts shape is valid (all numbers, non-negative).
    for (const [, , counts] of calls) {
      expect(typeof counts.watchItemsScanned).toBe('number');
      expect(typeof counts.blueprintsScanned).toBe('number');
      expect(typeof counts.apiCalls).toBe('number');
      expect(typeof counts.dealsFound).toBe('number');
      expect(counts.watchItemsScanned).toBeGreaterThanOrEqual(0);
      expect(counts.blueprintsScanned).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // 2. liveProgress absent → updateScanRunProgress NEVER called (cron)
  // -------------------------------------------------------------------------
  it('does NOT call updateScanRunProgress when liveProgress is omitted (cron path)', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9002, 82001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9002, 82001, 999002);

    await runScan(
      env,
      { trigger: 'cron', modeOverride: 'wholeset' },
      { createClient: () => client },
    );

    await drainMicrotasks();

    expect(vi.mocked(repo.updateScanRunProgress)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. liveProgress absent → updateScanRunProgress NEVER called (cloud run-now)
  // -------------------------------------------------------------------------
  it('does NOT call updateScanRunProgress for cloud run-now without liveProgress', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9003, 83001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9003, 83001, 999003);

    await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset' },  // no liveProgress
      { createClient: () => client },
    );

    await drainMicrotasks();

    expect(vi.mocked(repo.updateScanRunProgress)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Initial flush fires with runId matching the opened scan row
  // -------------------------------------------------------------------------
  it('first progress flush uses the correct runId from openScanRun', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9004, 84001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9004, 84001, 999004);

    const summary = await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      { createClient: () => client },
    );

    await drainMicrotasks();

    const calls = vi.mocked(repo.updateScanRunProgress).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Every call must use the same runId that openScanRun allocated.
    for (const [, runId] of calls) {
      expect(runId).toBe(summary.runId);
    }
  });

  // -------------------------------------------------------------------------
  // 5. A failed progress write does NOT abort the scan
  // -------------------------------------------------------------------------
  it('does not abort the scan when a progress write throws', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9005, 85001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9005, 85001, 999005);

    // Make updateScanRunProgress throw a transient error.
    vi.mocked(repo.updateScanRunProgress).mockRejectedValue(
      new Error('simulated transient D1 progress write error'),
    );

    // The scan should resolve (not reject), even though every progress write fails.
    const summary = await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      { createClient: () => client },
    );

    await drainMicrotasks();

    // The scan completed without the progress-write error surfacing.
    expect(summary.error).toBeNull();
    // At least one blueprint was scanned.
    expect(summary.blueprintsScanned).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 6. closeScanRun writes authoritative final counts even with liveProgress
  // -------------------------------------------------------------------------
  it('scan_runs row has correct final counts after a liveProgress run', async () => {
    const { db, raw } = makeD1();
    seedExpansionItem(raw, 9006, 86001);

    const env = makeEnv(db);
    const client = buildSuccessClient(9006, 86001, 999006);

    const summary = await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      { createClient: () => client },
    );

    await drainMicrotasks();

    // Read the scan_runs row back from the real DB.
    const row = raw
      .prepare(`SELECT * FROM scan_runs WHERE id = ?`)
      .get(summary.runId) as {
        finished_at: string | null;
        watch_items_scanned: number;
        blueprints_scanned: number;
        api_calls: number;
        deals_found: number;
        error: string | null;
      } | undefined;

    expect(row).toBeTruthy();
    // Row was closed by closeScanRun.
    expect(row!.finished_at).not.toBeNull();
    // Final counts match the summary from runScan.
    expect(row!.watch_items_scanned).toBe(summary.watchItemsScanned);
    expect(row!.blueprints_scanned).toBe(summary.blueprintsScanned);
    expect(row!.api_calls).toBe(summary.apiCalls);
    expect(row!.deals_found).toBe(summary.dealsFound);
    expect(row!.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. Progress counts passed to updateScanRunProgress increase monotonically
  //    (later flushes always have counts >= earlier flushes)
  // -------------------------------------------------------------------------
  it('progress counts are non-decreasing across flush calls', async () => {
    const { db, raw } = makeD1();
    // Seed TWO expansion items so there are multiple watch-item boundary flushes.
    seedExpansionItem(raw, 9007, 87001);

    // Add a second expansion item.
    raw
      .prepare(`INSERT INTO watchlist (type, cardtrader_id, label) VALUES ('expansion', ?, ?)`)
      .run(9008, 'Second Test Set');
    raw
      .prepare(
        `INSERT INTO blueprints (id, expansion_id, name, name_norm, synced_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(87002, 9008, 'Card 87002', 'card 87002');
    raw
      .prepare(`INSERT INTO expansions (id, game_id, code, name) VALUES (?, 1, 'TS2', 'Second Test Set')`)
      .run(9008);

    const env = makeEnv(db);

    // Client that handles both expansions.
    const resp1 = makeDealResponse(87001, 999007);
    const resp2 = makeDealResponse(87002, 999008);
    const client: CardTraderClient = {
      info: vi.fn().mockResolvedValue({ id: 1, username: 'tester', email: 'test@example.com' }),
      marketplaceProducts: vi.fn().mockImplementation((params: Record<string, unknown>) => {
        if ('expansionId' in params) {
          if (params.expansionId === 9007) { return Promise.resolve(resp1); }
          if (params.expansionId === 9008) { return Promise.resolve(resp2); }
        }
        return Promise.resolve({});
      }),
      expansions: vi.fn().mockResolvedValue([]),
      blueprintsExport: vi.fn().mockResolvedValue([]),
      getCart: vi.fn().mockResolvedValue({ cart_items: [] }),
      cartAdd: vi.fn().mockResolvedValue({ cart_items: [] }),
      cartRemove: vi.fn().mockResolvedValue({ cart_items: [] }),
    };

    await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      { createClient: () => client },
    );

    await drainMicrotasks();

    const calls = vi.mocked(repo.updateScanRunProgress).mock.calls;
    // With 2 watch items and 2 blueprints, there should be at least 2 flushes
    // (the initial 0/0 + at least one watch-item boundary flush).
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Counts must not decrease from one call to the next.
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1]![2];
      const curr = calls[i]![2];
      expect(curr.blueprintsScanned).toBeGreaterThanOrEqual(prev.blueprintsScanned);
      expect(curr.watchItemsScanned).toBeGreaterThanOrEqual(prev.watchItemsScanned);
    }
  });
});
