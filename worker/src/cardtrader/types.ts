/**
 * CardTrader API v2 — wire types and boundary parsers.
 *
 * Models only the load-bearing subset of the wire payload; the API carries
 * additional fields (description, bundle_size, signed, altered, etc.) that
 * are not read by any part of this system. Parsers narrow from `unknown` and
 * throw `CardTraderError` on any malformed input. price.cents is an integer
 * in the account's native currency — never parsed to a float here.
 */

// ---------------------------------------------------------------------------
// CardTraderError — typed error thrown at the client boundary.
// Never include the Bearer token in any field (no secrets in logs).
// ---------------------------------------------------------------------------

export class CardTraderError extends Error {
  readonly endpoint: string;
  readonly status: number | undefined;
  /** The blueprint id or expansion id being fetched, when applicable. */
  readonly resourceId: number | undefined;

  constructor(
    message: string,
    endpoint: string,
    status?: number,
    resourceId?: number,
  ) {
    super(message);
    this.name = 'CardTraderError';
    this.endpoint = endpoint;
    this.status = status;
    this.resourceId = resourceId;
  }
}

// ---------------------------------------------------------------------------
// PropertiesHash
//
// `condition` is kept as `string` here — narrowed to `Condition` only inside
// the deal engine after filtering; do not trust the wire value.
// ---------------------------------------------------------------------------

export interface PropertiesHash {
  condition: string;
  mtg_language: string;
  mtg_foil: boolean;
}

// ---------------------------------------------------------------------------
// Product — one seller listing of a blueprint.
// price.cents is an INTEGER — pass through as-is, never divide by 100 here.
// expansion and user are optional: the API may omit them in some contexts.
// ---------------------------------------------------------------------------

export interface Price {
  cents: number;
  currency: string;
}

export interface ProductExpansion {
  id: number;
  code: string;
  name_en: string;
}

export interface ProductUser {
  username: string;
  can_sell_via_hub: boolean;
  country_code: string;
}

export interface Product {
  id: number;
  blueprint_id: number;
  name_en: string;
  quantity: number;
  price: Price;
  properties_hash: PropertiesHash;
  expansion?: ProductExpansion;
  user?: ProductUser;
  graded: boolean;
  on_vacation: boolean;
}

// ---------------------------------------------------------------------------
// MarketplaceResponse — keyed by blueprint id (string) → up to 25 products.
// blueprintId variant returns one key; expansionId variant may return many.
// Callers iterate Object.entries() regardless of which variant produced it.
//
// VERIFY: expansion_id + language filter is unverified (PRD §6 / §13).
// Confirm the language param is honored on the expansionId variant; if not,
// fall back to per-blueprint calls.
// ---------------------------------------------------------------------------

export type MarketplaceResponse = Record<string, Product[]>;

// ---------------------------------------------------------------------------
// MarketplaceQuery
//
// Discriminated union: exactly one of blueprintId or expansionId is required.
// language is always 'en' at call sites; foil is omitted when foil_pref='any'.
// ---------------------------------------------------------------------------

export type MarketplaceQuery =
  | { blueprintId: number; language: string; foil?: boolean }
  | { expansionId: number; language: string; foil?: boolean };

// ---------------------------------------------------------------------------
// Info — minimal shape from GET /info (token-validation / health check).
// Scanner uses this only to confirm the token is valid (non-401).
// ---------------------------------------------------------------------------

export interface Info {
  /** Account id — a stable, always-present token-liveness signal. */
  id: number;
  /** Account display name (may be empty). */
  name: string;
  /** Numeric user id behind the token. */
  user_id: number;
  // NOTE: the real /api/v2/info response ALSO carries `shared_secret` — itself a
  // secret. We deliberately do NOT include or retain it (never stored, never
  // logged). Only the non-sensitive identifying fields above are kept.
}

// ---------------------------------------------------------------------------
// Expansion — expansions cache (set-watching + add-card UX). Minimal per PRD §6.
//
// The CardTrader wire uses `name_en` for the human-readable set name. We
// normalise this to `name` on the parsed shape for consumer convenience and
// keep `name_en` as well so existing callers that reference it still compile.
// ---------------------------------------------------------------------------

