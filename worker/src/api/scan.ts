/**
 * POST /api/scan/run-now
 * GET  /api/scan/runs
 *
 * POST /run-now: thin controller — delegates immediately to runScan, the same
 * entry point the hourly cron uses (PRD §4/§11).  No business logic, no raw SQL.
 * runScan always resolves (scan-level errors land in ScanSummary.error, not a
 * thrown rejection), so this route returns 200 with the summary even when the
 * underlying scan recorded a failure.  The caller can inspect summary.error.
 *
 * GET /runs: returns the 20 most recent scan_runs rows (newest first) as a bare
 * JSON array.  Used by the Health view to display scan history.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { runScan } from '../scan/scanner';
import { listScanRuns } from '../db/repo';

export const scanRouter = new Hono<{ Bindings: Env }>();

// POST /api/scan/run-now → runScan(env, { trigger: 'run-now' })
// Same code path as the cron — no forked logic (PRD §4/§11).
scanRouter.post('/run-now', async (c) => {
  const summary = await runScan(c.env, { trigger: 'run-now' });
  return c.json(summary);
});

// GET /api/scan/runs — recent scan history, newest first (max 20 rows).
scanRouter.get('/runs', async (c) => {
  try {
    const runs = await listScanRuns(c.env.DB, 20);
    return c.json(runs);
  } catch (err) {
    console.error('scan/runs error', err instanceof Error ? err.message : err);
    return c.json({ error: 'internal' }, 500);
  }
});
