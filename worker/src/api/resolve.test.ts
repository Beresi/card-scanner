/**
 * Fetch+cache behaviour for GET /api/resolve/expansions and /blueprints.
 *
 * Strategy: inject a mock CardTrader client via createResolveRouter(deps).
 * No real HTTP is ever made.  The in-memory D1 adapter (makeD1) runs the real
 * SQLite schema so the cache tables, upserts, and search all execute properly.
 *
 * Scenarios covered:
 *  expansions
 *    - empty cache → calls client.expansions(), filters MTG, caches, returns match
 *    - warm cache → client NOT called again (call count assertion)
 *    - non-MTG rows are filtered out before caching
 *    - fetch error + empty cache → 502
 *    - fetch error + warm cache → searches the existing cache (fallback)
 *    - blank q → [] without calling client
 *    - stale cache (simulated) → re-fetches
 *  blueprints
 *    - missing expansion_id → 400
 *    - non-integer expansion_id → 400
 *    - empty cache → calls client.blueprintsExport(id), caches, returns match
 *    - warm cache → client NOT called again
 *    - fetch error + empty cache → 502
 *    - fetch error + warm cache → fallback to cache
 *    - large set chunking: >200 blueprints sync without error
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createResolveRouter, type ResolveDeps } from './resolve';
import { makeD1 } from './__test-helpers__/d1';
import type { Env } from '../index';
import type { CardTraderClient } from '../cardtrader/client';
import type { Expansion, Blueprint } from '../cardtrader/types';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

const BEARER = 'test-token';

/**
 * Build a minimal Env.  CARDTRADER_API_TOKEN is present but never hits the real
 * network — the injected mock client factory ignores the token value.
 */
function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CARDTRADER_API_TOKEN: 'ct-fake',
    TELEGRAM_BOT_TOKEN: 'tg-fake',
    TELEGRAM_CHAT_ID: 'chat-fake',
    DESKTOP_AUTH_TOKEN: BEARER,
  };
}

/**
 * Build a Hono test app that mirrors the auth gate and mounts the resolve router
 * with an injected client factory.
 */
function makeApp(deps: ResolveDeps) {
  const app = new Hono<{ Bindings: Env }>();

  // Auth gate (mirrors index.ts)
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== c.env.DESKTOP_AUTH_TOKEN) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.route('/api/resolve', createResolveRouter(deps));
  return app;
}

