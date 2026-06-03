# CLAUDE.md — CardTrader Deal Scanner ("Card // Broker")

Personal, single-user tool that scans the CardTrader marketplace hourly for **underpriced
Magic: The Gathering cards**, shows every deal in a desktop dashboard, and pushes a strict,
opt-in subset to Telegram. No auto-buying — deals link out and the owner buys manually.

- **Authoritative spec:** `cardtrader-deal-scanner-PRD.md` (cite sections as §N).
- **Design handoff:** `README.md` + `design_handoff_deal_scanner_dashboard/` (reference only —
  do NOT port its Babel-in-HTML / `window.*` / mock-`data.js` scaffolding).
- **Overview & decisions:** `docs/project-summary.md`, `docs/.bootstrap-discovery.md`.

## Architecture — two build targets
**Tauri desktop client + unchanged Cloudflare cloud backend** (this overrides the PRD's web
delivery; backend logic is per-PRD).
- **Backend (`/worker`, API-only):** TypeScript on **Cloudflare Workers** + **Hono** + **D1**
  (binding `DB`), hourly cron `scheduled()` sharing the scan path with `POST /api/scan/run-now`.
  Always-on; scans regardless of whether the desktop app runs. No static-asset hosting.
- **Desktop (`/desktop`):** **Tauri v2** — React + Vite + TS frontend (`src/`) in the webview +
  a thin Rust host (`src-tauri/`). Calls the cloud `/api/*` over HTTPS via **TanStack Query**,
  authenticating with a Cloudflare Access service token / shared bearer in on-device secure
  storage.

@docs/project-summary.md
@docs/documentation/architecture.md

## Tech stack
TypeScript · Cloudflare Workers + Hono + D1 (SQLite) · Wrangler · React 18/19 + Vite +
TanStack Query · Tauri v2 (Rust host) · Vitest · CardTrader API v2 (Bearer) · Telegram Bot API.
Styling = **CSS custom properties + `cb-` classes** (NOT Tailwind). No i18n, no Next.js, no
Firebase, no Stripe/payments.

