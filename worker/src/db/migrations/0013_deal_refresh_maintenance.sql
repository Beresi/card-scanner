-- Migration 0013 — daily deal refresh + false-positive removal + cleanup.
--
-- Problem: a deal row's economics (discount_pct, baseline_cents, …) were frozen
-- at insert (upsertDeal is ON CONFLICT DO NOTHING). When a blueprint is re-scanned
-- and the whole cohort has since dropped, the stored discount is stale — the feed
-- shows "50% off" when the live discount is ~0%. And nothing ever prunes: expired/
-- sold rows accumulate forever (deal_retention_days was a dead setting).
--
-- Fix, three columns:
--  1. deals.revalidated_at — stamped every time we re-price a still-open deal
--     (repo.refreshDealEconomics). Backfilled to found_at for existing rows.
--     Drives auto-expiry of deals we haven't re-confirmed within a window.
--  2. config.deal_staleness_hours — open deals whose revalidated_at is older than
--     this are auto-expired by the daily maintenance job (0 = disabled).
--  3. config.last_maintenance_at — gate so maintenance (expire-stale + prune-
--     archived) runs at most once per ~24h across the 1-minute heartbeat cron.

ALTER TABLE deals ADD COLUMN revalidated_at TEXT;
UPDATE deals SET revalidated_at = found_at WHERE revalidated_at IS NULL;

ALTER TABLE config ADD COLUMN deal_staleness_hours INTEGER NOT NULL DEFAULT 24;  -- 0 = disabled
ALTER TABLE config ADD COLUMN last_maintenance_at TEXT;                          -- NULL = never run
