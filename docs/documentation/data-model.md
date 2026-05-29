# D1 Data Layer
> Greenfield — describes intent. Planned files: `src/db/schema.sql`, `src/db/repo.ts`
> (planned). Backend: Cloudflare Worker (`/worker`), D1 / SQLite, binding `DB`. Full DDL
> lives in [PRD §9](../../cardtrader-deal-scanner-PRD.md); this doc documents the layer's
> shape, invariants, and the inheritance rule — it does not re-paste the schema.

## Purpose
D1 is the **only persistent state** in the system — there is no other store. The data layer
is two planned files: `schema.sql` (the DDL applied at setup) and `repo.ts` (typed query
helpers that wrap D1 prepared statements). Every other system — the scanner, the API routes,
the dashboard — reads and writes through `repo.ts`; nothing else talks raw SQL. The schema
is authoritative for table/column names ([naming-conventions](../standards/naming-conventions.md#database-d1--sqlite),
PRD §9); `repo.ts` is the typed seam over it.

## Table inventory
| Table | Role | Key constraint |
|---|---|---|
| `watchlist` | What to scan — one row per watched card or set; holds per-ticket override columns (NULL = inherit). | `UNIQUE(type, cardtrader_id, foil_pref)` |
| `deals` | Found deals — the in-app feed **and** the dedupe source of truth. | `UNIQUE(product_id)` |
| `config` | Single row (`id = 1`): deal-logic defaults, new-ticket starting values, notification globals, appearance, maintenance. | `CHECK (id = 1)` |
| `scan_runs` | Observability — one row per scan run (counts, timing, error). | — |
| `expansions` | Cache of CardTrader sets, for add-card search + display enrichment. | PK = CT expansion id |
| `blueprints` | Cache of CardTrader card printings, for add-card search + display enrichment. | PK = CT blueprint id |

## Tables — key columns & invariants
Full DDL is in [PRD §9](../../cardtrader-deal-scanner-PRD.md). Conventions that hold across
every table: **money is integer `_cents`** (never floats — PRD §6,
[coding-standards](../standards/coding-standards.md#money--the-cardinal-rule)); **booleans
are `INTEGER` 0/1**; **timestamps are `TEXT` ending in `_at`, defaulting to `datetime('now')`
(UTC)**.

### `watchlist`
- Identity: `type` is `'blueprint' | 'expansion'` (CHECK); `cardtrader_id` is the CT
  blueprint or expansion id; `label` is the display name.
- **Override columns** (resolve against `config` at scan time — see [Inheritance](#9a-inheritance)):
  `threshold_pct`, `min_condition`, `foil_pref`, `allow_graded`, `importance`,
  `telegram_enabled`, `telegram_min_discount_pct`, `telegram_max_price_cents`,
  `telegram_min_savings_cents`. The nullable ones (no `NOT NULL`) use NULL to mean "inherit".
- `active` (0/1) gates whether the scanner loads the row.
- Invariant: `UNIQUE(type, cardtrader_id, foil_pref)` — foil vs non-foil of the same card are
  distinct tickets, not duplicates (PRD §13).

### `deals`
- `product_id` is the dedupe key (`UNIQUE`) — one deal row and one Telegram push per listing
  ever (PRD §7 step 7, §8). Upsert uses `ON CONFLICT(product_id) DO NOTHING`; the rows that
  actually insert are the "new" deals for the run.
- `watchlist_id` is `REFERENCES watchlist(id) ON DELETE CASCADE` — deleting a ticket removes
  its deals.
- Money: `price_cents`, `baseline_cents` are integer cents; `currency` rides alongside.
  `discount_pct` is the computed percent.
- State flags (0/1): `seen`, `dismissed`, `telegram_sent` (+ `telegram_sent_at`). `priority`
  is `'high' | 'normal'`, set by routing.
- Indexes: `idx_deals_found_at` on `(found_at DESC)` (feed order), `idx_deals_open` on
  `(dismissed, found_at DESC)` (the default "open deals" feed query).

### `config`
- Exactly one row, enforced by `CHECK (id = 1)`. The Settings page is the only writer
  (PATCH `/api/config`). Groups: deal-logic defaults (`default_threshold_pct`,
  `default_min_condition`, `cohort_size`, `min_cohort`), new-ticket starting values
  (`new_ticket_*`), notification globals (`telegram_min_discount_pct` default 60, quiet
  hours, digest), appearance (`theme`, `accent_color`, `density`), maintenance
  (`deal_retention_days`, `timezone`).
- Inherited defaults vs new-ticket starters are distinct: `default_*`/`cohort_size`/
  `min_cohort` are read live at scan time; `new_ticket_*` only pre-fill the add form.

### `scan_runs`
- One row per run, opened at start (`started_at`) and closed at end (`finished_at`, counts,
  `error`). It is the durable run log ([coding-standards](../standards/coding-standards.md#logging));
  a whole-run failure is recorded in `error` and the run still closes cleanly. Feeds the
  Health view and `/api/health`.

### `expansions` / `blueprints`
- Read-mostly caches keyed by the CardTrader id (so upserts are idempotent). Populated from
  `/expansions` and `/blueprints/export` (see [cardtrader-client](cardtrader-client.md));
  `synced_at` tracks staleness. `blueprints` carries `name`, `expansion_id`, `scryfall_id`,
  `image_url` for the add-card UX and feed enrichment. Indexes `idx_blueprints_exp`
  (`expansion_id`) and `idx_blueprints_name` (`name`) back the resolve/search endpoints.

## §9a Inheritance
This rule is shared with the UI (the inherit-vs-override indicators) and the scanner, so it
must be defined once and reused. Spec: [PRD §9a](../../cardtrader-deal-scanner-PRD.md).

Every `watchlist` override column resolves at **scan time** as:

```ts
effective = ticket.value !== null ? ticket.value : config.matchingDefault;
```

| Ticket override column | Falls back to `config` column |
|---|---|
| `threshold_pct` | `default_threshold_pct` |
| `min_condition` | `default_min_condition` |
| `foil_pref` | `new_ticket_foil_pref` |
| `allow_graded` | `new_ticket_allow_graded` |
| `importance` | `new_ticket_importance` |
| `telegram_enabled` | `new_ticket_telegram_enabled` |
| `telegram_min_discount_pct` | `telegram_min_discount_pct` (global) |
| `telegram_max_price_cents` | no cap (NULL = unbounded) |
| `telegram_min_savings_cents` | no floor (NULL = unbounded) |

### Rules
- **NULL follows the moving default.** A ticket left to "use default" tracks the global value
  even if it changes later — defaults are a live baseline, not a copy.
- **An explicit value is sticky.** Once a ticket has a non-NULL value, changing the global
  default does not touch it.
- **New tickets are born inheriting.** The add form is pre-filled from `config.new_ticket_*`
  and the deal-logic defaults, but a ticket created with no edits keeps its override columns
  **NULL** — it references the defaults, it does not copy them in.
- **The UI distinguishes inherit vs override** per field ("inheriting (default: X)" vs an
  explicit value) and offers a one-tap **reset** that nulls the column —
  `PATCH /api/watchlist/:id/reset`.

### One place for the rule
Put the resolution in a single `resolveEffective(ticket, config)` helper (in `repo.ts` or a
small dedicated module) and call it from the scanner and anywhere the effective value is
needed. Do **not** scatter `?? config.x` fallbacks across call sites
([coding-standards](../standards/coding-standards.md#typescript)). It is a pure function
(ticket + config in, effective values out) and unit-testable.

## Public interface (`repo.ts`, planned)
Typed helpers wrapping D1 prepared statements — callers pass/receive typed shapes, never raw
SQL strings. Sketch of the categories:

| Category | Helpers (planned) | Notes |
|---|---|---|
| Watchlist | `listWatchlist`, `getWatchlist`, `createWatchlist`, `updateWatchlist`, `deleteWatchlist`, `resetField` | `resetField` nulls one override column → inherit; backs `/api/watchlist/:id/reset`. |
| Deals | `upsertDeal` (`ON CONFLICT(product_id) DO NOTHING`), `listDeals` (filter status/min_discount/watchlist_id/priority), `patchDeal` (seen/dismissed/telegram_sent), `pruneDeals` | `upsertDeal` returns whether the row was newly inserted. |
| Config | `getConfig`, `patchConfig` | Always operates on `id = 1`. |
| Scan runs | `openScanRun`, `closeScanRun` | Open at start, close with counts + error. |
| Caches | `upsertExpansions`, `searchExpansions`, `upsertBlueprints`, `searchBlueprints` | Idempotent upsert by CT id; search backs resolve endpoints. |
| Inheritance | `resolveEffective(ticket, config)` | Pure; the single source of the §9a rule. |

## Maintenance
- **Retention prune.** `config.deal_retention_days` auto-prunes deals older than N days;
  **`0` = keep forever**. Surfaced as `DELETE /api/deals?older_than_days=` (Settings →
  Maintenance, PRD §10) and runnable on a schedule.

## Gotchas
- **`config` is a single enforced row.** `CHECK (id = 1)` — never `INSERT` a second config
  row; always read/patch `id = 1`. Seed exactly one row at setup.
- **Booleans are `0`/`1`, not `true`/`false`.** SQLite has no boolean type. Write integers in
  queries; convert at the `repo.ts` boundary so the rest of the code sees real booleans.
- **Timestamps are UTC.** `datetime('now')` is UTC. Format to `config.timezone` only at the
  edge (the UI / Telegram message) — never store local time
  ([coding-standards](../standards/coding-standards.md#money--the-cardinal-rule) money rule
  has the same shape: integers/UTC in the core, formatting at the edge).
- **Resolve inheritance in ONE place.** Re-deriving `ticket.value ?? config.default` inline
  anywhere other than `resolveEffective` is a bug waiting to drift. The scanner, routing, and
  UI-facing effective-value reads all go through the one helper.
- **`UNIQUE(product_id)` is the dedupe contract.** Don't add a second deal-insert path that
  bypasses the `ON CONFLICT` clause — that would double-alert.

## See also
- [architecture](architecture.md) — how the data layer fits the Worker + scan flow.
- [deal-engine](deal-engine.md) — produces the deal rows written here.
- [cardtrader-client](cardtrader-client.md) — source of cache + listing data.
- [PRD §9 / §9a](../../cardtrader-deal-scanner-PRD.md) — authoritative DDL and inheritance spec.
