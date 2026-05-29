# Deploy Command

Ship the backend Worker and/or cut a desktop release. The two targets deploy **independently**.

## Pre-flight (always)
1. Run `/validate` — typecheck + lint + tests must be green.
2. Confirm you're on the intended branch and changes are committed.

## Backend (Cloudflare Worker)
1. Ensure secrets exist (once per environment, never in source):
   `npx wrangler secret put CARDTRADER_API_TOKEN` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID`.
2. Ensure D1 schema is applied:
   `npx wrangler d1 execute DB --file=src/db/schema.sql` (first time / after migrations).
3. Deploy: `npx wrangler deploy`.
4. Smoke-check: `GET /api/health` returns the latest scan + token-ok; tail logs with
   `npx wrangler tail` if needed.

## Desktop (Tauri)
1. Build the per-OS bundle: `npm run tauri build`.
2. Sign the artifacts and publish to the update channel / release host (e.g. GitHub Releases);
   the updater public key is in `tauri.conf.json`, private signing keys are provided
   out-of-band.

## Hard rules
- **Never** put secrets in `wrangler.toml`, `tauri.conf.json`, source, logs, or git.
- The Worker is **API-only** — never add an `[assets]` block (the dashboard is the Tauri app).
- Never commit code-signing / update private keys.
- No purchase/cart endpoint is ever deployed (PRD non-goal).
- Cron is hourly UTC (`["0 * * * *"]`); don't change it without intent.

See `.claude/skills/cloudflare-workers/SKILL.md` and `tauri-desktop/SKILL.md` for details.