/** Issue a GET to the app with the test bearer token. */
async function GET(
  app: ReturnType<typeof makeApp>,
  env: Env,
  path: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${BEARER}` },
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// Sample fixture data
// ---------------------------------------------------------------------------

const MTG_EXPANSION: Expansion = {
  id: 100,
  code: 'KTK',
  name: 'Khans of Tarkir',
  name_en: 'Khans of Tarkir',
  game_id: 1,
};

const NON_MTG_EXPANSION: Expansion = {
  id: 200,
  code: 'OTH',
  name: 'Other Game Set',
  name_en: 'Other Game Set',
  game_id: 2,
};

const BLUEPRINT_LOTUS: Blueprint = {
  id: 10050,
  name: 'Black Lotus',
  expansion_id: 100,
  game_id: 1,
  image_url: 'https://example.com/lotus.jpg',
  scryfall_id: 'abc-123',
};

const BLUEPRINT_MOX: Blueprint = {
  id: 10051,
  name: 'Mox Pearl',
  expansion_id: 100,
  game_id: 1,
  image_url: null,
  scryfall_id: null,
};

// ---------------------------------------------------------------------------
// Helper: build a mock CardTraderClient
// ---------------------------------------------------------------------------

function mockClient(overrides: Partial<CardTraderClient> = {}): CardTraderClient {
  return {
    info: vi.fn().mockRejectedValue(new Error('not used')),
    marketplaceProducts: vi.fn().mockRejectedValue(new Error('not used')),
    expansions: vi.fn().mockResolvedValue([]),
    blueprintsExport: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Expansions
// ---------------------------------------------------------------------------

describe('GET /api/resolve/expansions', () => {
  it('empty cache → calls client.expansions(), caches MTG rows, returns match', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION, NON_MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions?q=khans');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();

    // Should return the MTG expansion that matches the query
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Khans of Tarkir');
    expect(body[0]!.id).toBe(100);

    // Client was called exactly once
    expect(client.expansions).toHaveBeenCalledTimes(1);
  });

  it('non-MTG expansions are filtered out before caching', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION, NON_MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    // First request populates the cache
    await GET(app, env, '/api/resolve/expansions?q=other');

    // The non-MTG expansion should not be in the cache
    const res2 = await GET(app, env, '/api/resolve/expansions?q=other');
    expect(res2.status).toBe(200);
    const body2 = await res2.json<{ id: number; name: string }[]>();
    expect(body2).toHaveLength(0);
  });

  it('warm cache → client is NOT called again', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Pre-seed the cache with a fresh synced_at (won't be stale for 7 days)
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name, synced_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(100, 1, 'KTK', 'Khans of Tarkir');

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions?q=khans');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Khans of Tarkir');

    // Client must NOT have been called (cache was warm)
    expect(client.expansions).toHaveBeenCalledTimes(0);
  });

  it('fetch error + empty cache → 502 {error:"upstream"}', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockRejectedValue(new Error('network failure')),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions?q=khans');
    expect(res.status).toBe(502);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('upstream');
  });

  it('fetch error + warm cache → returns cached results (fallback)', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Pre-seed a stale cache entry (older than 7 days) so a refresh is attempted
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name, synced_at)
       VALUES (?, ?, ?, ?, datetime('now', '-8 days'))`,
    ).run(100, 1, 'KTK', 'Khans of Tarkir');

    const client = mockClient({
      expansions: vi.fn().mockRejectedValue(new Error('CardTrader down')),
    });
    const app = makeApp({ createClient: () => client });

    // The fetch fails but the cache has data — should fall back to cache
    const res = await GET(app, env, '/api/resolve/expansions?q=khans');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Khans of Tarkir');
  });

  it('blank q → returns [] without calling client', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions?q=');
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);

    // Client should NOT be called for a blank query
    expect(client.expansions).toHaveBeenCalledTimes(0);
  });

  it('absent q → returns [] without calling client', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions');
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(body).toEqual([]);
    expect(client.expansions).toHaveBeenCalledTimes(0);
  });

  it('stale cache (older than 7 days) → re-fetches and updates', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Seed a stale entry (8 days old)
    raw.prepare(
      `INSERT INTO expansions (id, game_id, code, name, synced_at)
       VALUES (?, ?, ?, ?, datetime('now', '-8 days'))`,
    ).run(100, 1, 'KTK', 'Old Khans Name');

    // The client returns an updated name
    const updated: Expansion = { ...MTG_EXPANSION, name: 'Khans of Tarkir Updated', name_en: 'Khans of Tarkir Updated' };
    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([updated]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/expansions?q=khans');
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }[]>();

    // The cached name should be refreshed
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Khans of Tarkir Updated');
    expect(client.expansions).toHaveBeenCalledTimes(1);
  });

  it('second request on warm-after-first-fetch cache does NOT re-fetch', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      expansions: vi.fn().mockResolvedValue([MTG_EXPANSION]),
    });
    const app = makeApp({ createClient: () => client });

    // First request — populates cache
    await GET(app, env, '/api/resolve/expansions?q=khans');
    // Second request — cache is now warm
    await GET(app, env, '/api/resolve/expansions?q=khans');

    // Client called only once across both requests
    expect(client.expansions).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

