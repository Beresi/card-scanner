# Coding Standards
> Greenfield baseline for the TypeScript backend, the React/Vite desktop frontend, and the
> Rust Tauri host. Refine as real code accumulates.

## Money — the cardinal rule
All money is **integer cents** in the account's native currency (PRD §6). Never store,
compute, or pass floats for money. Carry the currency code alongside the cents. Convert to
a display string **only at the UI edge** (`formatCents(cents, currency)`); the engine,
API, and DB only ever see integers. No currency conversion anywhere (v1 non-goal).

## Error handling
- **External-API calls are expected to fail.** A single failed blueprint fetch is logged
  and **skipped — never fatal to a scan run** (PRD §13). Catch at the per-item boundary.
- **Whole-run failures** are recorded in `scan_runs.error`; the run closes cleanly.
- **Token 401** (`GET /info`) aborts the run and alerts **once** — don't spam on repeats.
- **Rate limits:** throttle `marketplace/products` to ~1 req/s; exponential backoff on
  HTTP 429 or `"Too many requests"` bodies (PRD §6, §13).
- Throw typed errors with context (which blueprint, which endpoint), not bare strings.
- Frontend: surface API failures as inline UI state (the "API 200" strip flips to an
  error), never a silent empty list. Use TanStack Query error/loading states.
- Rust host: return `Result<T, String>` (or a typed error) from commands; never `unwrap()`
  on fallible I/O in a command handler.

## Logging
- Backend: structured, leveled (`info`/`warn`/`error`). Log scan milestones (mirroring the
  §11 step list the UI streams) and every backoff/retry. **Never log secrets** — not the
  CardTrader token, Telegram token, or chat id (PRD §12).
- One `scan_runs` row per run is the durable log; transient `console` logs are for debug.

## TypeScript
- `strict: true`. No `any` — use `unknown` + narrowing at boundaries (parse the CardTrader
  response into typed shapes; don't trust the wire).
- Prefer `type` aliases and discriminated unions over enums for domain unions
  (`type FoilPref = 'any' | 'foil' | 'nonfoil'`).
- Pure domain logic (deal engine, condition ranking, routing decision) is **side-effect
  free and unit-testable** — no `fetch`, no DB, no `Date.now()` passed in rather than read.
- Validate config/inheritance resolution in one place (`resolveEffective(ticket, config)`),
  not scattered across call sites (PRD §9a).

## Import ordering
1. Node/Workers/std builtins, 2. external deps, 3. internal absolute (`@/…` or domain dirs),
4. relative (`./…`). Blank line between groups. Let the formatter enforce; don't hand-sort
against it.

## File size & shape
- Soft cap ~300 lines per module; split by responsibility when exceeded (the §14 layout
  already splits `dealEngine` / `conditions` / `scanner` — keep that separation).
- One React component per file (plus tiny local subcomponents). Extract a hook when a
  component holds more than ~2 pieces of server state.
- Keep timers/animation state in **leaf components** — a once-per-second tick in the root
  re-renders the whole tree and breaks entrance animations (README perf note). Isolate the
  countdown `Clock` into its own component.

## React / frontend
- Server data (deals, watchlist, config, scan_runs, caches) comes from the API via
  **TanStack Query**, cached and invalidated per mutation. Only ephemeral UI bits (open
  modals, palette state, selected row, toasts) live in component state.
- Filters must **actually filter** the live list (README). Don't fake it.
- Effects (decrypt reveal, toasts, radar blips, hot clock, boot glitch) are **feature-
  flagged, transform/opacity-only, and event-driven** — never always-on render loops.
- Buy links open in the **system browser** via the Tauri opener/shell plugin, not an
  in-webview navigation.

## Rust / Tauri host
- Keep the host thin: window setup, a few `#[tauri::command]`s (open URL, get/set token),
  secure storage, updater. Business logic stays in the cloud backend — don't reimplement
  the scan in Rust (that's the rejected "full local" architecture).
- Secrets (API base URL is fine in config; the auth token) live in OS-backed secure
  storage (stronghold/store), never in plaintext config committed to the repo.
- `cargo fmt` + `cargo clippy` clean before commit.

## Testing conventions
See PRD §16 — fixture-driven. Co-locate tests as `*.test.ts` beside the unit, or under a
`__tests__/`/`test/` dir per the chosen layout. The deal engine and Telegram routing are
the highest-value targets (pure functions, exact acceptance criteria). Each §16 case
becomes at least one named test. Aim for full branch coverage on the engine and routing;
the UI gets lighter component tests for the inherit/override and filter logic.
