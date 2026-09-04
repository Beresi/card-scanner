/**
 * d1-sqlite.ts — D1Database-shaped adapter over a LOCAL SQLite file
 * (better-sqlite3). This is the persistence backend for the self-hosted stack.
 *
 * It is the file-backed sibling of two adapters that already exist:
 *   - scripts/d1-http.ts                  → Cloudflare D1 over the REST API
 *   - src/api/__test-helpers__/d1.ts      → in-memory SQLite, used by the suite
 * All three satisfy the same structural contract that src/db/repo.ts calls:
 *   prepare(sql) · stmt.bind(...) · run() · all() · first<T>() · batch([...]) · exec()
 *
 * Why better-sqlite3 rather than node:sqlite — the entire repo layer is already
 * exercised against better-sqlite3 by the test suite, so every statement in
 * repo.ts is known to run on it. node:sqlite is still flagged experimental.
 * Swapping later is confined to this one file.
 *
 * BATCH ATOMICITY — unlike d1-http.ts (sequential REST calls, no transaction),
 * this adapter wraps batch() in a real SQLite transaction, matching the
 * semantics of the genuine Workers D1 binding. Self-hosting is therefore
 * STRICTER than the local sidecar it replaces, not looser.
 *
 * Pragmas applied on open:
 *   journal_mode = WAL   — readers (the API) never block the writer (the scan)
 *   busy_timeout = 5000  — wait rather than throw SQLITE_BUSY under contention
 *   foreign_keys = ON    — enforce the watchlist→deals cascade the schema declares
 *   synchronous  = NORMAL— safe under WAL, avoids fsync on every commit
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Bind-value coercion
// ---------------------------------------------------------------------------

/**
 * SQLite (via better-sqlite3) accepts only null, number, bigint, string and
 * Buffer. The repo layer is written against D1, which is more forgiving about
 * `undefined` and booleans, so normalise here rather than auditing 46 call sites.
 *   undefined → null   (D1 treats a missing bind as SQL NULL)
 *   boolean   → 0 | 1  (the schema stores booleans as INTEGER, per PRD §9)
 */
function coerceBind(value: unknown): unknown {
  if (value === undefined) { return null; }
  if (typeof value === 'boolean') { return value ? 1 : 0; }
  return value;
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/** Build a D1Result-shaped object from a SQLite outcome. */
function makeResult<T>(rows: T[], changes: number, lastRowId: number): D1Result<T> {
  return {
    results: rows,
    success: true,
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0,
      last_row_id: lastRowId,
      rows_read: rows.length,
      rows_written: changes,
      size_after: 0,
    },
  } as unknown as D1Result<T>;
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

/**
 * A prepared statement carrying its SQL and (possibly empty) bind list.
 * `bind()` returns a NEW instance rather than mutating, matching D1 semantics
 * where a prepared statement can be bound repeatedly and independently.
 */
class SqliteStatement<T = Record<string, unknown>> {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): SqliteStatement<T> {
    return new SqliteStatement<T>(this.db, this.sql, values.map(coerceBind));
  }

  /**
   * Execute the statement.
   *
   * A statement that returns rows (better-sqlite3 exposes this as `.reader`)
   * is routed to .all() — the real D1 binding lets run() be called on a SELECT
   * and returns its rows, and scripts/d1-http.ts does the same. Routing here
   * keeps the three adapters interchangeable.
   */
  runSync(): D1Result<T> {
    const stmt = this.db.prepare(this.sql);
    if (stmt.reader) {
      const rows = stmt.all(...(this.params as [])) as T[];
      return makeResult<T>(rows, 0, 0);
    }
    const info = stmt.run(...(this.params as []));
    return makeResult<T>([], info.changes, Number(info.lastInsertRowid) || 0);
  }

  // The public methods are `async` rather than returning Promise.resolve(...)
  // so that a SQLite error becomes a REJECTED PROMISE, matching the real D1
  // binding. Synchronously throwing from a Promise-returning method would break
  // every `db.run().catch(...)` call site and escape as an uncaught exception.
  async run(): Promise<D1Result<T>> {
    return this.runSync();
  }

  /** Alias for run() — SELECT callers read { results }. */
  async all<R = T>(): Promise<D1Result<R>> {
    return this.runSync() as unknown as D1Result<R>;
  }

  /** First row of the result set, or null when empty. */
  async first<R = T>(): Promise<R | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as [])) as R | undefined;
    return row ?? null;
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class SqliteD1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql, []);
  }

  /**
   * Execute every statement inside ONE SQLite transaction, mirroring the atomic
   * behaviour of the real D1 binding: either all statements apply or none do.
   * Returns one result per input statement, in order.
   */
  async batch<T = Record<string, unknown>>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
    const txn = this.db.transaction((stmts: SqliteStatement[]) =>
      stmts.map((s) => s.runSync() as unknown as D1Result<T>),
    );
    // `async` so a constraint violation rolls the transaction back AND surfaces
    // as a rejected promise, not a synchronous throw. See the note on run().
    return txn(statements);
  }

  /** Run a raw multi-statement SQL string (DDL, migrations). No binds. */
  async exec(sql: string): Promise<D1ExecResult> {
    this.db.exec(sql);
    return { count: 0, duration: 0 } as D1ExecResult;
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Open (creating if absent) the SQLite file at `filePath` and return both the
 * D1-shaped façade and the raw handle.
 *
 * The raw handle is exposed so bootstrap/migration tooling can run DDL, bulk
 * inserts and transactions directly without going through the D1 contract.
 *
 * The `as unknown as D1Database` cast is the same one d1-http.ts documents:
 * the workers-types interface carries runtime-injected symbol members that no
 * plain class can structurally satisfy, but every method repo.ts actually calls
 * is implemented above.
 */
export function openLocalD1(filePath: string): { db: D1Database; raw: Database.Database } {
  const raw = new Database(filePath);

  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('foreign_keys = ON');
  raw.pragma('synchronous = NORMAL');

  return { db: new SqliteD1Database(raw) as unknown as D1Database, raw };
}
