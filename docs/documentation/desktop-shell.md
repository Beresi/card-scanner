# Tauri Host + Desktop Shell
> Greenfield — describes intent. Planned files; no code yet. Lives in the `/desktop` unit
> (see [discovery report](../.bootstrap-discovery.md)). Reflects the **Tauri pivot**: the
> dashboard ships as a Tauri v2 desktop app, **not** a browser SPA served by the Worker.
> Specs: [PRD §5/§9/§12](../../cardtrader-deal-scanner-PRD.md), [README "Global layout"](../../README.md).

## Purpose
The desktop container and the app shell that hosts the four views (Deal Feed, Watchlist,
Settings, Health). Two layers in one build target:

- **Rust host** (Tauri v2) — owns the native window, opens Buy links in the system browser,
  and stores/serves the cloud auth token from OS-backed secure storage. It is deliberately
  **thin**: no scan logic, no deal logic, no DB. That all stays in the cloud Worker
  ([architecture](architecture.md)). Reimplementing the scan locally is the **rejected
  "full-local" architecture** — do not do it.
- **React frontend shell** — a full-viewport 3-column grid + SPA router that frames the four
  views and talks to the cloud `/api/*` over HTTPS, presenting the stored auth token.

The chosen architecture is **Tauri client + cloud backend**. The Worker stays always-on and
scans hourly regardless of whether the desktop app is running; it becomes **API-only** (no
static-asset hosting of the dashboard).

## Planned files
| Path | Role |
|---|---|
| `src-tauri/main.rs` *(planned)* | Host entrypoint: build the window, register commands + plugins, wire the updater. |
| `src-tauri/commands.rs` *(planned)* | The `#[tauri::command]` handlers (table below). Each returns `Result<_, String>`. |
| `src-tauri/tauri.conf.json` *(planned)* | Window config, bundle/installer config, updater endpoint + signing pubkey, plugin allowlist. |
| `src-tauri/Cargo.toml` *(planned)* | Rust crate + Tauri plugin deps (`opener`/`shell`, `store` or `stronghold`, `updater`). |
| `src/App.tsx` *(planned)* | Frontend root: theme/router providers, the 3-column shell, palette + overlay mounts. |
| `src/shell/*` *(planned)* | Shell regions — left rail, center top strip + scroll stage, right rail, the isolated `Clock` leaf. |

Repo splits into `/worker` (backend) and `/desktop` (this system). View paths like
`src/views/...` are relative to the desktop frontend. See the discovery report's
[repo-structure](../.bootstrap-discovery.md) section.

## Rust host responsibilities
The host does the few things a webview can't, and nothing more (coding-standards: keep the
host thin).

| Responsibility | Where | Notes |
|---|---|---|
| Window config | `tauri.conf.json` | Title, min size, decorations; single main window. |
| `open_buy_url(url)` | `commands.rs` + `opener`/`shell` plugin | Opens a CardTrader Buy link in the **system browser**, not in-webview (PRD non-goal: no in-app purchase). |
| `get_api_token()` / `set_api_token(token)` | `commands.rs` + `store`/`stronghold` | Read/write the cloud auth token (Cloudflare Access **service token** / shared bearer) in OS-backed secure storage (PRD §12). |
| Auto-updater wiring | `main.rs` + `updater` plugin | Checks the update manifest; channel is **separate** from Worker deploys ([shared-standards](../standards/shared-standards.md)). |
| Local font bundling | `tauri.conf.json` resources | Chakra Petch + IBM Plex Mono ship in the app; no Google Fonts fetch at runtime. |

It does **not**: run the scan, call CardTrader, touch D1, or hold deal/watchlist state —
that is the cloud backend's job (architecture decision in the discovery report).

## Frontend shell layout
A full-viewport 3-column CSS grid, pinned to viewport height so each region scrolls
independently (README "Global layout"):

```css
grid-template-columns: 224px  minmax(0, 1fr)  340px;
grid-template-rows: minmax(0, 1fr);
height: 100vh; overflow: hidden;
```

| Region | Width | Contents |
|---|---|---|
| Left rail | 224px | Brand lockup `◈ CARD//BROKER`; nav (Deal Feed / Watchlist / Settings / Health) with an **unseen-count badge** on Deal Feed; bottom system block — scanner status dot + next-scan clock + currency. Active item = cyan text + soft fill + 2px left bar. |
| Center stage | fluid (`minmax(0,1fr)`) | Thin **top strip** (view title + eyebrow subtitle, **⌘K chip**, next-scan clock, **API 200** status) over a scrolling content area (max-width **1480px**, centered, padding 24×30px). Primary focus region. |
| Right rail | 340px | Contextual telemetry/inspector (telemetry on Feed/Settings/Health; the Watchlist inspector or summary on Watchlist). **Collapses (`display:none`) below 1180px** viewport width. |

