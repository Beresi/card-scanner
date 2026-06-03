-- Migration 0008 — rename threshold_pct → discount semantics.
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0008_rename_threshold_to_discount.sql
--
-- Background: the old `threshold_pct` columns used a backwards/confusing scale
-- where the value represented "candidate must be ≤ X% of the cohort median"
-- (e.g. 50 meant "at or below half price", but 10 meant "90% off").
--
-- The new `min_discount_pct` / `default_discount_pct` columns use the intuitive
-- "flag when the cheapest copy is at least X% BELOW the median" meaning:
--   30 → "30% or more off"   (more lenient)
--   60 → "60% or more off"   (stricter)
--
-- These are complements: new = 100 − old.
-- The value transform preserves existing behaviour for all live DB rows:
--   old threshold_pct = 50  → new min_discount_pct = 50   (unchanged; 50 = 100−50)
--   old threshold_pct = 10  → new min_discount_pct = 90   (was "90% off" on old scale)
--   old threshold_pct = 0   → new min_discount_pct = 100  (was "any price qualifies")
--
-- NULL rows are left NULL (they inherit from config at scan time; the update
-- only transforms non-NULL per-ticket overrides).

-- ─── config: rename default_threshold_pct → default_discount_pct ─────────────
ALTER TABLE config RENAME COLUMN default_threshold_pct TO default_discount_pct;
UPDATE config SET default_discount_pct = 100 - default_discount_pct;

-- ─── watchlist: rename threshold_pct → min_discount_pct ──────────────────────
-- NULL rows are intentionally skipped (they inherit from config; touching them
-- would turn NULL into an explicit value, changing the inheritance behaviour).
ALTER TABLE watchlist RENAME COLUMN threshold_pct TO min_discount_pct;
UPDATE watchlist SET min_discount_pct = 100 - min_discount_pct WHERE min_discount_pct IS NOT NULL;
