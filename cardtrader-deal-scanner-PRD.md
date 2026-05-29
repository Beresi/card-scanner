# PRD — CardTrader Deal Scanner ("Underpriced-copy hunter")

**Owner:** Itay (single user)
**Status:** Ready to build
**Audience:** Claude Code (this document is the build spec)

---

## 1. Summary

A personal, single-user service that scans the [CardTrader](https://www.cardtrader.com) marketplace once per hour for a watchlist of cards and sets, and flags **underpriced copies** — listings priced far below the going rate for the same card. Every flagged deal appears in a web dashboard (the default surface, reachable from any device). A **filtered subset** is pushed to Telegram so the owner gets pinged only for the deals that matter and is not spammed.

Runs entirely on Cloudflare's free tier. No auto-purchasing — the owner reviews and buys manually.

---

## 2. Goals / Non-goals

### Goals
- Detect listings where the **cheapest copy of a card is ≤ a configurable % (default 50%) of the median price of the next-cheapest copies**, restricted to English and a minimum condition.
- Watch both **individual cards** and **whole sets/expansions**.
- Run **hourly**, fully in the cloud, free, with one source of truth, reachable from multiple devices.
- Two notification surfaces: **in-app feed = everything** (default), **Telegram = a filtered, owner-controlled subset** (anti-spam).
- Per-card / per-set control over thresholds, condition, and whether it can trigger Telegram.

### Non-goals (explicitly out of scope for v1)
- **Auto-buying / cart / checkout.** The API supports it; we do **not** use it. Deals link out to CardTrader and the owner buys manually. (Product + safety decision.)
- Shipping-aware total cost (item price only in v1; show CT Zero eligibility as a hint).
- Games other than Magic: The Gathering.
- Multi-user / public access / accounts.
- Currency conversion (use the account's native currency as returned by the API).

---

## 3. Glossary (CardTrader concepts)

- **Game** — e.g. Magic: The Gathering (`game_id = 1`). We only use MTG.
- **Expansion** — a set (e.g. "Core Set 2020"). Has an integer `id` and a `code`.
- **Blueprint** — a specific card printing. One blueprint per reprint. This is the unit a price comparison happens on.
- **Product** — a single seller's listing of a blueprint (a physical copy with a price, condition, language, quantity).
- **CardTrader Zero (CT Zero / hub)** — CardTrader's fulfillment hub. `user.can_sell_via_hub = true` means the product is buyable via CT Zero. "1-Day Ready" on the website is a CT0-box item already in the hub.
- **Condition ladder (MTG)**, best → worst: `Mint`, `Near Mint`, `Slightly Played`, `Moderately Played`, `Played`, `Heavily Played`, `Poor`.

> **Note on "ignore 1-Day Ready":** On the website, the "ready + price ascending" sort floats the 1-Day-Ready listing to the top even when it's pricier — a UI artifact. The API's `marketplace/products` returns listings **sorted by price**, so this concern dissolves: we price-sort from the start, the cheap anomaly is the candidate, and the baseline is the next-cheapest real listings. We therefore do **not** special-case hub listings (excluding them would drop most of the market); we simply include all qualifying listings and price-sort.

---

## 4. Architecture

```
                 ┌─────────────────────────────────────────────┐
   Your devices  │           CLOUDFLARE ACCOUNT (free)          │
   (any browser) │                                              │
        │        │   ┌────────────────────────────────────┐    │
        │  HTTPS │   │         Cloudflare Worker          │    │
        └───────▶│   │  • Cron trigger (hourly) → scan    │    │
   (Cloudflare   │   │  • API routes (Hono) → dashboard   │    │
    Access)      │   └───────────────┬────────────────────┘    │
                 │           reads/   │   writes                │
                 │          watchlist │   deals                 │
                 │                ┌───▼────┐                     │
                 │                │   D1   │  single source of   │
                 │                │ SQLite │  truth              │
                 │                └────────┘                     │
                 └───────┬──────────────────────────┬───────────┘
                         │ GET cheapest 25 (EN)      │ push filtered deals
                         ▼                           ▼
                 ┌───────────────┐           ┌───────────────┐
                 │ CardTrader API│           │  Telegram Bot │
                 └───────────────┘           └───────────────┘
```

- **Cloudflare Worker** — one Worker does double duty: a `scheduled()` cron handler (hourly scan) and an HTTP handler (dashboard + JSON API, via [Hono](https://hono.dev)).
- **D1** — SQLite database, the only persistent state.
- **Dashboard** — static SPA (React + Vite) served as Worker assets, gated by **Cloudflare Access** (Zero Trust, free for one user).
- **Telegram** — a bot the owner created; the Worker calls the Bot API to push filtered deals.
- **CardTrader API** — `https://api.cardtrader.com/api/v2`, Bearer auth.

### Free-tier fit
Hourly cron = 24 scheduled invocations/day, plus dashboard requests — trivially within Workers' 100k req/day. CPU per invocation is microseconds (JSON parse + medians); the `fetch()` waits to CardTrader are wall-clock, not CPU, so the 10ms CPU cap is irrelevant. D1 usage (a few hundred rows/day) is far under 5M reads / 100k writes per day.

---

## 5. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Compute + scheduler | Cloudflare Workers + Cron Triggers | `crons = ["0 * * * *"]` |
| HTTP routing | Hono | runs natively on Workers |
| Database | Cloudflare D1 (SQLite) | binding `DB` |
| Dashboard UI | React + Vite SPA, served as static assets | keep it light |
| Auth (dashboard) | Cloudflare Access | single user; or a shared-secret fallback |
| Notifications | Telegram Bot API | `sendMessage` |
| Secrets | Wrangler secrets | `CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Language | TypeScript | |

---

## 6. CardTrader API integration

Base URL: `https://api.cardtrader.com/api/v2`. Every request: header `Authorization: Bearer ${CARDTRADER_API_TOKEN}`.

### Endpoints used
| Endpoint | Use |
|---|---|
| `GET /info` | Health check / token validation on startup. |
| `GET /expansions` | Populate/refresh the local expansion cache (for set-watching + add-card UX). |
| `GET /blueprints/export?expansion_id=X` | List all card printings in a set → blueprint cache (for add-card search + display enrichment). |
| `GET /marketplace/products?blueprint_id=X&language=en` | Core: cheapest 25 listings for one card. |
| `GET /marketplace/products?expansion_id=X&language=en` | Core: cheapest 25 listings for **every** blueprint in a set, in one call (response is a map keyed by blueprint id). **Verify the `language` filter is honored on the `expansion_id` variant; if not, fall back to per-blueprint calls.** |

Optional filters on `marketplace/products`: `language` (2-letter, e.g. `en`) and `foil` (boolean). Pass `language=en` always; pass `foil` only when the watch item's foil preference isn't "any".

### `marketplace/products` response shape
Object keyed by blueprint id → array of up to 25 cheapest products:
```jsonc
{
  "10050": [
    {
      "id": 101862104,                // product_id (used for dedupe + buy link)
      "blueprint_id": 10050,
      "name_en": "Dragon Fodder",
      "quantity": 1,
      "price": { "cents": 2, "currency": "USD" },
      "description": "…",
      "properties_hash": {
        "condition": "Moderately Played",
        "mtg_language": "en",
        "mtg_foil": false,
        "signed": false,
        "altered": false
      },
      "expansion": { "id": 92, "code": "ptkdf", "name_en": "Tarkir Dragonfury" },
      "user": {
        "id": 41687, "username": "seller",
        "can_sell_via_hub": true,       // CT Zero eligible
        "country_code": "FI", "user_type": "normal"
      },
      "graded": false,
      "on_vacation": false,             // cannot buy if true
      "bundle_size": 1
    }
  ]
}
```

### Rate limits & caching
- Global: **200 requests / 10 seconds**.
- `marketplace/products`: docs are contradictory (states both "1 call/second" and "10 requests/second"). **Throttle to ~1 request/second** to be safe — hourly scanning has no need for speed.
- `marketplace/products` is **lightly cached**; prices/quantities may rarely lag. Acceptable for alerting — the owner re-confirms the live price on CardTrader before buying.
- Implement: sequential requests with a ~1s delay, exponential backoff on HTTP 429 / `"Too many requests"` bodies.

### Prices
`price.cents` is an integer in the **account's currency** (`price.currency`). Store cents as integers everywhere; never use floats for money.

### Buy link
Construct a link to the card on CardTrader for each deal. Likely pattern `https://www.cardtrader.com/cards/{blueprint_id}` — **verify the actual public URL pattern during build** and fall back to a search URL if needed.

---

## 7. Deal-detection algorithm

Per watched blueprint, each scan:

```
INPUTS (per watch item, with global defaults):
  min_condition      default "Near Mint"
  foil_pref          default "any"   // "any" | "foil" | "nonfoil"
  allow_graded       default false
  threshold_pct      default 50      // candidate must be <= this % of baseline
  cohort_size        default 10      // "next 10 cheapest"
  min_cohort         default 5       // need at least this many comparators

CONDITION_RANK = { Mint:7, "Near Mint":6, "Slightly Played":5,
                   "Moderately Played":4, Played:3, "Heavily Played":2, Poor:1 }

1. products = marketplace cheapest-25 for this blueprint (language=en)
2. filtered = products where:
     - properties_hash.mtg_language == "en"
     - on_vacation == false
     - graded == false            (unless allow_graded)
     - quantity >= 1
     - CONDITION_RANK[condition] >= CONDITION_RANK[min_condition]
     - foil matches foil_pref      (skip if "any")
3. sort filtered ascending by price.cents
4. if filtered.length < (min_cohort + 1): SKIP  // thin market, no reliable baseline
5. candidate = filtered[0]
   cohort    = filtered[1 .. cohort_size]        // up to 10
   if cohort.length < min_cohort: SKIP
   baseline_cents = median(cohort.map(price.cents))
6. discount_pct = round( (1 - candidate.cents / baseline_cents) * 100 )
   is_deal = candidate.cents <= (threshold_pct/100) * baseline_cents
7. if is_deal: upsert into `deals` keyed by UNIQUE(product_id)
     - ON CONFLICT(product_id) DO NOTHING  → already known, not "new"
     - rows that were actually inserted are the NEW deals for this run
```

Notes:
- **Median, not mean** — robust if a second copy is also underpriced.
- A deal is recorded **once per `product_id`** (a specific listing). If the same listing reappears next hour it is not re-alerted. (Future option: re-alert on a further price drop — see §13.)
- Comparisons are within the post-filter set, so a cheap *Poor* copy is never compared against *NM* copies.

---

## 8. Notification routing (anti-spam) — **key feature**

Two surfaces, decoupled:

### In-app feed (default, catch-all)
**Every** `is_deal` is written to `deals` and shown in the dashboard feed. Nothing is filtered out of the app. This is where the owner browses everything.

### Telegram (filtered, opt-in)
A deal pushes to Telegram **only if all** of the following hold:
1. The watch item has `telegram_enabled = true`, **or** the watch item's `importance = "high"`.
2. **Either** `importance = "high"` (high-importance items bypass the discount gate and push on any deal), **or** `discount_pct >= telegram_min_discount_pct` (per-item override, else global default — default **60%**, i.e. stricter than the 50% app threshold).
3. (Optional, if set) `candidate.cents <= telegram_max_price_cents` and/or `savings_cents (= baseline-candidate) >= telegram_min_savings_cents`.
4. Not already sent for this `product_id` (`telegram_sent = false`).
5. (Optional) Not inside quiet hours — if quiet hours are configured and active, hold the deal and include it in the next out-of-hours digest. (Quiet-hours/digest is v1-optional; implement the gate + a simple "send held deals when quiet hours end" if time permits, else defer.)

Result fields written per deal: `priority` (`high` | `normal`), `telegram_sent`, `telegram_sent_at`.

> Net effect: the owner marks a few sets/cards as **high importance** → those ping immediately. Everything else only pings if it's a *really* steep discount (≥ the stricter Telegram threshold). The full list always lives in the app. No spam.

### Telegram message format (per deal)
Plain text (owner can add an emoji prefix if desired):
```
Deal — {card_name} · {expansion_name}
{price} {currency}  ({discount_pct}% under median {baseline_price})
{condition} · {Foil|Non-foil} · EN · qty {quantity}
Seller: {seller_username} ({country_code}){ · CT Zero ✓ if can_sell_via_hub}
{buy_link}
```
Batch multiple new deals from one scan into a single message (or a small number) rather than one message per deal.

---

## 9. Data model (D1 / SQLite)

```sql
-- What to scan
CREATE TABLE watchlist (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  type                      TEXT NOT NULL CHECK (type IN ('blueprint','expansion')),
  cardtrader_id             INTEGER NOT NULL,         -- blueprint_id or expansion_id
  label                     TEXT NOT NULL,            -- card or set name for display
  game_id                   INTEGER NOT NULL DEFAULT 1,
  min_condition             TEXT NOT NULL DEFAULT 'Near Mint',
  foil_pref                 TEXT NOT NULL DEFAULT 'any' CHECK (foil_pref IN ('any','foil','nonfoil')),
  allow_graded              INTEGER NOT NULL DEFAULT 0,
  threshold_pct             INTEGER,                  -- NULL → use config default
  importance                TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('high','normal')),
  telegram_enabled          INTEGER NOT NULL DEFAULT 0,
  telegram_min_discount_pct INTEGER,                  -- NULL → use config default
  telegram_max_price_cents  INTEGER,                  -- NULL → no cap
  telegram_min_savings_cents INTEGER,                 -- NULL → no floor
  active                    INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, cardtrader_id, foil_pref)
);

-- Found deals (in-app feed + dedupe source)
CREATE TABLE deals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id      INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  blueprint_id      INTEGER NOT NULL,
  product_id        INTEGER NOT NULL UNIQUE,          -- dedupe key
  card_name         TEXT NOT NULL,
  expansion_name    TEXT,
  seller_username   TEXT,
  seller_country    TEXT,
  condition         TEXT,
  language          TEXT,
  foil              INTEGER,                          -- 0/1
  can_sell_via_hub  INTEGER,                          -- 0/1
  quantity          INTEGER,
  price_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  baseline_cents    INTEGER NOT NULL,
  cohort_size       INTEGER NOT NULL,
  discount_pct      INTEGER NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal',   -- 'high' | 'normal'
  buy_url           TEXT,
  found_at          TEXT NOT NULL DEFAULT (datetime('now')),
  seen              INTEGER NOT NULL DEFAULT 0,
  dismissed         INTEGER NOT NULL DEFAULT 0,
  telegram_sent     INTEGER NOT NULL DEFAULT 0,
  telegram_sent_at  TEXT
);
CREATE INDEX idx_deals_found_at ON deals(found_at DESC);
CREATE INDEX idx_deals_open ON deals(dismissed, found_at DESC);

-- Global config (single row, id = 1). Holds (a) deal-logic defaults, (b) the
-- starting values new tickets inherit, (c) notification globals, (d) appearance,
-- (e) maintenance. Per-ticket NULL override fields fall back to the matching
-- column here at scan time (see §9a Inheritance).
CREATE TABLE config (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),

  -- Deal-logic defaults (inherited by tickets whose override is NULL)
  default_threshold_pct         INTEGER NOT NULL DEFAULT 50,
  default_min_condition         TEXT    NOT NULL DEFAULT 'Near Mint',
  cohort_size                   INTEGER NOT NULL DEFAULT 10,
  min_cohort                    INTEGER NOT NULL DEFAULT 5,

  -- Starting values for the "new ticket" form
  new_ticket_foil_pref          TEXT    NOT NULL DEFAULT 'any',
  new_ticket_allow_graded       INTEGER NOT NULL DEFAULT 0,
  new_ticket_importance         TEXT    NOT NULL DEFAULT 'normal',
  new_ticket_telegram_enabled   INTEGER NOT NULL DEFAULT 0,

  -- Notification globals
  telegram_min_discount_pct     INTEGER NOT NULL DEFAULT 60,   -- stricter than app
  quiet_hours_start             INTEGER,                       -- 0-23 local, NULL = off
  quiet_hours_end               INTEGER,
  digest_on_quiet_end           INTEGER NOT NULL DEFAULT 1,    -- send held deals when quiet hours end

  -- Appearance
  theme                         TEXT    NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  accent_color                  TEXT    NOT NULL DEFAULT '#f59e0b',
  density                       TEXT    NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable','compact')),

  -- Maintenance / data
  deal_retention_days           INTEGER NOT NULL DEFAULT 30,   -- auto-dismiss/prune deals older than this; 0 = keep forever
  timezone                      TEXT    DEFAULT 'Asia/Jerusalem',

  updated_at                    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Observability
CREATE TABLE scan_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at        TEXT,
  watch_items_scanned INTEGER DEFAULT 0,
  blueprints_scanned INTEGER DEFAULT 0,
  api_calls          INTEGER DEFAULT 0,
  deals_found        INTEGER DEFAULT 0,
  telegram_sent      INTEGER DEFAULT 0,
  error              TEXT
);

-- Caches (for add-card UX + display enrichment)
CREATE TABLE expansions (
  id        INTEGER PRIMARY KEY,                      -- cardtrader expansion id
  game_id   INTEGER NOT NULL,
  code      TEXT,
  name      TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE blueprints (
  id           INTEGER PRIMARY KEY,                   -- cardtrader blueprint id
  expansion_id INTEGER,
  name         TEXT,
  scryfall_id  TEXT,
  image_url    TEXT,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_blueprints_exp ON blueprints(expansion_id);
CREATE INDEX idx_blueprints_name ON blueprints(name);
```

### 9a. Defaults & inheritance

Every per-ticket override column in `watchlist` (`threshold_pct`, `min_condition`, `foil_pref`, `allow_graded`, `importance`, `telegram_enabled`, `telegram_min_discount_pct`, `telegram_max_price_cents`, `telegram_min_savings_cents`) is resolved at scan time as:

```
effective_value = ticket.value  IF NOT NULL  ELSE  config.matching_default
```

Rules:
- A ticket left to "use default" (NULL) **follows the global default**, even if that default changes later — defaults are a moving baseline.
- A ticket with an explicit value is **sticky**: changing the global default does not touch it.
- The **new-ticket form** is pre-filled from `config.new_ticket_*` and the deal-logic defaults, so a ticket created with no edits is born inheriting everything (its override columns stay NULL — it does not copy the values in, it references them).
- The dashboard must visually distinguish "inheriting (default: X)" from an explicit override on each ticket field, with a one-tap "reset to default" that nulls the column.

---

## 10. Dashboard (web UI)

Single-user, reachable from any device, behind Cloudflare Access. Mobile-friendly.

### Views
1. **Deal feed** (home) — reverse-chronological list of `deals` (not dismissed). Each card shows: name, set, price vs baseline, discount %, condition, foil, seller + country, CT Zero badge, qty, age, **Buy** (→ CardTrader), **Dismiss**, **Mark seen**. Filters: open/all, min discount, by watch item, priority. Optional "manual scan now" button.
2. **Watchlist** — list of watch items with inline editing. **Add** flow:
   - Game is fixed to MTG.
   - Add a **set**: search the cached `expansions` by name/code → pick → creates an `expansion` watch item.
   - Add a **card**: pick a set → fetch/cache `blueprints` for it → search by name → pick → creates a `blueprint` watch item. (Also accept pasting a CardTrader card URL and parsing the id, as a shortcut — best effort.)
   - Per item set: min condition, foil pref, allow graded, threshold override, **importance (high/normal)**, **Telegram enabled**, Telegram discount/price/savings overrides, active toggle.
3. **Settings** — app-level configuration, grouped into sections:
   - **Appearance:** theme (light / dark / system), accent color, list density (comfortable / compact). Theme applies instantly via a CSS-variable swap; persisted in `config`.
   - **New-ticket defaults:** the starting values every new ticket inherits — default threshold %, default min condition, default foil pref, default allow-graded, default importance, default Telegram-enabled, plus the deal-logic globals (cohort size, minimum comparators). Editing these retroactively affects all tickets still set to "inherit" (§9a).
   - **Notifications:** Telegram connection status (from a cached `/getMe` check) + a **"Send test message"** button; global Telegram min-discount gate; quiet hours (start/end + timezone) and whether to send a digest when quiet hours end.
   - **Scan & data:** schedule (hourly — display the cron, read-only in v1); **"Scan now"** button; last-scan summary (links to Health); account currency; **CardTrader token status** (live from `GET /info`) with a reminder to rotate if exposed.
   - **Maintenance:** deal retention (auto-dismiss/prune deals older than N days; 0 = keep forever); optional "clear all deals."
4. **Health** — last scan time/result from `scan_runs`, error if any, counts.

> The Settings page reads and writes the single `config` row. Appearance + new-ticket defaults are part of that same row, so there is one settings surface, not several.

### API routes (Hono, JSON)
```
GET    /api/health                       -> latest scan_run + cardtrader token ok
GET    /api/config                       PATCH /api/config        -> all settings incl. appearance
GET    /api/watchlist                    POST /api/watchlist
PATCH  /api/watchlist/:id                DELETE /api/watchlist/:id
PATCH  /api/watchlist/:id/reset          -> null an override field back to inherit
GET    /api/deals?status=&min_discount=&watchlist_id=&priority=
PATCH  /api/deals/:id                    -> { seen?, dismissed? }
DELETE /api/deals?older_than_days=       -> maintenance prune
GET    /api/resolve/expansions?q=        -> from cache (refresh if stale)
GET    /api/resolve/blueprints?expansion_id=&q=  -> from cache (fetch+cache if missing)
POST   /api/scan/run-now                 -> trigger a scan immediately (same code path as cron)
POST   /api/telegram/test                -> send a test message to confirm bot+chat wiring
```

---

## 11. Scan flow (`scheduled()` handler)

```
1. Open scan_runs row (started_at).
2. Validate token via GET /info (cheap; if 401 → record error, abort, alert once).
3. Load active watchlist.
4. Group by type:
   - expansion items → one GET marketplace/products?expansion_id&language=en each
     (returns map blueprint_id -> [products]); iterate the map.
   - blueprint items → one GET marketplace/products?blueprint_id&language=en each.
   Throttle to ~1 req/s; backoff on 429.
5. For each (watch item, blueprint, product list): run §7 deal algorithm.
6. Upsert new deals (ON CONFLICT(product_id) DO NOTHING). Collect truly-new rows.
7. For new rows: compute priority + Telegram routing (§8). Send Telegram for those that pass; mark telegram_sent.
8. Enrich card_name/expansion_name/image from blueprint cache where useful.
9. Close scan_runs (finished_at, counts, error if thrown).
```

Make the scan callable from both the cron trigger and `POST /api/scan/run-now`.

---

## 12. Security & secrets

- `CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` → **Wrangler secrets only**. Never in source, D1, the client bundle, logs, or version control.
- The CardTrader token grants read **and write/purchase** scope on the account — treat as high-sensitivity. **Rotate the token if it is ever exposed.**
- Dashboard behind **Cloudflare Access** (one identity). No public routes that read/write D1.
- Do not implement any cart/purchase endpoint. Deals link out; the human buys.

---

## 13. Edge cases & rules

- **Thin markets:** fewer than `min_cohort + 1` qualifying listings → skip (no reliable baseline).
- **Foil vs non-foil:** treated as different items; a watch item with `foil_pref` filters accordingly. A single "any" item mixes them — acceptable, but recommend separate items for foils.
- **Vacation / graded:** excluded by default.
- **Lightly cached prices:** alert is a signal; live price is re-checked on CardTrader before buying.
- **Currency:** single account currency; store cents as integers.
- **Dedupe:** one alert per `product_id`. (Future: store last price and re-alert if it drops a further configurable %.)
- **Rate limit:** throttle ~1 req/s; exponential backoff on 429; a failed blueprint is logged and skipped, not fatal to the run.
- **`expansion_id` + `language` filter:** verify it works; if not, fall back to per-blueprint calls for sets (still fine hourly).

---

## 14. Suggested repo structure

```
/
  wrangler.toml
  package.json
  /src
    index.ts                # Hono app + export default { fetch, scheduled }
    /cardtrader
      client.ts             # info, expansions, blueprintsExport, marketplaceProducts
      types.ts
    /scan
      scanner.ts            # orchestrates a run (cron + run-now)
      dealEngine.ts         # §7 filtering + median baseline + threshold
      conditions.ts         # CONDITION_RANK + helpers
    /telegram
      notifier.ts           # sendMessage, batching
      routing.ts            # §8 should-notify decision
    /db
      schema.sql
      repo.ts               # typed D1 query helpers
    /api
      watchlist.ts deals.ts config.ts resolve.ts health.ts scan.ts
  /web                      # Vite + React dashboard (served as assets)
```

### `wrangler.toml` (sketch)
```toml
name = "cardtrader-deal-scanner"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[triggers]
crons = ["0 * * * *"]          # hourly, top of the hour (UTC)

[[d1_databases]]
binding = "DB"
database_name = "cardtrader_scanner"
database_id = "<filled after `wrangler d1 create`>"

[assets]
directory = "./web/dist"
# Secrets (not here): wrangler secret put CARDTRADER_API_TOKEN
#                     wrangler secret put TELEGRAM_BOT_TOKEN
#                     wrangler secret put TELEGRAM_CHAT_ID
```

---

## 15. Build phases (suggested sequencing for Claude Code)

- **Phase 0 — Setup:** Cloudflare account, Wrangler, `d1 create`, apply `schema.sql`, set secrets, create Telegram bot (BotFather) + capture chat id.
- **Phase 1 — Core engine:** CardTrader client (`/info`, marketplace), condition ladder, `dealEngine`, `scanner`, write `deals` + `scan_runs`. Test against one hardcoded blueprint via `run-now`.
- **Phase 2 — Telegram:** notifier + basic routing (`telegram_enabled`); push new deals; dedupe.
- **Phase 3 — Dashboard API + minimal UI:** watchlist CRUD, deal feed, config, health; Cloudflare Access. Wire the theme (light/dark/system) + accent + density via CSS variables from day one so appearance isn't a retrofit.
- **Phase 4 — Full notification routing:** importance tiers, stricter Telegram threshold, per-item overrides with inherit/reset (§9a), optional quiet-hours digest.
- **Phase 5 — Add-card UX:** expansion + blueprint caches; resolve/search endpoints; set-watching via `expansion_id` batch.
- **Phase 6 — Settings & maintenance:** full Settings page (appearance, new-ticket defaults, notifications + Telegram test, scan/data, token status, retention), inherit-vs-override indicators on tickets, auto-prune by `deal_retention_days`.
- **Phase 7 — Polish:** feed filters, dismiss/seen, backoff/throttle hardening, image enrichment.

---

## 16. Acceptance criteria

Build a small fixture set of `marketplace/products` responses and assert:
1. **Fires:** cheapest `0.16` with next-10 median `0.32`, all EN/NM → deal at `discount_pct ≈ 50%`, `is_deal = true` at threshold 50.
2. **No fire (thin):** only 3 qualifying copies → skipped, no deal.
3. **No fire (not cheap enough):** cheapest `0.30`, median `0.34` → not a deal at threshold 50.
4. **Condition filter:** a `Poor` copy at `0.05` with `min_condition = Near Mint` is excluded and does not become the candidate.
5. **Foil filter:** `foil_pref = nonfoil` ignores foil listings entirely.
6. **Dedupe:** same `product_id` over two consecutive scans → one deal row, one Telegram push.
7. **Routing — app only:** a `telegram_enabled = false`, `normal` deal at 52% off appears in the feed, **no** Telegram.
8. **Routing — high importance:** a `high` item deal at 51% off → Telegram fires even below the global Telegram threshold.
9. **Routing — steep global:** a `telegram_enabled = true` deal at 65% off (≥ global 60%) → Telegram fires; the same item at 52% off → app only.
10. **Health:** a forced API 401 → `scan_runs.error` set, run aborts cleanly.

---

## 17. Future (v2+)
- Shipping-aware total cost (per-seller `shipping_methods`), CT Zero fee modeling.
- Re-alert on further price drops.
- Additional games (Pokémon, Yu-Gi-Oh!) — generalize property names (`<game>_language`, `<game>_foil`).
- Optional auto-add-to-cart hold (explicitly gated; out of v1).