Navigation is an **SPA router** — instant view switch via the left rail or ⌘K, **no page
reloads**. The countdown clock is isolated into its own leaf component (see Gotchas).

## Theme / density / accent
Theme (Dark/Light/System, dark-first), accent color, and list density are applied **live by
swapping CSS custom properties on `:root`/`body`** — no reload, no re-fetch. The selection
is persisted in the single `config` row (PRD §9) via `PATCH /api/config`, so it round-trips
across launches. The full token set (colors, type, chamfer clip-paths, glow multiplier,
density vars) is the design system — see [README Design Tokens](../../README.md). Curated
accents: `#22d3ee, #37e0c8, #5b8cff, #f0387a, #f5b945, #45e0a0`.

## Data flow
The frontend is the only side that talks to the cloud `/api/*`, over **HTTPS via TanStack
Query** (cached + invalidated per mutation; ephemeral UI bits stay in component state). Each
request presents the stored auth token. The token's lifecycle:

```
Rust host secure storage  ──get_api_token()──▶  frontend  ──Authorization header──▶  cloud /api
```

The host supplies the token from secure storage; the frontend never persists it itself and
never embeds it in the bundle. The API contract (PRD §10, `snake_case` wire, integer cents)
is the shared boundary with the backend ([shared-standards](../standards/shared-standards.md)).

## Public interface
### Tauri commands (host IPC)
```rust
#[tauri::command] fn open_buy_url(url: String) -> Result<(), String>;
#[tauri::command] fn get_api_token() -> Result<Option<String>, String>;
#[tauri::command] fn set_api_token(token: String) -> Result<(), String>;
```
Commands return `Result<_, String>` (or a typed error) — never `unwrap()` on fallible I/O
(coding-standards: Rust/Tauri host).

### Shell regions
`LeftRail` · `CenterStage` (top strip + scroll area) · `RightRail` — plus the leaf `Clock`,
the ⌘K command palette overlay, and the live-scan overlay mount.

### Router routes (the four views)
| Path | View | Right-rail content |
|---|---|---|
| `/` (or `/feed`) | Deal Feed | Telemetry |
| `/watchlist` | Watchlist | Inspector / summary |
| `/settings` | Settings | Telemetry |
| `/health` | Health | Telemetry |

(Exact path strings TBD at scaffold; the router library — TanStack Router vs React Router —
is also TBD per the discovery report Stack table.)

## Dependencies
- **Cloud backend** — the Worker `/api/*` routes (PRD §10); the desktop app is useless
  without it. Versions independently ([shared-standards](../standards/shared-standards.md)).
- **Auth secret** — Cloudflare Access service token / shared bearer, stored on-device.
- **Tauri v2 plugins** — `opener`/`shell` (Buy links), `store` or `stronghold` (secret),
  `updater` (auto-update).
- **Updater endpoint** — update manifest host (Worker route, GitHub Releases, or static).
- **Design tokens** — [README](../../README.md); fonts bundled locally.

## Build / run
| Command | Does |
|---|---|
| `npm run tauri dev` | Run the desktop app against the Vite dev server (hot reload). |
| `npm run tauri build` | Compile the host + frontend into per-OS bundles/installers. |
| `cargo fmt` / `cargo clippy` | Format + lint the Rust host; clean before commit. |

Needs the **Rust toolchain** (`rustup`) alongside Node/npm. Fonts are bundled locally (no
runtime Google Fonts fetch). The desktop **auto-update channel is separate** from Worker
deploys — a contract-breaking backend change requires a coordinated desktop release.

## Gotchas
- **Grid scroll trap** — set `min-height: 0` on the center column **and** `min-height: 0` +
  `overflow-y: auto` on its inner scroll area, or the grid row grows to content height and
  the page won't scroll (README; bit the prototype).
- **Once-per-second re-render** — isolate the countdown `Clock` into its own **leaf**
  component. A ticking timer in the root re-renders the whole tree each second and sticks
  entrance animations at `opacity:0` (README perf note). Keep timers local.
- **Never store the auth token in plaintext** — not in committed config, not in the JS
  bundle. OS-backed secure storage only, served via `get_api_token` (PRD §12,
  [shared-standards](../standards/shared-standards.md)).
- **Right rail below 1180px** — it is `display:none`, not merely narrowed; views must not
  depend on it being visible at small widths.
- **Buy opens externally** — route Buy links through `open_buy_url` (system browser), never
  an in-webview navigation; there is no in-app purchase (PRD §12 non-goal).
- **Host stays thin** — resist adding scan/deal/DB logic to Rust; that is the rejected
  full-local architecture (discovery report architecture decision).
