/**
 * Pure helper for the configurable-interval heartbeat gate in scheduled().
 *
 * The Worker runs a 1-minute cron heartbeat (wrangler.toml: "* * * * *") so
 * the scan cadence can be changed at runtime without a redeploy. On each tick,
 * `shouldRunCron` decides whether enough minutes have elapsed since the last
 * scan started.
 *
 * Rules:
 *  - No previous run (lastStartedAtIso = null) → ALWAYS run (first ever scan).
 *  - Minutes since last run < intervalMinutes   → skip (too soon).
 *  - Minutes since last run >= intervalMinutes  → run (boundary is inclusive).
 *
 * @param lastStartedAtIso  `started_at` of the most recent scan_runs row (any
 *   status — in-progress counts so an already-running scan doesn't spawn a
 *   second one). The value is a UTC SQLite datetime string WITHOUT a 'Z' suffix;
 *   this function appends 'Z' to parse it as UTC (matches existing repo patterns).
 *   Pass null when no row exists.
 * @param intervalMinutes   Minimum minutes between runs (config.scan_interval_minutes).
 * @param nowMs             Current epoch ms (pass Date.now() in production; injectable for tests).
 * @returns true to proceed with the scan, false to skip this tick.
 */
export function shouldRunCron(
  lastStartedAtIso: string | null,
  intervalMinutes: number,
  nowMs: number,
): boolean {
  if (lastStartedAtIso === null) {
    return true; // No prior run — always run on first tick.
  }
  const lastMs = new Date(lastStartedAtIso + 'Z').getTime();
  const minsSince = (nowMs - lastMs) / 60_000;
  return minsSince >= intervalMinutes;
}

/** Minimum hours between daily-maintenance passes (expire-stale + prune-archived). */
export const MAINTENANCE_INTERVAL_HOURS = 24;

/**
 * Gate for the once-daily maintenance job in scheduled() (migration 0013).
 *
 * Mirrors {@link shouldRunCron}: on each 1-minute heartbeat, decide whether at
 * least MAINTENANCE_INTERVAL_HOURS have elapsed since the last maintenance pass.
 *
 * @param lastMaintenanceAtIso  `config.last_maintenance_at` — a UTC SQLite
 *   datetime string WITHOUT a 'Z' suffix, or null when maintenance has never run
 *   (→ always run). 'Z' is appended to parse as UTC, matching repo patterns.
 * @param nowMs  Current epoch ms (Date.now() in production; injectable for tests).
 * @returns true to run maintenance this tick, false to skip.
 */
export function shouldRunMaintenance(
  lastMaintenanceAtIso: string | null,
  nowMs: number,
): boolean {
  if (lastMaintenanceAtIso === null) {
    return true; // Never run — do it now.
  }
  const lastMs = new Date(lastMaintenanceAtIso + 'Z').getTime();
  const hoursSince = (nowMs - lastMs) / 3_600_000;
  return hoursSince >= MAINTENANCE_INTERVAL_HOURS;
}
