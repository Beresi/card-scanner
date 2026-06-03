/**
 * Minimal D1Database-compatible adapter backed by better-sqlite3 (in-memory).
 *
 * Implements exactly the prepared-statement methods the repo layer calls:
 *   prepare(sql)  → { bind(...args) → { run, first, all }, run, first, all }
 *   batch([stmts]) → Promise<D1Result[]>
 *
 * The adapter runs real SQL, which is essential for testing the dynamic
 * SET/WHERE builders in patchConfig, patchWatchlist, listDeals, and the
 * batch-cascade DELETE in deleteWatchlist.
 *
 * SQLite datetime('now') is supported natively by better-sqlite3.
 *
 * Usage:
 *   import { makeD1 } from './__test-helpers__/d1';
 *   const db = makeD1();   // fresh in-memory DB per test / suite
 *
 * The returned object is cast to `D1Database` via `as unknown as D1Database`
 * — the same pattern already used in scanner.test.ts.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../../db/schema.sql');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shape that satisfies D1Result<T> well enough for the repo to inspect. */
function makeResult<T = Record<string, unknown>>(
  rows: T[],
  changes: number,
  lastRowId?: number,
): D1Result<T> {
  return {
    results: rows,
    success: true,
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0,
      last_row_id: lastRowId ?? 0,
      rows_read: rows.length,
      rows_written: changes,
      size_after: 0,
    },
  } as unknown as D1Result<T>;
}

/**
 * Build a bound statement object that mimics D1PreparedStatement methods.
 * `stmtFactory` recreates the better-sqlite3 Statement with the given binds
 * so we respect SQLite's single-step execution model.
 */
function makeBoundStatement<T = Record<string, unknown>>(
  db: Database.Database,
  sql: string,
  binds: unknown[],
) {
  return {
    run(): Promise<D1Result<T>> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(binds as Parameters<typeof stmt.run>));
      return Promise.resolve(
        makeResult<T>([], info.changes, Number(info.lastInsertRowid) || undefined),
      );
    },
    first<R = T>(): Promise<R | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(binds as Parameters<typeof stmt.get>)) as R | undefined;
      return Promise.resolve(row ?? null);
    },
    all<R = T>(): Promise<D1Result<R>> {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(binds as Parameters<typeof stmt.all>)) as R[];
      return Promise.resolve(makeResult<R>(rows, 0));
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh in-memory SQLite database with the full schema already applied.
 *
 * Call once per test suite (or per test if full isolation is needed).
 * Returns the raw better-sqlite3 handle alongside the D1-compatible façade
 * so callers can run seeding SQL directly with `raw.prepare(...).run(...)`.
 */
export function makeD1(): { db: D1Database; raw: Database.Database } {
  const raw = new Database(':memory:');
  // Apply the real schema — same DDL the production Worker uses.
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  raw.exec(schema);

  const db = {
    prepare(sql: string) {
      // Returns an unbound statement — callers chain .bind(...) or call
      // .run() / .first() / .all() directly on it.
      const unbound = {
        bind(...args: unknown[]) {
          return makeBoundStatement(raw, sql, args);
        },
        run(): Promise<D1Result> {
          return makeBoundStatement(raw, sql, []).run();
        },
        first<T = Record<string, unknown>>(): Promise<T | null> {
          return makeBoundStatement<T>(raw, sql, []).first<T>();
        },
        all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          return makeBoundStatement<T>(raw, sql, []).all<T>();
        },
      };
      return unbound as unknown as D1PreparedStatement;
    },

    batch<T = Record<string, unknown>>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      // Each statement is an object built by our prepare().bind() chain.
      // Cast back to our internal shape to call .run().
      const results = Promise.all(
        statements.map((s) =>
          (s as unknown as ReturnType<typeof makeBoundStatement>).run() as Promise<D1Result<T>>,
        ),
      );
      return results;
    },

    exec(sql: string): Promise<D1ExecResult> {
      raw.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 } as D1ExecResult);
    },
  } as unknown as D1Database;

  return { db, raw };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal deal row directly via raw SQL (bypassing upsertDeal's
 * ON CONFLICT guard, which is what lets us seed known states for tests).
 *
 * `found_at` accepts a SQLite datetime string, e.g. "2025-01-01 00:00:00"
 * or the special literal "datetime('now','-60 days')".  Pass an ISO string
 * for deterministic timestamps; SQLite will store it verbatim.
 */