export interface Expansion {
  id: number;
  code: string;
  /** Normalised display name (sourced from `name_en` on the wire). */
  name: string;
  /** Raw wire field; same value as `name`. Kept for API-shape fidelity. */
  name_en: string;
  /** game_id is always 1 (MTG) but typed for completeness. */
  game_id: number;
}

// ---------------------------------------------------------------------------
// Blueprint — blueprints cache (add-card search + display). Minimal per PRD §6.
//
// The CardTrader /blueprints/export wire shape is not fully documented; we
// capture the guaranteed fields (id, name, expansion_id, game_id) strictly and
// treat image_url / scryfall_id as optional (absent on many printings).
//
// VERIFY: buy-URL pattern is unverified (PRD §6 / §13).
// Likely: https://www.cardtrader.com/cards/{blueprint_id}
// Confirm the real public URL during build; fall back to a search URL if needed.
// ---------------------------------------------------------------------------

export interface Blueprint {
  id: number;
  /** Card name as returned by the wire (name_en field). */
  name: string;
  expansion_id: number;
  game_id: number;
  /** Card image URL when provided by the API (may be absent). */
  image_url?: string | null;
  /** Scryfall UUID when provided by the API (may be absent). */
  scryfall_id?: string | null;
}

// ---------------------------------------------------------------------------
// Cart — GET /cart, POST /cart/add, POST /cart/remove.
//
// Money fields on the wire come back either as nested objects { cents, currency }
// OR as flat *_cents integers.  The parser handles both forms; missing optional
// fee fields are tolerated (set to undefined) — they vary by seller and payment method.
//
// NEVER call POST /cart/purchase — the owner checks out manually on cardtrader.com.
// ---------------------------------------------------------------------------

/** A money amount as returned by the CartTrader cart API. */
export interface Money {
  cents: number;
  currency: string;
}

/** One line item inside a seller's subcart. */
export interface CartItem {
  quantity: number;
  /** Unit price in cents. */
  price_cents: number;
  price_currency: string;
  product: {
    id: number;
    name_en: string;
  };
}

/**
 * One seller's portion of the cart.
 *
 * NOTE: the live CardTrader /cart response carries NO money fields on subcarts —
 * totals, shipping, and fees are all top-level on the Cart object. A subcart is
 * just seller + line items. (A per-seller subtotal can be derived by summing
 * line items at the display edge.)
 */
export interface Subcart {
  id: number;
  seller: {
    id: number;
    username: string;
  };
  /** True when this seller's items ship via CardTrader Zero. Absent on some carts. */
  via_cardtrader_zero?: boolean;
  cart_items: CartItem[];
}

/**
 * Top-level cart object returned by GET /cart and the cart mutation endpoints.
 *
 * All money lives here (not on subcarts). Every money field is optional — an
 * empty cart omits them, and we never throw on a missing total/fee.
 */
export interface Cart {
  id: number;
  total?: Money;
  subtotal?: Money;
  shipping_cost?: Money;
  safeguard_fee_amount?: Money;
  ct_zero_fee_amount?: Money;
  payment_method_fee_fixed_amount?: Money;
  payment_method_fee_percentage_amount?: Money;
  subcarts: Subcart[];
}

// ---------------------------------------------------------------------------
// Boundary parsers — narrow `unknown` → typed. Pure functions: no I/O.
// Throw CardTraderError on any structural violation.
// ---------------------------------------------------------------------------

/**
 * Parse the GET /expansions response body (an array of expansion objects).
 * Required fields (id, code, game_id) are validated strictly; name is sourced
 * from `name_en` on the wire (the documented field name). If `name_en` is
 * absent but `name` is present we fall back to that, tolerating API variation.
 */
export function parseExpansionArray(raw: unknown): Expansion[] {
  if (!Array.isArray(raw)) {
    throw new CardTraderError(
      '/expansions response: expected an array, got ' + typeof raw,
      '/expansions',
    );
  }
  return raw.map((item, index) => parseExpansion(item, index));
}

