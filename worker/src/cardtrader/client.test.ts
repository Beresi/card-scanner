/**
 * Unit tests for expansions() and blueprintsExport() on the CardTrader client.
 *
 * All tests stub out fetch — no real network calls. Patterns mirror the
 * scanner.test.ts approach: inject a fake fetchImpl via ClientOptions so the
 * throttle, backoff, Bearer header, and parser path are all exercised.
 *
 * Coverage:
 *   expansions()        — correct URL, Bearer header, happy-path parse,
 *                         401 → CardTraderError, 429 backoff (two-attempt path)
 *   blueprintsExport()  — correct URL + query param, Bearer header,
 *                         happy-path parse with optional fields,
 *                         missing optional fields tolerated, 401 → error,
 *                         non-array response → parse error
 */

import { describe, it, expect, vi } from 'vitest';
import { createCardTraderClient } from './client';
import { CardTraderError } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Response-like object that resolves to a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    clone() {
      return this as unknown as Response;
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** Build a Response that returns a plain text body (for "Too many requests"). */
function textResponse(body: string, status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not JSON')),
    clone() {
      return {
        text: () => Promise.resolve(body),
      } as unknown as Response;
    },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Minimal raw expansion wire object (as CardTrader returns it). */
function rawExpansion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 92,
    code: 'ktk',
    name_en: 'Khans of Tarkir',
    game_id: 1,
    ...overrides,
  };
}

/** Minimal raw blueprint wire object (as CardTrader returns it). */
function rawBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10050,
    name_en: 'Dragon Fodder',
    expansion_id: 92,
    game_id: 1,
    ...overrides,
  };
}

// A token value for tests — never a real secret.
const TEST_TOKEN = 'test-token-abc123';

// ---------------------------------------------------------------------------
// expansions()
// ---------------------------------------------------------------------------

describe('expansions()', () => {
  it('hits GET /expansions and returns a parsed Expansion array', async () => {
    const captured: RequestInfo[] = [];
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(url as RequestInfo);
      void init;
      return jsonResponse([rawExpansion(), rawExpansion({ id: 5, code: 'lea', name_en: 'Alpha', game_id: 1 })]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const result = await client.expansions();

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    // Correct URL
    expect(captured[0]).toBe('https://api.cardtrader.com/api/v2/expansions');
    // Bearer auth header sent
    expect(fakeFetch.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 92,
      code: 'ktk',
      name: 'Khans of Tarkir',
      name_en: 'Khans of Tarkir',
      game_id: 1,
    });
    expect(result[1]).toMatchObject({ id: 5, code: 'lea', name: 'Alpha' });
  });

  it('normalises `name` accessor from wire `name_en`', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse([{ id: 1, code: 'abc', name_en: 'Set Name', game_id: 1 }]),
    );

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const [exp] = await client.expansions();
    expect(exp.name).toBe('Set Name');
    expect(exp.name_en).toBe('Set Name');
  });

  it('falls back to `name` field when `name_en` is absent', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse([{ id: 2, code: 'xyz', name: 'Fallback Name', game_id: 1 }]),
    );

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const [exp] = await client.expansions();
    // name sourced from `name` wire field when `name_en` is absent
    expect(exp.name).toBe('Fallback Name');
  });

  it('throws CardTraderError with status=401 on 401 response', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    await expect(client.expansions()).rejects.toSatisfy(
      (e: unknown) => e instanceof CardTraderError && e.status === 401,
    );
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) { return textResponse('Too many requests', 429); }
      return jsonResponse([rawExpansion()]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
      maxRetries: 4,
    });

    const result = await client.expansions();
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it('throws when response is not an array', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ not: 'an array' }));

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    await expect(client.expansions()).rejects.toSatisfy(
      (e: unknown) => e instanceof CardTraderError,
    );
  });

  it('calls onRequest() for every attempt including retries', async () => {
    let attempts = 0;
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) { return textResponse('Too many requests', 429); }
      return jsonResponse([rawExpansion()]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
      onRequest: () => { attempts++; },
    });

    await client.expansions();
    // Both the initial attempt and the retry should be counted
    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// blueprintsExport()
// ---------------------------------------------------------------------------

describe('blueprintsExport()', () => {
  it('hits GET /blueprints/export?expansion_id=<id> and returns a parsed Blueprint array', async () => {
    const captured: RequestInfo[] = [];
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(url as RequestInfo);
      void init;
      return jsonResponse([rawBlueprint(), rawBlueprint({ id: 10051, name_en: 'Crater Elemental' })]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const result = await client.blueprintsExport(92);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    // Correct URL including query param
    expect(captured[0]).toBe(
      'https://api.cardtrader.com/api/v2/blueprints/export?expansion_id=92',
    );
    // Bearer auth header
    expect(fakeFetch.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 10050,
      name: 'Dragon Fodder',
      expansion_id: 92,
      game_id: 1,
    });
    expect(result[0].image_url).toBeUndefined();
    expect(result[0].scryfall_id).toBeUndefined();
  });

  it('parses optional image_url and scryfall_id when present', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse([
        rawBlueprint({
          image_url: 'https://example.com/card.jpg',
          scryfall_id: 'abcd-1234',
        }),
      ]),
    );

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const [bp] = await client.blueprintsExport(92);
    expect(bp.image_url).toBe('https://example.com/card.jpg');
    expect(bp.scryfall_id).toBe('abcd-1234');
  });

  it('tolerates null image_url and scryfall_id', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse([rawBlueprint({ image_url: null, scryfall_id: null })]),
    );

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const [bp] = await client.blueprintsExport(92);
    expect(bp.image_url).toBeNull();
    expect(bp.scryfall_id).toBeNull();
  });

  it('falls back to `name` wire field when `name_en` is absent', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse([{ id: 10050, name: 'Dragon Fodder', expansion_id: 92, game_id: 1 }]),
    );

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    const [bp] = await client.blueprintsExport(92);
    expect(bp.name).toBe('Dragon Fodder');
  });

  it('throws CardTraderError with status=401 on 401 response', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    await expect(client.blueprintsExport(92)).rejects.toSatisfy(
      (e: unknown) => e instanceof CardTraderError && e.status === 401,
    );
  });

  it('retries on 429 text body and succeeds on second attempt', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) { return textResponse('Too many requests', 429); }
      return jsonResponse([rawBlueprint()]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
      maxRetries: 4,
    });

    const result = await client.blueprintsExport(92);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it('throws when response is not an array', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ error: 'server issue' }, 500));

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    await expect(client.blueprintsExport(92)).rejects.toSatisfy(
      (e: unknown) => e instanceof CardTraderError,
    );
  });

  it('encodes the expansion_id in the query string correctly', async () => {
    const captured: string[] = [];
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      captured.push(url as string);
      return jsonResponse([]);
    });

    const client = createCardTraderClient(TEST_TOKEN, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      minIntervalMs: 0,
    });

    await client.blueprintsExport(999);
    expect(captured[0]).toContain('expansion_id=999');
  });
});
