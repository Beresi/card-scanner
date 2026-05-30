-- Migration 0003 — add scan_mode, scan_batch_size to config; add last_scanned_at to blueprints
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0003_scan_modes.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN will error if the column already exists.
-- This migration is one-shot; do not re-run against a DB that has already been migrated.
-- Safe to skip if you are applying schema.sql from scratch (the columns are already there).
--
-- scan_mode: 'chunked' (default, free-tier safe) scans a rotating batch of individual
--   blueprint cards per cron tick; 'wholeset' does one big expansion call per item (paid).
-- scan_batch_size: max per-card marketplace fetches per chunked run (default 40, fits
--   inside the Cloudflare free-tier 50-subrequest cap with headroom for /info + exports).
-- last_scanned_at: rotation cursor for the chunked mode; NULL = never scanned, sorted first.

ALTER TABLE config ADD COLUMN scan_mode TEXT NOT NULL DEFAULT 'chunked';
ALTER TABLE config ADD COLUMN scan_batch_size INTEGER NOT NULL DEFAULT 40;

ALTER TABLE blueprints ADD COLUMN last_scanned_at TEXT;

-- Index to support the rotation query: ORDER BY last_scanned_at ASC NULLS FIRST, id ASC
-- SQLite sorts NULLs last by default on ASC; the query works around this with
-- ORDER BY (last_scanned_at IS NULL) DESC, last_scanned_at ASC, id ASC
-- but an index on (expansion_id, last_scanned_at) still speeds up the WHERE IN + ORDER BY.
CREATE INDEX IF NOT EXISTS idx_blueprints_exp_scanned ON blueprints(expansion_id, last_scanned_at);
