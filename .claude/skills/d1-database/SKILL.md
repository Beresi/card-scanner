---
name: d1-database
description: Working with Cloudflare D1 (SQLite) in this project — the prepared-statement pattern, the table set, the upsert/dedupe contract, money-as-cents / boolean-as-0-1 / UTC conventions, and applying schema. Load before touching src/db/schema.sql, src/db/repo.ts, or any raw D1 query.
---

# D1 Database

## Purpose
D1 is the **only** persistent store — no Firebase, no ORM. Two files own it: `src/db/schema.sql`
(the DDL applied at setup) and `src/db/repo.ts` (typed helpers wrapping D1 prepared statements).
Everything else — scanner, API routes, dashboard — reads and writes through `repo.ts`; nothing
else issues raw SQL. Use prepared statements via the Worker binding `DB`:
`env.DB.prepare(sql).bind(...).first() / .all() / .run()`, and `env.DB.batch([...])` for atomic
multi-statement work. Full DDL: [PRD §9](../../../cardtrader-deal-scanner-PRD.md); layer shape:
[data-model](../../../docs/documentation/data-model.md).

## Tables
| Table | Role | Key constraint |
|---|---|---|
| `watchlist` | What to scan — one row per watched card/set; per-ticket override columns (NULL = inherit). | `UNIQUE(type, cardtrader_id, foil_pref)` |
| `deals` | Found-deal feed **and** the dedupe source of truth. | `UNIQUE(product_id)`, `watchlist_id` FK `ON DELETE CASCADE` |
| `config` | Single row (`id = 1`): defaults, new-ticket starters, notification globals, appearance, maintenance. | `CHECK (id = 1)` |
| `scan_runs` | Observability — one row per scan run (counts, timing, `error`). | — |
| `expansions` | Cache of CardTrader sets. | PK = CT expansion id |
| `blueprints` | Cache of CardTrader printings. | PK = CT blueprint id |

## Core patterns

### Typed repo helper (prepare / bind / first)
Callers pass and receive typed shapes — never raw SQL. Convert booleans (0/1) and resolve
nothing here; conversion happens at this boundary so the rest of the code sees real booleans.

```ts
// src/db/repo.ts
export interface WatchlistRow {
  id: number;
  type: 'blueprint' | 'expansion';
  cardtraderId: number;
  thresholdPct: number | null;   // NULL = inherit (do NOT coalesce here — see §9a)
  active: boolean;
}

export async function getWatchlist(db: D1Database, id: number): Promise<WatchlistRow | null> {
  const r = await db
    .prepare('SELECT id, type, cardtrader_id, threshold_pct, active FROM watchlist WHERE id = ?')
    .bind(id)
    .first<{ id: number; type: 'blueprint' | 'expansion'; cardtrader_id: number; threshold_pct: number | null; active: number }>();
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    cardtraderId: r.cardtrader_id,
    thresholdPct: r.threshold_pct,     // keep NULL — inheritance resolved in ONE place
    active: r.active === 1,            // 0/1 → boolean at the edge
  };
}
```

### Upsert + new-row detection (the dedupe contract)
`UNIQUE(product_id)` means one deal row and one Telegram push per listing, ever. Insert with
`ON CONFLICT(product_id) DO NOTHING`; the rows that actually insert are the truly-new deals for
the run. `.run()` exposes the row count in `meta.changes` — use it to decide "new vs already seen".

```ts
/** Returns true iff this product_id was newly inserted (i.e. a brand-new deal). */
export async function upsertDeal(db: D1Database, d: DealInsert): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO deals
         (watchlist_id, blueprint_id, product_id, card_name, price_cents,
          currency, baseline_cents, cohort_size, discount_pct, priority, found_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(product_id) DO NOTHING`,
    )
    .bind(
      d.watchlistId, d.blueprintId, d.productId, d.cardName, d.priceCents,
      d.currency, d.baselineCents, d.cohortSize, d.discountPct, d.priority,
    )
    .run();
  return res.meta.changes === 1;   // 0 = conflict (already known) → not new, no push
}
```

For many deals in one run, wrap the inserts in `db.batch([...])` so they apply atomically.

## Standards
@docs/standards/naming-conventions.md
@docs/standards/coding-standards.md

Tables/columns are `snake_case` and match PRD §9 **exactly** — do not rename. Money columns end
in `_cents` (integer), percent in `_pct`, timestamps in `_at`. Repo helpers expose `camelCase`
typed shapes; the wire format (API JSON) stays `snake_case` to mirror the DB and CardTrader.

## Examples (Good / Bad)

### Good — always bind parameters; operate config on id=1
```ts
await db.prepare('UPDATE config SET default_threshold_pct = ? WHERE id = 1').bind(pct).run();
const open = await db
  .prepare('SELECT * FROM deals WHERE dismissed = 0 ORDER BY found_at DESC')  // uses idx_deals_open
  .all();
```

### Bad — string interpolation, true/false, second config row, scattered fallback
```ts
db.prepare(`UPDATE config SET theme = '${theme}'`).run();          // SQL injection; no bind
db.prepare('INSERT INTO deals (..., seen) VALUES (..., false)');   // booleans are 0/1, not false
db.prepare('INSERT INTO config (id) VALUES (2)');                  // CHECK(id=1) — only one row
const eff = ticket.thresholdPct ?? config.defaultThresholdPct;     // inline inherit — must use resolveEffective()
```

## Gotchas
- **`config` is one enforced row.** `CHECK (id = 1)` — never `INSERT` a second; always read/patch
  `id = 1`. Seed exactly one row at setup.
- **Booleans are `0`/`1`, not `true`/`false`.** SQLite has no boolean type. Bind integers; convert
  to real booleans at the `repo.ts` boundary.
- **Timestamps are UTC.** `datetime('now')` is UTC; columns end in `_at`. Format to
  `config.timezone` only at the edge (UI / Telegram) — never store local time.
- **Dedupe on `product_id`.** Don't add a deal-insert path that bypasses `ON CONFLICT(product_id)
  DO NOTHING` — that double-alerts. Use `meta.changes` to find truly-new rows.
- **Resolve inheritance in ONE place.** Every `watchlist` override column (NULL = inherit) resolves
  at scan time as `effective = ticket.value !== null ? ticket.value : config.matchingDefault`.
  Put it in a single `resolveEffective(ticket, config)` helper — never inline `?? config.x` at call
  sites. See the inherit-override skill for the full rule + the override→default mapping table.
- **Migrations.** Apply schema with `wrangler d1 execute DB --file=src/db/schema.sql`. Later changes
  go in ordered files `src/db/NNNN_description.sql` (zero-padded), applied with the same command.

## Related skills
- inherit-override — the §9a resolution rule + override→default mapping (shared with the UI; don't duplicate it here)
- backend-dev — where `repo.ts` helpers and API routes live
- cloudflare-workers — the `DB` binding and Worker environment
