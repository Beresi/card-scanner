/**
 * Tests for the migration 0013 deal-refresh + maintenance repo functions:
 *   - refreshDealEconomics   — rewrites a still-open deal's live numbers on re-scan.
 *   - expireStaleOpenDeals   — daily auto-expiry of deals not re-confirmed in a window.
 *   - pruneArchivedDeals     — daily prune of archived clutter older than N days.
 *   - deleteArchivedDeals    — manual "Clear archive" (all archived, any age).
 *   - setLastMaintenanceAt   — stamps the daily gate timestamp.
 *
 * Backed by the in-memory better-sqlite3 D1 façade so the real SQL runs against
 * the production schema (which now carries revalidated_at + the config columns).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  refreshDealEconomics,
  expireStaleOpenDeals,
  pruneArchivedDeals,
  deleteArchivedDeals,
  setLastMaintenanceAt,
  getDealById,
  getConfig,
} from './repo';
import { makeD1, seedDeal, seedWatchlist } from '../api/__test-helpers__/d1';
import type { DealInsert } from './types';
import type Database from 'better-sqlite3';

const BP = 70; // blueprint id under test

let db: D1Database;
let raw: Database.Database;
let wid: number;

beforeEach(() => {
  ({ db, raw } = makeD1());
  wid = seedWatchlist(raw, { cardtrader_id: BP, label: 'Test Card' });
});

/** Find the deal row id for a given product_id. */
function dealIdFor(productId: number): number {
  const row = raw.prepare('SELECT id FROM deals WHERE product_id = ?').get(productId) as {
    id: number;
  };
  return row.id;
}

/** Read a single column off a deal row by product_id. */
function col<T = unknown>(productId: number, column: string): T {
  const row = raw
    .prepare(`SELECT ${column} AS v FROM deals WHERE product_id = ?`)
    .get(productId) as { v: T };
  return row.v;
}

/** Seed one open deal for BP; revalidated_at is set to found_at by the schema-less seeder → NULL. */
function seedOpenDeal(productId: number, priceCents: number, discountPct = 50): void {
  seedDeal(raw, {
    watchlist_id: wid,
    blueprint_id: BP,
    product_id: productId,
    card_name: 'Test Card',
    price_cents: priceCents,
    currency: 'USD',
    baseline_cents: priceCents * 2,
    cohort_size: 10,
    discount_pct: discountPct,
  });
}

