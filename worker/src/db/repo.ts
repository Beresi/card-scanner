/**
 * Typed D1 query helpers — the ONLY surface that issues raw SQL.
 *
 * Phase 1 set: scan_runs lifecycle, active watchlist load, config read, and
 * the deal upsert/dedupe contract.  Phase 3 will add listDeals, patchDeal,
 * prune, watchlist CRUD, cache helpers, and config patch.
 *
 * Conventions enforced here:
 *  - Prepared statements + .bind() only — never string-interpolate values.
 *  - Money passes through as integer cents; no float arithmetic.
 *  - Boolean 0/1 conversion happens at this boundary: D1 returns 0|1, callers
 *    receive real booleans (WatchlistRow keeps 0|1 per its type declaration).
 *  - Timestamps are written via datetime('now') in SQL — never JS Date strings.
 *
 * PRD §9 / §9a; docs/documentation/data-model.md; docs/documentation/scanner.md.
 */

import type {
  WatchlistRow,
  WatchlistInsert,
  ConfigRow,
  DealInsert,
  DealRow,
  ScanCounts,
  ScanRunRow,
  ExpansionRow,
  BlueprintRow,
} from './types';

// ---------------------------------------------------------------------------
// Scan-runs lifecycle (PRD §11 steps 1 + 10)
// ---------------------------------------------------------------------------

/**
 * Open a new scan run row.
 *
 * Inserts a `scan_runs` row with `started_at = datetime('now')` and returns
 * the newly-allocated `id`.  The scanner holds this id for the whole run and
 * passes it to `closeScanRun` in its `finally` block.
 */
export async function openScanRun(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO scan_runs (started_at)
       VALUES (datetime('now'))`,
    )
    .run();

  const id = res.meta.last_row_id;
  if (typeof id !== 'number' || id <= 0) {
    throw new Error('openScanRun: failed to obtain a valid scan_runs id');
  }
  return id;
}

/**
 * Close a scan run row.
 *
 * Writes `finished_at`, all five `ScanCounts` fields, and `error` (null on a
 * clean run).  Called from the scanner's `finally` block so the row always
 * closes, even when the run throws.
 */
export async function closeScanRun(
  db: D1Database,
  id: number,
  counts: ScanCounts,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE scan_runs
          SET finished_at          = datetime('now'),
              watch_items_scanned  = ?,
              blueprints_scanned   = ?,
              api_calls            = ?,
              deals_found          = ?,
              telegram_sent        = ?,
              error                = ?
        WHERE id = ?`,
    )
    .bind(
      counts.watch_items_scanned,
      counts.blueprints_scanned,
      counts.api_calls,
      counts.deals_found,
      counts.telegram_sent,
      error,
      id,
    )
    .run();
}

/**
 * Read the most recent scan_runs row (by id DESC).
 *
 * Returns null when no scan has ever run (empty table).
 * Used by GET /api/health to surface last-scan telemetry.
 */
export async function getLatestScanRun(db: D1Database): Promise<ScanRunRow | null> {
  return db
    .prepare(
      `SELECT id, started_at, finished_at,
              watch_items_scanned, blueprints_scanned, api_calls,
              deals_found, telegram_sent, error
         FROM scan_runs
        ORDER BY id DESC
        LIMIT 1`,
    )
    .first<ScanRunRow>();
}

/**
 * List recent scan_runs rows, newest first.
 *
 * Returns up to `limit` rows (default 20).  Used by GET /api/scan/runs for the
 * Health view history table.
 */
export async function listScanRuns(
  db: D1Database,
  limit = 20,
): Promise<ScanRunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, started_at, finished_at,
              watch_items_scanned, blueprints_scanned, api_calls,
              deals_found, telegram_sent, error
         FROM scan_runs
        ORDER BY id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<ScanRunRow>();

  return results;
}

// ---------------------------------------------------------------------------
// Watchlist (PRD §11 step 3)
// ---------------------------------------------------------------------------

/**
 * Load all active watchlist rows.
 *
 * Returns every row where `active = 1`, ordered by `id` for a stable,
 * deterministic scan sequence.  The raw 0|1 boolean columns are left as-is
 * on `WatchlistRow` — callers that need real booleans (e.g. the
 * inheritance resolver) access them via `resolveEffective`.
 */
