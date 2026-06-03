/**
 * Cart route tests — GET /api/cart, POST /api/cart/add, POST /api/cart/remove.
 *
 * Coverage:
 *  1. GET /api/cart returns Cart JSON from the (mocked) client.
 *  2. GET /api/cart without Bearer → 401.
 *  3. POST /api/cart/add valid body → calls cartAdd, returns Cart.
 *  4. POST /api/cart/add invalid body → 400 invalid_request.
 *  5. POST /api/cart/remove valid body → calls cartRemove, returns Cart.
 *  6. GUARDRAIL: POST /api/cart/purchase → 404 (route does not exist, anti-auto-buy regression).
 *  7. GET /api/cart attaches `meta` from enrichment (source:'deal' and source:'name').
 *  8. GET /api/cart returns 200 without meta when enrichment throws (best-effort).
 *  9. GET /api/cart fills stock/condition/language/foil for 'name'-sourced items via marketplace.
 * 10. GET /api/cart returns 200 with un-stocked name meta when marketplaceProducts rejects.
 *
 * Strategy: vi.mock the CardTrader client module so no real HTTP is ever made.
 * The repo enrichment function is also mocked — tests that don't need enrichment
 * have it return an empty Map; specific enrichment tests control its resolved value.
 * One fresh Hono app is built per describe block to keep test state isolated.
 *
 * Auth: matches the Bearer gate in index.ts / routes.test.ts.
 * Money assertions use integer cents only.
 * PRD §10; CLAUDE.md "No purchase path" invariant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { cartRouter } from './cart';
import type { Env } from '../index';
import type { Cart, MarketplaceQuery } from '../cardtrader/types';

/** Narrow a MarketplaceQuery to its blueprintId (tests only ever pass that form). */
function probedBlueprintId(q: MarketplaceQuery): number {
  return (q as { blueprintId: number }).blueprintId;
}
import type { CartItemMeta } from './cart';

// ---------------------------------------------------------------------------
// Mock the CardTrader client module.
//
// cart.ts calls createCardTraderClient(token) to get a client; we replace the
// factory with one that returns our controllable stub. The stub starts with
// `getCart`, `cartAdd`, and `cartRemove` resolving to the EMPTY_CART fixture;
// individual tests override them per-case.
// ---------------------------------------------------------------------------

