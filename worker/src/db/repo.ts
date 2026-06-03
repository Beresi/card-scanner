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

import { normalizeCardName } from '../scan/cardName';
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
              min_discount_pct,
              min_gap_pct,
              importance,
              telegram_enabled,
              telegram_min_discount_pct,
              telegram_max_price_cents,
              telegram_min_savings_cents,
              active,
              created_at,
              updated_at,
              detection_mode,
              max_price_cents,
              card_name_norm,
              expansion_filter
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
         second_cheapest_cents,
         gap_pct,
         avg4_cents,
         cohort_size,
         discount_pct,
         priority,
         buy_url,
         found_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?,
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
      deal.second_cheapest_cents,
      deal.gap_pct,
      deal.avg4_cents,
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

/**
 * Re-validate the open deals for one freshly-scanned blueprint and retire any
 * that are no longer the active candidate (deal lifecycle, migration 0009).
 *
 * Inputs for a blueprint we just fetched listings for:
 *  - presentProductIds  = every product_id currently listed (the cheapest-25).
 *  - candidateProductId = the product_id of the deal the engine flagged this run,
 *                         or null when no deal qualifies now.
 *
 * Transitions (only touch status='open', dismissed=0 rows — never user-dismissed):
 *  - product_id NOT present                → 'sold'    (listing gone).
 *  - present but product_id != candidate   → 'expired' (superseded / failed a gate,
 *                                             e.g. the new gap gate).
 *  - product_id == candidate               → stays 'open'.
 *  - candidate previously 'expired'        → reopened (it qualifies again).
 *
 * 'sold' rows are never reopened (a gone listing is gone); 'dismissed' is a user
 * action and is left alone. retired_at is stamped when a row leaves 'open'.
 * Runs as one ordered D1 batch (transactional): sold → reopen → expire.
 */
export async function revalidateBlueprintDeals(
  db: D1Database,
  blueprintId: number,
  presentProductIds: number[],
  candidateProductId: number | null,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  // 1. SOLD — open deals whose listing is gone from the marketplace.
  if (presentProductIds.length === 0) {
    stmts.push(
      db.prepare(
        `UPDATE deals SET status='sold', retired_at=datetime('now')
          WHERE blueprint_id=? AND status='open' AND dismissed=0`,
      ).bind(blueprintId),
    );
  } else {
    const placeholders = presentProductIds.map(() => '?').join(', ');
    stmts.push(
      db.prepare(
        `UPDATE deals SET status='sold', retired_at=datetime('now')
          WHERE blueprint_id=? AND status='open' AND dismissed=0
            AND product_id NOT IN (${placeholders})`,
      ).bind(blueprintId, ...presentProductIds),
    );
  }

  if (candidateProductId !== null) {
    // 2. REOPEN — the current candidate had been retired as 'expired' but now
    //    qualifies again (its earlier-cheaper competitor sold).
    stmts.push(
      db.prepare(
        `UPDATE deals SET status='open', retired_at=NULL
          WHERE blueprint_id=? AND product_id=? AND status='expired'`,
      ).bind(blueprintId, candidateProductId),
    );
    // 3. EXPIRED — still-present open deals that are not the current candidate.
    stmts.push(
      db.prepare(
        `UPDATE deals SET status='expired', retired_at=datetime('now')
          WHERE blueprint_id=? AND status='open' AND dismissed=0
            AND product_id != ?`,
      ).bind(blueprintId, candidateProductId),
    );
  } else {
    // No qualifying candidate now → expire every remaining present open deal.
    stmts.push(
      db.prepare(
        `UPDATE deals SET status='expired', retired_at=datetime('now')
          WHERE blueprint_id=? AND status='open' AND dismissed=0`,
      ).bind(blueprintId),
    );
  }

  await db.batch(stmts);
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
  'default_discount_pct',
  'default_min_condition',
  'cohort_size',
  'min_cohort',
  'default_min_gap_pct',
  'currency',
  'min_price_cents',
  'min_savings_cents',
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
  // Scan mode (migration 0003)
  'scan_mode',
  'scan_batch_size',
  // Chunked cycle tracking (migration 0004)
  'scan_cycle_started_at',
  // Detection-mode defaults + catalog controls (migration 0005)
  'default_detection_mode',
  'default_max_price_cents',
  'catalog_sync_enabled',
  'catalog_max_exports_per_run',
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
  'min_discount_pct',
  'min_gap_pct',
  'importance',
  'telegram_enabled',
  'telegram_min_discount_pct',
  'telegram_max_price_cents',
  'telegram_min_savings_cents',
  'active',
  // §9a nullable overrides (migration 0005)
  'detection_mode',
  'max_price_cents',
  // card-type set filter (migration 0005); card_name_norm is NOT patchable post-create
  'expansion_filter',
]);

