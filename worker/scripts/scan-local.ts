/**
 * scan-local.ts — Manual "deep-sweep" CLI entry point / Tauri sidecar.
 *
 * Runs the EXISTING scan path (runScan) on the local machine against the SAME
 * production Cloudflare D1 database the hourly cron and desktop app use. Bypasses
 * the Worker free-tier subrequest/CPU limits by running as a long-lived Node process.
 *
 * Usage (terminal):
 *   npm run scan:local
 *
 * Usage (Tauri sidecar):
 *   All configuration is injected via environment variables (process.env).
 *   The sidecar does NOT require a .dev.vars.local file.
 *
 * What it does:
 *   1. Loads credentials from process.env (priority) or worker/.dev.vars.local
 *      (optional fallback for terminal use), via env-local.ts.
 *   2. Builds a D1Database-shaped adapter over the Cloudflare D1 REST API.
 *   3. Calls runScan(env, { trigger: 'run-now', modeOverride: 'wholeset' }) —
 *      wholeset mode scans every expansion in one pass (no chunked rotation cap),
 *      run-now trigger bypasses the 55-minute wholeset self-throttle.
 *   4. Emits structured JSON lines to stdout (machine-readable for the Rust host)
 *      and human-readable progress to stderr.
 *
 * --- JSON-lines contract (stdout) ---
 *
 *   started:   {"event":"started","runId":<number>}
 *              Emitted immediately after the scan_runs row is opened. The Rust
 *              host can read this to know the run is live and obtain the runId.
 *
 *   done:      {"event":"done","summary":{
 *                "runId":<number>,
 *                "watchItemsScanned":<number>,
 *                "blueprintsScanned":<number>,
 *                "apiCalls":<number>,
 *                "dealsFound":<number>,
 *                "telegramSent":<number>,
 *                "error":<string|null>
 *              }}
 *              Emitted on successful scan completion (even if summary.error is set).
 *
 *   error:     {"event":"error","message":"<safe message, no secrets>"}
 *              Emitted on a fatal pre-scan error (e.g. missing env vars) then
 *              process exits 1. Also emitted by env-local on missing keys.
 *
 * Exit codes:
 *   0  — scan completed and summary.error is null.
 *   1  — fatal pre-scan error OR summary.error is non-null.
 *
 * Security invariant: NO secret value is ever printed to stdout or stderr.
 * Token values are consumed internally and never appear in log output.
 *
 * The Cloudflare hourly cron is completely unaffected — it calls runScan with
 * { trigger: 'cron' } and no modeOverride, so behavior is byte-for-byte unchanged.
 */

import { loadEnv } from './env-local';
import { runScan } from '../src/scan/scanner';
import type { ScanSummary } from '../src/scan/scanner';
import { resyncCatalog } from './catalogResync';

// ---------------------------------------------------------------------------
// JSON-line emitters (stdout = machine; stderr = human)
// ---------------------------------------------------------------------------

/** Emit a single JSON line to stdout. Stdout must be line-buffered by the host. */
function emitJson(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Format elapsed milliseconds as a human-readable string: "12.3s" or "2m 7.4s". */
function fmtElapsed(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) { return `${totalSec.toFixed(1)}s`; }
  const minutes = Math.floor(totalSec / 60);
  const secs = totalSec - minutes * 60;
  return `${minutes}m ${secs.toFixed(1)}s`;
}

/** Right-pad a label to a fixed width for aligned stderr output. */
function pad(label: string, width = 24): string {
  return label.padEnd(width);
}

/**
 * Belt-and-suspenders secret redaction for any string headed to stdout/stderr.
 * The scanner is written never to put a token in an error, but an upstream
 * fetch/URL failure could in theory carry one — strip Bearer tokens and the
 * CardTrader token prefix before any output.
 */
