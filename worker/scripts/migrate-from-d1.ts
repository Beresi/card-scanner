/**
 * migrate-from-d1.ts — one-way copy of the Cloudflare D1 database into the
 * local SQLite file the self-hosted backend uses.
 *
 * Reads over the D1 REST API with the same CF_API_TOKEN the existing deep-sweep
 * sidecar already uses (Account · D1 · Edit), so no extra credential is needed
 * and `wrangler login` is not involved.
 *
 * Design notes:
 *
 *  • Paged by rowid, not OFFSET. Every table here is a normal rowid table, so
 *    `WHERE rowid > ? ORDER BY rowid LIMIT n` is a stable cursor that cannot skip
 *    or duplicate rows, and stays O(1) per page as `blueprints` grows past
 *    hundreds of thousands of rows. OFFSET paging degrades quadratically and
 *    would burn D1 row reads re-scanning the prefix on every page.
 *
 *  • RESUMABLE. Each page is committed locally before the next is fetched, and
 *    the cursor restarts from `MAX(rowid)` already present locally. D1's free
 *    tier caps row reads per day (midnight UTC reset) — if the cap is hit
 *    mid-copy, re-running the script continues from where it stopped instead of
 *    starting over. `--fresh` opts out and re-copies a table from zero.
 *
 *  • Column intersection. Rows are inserted using only the columns present in
 *    BOTH the remote and local table. Any column on one side but not the other
 *    is reported — that is the signal that remote D1 and src/db/schema.sql have
 *    drifted, which is exactly what you want to know before cutting over.
 *
 *  • INSERT OR REPLACE keyed on the real primary key, so a re-run is idempotent
 *    and a partially-copied table heals rather than duplicating.
 *
 * Usage:
 *   npm run db:migrate-from-d1                     copy everything, resuming
 *   npm run db:migrate-from-d1 -- --fresh          wipe local tables first
 *   npm run db:migrate-from-d1 -- --tables=deals,watchlist
 *   npm run db:migrate-from-d1 -- --verify         count-only comparison, no writes
 *
 * SECURITY: CF_API_TOKEN is consumed internally and never printed, and never
 * appears in an error message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openLocalD1 } from './d1-sqlite';
import { bootstrapLocalDb } from './db-bootstrap';
import { makeVarGetter, requireKeys } from './vars';

// Non-secret ids — same values as wrangler.toml / env-local.ts.
const DEFAULT_CF_ACCOUNT_ID = '541d9063453516ba295a2c1cbf298129';
const DEFAULT_CF_D1_DATABASE_ID = '32265ad6-4e1d-4ef8-8086-899962fcdb1f';

/**
 * Tables to copy, ordered MOST-VALUABLE-FIRST.
 *
 * The schema has exactly one foreign key — deals.watchlist_id → watchlist(id) —
 * so the only hard requirement is that `watchlist` precedes `deals`. Everything
 * else is free to order by usefulness, and it should be:
 *
 * `blueprints` is the MTG card catalog and dwarfs every other table by orders of
 * magnitude. Copying it early would mean that a run which exhausts the daily
 * row-read cap partway leaves the owner with a catalog but no watchlist, no
 * deals and no purchase history — the very things the app is for. Copying it
 * last means an interrupted run still yields a usable app, and the catalog
 * (which the scanner rebuilds on its own anyway) fills in on the next run.
 *
 * `_local_migrations` is deliberately absent — it is local bookkeeping, rebuilt
 * by bootstrapLocalDb().
 */
const TABLES = [
  'config',      // one row, and everything inherits from it
  'watchlist',   // must precede deals (FK)
  'deals',       // the feed
  'purchases',   // the ledger — irreplaceable, nothing regenerates it
  'scan_runs',   // history for the Health view
  'expansions',  // set list; small
  'blueprints',  // the card catalog — huge, and regenerable. Last on purpose.
] as const;

/** Rows per REST request. Small enough to stay well inside D1's response cap
 *  on wide tables, large enough that a 500k-row catalog is ~250 requests. */
const PAGE_SIZE = 2000;

// ---------------------------------------------------------------------------
// D1 REST transport
// ---------------------------------------------------------------------------

interface RestEntry { results: Record<string, unknown>[]; success: boolean }

/**
 * Execute one SQL statement against remote D1 and return its rows.
 * Retries on 429 / 5xx with linear backoff; a row-limit error is NOT retried
 * (it will not clear until the daily reset) and is surfaced to the caller.
 */