/**
 * The §9a override columns that `:id/reset` is permitted to null out.
 * These are columns that have a config fallback — NULLing them means "inherit".
 *
 * Excluded:
 * - `telegram_max_price_cents` and `telegram_min_savings_cents`: no config
 *   fallback; NULL means "no cap / no floor", not "inherit".
 * - `expansion_filter` and `card_name_norm`: not §9a inheritance; card identity
 *   columns that shouldn't be wiped via reset.
 * - `allow_graded`: NOT NULL, no UI reset offered.
 */
const WATCHLIST_RESETTABLE_COLS = new Set<string>([
  'min_discount_pct',
  'min_gap_pct',
  'telegram_min_discount_pct',
  // §9a nullable overrides with config fallback (migration 0005)
  'detection_mode',
  'max_price_cents',
  // §9a nullable overrides with config fallback (migration 0006)
  'min_condition',
  'foil_pref',
  'importance',
  'telegram_enabled',
]);

/**
 * Derived (non-stored) column for the watchlist read paths.
 *
 * A `type='card'` row watches a card by name across every printing and carries
 * NO CardTrader blueprint id (`cardtrader_id` is NULL). To build a working
 * "View on CardTrader" link we need *some* blueprint id for that name — any
 * printing works, because the public `/cards/{id}/versions` page lists them all.
 * We pick the most-recent printing in the local catalog (highest id) whose
 * normalized name matches. For non-card rows `card_name_norm` is NULL, so the
 * subquery matches nothing and yields NULL (harmless). Returns NULL too when the
 * card's set hasn't been synced into the catalog yet — the client then falls
 * back to a name search.
 */
const REPR_BLUEPRINT_ID_SUBQUERY = `(
  SELECT b.id FROM blueprints b
   WHERE b.name_norm = watchlist.card_name_norm
   ORDER BY b.id DESC LIMIT 1
) AS repr_blueprint_id`;

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
              foil_pref, allow_graded, min_discount_pct, min_gap_pct, importance,
              telegram_enabled, telegram_min_discount_pct,
              telegram_max_price_cents, telegram_min_savings_cents,
              active, created_at, updated_at,
              detection_mode, max_price_cents,
              card_name_norm, expansion_filter,
              ${REPR_BLUEPRINT_ID_SUBQUERY}
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
              foil_pref, allow_graded, min_discount_pct, min_gap_pct, importance,
              telegram_enabled, telegram_min_discount_pct,
              telegram_max_price_cents, telegram_min_savings_cents,
              active, created_at, updated_at,
              detection_mode, max_price_cents,
              card_name_norm, expansion_filter,
              ${REPR_BLUEPRINT_ID_SUBQUERY}
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
    ['label', row.label],
  ];

  // cardtrader_id is nullable — blueprint/expansion rows pass a number; card rows
  // pass null (or omit it). Always bind when present to avoid ambiguity.
  if (row.cardtrader_id !== undefined)     { colVals.push(['cardtrader_id', row.cardtrader_id]); }
  // card_name_norm — required for type='card'; omitted for blueprint/expansion.
  if (row.card_name_norm !== undefined)    { colVals.push(['card_name_norm', row.card_name_norm]); }

  if (row.game_id !== undefined)           { colVals.push(['game_id', row.game_id]); }
  if (row.min_condition !== undefined)     { colVals.push(['min_condition', row.min_condition]); }
  if (row.foil_pref !== undefined)         { colVals.push(['foil_pref', row.foil_pref]); }
  if (row.allow_graded !== undefined)      { colVals.push(['allow_graded', row.allow_graded]); }
  if (row.importance !== undefined)        { colVals.push(['importance', row.importance]); }
  if (row.telegram_enabled !== undefined)  { colVals.push(['telegram_enabled', row.telegram_enabled]); }
  if (row.active !== undefined)            { colVals.push(['active', row.active]); }
  // §9a nullable overrides — only bind when callers explicitly supply them
  // (routes should leave these absent so new items are born inheriting)
  if (row.min_discount_pct !== undefined)              { colVals.push(['min_discount_pct', row.min_discount_pct]); }
  if (row.min_gap_pct !== undefined)                   { colVals.push(['min_gap_pct', row.min_gap_pct]); }
  if (row.telegram_min_discount_pct !== undefined)  { colVals.push(['telegram_min_discount_pct', row.telegram_min_discount_pct]); }
  if (row.telegram_max_price_cents !== undefined)   { colVals.push(['telegram_max_price_cents', row.telegram_max_price_cents]); }
  if (row.telegram_min_savings_cents !== undefined) { colVals.push(['telegram_min_savings_cents', row.telegram_min_savings_cents]); }
  // §9a nullable overrides (migration 0005) — born inheriting when absent
  if (row.detection_mode !== undefined)    { colVals.push(['detection_mode', row.detection_mode]); }
  if (row.max_price_cents !== undefined)   { colVals.push(['max_price_cents', row.max_price_cents]); }
  // Card-type expansion filter (migration 0005) — JSON int array; NULL/[] = all sets
  if (row.expansion_filter !== undefined)  { colVals.push(['expansion_filter', row.expansion_filter]); }

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
 * Only resettable §9a override columns (those with a config fallback) may be reset.
 * Any other field
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
 * Hours an EXPIRED deal lingers in the default "open" feed (measured from
 * retired_at) before it auto-hides. Gives the owner a window to see a superseded
 * deal — and dismiss it manually — instead of it vanishing silently. 'sold' deals
 * (listing gone, unbuyable) are NOT granted this grace; they drop out immediately.
 */