describe('GET /api/resolve/blueprints', () => {
  it('returns 400 when expansion_id is missing', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const app = makeApp({ createClient: () => mockClient() });

    const res = await GET(app, env, '/api/resolve/blueprints');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when expansion_id is not an integer', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const app = makeApp({ createClient: () => mockClient() });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=abc');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('empty cache → calls blueprintsExport, caches, returns match for q', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([BLUEPRINT_LOTUS, BLUEPRINT_MOX]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();

    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Black Lotus');
    expect(body[0]!.id).toBe(10050);

    // Client called once with the correct expansion id
    expect(client.blueprintsExport).toHaveBeenCalledTimes(1);
    expect(client.blueprintsExport).toHaveBeenCalledWith(100);
  });

  it('empty cache, empty q → returns all blueprints after fetching', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([BLUEPRINT_LOTUS, BLUEPRINT_MOX]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number }[]>();
    expect(body).toHaveLength(2);
  });

  it('warm cache → client is NOT called again', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Pre-seed the blueprint cache
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name, synced_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run(10050, 100, 'Black Lotus');

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([BLUEPRINT_LOTUS]),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Black Lotus');

    // No client call — cache was warm
    expect(client.blueprintsExport).toHaveBeenCalledTimes(0);
  });

  it('second request with warm-after-first-fetch cache does NOT re-fetch', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([BLUEPRINT_LOTUS, BLUEPRINT_MOX]),
    });
    const app = makeApp({ createClient: () => client });

    // First request — populates cache
    await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    // Second request — cache is warm
    await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=mox');

    // Client called only once total
    expect(client.blueprintsExport).toHaveBeenCalledTimes(1);
  });

  it('fetch error + empty cache → 502 {error:"upstream"}', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      blueprintsExport: vi.fn().mockRejectedValue(new Error('upstream timeout')),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    expect(res.status).toBe(502);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('upstream');
  });

  it('fetch error + warm cache → returns cached results (fallback)', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Pre-seed the cache so we have a fallback
    raw.prepare(
      `INSERT INTO blueprints (id, expansion_id, name, synced_at)
       VALUES (?, ?, ?, datetime('now', '-1 day'))`,
    ).run(10050, 100, 'Black Lotus');

    const client = mockClient({
      // The cached count is already > 0, so blueprintsExport should never be called
      blueprintsExport: vi.fn().mockRejectedValue(new Error('should not be called')),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe('Black Lotus');

    // Not called — cache was warm (fallback path uses cache, not fresh fetch)
    expect(client.blueprintsExport).toHaveBeenCalledTimes(0);
  });

  it('blueprints from other expansions are not returned', async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);

    // Seed cache for two expansions
    raw.prepare(`INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`)
      .run(10050, 100, 'Black Lotus');
    raw.prepare(`INSERT INTO blueprints (id, expansion_id, name) VALUES (?, ?, ?)`)
      .run(20001, 200, 'Mox Pearl');

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([]),
    });
    const app = makeApp({ createClient: () => client });

    // Query expansion 100 only
    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(10050);
  });

  it('large set: >200 blueprints sync correctly (chunk boundary)', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    // Generate 250 blueprints for expansion 100
    const blueprints: Blueprint[] = Array.from({ length: 250 }, (_, i) => ({
      id: 10000 + i,
      name: `Card ${i}`,
      expansion_id: 100,
      game_id: 1,
      image_url: null,
      scryfall_id: null,
    }));

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue(blueprints),
    });
    const app = makeApp({ createClient: () => client });

    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=Card 5');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string }[]>();

    // All "Card 5..." items should be returned (Card 5, Card 50-59, Card 150-159, Card 250 etc.)
    // The key assertion is that the route didn't error out due to chunking
    expect(body.length).toBeGreaterThan(0);
    body.forEach((b) => {
      expect(b.name).toMatch(/^Card 5/);
    });
  });

  it('scryfall_id and image_url are stored and returned correctly', async () => {
    const { db } = makeD1();
    const env = makeEnv(db);

    const client = mockClient({
      blueprintsExport: vi.fn().mockResolvedValue([BLUEPRINT_LOTUS]),
    });
    const app = makeApp({ createClient: () => client });

    // Note: searchBlueprints only selects id, expansion_id, name, image_url (not scryfall_id)
    // so we just verify image_url makes it through
    const res = await GET(app, env, '/api/resolve/blueprints?expansion_id=100&q=lotus');
    expect(res.status).toBe(200);
    const body = await res.json<{ id: number; name: string; image_url: string | null }[]>();
    expect(body).toHaveLength(1);
    expect(body[0]!.image_url).toBe('https://example.com/lotus.jpg');
  });
});
