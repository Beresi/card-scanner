/**
 * Scan orchestrator — the single shared entry point for both the cron
 * and POST /api/scan/run-now (PRD §4/§11).
 *
 * Two modes (config.scan_mode):
 *
 *  'chunked'  (default, free-tier safe)
 *    Scans a rotating batch of individual blueprint cards per cron tick.
 *    Each blueprint = one marketplace/products call (~1 req/s throttle).
 *    Budget capped to config.scan_batch_size per run (default 40) to stay
 *    inside the Cloudflare free-tier 50-subrequest limit.
 *    Expansion blueprint caches are warmed on demand (at most 1–2 per run).
 *    The last_scanned_at cursor advances after each attempt so each run
 *    picks up where the previous left off.
 *
 *  'wholeset' (paid-tier fallback)
 *    One marketplaceProducts({expansionId}) call per expansion item — same
 *    logic as Phase 1.  A self-throttle skips cron ticks that arrive within
 *    ~55 minutes of the last finished scan (prevents re-scanning whole sets
 *    every 2 minutes). run-now ALWAYS executes.
 *
 * What this module does NOT do:
 *  - No deal math, no routing math — pure cores handle those.
 *  - No D1 schema, no raw SQL — all persistence is via repo.ts.
 *
 * Money invariant: integer cents throughout; never divide by 100 here.
 * Secrets invariant: NEVER log CARDTRADER_API_TOKEN or any secret.
 *
 * PRD §11; docs/documentation/scanner.md.
 */

import type { Env } from '../index';
import {
  createCardTraderClient,
  buildBuyUrl,
  type CardTraderClient,
  type ClientOptions,
} from '../cardtrader/client';
import { CardTraderError } from '../cardtrader/types';
import { evaluateBlueprint } from './dealEngine';
import {
  openScanRun,
  closeScanRun,
  listActiveWatchlist,
  getConfig,
  patchConfig,
  upsertDeal,
  revalidateBlueprintDeals,
  markTelegramSent,
  countBlueprintsForExpansion,
  syncBlueprints,
  selectBlueprintsToScan,
  selectBlueprintsToScanByIds,
  markBlueprintsScanned,
  getLatestFinishedScanAt,
  countActiveExpansionBlueprints,
  countScannedThisCycle,
  resolveCardBlueprints,
  selectNextCatalogExpansions,
  markExpansionCatalogSynced,
} from '../db/repo';
import { resolveEffective } from '../db/resolve';
import { shouldNotify } from '../telegram/routing';
import { isTelegramConfigured, sendDeals } from '../telegram/notifier';
import type {
  DealInsert,
  EffectiveSettings,
  ScanCounts,
  WatchlistRow,
  ConfigRow,
} from '../db/types';
import type { Product } from '../cardtrader/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScanTrigger = 'cron' | 'run-now';

/** Mirrors the scan_runs row written at the end of a run. */
export interface ScanSummary {
  runId: number;
  watchItemsScanned: number;
  blueprintsScanned: number;
  apiCalls: number;
  dealsFound: number;
  telegramSent: number;
  /** null on a clean run; 'skipped' when the wholeset self-throttle fires. */
  error: string | null;
}

/**
 * Injectable dependencies — used by tests to swap the CardTrader client
 * without a real API token.
 */
