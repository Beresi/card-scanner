/**
 * POST /api/catalog/sync — on-demand catalog backfill for specific expansions.
 *
 * Pulls blueprints for the given MTG expansion ids from CardTrader and writes
 * them into the local catalog NOW (instead of waiting for the gradual cron
 * backfill). Used to immediately resolve cart/watchlist cards whose set hasn't
 * synced yet. Read-from-CardTrader + write-to-catalog only — NO purchase path.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { createCardTraderClient } from '../cardtrader/client';
import { CardTraderError } from '../cardtrader/types';
import { syncBlueprints, markExpansionCatalogSynced } from '../db/repo';
import { resyncCatalog } from '../scan/catalogResync';
import { detach } from './detach';

export const catalogRouter = new Hono<{ Bindings: Env }>();

// Bound the batch so one request can't fan out into a huge throttled run.
const MAX_SYNC_EXPANSIONS = 12;

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (err instanceof CardTraderError) {
    if (err.status === 401) { return c.json({ error: 'cardtrader_auth_failed' }, 502); }
    console.error('catalog route CardTraderError', err.endpoint, err.status);
    return c.json({ error: 'upstream_error' }, 500);
  }
  console.error('catalog route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// POST /sync — body { expansion_ids: number[] }
// ---------------------------------------------------------------------------

catalogRouter.post('/sync', async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const raw = body['expansion_ids'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Validate: positive integers, deduped, capped.
    const ids = [...new Set(raw)].filter(
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
    );
    if (ids.length === 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (ids.length > MAX_SYNC_EXPANSIONS) {
      return c.json({ error: 'too_many_expansions', max: MAX_SYNC_EXPANSIONS }, 400);
    }

    const client = createCardTraderClient(c.env.CARDTRADER_API_TOKEN);
    const synced: { expansion_id: number; count: number }[] = [];
    const errors: { expansion_id: number; error: string }[] = [];

    for (const expId of ids) {
      try {
        const blueprints = await client.blueprintsExport(expId);
        const count = await syncBlueprints(
          c.env.DB,
          blueprints.map((bp) => ({
            id: bp.id,
            expansion_id: expId,
            name: bp.name,
            scryfall_id: bp.scryfall_id ?? null,
            image_url: bp.image_url ?? null,
          })),
        );
        await markExpansionCatalogSynced(c.env.DB, expId);
        synced.push({ expansion_id: expId, count });
      } catch (err) {
        // Per-expansion failure is non-fatal — record and continue.
        errors.push({
          expansion_id: expId,
          error: err instanceof CardTraderError ? `upstream_${err.status ?? 'err'}` : 'failed',
        });
      }
    }

    return c.json({ synced, errors });
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// POST /resync — full-heal blueprint re-pull (Settings → Maintenance).
//
// Re-pulls EVERY MTG set's blueprints, bypassing the cron's "new sets only"
// refresh window. At CardTrader's ~1 req/s this runs for roughly 13 minutes, so
// the job is detached: the response carries the target set count as soon as the
// list is resolved, and search results improve live as sets land.
//
// Replaces the sidecar's CARD_BROKER_TASK=catalog-resync path. Same
// resyncCatalog() function, now called in-process against whichever database
// this backend is bound to — the sidecar would still be writing to cloud D1.
//
// Body is optional: { ids?: number[], emptyOnly?: boolean } narrows the run.
// ---------------------------------------------------------------------------

catalogRouter.post('/resync', async (c) => {
  // A body is optional here — unlike /sync, the default (every set) is the
  // common case, so an absent or unparseable body is not an error.
  let body: Record<string, unknown> = {};
  try { body = await c.req.json<Record<string, unknown>>(); } catch { /* default */ }

  const rawIds = body['ids'];
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds)].filter(
        (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
      )
    : undefined;
  const emptyOnly = body['emptyOnly'] === true;

  // resyncCatalog reports the target count via onStart, before the first
  // CardTrader call — that is what the response waits for.
  let signalStart: (totalSets: number) => void = () => {};
  const started = new Promise<number>((resolve) => { signalStart = resolve; });

  const job = resyncCatalog(c.env, { ids, emptyOnly }, { onStart: signalStart });
  detach(c, job, 'catalog-resync');

  // onStart wins unless the job throws while resolving the set list; the
  // summary fallback keeps this from hanging in that case.
  const totalSets = await Promise.race([
    started,
    job.then((s) => s.totalSets).catch(() => 0),
  ]);

  return c.json({ started: true, totalSets });
});
