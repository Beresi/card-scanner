---
name: cardtrader-api
description: How to talk to the CardTrader public API v2 from the worker — the typed read-only client in src/cardtrader/. Load when writing or changing client.ts/types.ts, calling /info, /expansions, /blueprints/export, or /marketplace/products, or handling CardTrader auth, throttling, 429 backoff, or money-as-cents.
---

# CardTrader API

## Purpose

Patterns for the **only** module that talks HTTP to CardTrader: `src/cardtrader/client.ts`
(fetch wrapper, throttle, backoff, public functions) and `src/cardtrader/types.ts` (wire
types narrowed from `unknown`). The client owns Bearer auth, ~1 req/s throttling, 429
backoff, and parsing the wire into typed shapes. It owns **no** deal logic and **no**
persistence — callers (`scan/scanner.ts`) get clean data and decide what to do.

- Base URL: `https://api.cardtrader.com/api/v2`
- Auth: every request carries `Authorization: Bearer ${CARDTRADER_API_TOKEN}`
- Game is always MTG (`game_id = 1`); the client does not parameterize game.
- **Read endpoints only. Never call a purchase/checkout endpoint** — this tool alerts, it
  does not buy.

### Endpoints used
| Function | Request | Use |
|---|---|---|
| `info()` | `GET /info` | Token validation / health check on startup. 401 ⇒ abort run, alert once. |
| `expansions()` | `GET /expansions` | Refresh the local expansion cache. |
| `blueprintsExport(id)` | `GET /blueprints/export?expansion_id=X` | All printings in a set → blueprint cache. |
| `marketplaceProducts(q)` | `GET /marketplace/products?blueprint_id\|expansion_id=X&language=en[&foil=…]` | Core: cheapest 25 listings, keyed by blueprint id. Throttled ~1 req/s. |

`MarketplaceQuery` requires exactly one of `blueprintId` or `expansionId`, plus
`language` (always `'en'`), and `foil` only when the watch item's foil preference isn't
`"any"`. The `expansionId` variant returns every blueprint in the set in **one** call.

### Glossary (CardTrader concepts)
- **Game** — MTG (`game_id = 1`). Only game we use.
- **Expansion** — a set; integer `id` + `code`.
- **Blueprint** — a specific card printing; the unit a price comparison happens on.
- **Product** — one seller's listing of a blueprint (copy + price + condition + language + qty).
- **CT Zero / hub** — `user.can_sell_via_hub = true` ⇒ buyable via CardTrader's fulfillment hub.
- **Condition ladder** (best → worst): `Mint`, `Near Mint`, `Slightly Played`,
  `Moderately Played`, `Played`, `Heavily Played`, `Poor`.

## Core patterns

### 1. Typed fetch wrapper (Bearer + narrow from `unknown`)
Never return `any`. Parse the wire into a `types.ts` shape and throw a typed error carrying
endpoint context.

```ts
// src/cardtrader/client.ts
const BASE = 'https://api.cardtrader.com/api/v2';

export class CardTraderError extends Error {
  constructor(message: string, readonly endpoint: string, readonly status?: number) {
    super(message);
    this.name = 'CardTraderError';
  }
}

async function ctFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }, // NEVER log this header
  });
  if (res.status === 401) {
    throw new CardTraderError('invalid/expired token', path, 401);
  }
  if (!res.ok) {
    throw new CardTraderError(`HTTP ${res.status}`, path, res.status);
  }
  return res.json(); // typed as unknown — caller narrows
}

// Narrow at the boundary; the wire carries more fields than we read.
export async function info(token: string): Promise<Info> {
  const raw = await ctFetch('/info', token);
  return parseInfo(raw); // parseInfo lives in types.ts, narrows unknown → Info
}
```

### 2. Throttle (~1 req/s) + exponential backoff on 429
Requests are **sequential** with a ~1s gap between marketplace calls. On HTTP 429 — or a
body containing `"Too many requests"` — back off exponentially and retry the same request.

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialize marketplace calls: one shared promise chain enforces ~1 req/s.
let queue: Promise<unknown> = Promise.resolve();
function throttled<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const out = await job();
    await sleep(1000); // ~1 req/s — hourly scanning needs no speed
    return out;
  });
  queue = run.catch(() => undefined); // a failed job must not stall the chain
  return run;
}

async function withBackoff<T>(job: () => Promise<T>, endpoint: string): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await job();
    } catch (err) {
      const is429 =
        err instanceof CardTraderError && err.status === 429;
      if (!is429 || attempt === 4) throw err;
      await sleep(delay);
      delay *= 2; // 1s → 2s → 4s → 8s
    }
  }
  throw new CardTraderError('exhausted retries', endpoint, 429);
}