async function remoteQuery(
  accountId: string,
  databaseId: string,
  apiToken: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });

    const text = await res.text();

    // Cloudflare reports the row-read cap as HTTP 400 with code 7500 in the body,
    // so the error array must be inspected regardless of status — checking only
    // the 2xx path would let the cap surface as a generic "400 Bad Request".
    let body: { success?: boolean; result?: RestEntry[]; errors?: { code: number; message: string }[] } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* non-JSON body */ }
    const errs = body.errors ?? [];

    // 7500 = free-tier daily row-read limit. Retrying cannot help — it clears
    // only at midnight UTC. Surface it as the actionable "resume later" message.
    if (errs.some((e) => e.code === 7500)) {
      throw new Error(
        'D1 daily row-read limit reached. Everything copied so far is committed locally; ' +
        're-run this command after the limit resets (midnight UTC) and it resumes from the same point.',
      );
    }

    if (res.ok) {
      if (body.success && body.result?.[0]) { return body.result[0].results ?? []; }
      throw new Error(`D1 query failed: ${errs.map((e) => `[${e.code}] ${e.message}`).join('; ') || 'unknown'}`);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    throw new Error(`D1 request failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }
  throw new Error('D1 request failed after retries');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/**
 * Module-level handle so the top-level catch can close SQLite before exiting.
 * Calling process.exit() with an open better-sqlite3 handle trips a libuv
 * assertion on Windows, so the handle is closed first and the exit is left to
 * `process.exitCode` plus a natural drain of the event loop.
 */
let openDb: { close(): void } | null = null;

function closeDb(): void {
  try { openDb?.close(); } catch { /* already closed */ }
  openDb = null;
}

/** Column names of `table` on the remote database. */
async function remoteColumns(q: (sql: string, p?: unknown[]) => Promise<Record<string, unknown>[]>, table: string): Promise<string[]> {
  const rows = await q(`PRAGMA table_info(${table})`);
  return rows.map((r) => String(r['name']));
}

/**
 * The column used for INSERT OR REPLACE conflict resolution, per table.
 * `config` is a single-row table keyed on id; the rest use their own PK.
 */
function primaryKeyOf(table: string): string {
  return table === 'config' ? 'id' : 'id';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (flag: string): boolean => argv.includes(flag);
  const valueOf = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`${name}=`))?.split('=').slice(1).join('=');

  const fresh = has('--fresh');
  const verifyOnly = has('--verify');
  const only = valueOf('--tables')?.split(',').map((s) => s.trim()).filter(Boolean);

  const get = makeVarGetter();
  requireKeys(get, ['CF_API_TOKEN']);

  const accountId = get('CF_ACCOUNT_ID') ?? DEFAULT_CF_ACCOUNT_ID;
  const databaseId = get('CF_D1_DATABASE_ID') ?? DEFAULT_CF_D1_DATABASE_ID;
  const apiToken = get('CF_API_TOKEN')!;

  const q = (sql: string, p: unknown[] = []) => remoteQuery(accountId, databaseId, apiToken, sql, p);

  // --- Probe the remote FIRST ----------------------------------------------
  // Nothing local is touched until Cloudflare has answered a trivial query.
  //
  // The overwhelmingly likely failure here is the daily row-read cap, and there
  // is no point creating a database directory and running a bootstrap for a run
  // that cannot proceed.
  //
  // (Note: on Windows this process also prints a spurious libuv assertion,
  // "!(handle->flags & UV_HANDLE_CLOSING)", after any error exit. It comes from
  // tsx tearing down undici's fetch handles, not from this script -- it is not
  // better-sqlite3, and it appears with the SQLite handle closed, left open, or
  // never created. Purely cosmetic: the real message prints first and the exit
  // code is correct.)
  //
  // The probe must READ A ROW. `SELECT 1` touches no table, so it succeeds even
  // when the row-read cap is exhausted and would wave a doomed run straight
  // through. Reading one row from `config` (a single-row table) costs one row
  // and is a true test of both reachability and the cap.
  await q('SELECT id FROM config LIMIT 1');

  // --- Local database -------------------------------------------------------
  const explicitDb = get('CARD_BROKER_DB');
  const dbPath = explicitDb
    ? path.resolve(explicitDb)
    : path.join(process.env.APPDATA ?? process.cwd(), 'CardBroker', 'cardbroker.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const { raw } = openLocalD1(dbPath);
  openDb = raw;
  bootstrapLocalDb(raw);

  log('');
  log('=== Card // Broker — D1 → local SQLite ===');
  log(`  source : Cloudflare D1 ${databaseId}`);
  log(`  target : ${dbPath}`);
  log(`  mode   : ${verifyOnly ? 'verify only (no writes)' : fresh ? 'fresh (local tables wiped)' : 'resume'}`);
  log('');

  const tables = only ? TABLES.filter((t) => only.includes(t)) : [...TABLES];
  const summary: { table: string; remote: number; local: number; copied: number }[] = [];

  for (const table of tables) {
    const remoteTotal = Number(
      (await q(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.['n'] ?? 0,
    );

    if (verifyOnly) {
      const localTotal = Number(
        (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
      const mark = localTotal === remoteTotal ? 'OK' : 'MISMATCH';
      log(`  ${table.padEnd(12)} remote ${String(remoteTotal).padStart(8)}  local ${String(localTotal).padStart(8)}  ${mark}`);
      summary.push({ table, remote: remoteTotal, local: localTotal, copied: 0 });
      continue;
    }

    if (fresh) { raw.prepare(`DELETE FROM ${table}`).run(); }

    // --- Column intersection ------------------------------------------------
    const rCols = await remoteColumns(q, table);
    const lCols = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const lSet = new Set(lCols);
    const cols = rCols.filter((c) => lSet.has(c));

    const onlyRemote = rCols.filter((c) => !lSet.has(c));
    const onlyLocal = lCols.filter((c) => !rCols.includes(c));
    if (onlyRemote.length) { log(`  ! ${table}: columns in D1 but not locally (NOT copied): ${onlyRemote.join(', ')}`); }
    if (onlyLocal.length) { log(`  ! ${table}: columns local but not in D1 (left at default): ${onlyLocal.join(', ')}`); }

    // --- Resume cursor ------------------------------------------------------
    // Restart from the highest primary key already stored locally. Combined with
    // the rowid ordering below this makes a re-run continue rather than repeat.
    const pk = primaryKeyOf(table);
    const startRow = raw.prepare(`SELECT COALESCE(MAX(${pk}), 0) AS m FROM ${table}`).get() as { m: number };
    let cursor = Number(startRow.m);
    const resumed = cursor > 0;

    const insertSql =
      `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) ` +
      `VALUES (${cols.map(() => '?').join(', ')})`;
    const insert = raw.prepare(insertSql);
    const insertPage = raw.transaction((rows: Record<string, unknown>[]) => {
      for (const row of rows) { insert.run(...cols.map((c) => row[c] ?? null)); }
    });

    let copied = 0;
    for (;;) {
      const rows = await q(
        `SELECT * FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ${PAGE_SIZE}`,
        [cursor],
      );
      if (rows.length === 0) { break; }

      insertPage(rows);
      copied += rows.length;
      cursor = Number(rows[rows.length - 1]![pk]);

      process.stdout.write(
        `\r  ${table.padEnd(12)} ${String(copied).padStart(8)} / ${remoteTotal} rows`,
      );
      if (rows.length < PAGE_SIZE) { break; }
    }

    const localTotal = Number(
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    );

    // Keep AUTOINCREMENT past the imported maximum so new local rows never
    // collide with a copied id.
    try {
      raw.prepare(
        `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(${pk}), 0) FROM ${table}) WHERE name = ?`,
      ).run(table);
    } catch { /* table has no AUTOINCREMENT counter — nothing to align */ }

    process.stdout.write(
      `\r  ${table.padEnd(12)} ${String(localTotal).padStart(8)} / ${remoteTotal} rows` +
      `${resumed ? ' (resumed)' : ''}${localTotal === remoteTotal ? '  OK' : '  INCOMPLETE'}\n`,
    );
    summary.push({ table, remote: remoteTotal, local: localTotal, copied });
  }

  // --- Verdict --------------------------------------------------------------
  log('');
  const incomplete = summary.filter((s) => s.local !== s.remote);
  if (incomplete.length === 0) {
    log('All tables match remote row counts. Local database is a complete copy.');
  } else {
    log('INCOMPLETE — these tables do not match remote row counts:');
    for (const s of incomplete) { log(`  ${s.table}: local ${s.local} vs remote ${s.remote}`); }
    log('Re-run this command to resume (it continues from the last copied row).');
  }
  log('');

  closeDb();
  process.exitCode = incomplete.length === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`\n[migrate-from-d1] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