vi.mock('../cardtrader/client', () => {
  return {
    createCardTraderClient: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock the repo enrichment function.
//
// cart.ts calls getCartEnrichment(c.env.DB, items) after getCart().  We replace
// it with a controllable mock; tests that only care about cart shape set it to
// return an empty Map; enrichment-specific tests control its resolved value.
// ---------------------------------------------------------------------------

vi.mock('../db/repo', () => {
  return {
    getCartEnrichment: vi.fn(),
  };
});

// Import AFTER vi.mock so we get the mocked modules.
import { createCardTraderClient } from '../cardtrader/client';
import { getCartEnrichment } from '../db/repo';
import type { CartItemMeta as RepoCartItemMeta, CartCandidatePrinting, CartEnrichmentResult } from '../db/repo';
const mockCreateClient = vi.mocked(createCardTraderClient);
const mockGetCartEnrichment = vi.mocked(getCartEnrichment);

/**
 * Helper: build the CartEnrichmentResult { meta, candidates } shape that
 * getCartEnrichment now returns, from a plain meta map and optional candidates.
 */
function enrichmentResult(
  meta: Map<number, RepoCartItemMeta>,
  candidates: Map<number, CartCandidatePrinting[]> = new Map(),
): CartEnrichmentResult {
  return { meta, candidates };
}

// ---------------------------------------------------------------------------
// Fixtures — integer cents only; no floats.
// ---------------------------------------------------------------------------

/** Minimal empty cart used as a default resolved value. */
const EMPTY_CART: Cart = {
  id: 1001,
  subcarts: [],
};

/** A cart with one subcart and one item (money as integer cents).
 *
 * Per the live CardTrader /cart API all money lives at the TOP-LEVEL cart object.
 * Subcarts carry only id, seller, via_cardtrader_zero, and cart_items — no money.
 */
const CART_WITH_ITEM: Cart = {
  id: 1001,
  subtotal: { cents: 3200, currency: 'USD' },     // top-level — integer cents
  shipping_cost: { cents: 400, currency: 'USD' },  // top-level — integer cents
  subcarts: [
    {
      id: 501,
      seller: { id: 99, username: 'seller_alice' },
      via_cardtrader_zero: false,
      cart_items: [
        {
          quantity: 2,
          price_cents: 1600,       // 16¢ each — integer cents
          price_currency: 'USD',
          product: { id: 42001, name_en: 'Black Lotus' },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Test plumbing — mirrors routes.test.ts
// ---------------------------------------------------------------------------

const BEARER = 'test-desktop-token';

function makeEnv(): Env {
  return {
    DB: {} as D1Database, // cart routes never touch D1
    CARDTRADER_API_TOKEN: 'ct-fake',
    TELEGRAM_BOT_TOKEN: 'tg-fake',
    TELEGRAM_CHAT_ID: 'chat-fake',
    DESKTOP_AUTH_TOKEN: BEARER,
  };
}

/** Build a Hono app with the same auth gate as index.ts, mounting cartRouter. */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();

  // Auth gate — identical to index.ts and routes.test.ts
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== c.env.DESKTOP_AUTH_TOKEN) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.route('/api/cart', cartRouter);

  // Explicit 404 catch-all so /api/cart/purchase returns 404, not Hono's
  // default behaviour (which may vary across versions).
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}

const BASE = 'http://localhost';

async function fetch_(
  app: ReturnType<typeof makeApp>,
  url: string,
  opts: RequestInit & { auth?: boolean },
): Promise<Response> {
  const { auth = true, ...rest } = opts;
  const headers: Record<string, string> = {
    ...(rest.headers as Record<string, string>),
  };
  if (auth) { headers['Authorization'] = `Bearer ${BEARER}`; }
  return app.fetch(new Request(url, { ...rest, headers }), makeEnv());
}

const GET = (app: ReturnType<typeof makeApp>, path: string, auth = true) =>
  fetch_(app, path, { method: 'GET', auth });

const POST = (
  app: ReturnType<typeof makeApp>,
  path: string,
  body: unknown,
  auth = true,
) =>
  fetch_(app, path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    auth,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cart', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: enrichment returns empty Maps (no meta on any item).
    mockGetCartEnrichment.mockResolvedValue(enrichmentResult(new Map()));
  });

  it('returns the Cart JSON the mocked client returns (200)', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    const body = await res.json<Cart>();
    expect(body.id).toBe(1001);
    expect(body.subcarts).toHaveLength(1);

    const subcart = body.subcarts[0]!;
    expect(subcart.cart_items).toHaveLength(1);

    const item = subcart.cart_items[0]!;
    // Money assertions — integer cents only, never floats.
    // All money is top-level on the cart, never on subcarts.
    expect(item.price_cents).toBe(1600);
    expect(Number.isInteger(item.price_cents)).toBe(true);
    expect(body.subtotal!.cents).toBe(3200);
    expect(Number.isInteger(body.subtotal!.cents)).toBe(true);
    expect(body.shipping_cost!.cents).toBe(400);
    expect(Number.isInteger(body.shipping_cost!.cents)).toBe(true);
  });

  it('returns 401 when Authorization header is absent', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(EMPTY_CART),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`, false);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
  });

  it('returns an empty subcarts array for an empty cart (200)', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(EMPTY_CART),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);
    const body = await res.json<Cart>();
    expect(body.subcarts).toEqual([]);
  });

  it('attaches meta from enrichment (source:deal) to each matching cart item', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const dealMeta: CartItemMeta = {
      source: 'deal',
      blueprint_id: 77001,
      image_url: 'https://cdn.cardtrader.com/images/bl/77001.jpg',
      expansion_name: 'Alpha',
      condition: 'Near Mint',
      language: 'en',
      foil: 0,
      available_quantity: 3,
    };
    // CART_WITH_ITEM has one item with product.id = 42001.
    mockGetCartEnrichment.mockResolvedValue(enrichmentResult(new Map([[42001, dealMeta]])));

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item).toBeDefined();
    // Core cart fields must still be present.
    expect(item.price_cents).toBe(1600);
    expect(item.product.id).toBe(42001);
    // Enrichment meta attached.
    expect(item.meta).toEqual(dealMeta);
    expect(item.meta.source).toBe('deal');
    expect(item.meta.foil).toBe(0);               // integer, not boolean
    expect(item.meta.available_quantity).toBe(3);
  });

  it('attaches meta from enrichment (source:name) when deal lookup misses', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      // Best-guess blueprint has no marketplace listings → no stock filled.
      marketplaceProducts: vi.fn().mockResolvedValue({}),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const nameMeta: CartItemMeta = {
      source: 'name',
      blueprint_id: 77002,
      image_url: 'https://cdn.cardtrader.com/images/bl/77002.jpg',
      expansion_name: 'Beta',
    };
    // No candidate printings → marketplace probe falls back to the best-guess
    // blueprint, which here returns no listings (empty), so no stock is filled.
    mockGetCartEnrichment.mockResolvedValue(
      enrichmentResult(new Map([[42001, nameMeta]])),
    );

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item.meta).toEqual(nameMeta);
    expect(item.meta.source).toBe('name');
    // Name-match meta has no condition/language/foil/available_quantity.
    expect(item.meta.condition).toBeUndefined();
    expect(item.meta.foil).toBeUndefined();
    expect(item.meta.available_quantity).toBeUndefined();
  });

  it("fills available_quantity/condition/language/foil on 'name'-sourced meta via marketplace", async () => {
    // CART_WITH_ITEM has one item: product.id = 42001, name_en = 'Black Lotus'.
    // D1 enrichment resolves it as source:'name' with blueprint_id 77002 but
    // no stock data — that is the starting state before the marketplace pass.
    const nameMeta: CartItemMeta = {
      source: 'name',
      blueprint_id: 77002,
      image_url: 'https://cdn.cardtrader.com/images/bl/77002.jpg',
      expansion_name: 'Alpha',
    };
    mockGetCartEnrichment.mockResolvedValue(
      enrichmentResult(
        new Map([[42001, nameMeta]]),
        new Map([[42001, [
          {
            blueprint_id: 77002,
            image_url: 'https://cdn.cardtrader.com/images/bl/77002.jpg',
            expansion_name: 'Alpha',
          },
        ]]]),
      ),
    );

    // The marketplace response for blueprint 77002 contains the exact product
    // with id 42001 — the route finds it and merges the stock data into meta.
    const marketplaceMock = vi.fn().mockResolvedValue({
      '77002': [
        {
          id: 42001,
          blueprint_id: 77002,
          name_en: 'Black Lotus',
          quantity: 5,
          price: { cents: 1200000, currency: 'EUR' },
          properties_hash: {
            condition: 'Near Mint',
            mtg_language: 'en',
            mtg_foil: false,
          },
          graded: false,
          on_vacation: false,
        },
      ],
    });

    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: marketplaceMock,
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item).toBeDefined();

    // Core cart fields must still be present.
    expect(item.price_cents).toBe(1600);
    expect(item.product.id).toBe(42001);

    // Source and static enrichment fields unchanged.
    expect(item.meta.source).toBe('name');
    expect(item.meta.blueprint_id).toBe(77002);
    expect(item.meta.image_url).toBe('https://cdn.cardtrader.com/images/bl/77002.jpg');
    expect(item.meta.expansion_name).toBe('Alpha');

    // Stock data filled in from the marketplace lookup.
    expect(item.meta.available_quantity).toBe(5);
    expect(item.meta.condition).toBe('Near Mint');
    expect(item.meta.language).toBe('en');
    expect(item.meta.foil).toBe(0);  // mtg_foil: false → 0

    // Confirm exactly one marketplace call was made (one distinct blueprint).
    expect(marketplaceMock).toHaveBeenCalledOnce();
    expect(marketplaceMock).toHaveBeenCalledWith({ blueprintId: 77002, language: 'en' });
  });

  it("resolves the EXACT printing by probing candidates: first miss, second hit overrides meta", async () => {
    // CART_WITH_ITEM has one item: product.id = 42001, name_en = 'Black Lotus'.
    // D1 best-guess meta points at the WRONG printing (88001 / 'Base Set'); the
    // candidate list has a second printing (88002 / 'Collectors') that is the
    // actual variant in the cart. The probe must find it and override the meta.
    const wrongGuess: CartItemMeta = {
      source: 'name',
      blueprint_id: 88001,
      image_url: 'https://cdn.cardtrader.com/images/bl/88001.jpg',
      expansion_name: 'Base Set',
    };
    mockGetCartEnrichment.mockResolvedValue(
      enrichmentResult(
        new Map([[42001, wrongGuess]]),
        new Map([[42001, [
          // Newest-first ordering: base set guessed first, collectors second.
          {
            blueprint_id: 88001,
            image_url: 'https://cdn.cardtrader.com/images/bl/88001.jpg',
            expansion_name: 'Base Set',
          },
          {
            blueprint_id: 88002,
            image_url: 'https://cdn.cardtrader.com/images/bl/88002.jpg',
            expansion_name: 'Collectors',
          },
        ]]]),
      ),
    );

    // First probed blueprint (88001) does NOT contain product 42001; the second
    // (88002) does — the route must override meta to 88002 and fill stock.
    const marketplaceMock = vi.fn((q: MarketplaceQuery) => {
      const blueprintId = probedBlueprintId(q);
      if (blueprintId === 88001) {
        // Wrong printing: contains some OTHER product, not 42001.
        return Promise.resolve({
          '88001': [
            {
              id: 99999,
              blueprint_id: 88001,
              name_en: 'Black Lotus',
              quantity: 1,
              price: { cents: 100, currency: 'EUR' },
              properties_hash: { condition: 'Played', mtg_language: 'en', mtg_foil: false },
              graded: false,
              on_vacation: false,
            },
          ],
        });
      }
      // Correct printing: contains the cart's exact product 42001.
      return Promise.resolve({
        '88002': [
          {
            id: 42001,
            blueprint_id: 88002,
            name_en: 'Black Lotus',
            quantity: 4,
            price: { cents: 1500000, currency: 'EUR' },
            properties_hash: { condition: 'Near Mint', mtg_language: 'en', mtg_foil: true },
            graded: false,
            on_vacation: false,
          },
        ],
      });
    });

    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: marketplaceMock,
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item).toBeDefined();

    // Meta OVERRIDDEN to the correct (second) candidate's printing.
    expect(item.meta.source).toBe('name');
    expect(item.meta.blueprint_id).toBe(88002);
    expect(item.meta.image_url).toBe('https://cdn.cardtrader.com/images/bl/88002.jpg');
    expect(item.meta.expansion_name).toBe('Collectors');

    // Stock filled from the matching printing.
    expect(item.meta.available_quantity).toBe(4);
    expect(item.meta.condition).toBe('Near Mint');
    expect(item.meta.language).toBe('en');
    expect(item.meta.foil).toBe(1);  // mtg_foil: true → 1

    // Both candidates were probed (first miss, then hit) — and in order.
    expect(marketplaceMock).toHaveBeenCalledTimes(2);
    expect(marketplaceMock).toHaveBeenNthCalledWith(1, { blueprintId: 88001, language: 'en' });
    expect(marketplaceMock).toHaveBeenNthCalledWith(2, { blueprintId: 88002, language: 'en' });
  });

  it('respects the global probe cap (15) across many candidate printings', async () => {
    // One item, product.id = 42001. Give it 20 candidate printings, NONE of
    // which contain product 42001. The per-item cap (4) bounds it well under the
    // global cap, so we assert at most 4 probes for this single item — proving
    // one many-printing card cannot exhaust the whole budget.
    const wrongGuess: CartItemMeta = {
      source: 'name',
      blueprint_id: 90000,
      image_url: null,
      expansion_name: 'Printing 0',
    };
    const manyCandidates: CartCandidatePrinting[] = Array.from({ length: 20 }, (_, i) => ({
      blueprint_id: 90000 + i,
      image_url: null,
      expansion_name: `Printing ${i}`,
    }));
    mockGetCartEnrichment.mockResolvedValue(
      enrichmentResult(
        new Map([[42001, wrongGuess]]),
        new Map([[42001, manyCandidates]]),
      ),
    );

    // Every probe returns listings WITHOUT product 42001 → never matches.
    const marketplaceMock = vi.fn((q: MarketplaceQuery) =>
      Promise.resolve({
        [String(probedBlueprintId(q))]: [
          {
            id: 11111,
            blueprint_id: probedBlueprintId(q),
            name_en: 'Black Lotus',
            quantity: 1,
            price: { cents: 100, currency: 'EUR' },
            properties_hash: { condition: 'Played', mtg_language: 'en', mtg_foil: false },
            graded: false,
            on_vacation: false,
          },
        ],
      }),
    );

    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: marketplaceMock,
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // Per-item cap = 4 → at most 4 probes for this single item (never 20),
    // and well within the global cap of 15.
    expect(marketplaceMock).toHaveBeenCalledTimes(4);

    // No candidate matched → best-guess meta retained, no stock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item.meta.blueprint_id).toBe(90000);
    expect(item.meta.available_quantity).toBeUndefined();
  });

  it('caps TOTAL probes at the global limit (15) across many items', async () => {
    // 6 cart items, each with 4 non-matching candidate printings = 24 potential
    // probes. The global cap of 15 must stop probing partway; later items keep
    // their best-guess meta untouched. (6 items, single subcart.)
    const itemCount = 6;
    const cartManyItems: Cart = {
      id: 2002,
      subtotal: { cents: 100, currency: 'USD' },
      subcarts: [
        {
          id: 600,
          seller: { id: 1, username: 's' },
          via_cardtrader_zero: false,
          cart_items: Array.from({ length: itemCount }, (_, i) => ({
            quantity: 1,
            price_cents: 100,
            price_currency: 'USD',
            product: { id: 50000 + i, name_en: `Card ${i}` },
          })),
        },
      ],
    };

    const meta = new Map<number, CartItemMeta>();
    const cands = new Map<number, CartCandidatePrinting[]>();
    for (let i = 0; i < itemCount; i++) {
      const pid = 50000 + i;
      meta.set(pid, {
        source: 'name',
        blueprint_id: 60000 + i * 10,
        image_url: null,
        expansion_name: `set ${i}`,
      });
      cands.set(pid, Array.from({ length: 4 }, (_, j) => ({
        blueprint_id: 60000 + i * 10 + j,
        image_url: null,
        expansion_name: `set ${i} v${j}`,
      })));
    }
    mockGetCartEnrichment.mockResolvedValue(enrichmentResult(meta, cands));

    // No probe ever matches the cart product → all 4 per-item probes used.
    const marketplaceMock = vi.fn((q: MarketplaceQuery) =>
      Promise.resolve({ [String(probedBlueprintId(q))]: [] }),
    );

    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: marketplaceMock,
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(cartManyItems),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // Global cap = 15: must never exceed it even though 24 probes were possible.
    expect(marketplaceMock).toHaveBeenCalledTimes(15);
  });

  it("returns 200 with un-stocked name meta when marketplaceProducts rejects (best-effort)", async () => {
    // D1 enrichment resolves source:'name' with blueprint but no stock.
    const nameMeta: CartItemMeta = {
      source: 'name',
      blueprint_id: 77002,
      image_url: 'https://cdn.cardtrader.com/images/bl/77002.jpg',
      expansion_name: 'Beta',
    };
    mockGetCartEnrichment.mockResolvedValue(
      enrichmentResult(
        new Map([[42001, nameMeta]]),
        new Map([[42001, [
          {
            blueprint_id: 77002,
            image_url: 'https://cdn.cardtrader.com/images/bl/77002.jpg',
            expansion_name: 'Beta',
          },
        ]]]),
      ),
    );

    // marketplaceProducts rejects — the cart must still return 200 with the
    // original name meta intact (no stock fields, but no crash either).
    const marketplaceMock = vi.fn().mockRejectedValue(new Error('CardTrader 503'));

    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: marketplaceMock,
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    // Must succeed despite marketplace failure.
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    expect(body.id).toBe(1001);
    const item = body.subcarts[0]?.cart_items[0];

    // Source and static fields still present.
    expect(item.meta.source).toBe('name');
    expect(item.meta.blueprint_id).toBe(77002);
    expect(item.meta.expansion_name).toBe('Beta');

    // No stock data — marketplace failed, never set wrong values.
    expect(item.meta.available_quantity).toBeUndefined();
    expect(item.meta.condition).toBeUndefined();
    expect(item.meta.language).toBeUndefined();
    expect(item.meta.foil).toBeUndefined();

    // Core cart fields still present.
    expect(item.price_cents).toBe(1600);
  });

  it('returns 200 without meta when enrichment throws (best-effort)', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    // Simulate a DB failure in the enrichment path.
    mockGetCartEnrichment.mockRejectedValue(new Error('D1 connection timeout'));

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    // Must still succeed — enrichment failure is non-fatal.
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    expect(body.id).toBe(1001);
    const item = body.subcarts[0]?.cart_items[0];
    // meta must be absent — enrichment failed silently.
    expect(item.meta).toBeUndefined();
    // Core cart fields still present.
    expect(item.price_cents).toBe(1600);
  });

  it('items with no enrichment hit carry no meta property', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn().mockResolvedValue(CART_WITH_ITEM),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    // Empty Maps — nothing resolved.
    mockGetCartEnrichment.mockResolvedValue(enrichmentResult(new Map()));

    const app = makeApp();
    const res = await GET(app, `${BASE}/api/cart`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json<any>();
    const item = body.subcarts[0]?.cart_items[0];
    expect(item.meta).toBeUndefined();
    expect(item.price_cents).toBe(1600);
  });
});

describe('POST /api/cart/add', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls cartAdd with product_id and quantity, returns updated Cart (200)', async () => {
    const cartAddMock = vi.fn().mockResolvedValue(CART_WITH_ITEM);
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: cartAddMock,
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, {
      product_id: 42001,
      quantity: 2,
    });
    expect(res.status).toBe(200);

    // Verify cartAdd was called with the exact args from the body
    expect(cartAddMock).toHaveBeenCalledOnce();
    expect(cartAddMock).toHaveBeenCalledWith(42001, 2);

    const body = await res.json<Cart>();
    expect(body.id).toBe(1001);
    // Money is top-level on the cart — integer cents only
    expect(Number.isInteger(body.subtotal!.cents)).toBe(true);
  });

  it('returns 400 when product_id is missing from the body', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, { quantity: 1 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when quantity is missing from the body', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, { product_id: 42001 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when quantity is zero (not a positive integer)', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, {
      product_id: 42001,
      quantity: 0,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when product_id is negative', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, {
      product_id: -1,
      quantity: 1,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when product_id is a non-numeric string', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/add`, {
      product_id: 'abc',
      quantity: 1,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when body is not valid JSON', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await fetch_(app, `${BASE}/api/cart/add`, {
      method: 'POST',
      body: 'not json{{',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 401 when Authorization header is absent', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(
      app,
      `${BASE}/api/cart/add`,
      { product_id: 1, quantity: 1 },
      false,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/cart/remove', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls cartRemove with product_id and quantity, returns updated Cart (200)', async () => {
    const cartRemoveMock = vi.fn().mockResolvedValue(EMPTY_CART);
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: cartRemoveMock,
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/remove`, {
      product_id: 42001,
      quantity: 1,
    });
    expect(res.status).toBe(200);

    // Verify cartRemove was called with the exact args
    expect(cartRemoveMock).toHaveBeenCalledOnce();
    expect(cartRemoveMock).toHaveBeenCalledWith(42001, 1);

    const body = await res.json<Cart>();
    expect(body.id).toBe(1001);
    expect(body.subcarts).toEqual([]);
  });

  it('returns 400 when product_id is missing', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/remove`, { quantity: 1 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when quantity is zero', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/remove`, {
      product_id: 42001,
      quantity: 0,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('returns 401 when Authorization header is absent', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(
      app,
      `${BASE}/api/cart/remove`,
      { product_id: 1, quantity: 1 },
      false,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GUARDRAIL — anti-auto-buy regression (PRD §10, CLAUDE.md "No purchase path")
// ---------------------------------------------------------------------------

describe('GUARDRAIL: /api/cart/purchase does not exist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('POST /api/cart/purchase → 404 (route intentionally absent)', async () => {
    mockCreateClient.mockReturnValue({
      info: vi.fn(),
      marketplaceProducts: vi.fn(),
      expansions: vi.fn(),
      blueprintsExport: vi.fn(),
      getCart: vi.fn(),
      cartAdd: vi.fn(),
      cartRemove: vi.fn(),
    });

    const app = makeApp();
    const res = await POST(app, `${BASE}/api/cart/purchase`, {
      product_id: 42001,
      quantity: 1,
    });
    // Must be 404 — this route must never be added.
    expect(res.status).toBe(404);
  });
});