const EXPIRED_GRACE_HOURS = 12;

/**
 * List deal rows with optional filters.
 *
 * Filters:
 *  - `status`: `'open'` (default) or `'all'` (no filter).
 *      'open' = active deals PLUS expired deals still inside the
 *      EXPIRED_GRACE_HOURS window; always excludes dismissed and sold.
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

  // Default to 'open': active deals + expired deals still inside the grace window
  // (so superseded deals stay visible briefly before auto-hiding). 'sold' deals and
  // dismissed deals are always hidden from the open feed. 'all' skips this gate.
  if ((f.status ?? 'open') === 'open') {
    sql += ` AND dismissed = 0 AND (
      status = 'open'
      OR (status = 'expired' AND retired_at >= datetime('now', ?))
    )`;
    binds.push(`-${EXPIRED_GRACE_HOURS} hours`);
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
// Cache sync helpers (Phase 4 — /api/resolve fetch+cache)
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of expansion rows from the CardTrader /expansions feed.
 *
 * Uses `INSERT … ON CONFLICT(id) DO UPDATE SET …, synced_at=datetime('now')` so
 * re-syncing is idempotent.  All statements are sent as a single `db.batch` call.
 *
 * Returns the count of rows in the batch (not the number actually changed — D1
 * `meta.changes` on an update-in-place is typically 0, which is fine; the rows
 * are still refreshed).
 */
