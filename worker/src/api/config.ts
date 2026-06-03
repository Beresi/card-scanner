/**
 * GET  /api/config   — read the single config row (id = 1).
 * PATCH /api/config  — partially update the config row; returns updated row.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 * No business logic — delegates to repo.getConfig / repo.patchConfig.
 *
 * PRD §9 / §10; docs/documentation/http-api.md.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';
import { getConfig, patchConfig } from '../db/repo';
import { pickAllowed } from './validate';
import type { ConfigRow } from '../db/types';
import { CONDITIONS } from '../scan/conditions';

export const configRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Allow-list for PATCH — all ConfigRow keys except id and updated_at.
// ---------------------------------------------------------------------------

const CONFIG_PATCH_FIELDS = [
  'default_discount_pct',
  'default_min_condition',
  'cohort_size',
  'min_cohort',
  'currency',
  'min_price_cents',
  'min_savings_cents',
  'new_ticket_foil_pref',
  'new_ticket_allow_graded',
  'new_ticket_importance',
  'new_ticket_telegram_enabled',
  'telegram_min_discount_pct',
  'quiet_hours_start',
  'quiet_hours_end',
  'digest_on_quiet_end',
  'theme',
  'accent_color',
  'density',
  'theme_palette',
  'font',
  'deal_retention_days',
  'timezone',
  // Detection-mode defaults + catalog controls (migration 0005)
  'default_detection_mode',
  'default_max_price_cents',
  'catalog_sync_enabled',
  'catalog_max_exports_per_run',
] as const;

// Valid detection modes for the config default.
const DETECTION_MODES = ['discount', 'price'] as const;

// Maximum catalog_max_exports_per_run — protect the subrequest budget.
// Each export is one CardTrader API call; free tier has ~50 subrequests/invocation.
const MAX_CATALOG_EXPORTS_PER_RUN = 10;
const MAX_DEFAULT_PRICE_CENTS = 10_000_000; // $100,000 ceiling for default_max_price_cents

// ---------------------------------------------------------------------------
// Error mapping — validate errors → 400, unexpected → 500 (no internals).
// ---------------------------------------------------------------------------

function handleError(err: unknown, c: Context<{ Bindings: Env }>) {
  if (err instanceof Error && err.message === 'invalid_request') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('config route error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal' }, 500);
}

// ---------------------------------------------------------------------------
// GET / — read config row
// ---------------------------------------------------------------------------

configRouter.get('/', async (c) => {
  try {
    const row = await getConfig(c.env.DB);
    return c.json(row);
  } catch (err) {
    return handleError(err, c);
  }
});

// ---------------------------------------------------------------------------
// PATCH / — partial update
// ---------------------------------------------------------------------------

configRouter.patch('/', async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // ── validate condition / mode fields before allow-listing ────────────────

    // default_min_condition: must be one of the 7 canonical CardTrader grade names.
    if (body['default_min_condition'] !== undefined) {
      if (!(CONDITIONS as readonly string[]).includes(body['default_min_condition'] as string)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    // default_detection_mode must be 'discount' or 'price'.
    if (body['default_detection_mode'] !== undefined) {
      if (!(DETECTION_MODES as readonly string[]).includes(body['default_detection_mode'] as string)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    // default_max_price_cents: non-negative integer (≤ ceiling) or null.
    if (body['default_max_price_cents'] !== undefined && body['default_max_price_cents'] !== null) {
      const mpc = body['default_max_price_cents'];
      if (!Number.isInteger(mpc) || typeof mpc !== 'number' || mpc < 0 || mpc > MAX_DEFAULT_PRICE_CENTS) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    // catalog_sync_enabled: 0, 1, or boolean (coerce to 0/1).
    if (body['catalog_sync_enabled'] !== undefined) {
      const cse = body['catalog_sync_enabled'];
      if (cse === true)  { body = { ...body, catalog_sync_enabled: 1 }; }
      else if (cse === false) { body = { ...body, catalog_sync_enabled: 0 }; }
      else if (cse !== 0 && cse !== 1) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    // catalog_max_exports_per_run: positive integer, capped at MAX_CATALOG_EXPORTS_PER_RUN.
    if (body['catalog_max_exports_per_run'] !== undefined) {
      const cme = body['catalog_max_exports_per_run'];
      if (!Number.isInteger(cme) || typeof cme !== 'number' || cme <= 0) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (cme > MAX_CATALOG_EXPORTS_PER_RUN) {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }

    const patch = pickAllowed<ConfigRow>(body, CONFIG_PATCH_FIELDS);
    const updated = await patchConfig(c.env.DB, patch);
    return c.json(updated);
  } catch (err) {
    return handleError(err, c);
  }
});
