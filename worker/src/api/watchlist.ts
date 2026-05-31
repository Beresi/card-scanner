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
import { normalizeCardName } from '../scan/cardName';

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
  // §9a nullable overrides (migration 0005)
  'detection_mode',
  'max_price_cents',
  // card-type set filter (migration 0005); card_name_norm is not patchable post-create
  'expansion_filter',
] as const;

// Valid detection modes (§9a).
const DETECTION_MODES = ['discount', 'price'] as const;

// Input bounds — defensive caps so a malformed/oversized body can't drive
// unbounded allocation or a huge IN-list at scan time (single-user tool, but cheap to guard).
const MAX_CARD_NAME_LEN = 200;           // card_name character ceiling
const MAX_EXPANSION_FILTER_LEN = 200;    // expansion_filter array-length ceiling
const MAX_PRICE_CENTS = 10_000_000;      // max_price_cents ceiling ($100,000)

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
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and normalise an expansion_filter value from the request body.
 *
 * Accepts an array of positive integers.  Returns the JSON string to store in
 * the DB, or null on invalid input.  An empty array or omitted value → null
 * (treated as "no filter — all sets").
 *
 * This never interpolates user values into SQL — the result is a JSON text
 * blob stored in a single bound column.
 */
function parseExpansionFilter(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  if (value.length > MAX_EXPANSION_FILTER_LEN) {
    return null;
  }
  for (const item of value) {
    if (!Number.isInteger(item) || typeof item !== 'number' || item <= 0) {
      return null;
    }
  }
  return JSON.stringify(value as number[]);
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

    const { type } = body;

    // ── type validation ───────────────────────────────────────────────────────
    if (type !== 'blueprint' && type !== 'expansion' && type !== 'card') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Build the insert from required + allowed optional fields.
    // §9a override columns are intentionally absent — new items are born inheriting.
    const insert: WatchlistInsert = { type, label: '' };

    if (type === 'card') {
      // ── card type: requires card_name ─────────────────────────────────────
      const cardName = body['card_name'];
      if (typeof cardName !== 'string' || cardName.trim() === '') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const trimmedName = cardName.trim();
      if (trimmedName.length > MAX_CARD_NAME_LEN) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      insert.label = trimmedName;
      insert.cardtrader_id = null;
      insert.card_name_norm = normalizeCardName(trimmedName);

      // Optional expansion_filter — array of positive integers → stored as JSON.
      if (body['expansion_filter'] !== undefined && body['expansion_filter'] !== null) {
        const filterResult = parseExpansionFilter(body['expansion_filter']);
        if (filterResult === null) {
          return c.json({ error: 'invalid_request' }, 400);
        }
        insert.expansion_filter = filterResult;
      }
    } else {
      // ── blueprint / expansion type: requires cardtrader_id + label ─────────
      const { cardtrader_id, label } = body;
      if (!Number.isInteger(cardtrader_id) || typeof cardtrader_id !== 'number') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (typeof label !== 'string' || label.trim() === '') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      insert.cardtrader_id = cardtrader_id;
      insert.label = label.trim();
    }

    // ── shared optional fields ────────────────────────────────────────────────
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

    // ── §9a optional override fields (both types) ─────────────────────────────
    if (body['detection_mode'] !== undefined) {
      if (!(DETECTION_MODES as readonly string[]).includes(body['detection_mode'] as string)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      insert.detection_mode = body['detection_mode'] as string;
    }
    if (body['max_price_cents'] !== undefined) {
      const mpc = body['max_price_cents'];
      if (!Number.isInteger(mpc) || typeof mpc !== 'number' || mpc < 0 || mpc > MAX_PRICE_CENTS) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      insert.max_price_cents = mpc;
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

    // ── validate the new optional override fields before allow-listing ────────
    if (body['detection_mode'] !== undefined && body['detection_mode'] !== null) {
      if (!(DETECTION_MODES as readonly string[]).includes(body['detection_mode'] as string)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }
    if (body['max_price_cents'] !== undefined && body['max_price_cents'] !== null) {
      const mpc = body['max_price_cents'];
      if (!Number.isInteger(mpc) || typeof mpc !== 'number' || mpc < 0 || mpc > MAX_PRICE_CENTS) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }
    if (body['expansion_filter'] !== undefined && body['expansion_filter'] !== null) {
      const filterResult = parseExpansionFilter(body['expansion_filter']);
      if (filterResult === null) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      // Replace the body value with the validated JSON string so pickAllowed passes it through.
      body = { ...body, expansion_filter: filterResult };
    }
    // null is a valid PATCH value for expansion_filter (clears the filter → all sets).
    // It passes through pickAllowed as-is.

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
