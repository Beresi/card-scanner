# Dashboard Views & Overlays
> The desktop frontend surface (React + Vite + TS webview inside the Tauri v2 app — see the
> [Tauri pivot](../.bootstrap-discovery.md)). Greenfield: paths below are **planned**.
> Design source: [README handoff](../../README.md); product spec: [PRD §10](../../cardtrader-deal-scanner-PRD.md),
> inheritance [§9a](../../cardtrader-deal-scanner-PRD.md). Conventions: [coding-standards](../standards/coding-standards.md).

## Purpose
The dashboard is the entire desktop UX — a single-user, cyberpunk "ops console" served as
a static SPA in the Tauri webview, talking only to the cloud Worker `/api/*` routes
([architecture](architecture.md)). It is composed of **four primary views** — Deal Feed,
Watchlist, Settings, Health — plus five supporting surfaces: a first-load **boot sequence**,
a **⌘K command palette**, a **live-scan overlay**, a right-hand **telemetry rail**, and a set
of opt-in **effects**. This doc is the map of that surface: what each view is, where it lives,
and which route it maps to. For pixel/copy detail, link out to the README; for behavior rules,
to the PRD.

The README prototype (`design_handoff_deal_scanner_dashboard/*.jsx`) is **design reference
only** — Babel-in-HTML + `window.*` globals + mock `data.js`. **Do not port it.** Rebuild every
piece as real React components on the project stack, wired to the API.

## Planned layout
| Planned path | Holds |
|---|---|
| `src/views/deal-feed/` | Deal Feed view, command bar, deal-card grid + card |
| `src/views/watchlist/` | Watchlist table, inspector editor, add-flow modal, inherit/override |
| `src/views/settings/` | Settings panels (the single `config` row) |
| `src/views/health/` | Health view (status banner, stat tiles, scan-run log) |
| `src/shell/aside/` | Right-rail telemetry + watch summary/inspector host |
| `src/overlays/scan/` | Live-scan overlay (radar + step log) |
| `src/overlays/palette/` | ⌘K command palette |
| `src/boot/` | Boot sequence (terminal init + CRT glitch) |
| `src/effects/` | Decrypt reveal, toasts, radar blips, hot clock, hover (feature-flagged) |
| `src/components/` | Shared primitives (below) |

The shell is a viewport-pinned 3-column grid (`224px · minmax(0,1fr) · 340px`); the right rail
collapses below 1180px. See README "Global layout" for the exact grid.

## Shared primitives (`src/components/`)
Rebuilt from the prototype's `components.jsx` as real, typed components — **not** ported.

| Primitive | Role |
|---|---|
| `Panel` | Chamfered surface container with eyebrow header + optional corner brackets |
| `Btn` | Button (primary / ghost / danger variants) |
| `Status` | Status dot + label (online/valid/linked/error) |
| `Tag` | Small pill (priority `--hot`, sent accent, neutral meta) |
| `Segmented` | Segmented toggle (e.g. Open/All, Any/Priority, foil pref) |
| `Switch` | On/off toggle |
| `InheritField` | The §9a control — shows `inherit · {default}` or an `override ✕` reset chip |
| `PriceBar` | Green fill = price as % of baseline, with a baseline tick |
| `Clock` | **Leaf** countdown to next scan — isolated so its 1s tick doesn't re-render the tree |
| `Icon` | Inline 1.6px-stroke `currentColor` SVG set (feed, radar, watch, gear, eye, x, …) |
| helpers | `flag(countryCode)`, `ago(ts)`, `formatCents(cents, currency)` |

`formatCents` is the **only** place money becomes a string — everything else is integer cents
([coding-standards "Money"](../standards/coding-standards.md), PRD §6).

---

## Deal Feed (home)
`src/views/deal-feed/` · the reverse-chronological wall of live deals. **Filters must actually
filter the live list** ([coding-standards](../standards/coding-standards.md)), not just toggle CSS.

- **Command bar:** segmented `Open/All` (status) + `Any/Priority`, a watch-item `<select>`, and a
  **min-discount** range slider. Each control feeds the `GET /api/deals` query.
- **Readout strip:** `N shown · N open · N unseen · potential savings $X` (savings summed in cents,
  formatted at the edge).
- **Deal-card grid:** responsive `repeat(auto-fill, minmax(372px, 1fr))`, gap `--row`.
- **Deal-card anatomy** (top→bottom): name + set · right-aligned **−NN%** (green, glow) over an
  "under med" eyebrow · price block `$price · vs $baseline (strikethrough) · save $X` + `PriceBar` ·
  meta tags (condition, FOIL/NONFOIL, EN, q{qty}, optional **CT0 ✓** accent tag) · footer (top
  border): seller `🏴 username` + tag cluster (PRIORITY hot, SENT, age) on the left, **Buy** /
  mark-seen (eye) / dismiss (×) on the right.
