/**
 * GET /api/resolve/expansions   — fetch+cache expansions from CardTrader, then search.
 * GET /api/resolve/blueprints   — fetch+cache blueprints for an expansion, then search.
 *
 * These routes serve the add-card UX: the user types a set name, picks an
 * expansion, then picks a card (blueprint).  On first access the cache is empty,
 * so the route fetches from CardTrader, filters to MTG (game_id === 1), stores
 * the results in D1, and returns the search results.  Subsequent requests with a
 * warm cache skip the CardTrader fetch entirely.
 *
 * Staleness / empty-cache logic:
 *  - Expansions: refresh when the table is empty OR the newest synced_at is older
 *    than EXPANSIONS_MAX_AGE_DAYS (7 days).
 *  - Blueprints: refresh when there are 0 rows for the requested expansion_id.
 *    (Blueprint sets are stable; once cached they are considered permanent.)
 *
 * Fallback on upstream error:
 *  - If the CardTrader fetch fails AND the cache is non-empty → search the cache.
 *  - If the CardTrader fetch fails AND the cache is empty → 502 {error:'upstream'}.
 *
 * Client-injection seam:
 *  `createResolveRouter(deps?)` accepts an optional `deps.createClient` factory,
 *  exactly mirroring ScanDeps in scanner.ts.  When omitted the real
 *  `createCardTraderClient` is used.  Tests pass a mock factory so no real HTTP
 *  calls are ever made.
 *
 * No-purchase guardrail: only GET /expansions and GET /blueprints/export are
 * called.  No cart, checkout, or purchase path exists in this module.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * PRD §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import {
  createCardTraderClient,
  type CardTraderClient,
} from '../cardtrader/client';
import {
  searchExpansions,
  searchBlueprints,
  countExpansions,
  countBlueprintsForExpansion,
  syncExpansions,
  syncBlueprints,
  expansionsStale,
  countCatalogProgress,
} from '../db/repo';
import { normalizeCardName } from '../scan/cardName';
import { parseIntParam } from './validate';

// ---------------------------------------------------------------------------
// Injectable dependencies — mirrors ScanDeps in scanner.ts
// ---------------------------------------------------------------------------

/** Factory signature — the same type as `createCardTraderClient`. */
type CreateClientFn = typeof createCardTraderClient;