export interface ScanDeps {
  createClient?: typeof createCardTraderClient;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum blueprint ids resolved per card-type watchlist item.
 * A popular name (e.g. "Lightning Bolt") may exist in hundreds of sets;
 * cap to keep the rotation budget manageable and prevent one card from
 * consuming the whole scan batch.
 */
const MAX_CARD_BLUEPRINTS_PER_ITEM = 200;

// ---------------------------------------------------------------------------
// runScan — the one entry point both callers use
// ---------------------------------------------------------------------------

/**
 * Run one full scan.
 *
 * Always resolves — never rejects for a scan-level failure. Whole-run errors
 * are recorded in scan_runs.error and reflected in ScanSummary.error; the row
 * is always closed via the finally block.
 */
export async function runScan(
  env: Env,
  opts: { trigger: ScanTrigger },
  deps?: ScanDeps,
): Promise<ScanSummary> {
  const runId = await openScanRun(env.DB);

  let watchItemsScanned = 0;
  let blueprintsScanned = 0;
  let apiCalls = 0;
  let dealsFound = 0;
  let telegramSent = 0;
  let runError: string | null = null;

  const newDeals: { deal: DealInsert; eff: EffectiveSettings }[] = [];

  const clientOpts: ClientOptions = {
    onRequest: () => { apiCalls++; },
  };
  const clientFactory = deps?.createClient ?? createCardTraderClient;
  const client: CardTraderClient = clientFactory(
    env.CARDTRADER_API_TOKEN,
    clientOpts,
  );

  try {
    // Step 1: Validate token — GET /info.
    // 401 → record error, abort; any other /info failure is also a whole-run abort.
    try {
      await client.info();
    } catch (err) {
      if (err instanceof CardTraderError && err.status === 401) {
        runError = 'cardtrader token invalid (401)';
        return buildSummary(
          runId,
          { watchItemsScanned, blueprintsScanned, apiCalls, dealsFound, telegramSent },
          runError,
        );
      }
      throw err;
    }

    // Step 2: Load config + active watchlist.
    const config = await getConfig(env.DB);
    const watchlist = await listActiveWatchlist(env.DB);

    // Step 3: Dispatch to the correct scan mode.
    if (config.scan_mode === 'wholeset') {
      await runWholeset(
        client, watchlist, config, env.DB, opts.trigger,
        {
          onWatchItemScanned: () => { watchItemsScanned++; },
          onBlueprintScanned: () => { blueprintsScanned++; },
          onNewDeal: (deal, eff) => { dealsFound++; newDeals.push({ deal, eff }); },
          onSkip: (msg) => { runError = msg; },
        },
      );
    } else {
      await runChunked(
        client, watchlist, config, env.DB,
        {
          onWatchItemScanned: () => { watchItemsScanned++; },
          onBlueprintScanned: () => { blueprintsScanned++; },
          onNewDeal: (deal, eff) => { dealsFound++; newDeals.push({ deal, eff }); },
        },
      );
    }

    // Step 4: Route new deals to Telegram (PRD §8) — guarded + non-fatal.
    if (isTelegramConfigured(env)) {
      try {
        const passing = newDeals
          .filter(({ deal, eff }) =>
            shouldNotify(
              {
                discount_pct: deal.discount_pct,
                price_cents: deal.price_cents,
                baseline_cents: deal.baseline_cents,
                telegram_sent: false,
              },
              eff,
              undefined,
              null,
            ).send,
          )
          .map(({ deal }) => deal);

        const sent = await sendDeals(passing, env);
        if (sent > 0) {
          for (const deal of passing) {
            await markTelegramSent(env.DB, deal.product_id);
          }
          telegramSent = sent;
        }
      } catch (tgErr) {
        console.error('[scanner] telegram routing/send failed', {
          runId,
          trigger: opts.trigger,
          newDeals: newDeals.length,
          error: tgErr instanceof Error ? tgErr.message : String(tgErr),
        });
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : 'unknown scan failure';
    console.error('[scanner] scan run failed', {
      runId,
      trigger: opts.trigger,
      error: runError,
    });
  } finally {
    const counts: ScanCounts = {
      watch_items_scanned: watchItemsScanned,
      blueprints_scanned: blueprintsScanned,
      api_calls: apiCalls,
      deals_found: dealsFound,
      telegram_sent: telegramSent,
    };
    try {
      await closeScanRun(env.DB, runId, counts, runError);
    } catch (closeErr) {
      console.error('[scanner] failed to close scan_runs row', {
        runId,
        trigger: opts.trigger,
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
    }
  }

  return buildSummary(
    runId,
    { watchItemsScanned, blueprintsScanned, apiCalls, dealsFound, telegramSent },
    runError,
  );
}

// ---------------------------------------------------------------------------
// Wholeset mode (paid-tier fallback)
// ---------------------------------------------------------------------------

/** Minimum minutes between wholeset cron runs. */
const WHOLESET_MIN_INTERVAL_MINUTES = 55;

interface ScanCallbacks {
  onWatchItemScanned: () => void;
  onBlueprintScanned: () => void;
  onNewDeal: (deal: DealInsert, eff: EffectiveSettings) => void;
}

interface WholesetCallbacks extends ScanCallbacks {
  /** Called when the cron self-throttle fires; receives the skip message. */
  onSkip: (msg: string) => void;
}

/**
 * Wholeset scan mode — one big marketplaceProducts({expansionId}) call per
 * expansion item. For blueprint items, one per-blueprint call (unchanged).
 * For card items, resolve to blueprint ids and scan each individually.
 *
 * Self-throttle: if the trigger is 'cron' AND the last finished scan was within
 * WHOLESET_MIN_INTERVAL_MINUTES, skip (log + call onSkip) and return immediately
 * so the 2-min cron doesn't re-scan whole sets every tick. run-now always runs.
 */
async function runWholeset(
  client: CardTraderClient,
  watchlist: WatchlistRow[],
  config: ConfigRow,
  db: D1Database,
  trigger: ScanTrigger,
  callbacks: WholesetCallbacks,
): Promise<void> {
  if (trigger === 'cron') {
    const lastFinished = await getLatestFinishedScanAt(db);
    if (lastFinished !== null) {
      const ageMs = Date.now() - new Date(lastFinished + 'Z').getTime();
      const ageMinutes = ageMs / 60_000;
      if (ageMinutes < WHOLESET_MIN_INTERVAL_MINUTES) {
        const msg = `skipped: wholeset last ran ${Math.round(ageMinutes)}m ago (< ${WHOLESET_MIN_INTERVAL_MINUTES}m)`;
        console.info('[scanner] wholeset self-throttle', { ageMinutes: Math.round(ageMinutes) });
        callbacks.onSkip(msg);
        return;
      }
    }
  }

  for (const item of watchlist) {
    if (item.type === 'card') {
      // Card items: resolve to blueprint ids and scan each individually.
      await runWholesetCardItem(client, item, config, db, callbacks);
      continue;
    }
    try {
      await scanItem(client, item, config, db, callbacks);
    } catch (err) {
      console.error('[scanner] item skipped (wholeset)', {
        watchlistId: item.id,
        watchlistType: item.type,
        cardtraderId: item.cardtrader_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }
}

/**
 * Wholeset helper for a single card-type watchlist item.
 * Resolves the card name to blueprint ids (capped), then scans each via
 * scanBlueprintById. Errors per-blueprint are caught and skipped; the item
 * as a whole is non-fatal.
 */
async function runWholesetCardItem(
  client: CardTraderClient,
  item: WatchlistRow,
  config: ConfigRow,
  db: D1Database,
  callbacks: ScanCallbacks,
): Promise<void> {
  if (!item.card_name_norm) {
    console.error('[scanner] card item missing card_name_norm', { watchlistId: item.id });
    return;
  }

  const expansionIds = parseExpansionFilter(item.expansion_filter);
  let resolved: { id: number; expansion_id: number }[];
  try {
    resolved = await resolveCardBlueprints(db, item.card_name_norm, expansionIds);
  } catch (err) {
    console.error('[scanner] resolveCardBlueprints failed (wholeset card item)', {
      watchlistId: item.id,
      cardNameNorm: item.card_name_norm,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Cap resolved ids so one ubiquitous name can't flood the scan.
  const cappedIds = resolved.slice(0, MAX_CARD_BLUEPRINTS_PER_ITEM).map((r) => r.id);

  for (const bpId of cappedIds) {
    try {
      await scanBlueprintById(bpId, client, item, config, db, callbacks);
    } catch (err) {
      console.error('[scanner] card blueprint skipped (wholeset)', {
        blueprintId: bpId,
        watchlistId: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal; continue to next blueprint.
    }
  }
}

// ---------------------------------------------------------------------------
// Chunked mode (default, free-tier safe)
// ---------------------------------------------------------------------------

/** Max expansion cache warm-up calls per chunked run (blueprintsExport is extra subrequests). */
const MAX_CACHE_WARMUPS_PER_RUN = 2;

/**
 * Per-run wall-clock budget for the chunked rotation loop (ms). Scheduled (cron)
 * invocations have a TIGHTER execution-time limit than a request handler, so a
 * full ~40-card batch (≈40-55s at ~1 req/s) gets killed mid-run on the cron path.
 * Stop the loop well under that limit so each run finishes cleanly.
 */
const CHUNKED_RUN_BUDGET_MS = 20_000;

/**
 * Per-run wall-clock budget for the Step-0 catalog backfill (ms). Catalog sync
 * runs BEFORE the rotation loop and shares the cron's tight execution limit, so
 * it must stop cleanly to leave room for the deal scan. Each export commits
 * independently (markExpansionCatalogSynced), so stopping early just resumes the
 * remaining sets next run — this lets catalog_max_exports_per_run be set high
 * for a fast backfill without risking a killed cron run.
 */
const CATALOG_SYNC_BUDGET_MS = 12_000;

/**
 * Persist rotation progress every N blueprints (not once at the end). If a run
 * is still killed mid-batch, the cursor has already advanced for what it did —
 * so the same cards are never retried forever (no permanent stall).
 */
const MARK_FLUSH_EVERY = 8;

/**
 * Chunked scan mode — rotates through blueprints across all active expansions
 * and card-name items, scanning at most config.scan_batch_size blueprints per run.
 *
 * Algorithm:
 *  0. Catalog-sync background step (gated on config.catalog_sync_enabled): pull
 *     up to catalog_max_exports_per_run unsynced expansions and export their
 *     blueprints into the local catalog.
 *  1. Split watchlist into blueprint / expansion / card items.
 *  2. Warm expansion blueprint caches (at most MAX_CACHE_WARMUPS_PER_RUN calls).
 *  3. Scan blueprint-type items directly (no rotation; few, explicit cards).
 *  4. With remaining budget, rotate expansion + card-derived blueprints via
 *     last_scanned_at cursor under one shared remaining budget.
 *  5. Mark all attempted blueprints scanned so the rotation advances.
 *
 * Owner precedence: when a blueprint belongs to both a watched expansion and a
 * card-name item, the expansion item's settings take precedence (it is more
 * specific — the user explicitly added the full set to their watchlist).
 */
async function runChunked(
  client: CardTraderClient,
  watchlist: WatchlistRow[],
  config: ConfigRow,
  db: D1Database,
  callbacks: ScanCallbacks,
): Promise<void> {
  const budget = config.scan_batch_size;

  const blueprintItems = watchlist.filter((w) => w.type === 'blueprint');
  const expansionItems = watchlist.filter((w) => w.type === 'expansion');
  const cardItems      = watchlist.filter((w) => w.type === 'card');

  // Step 0: Catalog-sync background step — fill the local blueprint catalog so
  // card-name items can resolve to blueprint ids. Gated on config flag.
  // Each blueprintsExport call is tracked through the client onRequest hook, so
  // api_calls is incremented automatically.
  if (config.catalog_sync_enabled === 1 && config.catalog_max_exports_per_run > 0) {
    try {
      const toSync = await selectNextCatalogExpansions(db, config.catalog_max_exports_per_run);
      const catalogStartMs = Date.now();
      for (const expId of toSync) {
        // Stop cleanly once the catalog budget is spent so the deal scan still
        // gets its rotation budget — remaining sets resume next run.
        if (Date.now() - catalogStartMs >= CATALOG_SYNC_BUDGET_MS) { break; }
        try {
          const blueprints = await client.blueprintsExport(expId);
          await syncBlueprints(
            db,
            blueprints.map((bp) => ({
              id: bp.id,
              expansion_id: expId,
              name: bp.name,
              scryfall_id: bp.scryfall_id ?? null,
              image_url: bp.image_url ?? null,
            })),
          );
          await markExpansionCatalogSynced(db, expId);
          console.info('[scanner] catalog sync: exported expansion', {
            expansionId: expId,
            count: blueprints.length,
          });
        } catch (err) {
          // Non-fatal: do NOT mark synced on error so it retries next run.
          console.error('[scanner] catalog sync: export failed (non-fatal)', {
            expansionId: expId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (catalogErr) {
      // selectNextCatalogExpansions failure is non-fatal — never abort the scan.
      console.error('[scanner] catalog sync: selectNextCatalogExpansions failed (non-fatal)', {
        error: catalogErr instanceof Error ? catalogErr.message : String(catalogErr),
      });
    }
  }

  // Cycle management — track "X of Y scanned this sweep".
  // A cycle = one full pass through all watched expansion blueprints.
  // Must run before the rotation so the cycleStart anchor is fresh before we
  // advance last_scanned_at on this batch.
  // Only expansion-derived blueprints are tracked in the cycle (card items
  // contribute to the same cursor but not to the cycle denominator).
  const activeExpansionIds = expansionItems
    .map((w) => w.cardtrader_id)
    .filter((id): id is number => id !== null);

  if (activeExpansionIds.length > 0) {
    try {
      const total = await countActiveExpansionBlueprints(db, activeExpansionIds);
      let cycleStart = config.scan_cycle_started_at;

      const shouldStartNewCycle =
        cycleStart === null ||
        total === 0 ||
        (await countScannedThisCycle(db, activeExpansionIds, cycleStart)) >= total;

      if (shouldStartNewCycle) {
        // Fetch a fresh UTC timestamp from SQLite so the anchor is consistent
        // with how markBlueprintsScanned writes last_scanned_at.
        const tsRow = await db
          .prepare(`SELECT datetime('now') AS ts`)
          .first<{ ts: string }>();
        cycleStart = tsRow?.ts ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
        await patchConfig(db, { scan_cycle_started_at: cycleStart });
        console.info('[scanner] new scan cycle started', { cycleStart, total });
      }
    } catch (cycleErr) {
      // Non-fatal: cycle tracking failure must not abort the scan.
      console.error('[scanner] cycle management error (non-fatal)', {
        error: cycleErr instanceof Error ? cycleErr.message : String(cycleErr),
      });
    }
  }

  // Step 1: Warm expansion caches — populate blueprints table for expansions
  // that have no cached blueprints yet. Cap at MAX_CACHE_WARMUPS_PER_RUN
  // to stay within the subrequest budget.
  let warmups = 0;
  for (const item of expansionItems) {
    if (warmups >= MAX_CACHE_WARMUPS_PER_RUN) { break; }
    // expansionItems always have a non-null cardtrader_id (expansion id).
    const expId = item.cardtrader_id as number;
    const count = await countBlueprintsForExpansion(db, expId);
    if (count === 0) {
      try {
        const blueprints = await client.blueprintsExport(expId);
        await syncBlueprints(
          db,
          blueprints.map((bp) => ({
            id: bp.id,
            expansion_id: expId,
            name: bp.name,
            scryfall_id: bp.scryfall_id ?? null,
            image_url: bp.image_url ?? null,
          })),
        );
        warmups++;
        console.info('[scanner] warmed blueprint cache', {
          expansionId: expId,
          count: blueprints.length,
        });
      } catch (err) {
        // Non-fatal: cache warms on the next run.
        console.error('[scanner] blueprint cache warmup failed', {
          expansionId: expId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Step 2: Scan blueprint-type watch items directly (fixed, no rotation).
  // These are individual cards explicitly added to the watchlist.
  let used = 0;
  for (const item of blueprintItems) {
    if (used >= budget) { break; }
    try {
      await scanItem(client, item, config, db, callbacks);
      used++;
    } catch (err) {
      console.error('[scanner] blueprint item skipped (chunked)', {
        watchlistId: item.id,
        cardtraderId: item.cardtrader_id,
        error: err instanceof Error ? err.message : String(err),
      });
      used++; // count attempt even on error so budget advances
    }
  }

  // Step 3: Rotate expansion + card-derived blueprints with remaining budget.
  // Build owner maps:
  //   expansionOwnerMap: expansion_id → WatchlistRow (for expansion items)
  //   cardOwnerMap: blueprint_id → WatchlistRow (for card items)
  // Precedence: expansion item wins if a blueprint appears in both — the user
  // explicitly added the full set, so its settings are more specific.
  const remaining = budget - used;
  if (remaining <= 0 && expansionItems.length === 0 && cardItems.length === 0) { return; }

  const expansionOwnerMap = new Map<number, WatchlistRow>();
  for (const item of expansionItems) {
    // expansion items always have a non-null cardtrader_id
    expansionOwnerMap.set(item.cardtrader_id as number, item);
  }

  // Resolve card items → blueprint id sets, build blueprint-level owner map.
  // We collect all card-derived blueprint ids here and dedup before the DB query.
  const cardOwnerMap = new Map<number, WatchlistRow>();

  for (const item of cardItems) {
    if (!item.card_name_norm) {
      console.error('[scanner] card item missing card_name_norm (chunked)', {
        watchlistId: item.id,
      });
      continue;
    }
    const expansionIds = parseExpansionFilter(item.expansion_filter);
    let resolved: { id: number; expansion_id: number }[];
    try {
      resolved = await resolveCardBlueprints(db, item.card_name_norm, expansionIds);
    } catch (err) {
      console.error('[scanner] resolveCardBlueprints failed (chunked)', {
        watchlistId: item.id,
        cardNameNorm: item.card_name_norm,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Cap per card item and register in the owner map.
    const capped = resolved.slice(0, MAX_CARD_BLUEPRINTS_PER_ITEM);
    for (const bp of capped) {
      // Only register card item ownership if the blueprint is NOT already owned
      // by an expansion item (expansion wins on overlap per owner precedence).
      if (!expansionOwnerMap.has(bp.expansion_id) && !cardOwnerMap.has(bp.id)) {
        cardOwnerMap.set(bp.id, item);
      }
    }
  }

  const cardBlueprintIds = Array.from(cardOwnerMap.keys());

  // Fetch the rotation candidates for both expansion-derived and card-derived
  // blueprints under ONE shared remaining-budget. We query them separately and
  // interleave by last_scanned_at (oldest-first) via a merge sort; in practice
  // the total is capped so budget exhaustion makes this a non-issue.
  // Simpler: query expansion ids and card ids together after computing the split.

  const hasExpansions = activeExpansionIds.length > 0;
  const hasCardBlueprints = cardBlueprintIds.length > 0;

  if (remaining <= 0 || (!hasExpansions && !hasCardBlueprints)) { return; }

  // Fetch separate batches and merge — each query returns at most `remaining`
  // entries but we need a unified rotation. Use a simple two-pass approach:
  // fetch both at full `remaining` budget and interleave by last_scanned_at,
  // then take the first `remaining` items. NULL last_scanned_at sorts first.
  const [expansionCandidates, cardCandidates] = await Promise.all([
    hasExpansions
      ? selectBlueprintsToScan(db, activeExpansionIds, remaining)
      : Promise.resolve([] as { id: number; expansion_id: number }[]),
    hasCardBlueprints
      ? selectBlueprintsToScanByIds(db, cardBlueprintIds, remaining)
      : Promise.resolve([] as { id: number; expansion_id: number }[]),
  ]);

  // Merge: null last_scanned_at comes first (we don't have that field here but
  // the DB queries already return results in the correct order). We merge the
  // two sorted arrays by stable interleaving — expansion candidates first when
  // both are from the same "tier" (both null or both timestamped). Since we
  // can't compare timestamps here (they're not in the returned rows), we use a
  // round-robin merge preserving each list's internal order.
  // This is a practical approximation; perfect fairness would require the DB to
  // return last_scanned_at. The cursor ensures fair long-run progress.
  const merged = mergeCandidates(expansionCandidates, cardCandidates, remaining);

  // Dedupe: if a blueprint appears in both (expansion + card overlap), keep the
  // first occurrence (expansion wins — it came first in the merged list).
  const seen = new Set<number>();
  const toScan: { id: number; expansion_id: number }[] = [];
  for (const bp of merged) {
    if (!seen.has(bp.id)) {
      seen.add(bp.id);
      toScan.push(bp);
    }
  }

  // Mark scanned blueprints in small chunks AS WE GO (not once at the end) and
  // stop at the per-run time budget — so a cron run killed mid-batch still
  // advances the rotation cursor instead of retrying the same cards forever.
  const startMs = Date.now();
  let pending: number[] = [];

  async function flushPending(): Promise<void> {
    if (pending.length > 0) {
      const batch = pending;
      pending = [];
      await markBlueprintsScanned(db, batch);
    }
  }

  for (const bp of toScan) {
    // Stop cleanly once the per-run time budget is used.
    if (Date.now() - startMs >= CHUNKED_RUN_BUDGET_MS) { break; }

    // Determine the owner item: expansion item takes precedence over card item.
    const ownerItem =
      expansionOwnerMap.get(bp.expansion_id) ??
      cardOwnerMap.get(bp.id);

    if (ownerItem === undefined) {
      // Blueprint no longer owned by any active item — mark scanned so it
      // doesn't block rotation.
      pending.push(bp.id);
      if (pending.length >= MARK_FLUSH_EVERY) { await flushPending(); }
      continue;
    }

    // Mark as attempted (scanned) so the cursor advances even on error.
    pending.push(bp.id);

    try {
      await scanBlueprintById(bp.id, client, ownerItem, config, db, callbacks);
    } catch (err) {
      console.error('[scanner] blueprint skipped (chunked rotation)', {
        blueprintId: bp.id,
        expansionId: bp.expansion_id,
        watchlistId: ownerItem.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal; continue to next blueprint.
    }

    if (pending.length >= MARK_FLUSH_EVERY) { await flushPending(); }
  }

  // Persist any remaining attempted blueprints.
  await flushPending();
}

// ---------------------------------------------------------------------------
// scanItem — per-watchlist-item logic (wholeset + blueprint-type chunked)
// ---------------------------------------------------------------------------

/**
 * Fetch and evaluate all blueprints for one watchlist item.
 *
 * For expansion items: one big marketplaceProducts({expansionId}) call → iterate
 * the response map (all blueprints in the set).
 * For blueprint items: one marketplaceProducts({blueprintId}) call → one key.
 *
 * Card items are NOT handled here — they are resolved to blueprint ids and
 * scanned via scanBlueprintById by the caller (runWholeset / runChunked).
 *
 * Throws on any fetch or parse failure — the caller catches at the per-item
 * boundary and continues (PRD §13).
 */
async function scanItem(
  client: CardTraderClient,
  item: WatchlistRow,
  config: ConfigRow,
  db: D1Database,
  callbacks: ScanCallbacks,
): Promise<void> {
  // cardtrader_id is guaranteed non-null for blueprint and expansion items.
  const ctId = item.cardtrader_id as number;

  const eff = resolveEffective(item, config);
  const foilParam: { foil?: boolean } =
    eff.foil_pref === 'any' ? {} : { foil: eff.foil_pref === 'foil' };

  const response =
    item.type === 'blueprint'
      ? await client.marketplaceProducts({
          blueprintId: ctId,
          language: 'en',
          ...foilParam,
        })
      : await client.marketplaceProducts({
          expansionId: ctId,
          language: 'en',
          ...foilParam,
        });

  callbacks.onWatchItemScanned();

  for (const [bpIdStr, products] of Object.entries(response)) {
    callbacks.onBlueprintScanned();
    const bpId = parseInt(bpIdStr, 10);
    await evaluateAndUpsert(bpId, products, item, eff, db, callbacks);
  }
}

/**
 * Fetch and evaluate a single blueprint by id for a given watchlist item
 * (expansion or card owner). Used by chunked mode for the rotation loop
 * and by wholeset mode for card-type items.
 *
 * Throws on fetch/parse failure — caller catches at the per-blueprint boundary.
 */
async function scanBlueprintById(
  blueprintId: number,
  client: CardTraderClient,
  ownerItem: WatchlistRow,
  config: ConfigRow,
  db: D1Database,
  callbacks: ScanCallbacks,
): Promise<void> {
  const eff = resolveEffective(ownerItem, config);
  const foilParam: { foil?: boolean } =
    eff.foil_pref === 'any' ? {} : { foil: eff.foil_pref === 'foil' };

  const response = await client.marketplaceProducts({
    blueprintId,
    language: 'en',
    ...foilParam,
  });

  callbacks.onWatchItemScanned();

  for (const [bpIdStr, products] of Object.entries(response)) {
    callbacks.onBlueprintScanned();
    const bpId = parseInt(bpIdStr, 10);
    await evaluateAndUpsert(bpId, products, ownerItem, eff, db, callbacks);
  }
}

// ---------------------------------------------------------------------------
// evaluateAndUpsert — shared deal-building helper
// ---------------------------------------------------------------------------

/**
 * Run the deal engine on one blueprint's products and upsert any deal found.
 *
 * Shared by both scan modes so the DealInsert shape is always identical.
 * Money is integer cents throughout; no floats.
 */
async function evaluateAndUpsert(
  blueprintId: number,
  products: Product[],
  item: WatchlistRow,
  eff: EffectiveSettings,
  db: D1Database,
  callbacks: ScanCallbacks,
): Promise<void> {
  const result = evaluateBlueprint(products, eff);

  if (result !== null) {
    const candidate = result.product;

    const deal: DealInsert = {
      watchlist_id: item.id,
      blueprint_id: blueprintId,
      product_id: candidate.id,
      card_name: candidate.name_en,
      expansion_name: candidate.expansion?.name_en ?? null,
      seller_username: candidate.user?.username ?? null,
      seller_country: candidate.user?.country_code ?? null,
      condition: candidate.properties_hash.condition,
      language: candidate.properties_hash.mtg_language,
      foil: candidate.properties_hash.mtg_foil,
      can_sell_via_hub: candidate.user?.can_sell_via_hub ?? null,
      quantity: candidate.quantity,
      price_cents: candidate.price.cents,                  // integer cents, never float
      currency: candidate.price.currency,
      baseline_cents: result.baselineCents,                // integer cents, never float
      second_cheapest_cents: result.secondCheapestCents,   // gap-gate baseline
      gap_pct: result.gapPct,                              // % below next-available copy
      avg4_cents: result.avg4Cents,                        // mean of next-4-cheapest ("vs avg")
      cohort_size: result.cohortSize,
      discount_pct: result.discountPct,                    // integer percent
      priority: eff.importance,
      buy_url: buildBuyUrl(blueprintId, candidate.name_en, candidate.expansion?.name_en ?? null),
    };

    const isNew = await upsertDeal(db, deal);
    if (isNew) {
      callbacks.onNewDeal(deal, eff);
    }
  }

  // Deal lifecycle (migration 0009): retire open deals for this blueprint that
  // are no longer the active candidate — sold (listing gone) or expired
  // (superseded / failed a gate). Runs even when no deal qualifies now, so a
  // blueprint that stopped having a deal still gets its stale rows cleared.
  const presentProductIds = products.map((p) => p.id);
  const candidateProductId = result?.product.id ?? null;
  await revalidateBlueprintDeals(db, blueprintId, presentProductIds, candidateProductId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the expansion_filter JSON string from a card-type watchlist item.
 *
 * Returns:
 *  - null  if the field is null, the empty string, or '[]' → "all sets"
 *  - number[] if the JSON parses to a non-empty int array
 *  - null  if the JSON is malformed (silently treated as "all sets")
 */
function parseExpansionFilter(raw: string | null): number[] | null {
  if (!raw) { return null; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) { return null; }
    return parsed as number[];
  } catch {
    // Malformed JSON — treat as "all sets" (no filter).
    return null;
  }
}

/**
 * Merge two sorted blueprint candidate arrays (each already in rotation order)
 * into a single list of at most `limit` entries using round-robin interleaving.
 *
 * Both input arrays are produced by DB queries that already sort correctly
 * (NULL last_scanned_at first, then oldest first, then id ASC). Round-robin
 * interleaving preserves each list's internal order while giving both sources
 * roughly equal representation within each budget window.
 */
function mergeCandidates(
  a: { id: number; expansion_id: number }[],
  b: { id: number; expansion_id: number }[],
  limit: number,
): { id: number; expansion_id: number }[] {
  const result: { id: number; expansion_id: number }[] = [];
  let ai = 0;
  let bi = 0;
  while (result.length < limit && (ai < a.length || bi < b.length)) {
    if (ai < a.length) { result.push(a[ai++]); }
    if (result.length < limit && bi < b.length) { result.push(b[bi++]); }
  }
  return result;
}

function buildSummary(
  runId: number,
  counts: {
    watchItemsScanned: number;
    blueprintsScanned: number;
    apiCalls: number;
    dealsFound: number;
    telegramSent: number;
  },
  error: string | null,
): ScanSummary {
  return {
    runId,
    watchItemsScanned: counts.watchItemsScanned,
    blueprintsScanned: counts.blueprintsScanned,
    apiCalls: counts.apiCalls,
    dealsFound: counts.dealsFound,
    telegramSent: counts.telegramSent,
    error,
  };
}
