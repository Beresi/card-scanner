/**
 * GET    /api/deals           — list deals with optional filters.
 * PATCH  /api/deals/:id       — update seen/dismissed flags.
 * DELETE /api/deals           — prune deals older than N days.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * No business logic — delegates to repo.ts helpers.
 *
 * PRD §9 / §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { listDeals, patchDeal, pruneDeals } from '../db/repo';
import { parseIntParam, parseBoolBody } from './validate';

export const dealsRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Valid enum values for the status query param.
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['open', 'all'] as const;
type DealStatus = (typeof VALID_STATUSES)[number];

// ---------------------------------------------------------------------------
// Error mapping — invalid_request → 400, unexpected → 500 (no internals leaked).
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('deals route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// GET / — list deals with optional filters
// ---------------------------------------------------------------------------

dealsRouter.get('/', async (c) => {
  try {
    const q = c.req.query();

    // status: must be 'open' or 'all' when present; default 'open'.
    let status: DealStatus = 'open';
    if (q['status'] !== undefined) {
      if (!(VALID_STATUSES as readonly string[]).includes(q['status'])) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      status = q['status'] as DealStatus;
    }

    // parseIntParam throws Error('invalid_request') on present-but-invalid.
    const min_discount = parseIntParam(q['min_discount']);
    const watchlist_id = parseIntParam(q['watchlist_id']);

    // priority is a free string pass-through.
    const priority = q['priority'];

    const rows = await listDeals(c.env.DB, {
      status,
      min_discount,
      watchlist_id,
      priority,
    });

    return c.json(rows);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id — update seen / dismissed flags
// ---------------------------------------------------------------------------

dealsRouter.patch('/:id', async (c) => {
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

    // parseBoolBody throws Error('invalid_request') on wrong type.
    const seen      = parseBoolBody(body['seen']);
    const dismissed = parseBoolBody(body['dismissed']);

    const updated = await patchDeal(c.env.DB, id, { seen, dismissed });
    if (updated === null) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(updated);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// DELETE / — prune deals older than N days
// ---------------------------------------------------------------------------

dealsRouter.delete('/', async (c) => {
  try {
    // older_than_days is REQUIRED.
    const rawDays = c.req.query('older_than_days');
    if (rawDays === undefined || rawDays === '') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // parseIntParam throws on non-integer.
    const olderThanDays = parseIntParam(rawDays);
    if (olderThanDays === undefined) {
      // Should not happen (empty string already caught above), but guard anyway.
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (olderThanDays < 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const deleted = await pruneDeals(c.env.DB, olderThanDays);
    return c.json({ deleted });
  } catch (err) {
    return handleError(err, c);
  }
});
