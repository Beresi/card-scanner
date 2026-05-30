-- Migration 0002 — add currency + deal-floor columns to config
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0002_config_deal_floors.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN will error if the column already exists.
-- This migration is one-shot; do not re-run against a DB that has already been migrated.
-- Safe to skip if you are applying schema.sql from scratch (the columns are already there).

ALTER TABLE config ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE config ADD COLUMN min_price_cents INTEGER NOT NULL DEFAULT 200;
ALTER TABLE config ADD COLUMN min_savings_cents INTEGER NOT NULL DEFAULT 100;