export async function listActiveWatchlist(
  db: D1Database,
): Promise<WatchlistRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id,
              type,
              cardtrader_id,
              label,
              game_id,
              min_condition,
              foil_pref,
              allow_graded,
              threshold_pct,
              importance,
              telegram_enabled,
              telegram_min_discount_pct,
              telegram_max_price_cents,
              telegram_min_savings_cents,
              active,
              created_at,
              updated_at
         FROM watchlist
        WHERE active = 1
        ORDER BY id ASC`,
    )
    .all<WatchlistRow>();

  return results;
}

// ---------------------------------------------------------------------------
// Config (PRD §9 — single id = 1 row)
// ---------------------------------------------------------------------------

/**
 * Read the single config row.
 *
 * Throws if the row is missing — `schema.sql` seeds `id = 1` via
 * `INSERT OR IGNORE INTO config (id) VALUES (1)`, so null means a broken DB
 * (migration not applied or row manually deleted).
 */
export async function getConfig(db: D1Database): Promise<ConfigRow> {
  const row = await db
    .prepare(`SELECT * FROM config WHERE id = 1`)
    .first<ConfigRow>();

  if (row === null) {
    throw new Error(
      'getConfig: config row (id = 1) is missing — was the schema applied?',
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Deals upsert / dedupe contract (PRD §7 step 7, §13)
// ---------------------------------------------------------------------------

/**
 * Upsert a deal row.
 *
 * Uses `ON CONFLICT(product_id) DO NOTHING` to enforce the one-row-per-listing
 * invariant.  Returns `true` if a new row was inserted (a brand-new deal this
 * run) and `false` if the product_id already existed (already-known; skip
 * Telegram routing).
 *
 * This is the ONLY insert path for deals — nothing bypasses the ON CONFLICT
 * clause so the dedupe guarantee holds end to end.
 *
 * Boolean fields (`foil`, `can_sell_via_hub`) arrive as `boolean | null` on
 * `DealInsert` and are bound as `0 | 1 | null` here — SQLite has no boolean.
 */
export async function upsertDeal(
  db: D1Database,
  deal: DealInsert,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO deals (
         watchlist_id,
         blueprint_id,
         product_id,
         card_name,
         expansion_name,
         seller_username,
         seller_country,
         condition,
         language,
         foil,
         can_sell_via_hub,
         quantity,
         price_cents,
         currency,
         baseline_cents,
         cohort_size,
         discount_pct,
         priority,
         buy_url,
         found_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         datetime('now')
       )
       ON CONFLICT(product_id) DO NOTHING`,
    )
    .bind(
      deal.watchlist_id,
      deal.blueprint_id,
      deal.product_id,
      deal.card_name,
      deal.expansion_name,
      deal.seller_username,
      deal.seller_country,
      deal.condition,
      deal.language,
      // Boolean → 0/1/null conversion at the D1 boundary
      deal.foil === null ? null : deal.foil ? 1 : 0,
      deal.can_sell_via_hub === null ? null : deal.can_sell_via_hub ? 1 : 0,
      deal.quantity,
      deal.price_cents,
      deal.currency,
      deal.baseline_cents,
      deal.cohort_size,
      deal.discount_pct,
      deal.priority,
      deal.buy_url,
    )
    .run();

  // meta.changes is 1 when a row was inserted, 0 when the ON CONFLICT path
  // fired (existing product_id).  This is the sole dedupe signal — do NOT
  // re-query and diff, as the skill and PRD §7/§13 both require.
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Telegram dedupe mark (PRD §8 — one push per product_id, ever)
// ---------------------------------------------------------------------------

/**
 * Mark a deal as pushed to Telegram.
 *
 * Sets `telegram_sent = 1` and `telegram_sent_at = datetime('now')` for the
 * row with the given `product_id` (the UNIQUE dedupe column — a `DealInsert`
 * carries no row `id`, so we key on `product_id`).  Called by the scanner only
 * AFTER `notifier.sendDeals` confirms the batch was delivered, so a held or
 * not-yet-configured run never marks anything sent (criterion 4 in §8 routing).
 */
