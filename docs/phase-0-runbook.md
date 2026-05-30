# Phase 0 Runbook — CardTrader Deal Scanner

First-time setup for the Cloudflare backend. All commands are copy-pasteable
and must be run from the `e:\Projects\card-scanner\worker` directory unless
stated otherwise. Steps that require your account credentials or secret values
are marked **OWNER ACTION** — Claude Code cannot perform these for you.

---

## Prerequisites

- Node.js 18+ and npm installed.
- A Cloudflare account (free tier is sufficient).
- A CardTrader developer account with an API token (read + write scope).
- A Telegram account to create a bot.

---

## Step 1 — Authenticate with Cloudflare

**OWNER ACTION.** Log in interactively (opens a browser):

```sh
npx wrangler login
```

Alternatively, if you prefer a non-interactive CI-style setup, set an API token
as an environment variable instead of logging in interactively:

```sh
# Generate at https://dash.cloudflare.com/profile/api-tokens
# Scope: Cloudflare Workers (Edit), D1 (Edit)
export CLOUDFLARE_API_TOKEN=<your-token>
```

Verify the login worked:

```sh
npx wrangler whoami
```

---

## Step 2 — Create the D1 database

**OWNER ACTION.** Run once — this creates the database in your Cloudflare account:

```sh
npx wrangler d1 create cardtrader_scanner
```

Wrangler prints output similar to:

```
[[d1_databases]]
binding = "DB"
database_name = "cardtrader_scanner"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy the `database_id` value** and paste it into `wrangler.toml`, replacing
`REPLACE_AFTER_D1_CREATE`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "cardtrader_scanner"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # <-- paste here
```

---

## Step 3 — Apply the database schema

The schema is delivered at `src/db/schema.sql` (creates all six tables and seeds
the single `config` row via `INSERT OR IGNORE INTO config (id) VALUES (1)` — the
inheritance baseline). Apply it to both the local dev DB and the remote DB.

Apply to the **remote** (production) database:

```sh
npx wrangler d1 execute cardtrader_scanner --remote --file=src/db/schema.sql
```

Apply to the **local** development database (for `wrangler dev` sessions):

```sh
npx wrangler d1 execute cardtrader_scanner --local --file=src/db/schema.sql
```

Re-run after every schema migration. Never deploy the Worker against an
unmigrated database — every query will fail.

---

## Step 4 — Provision Wrangler secrets

**OWNER ACTION.** Each command below prompts you to paste the secret value.
Nothing is echoed to the terminal. Never put these values in `wrangler.toml`,
source code, `.env` files, or git.

