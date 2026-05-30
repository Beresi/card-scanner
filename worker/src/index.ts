import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { runScan } from './scan/scanner';
import { scanRouter } from './api/scan';
import { telegramRouter } from './api/telegram';
import { configRouter } from './api/config';
import { watchlistRouter } from './api/watchlist';
import { dealsRouter } from './api/deals';
import { resolveRouter } from './api/resolve';

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
// Returns service liveness and timestamp.
// Exposes token *status* only (present/absent) — never the token value itself.
// Full health detail (latest scan_run, CardTrader token ok) will be added in Phase 1
// once the scanner and repo helpers exist.
app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'card-broker',
    ts: new Date().toISOString(),
    // Phase 1 additions: last_scan_at, last_scan_error, cardtrader_token_ok
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

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── Worker export ────────────────────────────────────────────────────────────
export default {
  // HTTP API — all requests routed through the Hono app above.
  fetch: app.fetch,

  // Hourly cron handler (wrangler.toml: crons = ["0 * * * *"], UTC).
  // Shares the exact same runScan entry point as POST /api/scan/run-now — no forked logic
  // (PRD §4/§11).  ctx.waitUntil keeps the isolate alive for the full async scan.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScan(env, { trigger: 'cron' }));
  },
} satisfies ExportedHandler<Env>;