export function seedDeal(
  raw: Database.Database,
  fields: {
    watchlist_id: number;
    blueprint_id: number;
    product_id: number;
    card_name: string;
    price_cents: number;
    currency: string;
    baseline_cents: number;
    cohort_size: number;
    discount_pct: number;
    priority?: string;
    seen?: number;
    dismissed?: number;
    found_at?: string; // ISO string or SQLite datetime expression
  },
): void {
  const {
    watchlist_id,
    blueprint_id,
    product_id,
    card_name,
    price_cents,
    currency,
    baseline_cents,
    cohort_size,
    discount_pct,
    priority = 'normal',
    seen = 0,
    dismissed = 0,
    found_at,
  } = fields;

  if (found_at) {
    // Use exec so we can embed a datetime() expression if needed.
    raw.exec(
      `INSERT INTO deals
         (watchlist_id, blueprint_id, product_id, card_name,
          price_cents, currency, baseline_cents, cohort_size,
          discount_pct, priority, seen, dismissed, found_at)
       VALUES
         (${watchlist_id}, ${blueprint_id}, ${product_id}, '${card_name}',
          ${price_cents}, '${currency}', ${baseline_cents}, ${cohort_size},
          ${discount_pct}, '${priority}', ${seen}, ${dismissed},
          ${found_at.startsWith("datetime(") ? found_at : `'${found_at}'`})`,
    );
  } else {
    raw
      .prepare(
        `INSERT INTO deals
           (watchlist_id, blueprint_id, product_id, card_name,
            price_cents, currency, baseline_cents, cohort_size,
            discount_pct, priority, seen, dismissed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        watchlist_id,
        blueprint_id,
        product_id,
        card_name,
        price_cents,
        currency,
        baseline_cents,
        cohort_size,
        discount_pct,
        priority,
        seen,
        dismissed,
      );
  }
}

/**
 * Insert a scan_runs row directly via raw SQL.
 *
 * `finished_at` and `error` are optional; if omitted the run appears as "in progress".
 * Returns the inserted row id.
 */
export function seedScanRun(
  raw: Database.Database,
  fields: {
    started_at?: string;
    finished_at?: string | null;
    watch_items_scanned?: number;
    blueprints_scanned?: number;
    api_calls?: number;
    deals_found?: number;
    telegram_sent?: number;
    error?: string | null;
  } = {},
): void {
  const {
    started_at = "datetime('now')",
    finished_at = null,
    watch_items_scanned = 0,
    blueprints_scanned = 0,
    api_calls = 5,
    deals_found = 3,
    telegram_sent = 1,
    error = null,
  } = fields;

  // Use exec so we can embed datetime() expressions in started_at / finished_at.
  const startedVal = started_at.startsWith("datetime(") ? started_at : `'${started_at}'`;
  const finishedVal =
    finished_at === null
      ? 'NULL'
      : finished_at.startsWith("datetime(")
        ? finished_at
        : `'${finished_at}'`;
  const errorVal = error === null ? 'NULL' : `'${error.replace(/'/g, "''")}'`;

  raw.exec(
    `INSERT INTO scan_runs
       (started_at, finished_at, watch_items_scanned, blueprints_scanned,
        api_calls, deals_found, telegram_sent, error)
     VALUES
       (${startedVal}, ${finishedVal}, ${watch_items_scanned}, ${blueprints_scanned},
        ${api_calls}, ${deals_found}, ${telegram_sent}, ${errorVal})`,
  );
}

/**
 * Insert a minimal watchlist row directly.  Returns the inserted id via
 * better-sqlite3's lastInsertRowid.
 */
export function seedWatchlist(
  raw: Database.Database,
  fields: {
    type?: string;
    cardtrader_id: number;
    label: string;
    min_discount_pct?: number | null;
  },
): number {
  const { type = 'blueprint', cardtrader_id, label, min_discount_pct = null } = fields;
  const info = raw
    .prepare(
      `INSERT INTO watchlist (type, cardtrader_id, label, min_discount_pct)
       VALUES (?, ?, ?, ?)`,
    )
    .run(type, cardtrader_id, label, min_discount_pct);
  return Number(info.lastInsertRowid);
}