/**
 * Parse the GET /blueprints/export response body (an array of blueprint objects).
 * Required fields (id, name, expansion_id, game_id) are validated strictly.
 * Optional fields (image_url, scryfall_id) are extracted when present and
 * well-typed; silently dropped otherwise — the /blueprints/export shape
 * varies across set sizes and API versions.
 */
export function parseBlueprintArray(raw: unknown, expansionId: number): Blueprint[] {
  if (!Array.isArray(raw)) {
    throw new CardTraderError(
      `/blueprints/export?expansion_id=${expansionId} response: expected an array, got ` + typeof raw,
      `/blueprints/export`,
    );
  }
  return raw.map((item, index) => parseBlueprint(item, index, expansionId));
}

/**
 * Validates that `raw` is an object keyed by blueprint id strings, each
 * holding an array of Product records. price.cents is validated as a finite
 * integer and passed through as-is — never divided by 100.
 */
export function parseMarketplaceResponse(raw: unknown): MarketplaceResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(
      'marketplace response: expected an object, got ' + typeof raw,
      '/marketplace/products',
    );
  }

  const result: MarketplaceResponse = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new CardTraderError(
        `marketplace response: key "${key}" is not an array`,
        '/marketplace/products',
      );
    }
    result[key] = value.map((item, index) =>
      parseProduct(item, `/marketplace/products`, key, index),
    );
  }

  return result;
}

/**
 * Validate the GET /api/v2/info response (token-liveness check).
 *
 * The real CardTrader v2 response is `{ id, name, shared_secret, user_id }`.
 * A non-401 carrying a numeric `id` is sufficient proof the token is valid.
 * We extract ONLY the non-sensitive identifying fields and deliberately drop
 * `shared_secret` so that secret is never retained, returned, or logged.
 */
export function parseInfo(raw: unknown): Info {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(
      '/info response: expected an object, got ' + typeof raw,
      '/info',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['id'] !== 'number') {
    throw new CardTraderError(
      '/info response: missing numeric "id" field',
      '/info',
    );
  }

  return {
    id: obj['id'],
    name: typeof obj['name'] === 'string' ? obj['name'] : '',
    user_id: typeof obj['user_id'] === 'number' ? obj['user_id'] : obj['id'],
  };
}

/**
 * Parse the cart response body from GET /cart or the cart mutation endpoints.
 *
 * The top-level `cart` wrapper is optional: the API may return `{ cart: {...} }`
 * or just the cart object directly.  Both forms are handled.
 *
 * Money fields tolerate two wire shapes:
 *   - nested object  { cents: number, currency: string }
 *   - flat integers  subtotal_cents / subtotal_currency (or similar *_cents keys)
 * Missing optional fee fields (safeguard_fee_amount, ct_zero_fee_amount,
 * payment_method_fee_*) are tolerated and set to undefined — never throw on them.
 *
 * A missing or empty subcarts array is treated as an empty cart (not an error).
 */
