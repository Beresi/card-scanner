---
name: backend-dev
description: Load when building or editing the Worker backend — Hono routes, the D1 repo, the scanner orchestration, the index.ts {fetch, scheduled} entry, or backend TypeScript conventions.
---

# Backend Development

## Purpose
How to build the backend layers of the CardTrader Deal Scanner: a single Cloudflare Worker
(Hono `fetch` + cron `scheduled`) over Cloudflare D1 (binding `DB`). Routes are thin
controllers that validate input and delegate; all SQL lives behind a typed `db/repo.ts`; the
pure domain core (engine, conditions, routing) does no I/O. Money is integer cents; the wire
and DB are `snake_case`; TypeScript is strict with no `any`.

## Module layout (PRD §14)
One folder per domain — match it exactly ([naming-conventions](../../../docs/standards/naming-conventions.md)):

```
src/
  index.ts                  # Hono app + export default { fetch, scheduled }
  cardtrader/{client,types}.ts
  scan/{scanner,dealEngine,conditions}.ts   # dealEngine + conditions are PURE
  telegram/{notifier,routing}.ts            # routing is PURE
  db/{schema.sql,repo.ts}                   # only place that touches raw SQL
  api/{watchlist,deals,config,resolve,health,scan}.ts   # thin Hono controllers
```

Layering rule: `api/*` → `repo.ts` / `scanner.ts` / `notifier.ts`. The scanner orchestrates;
the engine/conditions/routing are pure functions called by it. Nothing but `repo.ts` writes SQL.

## Core patterns

### `index.ts` — one Worker, two entrypoints
Both the cron and `POST /api/scan/run-now` call the same `runScan` (PRD §4, [scanner](../../../docs/documentation/scanner.md)).

```ts
import { Hono } from 'hono';
import { watchlist } from './api/watchlist';
import { deals } from './api/deals';
import { config } from './api/config';
import { resolve } from './api/resolve';
import { health } from './api/health';
import { scan } from './api/scan';
import { runScan } from './scan/scanner';

export type Env = {
  DB: D1Database;
  CARDTRADER_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
};

const app = new Hono<{ Bindings: Env }>();

app.route('/api/health', health);
app.route('/api/config', config);
app.route('/api/watchlist', watchlist);
app.route('/api/deals', deals);
app.route('/api/resolve', resolve);
app.route('/api', scan); // /api/scan/run-now, /api/telegram/test

export default {
  fetch: app.fetch,
  // hourly cron ["0 * * * *"] — identical code path to run-now
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScan(env, { trigger: 'cron' }).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
```

### Thin Hono controller — validate, delegate, shape `snake_case`
No business logic in a handler. Parse/clamp/enum-check input, call the repo, return cents
as integers in `snake_case` ([http-api](../../../docs/documentation/http-api.md)).

```ts
import { Hono } from 'hono';
import type { Env } from '../index';
import { listDeals, patchDeal } from '../db/repo';

type DealStatus = 'open' | 'dismissed';
const STATUSES = ['open', 'dismissed'] as const;
const PRIORITIES = ['high', 'normal'] as const;

export const deals = new Hono<{ Bindings: Env }>();

deals.get('/', async (c) => {
  const q = c.req.query();
  const status = (STATUSES as readonly string[]).includes(q.status ?? '')
    ? (q.status as DealStatus)
    : 'open';
  const minDiscount = clampInt(q.min_discount, 0, 100, 0);
  const priority = (PRIORITIES as readonly string[]).includes(q.priority ?? '')
    ? q.priority
    : undefined;

  const rows = await listDeals(c.env.DB, { status, minDiscount, priority });
  return c.json(rows); // repo already returns snake_case, cents-as-integers shapes
});

deals.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ seen?: boolean; dismissed?: boolean }>();
  // reject unknown fields — only seen/dismissed are patchable here
  const patch: { seen?: boolean; dismissed?: boolean } = {};
  if (typeof body.seen === 'boolean') patch.seen = body.seen;
  if (typeof body.dismissed === 'boolean') patch.dismissed = body.dismissed;

  await patchDeal(c.env.DB, id, patch);
  return c.body(null, 204);
});

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
```

### Typed D1 prepared-statement helper (in `repo.ts`)
Callers pass/receive typed shapes, never raw SQL. Booleans cross the boundary as real
booleans; 0/1 conversion happens here ([data-model](../../../docs/documentation/data-model.md)).

