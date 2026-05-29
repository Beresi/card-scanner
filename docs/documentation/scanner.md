# Scan Orchestration
> Planned: `src/scan/scanner.ts` (Cloudflare Worker, `/worker` backend — PRD [§14](../../cardtrader-deal-scanner-PRD.md)).
> Greenfield — describes intent. Spec: PRD [§11](../../cardtrader-deal-scanner-PRD.md) (flow), [§4](../../cardtrader-deal-scanner-PRD.md) (architecture).

## Purpose
Orchestrate one scan run end to end. The scanner owns the `scan_runs` lifecycle, walks the
active watchlist, fetches the cheapest-25 listings per blueprint, and delegates the actual
decisions: deal math to [`dealEngine`](dealEngine.md) (PRD §7) and the notify decision to
[`telegram/routing`](telegram.md) + the notifier (PRD §8). It does no price math and no
routing math itself — it is the loop, the throttle, and the bookkeeping around the pure cores.

It is the single shared code path for **both** entrypoints: the hourly cron `scheduled()`
handler and `POST /api/scan/run-now`. "Scan now" and the cron are identical by construction
(PRD §4). See [architecture](architecture.md) for how the scanner sits between the CardTrader
client, the engine, the repo, and Telegram.

## Public interface
| Function | Signature | Notes |
|---|---|---|
| `runScan` | `runScan(env, { trigger }) -> Promise<ScanSummary>` | `trigger: 'cron' \| 'run-now'`. The one entrypoint both callers use. |

```ts
type ScanTrigger = 'cron' | 'run-now';

// Mirrors the scan_runs row the run wrote (the durable log).
type ScanSummary = {
  runId: number;
  watchItemsScanned: number;
  blueprintsScanned: number;
  apiCalls: number;
  dealsFound: number;       // truly-new deal rows inserted this run
  telegramSent: number;
  error: string | null;     // null on clean run
};
```

