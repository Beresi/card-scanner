-- Migration 0007 — one-time vocabulary fix: canonicalise min_condition values.
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0007_canonicalize_conditions.sql
--
-- Background: the desktop UI was previously storing TCGplayer 5-grade codes
-- ('NM', 'LP', 'MP', 'HP', 'D') in the min_condition columns, but the deal
-- engine's condition ladder (conditions.ts) uses CardTrader's 7-grade names
-- ('Mint', 'Near Mint', 'Slightly Played', 'Moderately Played', 'Played',
-- 'Heavily Played', 'Poor').  Any stored legacy code caused conditionRank()
-- to throw "Unknown condition: LP", silently aborting blueprint evaluation.
--
-- This migration maps every legacy code to its canonical name in-place:
--   'NM' → 'Near Mint'
--   'LP' → 'Slightly Played'
--   'MP' → 'Moderately Played'
--   'HP' → 'Heavily Played'
--   'D'  → 'Poor'
-- Values already a canonical name (or NULL) are left untouched.
--
-- This migration is one-shot; safe to skip on a DB built from schema.sql from
-- scratch (the schema already uses 'Near Mint' as the default).

-- ─── config: canonicalise default_min_condition ───────────────────────────────
UPDATE config
SET default_min_condition = CASE default_min_condition
    WHEN 'NM' THEN 'Near Mint'
    WHEN 'LP' THEN 'Slightly Played'
    WHEN 'MP' THEN 'Moderately Played'
    WHEN 'HP' THEN 'Heavily Played'
    WHEN 'D'  THEN 'Poor'
    ELSE default_min_condition  -- already canonical or NULL handled by NOT NULL constraint
  END
WHERE id = 1;

-- ─── watchlist: canonicalise per-ticket min_condition overrides ───────────────
-- NULL rows are intentionally skipped (they inherit from config; there is
-- nothing to convert, and touching them would turn NULL into an explicit value).
UPDATE watchlist
SET min_condition = CASE min_condition
    WHEN 'NM' THEN 'Near Mint'
    WHEN 'LP' THEN 'Slightly Played'
    WHEN 'MP' THEN 'Moderately Played'
    WHEN 'HP' THEN 'Heavily Played'
    WHEN 'D'  THEN 'Poor'
    ELSE min_condition  -- already canonical
  END
WHERE min_condition IS NOT NULL;
