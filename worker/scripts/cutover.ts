/**
 * cutover.ts — switch Card // Broker from the Cloudflare backend to the
 * self-hosted one, in the one order that is safe.
 *
 * Run this ONCE, after `install-service.ps1` has the local backend running.
 *
 * The steps and why they are sequenced this way:
 *
 *  1. QUIESCE THE CLOUD. PATCH the Worker's config.scan_interval_minutes to a
 *     month so the hourly cron stops scanning. Two reasons: the cloud scan
 *     competes with this copy for the same daily D1 row-read budget, and once
 *     the local backend is also scanning, both would push the SAME deals to
 *     Telegram — the cloud has its own copy of the bot token. This is a config
 *     change, not a deploy, so it needs no wrangler credentials and is
 *     reversible from the desktop app's Settings.
 *
 *  2. STOP THE LOCAL BACKEND. Its heartbeat writes scan_runs rows; copying into
 *     a database that is being written produces id collisions.
 *
 *  3. COPY. migrate-from-d1 --fresh — a clean, complete copy rather than a merge
 *     into whatever the local heartbeat already wrote.
 *
 *  4. VERIFY. Row counts per table must match remote exactly, or the cutover
 *     aborts before anything points at the local database.
 *
 *  5. POINT THE DESKTOP AT LOCALHOST. Rewrites VITE_API_BASE_URL in
 *     desktop/.env.local, keeping a .bak.
 *
 *  6. RESTART THE LOCAL BACKEND, now against the copied data.
 *
 * If step 3 or 4 fails — the daily row-read cap is the likely cause — nothing
 * downstream runs, the desktop stays pointed at the cloud, and re-running this
 * command resumes the copy from where it stopped.
 *
 * Usage:
 *   npx tsx scripts/cutover.ts             full cutover
 *   npx tsx scripts/cutover.ts --dry-run   print the plan, change nothing
 *
 * The Worker and the D1 database are NOT deleted — winding those down is a
 * separate, deliberate step once the local stack has proven itself.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeVarGetter, requireKeys, resolveWorkerDir } from './vars';

const CLOUD_API = 'https://cardtrader-deal-scanner.beresi.workers.dev';
const LOCAL_API = 'http://127.0.0.1:8787';

/** ~30 days. Large enough to be plainly "off", still a valid interval the
 *  Settings UI can display and the owner can dial back down. */
const QUIESCED_INTERVAL_MINUTES = 43_200;

const dryRun = process.argv.includes('--dry-run');

function log(msg: string): void { process.stdout.write(`${msg}\n`); }
function step(n: number, msg: string): void { log(`\n[${n}/6] ${msg}`); }

/**
 * Stop or restart the backend by delegating to install-service.ps1.
 *
 * NOT `schtasks /end`: the task launches the server through a .vbs shim that
 * returns immediately, so the task reaches "Ready" within a second while the
 * node process keeps running orphaned from it. `/end` would report success and
 * terminate nothing, and the copy below would then run against a database the
 * heartbeat is still writing to. install-service.ps1 stops the process that is
 * actually holding the port.
 */
function backendControl(mode: 'Stop' | 'Restart', workerDir: string): void {
  execFileSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File',
     path.join(workerDir, 'scripts', 'install-service.ps1'), `-${mode}`],
    { cwd: workerDir, stdio: 'inherit' },
  );
}

/**
 * Run one of the migration scripts, showing its progress live but filtering a
 * known-bogus line out of its stderr.
 *
 * On Windows, Node 24 prints
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 * after this process exits non-zero following an HTTP request. It is emitted by
 * the C runtime during event-loop teardown, AFTER our code has finished, so it
 * cannot be prevented from inside the script.
 *
 * It is noise, not a failure: the real message is already printed, the exit code
 * is correct, and every page copied before the error was committed. But the
 * normal way to end a copy is hitting D1's daily row-read cap, and a line
 * screaming "Assertion failed" underneath a calm "resume after midnight UTC"
 * makes a routine pause look like a crash. So stderr is captured and that one
 * line dropped; everything else is passed through untouched.
 *
 * Reproduced under tsx and plain node, with better-sqlite3 loaded, not loaded,
 * and never imported — it is none of those. It could not be reproduced in any
 * isolated script, so it is filtered rather than fixed.
 *
 * Crucially the assertion ABORTS the process, replacing the script's exit code
 * with 0xC0000409 (3221226505). So the exit code cannot be trusted in either
 * direction, and success is determined from the "RESULT ok" line the script
 * writes before teardown instead. Without that, a completed copy could be
 * reported as a failure purely because of this artifact.
 *
 * Throws if the script did not report success.
 */
