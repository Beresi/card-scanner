/**
 * Tests for revalidateBlueprintDeals() — the deal-lifecycle retirement pass
 * (migration 0009). Backed by the in-memory better-sqlite3 D1 façade so the
 * real status-transition SQL is exercised.
 *
 * Transitions covered:
 *  - present + is candidate            → stays 'open'
 *  - present + not the candidate       → 'expired'
 *  - absent from listings              → 'sold'
 *  - no candidate at all               → remaining present open → 'expired'
 *  - empty listings                    → all open → 'sold'
 *  - dismissed rows are never touched
 *  - a candidate previously 'expired'  → reopened to 'open'
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { revalidateBlueprintDeals, getDealById, listDeals } from './repo';
import { makeD1, seedDeal, seedWatchlist } from '../api/__test-helpers__/d1';
import type Database from 'better-sqlite3';

const BP = 50; // blueprint id under test

let db: D1Database;
let raw: Database.Database;
let wid: number;

beforeEach(() => {
  ({ db, raw } = makeD1());
  wid = seedWatchlist(raw, { cardtrader_id: BP, label: 'Test Card' });
});

/** Seed one open deal for blueprint BP at the given product_id/price. */
function seedOpenDeal(productId: number, priceCents: number): void {
  seedDeal(raw, {
    watchlist_id: wid,
    blueprint_id: BP,
    product_id: productId,
    card_name: 'Test Card',
    price_cents: priceCents,
    currency: 'USD',
    baseline_cents: priceCents * 2,
    cohort_size: 10,
    discount_pct: 50,
  });
}

/** Find the deal row id for a given product_id. */
function dealIdFor(productId: number): number {
  const row = raw
    .prepare('SELECT id FROM deals WHERE product_id = ?')
    .get(productId) as { id: number };
  return row.id;
}

describe('revalidateBlueprintDeals — lifecycle transitions', () => {
  it('keeps the current candidate open', async () => {
    seedOpenDeal(111, 180);
    await revalidateBlueprintDeals(db, BP, [111, 222], 111);
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('open');
    expect(deal!.retired_at).toBeNull();
  });

  it("marks a still-listed non-candidate 'expired'", async () => {
    seedOpenDeal(111, 180);
    await revalidateBlueprintDeals(db, BP, [111, 222], 222);
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('expired');
    expect(deal!.retired_at).not.toBeNull();
  });

  it("marks a vanished listing 'sold'", async () => {
    seedOpenDeal(999, 212);
    await revalidateBlueprintDeals(db, BP, [111, 222], 111);
    const deal = await getDealById(db, dealIdFor(999));
    expect(deal!.status).toBe('sold');
    expect(deal!.retired_at).not.toBeNull();
  });

  it("expires remaining open deals when there is no qualifying candidate", async () => {
    seedOpenDeal(111, 180);
    await revalidateBlueprintDeals(db, BP, [111], null);
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('expired');
  });

  it("sells every open deal when the blueprint has zero listings", async () => {
    seedOpenDeal(111, 180);
    seedOpenDeal(222, 190);
    await revalidateBlueprintDeals(db, BP, [], null);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('sold');
    expect((await getDealById(db, dealIdFor(222)))!.status).toBe('sold');
  });

  it('never touches user-dismissed deals', async () => {
    seedDeal(raw, {
      watchlist_id: wid, blueprint_id: BP, product_id: 111, card_name: 'Test Card',
      price_cents: 180, currency: 'USD', baseline_cents: 360, cohort_size: 10,
      discount_pct: 50, dismissed: 1,
    });
    await revalidateBlueprintDeals(db, BP, [], null); // would otherwise mark sold
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.dismissed).toBe(1);
    expect(deal!.status).toBe('open'); // dismissed rows are excluded from retirement
  });

  it('reopens a previously-expired deal that is the candidate again', async () => {
    seedOpenDeal(111, 180);
    raw.prepare("UPDATE deals SET status='expired', retired_at=datetime('now') WHERE product_id=111").run();
    await revalidateBlueprintDeals(db, BP, [111, 222], 111);
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('open');
    expect(deal!.retired_at).toBeNull();
  });

  it('does not reopen a sold deal even if it reappears as candidate', async () => {
    seedOpenDeal(111, 180);
    raw.prepare("UPDATE deals SET status='sold', retired_at=datetime('now') WHERE product_id=111").run();
    await revalidateBlueprintDeals(db, BP, [111], 111);
    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('sold'); // a gone listing stays gone
  });

  it('scopes transitions to the given blueprint only', async () => {
    seedOpenDeal(111, 180);
    seedDeal(raw, {
      watchlist_id: wid, blueprint_id: 99, product_id: 777, card_name: 'Other',
      price_cents: 180, currency: 'USD', baseline_cents: 360, cohort_size: 10, discount_pct: 50,
    });
    await revalidateBlueprintDeals(db, BP, [], null); // empty listings for BP only
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('sold');
    expect((await getDealById(db, dealIdFor(777)))!.status).toBe('open'); // untouched
  });

  it('handles a present-listing set larger than D1’s bound-variable cap', async () => {
    // A popular card can have hundreds of live listings. The present-id set is
    // bound as a single JSON array (json_each) rather than one variable per id,
    // so a large set must NOT throw "too many SQL variables" (the prod bug this
    // guards against fired on the NOT IN (?, ?, …) form at ~100 ids).
    const present = Array.from({ length: 250 }, (_, i) => 1000 + i); // 250 ids
    seedOpenDeal(1000, 180);   // present AND the candidate → stays open
    seedOpenDeal(1500, 190);   // absent from the 250-id set    → sold

    await expect(
      revalidateBlueprintDeals(db, BP, present, 1000),
    ).resolves.toBeUndefined();

    expect((await getDealById(db, dealIdFor(1000)))!.status).toBe('open');
    expect((await getDealById(db, dealIdFor(1500)))!.status).toBe('sold');
  });
});