export interface ResolveDeps {
  createClient?: CreateClientFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh the expansions cache when the newest synced_at is older than this. */
const EXPANSIONS_MAX_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('resolve route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// Factory — accepts injected deps for testability
// ---------------------------------------------------------------------------

/**
 * Build the resolve router with optional injected dependencies.
 *
 * Pass `deps.createClient` to replace the real CardTrader client with a mock
 * in tests.  In production `index.ts` calls `createResolveRouter()` with no
 * arguments and the real client is used.
 */
export function createResolveRouter(deps?: ResolveDeps): Hono<{ Bindings: Env }> {
  const clientFactory: CreateClientFn = deps?.createClient ?? createCardTraderClient;

  const router = new Hono<{ Bindings: Env }>();

  // -------------------------------------------------------------------------
  // GET /expansions — fetch+cache MTG expansions, then search by name or code
  // -------------------------------------------------------------------------

  router.get('/expansions', async (c) => {
    try {
      const q = c.req.query('q') ?? '';

      // Return empty array immediately when q is blank — nothing to search.
      if (q.trim() === '') {
        return c.json([]);
      }

      const db = c.env.DB;

      // Determine whether we need to refresh from CardTrader.
      const needRefresh = await expansionsStale(db, EXPANSIONS_MAX_AGE_DAYS);

      if (needRefresh) {
        // Attempt upstream fetch.
        let fetchSucceeded = false;
        try {
          // No onRequest counter needed here (no scan_runs row for resolve).
          const client: CardTraderClient = clientFactory(c.env.CARDTRADER_API_TOKEN);
          const all = await client.expansions();

          // Filter to MTG only (game_id === 1) before caching.
          const mtg = all.filter((e) => e.game_id === 1);

          await syncExpansions(
            db,
            mtg.map((e) => ({
              id: e.id,
              game_id: e.game_id,
              code: e.code,
              name: e.name,
            })),
          );
          fetchSucceeded = true;
        } catch (fetchErr) {
          // Never leak CardTrader internals.
          console.error('[resolve] expansions fetch failed', {
            error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
        }

        if (!fetchSucceeded) {
          // Check if we have anything cached to fall back to.
          const cached = await countExpansions(db);
          if (cached === 0) {
            // Empty cache + failed fetch → 502.
            return c.json({ error: 'upstream' }, 502);
          }
          // Non-empty cache → fall through to search below.
        }
      }

      const rows = await searchExpansions(db, q);
      return c.json(rows);
    } catch (err) {
      return handleError(err, c);
    }
  });

  // -------------------------------------------------------------------------
  // GET /blueprints — fetch+cache a set's blueprints, then search by name
  // -------------------------------------------------------------------------

  router.get('/blueprints', async (c) => {
    try {
      // expansion_id is REQUIRED.
      const rawExpansionId = c.req.query('expansion_id');
      if (rawExpansionId === undefined || rawExpansionId === '') {
        return c.json({ error: 'invalid_request' }, 400);
      }

      const expansion_id = parseIntParam(rawExpansionId);
      if (expansion_id === undefined) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      const q = c.req.query('q') ?? '';
      const db = c.env.DB;

      // Refresh if there are no blueprints cached for this expansion.
      const cachedCount = await countBlueprintsForExpansion(db, expansion_id);

      if (cachedCount === 0) {
        let fetchSucceeded = false;
        try {
          const client: CardTraderClient = clientFactory(c.env.CARDTRADER_API_TOKEN);
          const blueprints = await client.blueprintsExport(expansion_id);

          await syncBlueprints(
            db,
            blueprints.map((b) => ({
              id: b.id,
              expansion_id: b.expansion_id,
              name: b.name,
              scryfall_id: b.scryfall_id ?? null,
              image_url: b.image_url ?? null,
            })),
          );
          fetchSucceeded = true;
        } catch (fetchErr) {
          console.error('[resolve] blueprints fetch failed', {
            expansionId: expansion_id,
            error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
        }

        if (!fetchSucceeded) {
          // Re-check: perhaps the fetch silently added nothing (empty set).
          const afterCount = await countBlueprintsForExpansion(db, expansion_id);
          if (afterCount === 0) {
            // Empty cache + failed fetch → 502.
            return c.json({ error: 'upstream' }, 502);
          }
          // Non-zero after re-check means a concurrent request or race filled it.
        }
      }

      const rows = await searchBlueprints(db, expansion_id, q);
      return c.json(rows);
    } catch (err) {
      return handleError(err, c);
    }
  });

  // -------------------------------------------------------------------------
  // GET /cards — cache-only cross-set card-name search (no CardTrader calls)
  //
  // Searches blueprints.name_norm for distinct card names matching the query.
  // Returns { name, printings, sets } for each match (LIMIT 50).
  // q < 2 trimmed chars → [].  Empty cache → [].  Never 502.
  // -------------------------------------------------------------------------

  router.get('/cards', async (c) => {
    try {
      const rawQ = c.req.query('q') ?? '';
      const trimmed = rawQ.trim();

      // Short query — nothing useful to search for yet.
      if (trimmed.length < 2) {
        return c.json([]);
      }

      const normalizedQ = normalizeCardName(trimmed);

      // Inline query: GROUP BY name_norm for distinct names.
      // Only bound placeholders — user value is never interpolated.
      const { results } = await c.env.DB
        .prepare(
          `SELECT MIN(name) AS name,
                  COUNT(*) AS printings,
                  COUNT(DISTINCT expansion_id) AS sets
             FROM blueprints
            WHERE name_norm LIKE '%' || ? || '%'
            GROUP BY name_norm
            ORDER BY name_norm
            LIMIT 50`,
        )
        .bind(normalizedQ)
        .all<{ name: string; printings: number; sets: number }>();

      return c.json(results);
    } catch (err) {
      return handleError(err, c);
    }
  });

  // -------------------------------------------------------------------------
  // GET /catalog-progress — how many MTG expansions have been catalog-synced
  //
  // Returns { total, synced } so the UI can show "N of M sets synced."
  // Cache-only — never calls CardTrader.
  // -------------------------------------------------------------------------

  router.get('/catalog-progress', async (c) => {
    try {
      const progress = await countCatalogProgress(c.env.DB);
      return c.json(progress);
    } catch (err) {
      return handleError(err, c);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default export — the pre-built router used by index.ts
// ---------------------------------------------------------------------------

/**
 * The resolve router instance used by the Hono app in index.ts.
 * Constructed with the real CardTrader client (no injected mock).
 *
 * index.ts mounts this as: `app.route('/api/resolve', resolveRouter)`
 */
export const resolveRouter: Hono<{ Bindings: Env }> = createResolveRouter();
