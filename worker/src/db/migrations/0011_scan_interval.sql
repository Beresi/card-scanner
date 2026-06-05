-- Migration 0011 — configurable scan interval (heartbeat gate).
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0011_scan_interval.sql
--
-- Instead of hard-coding the scan cadence in wrangler.toml's cron schedule,
-- the Worker now runs a 1-minute heartbeat cron and checks this column to
-- decide whether enough time has passed since the last run. Changing the
-- cadence is now pure config — no redeploy required.
--
-- Default: 60 minutes (one scan per hour, matching the old hardcoded cron).
-- Valid range: 1–1440 (1 minute to 1 day); enforced by the API PATCH route.
--
-- Idempotent intent: safe to skip on a DB freshly built from schema.sql.

ALTER TABLE config ADD COLUMN scan_interval_minutes INTEGER NOT NULL DEFAULT 60;