- **High-priority hot rail:** 2px `--hot` left bar + hot-tinted border. **Seen cards** dim to ~0.66.
- **Empty state:** centered radar icon + "No deals match these filters."

| Action | Route |
|---|---|
| Load feed (filters) | `GET /api/deals?status=&min_discount=&watchlist_id=&priority=` |
| Mark seen / dismiss | `PATCH /api/deals/:id` `{ seen?, dismissed? }` |
| Buy | Opens `buy_url` in the **system browser** (Tauri opener) — not in-webview |

---

## Watchlist
`src/views/watchlist/` · the list manager, built to stay legible at **40+ items**.

- **Command bar:** search input · segmented filter (All / Active / High / TG) · sort
  (Recent / Name / Hits / Importance) · **Add**.
- **Dense table:** columns `[type icon] · CARD/SET · COND · FOIL · THRESH · IMP · TG · HITS ·
  ON(toggle)`. 46px rows, hairline dividers, hover tint; selected row = soft accent fill + 2px left
  bar; inactive rows dim. The body scrolls under a sticky-ish header.
- **Inspector (right rail, `src/shell/aside/`):** clicking a row opens its single-column editor —
  Threshold (slider), Min condition (select), Foil pref (segmented), Importance (Normal /
  High·bypass), a **Telegram routing block** (enable switch, min-discount slider, max-price input)
  with a **live plain-English explanation** of the routing outcome, and **Remove from watchlist**.
- **Inherit / override — PRD §9a (critical):** every per-ticket field that can fall back to a global
  default renders an `InheritField`. When the column is NULL it shows `inherit · {default}` (mono,
  dim, idle dot) and follows the moving default; when set it shows an `override ✕` chip that
  **resets the field to NULL** (back to inherit) on click. New items are **born inheriting** — the
  add form pre-fills from `config.new_ticket_*` but leaves override columns NULL (references, not
  copies). Do not resolve inheritance in the UI; the UI only displays inherit-vs-override state.
- **Summary panel** (right rail, when nothing selected): item / active / high / TG counts, a
  cards-vs-sets composition bar, lifetime hits, and an Add button.
- **Add flow (modal):** segmented "Watch a card" / "Watch a whole set". Set = search cached
  expansions → pick. Card = pick set → search cached blueprints → pick. Also accepts a pasted
  CardTrader card URL to parse the id (best-effort).

| Action | Route |
|---|---|
| Load / create | `GET /api/watchlist` · `POST /api/watchlist` |
| Edit / delete | `PATCH /api/watchlist/:id` · `DELETE /api/watchlist/:id` |
| Reset field to inherit | `PATCH /api/watchlist/:id/reset` |
| Add-flow search | `GET /api/resolve/expansions?q=` · `GET /api/resolve/blueprints?expansion_id=&q=` |

---

## Settings
`src/views/settings/` · reads and writes the **single `config` row** (PRD §10) — one surface, not
several. Stacked eyebrow-headed panels:

- **Appearance:** Theme (Dark/Light/System) · Accent swatches · List density (Comfortable/Compact).
  All apply **live** by swapping CSS variables on `:root`/`body`, then persist to `config`.
- **New-ticket defaults** ("moving baseline · §9a"): default threshold, min condition, cohort size,
  min comparators, new-item foil pref, new-item importance. **Note retroactively:** changing a
  default moves every still-inheriting ticket (PRD §9a) — surface that warning in the UI.
- **Notifications:** Telegram status (LINKED dot, from cached `/getMe`) + **Send test** (shows
  "Sent ✓") · global TG min-discount slider · quiet hours (start→end + timezone + digest toggle).
- **Scan & data:** schedule (read-only cron `["0 * * * *"]`) · account currency · CardTrader token
  status (VALID · read·write) · deal retention (N days, 0 = forever).
- **Maintenance:** replay boot sequence · **clear all deals** (danger).

| Action | Route |
|---|---|
| Load / save settings | `GET /api/config` · `PATCH /api/config` |
| Send test message | `POST /api/telegram/test` |
| Clear old deals | `DELETE /api/deals?older_than_days=` |

---

## Health
`src/views/health/` · observability over `scan_runs` (PRD §11).