export async function markTelegramSent(
  db: D1Database,
  productId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE deals
          SET telegram_sent    = 1,
              telegram_sent_at  = datetime('now')
        WHERE product_id = ?`,
    )
    .bind(productId)
    .run();
}

// ---------------------------------------------------------------------------
// Config patch (Phase 3 — PATCH /api/config)
// ---------------------------------------------------------------------------

/**
 * Patched columns that may be updated on the `config` row.
 * `id` and `updated_at` are managed by this helper and are excluded.
 */
const CONFIG_PATCHABLE_COLS = new Set<string>([
  'default_threshold_pct',
  'default_min_condition',
  'cohort_size',
  'min_cohort',
  'new_ticket_foil_pref',
  'new_ticket_allow_graded',
  'new_ticket_importance',
  'new_ticket_telegram_enabled',
  'telegram_min_discount_pct',
  'quiet_hours_start',
  'quiet_hours_end',
  'digest_on_quiet_end',
  'theme',
  'accent_color',
  'density',
  'theme_palette',
  'font',
  'deal_retention_days',
  'timezone',
]);

/**
 * Partially update the single config row (`id = 1`).
 *
 * Builds a dynamic `UPDATE config SET col1=?, col2=?, ... updated_at=datetime('now')`
 * from an allow-listed subset of ConfigRow keys.  Unknown keys are silently skipped.
 * If no valid keys remain, the existing row is returned unchanged.
 *
 * Never inserts a second row — always targets `WHERE id = 1`.
 */
export async function patchConfig(
  db: D1Database,
  patch: Partial<ConfigRow>,
): Promise<ConfigRow> {
  const entries = Object.entries(patch).filter(([k]) => CONFIG_PATCHABLE_COLS.has(k));

  if (entries.length === 0) {
    return getConfig(db);
  }

  const setClauses = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = entries.map(([, v]) => v);

  await db
    .prepare(
      `UPDATE config
          SET ${setClauses}, updated_at = datetime('now')
        WHERE id = 1`,
    )
    .bind(...values)
    .run();

  return getConfig(db);
}

// ---------------------------------------------------------------------------
// Watchlist CRUD (Phase 3 — /api/watchlist)
// ---------------------------------------------------------------------------

/**
 * Columns on `watchlist` that may be updated via PATCH.
 * Excludes `id`, `created_at`, and `updated_at` (managed by the repo).
 */
const WATCHLIST_PATCHABLE_COLS = new Set<string>([
  'type',
  'cardtrader_id',
  'label',
  'game_id',
  'min_condition',
  'foil_pref',
  'allow_graded',
  'threshold_pct',
  'importance',
  'telegram_enabled',
  'telegram_min_discount_pct',
  'telegram_max_price_cents',
  'telegram_min_savings_cents',
  'active',
]);

/**
 * The two §9a override columns that `:id/reset` is permitted to null out.
 * `telegram_max_price_cents` and `telegram_min_savings_cents` are intentionally
 * excluded — they have no config fallback and resetting them to NULL would be
 * ambiguous (NULL already means "no cap / no floor", not "inherit").
 */
const WATCHLIST_RESETTABLE_COLS = new Set<string>([
  'threshold_pct',
  'telegram_min_discount_pct',
]);

/**
 * Read a single watchlist row by primary key.
 * Returns null if no row with that id exists.
 */
export async function getWatchlistById(
  db: D1Database,
  id: number,
): Promise<WatchlistRow | null> {
  return db
    .prepare(
      `SELECT id, type, cardtrader_id, label, game_id, min_condition,
              foil_pref, allow_graded, threshold_pct, importance,
              telegram_enabled, telegram_min_discount_pct,
              telegram_max_price_cents, telegram_min_savings_cents,
              active, created_at, updated_at
         FROM watchlist
        WHERE id = ?`,
    )
    .bind(id)
    .first<WatchlistRow>();
}

/**
 * List ALL watchlist rows (active and inactive), ordered by id.
 *
 * Distinct from `listActiveWatchlist` (scanner use) — this is for the
 * dashboard's full watchlist view (PRD §10 GET /api/watchlist).
 */
export async function listWatchlist(db: D1Database): Promise<WatchlistRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, type, cardtrader_id, label, game_id, min_condition,
              foil_pref, allow_graded, threshold_pct, importance,
              telegram_enabled, telegram_min_discount_pct,
              telegram_max_price_cents, telegram_min_savings_cents,
              active, created_at, updated_at
         FROM watchlist
        ORDER BY id ASC`,
    )
    .all<WatchlistRow>();

  return results;
}

/**
 * Insert a new watchlist row.
 *
 * Only binds columns that are present in `row`; absent optional columns are
 * omitted from the INSERT so the DB defaults apply.  §9a override columns not
 * supplied default to NULL (born inheriting).
 *
 * Returns the freshly-inserted row via `getWatchlistById` keyed on the
 * `last_row_id` from the run result.
 */
