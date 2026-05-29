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
  username: string;
  // Additional wire fields are not read; the index signature accepts them.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Expansion — expansions cache (set-watching + add-card UX). Minimal per PRD §6.
// ---------------------------------------------------------------------------

export interface Expansion {
  id: number;
  code: string;
  name_en: string;
  /** game_id is always 1 (MTG) but typed for completeness. */
  game_id: number;
}

// ---------------------------------------------------------------------------
// Blueprint — blueprints cache (add-card search + display). Minimal per PRD §6.
//
// VERIFY: buy-URL pattern is unverified (PRD §6 / §13).
// Likely: https://www.cardtrader.com/cards/{blueprint_id}
// Confirm the real public URL during build; fall back to a search URL if needed.
// ---------------------------------------------------------------------------

export interface Blueprint {
  id: number;
  name_en: string;
  expansion_id: number;
  /** Expansion code (e.g. "ptkdf") for display and cache look-up. */
  expansion_code?: string;
}

// ---------------------------------------------------------------------------
// Boundary parsers — narrow `unknown` → typed. Pure functions: no I/O.
// Throw CardTraderError on any structural violation.
// ---------------------------------------------------------------------------

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
 * Validates that `raw` carries at minimum a non-empty `username` string.
 * Extra wire fields are accepted via the Info index signature.
 */
export function parseInfo(raw: unknown): Info {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardTraderError(
      '/info response: expected an object, got ' + typeof raw,
      '/info',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['username'] !== 'string' || obj['username'].length === 0) {
    throw new CardTraderError(
      '/info response: missing or empty "username" field',
      '/info',
    );
  }

  return obj as Info;
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