export function marketplaceProducts(
  q: MarketplaceQuery,
  token: string,
): Promise<MarketplaceResponse> {
  const param =
    'blueprintId' in q ? `blueprint_id=${q.blueprintId}` : `expansion_id=${q.expansionId}`;
  const foil = q.foil === undefined ? '' : `&foil=${q.foil}`;
  const path = `/marketplace/products?${param}&language=${q.language}${foil}`;
  return throttled(() => withBackoff(async () => parseMarketplace(await ctFetch(path, token)), path));
}
```

## Standards
@docs/standards/coding-standards.md

Money is the cardinal rule: `price.cents` is an **integer** in the account's currency
(`price.currency`). The client passes cents through as integers and never parses floats;
formatting happens only at the UI edge. No `any` — narrow from `unknown` at the boundary.

## `marketplace/products` response shape
Object keyed by blueprint id (string) → array of up to 25 cheapest products. Only the
load-bearing subset is shown; the wire carries more (`description`, `bundle_size`, etc.).

```jsonc
{
  "10050": [                          // key = blueprint_id (as string)
    {
      "id": 101862104,                // product_id — dedupe key + buy link (deals.product_id)
      "blueprint_id": 10050,
      "name_en": "Dragon Fodder",     // card_name
      "quantity": 1,                  // must be >= 1 to qualify
      "price": { "cents": 2, "currency": "USD" },  // INTEGER cents in account currency
      "properties_hash": {
        "condition": "Near Mint",     // ranked against min_condition
        "mtg_language": "en",         // must == "en" to qualify
        "mtg_foil": false             // matched against foil_pref unless "any"
      },
      "expansion": { "id": 92, "code": "ptkdf", "name_en": "Tarkir Dragonfury" },
      "user": {
        "username": "seller",
        "can_sell_via_hub": true,     // CT Zero eligible → badge / Telegram hint
        "country_code": "FI"
      },
      "graded": false,                // excluded unless allow_graded
      "on_vacation": false            // cannot buy if true → excluded
    }
  ]
}
```

The `blueprintId` variant returns the same shape with a single key. Callers iterate the map
values regardless of which variant produced it.

## Examples (Good / Bad)

### Good — iterate the keyed map, integer cents, skip-not-fatal
```ts
// A whole set in one call; iterate every blueprint's listings.
const bySet = await marketplaceProducts({ expansionId: 92, language: 'en' }, token);
for (const [blueprintId, products] of Object.entries(bySet)) {
  try {
    feedDealEngine(blueprintId, products); // products[i].price.cents stays an integer
  } catch (err) {
    log.warn('skipped blueprint', { blueprintId, err }); // one bad blueprint ≠ dead run
  }
}
```

### Bad — float money, `any`, no throttle/backoff, leaked token
```ts
async function getPrices(id: number): Promise<any> {                 // ❌ any
  const r = await fetch(`${BASE}/marketplace/products?blueprint_id=${id}`); // ❌ no Bearer, no throttle
  const data = await r.json();
  console.log('token', token);                                        // ❌ logs the secret
  return data['10050'].map((p: any) => p.price.cents / 100);          // ❌ float money, ❌ no 429 handling
}
```

## Gotchas
- **Token = read + WRITE scope.** `CARDTRADER_API_TOKEN` grants read **and** write/purchase
  scope on the account. High sensitivity. Never in source, D1, the client bundle, logs, or
  version control (Wrangler secret only). **Never log it. Rotate it if ever exposed.**
- **Read endpoints only.** This system alerts; it never purchases. Do not call any
  purchase/checkout endpoint even though the token allows it.
- **Throttle to ~1 req/s.** Docs contradict themselves ("1/s" and "10/s"); global cap is
  200 req / 10s. Serialize requests with a ~1s gap. Exponential backoff on HTTP 429 / a
  `"Too many requests"` body, then retry the same request.
- **A failed blueprint is logged and skipped — never fatal to the run.** Catch at the
  per-item boundary; whole-run failures land in `scan_runs.error`. Token 401 aborts the run
  and alerts once.
- **Lightly-cached prices.** `marketplace/products` is lightly cached; prices/quantities may
  rarely lag. Acceptable for alerting — the owner re-confirms the live price before buying.
- **Trust nothing on the wire.** Parse into `types.ts` shapes and narrow from `unknown`.
- **VERIFY at build — `expansion_id` + `language`.** Confirm the `language` filter is honored
  on the `expansionId` variant. If it is **not**, fall back to per-blueprint calls for sets
  (still fine hourly).
- **VERIFY at build — buy-URL pattern.** Likely `https://www.cardtrader.com/cards/{blueprint_id}`.
  Verify the real public URL; fall back to a search URL if it doesn't resolve.

## Related skills
- **deal-engine** — consumes the product lists (price-sort, cohort baseline, condition ladder).
- **telegram-notifications** — formats the buy link and CT Zero hint.
- **error-handling** — backoff, per-item skip, 401-abort-once, typed errors with context.
