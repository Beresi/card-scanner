/**
 * Tests for the pure formatting helpers in notifier.ts — the money display edge
 * (formatCents) and the §8 message block (formatDeal). The network send path is
 * not exercised here; it is guarded by isTelegramConfigured and covered by the
 * scanner's inert-stub behavior.
 */

import { describe, it, expect } from 'vitest';
import { formatCents, formatDeal, type FormattableDeal } from './notifier';

// ---------------------------------------------------------------------------
// formatCents — integer cents → "12.34" (the only place money de-integerizes)
// ---------------------------------------------------------------------------

describe('formatCents', () => {
  it('renders whole and fractional parts with zero-padding', () => {
    expect(formatCents(1234)).toBe('12.34');
    expect(formatCents(1200)).toBe('12.00');
    expect(formatCents(1205)).toBe('12.05');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });

  it('renders negative cents with a leading sign', () => {
    expect(formatCents(-1234)).toBe('-12.34');
  });
});

// ---------------------------------------------------------------------------
// formatDeal — PRD §8 plain-text block
// ---------------------------------------------------------------------------

const FULL_DEAL: FormattableDeal = {
  card_name: 'Black Lotus',
  expansion_name: 'Alpha',
  price_cents: 1000,
  currency: 'EUR',
  discount_pct: 65,
  baseline_cents: 2000,
  condition: 'Near Mint',
  foil: false,
  quantity: 2,
  seller_username: 'topdeck',
  seller_country: 'IT',
  can_sell_via_hub: true,
  buy_url: 'https://www.cardtrader.com/cards/123',
};

describe('formatDeal', () => {
  it('renders the full §8 block including CT Zero and buy link', () => {
    expect(formatDeal(FULL_DEAL)).toBe(
      [
        'Deal — Black Lotus · Alpha',
        '10.00 EUR  (65% under median 20.00)',
        'Near Mint · Non-foil · EN · qty 2',
        'Seller: topdeck (IT) · CT Zero ✓',
        'https://www.cardtrader.com/cards/123',
      ].join('\n'),
    );
  });

  it('omits expansion suffix, CT Zero, country and buy link when absent', () => {
    const sparse: FormattableDeal = {
      ...FULL_DEAL,
      expansion_name: null,
      foil: true,
      quantity: null,
      seller_country: null,
      can_sell_via_hub: false,
      buy_url: null,
    };
    expect(formatDeal(sparse)).toBe(
      [
        'Deal — Black Lotus',
        '10.00 EUR  (65% under median 20.00)',
        'Near Mint · Foil · EN · qty ?',
        'Seller: topdeck',
      ].join('\n'),
    );
  });
});