Invariants callers must respect:
- `env` carries the D1 binding (`DB`) and the Wrangler secrets (`CARDTRADER_API_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). The scanner never reads secrets from anywhere else.
- `runScan` always resolves (it does not reject for a normal scan failure). A whole-run
  failure is recorded in `scan_runs.error` and reflected in the returned `ScanSummary.error`;
  the row is always closed (see [Error handling](#error-handling)).
- Concurrency is not designed for — the cron and a manual run-now firing at the same instant
  would open two overlapping runs. Not a v1 concern (single user, hourly).

## The flow (PRD §11)
Numbered to match the PRD step list (the Health view and live-scan overlay stream these
milestones). All money is **integer cents**.

1. **Open `scan_runs`** — insert a row with `started_at`. Hold its `id` for the rest of the run.
2. **Validate token** — `GET /info` via the [CardTrader client](cardtrader-client.md). On
   `401`: record the error in `scan_runs.error`, **abort the run**, and alert **once** (do not
   re-alert on repeated 401s across runs). Close the row and return.
3. **Load active watchlist** — `repo` query for `watchlist WHERE active = 1`.
4. **Group by type** — split into expansion items and blueprint items (see
   [Expansion vs blueprint](#expansion-vs-blueprint-handling)).
5. **Per item, fetch cheapest-25** — sequential `marketplace/products` calls, **throttled to
   ~1 req/s across the whole run**, with exponential backoff on HTTP 429 / `"Too many
   requests"` bodies. Each call increments the `api_calls` counter.
6. **Run the deal engine** — for each `(watch item, blueprint, product list)`, resolve
   effective settings (see [Inheritance](#inheritance)) and call `dealEngine` (PRD §7). It
   returns the candidate + baseline + `discount_pct` + `is_deal`, or a skip.
7. **Upsert deals** — `INSERT … ON CONFLICT(product_id) DO NOTHING` for each `is_deal`.
   **The rows actually inserted are the new deals** for this run; conflicts are already-known
   listings and are not re-processed.
8. **Route + notify new rows** — for each newly-inserted row compute `priority` and run the
   Telegram routing decision (PRD §8); batch-send the passing ones via the notifier and mark
   `telegram_sent` / `telegram_sent_at`.
9. **Enrich names** — fill `card_name` / `expansion_name` (and image where useful) from the
   `blueprints` / `expansions` cache.
10. **Close `scan_runs`** — write `finished_at` and the counters (`watch_items_scanned`,
    `blueprints_scanned`, `api_calls`, `deals_found`, `telegram_sent`) and `error` (NULL on
    success). This step runs in a `finally` so the row closes even on throw.

## Expansion vs blueprint handling
The watchlist mixes two item types; each maps to a different `marketplace/products` call shape
(PRD §6).

| Watch item `type` | Call | Response | Iteration |
|---|---|---|---|
| `expansion` | one `GET /marketplace/products?expansion_id=X&language=en` | map `blueprint_id -> [products]` (up to 25 each) | iterate the map; one engine run per blueprint key |
| `blueprint` | one `GET /marketplace/products?blueprint_id=X&language=en` | map with a single `blueprint_id` key | one engine run |

A whole set is therefore **one API call** for all its blueprints — the reason set-watching is
cheap enough for hourly scans.

> **Caveat (PRD [§6](../../cardtrader-deal-scanner-PRD.md)/[§13](../../cardtrader-deal-scanner-PRD.md)):**
> the `language` filter on the `expansion_id` variant is unverified. If the API does **not**
> honor `language=en` on the expansion call, fall back to **per-blueprint** calls for that set
> (still fine hourly). Verify during build before relying on the batch path.

## Inheritance
Per-item settings are resolved to **effective** values before each engine run. Every nullable
override column on the watch item falls back to the matching `config` default:

```
effective_value = ticket.value  IF NOT NULL  ELSE  config.matching_default
```

This covers `threshold_pct`, `min_condition`, `foil_pref`, `allow_graded`, `importance`,
`telegram_enabled`, and the Telegram discount/price/savings overrides. Resolution happens in
one place — `resolveEffective(ticket, config)` — not scattered across the loop. NULL means
"follow the (moving) default"; an explicit value is sticky. See PRD
[§9a](../../cardtrader-deal-scanner-PRD.md) and the data-model doc for the column-by-column
mapping.

## `scan_runs` fields written
One row per run is the durable log (PRD §9). These feed the **Health** view and
`GET /api/health`.

| Field | When written | Meaning |
|---|---|---|
| `started_at` | step 1 (open) | run start timestamp |
| `finished_at` | step 10 (`finally`) | run end timestamp |
| `watch_items_scanned` | step 10 | active watch items processed |
| `blueprints_scanned` | step 10 | distinct blueprints run through the engine (expands sets) |
| `api_calls` | incremented per fetch | total CardTrader requests (throttle/backoff visibility) |
| `deals_found` | step 10 | truly-new deal rows inserted this run |
| `telegram_sent` | step 10 | deals pushed to Telegram this run |
| `error` | step 10 | NULL on success; the failure message on a whole-run failure |

## Error handling
Follows [coding-standards](../standards/coding-standards.md) — external calls are expected to
fail.

- **Single blueprint failure is non-fatal.** Catch at the per-item boundary: log it
  (structured, with which blueprint and which endpoint), skip that item, continue the run
  (PRD §13). One bad set never sinks the scan.
- **Whole-run failure** (something outside a per-item boundary throws) is recorded in
  `scan_runs.error`; the run still closes cleanly with whatever counts accrued.
- **Token 401** on `GET /info` aborts the run and alerts **once** — never spam on repeats.
- **Rate limiting** — the client throttles `marketplace/products` to ~1 req/s and backs off
  exponentially on 429 / `"Too many requests"`. The scanner sequences the calls so the
  throttle is global, not per-item (see Gotchas).
- The `scan_runs` row **always closes** — the close (step 10) lives in a `finally`, so a throw
  anywhere still writes `finished_at`, the counts so far, and the error.

## Dependencies
| Depends on | For |
|---|---|
| [`cardtrader/client`](cardtrader-client.md) (planned) | `GET /info`, `marketplace/products`; owns throttle + 429 backoff |
| [`scan/dealEngine`](dealEngine.md) (planned, PRD §7) | filter → sort → median baseline → threshold (pure) |
| [`scan/conditions`](dealEngine.md) (planned) | `CONDITION_RANK` ladder (pure) |
| [`telegram/routing`](telegram.md) (planned, PRD §8) | should-notify decision (pure) |
| [`telegram/notifier`](telegram.md) (planned) | batched `sendMessage` |
| [`db/repo`](repo.md) (planned) | `scan_runs` lifecycle, `deals` upsert/dedupe, watchlist load, inheritance resolution, cache enrichment |
| CardTrader API v2 | `Bearer CARDTRADER_API_TOKEN` (read+write scope; high-sensitivity) |
| Cloudflare D1 (`DB` binding) | the only persistent state |

## Gotchas
- **Throttle is whole-run, not per-item.** The ~1 req/s pace must hold across the entire scan
  — sequencing every `marketplace/products` call through one throttle. Resetting the timer per
  item would burst and trip the 429 backoff. Sets help here: one call per set, not per card.
- **`api_calls` counts every request** including retries/backoff attempts — it is the
  observability signal for rate-limit behavior, so increment it at the client boundary, not
  per logical item.
- **Alert-once on 401.** A wrong/rotated token would 401 every hour; alert on the first and
  suppress repeats, or the owner gets paged every run.
- **The run must close even on throw** — keep the `scan_runs` close in a `finally`. A run that
  never writes `finished_at` looks "stuck" forever in the Health view.
- **`expansion_id` + `language`** — see the [caveat above](#expansion-vs-blueprint-handling);
  fall back to per-blueprint if the batch call ignores the language filter.
- **Inserted-rows = new-deals.** Rely on `ON CONFLICT(product_id) DO NOTHING` returning which
  rows inserted; do not re-query and diff. Only newly-inserted rows are eligible for Telegram,
  which is what keeps dedupe to one push per physical listing (PRD §7/§13).