export function parseCart(raw: unknown): Cart {
  const endpoint = '/cart';

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(
      'cart response: expected an object, got ' + typeof raw,
      endpoint,
    );
  }

  // Unwrap the optional `cart` wrapper: { cart: { id, subcarts } } OR { id, subcarts }
  const top = raw as Record<string, unknown>;
  const cartObj: Record<string, unknown> =
    top['cart'] !== undefined && top['cart'] !== null && typeof top['cart'] === 'object' && !Array.isArray(top['cart'])
      ? (top['cart'] as Record<string, unknown>)
      : top;

  const id = requireInteger(cartObj['id'], 'cart.id', endpoint);

  // Top-level money fields — all optional and tolerant of nested-object OR flat
  // *_cents/*_currency forms. An empty cart omits them; never throw here.
  const total = extractOptionalMoney(cartObj, 'total', 'cart', endpoint);
  const subtotal = extractOptionalMoney(cartObj, 'subtotal', 'cart', endpoint);
  const shipping_cost = extractOptionalMoney(cartObj, 'shipping_cost', 'cart', endpoint);
  const safeguard_fee_amount = extractOptionalMoney(cartObj, 'safeguard_fee_amount', 'cart', endpoint);
  const ct_zero_fee_amount = extractOptionalMoney(cartObj, 'ct_zero_fee_amount', 'cart', endpoint);
  const payment_method_fee_fixed_amount = extractOptionalMoney(cartObj, 'payment_method_fee_fixed_amount', 'cart', endpoint);
  const payment_method_fee_percentage_amount = extractOptionalMoney(cartObj, 'payment_method_fee_percentage_amount', 'cart', endpoint);

  const rawSubcarts = cartObj['subcarts'];
  const subcarts: Subcart[] = Array.isArray(rawSubcarts)
    ? rawSubcarts.map((item, index) => parseSubcart(item, index, endpoint))
    : [];

  return {
    id,
    total,
    subtotal,
    shipping_cost,
    safeguard_fee_amount,
    ct_zero_fee_amount,
    payment_method_fee_fixed_amount,
    payment_method_fee_percentage_amount,
    subcarts,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — not exported.
// ---------------------------------------------------------------------------

function parseProduct(
  raw: unknown,
  endpoint: string,
  blueprintKey: string,
  index: number,
): Product {
  const ctx = `product[${blueprintKey}][${index}]`;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(
      `${ctx}: expected an object`,
      endpoint,
    );
  }

  const p = raw as Record<string, unknown>;

  const id = requireInteger(p['id'], ctx + '.id', endpoint);
  const blueprint_id = requireInteger(p['blueprint_id'], ctx + '.blueprint_id', endpoint);
  const name_en = requireString(p['name_en'], ctx + '.name_en', endpoint);
  const quantity = requireInteger(p['quantity'], ctx + '.quantity', endpoint);
  const price = parsePrice(p['price'], ctx + '.price', endpoint);
  const properties_hash = parsePropertiesHash(p['properties_hash'], ctx + '.properties_hash', endpoint);
  const graded = requireBoolean(p['graded'], ctx + '.graded', endpoint);
  const on_vacation = requireBoolean(p['on_vacation'], ctx + '.on_vacation', endpoint);

  const expansion =
    p['expansion'] === undefined || p['expansion'] === null
      ? undefined
      : parseProductExpansion(p['expansion'], ctx + '.expansion', endpoint);

  const user =
    p['user'] === undefined || p['user'] === null
      ? undefined
      : parseProductUser(p['user'], ctx + '.user', endpoint);

  return {
    id,
    blueprint_id,
    name_en,
    quantity,
    price,
    properties_hash,
    expansion,
    user,
    graded,
    on_vacation,
  };
}

function parsePrice(raw: unknown, ctx: string, endpoint: string): Price {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }
  const p = raw as Record<string, unknown>;
  const cents = requireInteger(p['cents'], ctx + '.cents', endpoint);
  const currency = requireString(p['currency'], ctx + '.currency', endpoint);
  // cents is a raw integer from the wire — pass through as-is (never divide).
  return { cents, currency };
}

function parsePropertiesHash(raw: unknown, ctx: string, endpoint: string): PropertiesHash {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }
  const p = raw as Record<string, unknown>;
  return {
    condition: requireString(p['condition'], ctx + '.condition', endpoint),
    mtg_language: requireString(p['mtg_language'], ctx + '.mtg_language', endpoint),
    mtg_foil: requireBoolean(p['mtg_foil'], ctx + '.mtg_foil', endpoint),
  };
}

function parseProductExpansion(raw: unknown, ctx: string, endpoint: string): ProductExpansion {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }
  const p = raw as Record<string, unknown>;
  return {
    id: requireInteger(p['id'], ctx + '.id', endpoint),
    code: requireString(p['code'], ctx + '.code', endpoint),
    name_en: requireString(p['name_en'], ctx + '.name_en', endpoint),
  };
}

