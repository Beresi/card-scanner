/**
 * GET /api/purchases — cumulative purchase ledger for the Purchases view.
 *
 * Returns { total_saved_cents, total_paid_cents, count, currency, items[] }.
 * All money is integer cents. Read-only; no business logic — delegates to
 * repo.getPurchaseSummary. The ledger is written by markDealBought (the
 * PATCH /api/deals/:id { bought:true } path).
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { getPurchaseSummary } from '../db/repo';

export const purchasesRouter = new Hono<{ Bindings: Env }>();

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  console.error('purchases route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

purchasesRouter.get('/', async (c) => {
  try {
    const summary = await getPurchaseSummary(c.env.DB);
    return c.json(summary);
  } catch (err) {
    return handleError(err, c);
  }
});