export async function insertWatchlist(
  db: D1Database,
  row: WatchlistInsert,
): Promise<WatchlistRow> {
  // Build the column list and values from what is explicitly present.
  // Required columns come first, then each optional column only when provided.
  type ColVal = [string, unknown];
  const colVals: ColVal[] = [
    ['type', row.type],
    ['cardtrader_id', row.cardtrader_id],
    ['label', row.label],
  ];

  if (row.game_id !== undefined)           { colVals.push(['game_id', row.game_id]); }
  if (row.min_condition !== undefined)     { colVals.push(['min_condition', row.min_condition]); }
  if (row.foil_pref !== undefined)         { colVals.push(['foil_pref', row.foil_pref]); }
  if (row.allow_graded !== undefined)      { colVals.push(['allow_graded', row.allow_graded]); }
  if (row.importance !== undefined)        { colVals.push(['importance', row.importance]); }
  if (row.telegram_enabled !== undefined)  { colVals.push(['telegram_enabled', row.telegram_enabled]); }
  if (row.active !== undefined)            { colVals.push(['active', row.active]); }
  // §9a nullable overrides — only bind when callers explicitly supply them
  // (routes should leave these absent so new items are born inheriting)
  if (row.threshold_pct !== undefined)              { colVals.push(['threshold_pct', row.threshold_pct]); }
  if (row.telegram_min_discount_pct !== undefined)  { colVals.push(['telegram_min_discount_pct', row.telegram_min_discount_pct]); }
  if (row.telegram_max_price_cents !== undefined)   { colVals.push(['telegram_max_price_cents', row.telegram_max_price_cents]); }
  if (row.telegram_min_savings_cents !== undefined) { colVals.push(['telegram_min_savings_cents', row.telegram_min_savings_cents]); }

  const cols = colVals.map(([c]) => c).join(', ');
  const placeholders = colVals.map(() => '?').join(', ');
  const values = colVals.map(([, v]) => v);

  const res = await db
    .prepare(`INSERT INTO watchlist (${cols}) VALUES (${placeholders})`)
    .bind(...values)
    .run();

  const newId = res.meta.last_row_id;
  if (typeof newId !== 'number' || newId <= 0) {
    throw new Error('insertWatchlist: failed to obtain a valid rowid after INSERT');
  }

  const inserted = await getWatchlistById(db, newId);
  if (inserted === null) {
    throw new Error('insertWatchlist: row not found after INSERT');
  }
  return inserted;
}

/**
 * Partially update a watchlist row.
 *
 * Builds a dynamic SET from the allow-listed patchable columns.  Unknown keys
 * are silently skipped.  If no valid keys remain, returns the existing row
 * unchanged (or null if the id does not exist).
 *
 * The `patch` parameter uses `Record<string, unknown>` so the route layer can
 * pass the raw parsed JSON body — this function does the allow-listing.
 */
