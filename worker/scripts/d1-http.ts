/**
 * d1-http.ts — D1Database-shaped adapter over the Cloudflare D1 HTTP REST API.
 *
 * Implements the subset of the D1 binding that repo.ts actually uses:
 *   db.prepare(sql)
 *   stmt.bind(...params)
 *   stmt.run()         -> D1Result (with results, meta.last_row_id, meta.changes)
 *   stmt.all()         -> D1Result (alias for run() — SELECT callers read { results })
 *   stmt.first<T>()    -> T | null  (reads result[0] of results)
 *   db.batch([stmts])  -> D1Result[]
 *
 * Transport: POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/
 *            d1/database/{CF_D1_DATABASE_ID}/query
 * Auth header: Authorization: Bearer {CF_API_TOKEN}
 * Body: { sql: string, params: unknown[] }
 *
 * REST response shape:
 *   { success: boolean, errors: {...}[], result: [{ results: Row[], success: boolean,
 *     meta: { last_row_id: number, changes: number, ... } }] }
 *
 * IMPORTANT — batch atomicity:
 *   The real D1 Workers binding wraps batch([...]) in a single atomic SQL transaction.
 *   This adapter executes statements SEQUENTIALLY via individual REST calls — it does NOT
 *   provide atomicity. This is acceptable for the local deep-sweep CLI because all batch
 *   sites in repo.ts are either:
 *     - Idempotent ON CONFLICT upserts (syncExpansions, syncBlueprints): safe to re-run.
 *     - A delete-pair (deleteWatchlist): non-atomic deletion of child+parent rows is
 *       safe for the CLI's read-heavy, single-operator context.
 *     - The deal lifecycle batch (revalidateBlueprintDeals): partially-applied transitions
 *       are harmless — the next scan corrects any inconsistency.
 *   Never use this adapter in a context where transaction atomicity is required.
 *
 * SECRET SAFETY:
 *   The CF_API_TOKEN value is NEVER included in thrown Error messages, console output,
 *   or any string representation in this file. Callers also must not log it.
 *
 * Type cast rationale:
 *   The Workers runtime D1Database interface (from @cloudflare/workers-types) describes
 *   the binding injected by the runtime. This adapter is a Node.js HTTP client that matches
 *   the same structural contract (prepare/bind/run/all/first/batch). TypeScript cannot
 *   verify that a Node fetch-based class satisfies that interface because the interface
 *   includes internal symbol members. We use `as unknown as D1Database` at the single
 *   export boundary in makeD1HttpAdapter(). Everything within this module is fully typed.
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One row returned by D1 REST API. */
type Row = Record<string, unknown>;

/** The meta object inside a D1 REST result entry. */
interface D1RestMeta {
  last_row_id: number;
  changes: number;
  duration?: number;
  rows_read?: number;
  rows_written?: number;
}

/** One entry inside the `result` array of the D1 REST response. */
interface D1RestEntry {
  results: Row[];
  success: boolean;
  meta: D1RestMeta;
}

/** Top-level D1 REST response envelope. */
interface D1RestResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: D1RestEntry[];
}

