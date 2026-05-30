/**
 * GET /api/resolve/expansions   — search cached expansions by name/code.
 * GET /api/resolve/blueprints   — search cached blueprints within an expansion.
 *
 * These routes serve the add-card UX: the desktop types a set name, picks an
 * expansion, then picks a card (blueprint).  The cache tables are populated by
 * a future sync job; returning [] when the cache is empty is correct behaviour.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * No business logic — delegates to repo.searchExpansions / repo.searchBlueprints.
 *
 * PRD §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { searchExpansions, searchBlueprints } from '../db/repo';
import { parseIntParam } from './validate';

export const resolveRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Error mapping — invalid_request → 400, unexpected → 500 (no internals leaked).
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('resolve route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// GET /expansions — search by name or code
// ---------------------------------------------------------------------------

resolveRouter.get('/expansions', async (c) => {
  try {
    const q = c.req.query('q') ?? '';

    // No query string or empty → return empty array (nothing to search).
    if (q.trim() === '') {
      return c.json([]);
    }

    const rows = await searchExpansions(c.env.DB, q);
    return c.json(rows);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// GET /blueprints — search within a specific expansion
// ---------------------------------------------------------------------------

resolveRouter.get('/blueprints', async (c) => {
  try {
    // expansion_id is REQUIRED.
    const rawExpansionId = c.req.query('expansion_id');
    if (rawExpansionId === undefined || rawExpansionId === '') {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // parseIntParam throws Error('invalid_request') on non-integer.
    const expansion_id = parseIntParam(rawExpansionId);
    if (expansion_id === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const q = c.req.query('q') ?? '';

    const rows = await searchBlueprints(c.env.DB, expansion_id, q);
    return c.json(rows);
  } catch (err) {
    return handleError(err, c);
  }
});
