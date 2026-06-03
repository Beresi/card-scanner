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