## Commands (targets; tooling is stood up in Phase 0)
| Task | Command |
|---|---|
| Backend dev | `npx wrangler dev` |
| Frontend dev | `npm run dev` · desktop: `npm run tauri dev` |
| Build | `npm run build` (frontend) · `npm run tauri build` (desktop bundle) |
| Test | `npm test` / `npx vitest run` · `cargo test` (host) — `/test` |
| Lint+types | `npx eslint .` · `npx tsc --noEmit` · `cargo clippy`/`fmt` — `/lint` |
| Full gate | `/validate` |
| D1 | `npx wrangler d1 create cardtrader_scanner` · `... d1 execute DB --file=src/db/schema.sql` |
| Secrets | `npx wrangler secret put CARDTRADER_API_TOKEN` (also `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) |
| Deploy | `/deploy` (Worker via `wrangler deploy`; desktop via `tauri build` + sign) |

## Directory map (planned — greenfield)
```
/worker     src/{index.ts, cardtrader/, scan/, telegram/, db/, api/}, wrangler.toml
/desktop    src/ (React+Vite views/components/shell), src-tauri/ (Rust host)
/docs       standards/, documentation/, project-summary.md, .bootstrap-discovery.md
.claude     agents/, skills/, commands/, settings.json
```

## Key invariants (do not violate)
- **Money is always integer cents** — never floats; format only at the display edge.
- **No auto-purchase** — the desktop app may call CardTrader's `GET /cart`, `POST /cart/add`, and `POST /cart/remove` to view and manage the owner's cart, but we NEVER call `/cart/purchase` (or any checkout endpoint). The owner completes checkout manually on cardtrader.com.
- **Dedupe on `product_id`** — one deal row + one Telegram push per listing.
- **App feed = everything; Telegram = strict opt-in subset** (anti-spam is the core feature).
- **Inheritance (§9a):** per-ticket override columns are `NULL` → fall back to `config`
  defaults at scan time (use `??`, not `||`); explicit values are sticky; new tickets born
  inheriting. Resolve in ONE helper (`resolveEffective`).
- **Secrets:** Wrangler secrets (backend) + OS secure storage (desktop) — never in source,
  logs, bundle, D1, or git.
- **Animations:** transform/opacity-only, event-driven, feature-flagged, reduced-motion aware;
  isolate the per-second `Clock` into a leaf component.

## Agents — delegation map
The main session is the **architect** (plan → delegate → verify → integrate). Delegate by task:

| Task area | Agent |
|---|---|
| Deal algorithm, CardTrader client, scan orchestration, Telegram routing | **scan-engine-agent** |
| Hono API routes, D1 repo/schema, config + inheritance plumbing | **backend-agent** |
| React primitives & view components (cb- classes, no Tailwind) | **component-agent** |
| Wiring views/flows to the API (feed, watchlist, settings, health, overlays) | **feature-agent** |
| Design tokens, theming, chamfer/glow, animations/effects | **design-agent** |
| Tauri Rust host, secure storage, packaging/updater | **tauri-agent** |
| Secrets, auth, no-purchase guardrail, security review | **security-agent** |
| Tests (§16 fixtures), typecheck, lint, QA | **quality-agent** |
| Wrangler deploy, D1 migrations, Tauri build/release, CI | **devops-agent** |

Skills (auto-loaded by description) back these agents: `cardtrader-api`, `deal-engine`,
`telegram-notifications`, `cloudflare-workers`, `d1-database`, `inherit-override`,
`tauri-desktop`, `backend-dev`, `component-dev`, `view-dev`, `design-system`, `animation`,
`forms`, `state-management`, `accessibility`, `security`, `error-handling`, `testing`,
`documentation`.

## Your Workflow

### Phase 1: PLAN
1. Analyze scope — which domains are affected?
2. Identify advisory needs — for each domain involved, ask: do I know enough to plan well?
   Consult domain agents in **advisory mode** (read-only) when the domain has non-obvious
   patterns, you're unsure about conventions, decomposition is domain-specific, or an
   architectural decision depends on domain expertise. Spawn advisors in parallel for
   multi-domain features. Skip for trivial tasks.
3. Break into atomic units — incorporate advisor input.
4. Identify dependencies.
5. Produce a numbered task list with agent assignments.

### Phase 2: DELEGATE
For each work unit, give the executing agent: scope, context, constraints, acceptance criteria.

### Phase 3: VERIFY
Check output against acceptance criteria. Send back with corrections if needed.

### Phase 4: INTEGRATE
Wire imports/exports, verify the end-to-end flow.

## Advisory mode prompt template
```
ADVISORY MODE — research only. Do NOT write or modify any files.

Read .claude/agents/<agent-name>.md to understand your domain expertise.
Read these context files: <paths>

Question: <specific scoped question>

Return:
- Existing patterns in this codebase relevant to the question
- Recommended approach with rationale
- Risks and gotchas I should plan around
- Suggested decomposition (if you'd split this differently than my draft)

Do NOT propose a full implementation. Do NOT create or edit files.
Keep the response under 400 words.
```
The architect remains the planner of record — advisor input informs the plan, but the
architect decides.

## Build sequencing (PRD §15)
Phase 0 setup → core engine → Telegram → dashboard API + minimal UI → full routing → add-card
UX → settings/maintenance → polish. Stand up the Tauri shell + theme tokens early so appearance
isn't a retrofit.

## Deferred (enable during Phase 0, not yet active)
- **Format hooks:** a PostToolUse prettier/`cargo fmt` hook is intentionally NOT in
  `settings.json` yet — it would error on the empty repo. Add it once deps are installed
  (see `docs/standards/claude-code-maintenance.md`).
- **MCP:** `@modelcontextprotocol/server-sqlite` (point at the local Wrangler D1 file once it
  exists, for schema/query inspection) and `@modelcontextprotocol/server-github` (once a git
  remote exists). Configure in `settings.json` under `mcpServers` when ready.

## Permissions & session tips
`.claude/settings.json` runs in `acceptEdits` mode (file edits auto-approved; build/test/
wrangler/cargo/git commands allowlisted). Start a fresh session per task; `/compact` when
context gets heavy; debug with `claude --debug`, `/permissions`, `/hooks`, `/cost`, `/model`.
