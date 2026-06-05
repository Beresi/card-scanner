# Local Deep-Sweep Scan

> File: `worker/scripts/scan-local.ts`  
> Companion scripts: `worker/scripts/d1-http.ts`, `worker/scripts/env-local.ts`

## What it is

A manual, on-demand CLI that runs the **existing scan path** (`runScan`) on the owner's local
machine against the **same production Cloudflare D1** database the hourly cron and desktop app
use. It bypasses the Cloudflare Worker free-tier subrequest/CPU limits by running as a
long-lived Node.js process via `tsx`.

The Cloudflare hourly cron is **completely unaffected** — it continues to operate as always.
The CLI is additive: run it when you want an immediate, uncapped whole-set sweep on top of the
normal rotation.

**Key difference from the cron:** it forces `modeOverride: 'wholeset'` with `trigger:
'run-now'`. This scans every watched expansion in one pass (no chunked batch cap), and the
`run-now` trigger bypasses the wholeset 55-minute self-throttle. The cron uses `trigger: 'cron'`
with no `modeOverride`, so its chunked/wholeset behavior is byte-for-byte unchanged.

**Deals appear in the desktop immediately** — they land in the same D1 `deals` table. Telegram
pushes fire only if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.dev.vars.local`.

## Setup

### 1. Create a scoped Cloudflare API token

The CLI needs direct D1 access. Create a token scoped to **D1 Edit** only — not Account
Administrator, not broader Workers scopes.

1. Go to `https://dash.cloudflare.com/profile/api-tokens`
2. Click **Create Token** → **Custom token**
3. Set **Token name**: e.g. `card-broker-d1-local-scan`
4. Under **Permissions**, add:  
   Account → D1 → **Edit**
5. Under **Account Resources**, select **Include → <your account>**
6. **Do not** add Zone or Worker route permissions — this token is D1-only.
7. Click Continue to summary → Create Token → copy the token value immediately.

### 2. Find your account id and database id

**Account id**: visible in the Cloudflare dashboard right-hand sidebar, or run:
```
npx wrangler whoami
```

**Database id**: already in `worker/wrangler.toml` under `[[d1_databases]] database_id`.
You can also run:
```
npx wrangler d1 list
```

### 3. Create `worker/.dev.vars.local`

Copy `worker/.dev.vars.example` to `worker/.dev.vars.local` and fill in all values:

```dotenv
# Existing keys (same as .dev.vars for wrangler dev)
CARDTRADER_API_TOKEN=ct_live_...
TELEGRAM_BOT_TOKEN=...       # optional — omit to suppress Telegram pushes
TELEGRAM_CHAT_ID=...         # optional
DESKTOP_AUTH_TOKEN=...       # optional for the CLI

# New keys for the local deep-sweep CLI
CF_ACCOUNT_ID=abc123...
CF_D1_DATABASE_ID=32265ad6-4e1d-4ef8-8086-899962fcdb1f
CF_API_TOKEN=your-scoped-api-token-here
```

`.dev.vars.local` is listed in `.gitignore` — it will never be committed.

### 4. Install dependencies

```
cd worker
npm install
```

## Usage

```
cd worker
npm run scan:local
```

Example output:
```
=== Card // Broker — local deep-sweep scan ===
Started at: 2026-06-04T18:00:00.000Z
Mode:       wholeset (all watched expansions, no chunked cap)
Trigger:    run-now (wholeset self-throttle bypassed)
Target:     production D1 (same DB as the cron and desktop app)

Account ID:  abc123...
Database ID: 32265ad6-4e1d-4ef8-8086-899962fcdb1f
Telegram:    configured (pushes enabled)

Running scan...

=== Scan complete ===

Run ID:                 42
Watch items scanned:    8
Blueprints scanned:     312
API calls:              314
Deals found (new):      5
Telegram sent:          2
Error:                  none
Elapsed:                7m 23.1s
```

Exit code is **0** on a clean run, **1** if `summary.error` is set.

## Environment keys reference

| Key | Required | Description |
|---|---|---|
| `CARDTRADER_API_TOKEN` | Yes | CardTrader API v2 bearer token. High sensitivity. |
| `CF_ACCOUNT_ID` | Yes | Cloudflare account id. |
| `CF_D1_DATABASE_ID` | Yes | D1 database id — same value as `wrangler.toml database_id`. |
| `CF_API_TOKEN` | Yes | Cloudflare API token scoped to D1 Edit on this account/db only. |
| `TELEGRAM_BOT_TOKEN` | No | If absent, Telegram pushes are suppressed (isTelegramConfigured gates them). |
| `TELEGRAM_CHAT_ID` | No | Required alongside BOT_TOKEN for pushes to fire. |
| `DESKTOP_AUTH_TOKEN` | No | Not used by the scan; included for Env completeness. |

## Architecture notes

- `scripts/d1-http.ts` implements a `D1Database`-shaped adapter over the Cloudflare D1 REST
  API (`POST /client/v4/accounts/{id}/d1/database/{id}/query`). It covers the exact subset
  `repo.ts` uses: `prepare`, `bind`, `run`, `all`, `first`, `batch`.
- **`batch()` is NOT atomic** in this adapter (individual REST calls, no transaction). The
  batch call sites in `repo.ts` are all idempotent upserts or safe delete-pairs, so partial
  application is harmless and the next scan self-heals.
- `scripts/` is Node-only. No Worker runtime code imports from `scripts/`. The `tsconfig.json`
  excludes `scripts/`; `tsconfig.scripts.json` covers both `src/` and `scripts/`.
- The `CF_API_TOKEN` value is stored only inside the adapter closure and never appears in logs,
  error messages, or summaries.

## Security reminders

- Never commit `.dev.vars.local`.
- The `CF_API_TOKEN` has direct D1 write access to the production database — treat it like a
  production credential. Rotate it immediately if it is ever exposed.
- The `CARDTRADER_API_TOKEN` has read+write/purchase scope on CardTrader — equally sensitive.
  The CLI reuses the existing client and does not add any cart/purchase calls.
