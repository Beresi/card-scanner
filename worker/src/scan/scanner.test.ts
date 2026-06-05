/**
 * §16 case 10 — forced API 401 → scan_runs.error set, run aborts cleanly.
 *
 * This test exercises runScan via dependency injection. It never hits the
 * network or a real D1 instance — everything is driven by minimal in-memory
 * fakes.
 *
 * What we prove:
 *  1. runScan RESOLVES (does not reject) even when CardTrader returns 401.
 *  2. summary.error is non-null and references the 401 status.
 *  3. closeScanRun was called — the scan_runs row is always closed.
 *  4. The error value persisted via closeScanRun is non-null (scan_runs.error set).
 *  5. marketplaceProducts was NEVER called — the run aborted before the watchlist
 *     loop (clean abort, not a partial run).
 *
 * PRD §11 step 2: "if 401 → record error, abort, alert once."
 * PRD §16 case 10: "forced API 401 → scan_runs.error set, run aborts cleanly."
 */

import { describe, it, expect, vi } from 'vitest';
import { runScan } from './scanner';
import { CardTraderError } from '../cardtrader/types';
import type { CardTraderClient } from '../cardtrader/client';
import type { Env } from '../index';

// ---------------------------------------------------------------------------
// Helpers — build a minimal D1 statement chain
//
// D1Database in the Worker runtime is called as:
//   db.prepare(sql).bind(...args).run()       ← for INSERT/UPDATE (returns D1Result)
//   db.prepare(sql).run()                     ← for INSERT with no bind args
//   db.prepare(sql).first<T>()                ← for SELECT ... WHERE id = 1
//   db.prepare(sql).all<T>()                  ← for SELECT ... all rows
//
// We only need to support the calls that runScan makes BEFORE the abort:
//   openScanRun  → db.prepare(...).run()         (INSERT scan_runs)
//   closeScanRun → db.prepare(...).bind(...).run() (UPDATE scan_runs)
//
// getConfig and listActiveWatchlist MUST NOT be reached; their stubs throw.
// ---------------------------------------------------------------------------

/**
 * Captured state from the mock DB, inspected by assertions after runScan.
 *
 * `closeBindArgs` holds the positional .bind() arguments from the UPDATE
 * statement executed by closeScanRun. The argument order matches repo.ts:
 *   [0] watch_items_scanned
 *   [1] blueprints_scanned
 *   [2] api_calls
 *   [3] deals_found
 *   [4] telegram_sent
 *   [5] error          ← the field we assert on
 *   [6] id (run id)
 */
interface MockDbState {
  /** How many times closeScanRun's UPDATE .run() was called. */
  closeCallCount: number;
  /** The positional args passed to .bind() in the closeScanRun UPDATE. */
  closeBindArgs: unknown[];
}

function buildMockDb(): { db: D1Database; state: MockDbState } {
  const state: MockDbState = {
    closeCallCount: 0,
    closeBindArgs: [],
  };

  // Each call to .prepare() returns a statement stub whose behaviour depends
  // on the SQL string. We key on substring matches — robust enough for tests.
  const db = {
    prepare(sql: string) {
      const sqlUpper = sql.trim().toUpperCase();

      if (sqlUpper.startsWith('INSERT INTO SCAN_RUNS')) {
        // openScanRun: INSERT → return a run() result with last_row_id = 1.
        return {
          run() {
            return Promise.resolve({
              meta: { last_row_id: 1, changes: 1 },
              results: [],
              success: true,
            } as unknown as D1Result);
          },
        };
      }

      if (sqlUpper.startsWith('UPDATE SCAN_RUNS')) {
        // Two UPDATE SCAN_RUNS calls are now possible:
        //  1. reapStaleScanRuns  — contains 'BLUEPRINTS_SCANNED = 0'; binds one arg (interval)
        //  2. closeScanRun       — binds 7 args (counts + error + id); we capture this one
        const isReaper = sqlUpper.includes('BLUEPRINTS_SCANNED = 0');
        return {
          bind(...args: unknown[]) {
            return {
              run() {
                if (!isReaper) {
                  // Only count and capture the authoritative closeScanRun call.
                  state.closeCallCount++;
                  state.closeBindArgs = args;
                }
                return Promise.resolve({
                  meta: { changes: isReaper ? 0 : 1 },
                  results: [],
                  success: true,
                } as unknown as D1Result);
              },
            };
          },
        };
      }

      // getConfig / listActiveWatchlist — MUST NOT be reached on a 401 abort.
      // Throwing here proves the clean-abort contract: if the scan body executed
      // past the /info validation, the test would fail here.
      if (sqlUpper.includes('FROM CONFIG') || sqlUpper.includes('FROM WATCHLIST')) {
        return {
          first() {
            throw new Error(
              'mock DB: getConfig/listActiveWatchlist must not be called on a 401 abort',
            );
          },
          all() {
            throw new Error(
              'mock DB: getConfig/listActiveWatchlist must not be called on a 401 abort',
            );
          },
        };
      }

      // Fallback: any other SQL is unexpected in this test — fail loudly.
      throw new Error(`mock DB: unexpected SQL: ${sql.slice(0, 80)}`);
    },
  } as unknown as D1Database;

  return { db, state };
}

// ---------------------------------------------------------------------------
// Build a CardTraderClient whose info() rejects with a 401 CardTraderError
// and whose marketplaceProducts is a spy that MUST NOT be called.
// ---------------------------------------------------------------------------