function runMigration(workerDir: string, args: string[]): void {
  const result = spawnSync(
    process.execPath,
    [path.join(workerDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
     path.join(workerDir, 'scripts', 'migrate-from-d1.ts'), ...args],
    // stdout inherited so per-table progress streams live; stderr piped so it
    // can be filtered and inspected for the verdict.
    { cwd: workerDir, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf-8' },
  );

  const raw = result.stderr ?? '';

  const shown = raw
    .split('\n')
    .filter((line) => !line.includes('UV_HANDLE_CLOSING') && !line.includes('] RESULT '))
    .join('\n');
  if (shown.trim()) { process.stderr.write(shown); }

  if (!raw.includes('[migrate-from-d1] RESULT ok')) {
    throw new Error(
      `migrate-from-d1 ${args.join(' ')} did not complete successfully. ` +
      'Nothing downstream of this step ran; re-running resumes the copy.',
    );
  }
}

/** Is anything answering on the local API? Used to confirm the stop took effect. */
async function localBackendUp(authToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_API}/api/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const workerDir = resolveWorkerDir();
  const get = makeVarGetter();
  requireKeys(get, ['CF_API_TOKEN', 'DESKTOP_AUTH_TOKEN']);
  const authToken = get('DESKTOP_AUTH_TOKEN')!;

  log('');
  log('=== Card // Broker — cutover to self-hosted ===');
  if (dryRun) { log('    DRY RUN — nothing will be changed.'); }

  // -- 1. Quiesce the cloud scanner -----------------------------------------
  step(1, 'Quiescing the Cloudflare scan cadence');
  if (dryRun) {
    log(`      would PATCH ${CLOUD_API}/api/config  scan_interval_minutes=${QUIESCED_INTERVAL_MINUTES}`);
  } else {
    const res = await fetch(`${CLOUD_API}/api/config`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_interval_minutes: QUIESCED_INTERVAL_MINUTES }),
    });
    if (!res.ok) {
      throw new Error(
        `Could not quiesce the cloud scanner (HTTP ${res.status}). ` +
        'If this is the D1 row-read cap, wait for the midnight-UTC reset and re-run. ' +
        'Cutting over while the cloud cron still scans would double-push every deal to Telegram.',
      );
    }
    log(`      cloud scan interval set to ${QUIESCED_INTERVAL_MINUTES} min — the cron will no longer scan`);
  }

  // -- 2. Stop the local backend --------------------------------------------
  step(2, 'Stopping the local backend so the copy sees a quiet database');
  if (dryRun) {
    log('      would run: install-service.ps1 -Stop');
  } else {
    backendControl('Stop', workerDir);
    // Confirm rather than assume — copying into a database the heartbeat is
    // still writing produces scan_runs id collisions.
    if (await localBackendUp(authToken)) {
      throw new Error(
        'The local backend is still responding after the stop. Refusing to copy into a ' +
        'live database. Stop it manually (install-service.ps1 -Stop) and re-run.',
      );
    }
    log('      confirmed stopped');
  }

  // -- 3. Copy ---------------------------------------------------------------
  step(3, 'Copying D1 → local SQLite (this is the long one)');
  if (dryRun) {
    log('      would run: tsx scripts/migrate-from-d1.ts --fresh');
  } else {
    runMigration(workerDir, ['--fresh']);
  }

  // -- 4. Verify -------------------------------------------------------------
  step(4, 'Verifying row counts match remote');
  if (dryRun) {
    log('      would run: tsx scripts/migrate-from-d1.ts --verify');
  } else {
    // migrate-from-d1 exits non-zero on a mismatch, so runMigration throws if
    // any table was short. Reaching here means every table matched remote.
    runMigration(workerDir, ['--verify']);
  }

  // -- 5. Point the desktop at localhost -------------------------------------
  step(5, 'Pointing the desktop app at the local backend');
  const envPath = path.join(workerDir, '..', 'desktop', '.env.local');
  if (!fs.existsSync(envPath)) {
    log(`      ! ${envPath} not found — set VITE_API_BASE_URL=${LOCAL_API} by hand`);
  } else if (dryRun) {
    log(`      would rewrite VITE_API_BASE_URL in ${envPath} to ${LOCAL_API}`);
  } else {
    const before = fs.readFileSync(envPath, 'utf-8');
    fs.writeFileSync(`${envPath}.bak`, before);
    const after = before.replace(
      /^VITE_API_BASE_URL=.*$/m,
      `VITE_API_BASE_URL=${LOCAL_API}`,
    );
    fs.writeFileSync(envPath, after);
    log(`      ${envPath} → ${LOCAL_API}  (previous saved as .env.local.bak)`);
  }

  // -- 6. Restart ------------------------------------------------------------
  step(6, 'Restarting the local backend against the copied data');
  if (dryRun) {
    log('      would run: install-service.ps1 -Restart');
  } else {
    backendControl('Restart', workerDir);
    try {
      const res = await fetch(`${LOCAL_API}/api/health`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const body = await res.json() as { db_ok?: boolean; active_watch_count?: number | null };
      log(`      local backend healthy — db_ok=${body.db_ok}, watchlist items=${body.active_watch_count}`);
    } catch {
      log('      ! could not reach the local backend yet — check');
      log('        powershell -File scripts\\install-service.ps1 -Status');
    }
  }

  log('');
  log('Cutover complete.');
  log('');
  log('  • The desktop app now talks to 127.0.0.1 — restart it (or `npm run tauri dev`).');
  log('  • The Cloudflare Worker and D1 are still there, quiesced, as a backup.');
  log('  • Scans, Telegram pushes and the API now run entirely on this PC,');
  log('    with no row-read, subrequest or CPU ceiling.');
  log('');
}

main().catch((e) => {
  process.stderr.write(`\n[cutover] ${e instanceof Error ? e.message : String(e)}\n`);
  process.stderr.write('Nothing downstream of the failing step was changed.\n');
  process.exitCode = 1;
});
