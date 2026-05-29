# Naming Conventions
> Greenfield — these are the conventions to establish, derived from PRD §14 and the
> Tauri/React/Hono/Rust ecosystems. Document existing patterns once code lands.

## Files & folders

### Backend (Cloudflare Worker — TypeScript)
Follows PRD §14 exactly.
- Modules: `camelCase.ts` — `dealEngine.ts`, `conditions.ts`, `client.ts`, `repo.ts`.
- One folder per domain: `cardtrader/`, `scan/`, `telegram/`, `db/`, `api/`.
- API route files are named after the resource: `api/watchlist.ts`, `api/deals.ts`.
- SQL: `schema.sql`; migrations (if added) `NNNN_description.sql` (zero-padded, ordered).
- Types files: `types.ts` colocated with the client/domain they describe.

### Desktop frontend (React + Vite — TypeScript)
- **Components:** `PascalCase.tsx` — `DealCard.tsx`, `WatchlistTable.tsx`, `InheritField.tsx`.
- **Hooks:** `useCamelCase.ts` — `useDeals.ts`, `useConfig.ts`, `useScanStatus.ts`.
- **Non-component modules:** `camelCase.ts` — `apiClient.ts`, `format.ts`, `fuzzy.ts`.
- **CSS:** tokens in `tokens.css`; component-scoped CSS modules `Component.module.css`
  (or co-located CSS per the chosen styling approach — decide at scaffold).
- **Folders:** `kebab-case/` for feature/view dirs — `views/deal-feed/`, `views/watchlist/`.
- One folder per view; shared primitives in `components/` (mirrors the prototype's
  `components.jsx` set: Panel, Btn, Status, Tag, Segmented, Switch, InheritField, PriceBar).

### Tauri host (Rust)
- Files: `snake_case.rs` — `main.rs`, `commands.rs`, `secure_store.rs`.
- Modules and functions: `snake_case`; types/structs/enums: `PascalCase`.
- Tauri commands: verb-first `snake_case` — `open_buy_url`, `get_api_token`, `set_api_token`.

## Identifiers (TypeScript)
- Variables / functions: `camelCase`.
- Types / interfaces / React components / classes: `PascalCase`. No `I`-prefix on interfaces.
- Constants / enums-of-literals: `SCREAMING_SNAKE_CASE` for true constants
  (`CONDITION_RANK`, `DEFAULT_THRESHOLD_PCT`); `PascalCase` for type unions.
- Booleans read as predicates: `isDeal`, `telegramEnabled`, `canSellViaHub`, `onVacation`.
- **Money variables carry the unit:** suffix `_cents` / `Cents` — `priceCents`,
  `baselineCents`, `savingsCents`. Never an un-suffixed `price` holding cents.
- Discount/percent fields: suffix `Pct` — `discountPct`, `thresholdPct`.

## Database (D1 / SQLite)
Per PRD §9 — match it exactly; do not rename.
- Tables: `snake_case`, singular-ish domain nouns — `watchlist`, `deals`, `config`,
  `scan_runs`, `expansions`, `blueprints`.
- Columns: `snake_case` — `product_id`, `price_cents`, `telegram_min_discount_pct`.
- Money columns end in `_cents`; percent columns end in `_pct`; timestamps end in `_at`.
- Booleans stored as `INTEGER` 0/1 (SQLite) — `seen`, `dismissed`, `telegram_sent`, `active`.
- Dedupe/unique keys explicit: `UNIQUE(product_id)`, `UNIQUE(type, cardtrader_id, foil_pref)`.

## API endpoints (Hono)
Per PRD §10 — match exactly.
- Prefix `/api/`; resources are plural nouns — `/api/deals`, `/api/watchlist`, `/api/config`.
- Path params: `/api/deals/:id`. Sub-actions as path segments: `/api/watchlist/:id/reset`,
  `/api/scan/run-now`, `/api/telegram/test`.
- Query params `snake_case` to match the DB: `?status=&min_discount=&watchlist_id=&priority=`.
- PATCH for partial updates with a JSON body of the changed fields only.

## JSON / DTO fields
- API request/response bodies use `snake_case` to mirror the DB and the CardTrader API
  (`price.cents`, `properties_hash`, `can_sell_via_hub`). Map to `camelCase` at the
  frontend boundary if desired, but keep the wire format `snake_case` and consistent.

## CSS custom properties (design tokens)
Per README — match the prototype token names exactly: `--bg`, `--panel`, `--panel-2`,
`--line`, `--text-dim`, `--accent`, `--hot`, `--good`, `--warn`, `--pad`, `--row`,
`--radius`, `--glow`, `--bg-grid`. Component classes use the `cb-` prefix from the
prototype (`cb-panel`, `cb-btn`, `cb-tag`, `cb-seg`, `cb-pbar`).

## Git
- Branches: `type/short-description` — `feat/deal-engine`, `fix/429-backoff`,
  `chore/tauri-scaffold`, `docs/architecture`.
- Commits: Conventional Commits — `feat(scan): median baseline over cohort`,
  `fix(telegram): respect quiet hours`, `chore(desktop): wire updater`.
  Scope is the domain (`scan`, `cardtrader`, `telegram`, `api`, `db`, `desktop`, `tauri`).