function buildUnauthorisedClient(): CardTraderClient {
  return {
    info() {
      return Promise.reject(
        new CardTraderError('invalid or expired token', '/info', 401),
      );
    },
    // vi.fn() makes it easy to assert call count == 0 after the run.
    marketplaceProducts: vi.fn().mockRejectedValue(
      new Error('marketplaceProducts must not be called on a 401 abort'),
    ),
    expansions: vi.fn().mockRejectedValue(
      new Error('expansions must not be called on a 401 abort'),
    ),
    blueprintsExport: vi.fn().mockRejectedValue(
      new Error('blueprintsExport must not be called on a 401 abort'),
    ),
    getCart: vi.fn().mockRejectedValue(
      new Error('getCart must not be called on a 401 abort'),
    ),
    cartAdd: vi.fn().mockRejectedValue(
      new Error('cartAdd must not be called on a 401 abort'),
    ),
    cartRemove: vi.fn().mockRejectedValue(
      new Error('cartRemove must not be called on a 401 abort'),
    ),
  };
}

// ---------------------------------------------------------------------------
// §16 case 10 — acceptance test
// ---------------------------------------------------------------------------

describe('runScan — §16 case 10: forced API 401', () => {
  it('aborts the run and records error on 401', async () => {
    const { db, state } = buildMockDb();

    // Build a fixed unauthorized client and expose marketplaceProducts as a spy.
    const unauthorisedClient = buildUnauthorisedClient();
    const marketplaceSpy = unauthorisedClient.marketplaceProducts as ReturnType<typeof vi.fn>;

    // Minimal Env — secrets present but not validated by the scan code itself.
    const env = {
      DB: db,
      CARDTRADER_API_TOKEN: 'test-token-x',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHAT_ID: 'test-chat-id',
      DESKTOP_AUTH_TOKEN: 'test-desktop-token',
    } as Env;

    // Inject the unauthorised client via ScanDeps.createClient.
    // The factory receives (token, opts) but we ignore them and return our stub.
    const deps = {
      createClient: (_token: string, _opts: unknown) => unauthorisedClient,
    };

    // Assertion 1: runScan RESOLVES — never rejects on a scan-level failure.
    const summary = await runScan(env, { trigger: 'run-now' }, deps);

    // Assertion 2: summary.error is non-null and references the 401.
    expect(summary.error).not.toBeNull();
    expect(summary.error).toContain('401');

    // Assertion 3: closeScanRun was invoked — the run_row is always closed.
    expect(state.closeCallCount).toBe(1);

    // Assertion 4: the error persisted via closeScanRun is non-null.
    // closeBindArgs[5] is the `error` column (see MockDbState comment above).
    const persistedError = state.closeBindArgs[5];
    expect(persistedError).not.toBeNull();
    expect(typeof persistedError).toBe('string');
    expect(persistedError as string).toContain('401');

    // Assertion 5: marketplaceProducts was NEVER called — clean abort.
    expect(marketplaceSpy).not.toHaveBeenCalled();
  });

  it('records the run id returned by openScanRun in the summary', async () => {
    // Secondary sanity check: runId in the summary matches the id openScanRun allocated.
    const { db } = buildMockDb();
    const env = {
      DB: db,
      CARDTRADER_API_TOKEN: 'x',
      TELEGRAM_BOT_TOKEN: 'x',
      TELEGRAM_CHAT_ID: 'x',
      DESKTOP_AUTH_TOKEN: 'x',
    } as Env;
    const deps = {
      createClient: () => buildUnauthorisedClient(),
    };

    const summary = await runScan(env, { trigger: 'cron' }, deps);

    // openScanRun stub returns last_row_id = 1.
    expect(summary.runId).toBe(1);
  });

  it('counts the /info attempt in api_calls even on 401', async () => {
    // The scanner calls onRequest() on every HTTP attempt, including the /info
    // call that returns 401. apiCalls in the summary must therefore be >= 1.
    const { db } = buildMockDb();
    const env = {
      DB: db,
      CARDTRADER_API_TOKEN: 'x',
      TELEGRAM_BOT_TOKEN: 'x',
      TELEGRAM_CHAT_ID: 'x',
      DESKTOP_AUTH_TOKEN: 'x',
    } as Env;

    // This client tracks invocations via a counter but still rejects with 401.
    let infoCallCount = 0;
    const trackingClient: CardTraderClient = {
      info() {
        infoCallCount++;
        return Promise.reject(
          new CardTraderError('invalid or expired token', '/info', 401),
        );
      },
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    };

    // Wire onRequest through the real clientFactory path: the scanner passes
    // onRequest via ClientOptions to createClient, which then calls it on each
    // HTTP attempt. Here we inject a client that already called onRequest
    // conceptually — to test the counter we let the real clientFactory run
    // with a fetch stub that returns 401 immediately.
    //
    // Simpler: just confirm apiCalls >= 1 by using the real throttle-aware path.
    // We inject a fetch that immediately returns 401 so the real ctFetch fires.
    const { createCardTraderClient } = await import('../cardtrader/client');
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response('Unauthorized', { status: 401 }));

    const deps = {
      createClient: (token: string, opts: Parameters<typeof createCardTraderClient>[1]) =>
        createCardTraderClient(token, { ...opts, fetchImpl: fakeFetch, minIntervalMs: 0 }),
    };

    void trackingClient; // suppress unused warning — this path uses the real factory
    void infoCallCount;

    const summary = await runScan(env, { trigger: 'run-now' }, deps);

    // The /info call fired and was counted.
    expect(summary.apiCalls).toBeGreaterThanOrEqual(1);
    // Error is still set.
    expect(summary.error).not.toBeNull();
  });
});
