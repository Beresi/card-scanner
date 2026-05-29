# HTTP API (Hono)

> Planned — greenfield, describes intent. Worker backend lives under `/worker`.
> Spec: [PRD §10](../../cardtrader-deal-scanner-PRD.md) (routes), §4/§5 (Hono on Workers),
> §12 (auth/secrets). Wire format is `snake_case`; money is integer cents.

## Purpose

The JSON API surface the Tauri desktop client talks to over HTTPS. [Hono](https://hono.dev)
runs natively on the Cloudflare Worker; the **same** Worker also exports `scheduled` (the
hourly cron scan). This system is **API-only** — per the [Tauri pivot](../.bootstrap-discovery.md)
it does **not** serve the dashboard (the PRD's static-asset SPA delivery in §5/§10 is
replaced; the dashboard ships as a desktop app). Routes are thin controllers: they
validate input, delegate to the data layer / scanner / notifier, and return `snake_case`
JSON. No business logic lives in a route handler.

## Planned files

| File | Role |
|---|---|
| `worker/src/index.ts` | Hono app construction + `export default { fetch, scheduled }`. Mounts `/api/*` routers; `scheduled` runs the cron scan. |
| `worker/src/api/health.ts` | `GET /api/health` — latest scan + token status. |
| `worker/src/api/config.ts` | `GET` / `PATCH /api/config` — the single `config` row (all settings). |
| `worker/src/api/watchlist.ts` | Watchlist CRUD + `/:id/reset`. |
| `worker/src/api/deals.ts` | Deal feed read, per-deal patch, maintenance prune. |
| `worker/src/api/resolve.ts` | Expansion / blueprint cache search for the add-card flow. |
| `worker/src/api/scan.ts` | `POST /api/scan/run-now` and `POST /api/telegram/test`. |

> Per [naming-conventions](../standards/naming-conventions.md): route files are named
> after the resource; prefix `/api/`; resources are plural nouns; query params `snake_case`.

## Routes

Every route is gated (see [Auth](#auth)). All bodies and query params are `snake_case`;
money fields are integer cents. UI mappings come from the
[README "Map UI → PRD API routes" table](../../README.md).

| Method | Path | Purpose | Request body / query | Maps to UI action |
|---|---|---|---|---|
| `GET` | `/api/health` | Latest `scan_run` summary + CardTrader token OK + Telegram link status | — | Health view |
| `GET` | `/api/config` | Read the single `config` row (deal-logic defaults, new-ticket defaults, notifications, appearance, maintenance) | — | Load Settings |
| `PATCH` | `/api/config` | Partial update of changed config fields only | `{ <changed config fields> }` | Save Settings |
| `GET` | `/api/watchlist` | List all watch items (+ resolved effective values for display) | — | Load Watchlist |
| `POST` | `/api/watchlist` | Create a watch item (born inheriting — override columns stay NULL) | `{ type, cardtrader_id, label, ... }` | Add card / set |
| `PATCH` | `/api/watchlist/:id` | Partial update of changed ticket fields only | `{ <changed fields> }` | Inline edit / inspector |
| `DELETE` | `/api/watchlist/:id` | Remove a watch item (cascades its deals) | — | Remove from watchlist |
| `PATCH` | `/api/watchlist/:id/reset` | Null an override field back to inherit (§9a) | `{ field: "<column>" }` | Reset field to inherit |
| `GET` | `/api/deals` | Filtered deal feed (reverse-chronological, not dismissed by default) | `?status=&min_discount=&watchlist_id=&priority=` | Load feed (filters) |
| `PATCH` | `/api/deals/:id` | Mark seen / dismissed | `{ seen?, dismissed? }` | Dismiss / mark seen |
| `DELETE` | `/api/deals` | Maintenance prune of old deals | `?older_than_days=` | Clear old deals |
| `GET` | `/api/resolve/expansions` | Search cached expansions (refresh if stale) | `?q=` | Add-flow set search |
| `GET` | `/api/resolve/blueprints` | Search cached blueprints for a set (fetch + cache if missing) | `?expansion_id=&q=` | Add-flow card search |
| `POST` | `/api/scan/run-now` | Trigger a scan immediately — same code path as cron | — | Scan now |
| `POST` | `/api/telegram/test` | Send a test message to confirm bot + chat wiring | — | Telegram test |

### Notes on specific routes

- **`POST /api/scan/run-now`** invokes the **same scanner entry point** as the `scheduled`
  cron handler (PRD §11) — see the scanner doc (planned `scan/scanner.ts`; orchestration
  summarized in [architecture](architecture.md)). One run path, two triggers.
- **`GET /api/resolve/*`** reads the `expansions` / `blueprints` caches in D1; it refreshes
  expansions if stale and fetches + caches a set's blueprints on first use (PRD §6 endpoints
  via the [CardTrader client](cardtrader-client.md)).
- **`PATCH /api/watchlist/:id/reset`** sets the named override column to `NULL` so the ticket
  resumes following the matching `config` default (inheritance, PRD §9a) — it does not write
  the current default value in.
- The deal feed surfaces values produced by the [deal engine](deal-engine.md)
  (`discount_pct`, `baseline_cents`, `price_cents`, `priority`).

## Auth

- **Every route is gated.** There are **no public unauthenticated routes** that read or
  write D1.
- The desktop client presents a **Cloudflare Access service token / shared bearer** on each
  request. This replaces the PRD §12 browser-based Cloudflare Access flow for the desktop
  app (per the [Tauri auth note](../.bootstrap-discovery.md)); the Worker stays API-only.
- The secret is stored in OS-backed secure storage on-device, never in the JS bundle or
  committed config (see [shared-standards §Secrets](../standards/shared-standards.md)).
- No cart / purchase endpoint exists (PRD §2, §12) — deals link out; the human buys.

## Conventions

| Rule | Detail |
|---|---|
| Prefix | All routes under `/api/`. |
| Resource nouns | Plural — `/api/deals`, `/api/watchlist`, `/api/config`. |
| Sub-actions | Path segments — `/api/watchlist/:id/reset`, `/api/scan/run-now`, `/api/telegram/test`. |
| `PATCH` semantics | Partial update — body carries **only the changed fields**, never the whole row. |
| Reset = null | `:id/reset` nulls an override column → back to inherit (§9a). |
| Query params | `snake_case`, mirroring the DB — `status`, `min_discount`, `watchlist_id`, `priority`, `older_than_days`, `expansion_id`, `q`. |
| Money on the wire | Integer **cents** + currency code; never floats. |
| JSON casing | `snake_case` request and response bodies (mirrors D1 + the CardTrader API). The client maps to `camelCase` internally if it wants; the wire format is fixed. |

## Public interface

Routes are **thin controllers** — no business logic in a handler:

- **`config` / `watchlist` / `deals`** delegate to the typed D1 query helpers (planned
  `db/repo.ts`). Handlers parse and validate input, call the repo, shape the `snake_case`
  response.
- **`scan/run-now`** delegates to the scanner orchestration (planned `scan/scanner.ts`) —
  the same function the `scheduled` export calls.
- **`telegram/test`** delegates to the notifier (planned `telegram/notifier.ts`).
- **`resolve/*`** delegates to the repo (cache reads) and the
  [CardTrader client](cardtrader-client.md) (refresh/fetch on miss/stale).

Invariants callers must respect:

- Send only changed fields on `PATCH`; do not round-trip the full object.
- New watch items are **born inheriting** — omit override fields rather than copying defaults.
- Treat all money as integer cents end to end; format to a display string only at the UI edge.

## Examples

```http
GET /api/deals?status=open&min_discount=60&priority=high
Authorization: Bearer <cf-access-service-token>
```

```jsonc
// 200 — snake_case, cents
[
  {
    "id": 412,
    "watchlist_id": 7,
    "card_name": "Dragon Fodder",
    "expansion_name": "Tarkir Dragonfury",
    "price_cents": 2,
    "currency": "USD",
    "baseline_cents": 4,
    "discount_pct": 50,
    "priority": "high",
    "can_sell_via_hub": true,
    "seen": false,
    "dismissed": false
  }
]
```

```http
PATCH /api/watchlist/7
{ "threshold_pct": 45 }            // only the changed field

PATCH /api/watchlist/7/reset
{ "field": "threshold_pct" }       // nulls the column → back to inherit
```

## Gotchas

- **Keep long scan work off the request path where possible.** `POST /api/scan/run-now`
  runs the same handler as the cron, so a manual scan does the full marketplace sweep. CPU
  per invocation is microseconds (JSON parse + medians); the heavy part is wall-clock
  `fetch()` waits to CardTrader throttled at ~1 req/s (PRD §4) — be mindful of Worker
  request limits, even though CPU is not the binding constraint.
- **Validate and parse every input — never trust the client.** Coerce/clamp query params
  (`min_discount`, `older_than_days`), check enums (`status`, `priority`, `foil_pref`,
  `importance`, `min_condition`), and reject unknown `PATCH` fields. Bad input must not
  reach the repo or the scanner.
- **Consistent `snake_case` JSON.** A field that drifts to `camelCase` breaks the shared
  contract; the boundary is fixed (see [shared-standards](../standards/shared-standards.md)).
- **Never expose secrets in responses or errors.** `CARDTRADER_API_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the Access service token must never appear
  in a response body, error message, or log. `/api/health` reports token *status* (ok /
  invalid), not the token.
- **`resolve/blueprints` on a cold set** triggers a CardTrader fetch — first call for a new
  expansion is slower; subsequent calls hit the cache.