- **Status banner** (glowing, bracketed): "SCANNER ONLINE" + next-scan `Clock`.
- **Stat tiles** (3-col): uplink 200 OK · token VALID · telegram LINKED · deals found · TG pushed ·
  errors-in-window (amber if any).
- **Scan-run log table:** `RUN # · STARTED (+relative) · DUR · ITEMS · BLUEPRINTS · API calls ·
  DEALS · TG · STATUS (OK/WARN)`. A WARN row **expands** a non-fatal detail line (e.g. an HTTP-429
  backoff message).

| Action | Route |
|---|---|
| Load health | `GET /api/health` (latest `scan_runs` + token ok) |

---

## Right-rail telemetry
`src/shell/aside/` · shown on Feed / Settings / Health (the Watchlist replaces it with its
inspector/summary). Mini scan-radar (rings + rotating sweep, faster while scanning) + next-scan
`Clock` + **Scan now**; session stats (open deals / unseen / potential savings / scans); a
**discount-spread** distribution (buckets 40–49 / 50–59 / 60–69 / 70+); and an **activity log** of
recent deals (priority dot · name · −% · age).

## Live-scan overlay
`src/overlays/scan/` · triggered by **Scan now** or the palette. Modal: a large animated **radar**
(rings, cross, conic sweep, contact pings as deals are found, center count) beside a streaming
**step log mirroring PRD §11** (open scan_runs → GET /info → load watchlist → marketplace/products →
filter+sort → median baseline → threshold/upsert → telegram routing → close) + progress bar.
~3.6s, then returns to the feed and surfaces the new deals.

| Action | Route |
|---|---|
| Scan now | `POST /api/scan/run-now` (same code path as the cron) |

## Command palette (⌘K / Ctrl+K)
`src/overlays/palette/` · search input + grouped, fuzzy-filtered commands: **Navigate** (4 views),
**Actions** (run scan, add to watchlist, replay boot, toggle scanlines), **Jump to watch item**
(every watchlist row). Full keyboard control (↑/↓, ↵ to run, Esc to close); hover sets the active
row. A ⌘K chip in the top strip opens it.

## Boot sequence
`src/boot/` · first-load full-screen terminal init: streams ~11 mono status lines, clears, shows
the `◈ CARD//BROKER` lockup, then exits with a **CRT glitch-collapse** into the app. ~5s. Gated by
`localStorage` (`cardbroker_booted`), **skippable** by click, **replayable** from Settings →
Maintenance and the palette.

## Effects
`src/effects/` · **opt-in, feature-flagged, transform/opacity-only, event-driven** (mount / hover /
scan) — never always-on render loops ([coding-standards](../standards/coding-standards.md)):
**decrypt reveal** (new deal names scramble→resolve, staggered), **incoming toasts** (priority hits
slide in top-right, auto-dismiss ~4.6s), **radar blips** (ambient CSS dots), **hot clock**
(countdown turns `--hot` and pulses in the final 60s), **card hover** (border lights to accent).

---

## State management
- **Server data** (deals, watchlist, config, scan_runs, expansion/blueprint caches) comes from the
  API via **TanStack Query**, cached and **invalidated per mutation** (e.g. dismissing a deal
  invalidates the deals query; resetting a field invalidates that watchlist item). See
  [coding-standards "React / frontend"](../standards/coding-standards.md).
- **Ephemeral UI** lives in component state only: current `view`, selected watch-item id,
  modal/palette open, toasts, the scan-running flag, and the scan-target timestamp the `Clock`
  counts down to. Inheritance state is *displayed* (inherit vs override) — never *resolved* in the
  UI (the backend resolves at scan time, PRD §9a).

## Gotchas
- **Filters must actually filter** — the Deal Feed command bar drives the `GET /api/deals` query;
  don't fake filtering with CSS visibility.
- **Integer cents at the edge** — only `formatCents` produces strings; never store/compute floats
  for `price`, `baseline`, or `savings` (PRD §6).
- **Isolate the ticking `Clock`** — a once-per-second tick in the root re-renders the whole tree
  and freezes entrance animations at `opacity:0`. Keep the countdown in its own leaf component
  (README perf note, [coding-standards](../standards/coding-standards.md)).
- **`min-height:0` grid scroll trap** — keep `min-height:0` on the center column and on its inner
  `overflow-y:auto` area, or the grid row grows to content height and the page won't scroll (README).
- **Effects must be event-driven**, not always-on, and behind their feature flags.
- **Buy opens the system browser** via the Tauri opener/shell plugin — not an in-webview navigation
  (this is a Tauri app, not a browser tab; PRD non-goal: no in-app purchase).