export async function syncExpansions(
  db: D1Database,
  rows: { id: number; game_id: number; code: string; name: string }[],
): Promise<number> {
  if (rows.length === 0) { return 0; }

  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO expansions (id, game_id, code, name, synced_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           game_id   = excluded.game_id,
           code      = excluded.code,
           name      = excluded.name,
           synced_at = datetime('now')`,
      )
      .bind(r.id, r.game_id, r.code, r.name),
  );

  await db.batch(stmts);
  return rows.length;
}

/** Chunk size for blueprint batch operations. */
const BLUEPRINT_CHUNK_SIZE = 200;

/**
 * Upsert a batch of blueprint rows from the CardTrader /blueprints/export feed.
 *
 * Large sets can have thousands of entries; this function splits the rows into
 * chunks of `BLUEPRINT_CHUNK_SIZE` and fires each chunk as its own `db.batch`
 * call to stay within D1's per-request statement limit.
 *
 * Returns the total count of rows processed (not the change count).
 */
export async function syncBlueprints(
  db: D1Database,
  rows: { id: number; expansion_id: number; name: string; scryfall_id: string | null; image_url: string | null }[],
): Promise<number> {
  if (rows.length === 0) { return 0; }

  for (let offset = 0; offset < rows.length; offset += BLUEPRINT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + BLUEPRINT_CHUNK_SIZE);
    const stmts = chunk.map((r) =>
      db
        .prepare(
          `INSERT INTO blueprints (id, expansion_id, name, name_norm, scryfall_id, image_url, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             expansion_id = excluded.expansion_id,
             name         = excluded.name,
             name_norm    = excluded.name_norm,
             scryfall_id  = excluded.scryfall_id,
             image_url    = excluded.image_url,
             synced_at    = datetime('now')`,
        )
        .bind(r.id, r.expansion_id, r.name, normalizeCardName(r.name), r.scryfall_id, r.image_url),
    );
    await db.batch(stmts);
  }

  return rows.length;
}

/**
 * Return the count of rows in the `expansions` cache table.
 * A count of 0 means the cache has never been populated.
 */
export async function countExpansions(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM expansions`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Return the count of blueprint rows cached for the given expansion id.
 * A count of 0 means the cache for this expansion has not been populated yet.
 */
export async function countBlueprintsForExpansion(
  db: D1Database,
  expansionId: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM blueprints WHERE expansion_id = ?`)
    .bind(expansionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Return true if the expansions cache is empty OR the most-recently synced row
 * is older than `maxAgeDays` days.
 *
 * The staleness check is intentionally simple: we query the newest `synced_at`
 * value in the table.  If the table is empty that query returns null, which we
 * treat as stale.
 */
export async function expansionsStale(
  db: D1Database,
  maxAgeDays: number,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT MAX(synced_at) AS newest FROM expansions`)
    .first<{ newest: string | null }>();

  if (!row || row.newest === null) { return true; }

  // newest is an ISO-ish UTC string (datetime('now') in SQLite: "YYYY-MM-DD HH:MM:SS").
  const ageMs = Date.now() - new Date(row.newest + 'Z').getTime();
  const ageDays = ageMs / 86_400_000;
  return ageDays >= maxAgeDays;
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
      `SELECT id, expansion_id, name, name_norm, image_url, last_scanned_at
         FROM blueprints
        WHERE expansion_id = ? AND name LIKE ?
        ORDER BY name
        LIMIT 50`,
    )
    .bind(expansionId, like)
    .all<BlueprintRow>();

  return results;
}

// ---------------------------------------------------------------------------
// Chunked-scan rotation helpers (migration 0003)
// ---------------------------------------------------------------------------

/**
 * Select the next batch of blueprints to scan from the given expansion ids,
 * ordered by rotation cursor (never scanned first, then oldest-scanned first).
 *
 * The rotation order is:
 *   1. NULL last_scanned_at first (never scanned) — SQLite sorts NULLs LAST on
 *      ASC by default, so we flip with `(last_scanned_at IS NULL) DESC`.
 *   2. Oldest last_scanned_at ASC.
 *   3. Tie-break by id ASC for stability.
 *
 * Bound placeholders are used for ALL values — no string interpolation.
 * The IN-list size scales with the number of active expansion IDs passed in.
 *
 * Returns up to `limit` rows; the caller should cap `limit` to the remaining
 * budget after blueprint-type items have been scanned.
 */
export async function selectBlueprintsToScan(
  db: D1Database,
  expansionIds: number[],
  limit: number,
): Promise<{ id: number; expansion_id: number }[]> {
  if (expansionIds.length === 0 || limit <= 0) { return []; }

  const placeholders = expansionIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT id, expansion_id
         FROM blueprints
        WHERE expansion_id IN (${placeholders})
        ORDER BY (last_scanned_at IS NULL) DESC,
                 last_scanned_at ASC,
                 id ASC
        LIMIT ?`,
    )
    .bind(...expansionIds, limit)
    .all<{ id: number; expansion_id: number }>();

  return results;
}

/** Chunk size for markBlueprintsScanned batch operations. */
const MARK_SCANNED_CHUNK_SIZE = 100;

/**
 * Advance the rotation cursor for a batch of blueprints.
 *
 * Sets `last_scanned_at = datetime('now')` for every id in the list.
 * Chunked into groups of `MARK_SCANNED_CHUNK_SIZE` to stay within D1's
 * per-request statement limit.
 *
 * This is called AFTER each scan attempt (success or no-deal) so the rotation
 * advances even when a blueprint produces no deal.  A fetch ERROR does NOT
 * prevent marking — forward progress is more important than retrying one bad
 * blueprint on the next run (callers may choose to skip marking on error;
 * the scanner marks on attempt for simplicity).
 */
export async function markBlueprintsScanned(
  db: D1Database,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) { return; }

  for (let offset = 0; offset < ids.length; offset += MARK_SCANNED_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + MARK_SCANNED_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    await db
      .prepare(
        `UPDATE blueprints
            SET last_scanned_at = datetime('now')
          WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .run();
  }
}

/**
 * Return the `finished_at` timestamp of the most recent FINISHED scan run.
 *
 * Returns null when:
 *  - No scans have ever run.
 *  - No scan has finished yet (all rows have `finished_at IS NULL`).
 *
 * Used by the wholeset self-throttle: if the last finished scan was less than
 * ~55 minutes ago AND the trigger is 'cron', the run is skipped.
 */
