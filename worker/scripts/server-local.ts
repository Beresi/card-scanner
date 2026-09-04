/**
 * server-local.ts — the SELF-HOSTED backend. Replaces the Cloudflare Worker.
 *
 * One process provides both halves of what the Worker did:
 *   • the HTTP API — the SAME Hono `app` from src/index.ts, served over node:http
 *   • the scan cron — the SAME heartbeatTick() from src/index.ts, on a 60s timer
 *
 * Neither is reimplemented here. src/index.ts exports both, so a route or a
 * scheduling change lands in the cloud build and this one simultaneously. The
 * only differences between deployments are the transport and the timer.
 *
 * Persistence is a local SQLite file behind the same D1 contract
 * (scripts/d1-sqlite.ts), so src/db/repo.ts is byte-for-byte unchanged.
 *
 * Why this exists: Cloudflare's free tier caps D1 row reads per day, Worker
 * subrequests per invocation, and CPU per request. A full catalog scan hits all
 * three. Locally there is no such ceiling — the only real limit left is
 * CardTrader's own ~1 req/s throttle, which the scanner already respects.
 *
 * ─── Binding & auth ─────────────────────────────────────────────────────────
 * Binds 127.0.0.1 ONLY (never 0.0.0.0) — the API is not exposed to the LAN.
 * The DESKTOP_AUTH_TOKEN bearer gate in src/index.ts still applies on top of
 * that, unchanged, as defence in depth.
 *
 * ─── Configuration ──────────────────────────────────────────────────────────
 * Read via scripts/vars.ts (process.env → CARD_BROKER_VARS_FILE → .dev.vars.local
 * → .dev.vars):
 *   CARDTRADER_API_TOKEN   required
 *   DESKTOP_AUTH_TOKEN     required — the bearer the desktop app sends
 *   TELEGRAM_BOT_TOKEN     optional — pushes are skipped when absent
 *   TELEGRAM_CHAT_ID       optional
 *   CARD_BROKER_DB         optional — SQLite path (default: %APPDATA%/CardBroker/cardbroker.db)
 *   CARD_BROKER_PORT       optional — default 8787 (matches the wrangler dev port
 *                          the desktop client already falls back to)
 *
 * Note that CF_API_TOKEN is NOT required. Self-hosting needs no Cloudflare
 * credentials at all.
 *
 * ─── Run ────────────────────────────────────────────────────────────────────
 *   npm run serve:local                 (foreground, from the repo)
 *   scripts/install-service.ps1         (background, at logon — the real deploy)
 *
 * SECURITY: no secret value is ever written to stdout or stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { app, heartbeatTick, type Env } from '../src/index';
import { openLocalD1 } from './d1-sqlite';
import { bootstrapLocalDb, verifySchema } from './db-bootstrap';
import { makeVarGetter, requireKeys } from './vars';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heartbeat period. Matches the Worker's 1-minute cron exactly; the real scan
 *  cadence is gated inside heartbeatTick by config.scan_interval_minutes. */
const HEARTBEAT_MS = 60_000;

/** Loopback only — the API must never be reachable from the network. */
const HOST = '127.0.0.1';

const DEFAULT_PORT = 8787;

// ---------------------------------------------------------------------------
// Database location
// ---------------------------------------------------------------------------

/**
 * Resolve the SQLite file path.
 *
 * Default lives under the OS per-user application-data directory rather than in
 * the repo, so `git clean`, a reinstall, or moving the checkout cannot destroy
 * the deal history. Overridable with CARD_BROKER_DB.
 */
function resolveDbPath(get: (k: string) => string | undefined): string {
  const explicit = get('CARD_BROKER_DB');
  if (explicit) { return path.resolve(explicit); }

  const base =
    process.env.APPDATA ??                                  // Windows
    (process.env.HOME ? path.join(process.env.HOME, '.local', 'share') : '') ??
    process.cwd();

  return path.join(base, 'CardBroker', 'cardbroker.db');
}

