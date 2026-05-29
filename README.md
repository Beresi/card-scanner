# Handoff: CardTrader Deal Scanner — Dashboard UI ("Card // Broker")

## Overview
This package contains the high-fidelity **dashboard (web UI)** design for the CardTrader
Deal Scanner described in `cardtrader-deal-scanner-PRD.md` (included). The PRD is the full
product + backend build spec; **this handoff covers the front-end surface only** — PRD §10
(Dashboard) and the appearance settings in §9/§10.

The design is a single-user, cyberpunk-styled "ops console" with four primary views — **Deal
Feed, Watchlist, Settings, Health** — plus a boot sequence, a live-scan overlay, a right-hand
telemetry rail, a ⌘K command palette, and a few opt-in effects.

## About the design files
The files in this bundle are **design references built in HTML/CSS + in-browser React (Babel)**.
They are prototypes that show the intended look, layout, copy, and behavior — **not production
code to ship as-is.** The task is to **recreate these designs in the project's real stack.**

Per the PRD (§5), the real stack is **React + Vite (TypeScript), served as static assets by a
Cloudflare Worker, talking to a Hono JSON API backed by D1.** Recreate the UI as proper React
components there, wired to the real API routes (PRD §10). Do **not** copy the Babel-in-HTML
setup, the `window.*` global-export pattern, or the mock `data.js` — those are prototype
scaffolding. Use the project's component conventions, a real router, and real data fetching
(e.g. TanStack Query) instead.

## Fidelity
**High-fidelity.** Colors, typography, spacing, layout, states, and interactions are final and
should be reproduced precisely. The exact tokens are in the **Design Tokens** section below.

---

## Design Tokens

All tokens live in `styles.css` as CSS custom properties. Port them to your theme system
(CSS vars, Tailwind config, styled-system, etc.). Theme is **dark-first**.

### Colors
| Token | Hex / value | Use |
|---|---|---|
| `--bg` | `#05070b` | app background (cold near-black) |
| `--rail` | `#070a10` | left nav + right rail background (recessed) |
| `--panel` | `#0a0f17` | base panel |
| `--panel-2` | `#0e141f` | raised panel (gradient top) |
| `--panel-3` | `#121a28` | buttons / inputs surface |
| `--line` | `rgba(120,180,215,0.10)` | hairline borders |
| `--line-strong` | `rgba(120,200,230,0.22)` | stronger borders |
| `--text` | `#eaf2fb` | primary text |
| `--text-dim` | `#a3b5c8` | secondary text |
| `--text-faint` | `#6c7e92` | tertiary / metadata |
| `--accent` | `#22d3ee` (cyan) | primary accent (user-themeable) |
| `--accent-ink` | `#042027` | text on accent fills |
| `--hot` | `#f0387a` (magenta) | high priority / alerts / urgency |
| `--good` | `#45e0a0` (green) | positive deltas / discounts / "deal good" |
| `--warn` | `#f5b945` (amber) | warnings |

Accent is user-selectable; the curated set is:
`#22d3ee, #37e0c8, #5b8cff, #f0387a, #f5b945, #45e0a0`.
Derived helpers use CSS `color-mix(in oklab, var(--accent) N%, transparent)` for soft fills,
glows, and borders (e.g. `--accent-soft` = 16%, `--accent-glow` = 55%).

### Typography
- **Display / UI / body:** `'Chakra Petch'`, weights 400/500/600/700 (base body weight **500**).
- **Data / numbers / technical readouts:** `'IBM Plex Mono'`, weights 400/500/600, with
  `font-variant-numeric: tabular-nums`.
- Both loaded from Google Fonts.
- **Micro-labels ("eyebrows"):** IBM Plex Mono, ~10.5px, `letter-spacing: 0.2em`,
  `text-transform: uppercase`, color `--text-dim`.
- Representative sizes: page title (`h1`) 22px/600; deal name 16px/600; deal price 19px/700;
  discount % 23px/700; table row label 13.5px/600; body 13–14px.
- **Minimum readable size ~10px** (mono micro-labels only); never smaller.

### Spacing / density
Two density modes (user-switchable), driven by vars:
- Comfortable: `--pad: 18px`, `--row: 14px`
- Compact: `--pad: 12px`, `--row: 9px`
General gaps: 6–16px. Section padding: 14–24px.

### Shape, borders, glow
- **Radius:** essentially **square** (`--radius: 2px`). The signature shape is a **chamfer**
  (cut corner), not a round one.
- **Chamfer (cyberpunk corner):** `clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px,
  100% 100%, 12px 100%, 0 calc(100% - 12px))` — small variant uses 7px. Used on cards, buttons,
  modals, swatches.