export async function getLatestFinishedScanAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT finished_at
         FROM scan_runs
        WHERE finished_at IS NOT NULL
        ORDER BY id DESC
        LIMIT 1`,
    )
    .first<{ finished_at: string }>();

  return row?.finished_at ?? null;
}

// ---------------------------------------------------------------------------
// Chunked scan cycle progress helpers (migration 0004)
// ---------------------------------------------------------------------------

/**
 * Count all blueprints belonging to the given expansion ids.
 *
 * Returns Y — the total number of watched expansion blueprints in the cache.
 * Empty `expansionIds` → returns 0 immediately (no DB call needed).
 */
export async function countActiveExpansionBlueprints(
  db: D1Database,
  expansionIds: number[],
): Promise<number> {
  if (expansionIds.length === 0) { return 0; }

  const placeholders = expansionIds.map(() => '?').join(', ');
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM blueprints
        WHERE expansion_id IN (${placeholders})`,
    )
    .bind(...expansionIds)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

/**
 * Count blueprints belonging to the given expansion ids that have been scanned
 * since the cycle started (i.e. `last_scanned_at >= cycleStart`).
 *
 * Returns X — the number of blueprints completed in the current sweep.
 * Empty `expansionIds` → returns 0 immediately (no DB call needed).
 *
 * `cycleStart` must be a UTC datetime string in the format produced by
 * `datetime('now')` in SQLite: "YYYY-MM-DD HH:MM:SS".
 */
export async function countScannedThisCycle(
  db: D1Database,
  expansionIds: number[],
  cycleStart: string,
): Promise<number> {
  if (expansionIds.length === 0) { return 0; }

  const placeholders = expansionIds.map(() => '?').join(', ');
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM blueprints
        WHERE expansion_id IN (${placeholders})
          AND last_scanned_at IS NOT NULL
          AND last_scanned_at >= ?`,
    )
    .bind(...expansionIds, cycleStart)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Card-name catalog search (migration 0005)
// ---------------------------------------------------------------------------

/**
 * Resolve blueprint ids for a card by its normalised name, optionally scoped
 * to a subset of expansion ids.
 *
 * Cache-only read — never calls CardTrader.  Matches `blueprints.name_norm = ?`;
 * when `expansionIds` is a non-empty array also adds `AND expansion_id IN (...)`.
 * Null or empty `expansionIds` = all sets (no IN filter).
 *
 * Returns `{ id, expansion_id }` pairs — the minimum the scanner needs to wire
 * each resolved blueprint back to its card WatchlistRow.
 *
 * Bound-placeholder generation is safe: the IN-list is built from `Array.length`
 * repetitions of `?`, never string-interpolated user values.
 */
export async function resolveCardBlueprints(
  db: D1Database,
  nameNorm: string,
  expansionIds: number[] | null,
): Promise<{ id: number; expansion_id: number }[]> {
  const filtered = expansionIds && expansionIds.length > 0;

  let sql = `SELECT id, expansion_id FROM blueprints WHERE name_norm = ?`;
  const binds: unknown[] = [nameNorm];

  if (filtered) {
    const placeholders = (expansionIds as number[]).map(() => '?').join(', ');
    sql += ` AND expansion_id IN (${placeholders})`;
    binds.push(...(expansionIds as number[]));
  }

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ id: number; expansion_id: number }>();

  return results;
}

// ---------------------------------------------------------------------------
// Chunked scan by explicit id set (migration 0005 — card type)
// ---------------------------------------------------------------------------

/**
 * Select the next batch of blueprints to scan from an explicit set of blueprint
 * ids (used for card-type watchlist items that resolve to many printings).
 *
 * Same rotation order as `selectBlueprintsToScan`:
 *   1. Never-scanned first (NULL last_scanned_at).
 *   2. Oldest-scanned first (last_scanned_at ASC).
 *   3. Tie-break by id ASC.
 *
 * Returns `[]` immediately when `ids` is empty or `limit` is zero — the IN-list
 * guard prevents a bare `WHERE id IN ()` which is invalid in SQLite.
 */
export async function selectBlueprintsToScanByIds(
  db: D1Database,
  ids: number[],
  limit: number,
): Promise<{ id: number; expansion_id: number }[]> {
  if (ids.length === 0 || limit <= 0) { return []; }

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT id, expansion_id
         FROM blueprints
        WHERE id IN (${placeholders})
        ORDER BY (last_scanned_at IS NULL) DESC,
                 last_scanned_at ASC,
                 id ASC
        LIMIT ?`,
    )
    .bind(...ids, limit)
    .all<{ id: number; expansion_id: number }>();

  return results;
}

// ---------------------------------------------------------------------------
// Catalog-sync helpers (migration 0005)
// ---------------------------------------------------------------------------

