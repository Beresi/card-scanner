# Self-hosting the backend
> How Card // Broker runs entirely on the owner's PC instead of Cloudflare.
> For the cross-system view see [architecture](architecture.md); for product scope
> see [project-summary](../project-summary.md).

## Why

Cloudflare's free tier caps three things a full catalog scan runs into:

| Limit | Effect |
|---|---|
| D1 rows read per day | Scans and the API start failing with error 7500 until midnight UTC |
| Worker subrequests per invocation | Whole-set scans had to be chunked and rotated |
| Worker CPU per request | Long scans were pushed to the local deep-sweep sidecar |

Self-hosting removes all three. The only throughput limit left is CardTrader's
own ~1 req/s throttle, which the scanner already respects — so the constraint
becomes the one that is actually real.

## What changes, and what does not

**Unchanged:** every route, the scan engine, the deal algorithm, Telegram
routing, the D1 schema, and `src/db/repo.ts`. None of it is forked or
reimplemented.

**Changed:** only the transport and the timer.

| Concern | Cloudflare | Self-hosted |
|---|---|---|
| HTTP | `workerd` `fetch` | `@hono/node-server` on `node:http`, bound to `127.0.0.1` |
| Schedule | cron `* * * * *` → `scheduled()` | `setInterval(60s)` |
| Storage | D1 binding `env.DB` | SQLite file behind the same D1 contract |
| Process | Cloudflare edge | Windows Scheduled Task at logon |

`src/index.ts` exports both `app` and `heartbeatTick(env)`, and both deployments
use them. A new route or a change to the tick lands in both at once — there is
deliberately no second implementation to keep in sync.

## The three D1 adapters

`src/db/repo.ts` is written against one structural contract —
`prepare · bind · run · all · first · batch · exec`. Three implementations
satisfy it, which is what makes the backend portable:

| Adapter | Backing | Used by |
|---|---|---|
| `env.DB` binding | Cloudflare D1 | the deployed Worker |
| `scripts/d1-http.ts` | D1 REST API | the deep-sweep sidecar |
| `scripts/d1-sqlite.ts` | local SQLite file | **the self-hosted backend** |
| `src/api/__test-helpers__/d1.ts` | in-memory SQLite | the test suite |

`d1-sqlite.ts` wraps `batch()` in a real SQLite transaction, so it is *stricter*
than `d1-http.ts`, which issues sequential REST calls with no atomicity.

## Layout

| Path | Role |
|---|---|
| `worker/scripts/server-local.ts` | the backend — serves `app`, runs the heartbeat |
| `worker/scripts/d1-sqlite.ts` | SQLite behind the D1 contract |
| `worker/scripts/db-bootstrap.ts` | schema creation + migration ledger |
| `worker/scripts/vars.ts` | shared secret resolution |
| `worker/scripts/migrate-from-d1.ts` | one-way D1 → SQLite copy |
| `worker/scripts/cutover.ts` | the ordered switch-over |
| `worker/scripts/install-service.ps1` | install / status / uninstall the logon task |
| `%APPDATA%\CardBroker\cardbroker.db` | the database |
| `%APPDATA%\CardBroker\logs\backend.log` | the log |

The database lives under `%APPDATA%`, not in the repo, so `git clean`, a
reinstall, or moving the checkout cannot destroy deal history.

## Configuration

Resolved by `scripts/vars.ts` in priority order: `process.env` →
`CARD_BROKER_VARS_FILE` → `worker/.dev.vars.local` → `worker/.dev.vars`.

| Key | Required | Notes |
|---|---|---|
| `CARDTRADER_API_TOKEN` | yes | |
| `DESKTOP_AUTH_TOKEN` | yes | the bearer the desktop app sends |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | pushes are skipped when absent |
| `CARD_BROKER_DB` | no | default `%APPDATA%\CardBroker\cardbroker.db` |
| `CARD_BROKER_PORT` | no | default `8787` |

