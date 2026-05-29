---
name: cloudflare-workers
description: The Cloudflare Workers runtime/platform for the API-only backend — the export default { fetch, scheduled } entry, mounting Hono on fetch, the hourly cron scheduled() handler sharing the scan path with POST /api/scan/run-now, wrangler.toml shape (crons + D1 binding DB, NO [assets]), Wrangler secrets, D1 via env.DB, free-tier CPU-vs-wall-clock budget, ctx.waitUntil. Load when touching worker/src/index.ts, wrangler.toml, the cron handler, deploy/secret/d1 commands, or any platform-runtime concern. NOT for Hono route bodies (backend-dev) or D1 schema/queries (d1-database).
---

# Cloudflare Workers

## Purpose
The runtime and platform knowledge for the **single Cloudflare Worker** that is the entire
backend (`/worker`). One Worker does double duty: an hourly cron `scheduled()` scan **and** a
Hono JSON API on `fetch()`. State is **Cloudflare D1** (binding `DB`); secrets are Wrangler
secrets. It is **API-only** — it does NOT serve the dashboard (that ships as a separate Tauri
app, see [.bootstrap-discovery](../../../docs/.bootstrap-discovery.md)). Runs on the free tier.
Deployed with Wrangler. Spec: PRD [§4](../../../cardtrader-deal-scanner-PRD.md) (architecture),
§5 (stack), §11 (scan flow), §12 (secrets), §14 (`wrangler.toml` sketch).

