-- Migration 0004 — add scan_cycle_started_at to config
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0004_scan_cycle.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN will error if the column already exists.
-- This migration is one-shot; do not re-run against a DB that has already been migrated.
-- Safe to skip if you are applying schema.sql from scratch (the column is already there).
--
-- scan_cycle_started_at: runtime state — the UTC timestamp of when the current chunked
--   sweep began. A sweep = one full pass through all watched expansion blueprints.
--   NULL means no cycle has started yet. The scanner resets this whenever all blueprints
--   have been scanned (scanned_this_cycle >= total) or when no cycle exists.

ALTER TABLE config ADD COLUMN scan_cycle_started_at TEXT;
