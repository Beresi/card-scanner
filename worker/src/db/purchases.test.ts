/**
 * Tests for the purchase ledger (migration 0012):
 *   - markDealBought()     — records a purchase + retires the deal, atomically.
 *   - getPurchaseSummary() — cumulative savings aggregate + newest-first list.
 *
 * Backed by the in-memory better-sqlite3 D1 façade so the real INSERT/UPDATE
 * SQL (and the standalone, FK-free purchases table) is exercised.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { markDealBought, getPurchaseSummary, getDealById } from './repo';
import { makeD1, seedDeal, seedWatchlist } from '../api/__test-helpers__/d1';
import type Database from 'better-sqlite3';

const BP = 50;

let db: D1Database;
let raw: Database.Database;
let wid: number;

beforeEach(() => {
  ({ db, raw } = makeD1());
  wid = seedWatchlist(raw, { cardtrader_id: BP, label: 'Test Card' });
});

/** Seed one open deal; baseline defaults to 2× price. Returns its deal id. */
function seedOpenDeal(productId: number, priceCents: number, baselineCents = priceCents * 2): number {
  seedDeal(raw, {
    watchlist_id: wid,
    blueprint_id: BP,
    product_id: productId,
    card_name: 'Test Card',
    price_cents: priceCents,
    currency: 'USD',
    baseline_cents: baselineCents,
    cohort_size: 10,
    discount_pct: 50,
  });
  const row = raw.prepare('SELECT id FROM deals WHERE product_id = ?').get(productId) as { id: number };
  return row.id;
}

function purchaseCount(): number {
  return (raw.prepare('SELECT COUNT(*) AS n FROM purchases').get() as { n: number }).n;
}

describe('markDealBought', () => {
  it('records one purchase and retires the deal (status=bought, dismissed=1)', async () => {
    const id = seedOpenDeal(111, 1000); // baseline 2000

    const updated = await markDealBought(db, id);

    expect(updated!.status).toBe('bought');
    expect(updated!.dismissed).toBe(1);
    expect(updated!.retired_at).not.toBeNull();

    expect(purchaseCount()).toBe(1);
    const p = raw.prepare('SELECT * FROM purchases WHERE product_id = 111').get() as {
      paid_cents: number; saved_cents: number; card_name: string; currency: string;
    };
    expect(p.paid_cents).toBe(1000);
    // No second_cheapest → savings vs the median baseline: 2000 − 1000 = 1000.
    expect(p.saved_cents).toBe(1000);
    expect(p.card_name).toBe('Test Card');
    expect(p.currency).toBe('USD');
  });

  it('snapshots saved_cents against second_cheapest_cents when present', async () => {
    const id = seedOpenDeal(222, 1000, 5000); // median baseline 5000
    // Gap-gate baseline: the next-cheapest copy is 1500 → savings should be 500.
    raw.prepare('UPDATE deals SET second_cheapest_cents = 1500 WHERE id = ?').run(id);

    await markDealBought(db, id);

    const p = raw.prepare('SELECT saved_cents FROM purchases WHERE product_id = 222').get() as { saved_cents: number };
    expect(p.saved_cents).toBe(500); // 1500 − 1000, NOT 5000 − 1000
  });

  it('is idempotent — a second call does not double-record', async () => {
    const id = seedOpenDeal(333, 1000);

    await markDealBought(db, id);
    const second = await markDealBought(db, id);

    expect(purchaseCount()).toBe(1);
    expect(second!.status).toBe('bought');
  });

  it('returns null for an unknown deal id', async () => {
    expect(await markDealBought(db, 99999)).toBeNull();
    expect(purchaseCount()).toBe(0);
  });

  it('survives the watchlist cascade — the ledger row outlives the deal', async () => {
    const id = seedOpenDeal(444, 800);
    await markDealBought(db, id);

    // Simulate deleteWatchlist's cascade (deletes the deal row).
    raw.prepare('DELETE FROM deals WHERE watchlist_id = ?').run(wid);

    expect(await getDealById(db, id)).toBeNull(); // deal gone
    expect(purchaseCount()).toBe(1);              // ledger intact
  });
});

describe('getPurchaseSummary', () => {
  it('returns zeros for an empty ledger', async () => {
    const s = await getPurchaseSummary(db);
    expect(s).toEqual({
      total_saved_cents: 0,
      total_paid_cents: 0,
      count: 0,
      currency: 'USD',
      items: [],
    });
  });

  it('aggregates totals and lists purchases newest-first', async () => {
    const a = seedOpenDeal(111, 1000); // saved 1000, paid 1000
    const b = seedOpenDeal(222, 400, 1000); // saved 600, paid 400
    await markDealBought(db, a);
    await markDealBought(db, b);
    // Force a deterministic ordering: make 222 the newer purchase.
    raw.prepare("UPDATE purchases SET bought_at='2026-01-01 00:00:00' WHERE product_id=111").run();
    raw.prepare("UPDATE purchases SET bought_at='2026-01-02 00:00:00' WHERE product_id=222").run();

    const s = await getPurchaseSummary(db);

    expect(s.count).toBe(2);
    expect(s.total_saved_cents).toBe(1600); // 1000 + 600
    expect(s.total_paid_cents).toBe(1400);  // 1000 + 400
    expect(s.items.map((i) => i.product_id)).toEqual([222, 111]); // newest first
  });
});
