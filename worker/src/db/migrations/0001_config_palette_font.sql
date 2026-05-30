-- Migration 0001 — add theme_palette + font columns to config
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0001_config_palette_font.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN will error if the column already exists.
-- This migration is one-shot; do not re-run against a DB that has already been migrated.
-- Safe to skip if you are applying schema.sql from scratch (the columns are already there).

ALTER TABLE config ADD COLUMN theme_palette TEXT NOT NULL DEFAULT 'cyan';
ALTER TABLE config ADD COLUMN font TEXT NOT NULL DEFAULT 'chakra';
