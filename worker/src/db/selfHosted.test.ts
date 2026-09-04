/**
 * selfHosted.test.ts — the self-hosted persistence layer.
 *
 * Covers the two pieces that stand between the (already well-tested) repo layer
 * and a local SQLite file:
 *   scripts/d1-sqlite.ts   — the D1-shaped adapter
 *   scripts/db-bootstrap.ts — schema creation + the migration ledger
 *
 * The point of these tests is that repo.ts is NOT re-tested here: it is exercised
 * unchanged through the adapter, which is exactly the guarantee self-hosting
 * depends on. If the adapter diverges from the D1 contract, real repo functions
 * break here rather than in production.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalD1 } from '../../scripts/d1-sqlite';
import { bootstrapLocalDb, verifySchema } from '../../scripts/db-bootstrap';
import {
  getConfig,
  patchConfig,
  insertWatchlist,
  listActiveWatchlist,
  upsertDeal,
  openScanRun,
  getLatestScanRun,
} from './repo';

let dbFile: string;
let db: D1Database;
let raw: ReturnType<typeof openLocalD1>['raw'];

beforeEach(() => {
  dbFile = path.join(os.tmpdir(), `cb-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const opened = openLocalD1(dbFile);
  db = opened.db;
  raw = opened.raw;
  bootstrapLocalDb(raw);
});

afterEach(() => {
  try { raw.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
});

describe('bootstrapLocalDb', () => {
  it('creates the full schema from schema.sql alone, with no migration replayed', () => {
    // A second open of the SAME path must report an already-current database.
    const report = bootstrapLocalDb(raw);
    expect(report.created).toBe(false);
    expect(report.applied).toEqual([]);
    expect(report.baselined).toEqual([]);
  });

  it('baselines every pre-go-live migration rather than executing it', () => {
    // Migrations 0005/0006 DROP and rebuild `watchlist`. Executing them on a
    // fresh schema.sql database would be destructive, so they must be recorded
    // as applied without running.
    const names = (raw.prepare('SELECT name FROM _local_migrations ORDER BY name').all() as { name: string }[])
      .map((r) => r.name);
    expect(names.length).toBeGreaterThanOrEqual(13);
    expect(names).toContain('0005_card_type_and_price_mode.sql');
    expect(names).toContain('0013_deal_refresh_maintenance.sql');
  });

  it('leaves the database with every column the migrations introduce', () => {
    // This is the guard on "schema.sql is current" — the server refuses to boot
    // when this list is non-empty.
    expect(verifySchema(raw)).toEqual([]);
  });

  it('seeds exactly one config row', () => {
    const { n } = raw.prepare('SELECT COUNT(*) AS n FROM config').get() as { n: number };
    expect(n).toBe(1);
  });
});

describe('d1-sqlite adapter — real repo functions run unchanged', () => {
  it('reads the config row through getConfig', async () => {
    const config = await getConfig(db);
    expect(config.id).toBe(1);
    expect(config.scan_interval_minutes).toBe(60);
    expect(config.default_discount_pct).toBe(50);
  });

  it('round-trips a config patch (dynamic SET builder)', async () => {
    await patchConfig(db, { scan_interval_minutes: 15, default_discount_pct: 42 });
    const config = await getConfig(db);
    expect(config.scan_interval_minutes).toBe(15);
    expect(config.default_discount_pct).toBe(42);
  });

  it('creates and lists a watchlist item, leaving §9a overrides NULL', async () => {
    const created = await insertWatchlist(db, {
      type: 'expansion',
      cardtrader_id: 1234,
      label: 'Test Set',
    });
    expect(created.id).toBeGreaterThan(0);

    const items = await listActiveWatchlist(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe('Test Set');
    // NULL override columns must stay NULL so inheritance still resolves at scan
    // time — an adapter that coerced NULL to 0 would silently break §9a.
    expect(items[0]!.min_discount_pct).toBeNull();
    expect(items[0]!.min_gap_pct).toBeNull();
  });

  it('honours the ON CONFLICT(product_id) dedupe contract', async () => {
    const watch = await insertWatchlist(db, {
      type: 'expansion',
      cardtrader_id: 1234,
      label: 'Test Set',
    });

    // `foil` is typed `boolean | null` — a real JS boolean reaching SQLite,
    // which better-sqlite3 rejects natively and the adapter must coerce.
    const deal = {
      watchlist_id: watch.id,
      blueprint_id: 555,
      product_id: 999_001,
      card_name: 'Black Lotus',
      expansion_name: 'Alpha',
      seller_username: 'someone',
      seller_country: 'IT',
      condition: 'Near Mint',
      language: 'en',
      foil: false,
      can_sell_via_hub: true,
      quantity: 1,
      price_cents: 1000,
      currency: 'USD',
      baseline_cents: 5000,
      second_cheapest_cents: 4800,
      gap_pct: 79,
      avg4_cents: 5100,
      cohort_size: 10,
      discount_pct: 80,
      priority: 'high',
      buy_url: null,
    } as Parameters<typeof upsertDeal>[1];

    const first = await upsertDeal(db, deal);
    const second = await upsertDeal(db, deal);

    // First insert is new; the duplicate must NOT produce a second row or a
    // second Telegram push (PRD §7/§13 — dedupe on product_id).
    expect(first).toBe(true);
    expect(second).toBe(false);

    const { n } = raw.prepare('SELECT COUNT(*) AS n FROM deals').get() as { n: number };
    expect(n).toBe(1);

    // The boolean binds must have landed as SQLite integers.
    const row = raw.prepare('SELECT foil, can_sell_via_hub FROM deals').get() as
      { foil: number; can_sell_via_hub: number };
    expect(row.foil).toBe(0);
    expect(row.can_sell_via_hub).toBe(1);
  });

  it('returns last_row_id so scan_runs rows can be tracked', async () => {
    const id = await openScanRun(db);
    expect(id).toBeGreaterThan(0);
    const latest = await getLatestScanRun(db);
    expect(latest?.id).toBe(id);
    expect(latest?.finished_at).toBeNull();
  });

  it('coerces undefined and boolean binds the way D1 does', async () => {
    // better-sqlite3 rejects undefined and JS booleans outright; the adapter
    // normalises them (undefined→NULL, boolean→0/1) so repo.ts call sites that
    // were written against the more forgiving D1 binding keep working.
    const stmt = db.prepare('INSERT INTO expansions (id, name, code, game_id) VALUES (?, ?, ?, ?)');
    await stmt.bind(1, 'Alpha', undefined, true).run();

    const row = raw.prepare('SELECT code, game_id FROM expansions WHERE id = 1').get() as
      { code: string | null; game_id: number };
    expect(row.code).toBeNull();
    expect(row.game_id).toBe(1);
  });

  it('runs batch() as one atomic transaction', async () => {
    // The REST adapter (d1-http.ts) issues sequential calls with no atomicity.
    // The local adapter uses a real SQLite transaction, so a failing statement
    // must roll back its predecessors rather than leaving a partial write.
    const good = db.prepare('INSERT INTO expansions (id, name, code, game_id) VALUES (10, ?, ?, 1)').bind('Ok', 'OK');
    const bad = db.prepare('INSERT INTO expansions (id, name, code, game_id) VALUES (10, ?, ?, 1)').bind('Dup', 'DUP');

    await expect(db.batch([good, bad])).rejects.toThrow();

    const { n } = raw.prepare('SELECT COUNT(*) AS n FROM expansions').get() as { n: number };
    expect(n).toBe(0);
  });
});
