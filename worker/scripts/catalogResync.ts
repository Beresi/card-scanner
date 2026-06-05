/**
 * catalogResync.ts — shared full-heal catalog re-sync core.
 *
 * Re-pulls blueprint catalogs from CardTrader and upserts them into the SAME
 * production Cloudflare D1 the cron and desktop app use, bypassing the cron's
 * "new sets only" refresh window (selectNextCatalogExpansions). This is the
 * full-heal path: it un-freezes EVERY set that was imported while CardTrader
 * only listed a handful of its cards.
 *
 * Used by two callers:
 *   - scripts/resync-catalog.ts   — terminal CLI (`npm run catalog:resync`)
 *   - scripts/scan-local.ts       — the Tauri sidecar, when CARD_BROKER_TASK=
 *                                   catalog-resync (the desktop "Resync catalog"
 *                                   button in Settings → Maintenance)
 *
 * Pure-ish: takes an Env (DB adapter + CardTrader token) plus options and
 * progress callbacks; performs NO process I/O itself, so each caller formats
 * output however it needs (human stderr vs JSON-lines).
 *
 * Read-from-CardTrader + write-to-catalog only. NO cart/checkout/purchase path.
 * Uses the client's ~1 req/s throttle + 429 backoff, so a full run of ~770 sets
 * takes ~13 minutes.
 */

import type { Env } from '../src/index';
import { createCardTraderClient } from '../src/cardtrader/client';
import { syncBlueprints, markExpansionCatalogSynced } from '../src/db/repo';

export interface ResyncOptions {
  /** Restrict to these expansion ids. Empty/undefined = all MTG sets. */
  ids?: number[];
  /** Only re-pull sets that currently have 0 cached blueprints. */
  emptyOnly?: boolean;
}

export interface ResyncCallbacks {
  /** Fired once the target set list is known, before any CardTrader call. */
  onStart?: (totalSets: number) => void;
  /** Fired after each set (success or failure). `delta` is new-cards count. */
  onSet?: (info: {
    index: number;
    total: number;
    id: number;
    name: string;
    count: number | null;
    delta: number | null;
    error: string | null;
  }) => void;
}

export interface ResyncSummary {
  totalSets: number;
  ok: number;
  failed: number;
  /** Number of sets that gained blueprints (delta > 0). */
  grew: number;
  failures: { id: number; name: string; error: string }[];
}

interface ExpRow {
  id: number;
  name: string;
  cached: number;
}

/** Strip anything secret-looking from an error string before it leaves this module. */
function redact(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ct_live_\S+/gi, '[REDACTED]');
}

/**
 * Resolve the target set list (with current cached counts), then re-pull each
 * from CardTrader and upsert. Per-set failures are non-fatal — recorded and
 * skipped. Returns an aggregate summary.
 */
export async function resyncCatalog(
  env: Env,
  opts: ResyncOptions = {},
  cb: ResyncCallbacks = {},
): Promise<ResyncSummary> {
  const explicitIds = (opts.ids ?? []).filter((n) => Number.isInteger(n) && n > 0);

  const where = explicitIds.length > 0 ? `e.id IN (${explicitIds.join(',')})` : 'e.game_id = 1';
  const { results: targets } = await env.DB
    .prepare(
      `SELECT e.id AS id,
              e.name AS name,
              (SELECT COUNT(*) FROM blueprints b WHERE b.expansion_id = e.id) AS cached
         FROM expansions e
        WHERE ${where}
        ORDER BY e.id DESC`,
    )
    .all<ExpRow>();

  const toSync = opts.emptyOnly ? targets.filter((t) => t.cached === 0) : targets;

  cb.onStart?.(toSync.length);

  const client = createCardTraderClient(env.CARDTRADER_API_TOKEN);
  const summary: ResyncSummary = { totalSets: toSync.length, ok: 0, failed: 0, grew: 0, failures: [] };

  for (let i = 0; i < toSync.length; i++) {
    const exp = toSync[i];
    try {
      const blueprints = await client.blueprintsExport(exp.id);
      await syncBlueprints(
        env.DB,
        blueprints.map((bp) => ({
          id: bp.id,
          expansion_id: exp.id,
          name: bp.name,
          scryfall_id: bp.scryfall_id ?? null,
          image_url: bp.image_url ?? null,
        })),
      );
      await markExpansionCatalogSynced(env.DB, exp.id);
      const delta = blueprints.length - exp.cached;
      summary.ok++;
      if (delta > 0) { summary.grew++; }
      cb.onSet?.({ index: i, total: toSync.length, id: exp.id, name: exp.name, count: blueprints.length, delta, error: null });
    } catch (err) {
      const safe = redact(err instanceof Error ? err.message : String(err));
      summary.failed++;
      summary.failures.push({ id: exp.id, name: exp.name, error: safe });
      cb.onSet?.({ index: i, total: toSync.length, id: exp.id, name: exp.name, count: null, delta: null, error: safe });
    }
  }

  return summary;
}