- **Borders:** 1px hairlines using `--line` / `--line-strong`; active elements use an
  accent-tinted border `color-mix(in oklab, var(--accent) 40%, transparent)`.
- **Glow:** accent box-shadows / text-shadows, scaled by a `--glow` multiplier (0–1.6, default 1)
  so it can be dialed down. Example: `box-shadow: 0 0 calc(18px * var(--glow)) var(--accent-glow)`.
- **Corner brackets** (`.bracket`): small L-shaped accent marks on the top-left & bottom-right of
  focused panels (radar box, modals).

### Backdrop
- Subtle 44px grid (`--bg-grid: rgba(80,150,190,0.045)`), radially masked toward center,
  plus a vignette. Optional CRT scanline overlay (off by default).

---

## Global layout (the "shell")

A full-viewport 3-column CSS grid, **pinned to the viewport height** so each region scrolls
independently:

```
grid-template-columns: 224px  minmax(0, 1fr)  340px;
grid-template-rows: minmax(0, 1fr);
height: 100vh; overflow: hidden;
```

- **Left rail (224px):** dim/recessed. Brand lockup (`◈ CARD//BROKER`), nav (Deal Feed,
  Watchlist, Settings, Health) with an unseen-count badge on Deal Feed, and a bottom system
  block (scanner status dot, next-scan clock, currency). Active item = cyan text + soft fill +
  2px left bar.
- **Center stage (fluid):** a thin top strip (view title + subtitle eyebrow, ⌘K chip, next-scan
  clock, "API 200" status) over a scrolling content area. Content max-width 1480px, centered,
  padding 24×30px. **This is the primary focus region** — higher contrast than the periphery.
- **Right rail (340px):** contextual. Telemetry on Feed/Settings/Health; the Watchlist inspector
  or summary on Watchlist. Collapses (`display:none`) below 1180px viewport width.

> Implementation note: keep `min-height: 0` on the center column and `min-height: 0` +
> `overflow-y:auto` on its inner scroll area, or the grid row will grow to content height and
> the page won't scroll (this bit us during the prototype).

---

## Screens / Views

### 0. Boot sequence (first load only)
- Full-screen terminal init: streams ~11 mono status lines ("> establishing uplink … OK",
  "> cardtrader api · GET /info … 200", etc.) with a blinking cursor, then **clears**, shows
  the `◈ CARD//BROKER` logo alone, then exits with a **CRT glitch-collapse** (horizontal shake →
  squeeze to a bright line → fade) into the app.
- Gated by `localStorage` (`cardbroker_booted`), **skippable** by click. Replayable from Settings
  → Maintenance and from Tweaks.
- Total ~5s; lines stagger 220–420ms each.

### 1. Deal Feed (home)
- **Command bar:** segmented filters **Open/All** and **Any/Priority**, a "watch item" select,
  and a **min-discount** range slider. (Filters must actually filter.)
- **Readout strip:** counts — `N shown · N open · N unseen · potential savings $X`.
- **Deal grid:** responsive `repeat(auto-fill, minmax(372px, 1fr))`, gap = `--row`. Each **deal
  card** (chamfered) shows, top→bottom:
  - Card name (Chakra Petch 16/600) + set (mono 11px, ellipsis); right-aligned **−NN%** discount
    (green, 23px/700, glow) over an "under med" eyebrow.
  - Price block: `$price` (19/700) · strikethrough `vs $baseline` (faint) · right-aligned green
    `save $X`; below it a **price bar** (green fill = price as % of baseline, with a baseline
    tick).
  - Meta tag row: condition (NM/SP/… — green tag if NM/Mint), FOIL/NONFOIL, EN, q{qty}, optional
    **CT0 ✓** (accent tag) for CardTrader-Zero eligibility.
  - Footer (top border): seller `🏴 username` + a tag cluster (PRIORITY hot tag if high, SENT
    accent tag if pushed to Telegram, age) on the left; **Buy** (primary, opens CardTrader in new
    tab), **mark-seen** (eye), **dismiss** (×) on the right.
  - High-priority cards get a 2px **hot left rail** + hot-tinted border. Seen cards dim to ~0.66.
- **Empty state:** centered radar icon + "No deals match these filters."

### 2. Watchlist (scales to 40+ items)
- **Command bar:** search input, segmented filter (All / Active / High / TG), sort select
  (Recent / Name / Hits / Importance), **Add** button.
- **Dense table** (the list — handles 40+ without fatigue), columns:
  `[type icon] · CARD/SET · COND · FOIL · THRESH · IMP · TG · HITS · ON(toggle)`.
  Row height 46px, hairline dividers, hover tint. Selected row = soft accent fill + 2px left bar.
  Inactive rows dim. The table body scrolls; the header is sticky-ish above it.