This skill owns the *platform shell*: the entry shape, the cron wiring, `wrangler.toml`,
bindings, secrets, and free-tier limits. Hono route handlers and the deal/scan logic belong to
their own skills (see [Related skills](#related-skills)).

## Core patterns

### The Worker entry — `{ fetch, scheduled }`
One module exports both entrypoints. `fetch` delegates to the Hono app; `scheduled` runs the
hourly cron and calls the **same** `runScan` the `POST /api/scan/run-now` route calls — one scan
code path, two triggers (PRD §11; see [scanner](../../../docs/documentation/scanner.md)).

```ts
// worker/src/index.ts
import { Hono } from 'hono';
import { runScan } from './scan/scanner';
// import { health, config, watchlist, deals, resolve, scan } from './api/*'

export interface Env {
  DB: D1Database;                 // the only persistent state (binding name is "DB")
  CARDTRADER_API_TOKEN: string;   // Wrangler secret — never in source/bundle/logs
  TELEGRAM_BOT_TOKEN: string;     // Wrangler secret
  TELEGRAM_CHAT_ID: string;       // Wrangler secret
}

const app = new Hono<{ Bindings: Env }>();
// app.use('/api/*', authGate);   // every route gated — no public D1 routes (PRD §12)
app.route('/api/scan', scan);     // POST /api/scan/run-now -> runScan(env, { trigger: 'run-now' })
// app.route('/api/health', health) ... etc.

export default {
  // HTTP API — Hono owns routing/validation; handlers are thin (see backend-dev).
  fetch: app.fetch,

  // Hourly cron. SAME scan path as run-now. Always resolves; errors land in scan_runs.error.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil keeps the isolate alive for the full async scan after scheduled() returns.
    ctx.waitUntil(runScan(env, { trigger: 'cron' }));
  },
} satisfies ExportedHandler<Env>;
```

### `wrangler.toml` — API-only, cron + D1, NO `[assets]`
```toml
name = "cardtrader-deal-scanner"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[triggers]
crons = ["0 * * * *"]            # hourly, top of the hour — cron is ALWAYS UTC

[[d1_databases]]
binding = "DB"                   # -> env.DB ; this exact name is the contract
database_name = "cardtrader_scanner"
database_id = "<filled after `wrangler d1 create cardtrader_scanner`>"

# NO [assets] block — the Worker is API-only; the dashboard is a separate Tauri app.
# Secrets are NOT in this file:
#   wrangler secret put CARDTRADER_API_TOKEN
#   wrangler secret put TELEGRAM_BOT_TOKEN
#   wrangler secret put TELEGRAM_CHAT_ID
```

### Key Wrangler commands
```bash
npx wrangler dev                                       # local dev (fetch + cron testable)
npx wrangler deploy                                    # deploy the Worker
npx wrangler d1 create cardtrader_scanner              # create DB, copy database_id into toml
npx wrangler d1 execute DB --file=src/db/schema.sql    # apply schema to the DB binding
npx wrangler secret put CARDTRADER_API_TOKEN           # set a secret (prompts; never in source)
npx wrangler tail                                       # live-stream production logs
```

## Standards
@docs/standards/coding-standards.md
@docs/standards/shared-standards.md

## Examples (Good / Bad)

**Good — one scan path, both triggers; secrets read from `env`.**
```ts
// scheduled() and the run-now route both call the identical orchestration.
export default {
  fetch: app.fetch,
  scheduled: (e, env, ctx) => ctx.waitUntil(runScan(env, { trigger: 'cron' })),
} satisfies ExportedHandler<Env>;

// in api/scan.ts the POST handler does the same call (trigger: 'run-now') — no forked logic.
const token = env.CARDTRADER_API_TOKEN;   // secrets live on env, nowhere else
```

**Bad — duplicated scan logic, `[assets]` block, secret hardcoded, missing `waitUntil`.**
```ts
// ❌ separate copy-pasted scan body in scheduled() drifts from run-now
async scheduled(event, env, ctx) {
  const token = 'ct_live_abc123';                // ❌ secret in source — committed + bundled
  await fetch(/* ...inlined scan... */);         // ❌ no ctx.waitUntil — isolate may be killed
}
```
```toml
[assets]                                         # ❌ Worker is API-only; do not serve the SPA
directory = "./web/dist"
```

## Gotchas
- **Secrets never in source / bundle / logs.** `CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID` are Wrangler secrets read off `env` only — never literals, never in
  `wrangler.toml`, never in a response/error/log line (PRD §12). The CardTrader token is
  read+write/purchase scope — high-sensitivity; rotate if ever exposed.
- **No `[assets]` block.** This Worker does not host the dashboard (Tauri pivot). Adding
  `[assets]` reintroduces the SPA-serving the architecture deliberately dropped.
- **Cron is UTC.** `crons = ["0 * * * *"]` fires at the top of every hour in **UTC**, not local
  time. Quiet-hours / digest logic must convert, not assume local.
- **CPU budget is microseconds; `fetch()` waits are wall-clock, not CPU.** The free-tier CPU cap
  is irrelevant here — JSON parse + medians are trivial. The real cost is the throttled
  CardTrader sweep (~1 req/s, PRD §11). Pace external calls ~1 req/s; back off on 429. Don't
  conflate wall-clock scan duration with CPU limits.
- **Same scan path for cron and run-now.** `scheduled()` and `POST /api/scan/run-now` both call
  `runScan(env, …)` — never fork the logic. "Scan now" must be identical to the cron by
  construction (PRD §4/§11).
- **D1 binding name is `DB`.** `env.DB` is the contract across the codebase and `wrangler.toml`
  (`binding = "DB"`); renaming it breaks every query helper.
- **`ctx.waitUntil` for fire-and-forget.** In `scheduled()` (and any post-response work), wrap
  the async scan in `ctx.waitUntil` so the isolate stays alive until it finishes; otherwise the
  Worker may be torn down mid-scan.
- **`runScan` always resolves.** A normal scan failure is recorded in `scan_runs.error`, not
  thrown — so `scheduled()` doesn't surface an uncaught rejection. (Lifecycle owned by the
  scanner; see [scanner](../../../docs/documentation/scanner.md).)

## Related skills
- backend-dev — Hono routes + repo (the `fetch` side handlers; thin controllers)
- d1-database — the `DB` binding's schema and query helpers
