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

import type { WatchlistRow, ConfigRow, DealInsert, ScanCounts } from './types';

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
