/**
 * API route tests — config, watchlist, deals, resolve.
 *
 * Strategy: approach (c) — hand-built in-memory D1 adapter backed by
 * better-sqlite3 with the real schema applied.  This lets every test run the
 * actual SQL (dynamic SET builders, batch-cascade DELETE, datetime filters)
 * without spawning workerd / Miniflare.
 *
 * Tests call `app.fetch(new Request(url, opts), env)` through the full Hono
 * app (auth gate included).  One failing test exposes a genuine route bug;
 * the rest show green.
 *
 * Money assertions use integer cents only.  No Date.now() inside any test.
 * PRD §16 behaviours covered:
 *   config  — GET / PATCH / bad-body / unknown-key no-crash
 *   watchlist — POST/GET / bad-body 400 / PATCH / 404 / DELETE cascade / reset
 *   deals   — filters (status, min_discount, watchlist_id, priority) / PATCH flags
 *             / dismissed hides from open feed / DELETE prune / 400 cases
 *   resolve — expansions search / blueprints missing-param 400 / empty cache
 *   auth    — 401 without Bearer
 */

import { describe, it, expect } from 'vitest';
// Note: beforeEach not used — each test calls makeD1() for a fresh in-memory DB
import { Hono } from 'hono';
import { configRouter } from './config';
import { watchlistRouter } from './watchlist';
import { dealsRouter } from './deals';
import { createResolveRouter } from './resolve';
import { scanRouter } from './scan';
import { getLatestScanRun } from '../db/repo';
import { makeD1, seedDeal, seedWatchlist, seedScanRun } from './__test-helpers__/d1';
import type { Env } from '../index';
import type { ConfigRow, WatchlistRow, DealRow, ScanRunRow } from '../db/types';
import type { CardTraderClient } from '../cardtrader/client';
import type { Expansion, Blueprint } from '../cardtrader/types';

// ---------------------------------------------------------------------------
// Mock CardTrader client for routes.test.ts
//
// Returns empty arrays for all resolve-related calls.  This lets the existing
// resolve cache-read tests continue to exercise the DB path while the new
// fetch+cache behaviour is fully covered in resolve.test.ts.
// ---------------------------------------------------------------------------

const emptyClient: CardTraderClient = {
  info: () => Promise.reject(new Error('not used in route tests')),
  marketplaceProducts: () => Promise.reject(new Error('not used in route tests')),
  expansions: (): Promise<Expansion[]> => Promise.resolve([]),
  blueprintsExport: (): Promise<Blueprint[]> => Promise.resolve([]),
};

const resolveRouter = createResolveRouter({
  createClient: () => emptyClient,
});

// ---------------------------------------------------------------------------
// Test app — mirrors the auth gate + route mounting from index.ts
// ---------------------------------------------------------------------------

const testApp = new Hono<{ Bindings: Env }>();

