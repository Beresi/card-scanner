/**
 * Scan orchestrator — the single shared entry point for both the hourly cron
 * and POST /api/scan/run-now (PRD §4/§11).
 *
 * Responsibilities:
 *  - Open and always-close the scan_runs row (lifecycle, counters, error).
 *  - Validate the CardTrader token via GET /info (abort on 401).
 *  - Walk the active watchlist; dispatch marketplace/products calls (throttled
 *    by the single per-run client instance).
 *  - Delegate deal math to evaluateBlueprint (pure, no I/O).
 *  - Upsert deals via repo (ON CONFLICT dedupes); collect truly-new rows.
 *  - Hand new rows to Phase-2 Telegram routing (stub comment below).
 *
 * What this module does NOT do:
 *  - No deal math, no routing math — pure cores handle those.
 *  - No Telegram send in Phase 1 (stub comment awaits the telegram-agent).
 *  - No D1 schema, no SQL — all persistence is via repo.ts.
 *
 * Money invariant: integer cents throughout; never divide by 100 here.
 * Secrets invariant: NEVER log CARDTRADER_API_TOKEN or any secret — log counts
 * and structured context only (error-handling skill).
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
} from '../db/repo';
import { resolveEffective } from '../db/resolve';
import { shouldNotify } from '../telegram/routing';
import { isTelegramConfigured, sendDeals } from '../telegram/notifier';
import type {
  DealInsert,
  EffectiveSettings,
  ScanCounts,
  WatchlistRow,
} from '../db/types';

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
  /** Deals pushed to Telegram this run (Phase 2: will be > 0). */
  telegramSent: number;
  /** null on a clean run; the failure message on a whole-run failure. */
  error: string | null;
}

/**
 * Injectable dependencies — used by tests to swap the CardTrader client
 * without a real API token (e.g. the §16 case-10 401-abort test).
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
  // Step 1: Open scan_runs row. Hold runId for the whole run.
  const runId = await openScanRun(env.DB);

  // Mutable counters — incremented throughout the run, written in finally.
  let watchItemsScanned = 0;
  let blueprintsScanned = 0;
  let apiCalls = 0;
  let dealsFound = 0;
  let telegramSent = 0; // incremented in Step 6 when Telegram is configured
  let runError: string | null = null;

  // New-deal rows eligible for Telegram routing, paired with the resolved
  // (§9a) settings the routing predicate needs. `eff` is captured per item.
  const newDeals: { deal: DealInsert; eff: EffectiveSettings }[] = [];

  // Step 2: Create ONE client instance for the whole run.
  // The factory binds the throttle queue to the instance — one instance means
  // one whole-run ~1 req/s throttle (PRD §6/§11/scanner.md Gotchas).
  const clientOpts: ClientOptions = {
    onRequest: () => {
      apiCalls++; // every HTTP attempt including retries (PRD §6/§11)
    },
  };
  const clientFactory = deps?.createClient ?? createCardTraderClient;
  const client: CardTraderClient = clientFactory(
    env.CARDTRADER_API_TOKEN,
    clientOpts,
  );

  try {
    // Step 3: Validate token — GET /info.
    // 401 → record error, abort the scan body, still close in finally.
    // Any other /info failure is also a whole-run abort (recorded below).
    try {
      await client.info();
    } catch (err) {
      if (err instanceof CardTraderError && err.status === 401) {
        runError = 'cardtrader token invalid (401)';
        // Phase 2 (telegram-agent): alert ONCE on 401 — suppress repeats across runs.
        // Check the last scan_runs row for an existing 401 error before alerting.
        // Do NOT implement here — leave for the telegram-agent in Phase 2.
        return buildSummary(
          runId,
          { watchItemsScanned, blueprintsScanned, apiCalls, dealsFound, telegramSent },
          runError,
        );
      }
      // Non-401 /info error: whole-run abort (re-throw to the outer catch).
      throw err;
    }

    // Step 4: Load config + active watchlist.
    const config = await getConfig(env.DB);
    const watchlist = await listActiveWatchlist(env.DB);

    // Step 5: Per-item scan loop.
    // A single item failure is NON-FATAL: log with context and continue.
    // Only a throw that escapes the loop (e.g. getConfig failing) is a
    // whole-run failure caught by the outer try/catch.
    for (const item of watchlist) {
      try {
        await scanItem(
          client,
          item,
          config,
          env.DB,
          {
            onWatchItemScanned: () => { watchItemsScanned++; },
            onBlueprintScanned: () => { blueprintsScanned++; },
            onNewDeal: (deal, eff) => {
              dealsFound++;
              newDeals.push({ deal, eff });
            },
          },
        );
      } catch (err) {
        // Per-item boundary: log structured context, skip, never rethrow.
        // NEVER log the token — only IDs and the error message (error-handling skill).
        console.error('[scanner] blueprint skipped', {
          watchlistId: item.id,
          watchlistType: item.type,
          cardtraderId: item.cardtrader_id,
          trigger: opts.trigger,
          error: err instanceof Error ? err.message : String(err),
          endpoint:
            item.type === 'blueprint'
              ? '/marketplace/products?blueprint_id=...'
              : '/marketplace/products?expansion_id=...',
        });
        // watchItemsScanned is NOT incremented for a failed item (only on success
        // inside scanItem). If we want to count attempts regardless, increment here.
        // PRD/scanner.md do not specify — we count only successful fetches.
        continue;
      }
    }

    // Step 6: Route new deals to Telegram (PRD §8) — guarded + non-fatal.
    //
    // GUARD: nothing runs until both Telegram secrets are present. While
    // unconfigured (the Phase-2 stub state) this whole block is skipped —
    // telegramSent stays 0 and no deal is marked telegram_sent, so nothing is
    // "burned" before the bot is wired. When the secrets land, this goes live
    // with no code change.
    //
    // NON-FATAL: a Telegram failure must never fail the scan. Deals are already
    // persisted (Step 5) and shown in the app feed; a send error is logged and
    // swallowed so the scan_runs row still closes cleanly.
    //
    // Quiet-hours/digest is PRD §8 v1-OPTIONAL — the predicate supports it, but
    // we pass quiet:null here; the hold/digest mechanism is deferred (see plan).
    if (isTelegramConfigured(env)) {
      try {
        // newDeals carry telegram_sent:false (just inserted this run).
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
          // Mark only after the batch is confirmed delivered (one push per
          // product_id, ever — §8 dedupe criterion 4).
          for (const deal of passing) {
            await markTelegramSent(env.DB, deal.product_id);
          }
          telegramSent = sent;
        }
      } catch (tgErr) {
        // Never log the token; counts + message only (error-handling skill).
        console.error('[scanner] telegram routing/send failed', {
          runId,
          trigger: opts.trigger,
          newDeals: newDeals.length,
          error: tgErr instanceof Error ? tgErr.message : String(tgErr),
        });
      }
    }
  } catch (err) {
    // Whole-run failure: record the error; the finally still closes the row.
    runError = err instanceof Error ? err.message : 'unknown scan failure';
    console.error('[scanner] scan run failed', {
      runId,
      trigger: opts.trigger,
      error: runError,
    });
  } finally {
    // Step 10: ALWAYS close the scan_runs row — even on throw.
    // A run that never writes finished_at looks "stuck" in the Health view.
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
      // If closeScanRun itself throws, log but do not re-throw — we still need
      // to return a summary so runScan never rejects.
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
// scanItem — per-watchlist-item logic (extracted for a clean per-item boundary)
// ---------------------------------------------------------------------------

/** Callbacks injected by runScan to mutate its counters and collect new deals. */
interface ScanItemCallbacks {
  onWatchItemScanned: () => void;
  onBlueprintScanned: () => void;
  onNewDeal: (deal: DealInsert, eff: EffectiveSettings) => void;
}