/**
 * Return the ids of the next `limit` MTG expansions that have not yet had their
 * blueprint catalog exported (i.e. `blueprints_synced_at IS NULL`).
 *
 * Only considers game_id = 1 (Magic: The Gathering).  Results are ordered by
 * `id DESC` (newest expansions first) so current/recent sets — the ones the
 * owner is most likely to be watching and adding to the cart — get card data
 * (images, set, stock) first. Older sets backfill afterward.
 *
 * Returns an empty array when all expansions are synced or the table is empty.
 */
export async function selectNextCatalogExpansions(
  db: D1Database,
  limit: number,
): Promise<number[]> {
  if (limit <= 0) { return []; }

  const { results } = await db
    .prepare(
      `SELECT id
         FROM expansions
        WHERE game_id = 1
          AND blueprints_synced_at IS NULL
        ORDER BY id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number }>();

  return results.map((r) => r.id);
}

/**
 * Mark a single expansion as catalog-synced.
 *
 * Sets `blueprints_synced_at = datetime('now')` for the given expansion id.
 * Called by the scanner after a successful `blueprintsExport` + `syncBlueprints`
 * call so the id is no longer returned by `selectNextCatalogExpansions`.
 */
export async function markExpansionCatalogSynced(
  db: D1Database,
  expansionId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE expansions
          SET blueprints_synced_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(expansionId)
    .run();
}

/**
 * Count catalog-sync progress for MTG expansions (game_id = 1).
 *
 * Returns:
 *  - `total`: all MTG expansions in the local cache.
 *  - `synced`: those that have `blueprints_synced_at IS NOT NULL`.
 *
 * Used by `GET /api/resolve/catalog-progress` and the health telemetry.
 */
export async function countCatalogProgress(
  db: D1Database,
): Promise<{ total: number; synced: number }> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(blueprints_synced_at) AS synced
         FROM expansions
        WHERE game_id = 1`,
    )
    .first<{ total: number; synced: number }>();

  return { total: row?.total ?? 0, synced: row?.synced ?? 0 };
}

// ---------------------------------------------------------------------------
// Health telemetry — card-type blueprint count (Task 2 / scan_total fix)
// ---------------------------------------------------------------------------

/**
 * Count distinct blueprints that will be scanned for active card-type watchlist
 * items, excluding any blueprint already owned by an active expansion item.
 *
 * This is the card-type contribution to `scan_total` on GET /api/health.
 * Expansion-derived blueprints are excluded via `NOT IN (...)` so the two
 * counts can be summed without double-counting.
 *
 * Algorithm (mirrors the scanner's resolveCardBlueprints logic):
 *   1. For each active card-type row, resolve matching blueprints by name_norm
 *      (+ optional expansion_filter JSON int array).
 *   2. Collect blueprint ids into a Set (deduplication across card items).
 *   3. Subtract ids that belong to active expansion items (already counted).
 *
 * Returns 0 immediately when there are no active card-type items or the
 * blueprint catalog is empty for those names.
 *
 * NOTE: `excludeExpansionIds` is the list of expansion_ids owned by active
 * expansion-type watchlist items (from `countActiveExpansionBlueprints`'s
 * caller).  Blueprints whose `expansion_id` is in this set are already
 * counted there, so we skip them here.
 */
export async function countActiveCardBlueprints(
  db: D1Database,
  cardItems: { card_name_norm: string | null; expansion_filter: string | null }[],
  excludeExpansionIds: number[],
): Promise<number> {
  const activeCardItems = cardItems.filter((c) => c.card_name_norm !== null);
  if (activeCardItems.length === 0) { return 0; }

  const collectedIds = new Set<number>();

  for (const item of activeCardItems) {
    const nameNorm = item.card_name_norm as string;

    // Parse the expansion_filter JSON int array (same logic as the scanner).
    let filterIds: number[] | null = null;
    if (item.expansion_filter !== null) {
      try {
        const parsed = JSON.parse(item.expansion_filter) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          filterIds = parsed as number[];
        }
      } catch {
        // Malformed JSON — treat as no filter (all sets).
      }
    }

    let sql = `SELECT id, expansion_id FROM blueprints WHERE name_norm = ?`;
    const binds: unknown[] = [nameNorm];

    if (filterIds !== null && filterIds.length > 0) {
      const placeholders = filterIds.map(() => '?').join(', ');
      sql += ` AND expansion_id IN (${placeholders})`;
      binds.push(...filterIds);
    }

    const { results } = await db
      .prepare(sql)
      .bind(...binds)
      .all<{ id: number; expansion_id: number }>();

    for (const row of results) {
      // Skip blueprints already owned by an active expansion item.
      if (excludeExpansionIds.length === 0 || !excludeExpansionIds.includes(row.expansion_id)) {
        collectedIds.add(row.id);
      }
    }
  }

  return collectedIds.size;
}

