---
name: error-handling
description: Error-handling patterns for the CardTrader Deal Scanner — external-API resilience (1 req/s throttle, 429 backoff, per-blueprint skip), Hono status codes that hide internals, TanStack Query error UI, Rust Result commands, and secret-safe structured logging. Load when writing the scanner loop, the CardTrader client, a Hono route, a Tauri command, or any code that fetches/catches/logs.
---

# Error Handling

## Purpose
How this project fails safely. The scanner talks to a flaky external API on a 1 req/s leash,
so failure is the expected path, not the exception. The rules: one bad blueprint never sinks
a run; a whole-run failure is recorded in `scan_runs.error` and the row still closes; a token
`401` aborts and alerts **once**; the Hono API returns correct status codes and never leaks
internals or secrets; the React client surfaces failures as visible UI state; the Rust host
returns `Result<T, String>` instead of panicking. Authoritative source: the **Error handling**
and **Logging** sections of the coding standards (linked below); spec is PRD §6/§11/§13.

## Core patterns

### Throttled fetch with exponential backoff on 429 (`cardtrader/client.ts`)
The client owns the global ~1 req/s throttle and the 429 backoff. `api_calls` is incremented
at this boundary (every request, including retries) so the `scan_runs` counter reflects real
rate-limit behavior. Throw a *typed* error carrying context, never a bare string.

