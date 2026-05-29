# CardTrader API Client
> Greenfield — describes intent. Planned files; no code yet. Spec:
> [PRD §6](../../cardtrader-deal-scanner-PRD.md). Lives in the `/worker` backend (PRD §14).

## Purpose
A thin, typed wrapper over the [CardTrader](https://www.cardtrader.com) public API v2. It is
the only module that talks HTTP to CardTrader: it owns Bearer auth, throttling, 429 backoff,
and parsing the wire into typed shapes. It owns **no** deal logic and **no** persistence —
callers ([`scan/scanner.ts`](architecture.md)) get clean data and decide what to do with it.

- Base URL: `https://api.cardtrader.com/api/v2`
- Auth: every request carries `Authorization: Bearer ${CARDTRADER_API_TOKEN}`
- Game is always MTG (`game_id = 1`, PRD §3); the client does not parameterize game.

## Planned files
| Path | Role |
|---|---|
| `src/cardtrader/client.ts` *(planned)* | The fetch wrapper: auth header, throttle queue, backoff, the public functions below. |
| `src/cardtrader/types.ts` *(planned)* | Wire types (`Product`, `PropertiesHash`, `Expansion`, `Blueprint`, `MarketplaceResponse`, etc.). Parsed/narrowed at the boundary — don't trust the wire (coding-standards: no `any`). |

## Public interface
Each function maps to one row of the PRD §6 endpoints table.

| Function | Signature | Maps to | Notes |
|---|---|---|---|
| `info()` | `() => Promise<Info>` | `GET /info` | Token validation / health check on startup. 401 ⇒ abort the run, alert once (PRD §11). |
| `expansions()` | `() => Promise<Expansion[]>` | `GET /expansions` | Refresh the local `expansions` cache (set-watching + add-card UX). |
| `blueprintsExport(expansionId)` | `(expansionId: number) => Promise<Blueprint[]>` | `GET /blueprints/export?expansion_id=X` | All printings in a set → `blueprints` cache. |
| `marketplaceProducts(params)` | `(params: MarketplaceQuery) => Promise<MarketplaceResponse>` | `GET /marketplace/products?…` | Core call. Cheapest 25 listings, keyed by blueprint id. Throttled to ~1 req/s. |

```ts
// MarketplaceQuery — exactly one of blueprintId | expansionId is required.
type MarketplaceQuery =
  | { blueprintId: number;  language: string; foil?: boolean }
  | { expansionId: number;  language: string; foil?: boolean };
```

- Always pass `language: 'en'` (PRD §6); pass `foil` only when the watch item's foil
  preference is not `"any"`.
- The `expansionId` variant returns every blueprint in the set in **one** call — the map is
  keyed by blueprint id (see below).

## `marketplace/products` response shape
An object keyed by blueprint id (string) → array of up to 25 cheapest products. Only the
fields the rest of the system reads are documented here; the wire carries more.

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
        "condition": "Near Mint",     // ranked against min_condition (PRD §7)
        "mtg_language": "en",         // must == "en" to qualify
        "mtg_foil": false             // matched against foil_pref unless "any"
      },
      "expansion": { "id": 92, "code": "ptkdf", "name_en": "Tarkir Dragonfury" },
      "user": {
        "username": "seller",
        "can_sell_via_hub": true,     // CT Zero eligible → badge / Telegram hint
        "country_code": "FI"
      },
      "graded": false,                // excluded unless allow_graded (PRD §7)
      "on_vacation": false            // cannot buy if true → excluded
    }
  ]
}
```

The `blueprintId` variant returns the same shape with a single key. Callers iterate the map
values regardless of which variant produced it (PRD §11 step 4).

## Rate limits & throttling
| Limit | Value | Handling |
|---|---|---|
| Global | 200 requests / 10 seconds | Stay well under by serializing requests. |
| `marketplace/products` | docs contradictory ("1/s" and "10/s") | **Throttle to ~1 req/s** — hourly scanning needs no speed (PRD §6). |
| HTTP 429 / `"Too many requests"` body | — | **Exponential backoff**, then retry the same request. |

Implementation: requests are **sequential** with a ~1s delay between marketplace calls; a
single failed blueprint fetch is logged and **skipped — never fatal to the run** (PRD §13,
coding-standards "Error handling"). Throw typed errors carrying context (which endpoint,
which blueprint/expansion id), not bare strings.

## Money
`price.cents` is an **integer** in the account's native currency (`price.currency`). The
client passes cents through as integers and never parses them into floats. All downstream
money is integer cents (coding-standards "Money — the cardinal rule"); display formatting
happens only at the UI edge.

## Auth & secrets
| Item | Where | Sensitivity |
|---|---|---|
| `CARDTRADER_API_TOKEN` | Wrangler secret (PRD §5, §12) | **High** — grants read **and** write/purchase scope on the account. |

- Never in source, D1, the client bundle, logs, or version control (coding-standards
  "Logging": never log the token).
- **Rotate the token if it is ever exposed** (PRD §12). The Settings page surfaces live
  token status from `GET /info` with a rotation reminder (PRD §10).

## Examples
```ts
// One card's cheapest 25, English only.
const byBlueprint = await marketplaceProducts({ blueprintId: 10050, language: 'en' });
const listings = byBlueprint['10050'] ?? [];

// A whole set in one call; iterate every blueprint's listings.
const bySet = await marketplaceProducts({ expansionId: 92, language: 'en' });
for (const [blueprintId, products] of Object.entries(bySet)) {
  // feed `products` into the deal engine (PRD §7)
}

// Non-foil-only watch item.
await marketplaceProducts({ blueprintId: 10050, language: 'en', foil: false });
```

## Gotchas
- **`expansion_id` + `language` filter is unverified.** Confirm the `language` filter is
  honored on the `expansionId` variant during build; if it is **not**, fall back to
  per-blueprint calls for sets (still fine hourly) (PRD §6, §13).
- **Buy-URL pattern is unverified.** The likely pattern is
  `https://www.cardtrader.com/cards/{blueprint_id}` — verify the real public URL during
  build and fall back to a search URL if needed (PRD §6). The client may expose a helper,
  but the pattern itself is not yet confirmed.
- **Lightly-cached prices.** `marketplace/products` is lightly cached; prices/quantities may
  rarely lag. Acceptable for alerting — the owner re-confirms the live price on CardTrader
  before buying (PRD §6, §13).
- **Trust nothing on the wire.** Parse responses into the `types.ts` shapes and narrow from
  `unknown`; the documented fields above are the load-bearing subset, not the full payload.
```