- **Inspector (right rail):** clicking a row opens its editor in the right rail (single-column,
  so it fits 340px) — **Threshold** (slider), **Min condition** (select), **Foil pref**
  (segmented), **Importance** (segmented: Normal / High·bypass), and a **Telegram routing** block
  (enable switch, min-discount slider, max-price input) with a live plain-English explanation of
  the routing outcome, plus a **Remove from watchlist** button.
- **Inherit / override (critical — PRD §9a):** every per-ticket field that can fall back to a
  global default shows either `inherit · {default}` (mono, dim, with a small idle dot) **or**, when
  the user has set an explicit value, an `override ✕` chip that **resets the field to null
  (back to inherit)** on click. New items are born inheriting (override columns null).
- **Summary (right rail, when nothing selected):** item/active/high/TG counts, a cards-vs-sets
  composition bar, lifetime hits, and an Add button.
- **Add flow (modal):** segmented "Watch a card" / "Watch a whole set". Set = search cached
  expansions → pick. Card = pick set → search cached blueprints → pick. (Also: accept pasting a
  CardTrader card URL to parse the id — best effort.)

### 3. Settings (single `config` row — PRD §9/§10)
Stacked panels, each with an eyebrow header:
- **Appearance:** Theme (Dark/Light/System segmented — dark-first), **Accent color** swatches
  (apply live), **List density** (Comfortable/Compact, applies live).
- **New-ticket defaults** ("moving baseline · §9a"): default threshold (slider), default min
  condition, cohort size, min comparators, new-item foil pref, new-item importance — 2-col grid,
  with a note that changing a default retroactively affects all inheriting items.
- **Notifications:** Telegram bot status (LINKED dot) + **Send test** button (shows "Sent ✓"),
  global TG min-discount slider, quiet hours (start→end + timezone + digest toggle).
- **Scan & data:** schedule (read-only cron `["0 * * * *"]`), account currency, CardTrader token
  status (VALID · read·write scope), deal retention (N days, 0 = forever).
- **Maintenance:** replay boot sequence, clear all deals (danger).

### 4. Health (observability — PRD §11 `scan_runs`)
- **Status banner** (glowing, bracketed): "SCANNER ONLINE" + next-scan clock.
- **Stat tiles** (3-col): uplink 200 OK, token VALID, telegram LINKED, deals found, TG pushed,
  errors-in-window (amber if any).
- **Scan run log:** table — RUN # · STARTED (+relative) · DUR · ITEMS · BLUEPRINTS · API calls ·
  DEALS · TG · STATUS (OK/WARN tag). A warn row expands a detail line (e.g. an HTTP-429 backoff
  message), styled as non-fatal.

### Right-rail Telemetry (Feed / Settings / Health)
Mini scan-radar (rings + rotating sweep, faster while scanning) + next-scan clock + **Scan now**
button; session stats (open deals / unseen / potential savings / scans); a **discount-spread**
distribution (buckets 40–49 / 50–59 / 60–69 / 70+ with bars); and an **activity log** of recent
deals (priority dot · name · −%· age).

### Command palette (⌘K / Ctrl+K)
Overlay with a search input and grouped, fuzzy-filtered commands: **Navigate** (the 4 views),
**Actions** (run scan, add to watchlist, replay boot, toggle scanlines), **Jump to watch item**
(every watchlist row). Full keyboard control (↑/↓, ↵ to run, Esc to close); mouse hover sets the
active row. A ⌘K chip in the top strip opens it.

### Live-scan overlay
Triggered by "Scan now" (and the palette). Modal with a large animated **radar** (rings, cross,
rotating conic sweep, contact pings appearing as it finds deals, center count) beside a streaming
**step log** mirroring PRD §11 (open scan_runs → GET /info → load watchlist → marketplace/products
→ filter+sort → median baseline → threshold/upsert → telegram routing → close) with a progress
bar. ~3.6s, then returns to the feed and surfaces the new deals.

---

## Interactions & behavior
- **Navigation:** instant view switch via left rail or ⌘K. No page reloads (SPA router).
- **Deal feed filters:** status, priority, watch-item, and min-discount all filter the live list.
- **Dismiss / mark-seen:** mutate deal state live (and should PATCH `/api/deals/:id`).
- **Buy:** opens the CardTrader URL in a new tab (`buy_url`). No in-app purchase (PRD non-goal).
- **Scan now:** runs the overlay, then surfaces freshly-found deals.
- **Inherit/override:** toggling a field to an explicit value makes it "sticky"; the reset chip
  nulls it back to following the global default.
- **Accent / density / theme:** apply live by swapping CSS variables on `:root` / `body`.