// ---------------------------------------------------------------------------
// listDeals open-feed grace window (migration 0009 + expired grace)
//
// Expired deals linger in the default 'open' feed for EXPIRED_GRACE_HOURS (12h)
// after retired_at, then auto-hide. Sold deals never get the grace window.
// ---------------------------------------------------------------------------

describe('listDeals — expired grace window', () => {
  /** Mark a seeded deal's lifecycle directly (status + relative retired_at). */
  function setLifecycle(productId: number, status: string, retiredMod: string): void {
    raw.prepare(
      `UPDATE deals SET status=?, retired_at=datetime('now', ?) WHERE product_id=?`,
    ).run(status, retiredMod, productId);
  }

  it('shows an expired deal retired just now in the open feed', async () => {
    seedOpenDeal(111, 180);
    setLifecycle(111, 'expired', '-1 hours');
    const open = await listDeals(db, { status: 'open' });
    expect(open.map((d) => d.product_id)).toContain(111);
  });

  it('hides an expired deal retired more than 12h ago from the open feed', async () => {
    seedOpenDeal(111, 180);
    setLifecycle(111, 'expired', '-13 hours');
    const open = await listDeals(db, { status: 'open' });
    expect(open.map((d) => d.product_id)).not.toContain(111);
    // …but it is still visible under 'all'.
    const all = await listDeals(db, { status: 'all' });
    expect(all.map((d) => d.product_id)).toContain(111);
  });

  it('hides a sold deal from the open feed immediately (no grace)', async () => {
    seedOpenDeal(111, 180);
    setLifecycle(111, 'sold', '-1 minutes');
    const open = await listDeals(db, { status: 'open' });
    expect(open.map((d) => d.product_id)).not.toContain(111);
    const all = await listDeals(db, { status: 'all' });
    expect(all.map((d) => d.product_id)).toContain(111);
  });

  it('keeps active (open) deals in the feed regardless of the window', async () => {
    seedOpenDeal(222, 190);
    const open = await listDeals(db, { status: 'open' });
    expect(open.map((d) => d.product_id)).toContain(222);
  });

  it('still hides a dismissed deal even within the grace window', async () => {
    seedOpenDeal(111, 180);
    setLifecycle(111, 'expired', '-1 hours');
    raw.prepare(`UPDATE deals SET dismissed=1 WHERE product_id=111`).run();
    const open = await listDeals(db, { status: 'open' });
    expect(open.map((d) => d.product_id)).not.toContain(111);
  });
});