function redact(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ct_live_\S+/gi, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// Catalog-resync task — full-heal blueprint re-pull (Settings → Maintenance).
//
// Selected via CARD_BROKER_TASK=catalog-resync. Shares the same env loader and
// JSON-lines contract as the scan task:
//   started: {"event":"started","task":"catalog-resync","totalSets":N}
//   done:    {"event":"done","summary":{ totalSets, ok, failed, grew }}
//   error:   {"event":"error","message":"<safe>"}
// The Rust host returns to the UI as soon as "started" is observed; the re-pull
// continues detached (~13 min for a full run at ~1 req/s).
// ---------------------------------------------------------------------------

async function runCatalogResyncTask(): Promise<void> {
  const startMs = Date.now();

  process.stderr.write('\n');
  process.stderr.write('=== Card // Broker — local catalog re-sync (full heal) ===\n');
  process.stderr.write(`Started at: ${new Date().toISOString()}\n`);
  process.stderr.write('Target:     production D1 (same DB as the cron and desktop app)\n');
  process.stderr.write('\n');

  const env = loadEnv();

  const summary = await resyncCatalog(
    env,
    {},
    {
      onStart: (totalSets) => {
        emitJson({ event: 'started', task: 'catalog-resync', totalSets });
        process.stderr.write(`[catalog-resync] re-pulling ${totalSets} sets...\n`);
      },
      onSet: ({ index, total, id, name, count, delta, error }) => {
        const prefix = `[${index + 1}/${total}] #${id} ${name}`;
        if (error) {
          process.stderr.write(`${prefix} → FAILED: ${redact(error)}\n`);
        } else {
          const deltaStr = delta && delta > 0 ? ` (+${delta})` : '';
          process.stderr.write(`${prefix} → ${count} blueprints${deltaStr}\n`);
        }
      },
    },
  );

  emitJson({
    event: 'done',
    summary: {
      totalSets: summary.totalSets,
      ok: summary.ok,
      failed: summary.failed,
      grew: summary.grew,
    },
  });

  const elapsed = Date.now() - startMs;
  process.stderr.write('\n=== Catalog re-sync complete ===\n');
  process.stderr.write(`${pad('Sets pulled:')}${summary.totalSets}\n`);
  process.stderr.write(`${pad('Synced OK:')}${summary.ok}\n`);
  process.stderr.write(`${pad('Grew (new cards):')}${summary.grew}\n`);
  process.stderr.write(`${pad('Failed:')}${summary.failed}\n`);
  process.stderr.write(`${pad('Elapsed:')}${fmtElapsed(elapsed)}\n\n`);

  process.exit(summary.failed > 0 && summary.ok === 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Task dispatch — the sidecar binary is shared. CARD_BROKER_TASK selects the
  // job; absent/"scan" runs the default deep-sweep below.
  if (process.env.CARD_BROKER_TASK === 'catalog-resync') {
    await runCatalogResyncTask();
    return;
  }

  const startMs = Date.now();

  // Human-readable header → stderr only.
  process.stderr.write('\n');
  process.stderr.write('=== Card // Broker — local deep-sweep scan ===\n');
  process.stderr.write(`Started at: ${new Date().toISOString()}\n`);
  process.stderr.write('Mode:       wholeset (all watched expansions, no chunked cap)\n');
  process.stderr.write('Trigger:    run-now (wholeset self-throttle bypassed)\n');
  process.stderr.write('Target:     production D1 (same DB as the cron and desktop app)\n');
  process.stderr.write('\n');

  // loadEnv() fails fast and exits 1 if any required key is missing.
  // On missing keys it emits {"event":"error",...} to stdout before exiting.
  const env = loadEnv();

  // Log non-secret context → stderr only. Never print token values.
  process.stderr.write(`Account ID:  ${env.CF_ACCOUNT_ID}\n`);
  process.stderr.write(`Database ID: ${env.CF_D1_DATABASE_ID}\n`);
  process.stderr.write(`Telegram:    ${env.TELEGRAM_BOT_TOKEN ? 'configured (pushes enabled)' : 'not configured (pushes suppressed)'}\n`);
  process.stderr.write('\n');
  process.stderr.write('Running scan...\n');
  process.stderr.write('\n');

  // Run the scan. The onRunOpened callback fires immediately after openScanRun
  // returns so the Rust host can observe the runId before the scan completes.
  let summary: ScanSummary;
  try {
    summary = await runScan(
      env,
      { trigger: 'run-now', modeOverride: 'wholeset', liveProgress: true },
      {
        onRunOpened: (runId) => {
          // Machine event: the scan row is live. Emit before any API calls.
          emitJson({ event: 'started', runId });
          process.stderr.write(`[scan-local] scan_runs row opened (runId=${runId})\n`);
        },
      },
    );
  } catch (err) {
    // runScan always resolves, so this catch is a belt-and-suspenders guard for
    // unexpected import/runtime failures.
    const safe = redact(err instanceof Error ? err.message : String(err));
    emitJson({ event: 'error', message: safe });
    process.stderr.write(`[scan-local] fatal: ${safe}\n`);
    process.exit(1);
  }

  // Redact any secret that could have ridden along in a scan-level error
  // message before it reaches stdout (done event) or stderr below.
  if (summary.error !== null) {
    summary = { ...summary, error: redact(summary.error) };
  }

  const elapsed = Date.now() - startMs;

  // Machine event: scan complete.
  emitJson({ event: 'done', summary });

  // Human-readable summary → stderr.
  process.stderr.write('=== Scan complete ===\n');
  process.stderr.write('\n');
  process.stderr.write(`${pad('Run ID:')}${summary.runId}\n`);
  process.stderr.write(`${pad('Watch items scanned:')}${summary.watchItemsScanned}\n`);
  process.stderr.write(`${pad('Blueprints scanned:')}${summary.blueprintsScanned}\n`);
  process.stderr.write(`${pad('API calls:')}${summary.apiCalls}\n`);
  process.stderr.write(`${pad('Deals found (new):')}${summary.dealsFound}\n`);
  process.stderr.write(`${pad('Telegram sent:')}${summary.telegramSent}\n`);
  process.stderr.write(`${pad('Error:')}${summary.error ?? 'none'}\n`);
  process.stderr.write(`${pad('Elapsed:')}${fmtElapsed(elapsed)}\n`);
  process.stderr.write('\n');

  if (summary.error !== null) {
    process.stderr.write(`Scan finished with error: ${summary.error}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  // Unexpected throw — belt-and-suspenders guard; runScan always resolves.
  // Redact anything that looks like a bearer token before printing.
  const raw = err instanceof Error ? err.message : String(err);
  const safe = raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ct_live_\S+/gi, '[REDACTED]');
  emitJson({ event: 'error', message: safe });
  process.stderr.write(`[scan-local] fatal: ${safe}\n`);
  process.exit(1);
});