export async function patchWatchlist(
  db: D1Database,
  id: number,
  patch: Record<string, unknown>,
): Promise<WatchlistRow | null> {
  const entries = Object.entries(patch).filter(([k]) => WATCHLIST_PATCHABLE_COLS.has(k));

  if (entries.length === 0) {
    return getWatchlistById(db, id);
  }

  const setClauses = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = [...entries.map(([, v]) => v), id];

  await db
    .prepare(
      `UPDATE watchlist
          SET ${setClauses}, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(...values)
    .run();

  return getWatchlistById(db, id);
}

/**
 * Hard-delete a watchlist row and its associated deals.
 *
 * D1 does not reliably enforce `ON DELETE CASCADE` without `PRAGMA foreign_keys`
 * (which is unreliable in D1).  This function issues a safe batch that explicitly
 * deletes child deals first, then the watchlist row, atomically.
 *
 * Returns `true` if the watchlist row existed (was deleted); `false` if not found.
 */
export async function deleteWatchlist(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const [, watchlistResult] = await db.batch([
    db.prepare(`DELETE FROM deals WHERE watchlist_id = ?`).bind(id),
    db.prepare(`DELETE FROM watchlist WHERE id = ?`).bind(id),
  ]);

  return (watchlistResult.meta.changes ?? 0) > 0;
}

/**
 * Null out a §9a override column to reset a watchlist item back to inheriting.
 *
 * Only `threshold_pct` and `telegram_min_discount_pct` may be reset — these are
 * the two columns that fall back to a `config` default (§9a).  Any other field
 * name throws `Error('invalid_field')`, which the route maps to 400.
 *
 * Returns the updated row, or null if the id does not exist.
 */
export async function resetWatchlistField(
  db: D1Database,
  id: number,
  field: string,
): Promise<WatchlistRow | null> {
  if (!WATCHLIST_RESETTABLE_COLS.has(field)) {
    throw new Error('invalid_field');
  }

  await db
    .prepare(
      `UPDATE watchlist
          SET ${field} = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(id)
    .run();

  return getWatchlistById(db, id);
}

// ---------------------------------------------------------------------------
// Deals read / patch / prune (Phase 3 — /api/deals)
// ---------------------------------------------------------------------------

/**
 * Read a single deal row by primary key.
 * Returns null if no row with that id exists.
 */
export async function getDealById(
  db: D1Database,
  id: number,
): Promise<DealRow | null> {
  return db
    .prepare(`SELECT * FROM deals WHERE id = ?`)
    .bind(id)
    .first<DealRow>();
}

/**
 * List deal rows with optional filters.
 *
 * Filters:
 *  - `status`: `'open'` (default, `dismissed = 0`) or `'all'` (no filter).
 *  - `min_discount`: only rows with `discount_pct >= ?`.
 *  - `watchlist_id`: only rows for this watchlist item.
 *  - `priority`: only rows with this priority value.
 *
 * Results are ordered by `found_at DESC` (newest first).
 */
export async function listDeals(
  db: D1Database,
  f: {
    status?: 'open' | 'all';
    min_discount?: number;
    watchlist_id?: number;
    priority?: string;
  },
): Promise<DealRow[]> {
  let sql = `SELECT * FROM deals WHERE 1=1`;
  const binds: unknown[] = [];

  // Default to 'open' — omit dismissed rows unless caller explicitly asks for all.
  if ((f.status ?? 'open') === 'open') {
    sql += ` AND dismissed = 0`;
  }
  if (f.min_discount !== undefined) {
    sql += ` AND discount_pct >= ?`;
    binds.push(f.min_discount);
  }
  if (f.watchlist_id !== undefined) {
    sql += ` AND watchlist_id = ?`;
    binds.push(f.watchlist_id);
  }
  if (f.priority !== undefined) {
    sql += ` AND priority = ?`;
    binds.push(f.priority);
  }

  sql += ` ORDER BY found_at DESC`;

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<DealRow>();

  return results;
}

/**
 * Partially update a deal's `seen` and/or `dismissed` flags.
 *
 * Converts JS booleans to 0/1 before binding.  Skips absent fields.
 * If neither field is provided, returns the existing row unchanged (or null
 * if not found).
 *
 * Returns the updated row, or null if no row exists for the given id.
 */
export async function patchDeal(
  db: D1Database,
  id: number,
  patch: { seen?: boolean; dismissed?: boolean },
): Promise<DealRow | null> {
  type ColVal = [string, 0 | 1];
  const colVals: ColVal[] = [];

  if (patch.seen !== undefined)      { colVals.push(['seen', patch.seen ? 1 : 0]); }
  if (patch.dismissed !== undefined) { colVals.push(['dismissed', patch.dismissed ? 1 : 0]); }

  if (colVals.length === 0) {
    return getDealById(db, id);
  }

  const setClauses = colVals.map(([col]) => `${col} = ?`).join(', ');
  const values = [...colVals.map(([, v]) => v), id];

  await db
    .prepare(`UPDATE deals SET ${setClauses} WHERE id = ?`)
    .bind(...values)
    .run();

  return getDealById(db, id);
}

/**
 * Delete deal rows older than `olderThanDays` days.
 *
 * Uses a bound parameter for the `datetime` modifier so the days value is never
 * interpolated into the SQL text.
 *
 * Returns the count of deleted rows (`meta.changes`).
 */
export async function pruneDeals(
  db: D1Database,
  olderThanDays: number,
): Promise<number> {
  const modifier = `-${olderThanDays} days`;
  const res = await db
    .prepare(
      `DELETE FROM deals WHERE found_at < datetime('now', ?)`,
    )
    .bind(modifier)
    .run();

  return res.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Cache search helpers (Phase 3 — /api/resolve)
// ---------------------------------------------------------------------------

/**
 * Search cached expansions by name or code (case-insensitive partial match).
 * Returns up to 50 results ordered by name.
 */
export async function searchExpansions(
  db: D1Database,
  q: string,
): Promise<ExpansionRow[]> {
  const like = `%${q}%`;
  const { results } = await db
    .prepare(
      `SELECT id, game_id, code, name
         FROM expansions
        WHERE name LIKE ? OR code LIKE ?
        ORDER BY name
        LIMIT 50`,
    )
    .bind(like, like)
    .all<ExpansionRow>();

  return results;
}

/**
 * Search cached blueprints within a specific expansion by name
 * (case-insensitive partial match).
 * Returns up to 50 results ordered by name.
 */
export async function searchBlueprints(
  db: D1Database,
  expansionId: number,
  q: string,
): Promise<BlueprintRow[]> {
  const like = `%${q}%`;
  const { results } = await db
    .prepare(
      `SELECT id, expansion_id, name, image_url
         FROM blueprints
        WHERE expansion_id = ? AND name LIKE ?
        ORDER BY name
        LIMIT 50`,
    )
    .bind(expansionId, like)
    .all<BlueprintRow>();

  return results;
}