// ---------------------------------------------------------------------------
// Logging (never prints a secret — only presence flags)
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function logErr(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function main(): void {
  const get = makeVarGetter();

  // CARDTRADER_API_TOKEN — the scanner cannot work without it.
  // DESKTOP_AUTH_TOKEN   — the /api/* bearer gate would reject every request
  //                        with an empty expected value, so require it too.
  requireKeys(get, ['CARDTRADER_API_TOKEN', 'DESKTOP_AUTH_TOKEN']);

  const dbPath = resolveDbPath(get);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const port = Number(get('CARD_BROKER_PORT') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logErr(`Invalid CARD_BROKER_PORT — expected 1-65535`);
    process.exit(1);
  }

  log('Card // Broker — self-hosted backend starting');
  log(`  database : ${dbPath}`);
  log(`  listen   : http://${HOST}:${port}`);
  log(`  telegram : ${get('TELEGRAM_BOT_TOKEN') && get('TELEGRAM_CHAT_ID') ? 'configured' : 'not configured (pushes skipped)'}`);

  // --- Open + bootstrap the database ---------------------------------------
  const { db, raw } = openLocalD1(dbPath);

  const report = bootstrapLocalDb(raw);
  if (report.created) {
    log(`  schema   : created fresh (${report.baselined.length} migrations baselined)`);
  } else if (report.applied.length > 0) {
    log(`  schema   : applied ${report.applied.join(', ')}`);
  } else {
    log('  schema   : current');
  }

  // Guard the "schema.sql is current" assumption — see db-bootstrap.ts.
  const missing = verifySchema(raw);
  if (missing.length > 0) {
    logErr(`FATAL: database is missing expected columns: ${missing.join(', ')}`);
    logErr('Refusing to start — the schema is not at the shape the code expects.');
    process.exit(1);
  }

  // --- Build the Env the Worker code expects -------------------------------
  // Structurally identical to the Cloudflare binding set; DB is the SQLite
  // adapter instead of the D1 binding. No downstream code can tell the difference.
  const env: Env = {
    DB: db,
    CARDTRADER_API_TOKEN: get('CARDTRADER_API_TOKEN')!,
    TELEGRAM_BOT_TOKEN: get('TELEGRAM_BOT_TOKEN') ?? '',
    TELEGRAM_CHAT_ID: get('TELEGRAM_CHAT_ID') ?? '',
    DESKTOP_AUTH_TOKEN: get('DESKTOP_AUTH_TOKEN')!,
  };

  // --- HTTP server ----------------------------------------------------------
  // Hono's Env bindings arrive per-request via the third `serve` argument in
  // workerd; on Node we inject them through the fetch wrapper instead.
  const server = serve(
    {
      fetch: (request: Request) => app.fetch(request, env),
      hostname: HOST,
      port,
    },
    (info) => log(`API listening on http://${HOST}:${info.port}`),
  );

  // --- Heartbeat ------------------------------------------------------------
  // A guard flag, not a queue: if a tick is still running when the next fires,
  // the new one is dropped. The Cloudflare cron had the same property (an
  // overlapping invocation would find a RUNNING scan_runs row and self-throttle),
  // and dropping is correct — ticks are idempotent checks, not work items.
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) { return; }
    ticking = true;
    try {
      await heartbeatTick(env);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, HEARTBEAT_MS);

  // Run one tick immediately so a machine that was asleep past its scan window
  // catches up on boot rather than waiting out a full heartbeat.
  void tick();

  // --- Shutdown -------------------------------------------------------------
  // Close the SQLite handle explicitly so WAL is checkpointed cleanly.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) { return; }
    closing = true;
    log(`${signal} received — shutting down`);
    clearInterval(timer);
    server.close(() => {
      try { raw.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    // Hard stop if a long scan keeps the loop alive past a grace period.
    setTimeout(() => {
      try { raw.close(); } catch { /* already closed */ }
      process.exit(0);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash in a detached background service must be visible in the log rather
  // than silently killing the process.
  process.on('unhandledRejection', (reason) => {
    logErr(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

main();