/**
 * Fetch and evaluate all blueprints for one watchlist item.
 *
 * Throws on any fetch or parse failure — the caller (runScan) catches at the
 * per-item boundary and continues the loop (PRD §13).
 */
async function scanItem(
  client: CardTraderClient,
  item: WatchlistRow,
  config: ReturnType<typeof getConfig> extends Promise<infer T> ? T : never,
  db: D1Database,
  callbacks: ScanItemCallbacks,
): Promise<void> {
  const eff = resolveEffective(item, config);

  // Foil query param: omit when foil_pref is 'any'; set true/false otherwise.
  // The client omits the `foil` param when undefined (buildMarketplacePath).
  const foilParam: { foil?: boolean } =
    eff.foil_pref === 'any' ? {} : { foil: eff.foil_pref === 'foil' };

  // Dispatch the marketplace/products call by item type.
  // expansion variant: one call → map of blueprint_id → Product[].
  // blueprint variant: one call → map with a single blueprint_id key.
  // Both produce a MarketplaceResponse (Record<string, Product[]>).
  //
  // NOTE (PRD §6/§13): the expansion_id + language filter is unverified.
  // If the API does not honor language=en on the expansion call, fall back
  // to per-blueprint calls. Verify during build before relying on batch path.
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

  // A single item fetch succeeded — count it.
  callbacks.onWatchItemScanned();

  // Iterate the response map: each key is a blueprint_id string → Product[].
  // For expansion items this may be many blueprints; for blueprint items, one.
  for (const products of Object.values(response)) {
    callbacks.onBlueprintScanned();

    const result = evaluateBlueprint(products, eff);
    if (result === null) {continue;} // thin market, not cheap enough, etc.

    const candidate = result.product;

    // Build the DealInsert from the engine result.
    // All money is integer cents — price_cents and baseline_cents from the wire.
    // buy_url is unverified (PRD §6/§13): confirm the pattern before shipping.
    const deal: DealInsert = {
      watchlist_id: item.id,
      blueprint_id: candidate.blueprint_id,
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
      buy_url: buildBuyUrl(candidate.blueprint_id),
    };

    // Upsert: ON CONFLICT(product_id) DO NOTHING.
    // isNew = true only when the row was freshly inserted (new deal this run).
    // Conflicts = already-known listing; skip Telegram, do not re-insert.
    const isNew = await upsertDeal(db, deal);
    if (isNew) {
      callbacks.onNewDeal(deal, eff);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a ScanSummary from the run's counters and error. */
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
