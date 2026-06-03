-- Migration 0010 — store the next-4-cheapest average baseline on each deal.
-- Apply with: npx wrangler d1 execute DB --file=src/db/migrations/0010_deal_avg4_baseline.sql
--
-- The deal card now leads with the gap to the NEXT-cheapest copy (the price you'd
-- actually pay next) and shows a secondary "vs avg" line built from the mean of
-- the next-4-cheapest qualifying copies (2nd–5th). The cohort prices aren't kept
-- on the row, so we persist that average at scan time.
--
--   deals.avg4_cents — mean (integer cents) of the next-4-cheapest copies;
--                      NULL on legacy rows (the card hides the avg line then),
--                      = candidate price in price mode (self-baseline).
--
-- Idempotent intent: safe to skip on a DB freshly built from schema.sql.

ALTER TABLE deals ADD COLUMN avg4_cents INTEGER;