```ts
// src/cardtrader/client.ts (planned)
class CardTraderError extends Error {
  constructor(message: string, readonly endpoint: string, readonly status?: number) {
    super(message);
    this.name = 'CardTraderError';
  }
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000; // ~1 req/s baseline pace

async function ctFetch(env: Env, path: string, counter: { apiCalls: number }): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    counter.apiCalls++; // count EVERY request, retries included (observability signal)
    const res = await fetch(`https://api.cardtrader.com/api/v2${path}`, {
      headers: { Authorization: `Bearer ${env.CARDTRADER_API_TOKEN}` },
    });

    // 429 or a "Too many requests" body → exponential backoff, then retry the SAME request.
    const tooMany = res.status === 429 || (await peekTooManyRequests(res));
    if (tooMany && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** attempt; // 1s, 2s, 4s, 8s, 16s
      logger.warn('cardtrader backoff', { endpoint: path, attempt, delayMs: delay });
      await sleep(delay);
      continue;
    }
    if (!res.ok) {
      // Never put the token or raw body in the message — just status + endpoint.
      throw new CardTraderError(`request failed (${res.status})`, path, res.status);
    }
    return res;
  }
  throw new CardTraderError('exhausted retries', path);
}
```

### Per-blueprint try/catch that SKIPS, not throws (`scan/scanner.ts`)
A single failed blueprint fetch is logged and skipped — never fatal to the run (PRD §13).
The 401 on `GET /info` is the *one* exception: it aborts the whole run. And the `scan_runs`
row closes in a `finally` no matter what threw.

```ts
// src/scan/scanner.ts (planned) — abbreviated to the error-handling shape
export async function runScan(env: Env, { trigger }: { trigger: ScanTrigger }): Promise<ScanSummary> {
  const runId = await repo.openScanRun(env, { startedAt: Date.now() });
  const counter = { apiCalls: 0 };
  let runError: string | null = null;
  let dealsFound = 0;

  try {
    // Token check: 401 aborts the run and alerts ONCE (see Gotchas: alert-once).
    try {
      await client.info(env, counter);
    } catch (err) {
      if (err instanceof CardTraderError && err.status === 401) {
        await alertTokenInvalidOnce(env); // suppressed on repeat 401s across runs
        runError = 'cardtrader token invalid (401)';
        return; // finally still closes the row
      }
      throw err; // other /info failures are whole-run failures, handled below
    }

    for (const item of await repo.activeWatchlist(env)) {
      try {
        const products = await client.marketplaceProducts(env, queryFor(item), counter);
        dealsFound += await processBlueprint(env, item, products);
      } catch (err) {
        // ONE bad blueprint must not sink the scan — log with context and move on.
        logger.error('blueprint skipped', {
          watchlistId: item.id,
          endpoint: 'marketplace/products',
          error: err instanceof Error ? err.message : 'unknown',
        });
        continue; // skip, do not rethrow
      }
    }
  } catch (err) {
    // Whole-run failure (outside a per-item boundary) → recorded, run still closes cleanly.
    runError = err instanceof Error ? err.message : 'unknown scan failure';
    logger.error('scan run failed', { runId, error: runError });
  } finally {
    // ALWAYS closes the row — a run with no finished_at looks "stuck" forever in Health.
    await repo.closeScanRun(env, runId, {
      finishedAt: Date.now(),
      apiCalls: counter.apiCalls,
      dealsFound,
      error: runError,
    });
  }

  return { runId, apiCalls: counter.apiCalls, dealsFound, error: runError, /* …counts */ } as ScanSummary;
}
```

### Hono error response that hides internals (`worker/src/api/*.ts`)
Routes are thin controllers: validate input, return the correct status code, and never put
an internal message, stack, or secret in the body. `/api/health` reports token *status*, not
the token.

```ts
// worker/src/index.ts — one app-wide handler keeps every route consistent.
app.onError((err, c) => {
  logger.error('api error', {
    path: c.req.path,
    error: err instanceof Error ? err.message : 'unknown', // logged, NOT returned
  });
  return c.json({ error: 'Internal error' }, 500); // generic — no detail to the client
});

// worker/src/api/deals.ts — validate, map to the right status, never trust the client.
app.get('/api/deals', async (c) => {
  const parsed = dealsQuerySchema.safeParse(c.req.query()); // clamps min_discount, checks enums
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters' }, 400); // no Zod internals leaked
  }
  const deals = await repo.listDeals(c.env, parsed.data);
  return c.json(deals); // snake_case, integer cents
});
```

## Standards
@docs/standards/coding-standards.md

## Examples (Good / Bad)

| Concern | Good | Bad |
|---|---|---|
| One blueprint 500s mid-run | log it with `watchlistId`+endpoint, `continue` the loop | `throw` and kill the whole scan |
| Whole-run throw | record in `scan_runs.error`, close the row in `finally` | let it reject; row never gets `finished_at` |
| Repeated `401` from `/info` | alert once, suppress on later runs | page the owner every hour |
| Hono 500 body | `{ "error": "Internal error" }` | `{ "error": "D1_ERROR: no such column foo" }` |
| Bad query param | `400 { "error": "Invalid query parameters" }` | pass it straight to `repo` / the scanner |
| Logging a failed fetch | `logger.warn('backoff', { endpoint, attempt })` | `logger.info('GET …Bearer eyJ…')` (leaks token) |
| Token status to UI | `/api/health` returns `token_ok: false` | return the token string |
| React query fails | flip the "API 200" strip to an error chip | render an empty list silently |
| Rust command I/O fails | `Err("could not read token store".into())` | `store.get(key).unwrap()` |

### Frontend (React + TanStack Query) — surface, never swallow
Server data comes from the API via TanStack Query. An error must become visible UI state —
the "API 200" status strip flips to an error indicator; never a silent empty list.

```tsx
function DealFeed(): React.ReactElement {
  const { data, isLoading, isError } = useQuery({ queryKey: ['deals'], queryFn: fetchDeals });
  if (isLoading) return <ApiStrip state="loading" />;
  if (isError)   return <ApiStrip state="error" />; // strip flips to error — not <EmptyList/>
  if (data.length === 0) return <EmptyState label="No deals yet" />; // distinct from failure
  return <DealList deals={data} />;
}
```

### Rust host — `Result<T, String>`, no `unwrap()` on fallible I/O
Tauri commands return a `Result`; the host stays thin (open URL, get/set token, secure
storage). Never `unwrap()` on fallible I/O in a command handler.

```rust
#[tauri::command]
fn get_api_token(store: State<TokenStore>) -> Result<String, String> {
    store
        .read()                              // fallible OS-backed secure storage read
        .map_err(|e| format!("token read failed: {e}")) // typed-ish error, no panic
}
```

## Gotchas
- **Alert-once on `401`.** A wrong or rotated token would `401` on `GET /info` every hour;
  alert on the first occurrence and suppress repeats, or the owner gets paged every run
  (scanner doc / PRD §11). Persist the "already alerted" state so it survives across runs.
- **Close `scan_runs` in a `finally` — even on throw.** A run that never writes `finished_at`
  looks "stuck" forever in the Health view. The close writes the counts accrued so far plus
  `error` (NULL on success).
- **One bad blueprint never sinks a run.** Catch at the per-item boundary, log with context
  (which `watchlistId`, which endpoint), `continue`. Whole-run failures are the only thing
  recorded in `scan_runs.error`.
- **Throttle is whole-run, not per-item.** Sequence every `marketplace/products` call through
  one ~1 req/s throttle; resetting the timer per item would burst and trip the 429 backoff.
  `api_calls` counts every request including retries — increment at the client boundary.
- **Never leak secrets in errors or logs.** Not the `CARDTRADER_API_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, or the Cloudflare Access service token — not in a Hono response body, an
  error message, or a log line. `/api/health` reports token *status*, never the token. Rotate
  the CardTrader token if it is ever exposed (it grants write/purchase scope).
- **Never expose internals to clients.** Map errors to a generic message + correct status code
  (`400` invalid input, `401`/`403` auth, `404` not found, `500` internal). Log the real detail
  server-side; return the generic message to the desktop app.
- **Trust nothing on the wire.** Parse CardTrader responses (and client requests) from `unknown`
  into typed shapes at the boundary; a malformed payload is a per-item skip, not a crash.
- **Validate before the repo/scanner.** Coerce/clamp query params (`min_discount`,
  `older_than_days`), check enums (`status`, `priority`, `foil_pref`, `importance`,
  `min_condition`), reject unknown `PATCH` fields. Bad input must not reach D1.

## Related skills
- cardtrader-api — the throttle / 429-backoff source; client error shapes.
- backend-dev — Hono route structure and the app-wide error handler.
- testing — the PRD §16 `401`-abort case and per-blueprint-skip cases.
