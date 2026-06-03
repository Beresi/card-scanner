/**
 * Tests for buildWatchUrl — the "View on CardTrader" link for each WatchItem type.
 *
 * Regression focus: a card-type ("any printing") watch must link to a real card
 * page (/cards/{id}/versions), NOT the dead category-search page.
 */

import { describe, it, expect } from 'vitest';
import { buildWatchUrl } from './cardtrader-url';
import type { WatchItem } from '../api/types';

const BASE = 'https://www.cardtrader.com';

/** Minimal WatchItem with sane defaults; override per case. */
function watchItem(over: Partial<WatchItem>): WatchItem {
  return {
    id: 1,
    type: 'card',
    cardtrader_id: null,
    label: 'Lightning Bolt',
    game_id: 1,
    min_condition: null,
    foil_pref: null,
    allow_graded: null,
    min_discount_pct: null,
    min_gap_pct: null,
    importance: null,
    telegram_enabled: null,
    telegram_min_discount_pct: null,
    telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    detection_mode: null,
    max_price_cents: null,
    card_name_norm: 'lightning bolt',
    expansion_filter: null,
    repr_blueprint_id: null,
    active: 1,
    created_at: '2026-06-01 00:00:00',
    updated_at: '2026-06-01 00:00:00',
    ...over,
  };
}

describe('buildWatchUrl — blueprint', () => {
  it('links to the card page by blueprint id with a readable (cosmetic) slug', () => {
    const url = buildWatchUrl(
      watchItem({ type: 'blueprint', cardtrader_id: 10050, label: 'Lightning Bolt' }),
    );
    expect(url).toBe(`${BASE}/cards/10050-lightning-bolt`);
  });

  it('omits any locale segment so CardTrader auto-redirects to the viewer locale', () => {
    const url = buildWatchUrl(watchItem({ type: 'blueprint', cardtrader_id: 10050 }));
    expect(url).not.toMatch(/\/(en|it)\/cards\//);
  });
});

describe('buildWatchUrl — card (any printing)', () => {
  it('links to /cards/{repr_blueprint_id}/versions when a representative id is present', () => {
    const url = buildWatchUrl(
      watchItem({
        type: 'card',
        cardtrader_id: null,
        repr_blueprint_id: 358526,
        card_name_norm: 'lightning bolt',
      }),
    );
    expect(url).toBe(`${BASE}/cards/358526-lightning-bolt/versions`);
  });

  it('does NOT use the dead category-search page when a repr id exists', () => {
    const url = buildWatchUrl(
      watchItem({ type: 'card', repr_blueprint_id: 358526 }),
    );
    expect(url).not.toContain('blueprints_search');
  });

  it('falls back to a name search only when repr_blueprint_id is null', () => {
    const url = buildWatchUrl(
      watchItem({ type: 'card', repr_blueprint_id: null, card_name_norm: 'black lotus' }),
    );
    expect(url).toContain('blueprints_search');
    expect(url).toContain('black%20lotus');
  });
});
