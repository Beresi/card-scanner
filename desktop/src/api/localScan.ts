/**
 * localScan.ts — the two long-running maintenance jobs: the deep-sweep scan
 * ("Scan Now") and the catalog full-heal (Settings → Maintenance).
 *
 * These used to be Tauri `invoke` calls that spawned a bundled sidecar process.
 * The sidecar existed for ONE reason: to run a sweep longer than a Cloudflare
 * Worker's CPU/subrequest budget allowed. It reached the database over the
 * Cloudflare D1 REST API.
 *
 * The backend is now self-hosted and has no such budget, so both jobs run
 * in-process behind ordinary API routes:
 *
 *   runLocalScan()          → POST /api/scan/deep-sweep
 *   runLocalCatalogResync() → POST /api/catalog/resync
 *
 * That is not just a simplification — keeping the sidecar would have been a
 * correctness bug. It writes to whichever database its own credentials point at,
 * which after the migration is the OLD cloud D1: "Scan Now" would have appeared
 * to work while its results landed somewhere the app no longer reads.
 *
 * Both routes are detached server-side. They return as soon as the job has an id
 * to report — `started: true` means STARTED, not finished — and the UI polls
 * scan_runs / catalog progress from there. The exported shapes are unchanged, so
 * App.tsx and the hooks that consume them did not need to change.
 *
 * These work in a plain browser tab as well as the desktop app; there is no
 * longer any Tauri dependency here.
 */

import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status returned by getLocalScanStatus(). */
export interface LocalScanStatus {
  /** True when the backend is reachable, i.e. the jobs below can be started. */
  configured: boolean;
  /** True when the backend has Telegram credentials, so pushes will be sent. */
  hasTelegram: boolean;
}

/** Result from runLocalScan(). */
export interface LocalScanResult {
  started: boolean;
  runId: number | null;
}

/** Result from runLocalCatalogResync(). */
export interface CatalogResyncResult {
  started: boolean;
  totalSets: number | null;
}

/** The subset of GET /api/health this module reads. */
interface HealthProbe {
  ok?: boolean;
  db_ok?: boolean;
}

// ---------------------------------------------------------------------------
// getLocalScanStatus
// ---------------------------------------------------------------------------

/**
 * Reports whether the deep-sweep and catalog jobs can be started, by probing
 * the backend's health endpoint.
 *
 * `configured` used to mean "are the sidecar's credentials present on this
 * device". With the work moved server-side it means "is the backend up and its
 * database reachable" — the backend owns the credentials now.
 *
 * Never throws: an unreachable backend returns
 * { configured: false, hasTelegram: false }, which disables the Scan Now button
 * rather than letting it fail on click.
 */
export async function getLocalScanStatus(): Promise<LocalScanStatus> {
  try {
    const health = await apiFetch<HealthProbe>('/api/health');
    const up = health.ok === true && health.db_ok === true;
    return { configured: up, hasTelegram: up };
  } catch {
    return { configured: false, hasTelegram: false };
  }
}

// ---------------------------------------------------------------------------
// runLocalScan
// ---------------------------------------------------------------------------

/**
 * Starts a deep sweep — every watched set in one uncapped pass.
 *
 * Resolves as soon as the server has opened the scan_runs row and returned its
 * id; the sweep itself continues for minutes afterwards. Poll scan_runs / health
 * for progress.
 *
 * Throws with a human-readable message if the backend cannot be reached, which
 * the caller surfaces as a toast.
 */
export async function runLocalScan(): Promise<LocalScanResult> {
  try {
    return await apiFetch<LocalScanResult>('/api/scan/deep-sweep', { method: 'POST' });
  } catch (err) {
    throw new Error(describeFailure(err, 'Deep sweep failed to start.'));
  }
}

// ---------------------------------------------------------------------------
// runLocalCatalogResync
// ---------------------------------------------------------------------------

/**
 * Starts a full-heal re-pull of every set's blueprints, bypassing the periodic
 * refresh's "new sets only" window.
 *
 * Resolves once the server knows how many sets it will pull; the re-pull runs
 * for roughly 13 minutes at CardTrader's ~1 req/s. Search results improve live
 * as sets land.
 */
export async function runLocalCatalogResync(): Promise<CatalogResyncResult> {
  try {
    return await apiFetch<CatalogResyncResult>('/api/catalog/resync', { method: 'POST' });
  } catch (err) {
    throw new Error(describeFailure(err, 'Catalog re-sync failed to start.'));
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn a fetch/ApiError into something worth showing in a toast. A failure here
 * is almost always "the backend is not running", so say that rather than
 * surfacing a bare TypeError from fetch.
 */
function describeFailure(err: unknown, fallback: string): string {
  if (err instanceof TypeError) {
    return 'Cannot reach the Card // Broker backend. Check that it is running (install-service.ps1 -Status).';
  }
  if (err instanceof Error && err.message) { return err.message; }
  return fallback;
}