/** A fully-resolved D1Result that repo.ts callers read. */
interface D1HttpResult<T = Row> {
  results: T[];
  success: boolean;
  meta: {
    last_row_id: number;
    changes: number;
    duration?: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/**
 * Execute a single SQL statement against the D1 REST API.
 * Returns the first result entry.
 *
 * Throws if:
 *  - The HTTP request itself fails (network error).
 *  - The response status is not 2xx.
 *  - The D1 `success` field is false (includes SQL errors).
 *
 * The CF_API_TOKEN is intentionally NOT included in thrown error messages.
 */
async function execStatement(
  accountId: string,
  databaseId: string,
  apiToken: string,
  sql: string,
  params: unknown[],
): Promise<D1RestEntry> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
  } catch (networkErr) {
    throw new Error(
      `D1 HTTP: network error contacting Cloudflare API — ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }

  if (!response.ok) {
    // Read body for error details without ever printing the token.
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignore */ }
    throw new Error(
      `D1 HTTP: request failed with status ${response.status} ${response.statusText}. Body: ${bodyText.slice(0, 300)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('D1 HTTP: failed to parse JSON response from Cloudflare API');
  }

  const body = payload as D1RestResponse;

  if (!body.success || !body.result || body.result.length === 0) {
    const errSummary = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? 'unknown';
    throw new Error(`D1 HTTP: query failed — ${errSummary}`);
  }

  const entry = body.result[0]!;
  if (!entry.success) {
    const errSummary = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? 'unknown';
    throw new Error(`D1 HTTP: statement failed — ${errSummary}`);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Bound statement
// ---------------------------------------------------------------------------

class D1HttpStatement<T = Row> {
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(
    accountId: string,
    databaseId: string,
    apiToken: string,
    sql: string,
    params: unknown[],
  ) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.sql = sql;
    this.params = params;
  }

  /** Return a new statement with these params bound (existing params replaced). */
  bind(...values: unknown[]): D1HttpStatement<T> {
    return new D1HttpStatement<T>(
      this.accountId,
      this.databaseId,
      this.apiToken,
      this.sql,
      values,
    );
  }

  /** Execute the statement and return the full D1HttpResult. */
  async run(): Promise<D1HttpResult<T>> {
    const entry = await execStatement(
      this.accountId,
      this.databaseId,
      this.apiToken,
      this.sql,
      this.params,
    );
    return {
      results: entry.results as T[],
      success: entry.success,
      meta: {
        last_row_id: entry.meta.last_row_id,
        changes: entry.meta.changes,
        duration: entry.meta.duration,
      },
    };
  }

  /**
   * Alias for run() — SELECT callers read { results } from the return value.
   * repo.ts uses .all<T>() for multi-row SELECTs; .run() for mutations.
   * They return the same shape, so this is a direct alias.
   */
  async all(): Promise<D1HttpResult<T>> {
    return this.run();
  }

  /**
   * Return the first row of the result set, or null if empty.
   * Used by repo.ts for .first<T>() calls (single-row reads, e.g. getConfig).
   */
  async first<R = T>(): Promise<R | null> {
    const result = await this.run();
    const row = (result.results as unknown as R[])[0];
    return row !== undefined ? row : null;
  }

  // Expose internals so D1HttpDatabase.batch() can read them without re-executing.
  getSql(): string { return this.sql; }
  getParams(): unknown[] { return this.params; }
}

// ---------------------------------------------------------------------------
// Database adapter
// ---------------------------------------------------------------------------

class D1HttpDatabase {
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;

  constructor(accountId: string, databaseId: string, apiToken: string) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
  }

  /** Create a prepared statement. Params are bound via .bind(...). */
  prepare(sql: string): D1HttpStatement {
    return new D1HttpStatement(this.accountId, this.databaseId, this.apiToken, sql, []);
  }

  /**
   * Execute an array of prepared statements SEQUENTIALLY and return one result per
   * statement.
   *
   * NOTE — atomicity: the real D1 Workers binding executes batch() as an atomic
   * SQL transaction. This adapter issues individual REST calls; there is NO
   * transaction guarantee. See the file-level comment for why this is acceptable
   * for the local deep-sweep CLI.
   *
   * Callers that destructure the results array (e.g. `const [, second] = await
   * db.batch([...])`) can safely read `second.meta.changes` — each entry in the
   * returned array maps 1-to-1 with the input statements.
   */
  async batch(statements: D1HttpStatement[]): Promise<D1HttpResult[]> {
    const results: D1HttpResult[] = [];
    for (const stmt of statements) {
      const result = await execStatement(
        this.accountId,
        this.databaseId,
        this.apiToken,
        stmt.getSql(),
        stmt.getParams(),
      );
      results.push({
        results: result.results,
        success: result.success,
        meta: {
          last_row_id: result.meta.last_row_id,
          changes: result.meta.changes,
          duration: result.meta.duration,
        },
      });
    }
    return results;
  }

  /** Convenience: execute a raw SQL string with no parameters. */
  async exec(query: string): Promise<D1HttpResult> {
    return this.prepare(query).run();
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a D1Database-shaped adapter backed by the Cloudflare D1 REST API.
 *
 * The returned object is cast `as unknown as D1Database` because:
 *   1. The @cloudflare/workers-types D1Database interface includes internal
 *      symbol-keyed members that are runtime injected by the Workers binding.
 *      A plain JS class cannot structurally satisfy that interface at compile
 *      time even though it fulfils the contract at runtime.
 *   2. All repo.ts call sites (prepare/bind/run/all/first/batch) are covered
 *      by the concrete implementations above — the cast is safe for our usage.
 *
 * SECURITY: the apiToken is stored inside the D1HttpDatabase closure only and
 * is never returned, logged, or included in error messages.
 */
export function makeD1HttpAdapter(
  accountId: string,
  databaseId: string,
  apiToken: string,
): D1Database {
  const db = new D1HttpDatabase(accountId, databaseId, apiToken);
  // Type-cast: see rationale above. The structural contract is fulfilled by the
  // D1HttpDatabase + D1HttpStatement methods that repo.ts actually calls.
  return db as unknown as D1Database;
}
