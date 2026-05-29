import { Hono } from 'hono';

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

// ── TODO — Phase 1+ routes (do not implement here) ───────────────────────────
// Mount thin Hono sub-routers once their controllers exist in api/:
//
//   import { configRouter }    from './api/config';
//   import { watchlistRouter } from './api/watchlist';
//   import { dealsRouter }     from './api/deals';
//   import { resolveRouter }   from './api/resolve';
//   import { scanRouter }      from './api/scan';      // POST /api/scan/run-now
//   import { telegramRouter }  from './api/telegram';  // POST /api/telegram/test
//
//   app.route('/api/config',    configRouter);    // GET / PATCH
//   app.route('/api/watchlist', watchlistRouter); // GET / POST / PATCH :id / DELETE :id / PATCH :id/reset
//   app.route('/api/deals',     dealsRouter);     // GET ?status&min_discount&watchlist_id&priority
//                                                 // PATCH :id / DELETE ?older_than_days
//   app.route('/api/resolve',   resolveRouter);   // GET /expansions?q= / GET /blueprints?expansion_id&q=
//   app.route('/api/scan',      scanRouter);      // POST /run-now → calls runScan(env, {trigger:'run-now'})
//   app.route('/api/telegram',  telegramRouter);  // POST /test → calls notifier
//
// Rule: route handlers are thin controllers — validate input, delegate to repo.ts /
// scanner / notifier, return snake_case JSON.  No business logic, no raw SQL here.

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── Worker export ────────────────────────────────────────────────────────────
export default {
  // HTTP API — all requests routed through the Hono app above.
  fetch: app.fetch,

  // Hourly cron handler (wrangler.toml: crons = ["0 * * * *"], UTC).
  // Phase 1: replace the console.log with `ctx.waitUntil(runScan(env, { trigger: 'cron' }))`.
  // This must share the SAME runScan entry point as POST /api/scan/run-now — no forked logic
  // (PRD §4/§11).  ctx.waitUntil keeps the isolate alive for the full async scan.
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Phase 0 stub — scan engine does not exist yet.
    // Phase 1 implementation (scan-engine-agent):
    //   _ctx.waitUntil(runScan(_env, { trigger: 'cron' }));
    console.info('[card-broker] scheduled scan would run here (Phase 0 stub)');
  },
} satisfies ExportedHandler<Env>;
