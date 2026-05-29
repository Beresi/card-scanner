/**
 * POST /api/scan/run-now
 *
 * Thin controller: delegates immediately to runScan — the same entry point the
 * hourly cron uses (PRD §4/§11).  No business logic, no raw SQL here.
 *
 * runScan always resolves (scan-level errors land in ScanSummary.error, not a
 * thrown rejection), so this route returns 200 with the summary even when the
 * underlying scan recorded a failure.  The caller can inspect summary.error.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { runScan } from '../scan/scanner';

export const scanRouter = new Hono<{ Bindings: Env }>();

// POST /api/scan/run-now → runScan(env, { trigger: 'run-now' })
// Same code path as the cron — no forked logic (PRD §4/§11).
scanRouter.post('/run-now', async (c) => {
  const summary = await runScan(c.env, { trigger: 'run-now' });
  return c.json(summary);
});