function parseProductUser(raw: unknown, ctx: string, endpoint: string): ProductUser {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }
  const p = raw as Record<string, unknown>;
  return {
    username: requireString(p['username'], ctx + '.username', endpoint),
    can_sell_via_hub: requireBoolean(p['can_sell_via_hub'], ctx + '.can_sell_via_hub', endpoint),
    country_code: requireString(p['country_code'], ctx + '.country_code', endpoint),
  };
}

// ---------------------------------------------------------------------------
// Expansion / Blueprint helpers
// ---------------------------------------------------------------------------

function parseExpansion(raw: unknown, index: number): Expansion {
  const ctx = `expansion[${index}]`;
  const endpoint = '/expansions';

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }

  const e = raw as Record<string, unknown>;

  const id = requireInteger(e['id'], ctx + '.id', endpoint);
  const code = requireString(e['code'], ctx + '.code', endpoint);
  const game_id = requireInteger(e['game_id'], ctx + '.game_id', endpoint);

  // The wire field is `name_en`; tolerate a plain `name` as a fallback.
  const rawName = e['name_en'] ?? e['name'];
  const name_en = typeof rawName === 'string' ? rawName : '';
  const name = name_en;

  return { id, code, name, name_en, game_id };
}

function parseBlueprint(raw: unknown, index: number, expansionId: number): Blueprint {
  const ctx = `blueprint[${index}]`;
  const endpoint = `/blueprints/export`;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }

  const b = raw as Record<string, unknown>;

  const id = requireInteger(b['id'], ctx + '.id', endpoint);

  // `name_en` is the documented field; fall back to `name` for API variation.
  const rawName = b['name_en'] ?? b['name'];
  const name = typeof rawName === 'string' ? rawName : '';
  if (!name) {
    throw new CardTraderError(
      `${ctx}: missing name (name_en/name) for blueprint id ${id}`,
      endpoint,
    );
  }

  const blueprint_expansion_id = requireInteger(
    b['expansion_id'],
    ctx + '.expansion_id',
    endpoint,
  );

  const game_id = requireInteger(b['game_id'], ctx + '.game_id', endpoint);

  // Optional fields — accept string or null; absent fields become undefined.
  const image_url =
    b['image_url'] === undefined
      ? undefined
      : typeof b['image_url'] === 'string' || b['image_url'] === null
        ? (b['image_url'] as string | null)
        : undefined;

  const scryfall_id =
    b['scryfall_id'] === undefined
      ? undefined
      : typeof b['scryfall_id'] === 'string' || b['scryfall_id'] === null
        ? (b['scryfall_id'] as string | null)
        : undefined;

  // Defensive: ignore expansionId mismatch rather than throwing (API is
  // expected to return the correct set but we don't want a stale cache entry
  // to fail the whole import).
  void expansionId;

  return {
    id,
    name,
    expansion_id: blueprint_expansion_id,
    game_id,
    image_url,
    scryfall_id,
  };
}

// Primitive validators — throw CardTraderError so caller types stay non-optional.

function requireString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== 'string') {
    throw new CardTraderError(
      `${field}: expected string, got ${typeof value}`,
      endpoint,
    );
  }
  return value;
}

function requireInteger(value: unknown, field: string, endpoint: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CardTraderError(
      `${field}: expected integer, got ${typeof value} (${String(value)})`,
      endpoint,
    );
  }
  return value;
}

