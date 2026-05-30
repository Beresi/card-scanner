/**
 * GET    /api/watchlist          — list all watchlist rows.
 * POST   /api/watchlist          — insert a new watchlist row; 201 on success.
 * PATCH  /api/watchlist/:id      — partial update; 404 if not found.
 * DELETE /api/watchlist/:id      — hard-delete row + child deals; 204 on success.
 * PATCH  /api/watchlist/:id/reset — null a §9a override column (back to inherit).
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * No business logic — delegates to repo.ts helpers.
 *
 * PRD §9 / §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import {
  listWatchlist,
  insertWatchlist,
  patchWatchlist,
  deleteWatchlist,
  resetWatchlistField,
} from '../db/repo';
import { parseIntParam, pickAllowed } from './validate';
import type { WatchlistRow, WatchlistInsert } from '../db/types';

export const watchlistRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Allow-list for PATCH /:id — all editable columns (not id / created_at / updated_at).
// ---------------------------------------------------------------------------

const WATCHLIST_PATCH_FIELDS = [
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
] as const;

// ---------------------------------------------------------------------------
// Error mapping — invalid_request → 400, unexpected → 500 (no internals leaked).
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('watchlist route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// GET / — list all watchlist rows (active and inactive)
// ---------------------------------------------------------------------------

watchlistRouter.get('/', async (c) => {
  try {
    const rows = await listWatchlist(c.env.DB);
    return c.json(rows);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// POST / — create a new watchlist item
// ---------------------------------------------------------------------------

watchlistRouter.post('/', async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Validate required fields.
    const { type, cardtrader_id, label } = body;

    if (type !== 'blueprint' && type !== 'expansion') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!Number.isInteger(cardtrader_id) || typeof cardtrader_id !== 'number') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (typeof label !== 'string' || label.trim() === '') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Build the insert from required + allowed optional fields.
    // §9a override columns are intentionally absent — new items are born inheriting.
    const insert: WatchlistInsert = {
      type,
      cardtrader_id,
      label: label.trim(),
    };

    if (typeof body['game_id'] === 'number') { insert.game_id = body['game_id']; }
    if (typeof body['min_condition'] === 'string') { insert.min_condition = body['min_condition']; }
    if (body['foil_pref'] === 'any' || body['foil_pref'] === 'foil' || body['foil_pref'] === 'nonfoil') {
      insert.foil_pref = body['foil_pref'];
    }
    if (body['allow_graded'] === 0 || body['allow_graded'] === 1) {
      insert.allow_graded = body['allow_graded'];
    }
    if (body['importance'] === 'high' || body['importance'] === 'normal') {
      insert.importance = body['importance'];
    }
    if (body['telegram_enabled'] === 0 || body['telegram_enabled'] === 1) {
      insert.telegram_enabled = body['telegram_enabled'];
    }
    if (body['active'] === 0 || body['active'] === 1) {
      insert.active = body['active'];
    }

    const created = await insertWatchlist(c.env.DB, insert);
    return c.json(created, 201);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id/reset — null a §9a override column (back to inherit).
// Must be registered BEFORE /:id so Hono matches /reset as the literal path.
// ---------------------------------------------------------------------------

watchlistRouter.patch('/:id/reset', async (c) => {
  try {
    const id = parseIntParam(c.req.param('id'));
    if (id === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const field = body['field'];
    if (typeof field !== 'string' || field === '') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    let updated: WatchlistRow | null;
    try {
      updated = await resetWatchlistField(c.env.DB, id, field);
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid_field') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      throw err; // re-throw; outer catch handles as 500
    }

    if (updated === null) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(updated);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id — partial update
// ---------------------------------------------------------------------------

watchlistRouter.patch('/:id', async (c) => {
  try {
    const id = parseIntParam(c.req.param('id'));
    if (id === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const patch = pickAllowed<WatchlistRow>(body, WATCHLIST_PATCH_FIELDS);
    const updated = await patchWatchlist(c.env.DB, id, patch as Record<string, unknown>);

    if (updated === null) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(updated);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — hard-delete row + child deals
// ---------------------------------------------------------------------------

watchlistRouter.delete('/:id', async (c) => {
  try {
    const id = parseIntParam(c.req.param('id'));
    if (id === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const deleted = await deleteWatchlist(c.env.DB, id);
    if (!deleted) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(null, 204);
  } catch (err) {
    return handleError(err, c);
  }
});