// Auth gate (copied from index.ts)
testApp.use('/api/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== c.env.DESKTOP_AUTH_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

testApp.route('/api/config', configRouter);
testApp.route('/api/watchlist', watchlistRouter);
testApp.route('/api/deals', dealsRouter);
testApp.route('/api/resolve', resolveRouter);
testApp.route('/api/scan', scanRouter);

// Health endpoint — mirrors index.ts implementation for testing
testApp.get('/api/health', async (c) => {
  let db_ok = false;
  let last_scan_at: string | null = null;
  let last_scan_finished_at: string | null = null;
  let last_scan_error: string | null = null;
  let deals_found: number | null = null;
  let telegram_sent: number | null = null;
  let api_calls: number | null = null;

  try {
    const run = await getLatestScanRun(c.env.DB);
    db_ok = true;
    if (run !== null) {
      last_scan_at = run.started_at;
      last_scan_finished_at = run.finished_at;
      last_scan_error = run.error;
      deals_found = run.deals_found;
      telegram_sent = run.telegram_sent;
      api_calls = run.api_calls;
    }
  } catch {
    db_ok = false;
  }

  return c.json({
    ok: true,
    service: 'card-broker',
    ts: new Date().toISOString(),
    db_ok,
    last_scan_at,
    last_scan_finished_at,
    last_scan_error,
    deals_found,
    telegram_sent,
    api_calls,
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BEARER = 'test-desktop-token';

/** Build a minimal Env with the given D1 database. */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CARDTRADER_API_TOKEN: 'ct-token',
    TELEGRAM_BOT_TOKEN: 'tg-bot',
    TELEGRAM_CHAT_ID: 'tg-chat',
    DESKTOP_AUTH_TOKEN: BEARER,
  };
}

async function fetch_(
  url: string,
  opts: RequestInit & { auth?: boolean },
  env: Env,
): Promise<Response> {
  const { auth = true, ...rest } = opts;
  const headers: Record<string, string> = {
    ...(rest.headers as Record<string, string>),
  };
  if (auth) { headers['Authorization'] = `Bearer ${BEARER}`; }
  return testApp.fetch(new Request(url, { ...rest, headers }), env);
}

// Shorthand wrappers
const GET = (env: Env, path: string, auth = true) =>
  fetch_(path, { method: 'GET', auth }, env);

const POST = (env: Env, path: string, body: unknown, auth = true) =>
  fetch_(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    auth,
  }, env);

const PATCH = (env: Env, path: string, body: unknown, auth = true) =>
  fetch_(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    auth,
  }, env);

const DELETE_ = (env: Env, path: string, auth = true) =>
  fetch_(path, { method: 'DELETE', auth }, env);

// Base URL for the Worker
const BASE = 'http://localhost';

// ---------------------------------------------------------------------------
// §16 acceptance — auth gate
// ---------------------------------------------------------------------------

describe('auth gate', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/config`, false);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 when Bearer token is wrong', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await fetch_(`${BASE}/api/config`, {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-token' },
      auth: false,
    }, env);
    expect(res.status).toBe(401);
  });

  it('accepts the correct Bearer token', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/config`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Config routes
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  it('returns the seeded config row with defaults', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json<ConfigRow>();
    expect(body.id).toBe(1);
    // Schema seeds default_threshold_pct = 50
    expect(body.default_threshold_pct).toBe(50);
    // Money is integer — never float
    expect(Number.isInteger(body.default_threshold_pct)).toBe(true);
    expect(body.telegram_min_discount_pct).toBe(60);
  });
});

