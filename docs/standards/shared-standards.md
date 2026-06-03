# Shared Standards
> Cross-cutting conventions that span the cloud backend and the desktop client. Read
> alongside [naming-conventions](naming-conventions.md) and [coding-standards](coding-standards.md).

This is a multi-target project: a **Cloudflare Worker backend** and a **Tauri desktop
client** that share a contract but build and deploy independently.

## The API contract is the boundary
The PRD §10 route list is the shared contract between backend and desktop client. Both
sides depend on it; neither owns the other.
- Keep request/response field names **`snake_case`** to mirror the DB and the CardTrader
  API (PRD §6/§9). The desktop client maps to `camelCase` internally if it wants, but the
  wire format is fixed.
- When a route's shape changes, update both sides and the route's system doc in the same
  change. Treat the shared DTO types as the source of truth — define them once (ideally a
  shared `types` module or duplicated-but-identical) and keep them in lockstep.
- All money crossing the boundary is **integer cents + currency code** (never floats).

## Inheritance / override is a shared concept (PRD §9a)
The "ticket value if not NULL else config default" rule lives on **both** sides:
- Backend resolves effective values at **scan time** (`resolveEffective`).
- Desktop UI renders the **inherit vs override** state per field and offers a one-tap reset
  that PATCHes `/api/watchlist/:id/reset` to null the column.
Keep the resolution rule defined once conceptually; if both sides need it, they must agree
exactly. New tickets are born inheriting (override columns NULL) — do not copy defaults in.

## Secrets handling (cross-cutting, PRD §12)
- **Backend secrets** (`CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`):
  Wrangler secrets only — never in source, D1, logs, the client bundle, or git.
- **Desktop secret** (the Cloudflare Access service token / shared bearer used to reach the
  API): OS-backed secure storage on-device — never in committed config or the JS bundle.
- The CardTrader token has **read + write/purchase** scope → treat as high-sensitivity;
  rotate if ever exposed. The app calls cart add/view/remove (owner decision 2026-06-01)
  but NEVER calls `/cart/purchase` or any checkout endpoint.
- `.env*` and any local secret files are git-ignored.

## Time, timezones, scheduling
- The scan cron is hourly UTC (`["0 * * * *"]`). Store timestamps as `datetime('now')` (UTC)
  in D1; format to the user's `config.timezone` (default `Asia/Jerusalem`) at the display
  edge. Quiet-hours comparisons use local hours per `config` (PRD §8/§9).

## Versioning & releases
- Backend (Worker) and desktop app version independently. The desktop app's auto-update
  channel is separate from Worker deploys.
- A backend API change that breaks the contract requires a coordinated desktop release;
  prefer additive, backward-compatible changes.

## Definition of done (any change)
- Type-checks clean (`tsc --noEmit`; `cargo clippy` for Rust).
- Touched pure logic has tests (deal engine / routing especially — PRD §16).
- No secret in source, logs, or bundle.
- Money stayed in integer cents end-to-end.
- Affected system doc updated.
