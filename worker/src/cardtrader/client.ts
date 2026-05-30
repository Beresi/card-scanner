/**
 * CardTrader API v2 HTTP client.
 *
 * Owns Bearer auth, the whole-run ~1 req/s throttle, and exponential backoff
 * on HTTP 429 / "Too many requests" bodies. It does NOT own deal logic or
 * persistence — callers get clean, typed data and decide what to do.
 *
 * Factory pattern: one client instance = one scan run. The throttle queue is
 * per-instance so the scanner creates exactly ONE client and the ~1 req/s
 * guarantee spans the whole run.
 *
 * NEVER log the Bearer token. NEVER call purchase/checkout endpoints.
 */

import type { Info, MarketplaceQuery, MarketplaceResponse, Expansion, Blueprint } from './types';
import {
  parseInfo,
  parseMarketplaceResponse,
  parseExpansionArray,
  parseBlueprintArray,
  CardTraderError,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.cardtrader.com/api/v2';

const DEFAULT_MIN_INTERVAL_MS = 1_000; // ~1 req/s
const DEFAULT_MAX_RETRIES = 4;         // 5 attempts total (attempt 0..4)
const BACKOFF_BASE_MS = 1_000;         // 1s → 2s → 4s → 8s → 16s

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CardTraderClient {
  info(): Promise<Info>;
  marketplaceProducts(q: MarketplaceQuery): Promise<MarketplaceResponse>;
  /**
   * GET /expansions — all expansions across all games.
   * Filter to MTG (game_id = 1) at the cache/route layer if needed.
   * Throttled through the same ~1 req/s queue as every other method.
   */
  expansions(): Promise<Expansion[]>;
  /**
   * GET /blueprints/export?expansion_id=<id> — all blueprint printings for
   * a set. Large sets can return many rows. Throttled through the same queue.
   */
  blueprintsExport(expansionId: number): Promise<Blueprint[]>;
}

export interface ClientOptions {
  /** Injected fetch implementation; defaults to globalThis.fetch. Tests pass a stub. */
  fetchImpl?: typeof fetch;
  /**
   * Called on EVERY HTTP attempt including retries. The scanner uses this to
   * increment its api_calls counter so the scan_runs row reflects real behavior.
   */
  onRequest?: () => void;
  /** Minimum milliseconds between request STARTS across the whole run. Default ~1000. */
  minIntervalMs?: number;
  /** Maximum number of 429 retries (not counting the first attempt). Default 4. */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CardTrader API client bound to a single token.
 * Instantiate ONCE per scan run so the throttle queue spans the whole run.
 */
export function createCardTraderClient(
  token: string,
  opts?: ClientOptions,
): CardTraderClient {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const onRequest = opts?.onRequest ?? (() => undefined);
  const minIntervalMs = opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  // ---------------------------------------------------------------------------
  // Throttle — promise chain with ≥ minIntervalMs spacing between request starts.
  //
  // Each call appends to the end of the chain. A failed job must not stall the
  // chain: we catch and discard the error on the chain-tail so the next job's
  // .then() still fires.
  // ---------------------------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve();

  function throttled<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(async (): Promise<T> => {
      // Spacing is placed BEFORE the job so the next job waits minIntervalMs
      // after THIS job starts (not after it finishes). This gives whole-run
      // ~1 req/s regardless of each call's own latency.
      const result = await job();
      await sleep(minIntervalMs);
      return result;
    });
    // Swallow rejections on the tail so a failed job never stalls the chain.
    queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------
  // Raw HTTP fetch — Bearer auth, no token in error context.
  // Calls onRequest() on every attempt (including retries).
  // Returns the parsed JSON body as `unknown` — callers narrow.
  // ---------------------------------------------------------------------------

  async function ctFetch(path: string): Promise<unknown> {
    let delay = BACKOFF_BASE_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      onRequest(); // count every attempt, retries included

      const res = await fetchImpl(`${BASE_URL}${path}`, {
        headers: {
          // NEVER log this header — token is high-sensitivity (read+write scope).
          Authorization: `Bearer ${token}`,
        },
      });

      // 401 — invalid / expired token. Do NOT retry; the scanner aborts on this.
      if (res.status === 401) {
        throw new CardTraderError('invalid or expired token', path, 401);
      }

      // 429 or "Too many requests" body — exponential backoff then retry.
      if (res.status === 429 || (await isTooManyRequests(res))) {
        if (attempt < maxRetries) {
          await sleep(delay);
          delay *= 2; // 1s → 2s → 4s → 8s → 16s (capped at maxRetries doublings)
          continue;
        }
        // Retries exhausted.
        throw new CardTraderError('rate limit: retries exhausted', path, 429);
      }

      // Any other non-OK response is a non-retryable error — caller catches and skips.
      if (!res.ok) {
        throw new CardTraderError(`request failed`, path, res.status);
      }

      // Parse as unknown — boundary parsers narrow to the correct shape.
      return res.json() as unknown;
    }

    // Unreachable: the loop always returns or throws within the body.
    throw new CardTraderError('unexpected: fetch loop exited without result', path);
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  async function info(): Promise<Info> {
    // info() goes through the throttle so it shares the same ~1 req/s queue.
    return throttled(async () => {
      const raw = await ctFetch('/info');
      return parseInfo(raw);
    });
  }

  async function marketplaceProducts(q: MarketplaceQuery): Promise<MarketplaceResponse> {
    const path = buildMarketplacePath(q);
    return throttled(async () => {
      const raw = await ctFetch(path);
      return parseMarketplaceResponse(raw);
    });
  }

  async function expansions(): Promise<Expansion[]> {
    return throttled(async () => {
      const raw = await ctFetch('/expansions');
      return parseExpansionArray(raw);
    });
  }

  async function blueprintsExport(expansionId: number): Promise<Blueprint[]> {
    const path = `/blueprints/export?expansion_id=${expansionId}`;
    return throttled(async () => {
      const raw = await ctFetch(path);
      return parseBlueprintArray(raw, expansionId);
    });
  }

  return { info, marketplaceProducts, expansions, blueprintsExport };
}

// ---------------------------------------------------------------------------
// buildBuyUrl
//
// VERIFY: the `https://www.cardtrader.com/cards/{blueprint_id}` pattern is
// unverified (PRD §6 / §13). Confirm the real public URL during build and
// fall back to a search URL if this pattern does not resolve.
// ---------------------------------------------------------------------------

export function buildBuyUrl(blueprintId: number): string {
  return `https://www.cardtrader.com/cards/${blueprintId}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the /marketplace/products query string from a MarketplaceQuery.
 * Always includes `language`; includes `foil` only when defined;
 * uses `blueprint_id` or `expansion_id` per the union discriminant.
 *
 * VERIFY: the `expansion_id` + `language` filter combination is unverified
 * (PRD §6 / §13). Confirm `language` is honored on the expansionId variant;
 * if not, fall back to per-blueprint calls for set-level watch items.
 */
function buildMarketplacePath(q: MarketplaceQuery): string {
  const idParam =
    'blueprintId' in q
      ? `blueprint_id=${q.blueprintId}`
      : `expansion_id=${q.expansionId}`;

  const foilParam = q.foil === undefined ? '' : `&foil=${q.foil}`;

  return `/marketplace/products?${idParam}&language=${q.language}${foilParam}`;
}

/**
 * Peek at the response body to detect a "Too many requests" JSON payload.
 * Consumes the body; returns true when the body contains that phrase.
 *
 * This is conservative: any read error (non-JSON, network) returns false so
 * the non-retryable error path handles it instead.
 */
async function isTooManyRequests(res: Response): Promise<boolean> {
  try {
    const text = await res.clone().text();
    return text.toLowerCase().includes('too many requests');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