/** A fresh DealInsert carrying live (post-drop) numbers for product_id. */
function freshDeal(productId: number, overrides: Partial<DealInsert> = {}): DealInsert {
  return {
    watchlist_id: wid,
    blueprint_id: BP,
    product_id: productId,
    card_name: 'Test Card',
    expansion_name: null,
    seller_username: null,
    seller_country: null,
    condition: 'Near Mint',
    language: 'en',
    foil: null,
    can_sell_via_hub: null,
    quantity: 3,
    price_cents: 190,
    currency: 'USD',
    baseline_cents: 200, // cohort dropped — discount now tiny
    second_cheapest_cents: 195,
    gap_pct: 3,
    avg4_cents: 198,
    cohort_size: 8,
    discount_pct: 5, // the honest, collapsed discount
    priority: 'normal',
    buy_url: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// refreshDealEconomics
// ---------------------------------------------------------------------------

describe('refreshDealEconomics — live re-pricing of open deals', () => {
  it('rewrites the stored economics + stamps revalidated_at on an open row', async () => {
    seedOpenDeal(111, 100, 50); // originally "50% off"
    expect(col<string | null>(111, 'revalidated_at')).toBeNull();

    const changed = await refreshDealEconomics(db, freshDeal(111));
    expect(changed).toBe(true);

    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.discount_pct).toBe(5); // no longer the stale 50
    expect(deal!.baseline_cents).toBe(200);
    expect(deal!.second_cheapest_cents).toBe(195);
    expect(deal!.gap_pct).toBe(3);
    expect(deal!.price_cents).toBe(190);
    expect(deal!.quantity).toBe(3);
    expect(deal!.revalidated_at).not.toBeNull();
  });

  it('does NOT rewrite found_at (age/retention stays stable)', async () => {
    seedDeal(raw, {
      watchlist_id: wid,
      blueprint_id: BP,
      product_id: 111,
      card_name: 'Test Card',
      price_cents: 100,
      currency: 'USD',
      baseline_cents: 200,
      cohort_size: 10,
      discount_pct: 50,
      found_at: '2026-01-01 00:00:00',
    });

    await refreshDealEconomics(db, freshDeal(111));
    expect(col<string>(111, 'found_at')).toBe('2026-01-01 00:00:00');
  });

  it('is a no-op on a non-open (expired) row — never rewrites archived numbers', async () => {
    seedOpenDeal(111, 100, 50);
    raw.exec(`UPDATE deals SET status='expired', retired_at=datetime('now') WHERE product_id=111`);

    const changed = await refreshDealEconomics(db, freshDeal(111));
    expect(changed).toBe(false);

    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.discount_pct).toBe(50); // untouched
    expect(deal!.baseline_cents).toBe(200); // seeded value, not the fresh 200-vs-100 rewrite
  });

  it('still refreshes a dismissed-but-open row (WHERE gates on status only, not dismissed)', async () => {
    // dismissed=1 but status stays 'open' — refresh still applies (dismissed is a
    // separate user flag; the WHERE clause only gates on status).
    seedOpenDeal(111, 100, 50);
    raw.exec(`UPDATE deals SET dismissed=1 WHERE product_id=111`);

    const changed = await refreshDealEconomics(db, freshDeal(111));
    expect(changed).toBe(true);
    expect((await getDealById(db, dealIdFor(111)))!.discount_pct).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// expireStaleOpenDeals
// ---------------------------------------------------------------------------

describe('expireStaleOpenDeals — auto-expire un-reconfirmed open deals', () => {
  it('expires an open deal whose revalidated_at is older than the window', async () => {
    seedOpenDeal(111, 100);
    raw.exec(`UPDATE deals SET revalidated_at=datetime('now','-30 hours') WHERE product_id=111`);

    const count = await expireStaleOpenDeals(db, 24);
    expect(count).toBe(1);

    const deal = await getDealById(db, dealIdFor(111));
    expect(deal!.status).toBe('expired');
    expect(deal!.retired_at).not.toBeNull();
  });

  it('expires a row with a NULL revalidated_at (pre-0013, never re-scanned)', async () => {
    seedOpenDeal(111, 100); // revalidated_at NULL
    const count = await expireStaleOpenDeals(db, 24);
    expect(count).toBe(1);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('expired');
  });

  it('leaves a freshly-reconfirmed open deal alone', async () => {
    seedOpenDeal(111, 100);
    raw.exec(`UPDATE deals SET revalidated_at=datetime('now','-1 hours') WHERE product_id=111`);

    const count = await expireStaleOpenDeals(db, 24);
    expect(count).toBe(0);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('open');
  });

  it('never touches dismissed rows', async () => {
    seedOpenDeal(111, 100);
    raw.exec(
      `UPDATE deals SET revalidated_at=datetime('now','-30 hours'), dismissed=1 WHERE product_id=111`,
    );

    const count = await expireStaleOpenDeals(db, 24);
    expect(count).toBe(0);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('open');
  });

  it('never touches already-retired (sold) rows', async () => {
    seedOpenDeal(111, 100);
    raw.exec(
      `UPDATE deals SET status='sold', retired_at=datetime('now'), revalidated_at=datetime('now','-30 hours') WHERE product_id=111`,
    );

    const count = await expireStaleOpenDeals(db, 24);
    expect(count).toBe(0);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('sold');
  });

  it('is disabled at 0 (feature off) — expires nothing', async () => {
    seedOpenDeal(111, 100); // NULL revalidated_at
    const count = await expireStaleOpenDeals(db, 0);
    expect(count).toBe(0);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// pruneArchivedDeals
// ---------------------------------------------------------------------------

describe('pruneArchivedDeals — daily prune of archived clutter', () => {
  it('deletes an expired row older than the retention window', async () => {
    seedOpenDeal(111, 100);
    raw.exec(
      `UPDATE deals SET status='expired', retired_at=datetime('now','-40 days') WHERE product_id=111`,
    );

    const deleted = await pruneArchivedDeals(db, 30);
    expect(deleted).toBe(1);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM deals').get()).toEqual({ n: 0 });
  });

  it('keeps an expired row still inside the retention window', async () => {
    seedOpenDeal(111, 100);
    raw.exec(
      `UPDATE deals SET status='expired', retired_at=datetime('now','-10 days') WHERE product_id=111`,
    );

    const deleted = await pruneArchivedDeals(db, 30);
    expect(deleted).toBe(0);
  });

  it('NEVER deletes an open, non-dismissed deal regardless of age', async () => {
    seedDeal(raw, {
      watchlist_id: wid,
      blueprint_id: BP,
      product_id: 111,
      card_name: 'Test Card',
      price_cents: 100,
      currency: 'USD',
      baseline_cents: 200,
      cohort_size: 10,
      discount_pct: 50,
      found_at: "datetime('now','-400 days')",
    });

    const deleted = await pruneArchivedDeals(db, 30);
    expect(deleted).toBe(0);
    expect((await getDealById(db, dealIdFor(111)))!.status).toBe('open');
  });

  it('deletes a dismissed-but-open row older than retention (uses found_at fallback)', async () => {
    seedDeal(raw, {
      watchlist_id: wid,
      blueprint_id: BP,
      product_id: 111,
      card_name: 'Test Card',
      price_cents: 100,
      currency: 'USD',
      baseline_cents: 200,
      cohort_size: 10,
      discount_pct: 50,
      dismissed: 1,
      found_at: "datetime('now','-40 days')",
    });

    const deleted = await pruneArchivedDeals(db, 30);
    expect(deleted).toBe(1);
  });

  it('is disabled at 0 (keep forever) — deletes nothing', async () => {
    seedOpenDeal(111, 100);
    raw.exec(
      `UPDATE deals SET status='expired', retired_at=datetime('now','-400 days') WHERE product_id=111`,
    );

    const deleted = await pruneArchivedDeals(db, 0);
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteArchivedDeals (manual "Clear archive")
// ---------------------------------------------------------------------------

describe('deleteArchivedDeals — manual clear of all archived, any age', () => {
  it('deletes all retired/dismissed rows but keeps live open deals', async () => {
    seedOpenDeal(111, 100); // open, keep
    seedOpenDeal(222, 100);
    seedOpenDeal(333, 100);
    seedOpenDeal(444, 100);
    raw.exec(`UPDATE deals SET status='expired', retired_at=datetime('now') WHERE product_id=222`);
    raw.exec(`UPDATE deals SET status='sold', retired_at=datetime('now') WHERE product_id=333`);
    raw.exec(`UPDATE deals SET dismissed=1 WHERE product_id=444`);

    const deleted = await deleteArchivedDeals(db);
    expect(deleted).toBe(3);

    const remaining = raw.prepare('SELECT product_id FROM deals').all() as { product_id: number }[];
    expect(remaining).toEqual([{ product_id: 111 }]);
  });

  it('returns 0 when there is nothing archived', async () => {
    seedOpenDeal(111, 100);
    const deleted = await deleteArchivedDeals(db);
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setLastMaintenanceAt
// ---------------------------------------------------------------------------

describe('setLastMaintenanceAt', () => {
  it('stamps config.last_maintenance_at (was NULL by default)', async () => {
    const before = await getConfig(db);
    expect(before.last_maintenance_at).toBeNull();

    await setLastMaintenanceAt(db);

    const after = await getConfig(db);
    expect(after.last_maintenance_at).not.toBeNull();
    expect(typeof after.last_maintenance_at).toBe('string');
  });
});