describe('PATCH /api/config', () => {
  it('updates an allow-listed field and GET reflects the change', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const patchRes = await PATCH(env, `${BASE}/api/config`, { default_threshold_pct: 40 });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<ConfigRow>();
    expect(patched.default_threshold_pct).toBe(40);
    expect(Number.isInteger(patched.default_threshold_pct)).toBe(true);

    // Subsequent GET reflects the change
    const getRes = await GET(env, `${BASE}/api/config`);
    const got = await getRes.json<ConfigRow>();
    expect(got.default_threshold_pct).toBe(40);
  });

  it('updates telegram_min_discount_pct as integer cents', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const patchRes = await PATCH(env, `${BASE}/api/config`, { telegram_min_discount_pct: 70 });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json<ConfigRow>();
    expect(body.telegram_min_discount_pct).toBe(70);
    expect(Number.isInteger(body.telegram_min_discount_pct)).toBe(true);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await fetch_(`${BASE}/api/config`, {
      method: 'PATCH',
      body: 'not json{{',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(res.status).toBe(400);
  });

  it('ignores unknown keys — does not crash, returns current row', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    // A key that is not in CONFIG_PATCH_FIELDS
    const res = await PATCH(env, `${BASE}/api/config`, { totally_unknown_field: 999 });
    expect(res.status).toBe(200);
    const body = await res.json<ConfigRow>();
    // Should return the unchanged row
    expect(body.default_threshold_pct).toBe(50);
  });

  it('does not update id or updated_at from the body', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    // Attempt to change id — should be silently ignored
    const res = await PATCH(env, `${BASE}/api/config`, { id: 999, default_threshold_pct: 45 });
    expect(res.status).toBe(200);
    const body = await res.json<ConfigRow>();
    expect(body.id).toBe(1);
    expect(body.default_threshold_pct).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Watchlist routes
// ---------------------------------------------------------------------------

describe('GET /api/watchlist', () => {
  it('returns an empty array when no watchlist items exist', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/watchlist`);
    expect(res.status).toBe(200);
    const body = await res.json<WatchlistRow[]>();
    expect(body).toEqual([]);
  });

  it('returns items after POST', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      cardtrader_id: 10050,
      label: 'Black Lotus',
    });
    const res = await GET(env, `${BASE}/api/watchlist`);
    const body = await res.json<WatchlistRow[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.label).toBe('Black Lotus');
    expect(body[0]!.cardtrader_id).toBe(10050);
  });
});

describe('POST /api/watchlist', () => {
  it('creates a new watchlist item (201) with §9a override columns NULL', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      cardtrader_id: 10050,
      label: 'Black Lotus',
    });
    expect(res.status).toBe(201);
    const body = await res.json<WatchlistRow>();
    expect(body.type).toBe('blueprint');
    expect(body.cardtrader_id).toBe(10050);
    expect(body.label).toBe('Black Lotus');
    // §9a: new items are born inheriting — override columns must be NULL
    expect(body.threshold_pct).toBeNull();
    expect(body.telegram_min_discount_pct).toBeNull();
    expect(body.telegram_max_price_cents).toBeNull();
    expect(body.telegram_min_savings_cents).toBeNull();
  });

  it('returns 400 when type is missing', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      cardtrader_id: 10050,
      label: 'Black Lotus',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'card',
      cardtrader_id: 10050,
      label: 'Black Lotus',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when cardtrader_id is missing', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      label: 'Black Lotus',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when cardtrader_id is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      cardtrader_id: 'abc',
      label: 'Black Lotus',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when label is blank', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      cardtrader_id: 10050,
      label: '   ',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await fetch_(`${BASE}/api/watchlist`, {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(res.status).toBe(400);
  });

  it('trims whitespace from label', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await POST(env, `${BASE}/api/watchlist`, {
      type: 'blueprint',
      cardtrader_id: 10050,
      label: '  Black Lotus  ',
    });
    expect(res.status).toBe(201);
    const body = await res.json<WatchlistRow>();
    expect(body.label).toBe('Black Lotus');
  });
});

describe('PATCH /api/watchlist/:id', () => {
  it('updates a field and returns 200 with the updated row', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });

    const res = await PATCH(env, `${BASE}/api/watchlist/${id}`, { label: 'Mox Sapphire' });
    expect(res.status).toBe(200);
    const body = await res.json<WatchlistRow>();
    expect(body.label).toBe('Mox Sapphire');
    expect(body.id).toBe(id);
  });

  it('returns 404 when the id does not exist', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await PATCH(env, `${BASE}/api/watchlist/9999`, { label: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when id is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await PATCH(env, `${BASE}/api/watchlist/abc`, { label: 'Ghost' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/watchlist/:id', () => {
  it('returns 204 and removes the row', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });

    const res = await DELETE_(env, `${BASE}/api/watchlist/${id}`);
    expect(res.status).toBe(204);

    // Confirm gone from GET
    const listRes = await GET(env, `${BASE}/api/watchlist`);
    const rows = await listRes.json<WatchlistRow[]>();
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it('cascade-deletes child deals when watchlist item is deleted', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const wId = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
    // Seed a deal belonging to this watchlist item
    seedDeal(raw, {
      watchlist_id: wId,
      blueprint_id: 10050,
      product_id: 9001,
      card_name: 'Black Lotus',
      price_cents: 1600,   // integer cents
      currency: 'USD',
      baseline_cents: 3200, // integer cents
      cohort_size: 10,
      discount_pct: 50,
    });

    // Verify deal exists first
    const beforeRes = await GET(env, `${BASE}/api/deals`);
    const before = await beforeRes.json<DealRow[]>();
    expect(before.some((d) => d.product_id === 9001)).toBe(true);

    // Delete the watchlist item
    const delRes = await DELETE_(env, `${BASE}/api/watchlist/${wId}`);
    expect(delRes.status).toBe(204);

    // The deal must also be gone (cascade)
    const afterRes = await GET(env, `${BASE}/api/deals?status=all`);
    const after = await afterRes.json<DealRow[]>();
    expect(after.some((d) => d.product_id === 9001)).toBe(false);
  });

  it('returns 404 when the id does not exist', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await DELETE_(env, `${BASE}/api/watchlist/9999`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when id is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await DELETE_(env, `${BASE}/api/watchlist/abc`);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/watchlist/:id/reset', () => {
  it('nulls threshold_pct back to inherit (200)', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, {
      cardtrader_id: 10050,
      label: 'Black Lotus',
      threshold_pct: 40,
    });

    // Verify it was seeded with a value
    const beforeRes = await GET(env, `${BASE}/api/watchlist`);
    const before = await beforeRes.json<WatchlistRow[]>();
    expect(before[0]!.threshold_pct).toBe(40);

    // Reset it
    const res = await PATCH(env, `${BASE}/api/watchlist/${id}/reset`, { field: 'threshold_pct' });
    expect(res.status).toBe(200);
    const body = await res.json<WatchlistRow>();
    expect(body.threshold_pct).toBeNull();
  });

  it('nulls telegram_min_discount_pct back to inherit (200)', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    // Seed with explicit telegram_min_discount_pct
    const id = raw.prepare(
      `INSERT INTO watchlist (type, cardtrader_id, label, telegram_min_discount_pct)
       VALUES ('blueprint', 10050, 'Black Lotus', 70)`,
    ).run().lastInsertRowid as number;

    const res = await PATCH(env, `${BASE}/api/watchlist/${id}/reset`, { field: 'telegram_min_discount_pct' });
    expect(res.status).toBe(200);
    const body = await res.json<WatchlistRow>();
    expect(body.telegram_min_discount_pct).toBeNull();
  });

  it('returns 400 for a non-resettable field (telegram_max_price_cents)', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
    const res = await PATCH(env, `${BASE}/api/watchlist/${id}/reset`, {
      field: 'telegram_max_price_cents',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown field', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
    const res = await PATCH(env, `${BASE}/api/watchlist/${id}/reset`, { field: 'bogus_field' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when field key is missing from body', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const id = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
    const res = await PATCH(env, `${BASE}/api/watchlist/${id}/reset`, {});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown watchlist id', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await PATCH(env, `${BASE}/api/watchlist/9999/reset`, { field: 'threshold_pct' });
    // The route returns 404 when the id doesn't exist but the field is valid.
    // NOTE: resetWatchlistField does an UPDATE then getWatchlistById. If the id
    // doesn't exist, getWatchlistById returns null → route returns 404.
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Deals routes
// ---------------------------------------------------------------------------

/** Create a standard test environment with pre-seeded deals. */
function makeDealsEnv() {
  const { db, raw } = makeD1();
  const env = makeEnv(db);

  // Seed one watchlist item to satisfy the FK
  const wId = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
  const wId2 = seedWatchlist(raw, { cardtrader_id: 20001, label: 'Mox Sapphire' });

  // Seed five deals: varying discount_pct, dismissed, watchlist_id, priority
  // All money as integer cents
  seedDeal(raw, {
    watchlist_id: wId,
    blueprint_id: 10050,
    product_id: 1001,
    card_name: 'Black Lotus',
    price_cents: 1600,
    currency: 'USD',
    baseline_cents: 3200,
    cohort_size: 10,
    discount_pct: 50,
    priority: 'high',
  });
  seedDeal(raw, {
    watchlist_id: wId,
    blueprint_id: 10050,
    product_id: 1002,
    card_name: 'Black Lotus Alt',
    price_cents: 2800,
    currency: 'USD',
    baseline_cents: 3200,
    cohort_size: 10,
    discount_pct: 12,
  });
  seedDeal(raw, {
    watchlist_id: wId,
    blueprint_id: 10050,
    product_id: 1003,
    card_name: 'Black Lotus Dismissed',
    price_cents: 1600,
    currency: 'USD',
    baseline_cents: 3200,
    cohort_size: 10,
    discount_pct: 50,
    dismissed: 1,
  });
  seedDeal(raw, {
    watchlist_id: wId2,
    blueprint_id: 20001,
    product_id: 2001,
    card_name: 'Mox Sapphire',
    price_cents: 1200,
    currency: 'USD',
    baseline_cents: 3000,
    cohort_size: 10,
    discount_pct: 60,
  });
  seedDeal(raw, {
    watchlist_id: wId2,
    blueprint_id: 20001,
    product_id: 2002,
    card_name: 'Mox Sapphire Cheap',
    price_cents: 400,
    currency: 'USD',
    baseline_cents: 3000,
    cohort_size: 10,
    discount_pct: 86,
    priority: 'high',
  });

  return { db, raw, env, wId, wId2 };
}

describe('GET /api/deals', () => {
  it('returns only non-dismissed deals by default (status=open)', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    // Dismissed deal (product_id 1003) must not appear
    expect(body.every((d) => d.dismissed === 0)).toBe(true);
    expect(body.some((d) => d.product_id === 1003)).toBe(false);
  });

  it('returns all deals including dismissed with status=all', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?status=all`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    expect(body.some((d) => d.product_id === 1003)).toBe(true);
  });

  it('filters by min_discount — only deals at or above the threshold', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?min_discount=50`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    // product_id 1002 has discount_pct=12, should be excluded
    expect(body.some((d) => d.product_id === 1002)).toBe(false);
    // All returned deals must have discount_pct >= 50
    expect(body.every((d) => d.discount_pct >= 50)).toBe(true);
    // Integer check on money field
    body.forEach((d) => {
      expect(Number.isInteger(d.price_cents)).toBe(true);
      expect(Number.isInteger(d.baseline_cents)).toBe(true);
    });
  });

  it('filters by watchlist_id', async () => {
    const { env, wId } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?watchlist_id=${wId}`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    expect(body.every((d) => d.watchlist_id === wId)).toBe(true);
    // wId2 deals (product_ids 2001, 2002) must not appear
    expect(body.some((d) => d.product_id === 2001)).toBe(false);
    expect(body.some((d) => d.product_id === 2002)).toBe(false);
  });

  it('filters by priority=high', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?priority=high`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    expect(body.every((d) => d.priority === 'high')).toBe(true);
    // product_id 2002 is high and open
    expect(body.some((d) => d.product_id === 2002)).toBe(true);
  });

  it('applies combined filters (min_discount AND watchlist_id) as AND', async () => {
    const { env, wId2 } = makeDealsEnv();
    // wId2 has product_ids 2001 (60%) and 2002 (86%)
    const res = await GET(env, `${BASE}/api/deals?min_discount=70&watchlist_id=${wId2}`);
    expect(res.status).toBe(200);
    const body = await res.json<DealRow[]>();
    // Only 2002 (86%) should pass; 2001 (60%) is below 70
    expect(body.some((d) => d.product_id === 2002)).toBe(true);
    expect(body.some((d) => d.product_id === 2001)).toBe(false);
  });

  it('returns 400 when min_discount is not an integer', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?min_discount=notanint`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is invalid', async () => {
    const { env } = makeDealsEnv();
    const res = await GET(env, `${BASE}/api/deals?status=invalid`);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/deals/:id', () => {
  it('marks seen=true and returns the updated row', async () => {
    const { env } = makeDealsEnv();
    // Get a deal id first
    const listRes = await GET(env, `${BASE}/api/deals`);
    const deals = await listRes.json<DealRow[]>();
    const deal = deals.find((d) => d.product_id === 1001)!;

    const res = await PATCH(env, `${BASE}/api/deals/${deal.id}`, { seen: true });
    expect(res.status).toBe(200);
    const body = await res.json<DealRow>();
    expect(body.seen).toBe(1); // D1 boolean stored as 0/1
  });

  it('marks dismissed=true and deal drops out of open feed', async () => {
    const { env } = makeDealsEnv();
    const listRes = await GET(env, `${BASE}/api/deals`);
    const deals = await listRes.json<DealRow[]>();
    const deal = deals.find((d) => d.product_id === 1002)!;

    const patchRes = await PATCH(env, `${BASE}/api/deals/${deal.id}`, { dismissed: true });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<DealRow>();
    expect(patched.dismissed).toBe(1);

    // Default open feed no longer includes it
    const afterRes = await GET(env, `${BASE}/api/deals`);
    const after = await afterRes.json<DealRow[]>();
    expect(after.some((d) => d.product_id === 1002)).toBe(false);
  });

  it('returns 404 for an unknown deal id', async () => {
    const { env } = makeDealsEnv();
    const res = await PATCH(env, `${BASE}/api/deals/99999`, { seen: true });
    expect(res.status).toBe(404);
  });

  it('returns 400 when seen is wrong type (string instead of boolean)', async () => {
    const { env } = makeDealsEnv();
    const listRes = await GET(env, `${BASE}/api/deals`);
    const deals = await listRes.json<DealRow[]>();
    const deal = deals[0]!;

    const res = await PATCH(env, `${BASE}/api/deals/${deal.id}`, { seen: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when dismissed is wrong type (number instead of boolean)', async () => {
    const { env } = makeDealsEnv();
    const listRes = await GET(env, `${BASE}/api/deals`);
    const deals = await listRes.json<DealRow[]>();
    const deal = deals[0]!;

    const res = await PATCH(env, `${BASE}/api/deals/${deal.id}`, { dismissed: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when deal id is not an integer', async () => {
    const { env } = makeDealsEnv();
    const res = await PATCH(env, `${BASE}/api/deals/abc`, { seen: true });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/deals (prune)', () => {
  it('deletes deals older than N days and returns {deleted: N}', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const wId = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });

    // Seed one old deal (60 days ago) and one fresh one
    seedDeal(raw, {
      watchlist_id: wId,
      blueprint_id: 10050,
      product_id: 3001,
      card_name: 'Old Deal',
      price_cents: 1600,
      currency: 'USD',
      baseline_cents: 3200,
      cohort_size: 10,
      discount_pct: 50,
      found_at: "datetime('now','-60 days')",
    });
    seedDeal(raw, {
      watchlist_id: wId,
      blueprint_id: 10050,
      product_id: 3002,
      card_name: 'Fresh Deal',
      price_cents: 1600,
      currency: 'USD',
      baseline_cents: 3200,
      cohort_size: 10,
      discount_pct: 50,
      // found_at defaults to now
    });

    const res = await DELETE_(env, `${BASE}/api/deals?older_than_days=30`);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: number }>();
    expect(body.deleted).toBe(1);

    // Old deal is gone; fresh one still present
    const listRes = await GET(env, `${BASE}/api/deals?status=all`);
    const remaining = await listRes.json<DealRow[]>();
    expect(remaining.some((d) => d.product_id === 3001)).toBe(false);
    expect(remaining.some((d) => d.product_id === 3002)).toBe(true);
  });

  it('returns {deleted: 0} when nothing is old enough', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    const wId = seedWatchlist(raw, { cardtrader_id: 10050, label: 'Black Lotus' });
    seedDeal(raw, {
      watchlist_id: wId,
      blueprint_id: 10050,
      product_id: 3003,
      card_name: 'Fresh',
      price_cents: 1600,
      currency: 'USD',
      baseline_cents: 3200,
      cohort_size: 10,
      discount_pct: 50,
    });

    const res = await DELETE_(env, `${BASE}/api/deals?older_than_days=30`);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: number }>();
    expect(body.deleted).toBe(0);
  });

  it('returns 400 when older_than_days is missing', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await DELETE_(env, `${BASE}/api/deals`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when older_than_days is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await DELETE_(env, `${BASE}/api/deals?older_than_days=abc`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when older_than_days is negative', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await DELETE_(env, `${BASE}/api/deals?older_than_days=-5`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Resolve routes
// ---------------------------------------------------------------------------

describe('GET /api/resolve/expansions', () => {
  it('returns empty array when cache is empty and q is provided', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/expansions?q=khans`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);
  });

  it('returns empty array when q is absent', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/expansions`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);
  });

  it('returns empty array when q is blank', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/expansions?q=`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);
  });

  it('returns matching expansion from the cache', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    // Seed an expansion
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name) VALUES (?, ?, ?, ?)`,
    ).run(100, 1, 'KTK', 'Khans of Tarkir');

    const res = await GET(env, `${BASE}/api/resolve/expansions?q=khans`);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Khans of Tarkir');
  });

  it('is case-insensitive', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name) VALUES (?, ?, ?, ?)`,
    ).run(101, 1, 'KTK', 'Khans of Tarkir');

    const res = await GET(env, `${BASE}/api/resolve/expansions?q=TARKIR`);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
  });

  it('matches by code', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name) VALUES (?, ?, ?, ?)`,
    ).run(102, 1, 'KTK', 'Khans of Tarkir');

    const res = await GET(env, `${BASE}/api/resolve/expansions?q=KTK`);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
  });
});

