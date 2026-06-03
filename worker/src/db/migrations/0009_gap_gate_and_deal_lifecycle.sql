-- Migration 0009 — gap-to-next-cheapest gate + deal lifecycle (sold/expired).
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0009_gap_gate_and_deal_lifecycle.sql
--
-- Two features land together:
--
-- 1. Gap-to-next gate (Problem B — median over-flags the cheapest copy).
--    The median baseline sits ~40% above the cheapest copy on any upward-sloping
--    ladder, so the cheapest listing almost always looked like a 30% "deal" even
--    when the next copy was pennies more. A new §9a-inheritable gate requires the
--    candidate to be at least default_min_gap_pct% below the 2nd-cheapest QUALIFYING
--    copy (the price you'd actually pay if you missed this one).
--      config.default_min_gap_pct  — inheritable default (NOT NULL, %).
--      watchlist.min_gap_pct       — nullable §9a override (NULL → inherit).
--
-- 2. Deal lifecycle (Problem A — sold/stale deals lingered forever).
--    Deals were append-only: ON CONFLICT(product_id) DO NOTHING never cleared a
--    row whose listing had sold or stopped qualifying. The scan now re-validates
--    each scanned blueprint and retires open deals that aren't the current
--    candidate:
--      deals.status  — 'open' | 'sold' | 'expired'  (NOT NULL DEFAULT 'open').
--        'sold'    = the listing's product_id is gone from the marketplace.
--        'expired' = still listed but no longer the qualifying candidate.
--      deals.retired_at           — UTC timestamp when status left 'open'.
--      deals.second_cheapest_cents — the 2nd-cheapest qualifying copy at scan time
--                                    (the gap-gate baseline; NULL on legacy rows).
--      deals.gap_pct               — % the candidate was below second_cheapest_cents
--                                    (informational; NULL on legacy rows).
--
-- Idempotent intent: safe to skip on a DB freshly built from schema.sql (which
-- already declares every column below). SQLite ALTER TABLE ADD COLUMN is the only
-- portable way to extend an existing table.

-- ─── config: inheritable gap default ─────────────────────────────────────────
ALTER TABLE config ADD COLUMN default_min_gap_pct INTEGER NOT NULL DEFAULT 15;

-- ─── watchlist: §9a nullable gap override ─────────────────────────────────────
ALTER TABLE watchlist ADD COLUMN min_gap_pct INTEGER;

-- ─── deals: gap baseline + lifecycle columns ─────────────────────────────────
ALTER TABLE deals ADD COLUMN second_cheapest_cents INTEGER;
ALTER TABLE deals ADD COLUMN gap_pct INTEGER;
ALTER TABLE deals ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE deals ADD COLUMN retired_at TEXT;

-- Open-feed index now keys on status as well (listDeals 'open' = status='open' AND dismissed=0).
CREATE INDEX IF NOT EXISTS idx_deals_status_open ON deals(status, dismissed, found_at DESC);
