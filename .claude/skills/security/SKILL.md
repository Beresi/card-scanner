---
name: security
description: Secrets, auth, and input-validation rules for the CardTrader Deal Scanner — Wrangler secrets (CARDTRADER_API_TOKEN, TELEGRAM_*), the high-sensitivity write/purchase-scoped CardTrader token, Hono route auth, no-public-D1 access, and on-device token storage in the Tauri host. Load before reading a secret from env, adding/changing a Hono route's auth, storing the desktop auth token, validating request input, or anytime you touch wrangler secrets / Cloudflare Access / .dev.vars / tauri.conf.json.
---

# Security

## Purpose
This is a single-user tool with one high-value secret: the **CardTrader API token has
read + WRITE/purchase scope** (PRD §12, §2). Nothing here calls a purchase endpoint, but a
leaked token could drain the account, so treat every secret as high-sensitivity. Two trust
zones: the **Worker backend** (holds the CardTrader/Telegram secrets, talks to CardTrader)
and the **Tauri desktop app** (holds one credential to reach the API). Secrets live in
Wrangler / OS secure storage only — never in source, D1, logs, the bundle, or git.

## Core patterns

### 1. Read a Wrangler secret from `env` in a Worker (never `process.env`)
Secrets are bound on `env` at request/cron time; they are not module-scope constants and
must not be logged. Validate input before doing anything else.

```ts
import { Hono } from 'hono';

type Env = {
  DB: D1Database;
  CARDTRADER_API_TOKEN: string;   // Wrangler secret — write/purchase scope
  TELEGRAM_BOT_TOKEN: string;     // Wrangler secret
  TELEGRAM_CHAT_ID: string;       // Wrangler secret
  API_AUTH_TOKEN: string;         // Wrangler secret — shared bearer the desktop app sends
};

const app = new Hono<{ Bindings: Env }>();

async function fetchInfo(env: Env) {
  const res = await fetch('https://api.cardtrader.com/api/v2/info', {
    headers: { Authorization: `Bearer ${env.CARDTRADER_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`cardtrader info failed: ${res.status}`); // status, never the token
  return res.json();
}
```

Set each secret out-of-band (never commit it):
```sh
wrangler secret put CARDTRADER_API_TOKEN   # then TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, API_AUTH_TOKEN
```
Local dev reads `.dev.vars` (KEY=value lines) — that file is **git-ignored**, alongside `.env*`.

### 2. Auth gate on every Hono route (no public D1 access)
The desktop client sends a shared bearer (or Cloudflare Access service-token headers). Every
route that reads/writes D1 sits behind the gate. Use a constant-time compare; return a bare
401 with no detail.

```ts
import { bearerAuth } from 'hono/bearer-auth';

// /api/health may stay open; everything that touches D1 is gated.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  return bearerAuth({ token: c.env.API_AUTH_TOKEN })(c, next);
});

app.get('/api/deals', async (c) => {            // only runs past the gate
  const rows = await c.env.DB.prepare('SELECT * FROM deals ORDER BY found_at DESC LIMIT 100').all();
  return c.json(rows.results);
});
```

### 3. Store the desktop credential in OS-backed secure storage (Tauri Rust host)
The API base URL may live in config; the **auth token never does**. Persist it via
`stronghold` / `keyring` (encrypted, OS-backed), exposed through thin commands.

```rust
#[tauri::command]
fn set_api_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    keyring::Entry::new("card-broker", "api_token")
        .and_then(|e| e.set_password(&token))
        .map_err(|e| e.to_string())            // surface the failure kind, not the token
}

#[tauri::command]
fn get_api_token() -> Result<String, String> {
    keyring::Entry::new("card-broker", "api_token")
        .and_then(|e| e.get_password())
        .map_err(|e| e.to_string())
}
```

## Standards
@docs/standards/shared-standards.md
@docs/standards/coding-standards.md

## Examples (Good / Bad)

### Good — token from `env`, request validated, generic failure
```ts
app.post('/api/scan/run-now', async (c) => {
  const token = c.env.CARDTRADER_API_TOKEN;          // from env, never logged
  try {
    await runScan(c.env, token);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'scan failed' }, 500);    // no internals, no secret, no stack
  }
});
```

### Bad — hardcoded / logged secret
```ts
const TOKEN = 'ct_live_9f3a...';                      // ✗ secret in source & bundle & git
console.log('using cardtrader token', c.env.CARDTRADER_API_TOKEN); // ✗ secret in logs
return c.json({ detail: err.message, token: TOKEN }, 500);         // ✗ leaks internals + secret
```

### Bad — unauthenticated D1 route
```ts
app.get('/api/watchlist', async (c) =>               // ✗ no auth gate → public DB read
  c.json((await c.env.DB.prepare('SELECT * FROM watchlist').all()).results));
```

### Bad — desktop secret in committed config / JS
```jsonc
// tauri.conf.json  — ✗ plaintext credential ships in every installer
{ "app": { "apiToken": "bearer-abc123" } }
```
```ts
const API_AUTH = 'bearer-abc123';                     // ✗ secret baked into the JS bundle
```

## Gotchas
- **CardTrader token = write/purchase scope.** Highest-sensitivity secret in the project.
  If it ever appears in a log, a commit, a response, or the bundle, **rotate it immediately**
  (regenerate on CardTrader + `wrangler secret put` the new value). PRD §12.
- **Never implement a purchase/cart endpoint — ever.** Auto-buy is an explicit non-goal (PRD
  §2). The app only reads marketplace data and links out; the human buys manually.
- **Never log secrets.** Not the CardTrader token, Telegram bot token, chat id, or API auth
  token. Log endpoint + HTTP status, never `Authorization` headers or `env` values.
- **No public D1 routes.** Every route that reads/writes `DB` is behind the bearer / Access
  gate. Only `/api/health` may be open. PRD §12.
- **`env`, not `process.env`.** Workers inject secrets on the `env` binding per invocation —
  there is no Node `process.env`. Reading from module scope at import time fails.
- **`.dev.vars` and `.env*` are git-ignored.** Verify a secret never enters a tracked file
  before committing. Secrets live in Wrangler (backend) and OS secure storage (desktop) only.
- **No plaintext token in `tauri.conf.json` or the JS bundle.** The desktop credential goes
  in stronghold/keyring via a Rust command; the API *base URL* in config is fine.
- **Generic error responses.** Catch internal errors and return a short, fixed message + the
  right status. Never echo `err.message`, stack traces, SQL, or upstream bodies to the client.
- **Validate/parse all input** at the route boundary before it reaches D1 or CardTrader —
  don't trust the wire (coding-standards: `unknown` + narrowing).

## Related skills
- backend-dev — Hono route auth and the gated `/api/*` surface
- tauri-desktop — secure on-device storage of the API credential
- error-handling — return generic errors; don't leak internals or secrets
