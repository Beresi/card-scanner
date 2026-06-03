/**
 * GET  /api/cart         — view the current CardTrader cart (enriched with D1 meta).
 * POST /api/cart/add     — add a product to the cart.
 * POST /api/cart/remove  — remove a product from the cart.
 *
 * NO /cart/purchase route — auto-buy is forbidden (owner checks out manually on cardtrader.com).
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * The GET route enriches cart items with display metadata from D1 (deals + blueprints),
 * then does a best-effort marketplace pass to fill stock/condition for 'name'-sourced items.
 * add/remove proxy to CardTrader only (no D1 reads).
 *
 * PRD §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { createCardTraderClient } from '../cardtrader/client';
import type { CardTraderClient } from '../cardtrader/client';
import { CardTraderError } from '../cardtrader/types';
import type { CartItem, Subcart } from '../cardtrader/types';
import { getCartEnrichment } from '../db/repo';
import type { CartItemMeta, CartCandidatePrinting } from '../db/repo';
import { parseIntParam } from './validate';

// Re-export so the desktop DTO contract can import the type from one place.
export type { CartItemMeta } from '../db/repo';

export const cartRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Marketplace stock enrichment for 'name'-sourced cart items.
//
// Cap is a latency / rate-limit guard: each lookup costs ~1 req/s through the
// client throttle, so 15 lookups ≤ ~15 s — acceptable within a Worker CPU
// budget and polite to the CardTrader API.
// ---------------------------------------------------------------------------

const MAX_CART_STOCK_LOOKUPS = 15;

// Per-item cap on candidate-printing probes. A single many-printing card (e.g.
// a card with base / collectors / promo / borderless variants) can't consume
// the entire global budget — it gets at most this many probes before we move on.
const MAX_CANDIDATE_PROBES_PER_ITEM = 4;

/**
 * Best-effort marketplace pass — resolves the EXACT printing for each
 * 'name'-sourced cart item by probing its candidate printings against the live
 * marketplace, then fills `available_quantity`, `condition`, `language`, and
 * `foil` (and OVERRIDES blueprint_id/image_url/expansion_name to the matched
 * printing) on the meta entry.
 *
 * A card name can have many printings, each a different blueprint_id; D1's
 * best-guess meta may point at the wrong variant. For each candidate printing
 * (newest first, capped) we call marketplaceProducts and look for a product
 * whose id === the cart line's product.id. The FIRST candidate that contains it
 * is the correct variant — we override the meta with that candidate's display
 * fields and merge in the live stock, then stop probing that item.
 *
 * Mutates the `enrichment` Map in-place.  A failure on any individual lookup
 * (or the entire pass) is silently swallowed so the cart response is never
 * blocked.  'deal'-sourced items are skipped — their stock data is already
 * authoritative from the D1 scan.  If NO candidate matches, the existing
 * best-guess meta is left as-is (image/set shown, just no stock).
 *
 * Probe budget: every candidate probe counts against MAX_CART_STOCK_LOOKUPS
 * (global) and MAX_CANDIDATE_PROBES_PER_ITEM (per item). Once the global cap is
 * reached, remaining items keep their best-guess meta.
 */
