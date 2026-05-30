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

export const configRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Allow-list for PATCH — all ConfigRow keys except id and updated_at.
// ---------------------------------------------------------------------------

const CONFIG_PATCH_FIELDS = [
  'default_threshold_pct',
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
] as const;

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

    const patch = pickAllowed<ConfigRow>(body, CONFIG_PATCH_FIELDS);
    const updated = await patchConfig(c.env.DB, patch);
    return c.json(updated);
  } catch (err) {
    return handleError(err, c);
  }
});
