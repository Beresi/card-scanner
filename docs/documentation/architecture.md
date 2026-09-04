# Architecture
> Cross-system view. For product scope see [project-summary](../project-summary.md); for the
> full inventory and the Tauri decision see [.bootstrap-discovery](../.bootstrap-discovery.md).
> Authoritative spec: `cardtrader-deal-scanner-PRD.md`.

## Overview
Two independently-built, independently-deployed units joined by an HTTP contract:
1. **Backend** — scans CardTrader hourly and exposes a Hono JSON API over SQLite. Ships in
   two interchangeable forms: a Cloudflare Worker (`src/index.ts` default export) and a
   self-hosted Node process (`scripts/server-local.ts`). Both import the SAME `app` and
   `heartbeatTick()`; only the transport and the timer differ. See
   [self-hosting](self-hosting.md).
2. **Desktop client** — a Tauri v2 app (React+Vite+TS webview + Rust host) that is the
   dashboard. It only reads/writes through the backend `/api/*` routes, wherever it lives.

## Component map
```
CLOUDFLARE WORKER (one Worker, two entrypoints)
├─ scheduled()  ──hourly cron ["0 * * * *"]──┐
│                                            ▼
│   scan/scanner.ts  (orchestrates a run, shared by cron + run-now)
│     ├─ cardtrader/client.ts   GET /info, /marketplace/products (throttle + backoff)
│     ├─ scan/dealEngine.ts     filter → sort → median baseline → threshold   (pure)
│     ├─ scan/conditions.ts     CONDITION_RANK ladder                          (pure)
│     ├─ db/repo.ts             upsert deals (ON CONFLICT product_id), scan_runs
│     └─ telegram/routing.ts → telegram/notifier.ts   (anti-spam decision, batched send)
│
└─ fetch()  ──Hono app──> /api/*  (health, config, watchlist, deals, resolve, scan, telegram)
        │
        ▼
   Cloudflare D1 (SQLite) — watchlist, deals, config(1 row), scan_runs, expansions, blueprints

EXTERNAL:  CardTrader API v2 (Bearer)   ·   Telegram Bot API (sendMessage)

DESKTOP (Tauri v2)
├─ src/ (React + Vite + TS)  ── HTTPS + service token ──> Worker /api/*  (TanStack Query)
│    4 views: Deal Feed · Watchlist · Settings · Health
│    + boot sequence, ⌘K palette, live-scan overlay, telemetry rail, opt-in effects
└─ src-tauri/ (Rust host)  open-in-browser (Buy links) · secure token store · auto-updater
```

## Responsibilities
| Component | Owns | Does NOT own |
|---|---|---|
| `cardtrader/client.ts` | HTTP to CardTrader, throttle, 429 backoff, response typing | Deal logic, persistence |
| `scan/dealEngine.ts` | Filter/sort/median/threshold decision (pure) | I/O, networking, DB |
| `scan/conditions.ts` | Condition ladder ranking (pure) | Anything else |
| `scan/scanner.ts` | Run orchestration, throttle loop, `scan_runs` lifecycle | Deal math, routing math (delegates) |
| `telegram/routing.ts` | Should-notify decision (§8, pure) | Sending |
| `telegram/notifier.ts` | `sendMessage`, batching, message format | Routing decision |
| `db/repo.ts` | Typed D1 queries, upsert/dedupe, inheritance resolution | Business decisions |
| `api/*.ts` (Hono) | HTTP surface, validation, auth gate | Long-running scan logic (calls scanner) |
| Desktop `src/` | Rendering, filters, inherit/override UX, data fetching/caching | Scan logic, secrets, persistence |
| Desktop `src-tauri/` | Window, open-URL, secure storage, updater | Business logic |

## Data flow — a scan (PRD §11)
1. cron (or `POST /api/scan/run-now`) → open `scan_runs` row.
2. `GET /info` validates the token (401 → record error, abort, alert once).
3. Load active watchlist; group expansion vs blueprint items.
4. Per item: fetch cheapest-25 (throttle ~1 req/s, backoff on 429) → run dealEngine (§7).
5. Upsert deals `ON CONFLICT(product_id) DO NOTHING`; inserted rows = the new deals.
6. New deals: compute priority + Telegram routing (§8); send the passing ones; mark sent.
7. Close `scan_runs` (counts, error if any).

