# Project Summary — CardTrader Deal Scanner ("Card // Broker")

## Purpose
A personal, **single-user** tool that hunts for **underpriced Magic: The Gathering cards**
on the [CardTrader](https://www.cardtrader.com) marketplace. Once an hour it scans a
watchlist of cards and whole sets, flags listings whose cheapest copy is priced far below
the going rate (default ≤ 50% of the median of the next-cheapest copies, English + a
minimum condition), and surfaces them in a dashboard. A **filtered, owner-controlled
subset** is pushed to Telegram so the owner is pinged only for deals that matter.

No auto-buying — every deal links out to CardTrader and the owner buys manually.

## Architecture (two build targets)
The system is split into an always-on cloud backend and a desktop client.

```
   ┌──────────────────────── CLOUDFLARE (free tier) ───────────────────────┐
   │  Cloudflare Worker                                                     │
   │   • scheduled() cron — hourly scan                                     │
   │   • Hono JSON API (/api/*)  ── service-token auth ──┐                  │
   │            reads watchlist / writes deals           │                  │
   │                  ┌──────┐                           │                  │
   │                  │  D1  │  single source of truth   │                  │
   │                  └──────┘                           │                  │
   └──────┬─────────────────────────────┬───────────────┼──────────────────┘
          │ GET cheapest 25 (EN)         │ push filtered │ HTTPS /api/*
          ▼                              ▼               ▼
  ┌───────────────┐              ┌──────────────┐   ┌──────────────────────┐
  │ CardTrader API│              │ Telegram Bot │   │  TAURI DESKTOP APP     │
  └───────────────┘              └──────────────┘   │  React+Vite webview    │
                                                     │  + Rust host           │
                                                     └──────────────────────┘
```

- **Cloud backend (unchanged from PRD §4–§14):** a single Cloudflare Worker does double
  duty — an hourly `scheduled()` scan handler and a Hono HTTP API. Cloudflare **D1**
  (SQLite) is the only persistent state. The scan runs regardless of whether the desktop
  app is open. The Worker is **API-only** (it does not serve the dashboard).
- **Desktop client (Tauri pivot — see `docs/.bootstrap-discovery.md`):** the dashboard is
  a **Tauri v2** app — a React + Vite + TypeScript SPA in the system webview with a Rust
  host. It calls the cloud `/api/*` routes over HTTPS (TanStack Query), authenticating
  with a Cloudflare Access service token / shared secret held in on-device secure storage.

## Key systems
| System | Responsibility | Spec |
|---|---|---|
| CardTrader client | Typed API calls, ~1 req/s throttle, 429 backoff | PRD §6 |
| Deal engine | Filter → price-sort → median baseline → threshold/discount | PRD §7 |
| Scanner | Orchestrates a run (cron + run-now), writes `scan_runs` | PRD §11 |
| Telegram routing | Anti-spam decision (importance + stricter threshold), batched send | PRD §8 |
| Data layer (D1) | `watchlist`, `deals`, `config`, `scan_runs`, caches; inheritance (§9a) | PRD §9 |
| HTTP API (Hono) | `/api/{health,config,watchlist,deals,resolve,scan,telegram}` | PRD §10 |
| Desktop dashboard | 4 views (Feed, Watchlist, Settings, Health) + boot, ⌘K, scan overlay, telemetry rail | README handoff |

## Data flow (one scan)
1. Cron fires → open a `scan_runs` row → validate token via `GET /info`.
2. Load active watchlist → group by type (expansion vs blueprint).
3. For each item, fetch cheapest-25 listings (throttled), run the deal algorithm (§7).
4. Upsert deals keyed by `UNIQUE(product_id)` — newly-inserted rows are the new deals.
5. For new deals, compute priority + Telegram routing (§8); send the ones that pass.
6. Close `scan_runs` with counts. The desktop app reads it all back via `/api`.

## Key invariants
- **Money is always integer cents** — never floats; format only at the display edge.
- **One alert per `product_id`** — dedupe on the listing, not the card.
- **In-app feed = everything; Telegram = a strict, opt-in subset** (anti-spam is the point).
- **Inheritance:** per-ticket override columns are `NULL` → fall back to the `config`
  default at scan time; defaults are a moving baseline (PRD §9a).
- **No purchase path** — the API supports buying; we never call it.

## What this is NOT (v1 non-goals)
Auto-buying/cart, shipping-aware totals, non-MTG games, multi-user/public access,
currency conversion. (PRD §2.)

## Where to look
- `cardtrader-deal-scanner-PRD.md` — authoritative product + backend spec.
- `README.md` — design handoff for the dashboard UI (tokens, views, interactions).
- `design_handoff_deal_scanner_dashboard/` — the HTML/CSS+Babel prototype (reference only,
  **do not port** the Babel/`window.*`/mock-data scaffolding).
- `docs/.bootstrap-discovery.md` — full domain/stack/concern inventory + the Tauri decision.
- `docs/documentation/architecture.md` — deeper architecture doc.