```sh
npx wrangler secret put CARDTRADER_API_TOKEN
```
Your CardTrader API token (obtain from https://www.cardtrader.com/en/developer).
**HIGH SENSITIVITY** — this token has read + write/purchase scope. Rotate it
immediately via `wrangler secret put` if it ever appears in a log, commit,
response body, or bundle.

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
Your Telegram bot token from @BotFather (see Step 5 below).

```sh
npx wrangler secret put TELEGRAM_CHAT_ID
```
The chat id of the channel/chat where deal notifications should be sent
(see Step 5 below for how to retrieve this).

```sh
npx wrangler secret put DESKTOP_AUTH_TOKEN
```
A strong, random shared secret the Tauri desktop app sends as a bearer token
on every `/api/*` request. Generate one yourself — for example:

```sh
# On Linux/macOS:
openssl rand -hex 32

# On Windows (PowerShell):
[System.Web.Security.Membership]::GeneratePassword(64, 16)
# or install openssl and run: openssl rand -hex 32
```

Store the same value in the Tauri desktop app's OS-backed secure storage
(keyring/stronghold) — never commit it anywhere.

Audit which secrets are set at any time:

```sh
npx wrangler secret list
```

---

## Step 5 — Create the Telegram bot and capture the chat id

**OWNER ACTION.**

### Create the bot

1. Open Telegram and start a chat with **@BotFather**.
2. Send `/newbot` and follow the prompts (choose a name and username).
3. BotFather replies with your bot token: `0000000000:AABBccDDee...`
4. Use that token for `TELEGRAM_BOT_TOKEN` in Step 4.

### Capture the chat id

**Option A — getUpdates (easiest):**

1. Send any message to your bot (or to the group/channel where it should post).
2. Call the Telegram API in a browser or curl:

```sh
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
```

3. Find `"chat":{"id": -100...}` in the response. That number is your `TELEGRAM_CHAT_ID`.
   Note: group/channel ids are typically negative.

**Option B — @userinfobot:**

1. Add @userinfobot to the group/channel.
2. It replies with the chat id.

Use the captured id for `TELEGRAM_CHAT_ID` in Step 4.

---

## Step 6 — Verify the secret slots

```sh
npx wrangler secret list
```

Expected output lists all four secrets (values are never shown):

```
CARDTRADER_API_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
DESKTOP_AUTH_TOKEN
```

---

## Step 7 — Set up local dev vars

Copy the example file and fill in real values for local development:

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars with your real values — this file is git-ignored
```

`.dev.vars` is read automatically by `wrangler dev`. Never commit it.

---

## Step 8 — Deploy the Worker

Run after schema is applied (Step 3) and secrets are set (Step 4):

```sh
npx wrangler deploy
```

Verify the deploy succeeded by hitting the health endpoint:

```sh
curl https://cardtrader-deal-scanner.<your-subdomain>.workers.dev/api/health
```

Confirm in the Wrangler deploy output or Cloudflare dashboard that the cron
trigger `0 * * * *` (hourly UTC) is registered.

---

## Step 9 — Verify end-to-end (with the bearer token)

Every `/api/*` route requires `Authorization: Bearer <DESKTOP_AUTH_TOKEN>` — there
is **no Cloudflare Access**; the bearer gate in `src/index.ts` is the sole auth
layer (single-user tool; see `docs/.bootstrap-discovery.md`). Replace `<URL>` with
your deployed Worker URL and `<TOKEN>` with the DESKTOP_AUTH_TOKEN.

Health (latest scan + token status):

```sh
curl -H "Authorization: Bearer <TOKEN>" https://<URL>/api/health
```

Trigger a scan immediately (same code path as the hourly cron):

```sh
curl -X POST -H "Authorization: Bearer <TOKEN>" https://<URL>/api/scan/run-now
```

The response is a scan summary `{ runId, watchItemsScanned, …, error }`. With an
empty watchlist it scans 0 items and closes cleanly. Without `CARDTRADER_API_TOKEN`
the run records `error: "cardtrader token invalid (401)"` and aborts cleanly — that
is expected until the token is set. A request with no/invalid bearer returns `401`.

(Optional) Test Telegram wiring once both Telegram secrets are set:

```sh
curl -X POST -H "Authorization: Bearer <TOKEN>" https://<URL>/api/telegram/test
```

---

## Step 10 — Point the desktop app at the cloud

For the later wiring pass, create `desktop/.env.local` (git-ignored via `*.local`):

```
VITE_API_BASE_URL=https://<URL>
VITE_DEV_AUTH_TOKEN=<the same DESKTOP_AUTH_TOKEN>
```

`desktop/src/api/client.ts` reads these. This is the dev path; production moves the
token into Tauri OS-backed secure storage (security-agent task). The watchlist
starts empty — add real items via the desktop add-flow (needs `/api/resolve`
fetch+cache, a later task) or by inserting rows with **real** CardTrader
expansion/blueprint ids; mock ids will not resolve against the live API.

---

## Phase 0 Checklist (PRD §15)

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Cloudflare account exists | Owner | OWNER ACTION |
| 2 | `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` env set) | Owner | OWNER ACTION |
| 3 | `wrangler d1 create cardtrader_scanner` → `database_id` pasted into `wrangler.toml` | Owner | OWNER ACTION |
| 4 | Schema at `src/db/schema.sql` delivered by backend-agent | backend-agent | Pending |
| 5 | Schema applied to remote DB (`--remote --file=src/db/schema.sql`) | Owner | OWNER ACTION (after #4) |
| 6 | Schema applied to local dev DB (`--local --file=src/db/schema.sql`) | Owner | OWNER ACTION (after #4) |
| 7 | `wrangler secret put CARDTRADER_API_TOKEN` | Owner | OWNER ACTION |
| 8 | `wrangler secret put TELEGRAM_BOT_TOKEN` | Owner | OWNER ACTION |
| 9 | `wrangler secret put TELEGRAM_CHAT_ID` | Owner | OWNER ACTION |
| 10 | `wrangler secret put DESKTOP_AUTH_TOKEN` | Owner | OWNER ACTION |
| 11 | Telegram bot created via @BotFather; token captured | Owner | OWNER ACTION |
| 12 | Telegram chat id captured via `getUpdates` or @userinfobot | Owner | OWNER ACTION |
| 13 | `.dev.vars` created from `.dev.vars.example`, values filled in | Owner | OWNER ACTION |
| 14 | `npx wrangler deploy` succeeds; `GET /api/health` returns OK | Owner | OWNER ACTION (after all above) |
| 15 | Cron trigger `0 * * * *` confirmed in deploy output / dashboard | Owner | OWNER ACTION |
| 16 | Tauri desktop target scaffolded (separate Phase 0 task — tauri-agent) | tauri-agent | Pending |
| 17 | Git repo initialized and `.gitignore` covers secrets, build output | devops-agent | Pending |
| 18 | Desktop `DESKTOP_AUTH_TOKEN` stored in OS-backed secure storage | tauri-agent | Pending |

---

## Notes on the architecture

- The Worker is **API-only**. It does not serve the dashboard. There is no
  `[assets]` block in `wrangler.toml`. The dashboard is the Tauri desktop app.
- All money is **integer cents** in the DB and API — never floats.
- The CardTrader token has write/purchase scope but the app never calls purchase
  endpoints (PRD §2). Treat it as the highest-sensitivity secret in the project.
- The hourly cron fires at the **top of every hour UTC** (`0 * * * *`).
  Quiet-hours logic must account for timezone conversion, not assume local time.
- The D1 binding name `DB` (i.e. `env.DB`) is the contract across the entire
  backend codebase — do not rename it.