function requireBoolean(value: unknown, field: string, endpoint: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CardTraderError(
      `${field}: expected boolean, got ${typeof value}`,
      endpoint,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cart helpers
// ---------------------------------------------------------------------------

/**
 * Parse a money field that may arrive as:
 *   - a nested object { cents: number, currency: string }
 *   - absent / null (caller passes a fallback)
 *
 * Flat *_cents / *_currency pairs are handled by the caller by pre-composing
 * them into an object before calling this helper.
 */
function parseMoneyField(
  raw: unknown,
  ctx: string,
  endpoint: string,
): Money {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected a money object`, endpoint);
  }
  const m = raw as Record<string, unknown>;
  const cents = requireInteger(m['cents'], ctx + '.cents', endpoint);
  const currency = requireString(m['currency'], ctx + '.currency', endpoint);
  return { cents, currency };
}

/**
 * Extract a Money value from a field that may be either:
 *   - a nested { cents, currency } object under `key`
 *   - flat integers under `${key}_cents` / `${key}_currency`
 * Returns undefined when neither form is present (optional fee fields).
 */
function extractOptionalMoney(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
  endpoint: string,
): Money | undefined {
  if (obj[key] !== undefined && obj[key] !== null) {
    return parseMoneyField(obj[key], `${ctx}.${key}`, endpoint);
  }
  // Try flat *_cents / *_currency form.
  const centsKey = `${key}_cents`;
  const currencyKey = `${key}_currency`;
  if (obj[centsKey] !== undefined && obj[currencyKey] !== undefined) {
    const cents = requireInteger(obj[centsKey], `${ctx}.${centsKey}`, endpoint);
    const currency = requireString(obj[currencyKey], `${ctx}.${currencyKey}`, endpoint);
    return { cents, currency };
  }
  return undefined;
}

function parseCartItem(raw: unknown, index: number, endpoint: string): CartItem {
  const ctx = `cart_item[${index}]`;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }

  const item = raw as Record<string, unknown>;

  const quantity = requireInteger(item['quantity'], ctx + '.quantity', endpoint);

  // price_cents / price_currency may be top-level integers or a nested price object.
  let price_cents: number;
  let price_currency: string;
  if (typeof item['price_cents'] === 'number') {
    price_cents = requireInteger(item['price_cents'], ctx + '.price_cents', endpoint);
    price_currency = typeof item['price_currency'] === 'string' ? item['price_currency'] : 'EUR';
  } else if (item['price'] !== undefined && item['price'] !== null && typeof item['price'] === 'object') {
    const priceObj = item['price'] as Record<string, unknown>;
    price_cents = requireInteger(priceObj['cents'], ctx + '.price.cents', endpoint);
    price_currency = typeof priceObj['currency'] === 'string' ? priceObj['currency'] : 'EUR';
  } else {
    throw new CardTraderError(`${ctx}: missing price_cents`, endpoint);
  }

  // product sub-object.
  const rawProduct = item['product'];
  if (rawProduct === null || typeof rawProduct !== 'object' || Array.isArray(rawProduct)) {
    throw new CardTraderError(`${ctx}.product: expected an object`, endpoint);
  }
  const prod = rawProduct as Record<string, unknown>;
  const productId = requireInteger(prod['id'], ctx + '.product.id', endpoint);
  const name_en = typeof prod['name_en'] === 'string' ? prod['name_en'] : '';

  return {
    quantity,
    price_cents,
    price_currency,
    product: { id: productId, name_en },
  };
}

function parseSubcart(raw: unknown, index: number, endpoint: string): Subcart {
  const ctx = `subcart[${index}]`;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(`${ctx}: expected an object`, endpoint);
  }

  const s = raw as Record<string, unknown>;

  const id = requireInteger(s['id'], ctx + '.id', endpoint);

  // seller sub-object.
  const rawSeller = s['seller'];
  if (rawSeller === null || typeof rawSeller !== 'object' || Array.isArray(rawSeller)) {
    throw new CardTraderError(`${ctx}.seller: expected an object`, endpoint);
  }
  const sellerObj = rawSeller as Record<string, unknown>;
  const sellerId = requireInteger(sellerObj['id'], ctx + '.seller.id', endpoint);
  const sellerUsername = requireString(sellerObj['username'], ctx + '.seller.username', endpoint);

  // cart_items array — treat absent/non-array as empty rather than throwing.
  const rawItems = s['cart_items'];
  const cart_items: CartItem[] = Array.isArray(rawItems)
    ? rawItems.map((item, i) => parseCartItem(item, i, endpoint))
    : [];

  // Subcarts carry NO money fields on the live API — only the seller's line items.
  const via_cardtrader_zero =
    typeof s['via_cardtrader_zero'] === 'boolean' ? s['via_cardtrader_zero'] : undefined;

  return {
    id,
    seller: { id: sellerId, username: sellerUsername },
    via_cardtrader_zero,
    cart_items,
  };
}