async function fillNameSourcedStock(
  client: CardTraderClient,
  enrichment: Map<number, CartItemMeta>,
  candidates: Map<number, CartCandidatePrinting[]>,
  subcarts: Subcart[],
): Promise<void> {
  // Build a flat list of (productId, cartItem) pairs whose meta is 'name' and
  // whose available_quantity has not yet been filled.
  const namePairs: { productId: number; item: CartItem }[] = [];
  for (const subcart of subcarts) {
    for (const item of subcart.cart_items) {
      const meta = enrichment.get(item.product.id);
      if (meta?.source === 'name' && meta.available_quantity === undefined) {
        namePairs.push({ productId: item.product.id, item });
      }
    }
  }

  if (namePairs.length === 0) { return; }

  // Global probe budget across all items, all candidates.
  let probesRemaining = MAX_CART_STOCK_LOOKUPS;

  for (const { productId, item } of namePairs) {
    if (probesRemaining <= 0) { break; }  // global cap exhausted

    const meta = enrichment.get(productId);
    if (!meta) { continue; }

    // Candidate printings for this item; fall back to the best-guess blueprint
    // when D1 returned no candidate list (defensive — should not happen for
    // name-sourced items, but keeps a single probe path).
    let printings = candidates.get(productId);
    if ((!printings || printings.length === 0) && meta.blueprint_id !== undefined) {
      printings = [{
        blueprint_id: meta.blueprint_id,
        image_url: meta.image_url ?? null,
        expansion_name: meta.expansion_name ?? null,
      }];
    }
    if (!printings || printings.length === 0) { continue; }

    let perItemProbes = 0;
    for (const candidate of printings) {
      if (probesRemaining <= 0) { break; }                 // global cap
      if (perItemProbes >= MAX_CANDIDATE_PROBES_PER_ITEM) { break; }  // per-item cap

      probesRemaining -= 1;
      perItemProbes += 1;

      try {
        const resp = await client.marketplaceProducts({
          blueprintId: candidate.blueprint_id,
          language: 'en',
        });
        const products = resp[String(candidate.blueprint_id)] ?? [];

        const match = products.find((p) => p.id === item.product.id);
        if (!match) {
          // This printing doesn't contain the cart's product.id — try the next.
          continue;
        }

        // Correct variant found — override the display fields with this exact
        // candidate's values, then merge the live stock, and stop probing.
        meta.blueprint_id = candidate.blueprint_id;
        meta.image_url = candidate.image_url;
        meta.expansion_name = candidate.expansion_name;
        meta.available_quantity = match.quantity;
        meta.condition = match.properties_hash.condition;
        meta.language = match.properties_hash.mtg_language;
        meta.foil = match.properties_hash.mtg_foil ? 1 : 0;
        break;
      } catch (err) {
        // Per-probe failure is silently swallowed — other candidates/items
        // continue. The probe still counted against the budget.
        console.warn(
          'cart stock lookup failed for blueprint', candidate.blueprint_id,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error mapping — invalid_request → 400, CardTrader auth → 502,
// unexpected → 500 (no internals leaked; token never surfaced in any response).
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (err instanceof CardTraderError) {
    // A 401 from CardTrader means our token is invalid — surface as 502 (bad gateway)
    // without exposing any token detail.
    if (err.status === 401) {
      return c.json({ error: 'cardtrader_auth_failed' }, 502);
    }
    // Other CardTrader API errors (429 exhausted, 5xx, parse failures) → 500.
    console.error('cart route CardTraderError', err.endpoint, err.status, err.message);
    return c.json({ error: 'upstream_error' }, 500);
  }
  console.error('cart route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// GET / — view the current cart (enriched with D1 display metadata)
// ---------------------------------------------------------------------------

cartRouter.get('/', async (c) => {
  try {
    const client = createCardTraderClient(c.env.CARDTRADER_API_TOKEN);
    const cart = await client.getCart();

    // Collect all (productId, nameEn) pairs from every subcart's line items.
    const items: { productId: number; nameEn: string }[] = [];
    for (const subcart of cart.subcarts) {
      for (const item of subcart.cart_items) {
        items.push({ productId: item.product.id, nameEn: item.product.name_en });
      }
    }

    // Best-effort D1 enrichment: a DB error must never fail the cart response.
    let enrichment: Map<number, CartItemMeta> = new Map();
    let candidates: Map<number, CartCandidatePrinting[]> = new Map();
    try {
      const res = await getCartEnrichment(c.env.DB, items);
      enrichment = res.meta;
      candidates = res.candidates;
    } catch (err) {
      // Log but do not propagate — the un-enriched cart is still useful.
      console.warn('cart enrichment failed, returning cart without meta:', err instanceof Error ? err.message : err);
    }

    // Best-effort marketplace pass: resolve the exact printing + fill
    // stock/condition/language/foil for 'name'-sourced items that lack
    // available_quantity (no extra call for 'deal' items — their data is
    // authoritative from D1).
    try {
      await fillNameSourcedStock(client, enrichment, candidates, cart.subcarts);
    } catch (err) {
      // Outer safety net — individual blueprint failures are already caught
      // inside fillNameSourcedStock; this guards against unexpected throws.
      console.warn('cart stock pass failed:', err instanceof Error ? err.message : err);
    }

    // Attach meta to each line item; items with no enrichment hit get no `meta`.
    const enrichedCart = {
      ...cart,
      subcarts: cart.subcarts.map((subcart) => ({
        ...subcart,
        cart_items: subcart.cart_items.map((item) => {
          const meta = enrichment.get(item.product.id);
          return meta !== undefined ? { ...item, meta } : item;
        }),
      })),
    };

    return c.json(enrichedCart);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// POST /add — add a product to the cart
// ---------------------------------------------------------------------------

cartRouter.post('/add', async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // product_id and quantity must be present positive integers.
    const product_id = parseIntParam(
      body['product_id'] !== undefined ? String(body['product_id']) : undefined,
    );
    const quantity = parseIntParam(
      body['quantity'] !== undefined ? String(body['quantity']) : undefined,
    );

    if (product_id === undefined || quantity === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (product_id <= 0 || quantity <= 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const client = createCardTraderClient(c.env.CARDTRADER_API_TOKEN);
    const cart = await client.cartAdd(product_id, quantity);
    return c.json(cart);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// POST /remove — remove a product from the cart
// ---------------------------------------------------------------------------

cartRouter.post('/remove', async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // product_id and quantity must be present positive integers.
    const product_id = parseIntParam(
      body['product_id'] !== undefined ? String(body['product_id']) : undefined,
    );
    const quantity = parseIntParam(
      body['quantity'] !== undefined ? String(body['quantity']) : undefined,
    );

    if (product_id === undefined || quantity === undefined) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (product_id <= 0 || quantity <= 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const client = createCardTraderClient(c.env.CARDTRADER_API_TOKEN);
    const cart = await client.cartRemove(product_id, quantity);
    return c.json(cart);
  } catch (err) {
    return handleError(err, c);
  }
});