No Cloudflare credential is needed to run. `CF_API_TOKEN` is required only by
`migrate-from-d1.ts`, which reads the old database.

> **A blank value counts as unset.** `.dev.vars.local` ships with empty
> `TELEGRAM_BOT_TOKEN=` / `TELEGRAM_CHAT_ID=` placeholder lines. Under a plain
> `??` walk those would shadow the real values in `.dev.vars` and silently
> disable Telegram. `makeVarGetter` skips empty values for exactly this reason.

## Security

- Binds `127.0.0.1` only — never `0.0.0.0`. The API is not on the LAN.
- The `DESKTOP_AUTH_TOKEN` bearer gate in `src/index.ts` still applies on top,
  unchanged.
- No secret value is written to stdout, stderr, or the log. The startup banner
  reports Telegram as `configured` / `not configured`, never a token.
- The no-purchase guardrail is untouched: `/api/cart/purchase` does not exist
  here any more than it does in the Worker.

## Install

```powershell
cd worker
npm install
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

This registers a Scheduled Task that starts the backend at every logon, with no
console window and no elevation.

| Command | Effect |
|---|---|
| `install-service.ps1` | install (or reinstall) and start |
| `install-service.ps1 -Status` | task state, port, log tail |
| `install-service.ps1 -Restart` | restart — use after changing server code |
| `install-service.ps1 -Stop` | stop, leaving the task registered for next logon |
| `install-service.ps1 -Uninstall` | remove the task; database and logs are kept |
| `install-service.ps1 -Port 9000` | use a different port |

Why a Scheduled Task rather than a Windows Service: a service needs elevation to
install plus a wrapper to host a Node process. A logon task needs neither and is
inspectable in `taskschd.msc`. It is launched through a generated `.vbs` shim
because running `node.exe` directly from a task shows a console window for the
life of the process.

> **`schtasks /end` does not stop the backend.** The `.vbs` shim returns as soon
> as it has spawned the server, so the task reaches *Ready* within a second while
> the node process keeps running, orphaned from it. `/end` reports success and
> terminates nothing. Every stop path in `install-service.ps1` — and step 2 of
> the cutover — instead kills the process actually listening on the port, then
> waits for the port to free so a restart cannot race the bind.

> **The script must keep its UTF-8 BOM.** Windows PowerShell 5.1 decodes a
> BOM-less `.ps1` as ANSI, which mangles the em dashes in its output and can
> break the parser outright.

Run it in the foreground instead with `npm run serve:local`.

## Migrating the data

```
npm run db:migrate-from-d1                  copy everything, resuming
npm run db:migrate-from-d1 -- --fresh       wipe local tables first
npm run db:migrate-from-d1 -- --verify      compare row counts, write nothing
npm run db:migrate-from-d1 -- --tables=deals,watchlist
```

Reads over the D1 REST API using the same `CF_API_TOKEN` the deep-sweep sidecar
already uses, so `wrangler login` is not involved.

**Resumable by design.** Paging is by primary key (`WHERE id > ? ORDER BY id`),
not `OFFSET`, so the cursor cannot skip or duplicate rows and stays O(1) per page
as `blueprints` grows. Each page commits locally before the next is fetched, and
the cursor restarts from `MAX(id)` already present. If the daily row-read cap is
hit mid-copy, re-running continues from the same point instead of starting over.

Rows are inserted using the intersection of remote and local columns; any column
on one side only is reported. That is the drift signal between production D1 and
`src/db/schema.sql`.

## Cutting over

```
npm run cutover -- --dry-run    print the plan, change nothing
npm run cutover                 do it
```

The order is the point:

1. **Quiesce the cloud** — PATCH `config.scan_interval_minutes` to 30 days so the
   Worker cron stops scanning. It competes for the same row-read budget, and
   once both backends scan, *both* push the same deals to Telegram.
2. **Stop the local backend** — its heartbeat writes `scan_runs`; copying into a
   database being written produces id collisions.
3. **Copy** with `--fresh`.
4. **Verify** row counts. A mismatch aborts before anything points at local.
5. **Repoint the desktop** — rewrites `VITE_API_BASE_URL` in
   `desktop/.env.local`, keeping a `.bak`.
6. **Restart** the backend against the copied data.

A failure at any step stops everything downstream, leaves the desktop on the
cloud, and is safe to re-run.

The Worker and D1 are left in place, quiesced, as a rollback path. Deleting them
is a separate deliberate step.

## Schema and migrations

`src/db/schema.sql` is kept at the *current* shape, so a fresh local database is
created from it alone. The numbered migrations are historical upgrade steps and
must never be replayed on a fresh database — `0005` and `0006` DROP and rebuild
`watchlist`.

`bootstrapLocalDb()` runs on every start and:

- creates the schema if the database is new,
- records migrations through the go-live baseline as already-applied in
  `_local_migrations` without executing them,
- executes any migration newer than the baseline that is not yet recorded, each
  in its own transaction.

So a migration `0014` added later applies automatically on the next restart.

`verifySchema()` then asserts the live database declares every column the
migrations introduce, and the server **refuses to start** if any are missing.
That is the guard on the "schema.sql is current" assumption: if a migration is
ever added without folding it into `schema.sql`, this fails loudly instead of a
fresh database silently lacking the column.

## Rolling back

1. Set `VITE_API_BASE_URL` in `desktop/.env.local` back to the workers.dev URL
   (or restore `.env.local.bak`).
2. Set the cloud `config.scan_interval_minutes` back to 60 in Settings.
3. `install-service.ps1 -Uninstall`.

The cloud database still holds everything as of the cutover; anything found
locally since then stays in the local file.

## Gotchas

- **The desktop must be restarted** after the cutover — Vite inlines
  `VITE_API_BASE_URL` at build time, so a running app keeps the old base URL.
- **Scans only run while the PC is on.** This is the one genuine regression
  against the always-on cloud cron. The heartbeat runs once immediately at
  startup so a machine that was asleep past its scan window catches up on boot
  rather than waiting out a full interval.
- **Do not run both backends against their own databases and both with Telegram
  configured** — every deal gets pushed twice. Step 1 of the cutover exists to
  prevent exactly this.
- **`npm run scan:local` and `npm run catalog:resync` still target Cloudflare
  D1**, not the local database. They are the old CLIs, kept only as an escape
  hatch while the cloud remains as a backup. Do not use them after the cutover —
  their results would land in the database the app no longer reads.

## The sidecar, and why it is gone

"Scan Now" and Settings → Maintenance → "Resync catalog" used to spawn a bundled
Tauri sidecar (a 92 MB Node SEA binary) that reached the database over the D1
REST API. That sidecar existed for exactly one reason: to run work longer than a
Worker's CPU and subrequest budget allowed.

Self-hosted, that reason is gone — and keeping it would have been a correctness
bug rather than dead weight. The sidecar writes to whatever database its own
credentials name, which after the migration is the *old cloud D1*: both buttons
would have appeared to work while their results landed where the app no longer
reads, burning the quota being escaped.

Both jobs are now detached API routes served in-process:

| Button | Route | Returns |
|---|---|---|
| Scan Now | `POST /api/scan/deep-sweep` | `{ started, runId }` once the `scan_runs` row is open |
| Resync catalog | `POST /api/catalog/resync` | `{ started, totalSets }` once the set list is resolved |

`started: true` means *started*, not finished; the UI polls `scan_runs` and
catalog progress exactly as it did before. `runScan` already exposed
`onRunOpened` and `resyncCatalog` already exposed `onStart` for precisely this,
and the response shapes are unchanged — the views consuming them did not change.

Running in-process also means **one writer** on the SQLite file rather than two
processes contending for it.

Consequently the Tauri host lost `commands.rs`, the shell plugin, the
`shell:allow-execute` sidecar grant, and `externalBin`. The webview now needs no
process-spawning capability at all, and the desktop build no longer depends on
building that SEA binary first.