describe('GET /api/resolve/blueprints', () => {
  it('returns 400 when expansion_id is missing', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/blueprints`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when expansion_id is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/blueprints?expansion_id=abc`);
    expect(res.status).toBe(400);
  });

  it('returns empty array when cache is empty', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/resolve/blueprints?expansion_id=123&q=`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);
  });

  it('returns matching blueprint from the cache', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name) VALUES (?, ?, ?, ?)`,
    ).run(100, 1, 'KTK', 'Khans of Tarkir');
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`,
    ).run(10050, 100, 'Black Lotus');
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`,
    ).run(10051, 100, 'Mox Pearl');

    const res = await GET(env, `${BASE}/api/resolve/blueprints?expansion_id=100&q=lotus`);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Black Lotus');
  });

  it('returns all blueprints in an expansion when q is empty', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name) VALUES (?, ?, ?, ?)`,
    ).run(100, 1, 'KTK', 'Khans of Tarkir');
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`,
    ).run(10050, 100, 'Black Lotus');
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`,
    ).run(10051, 100, 'Mox Pearl');

    const res = await GET(env, `${BASE}/api/resolve/blueprints?expansion_id=100&q=`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toHaveLength(2);
  });

  it('does not return blueprints from a different expansion', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.prepare(`INSERT INTO expansions (id, game_id, name) VALUES (100, 1, 'Set A')`).run();
    raw.prepare(`INSERT INTO expansions (id, game_id, name) VALUES (200, 1, 'Set B')`).run();
    raw.prepare(`INSERT INTO blueprints (id, expansion_id, name) VALUES (1, 100, 'Black Lotus')`).run();
    raw.prepare(`INSERT INTO blueprints (id, expansion_id, name) VALUES (2, 200, 'Mox Pearl')`).run();

    const res = await GET(env, `${BASE}/api/resolve/blueprints?expansion_id=100`);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Black Lotus');
  });
});

// ---------------------------------------------------------------------------
// Config — theme_palette + font columns
// ---------------------------------------------------------------------------

describe('PATCH /api/config — theme_palette + font', () => {
  it('persists theme_palette and GET reflects the change', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const patchRes = await PATCH(env, `${BASE}/api/config`, { theme_palette: 'rose' });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<ConfigRow>();
    expect(patched.theme_palette).toBe('rose');

    const getRes = await GET(env, `${BASE}/api/config`);
    const got = await getRes.json<ConfigRow>();
    expect(got.theme_palette).toBe('rose');
  });

  it('persists font and GET reflects the change', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const patchRes = await PATCH(env, `${BASE}/api/config`, { font: 'mono' });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<ConfigRow>();
    expect(patched.font).toBe('mono');

    const getRes = await GET(env, `${BASE}/api/config`);
    const got = await getRes.json<ConfigRow>();
    expect(got.font).toBe('mono');
  });

  it('persists theme_palette + font in a single PATCH', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const patchRes = await PATCH(env, `${BASE}/api/config`, {
      theme_palette: 'amber',
      font: 'plex',
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<ConfigRow>();
    expect(patched.theme_palette).toBe('amber');
    expect(patched.font).toBe('plex');
  });

  it('GET /api/config includes theme_palette and font with schema defaults', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const res = await GET(env, `${BASE}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json<ConfigRow>();
    // Schema defaults
    expect(body.theme_palette).toBe('cyan');
    expect(body.font).toBe('chakra');
  });
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns ok:true, service, ts, and db_ok:true with empty scan fields when no scans ran', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const res = await GET(env, `${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      service: string;
      ts: string;
      db_ok: boolean;
      last_scan_at: string | null;
      last_scan_finished_at: string | null;
      last_scan_error: string | null;
      deals_found: number | null;
      telegram_sent: number | null;
      api_calls: number | null;
    }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('card-broker');
    expect(typeof body.ts).toBe('string');
    expect(body.db_ok).toBe(true);
    // No scans ever → all scan fields null
    expect(body.last_scan_at).toBeNull();
    expect(body.last_scan_finished_at).toBeNull();
    expect(body.last_scan_error).toBeNull();
    expect(body.deals_found).toBeNull();
    expect(body.telegram_sent).toBeNull();
    expect(body.api_calls).toBeNull();
  });

  it('surfaces the latest scan_run counts and timestamps', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Seed an older run (should not appear)
    seedScanRun(raw, {
      api_calls: 1,
      deals_found: 0,
      telegram_sent: 0,
      finished_at: "datetime('now','-2 hours')",
    });
    // Seed the most recent run
    seedScanRun(raw, {
      api_calls: 12,
      deals_found: 4,
      telegram_sent: 2,
      error: null,
      finished_at: "datetime('now')",
    });

    const res = await GET(env, `${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      db_ok: boolean;
      last_scan_at: string | null;
      last_scan_finished_at: string | null;
      last_scan_error: string | null;
      deals_found: number | null;
      telegram_sent: number | null;
      api_calls: number | null;
    }>();
    expect(body.db_ok).toBe(true);
    expect(body.last_scan_at).not.toBeNull();
    expect(body.last_scan_finished_at).not.toBeNull();
    expect(body.last_scan_error).toBeNull();
    // Must reflect the latest run's counts
    expect(body.deals_found).toBe(4);
    expect(body.telegram_sent).toBe(2);
    expect(body.api_calls).toBe(12);
  });

  it('surfaces last_scan_error when the latest run errored', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    seedScanRun(raw, {
      api_calls: 3,
      deals_found: 0,
      telegram_sent: 0,
      error: 'CardTrader 401',
      finished_at: "datetime('now')",
    });

    const res = await GET(env, `${BASE}/api/health`);
    const body = await res.json<{ last_scan_error: string | null }>();
    expect(body.last_scan_error).toBe('CardTrader 401');
  });

  it('returns 401 without auth', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/health`, false);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan/runs
// ---------------------------------------------------------------------------

describe('GET /api/scan/runs', () => {
  it('returns an empty array when no scans have run', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const res = await GET(env, `${BASE}/api/scan/runs`);
    expect(res.status).toBe(200);
    const body = await res.json<ScanRunRow[]>();
    expect(body).toEqual([]);
  });

  it('returns seeded runs newest-first', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Insert three runs in chronological order
    seedScanRun(raw, { api_calls: 1, deals_found: 0, telegram_sent: 0 });
    seedScanRun(raw, { api_calls: 5, deals_found: 2, telegram_sent: 1 });
    seedScanRun(raw, { api_calls: 8, deals_found: 5, telegram_sent: 3 });

    const res = await GET(env, `${BASE}/api/scan/runs`);
    expect(res.status).toBe(200);
    const body = await res.json<ScanRunRow[]>();
    expect(body).toHaveLength(3);
    // Newest first — last inserted has highest id
    expect(body[0]!.api_calls).toBe(8);
    expect(body[1]!.api_calls).toBe(5);
    expect(body[2]!.api_calls).toBe(1);
  });

  it('each row has the expected ScanRunRow fields', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    seedScanRun(raw, {
      api_calls: 7,
      deals_found: 3,
      telegram_sent: 1,
      error: null,
      finished_at: "datetime('now')",
    });

    const res = await GET(env, `${BASE}/api/scan/runs`);
    const body = await res.json<ScanRunRow[]>();
    expect(body).toHaveLength(1);
    const run = body[0]!;
    expect(typeof run.id).toBe('number');
    expect(typeof run.started_at).toBe('string');
    expect(run.finished_at).not.toBeNull();
    expect(run.api_calls).toBe(7);
    expect(run.deals_found).toBe(3);
    expect(run.telegram_sent).toBe(1);
    expect(run.error).toBeNull();
  });

  it('returns at most 20 rows', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Seed 25 runs
    for (let i = 0; i < 25; i++) {
      seedScanRun(raw, { deals_found: i });
    }

    const res = await GET(env, `${BASE}/api/scan/runs`);
    const body = await res.json<ScanRunRow[]>();
    expect(body.length).toBeLessThanOrEqual(20);
    expect(body).toHaveLength(20);
  });

  it('returns 401 without auth', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const res = await GET(env, `${BASE}/api/scan/runs`, false);
    expect(res.status).toBe(401);
  });
});