## Data flow — the dashboard
The desktop app is a thin read/write client. Every UI action maps to a route (README §"Map
UI → PRD API routes"): load feed (`GET /api/deals?…`), dismiss/seen (`PATCH /api/deals/:id`),
watchlist CRUD + reset, config get/patch, add-flow resolve search, scan now, telegram test,
health. Server state is cached/invalidated by TanStack Query; only ephemeral UI lives locally.

## Key decisions & rationale
- **One Worker, two entrypoints** (PRD §4) — `scheduled` + `fetch` share the scan code path
  so "Scan now" and the cron are identical. Free-tier fit is trivial (24 cron + light API).
- **Median, not mean** baseline (PRD §7) — robust when a second copy is also underpriced.
- **Dedupe on `product_id`** (PRD §7/§13) — one alert per physical listing, not per card.
- **Two decoupled surfaces** (PRD §8) — app feed = everything; Telegram = strict opt-in
  subset. This anti-spam split is the product's core value.
- **Inheritance via NULL columns** (PRD §9a) — defaults are a moving baseline; explicit
  values are sticky. Resolved at scan time, surfaced in the UI as inherit/override.
- **Tauri client + cloud backend** (overrides PRD frontend delivery) — desktop UX without
  losing the always-on cloud scan + Telegram push. Worker is API-only; browser Cloudflare
  Access is replaced by a desktop service token. See [.bootstrap-discovery](../.bootstrap-discovery.md).
- **Pure domain core** — engine, conditions, routing take data in and return decisions out,
  no I/O, so the §16 fixtures test them directly.

## External dependencies & secrets
| Dependency | Auth | Notes |
|---|---|---|
| CardTrader API v2 | `Bearer CARDTRADER_API_TOKEN` | read+write scope; high-sensitivity; ~1 req/s; cart add/view/remove used; /cart/purchase NEVER called |
| Telegram Bot API | bot token + chat id | batched `sendMessage` |
| Cloudflare D1 | Worker binding `DB` | only persistent state |
| Worker `/api` (from desktop) | Access service token / shared bearer | on-device secure storage |

Secrets: Wrangler secrets (backend) + OS secure store (desktop). Never in source/logs/bundle.

## Gotchas
- **Grid scroll trap:** keep `min-height:0` on the center column + inner `overflow-y:auto`,
  or the page won't scroll (README).
- **Re-render kills animations:** isolate the per-second countdown into a leaf `Clock`
  component; a root-level tick breaks entrance animations (README).
- **`expansion_id`+`language`:** verify the language filter is honored on the expansion
  variant; if not, fall back to per-blueprint calls (PRD §6/§13).
- **Buy URL pattern** is unverified — confirm `https://www.cardtrader.com/cards/{blueprint_id}`
  during build; fall back to a search URL (PRD §6).
- **Lightly-cached prices** — alerts are signals; the owner re-checks live price before buying.

## Deployment targets
The backend has two hosts. `src/index.ts` exports `app` (the Hono application) and
`heartbeatTick(env)` (one scan-gate tick) so both import the identical code path — there is
no second implementation of a route or of the schedule logic to keep in sync.

| | Cloudflare Worker | Self-hosted (current) |
|---|---|---|
| Entry | `src/index.ts` default export | `scripts/server-local.ts` |
| HTTP | `workerd` `fetch` | `@hono/node-server`, bound `127.0.0.1` |
| Schedule | cron `* * * * *` → `scheduled()` | `setInterval(60s)` |
| Storage | D1 binding `env.DB` | SQLite file via `scripts/d1-sqlite.ts` |
| Process | Cloudflare edge, always-on | Windows logon task, on while the PC is on |
| Limits | free-tier row-read / subrequest / CPU caps | CardTrader's ~1 req/s only |

`src/db/repo.ts` is written against one structural D1 contract
(`prepare · bind · run · all · first · batch · exec`) that four adapters satisfy: the real
binding, `scripts/d1-http.ts` (REST), `scripts/d1-sqlite.ts` (local file), and
`src/api/__test-helpers__/d1.ts` (in-memory, used by the suite). That is what makes the
backend portable without touching business logic.
