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
import { detach } from './detach';

export const scanRouter = new Hono<{ Bindings: Env }>();

// POST /api/scan/run-now → runScan(env, { trigger: 'run-now' })
// Same code path as the cron — no forked logic (PRD §4/§11).
scanRouter.post('/run-now', async (c) => {
  const summary = await runScan(c.env, { trigger: 'run-now' });
  return c.json(summary);
});

// ---------------------------------------------------------------------------
// POST /deep-sweep — the "Scan Now" button.
//
// A full whole-set sweep of every watched expansion in one uncapped pass, with
// live progress written to the open scan_runs row so the UI can show "X / Y".
// It takes minutes, so this route does NOT wait for it: the scan is detached and
// the response carries the run id as soon as the scan_runs row is open. The
// frontend polls GET /api/scan/runs from there.
//
// This replaces the bundled Tauri sidecar, which ran the same sweep in a second
// process purely to escape the Worker's CPU/subrequest limits. Self-hosted there
// are no such limits, and running in-process means a single writer on the
// database — the sidecar would otherwise still be writing to the OLD cloud D1.
//
// trigger:'run-now' also bypasses the wholeset self-throttle, and the
// modeOverride is per-run only — config.scan_mode is never mutated.
// ---------------------------------------------------------------------------
scanRouter.post('/deep-sweep', async (c) => {
  // runScan reports the run id via onRunOpened, immediately after INSERTing the
  // scan_runs row and long before the sweep finishes.
  let signalOpened: (runId: number) => void = () => {};
  const opened = new Promise<number>((resolve) => { signalOpened = resolve; });

  const scan = runScan(
    c.env,
    { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
    { onRunOpened: signalOpened },
  );
  detach(c, scan, 'deep-sweep');

  // onRunOpened effectively always wins this race. The summary is the fallback
  // for the pathological case where the scan fails between opening the row and
  // invoking the callback — runScan always resolves, so this cannot hang.
  const runId = await Promise.race([opened, scan.then((s) => s.runId)]);

  return c.json({ started: true, runId });
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
