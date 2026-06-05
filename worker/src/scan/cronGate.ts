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
