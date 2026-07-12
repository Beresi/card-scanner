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
import { listDeals, markDealBought, patchDeal, pruneDeals, deleteArchivedDeals, deleteAllDeals } from '../db/repo';
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
    const bought    = parseBoolBody(body['bought']);

    // bought:true is a dedicated transition — record the purchase ledger entry
    // AND retire the deal atomically (markDealBought). It is not a generic flag,
    // so it takes its own path rather than the seen/dismissed UPDATE.
    if (bought === true) {
      const boughtRow = await markDealBought(c.env.DB, id);
      if (boughtRow === null) {
        return c.json({ error: 'not_found' }, 404);
      }
      return c.json(boughtRow);
    }

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
// DELETE / — clear deals. Two mutually-exclusive modes:
//   ?scope=archived  → delete only retired/dismissed clutter (keep open deals).
//   ?scope=all       → delete every deal row (live deals return next scan).
//   ?older_than_days=N → legacy/automated: prune anything older than N days.
// Exactly one selector is required.
// ---------------------------------------------------------------------------

const VALID_SCOPES = ['archived', 'all'] as const;
type ClearScope = (typeof VALID_SCOPES)[number];

dealsRouter.delete('/', async (c) => {
  try {
    const rawScope = c.req.query('scope');
    const rawDays = c.req.query('older_than_days');

    // scope takes precedence when present (the desktop "Clear archive"/"Clear all").
    if (rawScope !== undefined && rawScope !== '') {
      if (!(VALID_SCOPES as readonly string[]).includes(rawScope)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const scope = rawScope as ClearScope;
      const deleted =
        scope === 'archived'
          ? await deleteArchivedDeals(c.env.DB) // all retired/dismissed, keep open
          : await deleteAllDeals(c.env.DB); // unconditional wipe
      return c.json({ deleted });
    }

    // Legacy path: older_than_days is REQUIRED when no scope is given.
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
