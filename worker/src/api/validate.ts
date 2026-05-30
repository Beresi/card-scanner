/**
 * Small, dependency-free validation helpers for Hono route handlers.
 *
 * These helpers parse and validate raw request values at the API boundary.
 * They are pure functions with no I/O — no Hono, no D1, no fetch.
 *
 * Convention:
 *  - A missing / absent value → `undefined` (caller decides whether required).
 *  - A present-but-invalid value → throws `Error('invalid_request')`.
 *    Route handlers catch this and return 400.
 *
 * PRD §10; docs/documentation/http-api.md.
 */

// ---------------------------------------------------------------------------
// parseIntParam
// ---------------------------------------------------------------------------

/**
 * Parse a query-parameter string to an integer.
 *
 * - `undefined` or empty string → `undefined` (param was absent or blank).
 * - A string that parses to a finite integer → that integer.
 * - Anything else (NaN, float string, non-numeric) → throws `Error('invalid_request')`.
 *
 * @example
 *   parseIntParam('42')        // → 42
 *   parseIntParam(undefined)   // → undefined
 *   parseIntParam('')          // → undefined
 *   parseIntParam('abc')       // throws Error('invalid_request')
 *   parseIntParam('3.5')       // throws Error('invalid_request')
 */
export function parseIntParam(
  value: string | undefined | null,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error('invalid_request');
  }
  return n;
}

// ---------------------------------------------------------------------------
// parseBoolBody
// ---------------------------------------------------------------------------

/**
 * Parse a boolean field from a JSON request body.
 *
 * - `undefined` (key absent from the body) → `undefined`.
 * - `true` or `false` → the boolean value.
 * - Any other type → throws `Error('invalid_request')`.
 *
 * @example
 *   parseBoolBody(true)        // → true
 *   parseBoolBody(false)       // → false
 *   parseBoolBody(undefined)   // → undefined
 *   parseBoolBody(1)           // throws Error('invalid_request')
 *   parseBoolBody('true')      // throws Error('invalid_request')
 */
export function parseBoolBody(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error('invalid_request');
}

// ---------------------------------------------------------------------------
// pickAllowed
// ---------------------------------------------------------------------------

/**
 * Return a new object containing only the allow-listed keys that are present
 * in `obj`.  Keys absent from `obj` are omitted (not set to undefined).
 *
 * This is the allow-list gate for PATCH bodies — it ensures unknown fields
 * never reach the repo layer.
 *
 * @example
 *   pickAllowed({ a: 1, b: 2, c: 3 }, ['a', 'c'])   // → { a: 1, c: 3 }
 *   pickAllowed({ x: 9 },             ['a', 'c'])   // → {}
 */
export function pickAllowed<T extends object>(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result as Partial<T>;
}
