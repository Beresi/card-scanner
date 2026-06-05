import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { runScan } from './scan/scanner';
import { shouldRunCron } from './scan/cronGate';
import { scanRouter } from './api/scan';
import { telegramRouter } from './api/telegram';
import { configRouter } from './api/config';
import { watchlistRouter } from './api/watchlist';
import { dealsRouter } from './api/deals';
import { resolveRouter } from './api/resolve';
import { cartRouter } from './api/cart';
import { catalogRouter } from './api/catalog';
import {
  getLatestScanRun,
  getConfig,
  reapStaleScanRuns,
  listActiveWatchlist,
  countActiveExpansionBlueprints,
  countActiveCardBlueprints,
  countActiveWatchlist,
  countScannedThisCycle,
} from './db/repo';

// ─── Environment bindings ─────────────────────────────────────────────────────
// DB        — Cloudflare D1 binding (name "DB" matches wrangler.toml [[d1_databases]])
// Secrets   — provisioned via `wrangler secret put <NAME>`; never in source or logs.
//             CARDTRADER_API_TOKEN has read+write/purchase scope — treat as high-sensitivity.
export interface Env {
  DB: D1Database;
  CARDTRADER_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  // Auth token the Tauri desktop client sends as a Bearer in every /api/* request.
  // Provisioned the same way as the other secrets.
  DESKTOP_AUTH_TOKEN: string;
}

// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// ── CORS ───────────────────────────────────────────────────────────────────────
// The desktop client is a browser/webview, so cross-origin /api/* calls need CORS.
// Registered BEFORE the auth gate so the preflight OPTIONS (which carries no
// Authorization header) is answered with CORS headers instead of a 401.
// The bearer token — not the origin — is the security boundary (no cookies are
// used), so we simply reflect trusted dev/desktop origins: localhost (any port,
// Vite dev + `tauri dev`) and the Tauri production webview origin (tauri.localhost).
const ALLOWED_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|(tauri|https?):\/\/tauri\.localhost)$/;
app.use('/api/*', cors({
  origin: (origin) => (origin && ALLOWED_ORIGIN.test(origin) ? origin : ''),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

// ── Auth gate ────────────────────────────────────────────────────────────────
// Every /api/* route is behind this middleware.  It compares the Authorization
// header ("Bearer <token>") against DESKTOP_AUTH_TOKEN.  No route below reads or
// writes D1 without passing this check (PRD §12).
app.use('/api/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== c.env.DESKTOP_AUTH_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

// ── GET /api/health ───────────────────────────────────────────────────────────
// Returns service liveness, timestamp, DB reachability, and latest scan telemetry.
// Exposes token *status* only (present/absent) — never the token value itself.
// Never 500s: DB errors are caught and surfaced as db_ok:false with null scan fields.
app.get('/api/health', async (c) => {
  let db_ok = false;
  let last_scan_at: string | null = null;
  let last_scan_finished_at: string | null = null;
  let last_scan_error: string | null = null;
  let deals_found: number | null = null;
  let telegram_sent: number | null = null;
  let api_calls: number | null = null;

  // Cycle progress fields (scan_mode, scan_total, scan_done).
  // Default to safe fallback values — errors here must never 500 the health endpoint.
  let scan_mode = 'chunked';
  let scan_total = 0;
  let scan_done = 0;

  try {
    const run = await getLatestScanRun(c.env.DB);
    db_ok = true;
    if (run !== null) {
      last_scan_at = run.started_at;
      last_scan_finished_at = run.finished_at;
      last_scan_error = run.error;
      deals_found = run.deals_found;
      telegram_sent = run.telegram_sent;
      api_calls = run.api_calls;
    }
  } catch {
    // DB unreachable — report status, keep ok:true (liveness is separate from DB health)
    db_ok = false;
  }

  // active_watch_count: number of watchlist rows where active = 1.
  // Lets the desktop distinguish "nothing watched (idle)" from "caching sets…".
  // Default to null so the field is absent-safe on DB error.
  let active_watch_count: number | null = null;

  // Compute cycle progress — wrapped independently so an error here never affects
  // the existing scan_run fields or the ok/db_ok response structure.
  try {
    const config = await getConfig(c.env.DB);
    const watchlist = await listActiveWatchlist(c.env.DB);

    // Split active watchlist by type.
    const activeExpansionIds = watchlist
      .filter((w) => w.type === 'expansion')
      .map((w) => w.cardtrader_id)
      .filter((id): id is number => id !== null);

    const activeCardItems = watchlist
      .filter((w) => w.type === 'card')
      .map((w) => ({ card_name_norm: w.card_name_norm, expansion_filter: w.expansion_filter }));

    scan_mode = config.scan_mode;

    // scan_total = expansion-derived blueprints + card-derived blueprints (deduped,
    // not double-counting expansion-owned blueprints).
    const expansionTotal = await countActiveExpansionBlueprints(c.env.DB, activeExpansionIds);
    const cardTotal = await countActiveCardBlueprints(c.env.DB, activeCardItems, activeExpansionIds);
    scan_total = expansionTotal + cardTotal;

    scan_done = config.scan_cycle_started_at !== null
      ? await countScannedThisCycle(c.env.DB, activeExpansionIds, config.scan_cycle_started_at)
      : 0;
    // Clamp: scan_done must never exceed scan_total (e.g. if watchlist shrank mid-cycle).
    if (scan_done > scan_total) { scan_done = scan_total; }

    active_watch_count = await countActiveWatchlist(c.env.DB);
  } catch {
    // Non-fatal — return safe defaults computed above; never 500.
    scan_mode = 'chunked';
    scan_total = 0;
    scan_done = 0;
    active_watch_count = null;
  }

  return c.json({
    ok: true,
    service: 'card-broker',
    ts: new Date().toISOString(),
    db_ok,
    last_scan_at,
    last_scan_finished_at,
    last_scan_error,
    deals_found,
    telegram_sent,
    api_calls,
    scan_mode,
    scan_total,
    scan_done,
    // Number of watchlist rows where active=1, or null on DB error.
    // Desktop usage: null/0 → "idle"; >0 but scan_total=0 → "caching sets…"; scan_total>0 → "X/Y".
    active_watch_count,
  });
});

// ── Scan router (Phase 1) ─────────────────────────────────────────────────────
// POST /api/scan/run-now — same runScan entry point as the cron (PRD §4/§11).
app.route('/api/scan', scanRouter);

// ── Telegram router (Phase 2) ─────────────────────────────────────────────────
// POST /api/telegram/test — confirm bot+chat wiring (PRD §10).  Inert until the
// Telegram secrets are provisioned (notifier guards every send).
app.route('/api/telegram', telegramRouter);

// ── Phase 3 routes ────────────────────────────────────────────────────────────
// GET / PATCH /api/config
app.route('/api/config', configRouter);
// GET / POST / PATCH :id / DELETE :id / PATCH :id/reset
app.route('/api/watchlist', watchlistRouter);
// GET ?status&min_discount&watchlist_id&priority / PATCH :id / DELETE ?older_than_days
app.route('/api/deals', dealsRouter);
// GET /expansions?q= / GET /blueprints?expansion_id=&q=
app.route('/api/resolve', resolveRouter);
// GET /api/cart / POST /api/cart/add / POST /api/cart/remove
// NO /api/cart/purchase — auto-buy is forbidden; the owner checks out manually.
app.route('/api/cart', cartRouter);

// POST /api/catalog/sync — on-demand blueprint backfill for specific expansions.
app.route('/api/catalog', catalogRouter);

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── Worker export ────────────────────────────────────────────────────────────
export default {
  // HTTP API — all requests routed through the Hono app above.
  fetch: app.fetch,

  // 1-minute heartbeat cron handler (wrangler.toml: crons = ["* * * * *"], UTC).
  // The scan cadence is stored in config.scan_interval_minutes (default 60) so the
  // owner can change it without a redeploy. On each tick, shouldRunCron() checks how
  // many minutes have elapsed since the last scan started; if less than the configured
  // interval, this tick is silently skipped and NO scan_runs row is opened.
  //
  // POST /api/scan/run-now and the local sidecar (trigger:'run-now') always call
  // runScan directly — they are never gated. The gate is ONLY on the cron path.
  //
  // ctx.waitUntil keeps the isolate alive for the full async work.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        // Reap on EVERY heartbeat (not just inside runScan) — the interval gate
        // below skips runScan for up to scan_interval_minutes, so a cron run that
        // was hard-killed mid-scan (no finally → finished_at stays NULL) would
        // otherwise linger as "RUNNING" for a full interval. A 3-min staleness
        // bar with the blueprints_scanned=0 guard closes dead rows fast and can
        // never reap a progressing scan (which has blueprints_scanned > 0 within
        // seconds). Non-fatal: failures here must not block the gate/scan.
        try { await reapStaleScanRuns(env.DB, 3); } catch (re) {
          console.error('[scheduled] reap failed', re instanceof Error ? re.message : String(re));
        }

        const config = await getConfig(env.DB);
        const latest = await getLatestScanRun(env.DB); // newest run (any status)
        if (!shouldRunCron(latest?.started_at ?? null, config.scan_interval_minutes, Date.now())) {
          return; // too soon — skip silently, no scan_runs row opened
        }
        await runScan(env, { trigger: 'cron' });
      } catch (e) {
        console.error('[scheduled] gate/scan failed', e instanceof Error ? e.message : String(e));
      }
    })());
  },
} satisfies ExportedHandler<Env>;