```ts
type DealRow = {
  id: number;
  watchlist_id: number;
  card_name: string;
  price_cents: number;     // integer cents
  baseline_cents: number;  // integer cents
  discount_pct: number;
  priority: 'high' | 'normal';
  seen: boolean;
  dismissed: boolean;
};

export async function listDeals(
  db: D1Database,
  filter: { status: 'open' | 'dismissed'; minDiscount: number; priority?: string },
): Promise<DealRow[]> {
  const dismissed = filter.status === 'dismissed' ? 1 : 0;
  const { results } = await db
    .prepare(
      `SELECT id, watchlist_id, card_name, price_cents, baseline_cents,
              discount_pct, priority, seen, dismissed
         FROM deals
        WHERE dismissed = ?1 AND discount_pct >= ?2
          AND (?3 IS NULL OR priority = ?3)
        ORDER BY found_at DESC`,
    )
    .bind(dismissed, filter.minDiscount, filter.priority ?? null)
    .all<Record<string, unknown>>();

  return results.map((r) => ({
    ...(r as unknown as DealRow),
    seen: r.seen === 1,         // INTEGER 0/1 → boolean at the seam
    dismissed: r.dismissed === 1,
  }));
}

// Dedupe contract: one row + one push per listing, ever (PRD §7/§13).
export async function upsertDeal(db: D1Database, deal: NewDeal): Promise<{ inserted: boolean }> {
  const res = await db
    .prepare(
      `INSERT INTO deals (product_id, watchlist_id, price_cents, baseline_cents, discount_pct, priority)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(product_id) DO NOTHING`,
    )
    .bind(deal.productId, deal.watchlistId, deal.priceCents, deal.baselineCents, deal.discountPct, deal.priority)
    .run();
  return { inserted: (res.meta.changes ?? 0) > 0 }; // inserted rows = the new deals this run
}
```

## Standards
@docs/standards/coding-standards.md
@docs/standards/naming-conventions.md

## Examples

### Good
`PATCH /api/watchlist/:id/reset` nulls one override column — the route validates the field
name against the known override columns and delegates; the SQL lives in the repo.

```ts
const OVERRIDE_COLUMNS = [
  'threshold_pct', 'min_condition', 'foil_pref', 'allow_graded', 'importance',
  'telegram_enabled', 'telegram_min_discount_pct', 'telegram_max_price_cents',
  'telegram_min_savings_cents',
] as const;
type OverrideColumn = (typeof OVERRIDE_COLUMNS)[number];

watchlist.patch('/:id/reset', async (c) => {
  const id = Number(c.req.param('id'));
  const { field } = await c.req.json<{ field: string }>();
  if (!(OVERRIDE_COLUMNS as readonly string[]).includes(field)) {
    return c.json({ error: 'invalid field' }, 400);
  }
  await resetField(c.env.DB, id, field as OverrideColumn); // repo nulls the column → inherit
  return c.body(null, 204);
});
```

Why it is good: the enum guard rejects arbitrary column names (no SQL injection via `field`),
the handler holds no SQL, and "reset = null" (§9a) stays the repo's job.

### Bad
```ts
// ❌ business logic + raw SQL + float money + leaked error in a route handler
deals.get('/', async (c) => {
  const min = c.req.query('min_discount'); // unvalidated, untyped
  try {
    const rows = await c.env.DB
      .prepare(`SELECT * FROM deals WHERE discount_pct > ${min}`) // string interp → injection
      .all();
    return c.json(rows.results.map((r: any) => ({   // `any`, raw row passthrough
      ...r,
      price: r.price_cents / 100,                    // float money — banned
      seen: r.seen,                                  // 0/1 leaks instead of boolean
    })));
  } catch (e) {
    return c.json({ error: String(e) }, 500);        // leaks internal/DB detail to client
  }
});
```
Why it is bad: SQL in the controller, string-interpolated query (injection), `any`, raw row
passthrough, float money, 0/1 booleans on the wire, and the internal error reaches the client.

## Gotchas
- **Thin controllers only.** No deal math, routing math, or SQL in `api/*`. Validate input,
  call `repo`/`scanner`/`notifier`, shape the `snake_case` response — nothing more.
- **Never expose internal errors.** Return generic client messages; never echo a DB or
  CardTrader error, stack, or secret. `/api/health` reports token *status*, not the token.
- **Validate every input.** Coerce/clamp numeric query params, check enums (`status`,
  `priority`, `foil_pref`, `importance`, `min_condition`), reject unknown PATCH fields.
  Never string-interpolate input into SQL — always `.bind(...)` parameters.
- **D1 booleans are 0/1.** SQLite has no boolean. Write integers in queries, convert to real
  booleans at the `repo.ts` seam so the rest of the backend sees `true`/`false`.
- **Money is integer cents.** Never store/compute/return float money; carry the currency
  code alongside; format only at the UI edge — never in the Worker.
- **PATCH = changed fields only.** Build the SET clause from present keys; don't round-trip
  the whole row. New watch items are born inheriting — omit override fields (leave NULL).
- **`config` is one row (`id = 1`).** `getConfig`/`patchConfig` always target `id = 1`; never
  insert a second config row.
- **One scan path.** `scheduled` and `POST /api/scan/run-now` both call `runScan`; don't fork
  a second implementation. `runScan` always resolves and closes `scan_runs` in a `finally`.
- **No `any`.** Parse the D1/CardTrader wire into typed shapes with `unknown` + narrowing;
  use discriminated unions for domain unions (`FoilPref`, condition) — not enums.
- **Secrets come from `env` only.** `CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID` ride on the Worker `env`; never read elsewhere, never log them.

## Related skills
- cloudflare-workers — Worker/Hono/cron runtime + Wrangler config and secrets
- d1-database — schema, prepared statements, the §9a inheritance resolver
- error-handling — backoff, non-fatal per-blueprint skip, `scan_runs.error`, alert-once on 401