/**
 * Count the number of active watchlist rows (active = 1).
 *
 * Used by GET /api/health to distinguish "nothing watched (idle)" from
 * "cache warming" (active items exist but no blueprints resolved yet).
 */
export async function countActiveWatchlist(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM watchlist WHERE active = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Cart enrichment (GET /api/cart)
// ---------------------------------------------------------------------------

/**
 * Meta attached to each cart line item by the GET /api/cart route.
 *
 * source='deal'  — resolved via the deals table (product_id lookup).
 * source='name'  — resolved via blueprints.name_norm fallback.
 * Omitted entirely when neither lookup hits.
 *
 * `foil` mirrors deals.foil (0/1 integer, never a boolean on the wire).
 * `available_quantity` is the listing stock captured at scan time (deals.quantity).
 * `image_url` / `expansion_name` may be null when the DB row has no value.
 *
 * This interface is the single definition — cart.ts re-exports it to the route
 * and the desktop DTO contract must match it exactly.
 */
export interface CartItemMeta {
  source: 'deal' | 'name';
  blueprint_id?: number;
  image_url?: string | null;
  expansion_name?: string | null;
  condition?: string | null;
  language?: string | null;
  foil?: 0 | 1 | null;          // from deals.foil (integer — not converted to boolean)
  available_quantity?: number | null;  // from deals.quantity (listing stock at scan time)
}

/**
 * A single candidate printing for a name-sourced cart item. The same card name
 * (name_norm) can have many printings (base set, collectors, promos, borderless,
 * …), each a different blueprint_id. The route probes these against the live
 * marketplace to discover which printing actually contains the cart's product.id.
 */
export interface CartCandidatePrinting {
  blueprint_id: number;
  image_url: string | null;
  expansion_name: string | null;
}

/**
 * Maximum candidate printings returned per name-sourced cart item. Bounds the
 * marketplace-probe budget so one many-printing card can't dominate the cart's
 * global lookup cap (see cart.ts MAX_CART_STOCK_LOOKUPS).
 */
export const MAX_CART_CANDIDATE_PRINTINGS = 6;

/**
 * Return shape of getCartEnrichment.
 *  - `meta`: Map<productId, CartItemMeta> — best-guess display metadata so every
 *    matched item shows SOMETHING (deal-sourced is authoritative; name-sourced
 *    uses the first candidate printing as the best guess).
 *  - `candidates`: Map<productId, CartCandidatePrinting[]> — ALL candidate
 *    printings for each name-sourced item, capped, for the route to probe the
 *    live marketplace and resolve the EXACT printing. Deal-sourced items have no
 *    entry here (their data is authoritative — no probing needed).
 */
export interface CartEnrichmentResult {
  meta: Map<number, CartItemMeta>;
  candidates: Map<number, CartCandidatePrinting[]>;
}

/**
 * Enrich a batch of cart line items with display metadata from D1.
 *
 * Algorithm (per item, in priority order):
 *  1. PRIMARY — look up product.id in `deals` (UNIQUE key).  If found, return
 *     source:'deal' with deal columns + image_url from blueprints.
 *  2. FALLBACK — normalise product.name_en with `normalizeCardName` and gather
 *     ALL candidate printings (`blueprints JOIN expansions WHERE name_norm IN`).
 *     The FIRST candidate (id DESC → newest printing first) becomes the
 *     source:'name' best-guess meta so the card still shows an image/set; the
 *     full capped candidate list is returned separately for the route to probe
 *     the live marketplace and resolve the EXACT printing.
 *  3. Neither resolves → item absent from both Maps (no meta attached).
 *
 * Queries are batched (IN-lists), not issued N+1 per item.
 * Best-effort: callers wrap this in try/catch; a DB error returns empty Maps
 * so the cart still loads without meta.
 *
 * Returns a CartEnrichmentResult: { meta, candidates } both keyed by product.id.
 */
export async function getCartEnrichment(
  db: D1Database,
  items: { productId: number; nameEn: string }[],
): Promise<CartEnrichmentResult> {
  if (items.length === 0) { return { meta: new Map(), candidates: new Map() }; }

  const result = new Map<number, CartItemMeta>();
  const candidates = new Map<number, CartCandidatePrinting[]>();

  // ── Step 1: batch-lookup all product_ids in `deals` ─────────────────────
  const productIds = items.map((i) => i.productId);
  const placeholders1 = productIds.map(() => '?').join(', ');
  const { results: dealRows } = await db
    .prepare(
      `SELECT product_id, blueprint_id, expansion_name, condition, language, foil, quantity
         FROM deals
        WHERE product_id IN (${placeholders1})`,
    )
    .bind(...productIds)
    .all<{
      product_id: number;
      blueprint_id: number;
      expansion_name: string | null;
      condition: string | null;
      language: string | null;
      foil: 0 | 1 | null;
      quantity: number | null;
    }>();

  // Collect the blueprint_ids we need to fetch image_urls for (deal path).
  const dealBlueprintIds = [...new Set(dealRows.map((d) => d.blueprint_id))];
  const blueprintImageMap = new Map<number, string | null>();

  if (dealBlueprintIds.length > 0) {
    const placeholdersBp = dealBlueprintIds.map(() => '?').join(', ');
    const { results: bpRows } = await db
      .prepare(
        `SELECT id, image_url FROM blueprints WHERE id IN (${placeholdersBp})`,
      )
      .bind(...dealBlueprintIds)
      .all<{ id: number; image_url: string | null }>();

    for (const row of bpRows) {
      blueprintImageMap.set(row.id, row.image_url);
    }
  }

  // Build a Set of product_ids that resolved via the deal path so the name
  // fallback skips them.
  const resolvedViaDeals = new Set<number>();

  for (const deal of dealRows) {
    resolvedViaDeals.add(deal.product_id);
    result.set(deal.product_id, {
      source: 'deal',
      blueprint_id: deal.blueprint_id,
      image_url: blueprintImageMap.get(deal.blueprint_id) ?? null,
      expansion_name: deal.expansion_name,
      condition: deal.condition,
      language: deal.language,
      foil: deal.foil,
      available_quantity: deal.quantity,
    });
  }

  // ── Step 2: name fallback for items not resolved via deals ───────────────
  const unresolved = items.filter((i) => !resolvedViaDeals.has(i.productId));
  if (unresolved.length === 0) { return { meta: result, candidates }; }

  // Normalise each distinct name and deduplicate.
  const normToProductIds = new Map<string, number[]>();
  for (const item of unresolved) {
    const norm = normalizeCardName(item.nameEn);
    if (!norm) { continue; }
    const existing = normToProductIds.get(norm);
    if (existing) {
      existing.push(item.productId);
    } else {
      normToProductIds.set(norm, [item.productId]);
    }
  }

  if (normToProductIds.size === 0) { return { meta: result, candidates }; }

  const distinctNorms = [...normToProductIds.keys()];
  const placeholdersN = distinctNorms.map(() => '?').join(', ');

  // One query for ALL distinct normalised names: retrieve every matching
  // blueprint (a name can have many printings), newest printing first so the
  // best-guess prefers recent reprints. We group by name_norm in JS and cap the
  // candidate list per name; the distinct-norms list is small for a cart.
  const { results: bpNameRows } = await db
    .prepare(
      `SELECT b.id AS blueprint_id, b.name_norm, b.image_url,
              e.name AS expansion_name
         FROM blueprints b
         LEFT JOIN expansions e ON e.id = b.expansion_id
        WHERE b.name_norm IN (${placeholdersN})
        ORDER BY b.id DESC`,
    )
    .bind(...distinctNorms)
    .all<{
      blueprint_id: number;
      name_norm: string;
      image_url: string | null;
      expansion_name: string | null;
    }>();

  // Build a Map<name_norm, capped candidate printings[]> (ordered id DESC).
  const normToCandidates = new Map<string, CartCandidatePrinting[]>();
  for (const row of bpNameRows) {
    const list = normToCandidates.get(row.name_norm);
    const candidate: CartCandidatePrinting = {
      blueprint_id: row.blueprint_id,
      image_url: row.image_url,
      expansion_name: row.expansion_name,
    };
    if (list) {
      if (list.length < MAX_CART_CANDIDATE_PRINTINGS) { list.push(candidate); }
    } else {
      normToCandidates.set(row.name_norm, [candidate]);
    }
  }

  // Attach best-guess meta (first candidate) + the full candidate list to each
  // unresolved product_id.
  for (const [norm, productIdsForNorm] of normToProductIds.entries()) {
    const list = normToCandidates.get(norm);
    if (!list || list.length === 0) { continue; }
    const best = list[0]!;
    for (const pid of productIdsForNorm) {
      result.set(pid, {
        source: 'name',
        blueprint_id: best.blueprint_id,
        image_url: best.image_url,
        expansion_name: best.expansion_name,
      });
      candidates.set(pid, list);
    }
  }

  return { meta: result, candidates };
}