### Effects (opt-in, all default ON, behind Tweak toggles; keep them feature-flagged)
- **Decrypt reveal:** newly-found deal names scramble through glyphs then resolve (~16 frames /
  ~500ms), staggered ~140ms per card. Runs once per new card.
- **Incoming toasts:** on scan completion, high-priority hits slide a small "PRIORITY · Telegram"
  toast in from the top-right; auto-dismiss after ~4.6s.
- **Radar blips:** ambient contact dots fade in/out on the telemetry mini-radar (pure CSS).
- **Hot clock:** the next-scan countdown turns `--hot` and pulses in its final 60 seconds.
- **Card hover:** border lights to accent + soft glow.

> Performance note: keep all animations transform/opacity-based and **event-driven** (mount,
> hover, scan), not always-on. In the prototype, a once-per-second app-wide re-render (a countdown
> in the root) caused entrance animations to stick at `opacity:0`; the fix was to isolate the
> ticking clock into its own leaf component so the rest of the tree doesn't re-render each second.
> Do the same: keep timers local.

---

## State management
Local UI state needed: `view`, deal list (+ per-deal seen/dismissed), watchlist (+ per-item
overrides), `config`, scan-running flag, newly-found deal ids, selected watch-item id,
add-flow-open, palette-open, toasts, and a scan-target timestamp for the countdown. In the real
app, server data (deals, watchlist, config, scan_runs, expansion/blueprint caches) should come
from the API and be cached/invalidated per action; only ephemeral UI bits stay in component state.

### Map UI → PRD API routes (§10)
| UI action | Route |
|---|---|
| Load feed (filters) | `GET /api/deals?status=&min_discount=&watchlist_id=&priority=` |
| Dismiss / mark seen | `PATCH /api/deals/:id` `{ seen?, dismissed? }` |
| Clear old deals | `DELETE /api/deals?older_than_days=` |
| Load / mutate watchlist | `GET/POST /api/watchlist`, `PATCH/DELETE /api/watchlist/:id` |
| Reset a field to inherit | `PATCH /api/watchlist/:id/reset` |
| Load / save settings | `GET/PATCH /api/config` |
| Add-flow search | `GET /api/resolve/expansions?q=`, `GET /api/resolve/blueprints?expansion_id=&q=` |
| Scan now | `POST /api/scan/run-now` |
| Telegram test | `POST /api/telegram/test` |
| Health | `GET /api/health` |

All money is integer **cents** (PRD §6) — format at the edge, never store floats.

---

## Assets
- **Fonts:** Google Fonts — Chakra Petch + IBM Plex Mono (self-host for production).
- **Icons:** simple inline single-path SVGs (feed, radar, watch, gear, pulse, bolt, ext, eye,
  plus, search, send, check, alert, card, layers, x) — see `components.jsx` `Icon`. Replace with
  the project's icon set if it has one; keep them 1.6px stroke, `currentColor`.
- **Country flags:** rendered from country codes via regional-indicator emoji (no image assets).
- **No raster images / logos** are used; the brand mark is the `◈` glyph + wordmark.

## Files in this bundle (design references)
- `Card Broker.html` — entry; wires fonts, CSS, and the prototype scripts.
- `styles.css` — **design tokens** + global/HUD utilities (start here).
- `ui.css` — primitive component styles (buttons, tags, segmented, switch, inputs, inherit-field).
- `views.css` — layout (shell), all four views, telemetry rail, boot, scan overlay, effects.
- `components.jsx` — shared primitives (Panel, Btn, Status, Tag, Segmented, Switch, InheritField,
  PriceBar, Clock, Icon set, helpers).
- `feed.jsx` — Deal Feed + deal card.
- `watchlist.jsx` — watchlist table, inspector editor, add-flow modal, inherit/override.
- `aside.jsx` — telemetry rail + watch summary.
- `settings.jsx`, `health.jsx` — those views.
- `effects.jsx` — ScrambleText (decrypt) + CommandPalette.
- `boot.jsx` — boot sequence.
- `app.jsx` — app shell, routing, state, scan overlay, toasts, ⌘K, Tweaks wiring.
- `data.js` — **mock data only** (do not port; replace with the real API).
- `cardtrader-deal-scanner-PRD.md` — the full product/backend spec this UI serves.

## Suggested build order
1. Stand up the React+Vite app + theme tokens (Design Tokens above) + the 3-column shell.
2. Routing + the four views as static shells.
3. Wire the API (PRD §10) and replace mock data; deal feed + filters first.
4. Watchlist table + inspector + inherit/override (PRD §9a) + add-flow.
5. Settings (the single `config` row) + Health.
6. Scan overlay + telemetry rail.
7. Boot sequence, command palette, and the opt-in effects last (behind flags).
