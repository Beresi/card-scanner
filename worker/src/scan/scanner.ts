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
  upsertDeal,
  markTelegramSent,
  countBlueprintsForExpansion,
  syncBlueprints,
  selectBlueprintsToScan,
  markBlueprintsScanned,
  getLatestFinishedScanAt,
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
    try {
      await scanItem(client, item, config, db, callbacks);
    } catch (err) {
      console.error('[scanner] blueprint skipped (wholeset)', {
        watchlistId: item.id,
        watchlistType: item.type,
        cardtraderId: item.cardtrader_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Chunked mode (default, free-tier safe)
// ---------------------------------------------------------------------------

/** Max expansion cache warm-up calls per chunked run (blueprintsExport is extra subrequests). */
const MAX_CACHE_WARMUPS_PER_RUN = 2;

/**
 * Chunked scan mode — rotates through blueprints across all active expansions,
 * scanning at most config.scan_batch_size blueprints per run.
 *
 * Algorithm:
 *  1. Split watchlist into blueprint-type items and expansion-type items.
 *  2. Warm expansion blueprint caches (at most MAX_CACHE_WARMUPS_PER_RUN calls).
 *  3. Scan blueprint-type items directly (no rotation; few, explicit cards).
 *  4. With remaining budget, rotate expansion blueprints via last_scanned_at cursor.
 *  5. Mark all attempted blueprints scanned so the rotation advances.
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

  // Step 1: Warm expansion caches — populate blueprints table for expansions
  // that have no cached blueprints yet. Cap at MAX_CACHE_WARMUPS_PER_RUN
  // to stay within the subrequest budget.
  let warmups = 0;
  for (const item of expansionItems) {
    if (warmups >= MAX_CACHE_WARMUPS_PER_RUN) { break; }
    const count = await countBlueprintsForExpansion(db, item.cardtrader_id);
    if (count === 0) {
      try {
        const blueprints = await client.blueprintsExport(item.cardtrader_id);
        await syncBlueprints(
          db,
          blueprints.map((bp) => ({
            id: bp.id,
            expansion_id: item.cardtrader_id,
            name: bp.name,
            scryfall_id: bp.scryfall_id ?? null,
            image_url: bp.image_url ?? null,
          })),
        );
        warmups++;
        console.info('[scanner] warmed blueprint cache', {
          expansionId: item.cardtrader_id,
          count: blueprints.length,
        });
      } catch (err) {
        // Non-fatal: cache warms on the next run.
        console.error('[scanner] blueprint cache warmup failed', {
          expansionId: item.cardtrader_id,
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

  // Step 3: Rotate expansion blueprints with remaining budget.
  const remaining = budget - used;
  if (remaining <= 0 || expansionItems.length === 0) { return; }

  const expansionIds = expansionItems.map((w) => w.cardtrader_id);

  // Build a map from expansion_id to the owning watchlist item for resolveEffective.
  const expansionMap = new Map<number, WatchlistRow>();
  for (const item of expansionItems) {
    expansionMap.set(item.cardtrader_id, item);
  }

  const toScan = await selectBlueprintsToScan(db, expansionIds, remaining);
  const scannedIds: number[] = [];

  for (const bp of toScan) {
    const ownerItem = expansionMap.get(bp.expansion_id);
    if (ownerItem === undefined) {
      // Blueprint belongs to an expansion no longer on the active watchlist —
      // mark scanned so it doesn't block the rotation, then skip.
      scannedIds.push(bp.id);
      continue;
    }

    // Always mark as attempted (scanned) so the cursor advances even on error.
    scannedIds.push(bp.id);

    try {
      await scanBlueprintById(bp.id, client, ownerItem, config, db, callbacks);
    } catch (err) {
      console.error('[scanner] expansion blueprint skipped (chunked)', {
        blueprintId: bp.id,
        expansionId: bp.expansion_id,
        watchlistId: ownerItem.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal; continue to next blueprint.
    }
  }

  // Advance the rotation cursor for all attempted blueprints.
  await markBlueprintsScanned(db, scannedIds);
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
  const eff = resolveEffective(item, config);
  const foilParam: { foil?: boolean } =
    eff.foil_pref === 'any' ? {} : { foil: eff.foil_pref === 'foil' };

  const response =
    item.type === 'blueprint'
      ? await client.marketplaceProducts({
          blueprintId: item.cardtrader_id,
          language: 'en',
          ...foilParam,
        })
      : await client.marketplaceProducts({
          expansionId: item.cardtrader_id,
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
 * Fetch and evaluate a single blueprint by id for a given expansion watch item.
 * Used by chunked mode for the rotation loop.
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
  if (result === null) { return; }

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
    price_cents: candidate.price.cents,      // integer cents, never float
    currency: candidate.price.currency,
    baseline_cents: result.baselineCents,    // integer cents, never float
    cohort_size: result.cohortSize,
    discount_pct: result.discountPct,        // integer percent
    priority: eff.importance,
    buy_url: buildBuyUrl(blueprintId),
  };

  const isNew = await upsertDeal(db, deal);
  if (isNew) {
    callbacks.onNewDeal(deal, eff);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
