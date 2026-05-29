/**
 * PRD §16 acceptance tests for evaluateBlueprint (cases 1–5).
 *
 * Cases 6–10 (dedupe, Telegram routing, health) live at the repo / notifier
 * / scanner layers respectively.
 *
 * All money is integer cents. The fixture factory keeps each test compact.
 */

import { describe, it, expect } from 'vitest';
import { evaluateBlueprint } from './dealEngine';
import type { Product } from '../cardtrader/types';
import type { EffectiveSettings } from '../db/types';

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

let _idCounter = 1;

/**
 * Build a minimal Product fixture.
 *
 * Sensible defaults: EN, Near Mint, non-foil, not graded, not on vacation,
 * quantity 1. Pass overrides for the fields under test.
 */
function makeProduct(
  priceCents: number,
  overrides: {
    id?: number;
    condition?: string;
    mtg_language?: string;
    mtg_foil?: boolean;
    graded?: boolean;
    on_vacation?: boolean;
    quantity?: number;
  } = {},
): Product {
  const id = overrides.id ?? _idCounter++;
  return {
    id,
    blueprint_id: 1001,
    name_en: 'Test Card',
    quantity: overrides.quantity ?? 1,
    price: { cents: priceCents, currency: 'EUR' },
    properties_hash: {
      condition: overrides.condition ?? 'Near Mint',
      mtg_language: overrides.mtg_language ?? 'en',
      mtg_foil: overrides.mtg_foil ?? false,
    },
    graded: overrides.graded ?? false,
    on_vacation: overrides.on_vacation ?? false,
  };
}

/**
 * Default effective settings (global config defaults, PRD §7).
 * Tests override only the fields relevant to the case under test.
 */
function defaultSettings(
  overrides: Partial<EffectiveSettings> = {},
): EffectiveSettings {
  return {
    min_condition: 'Near Mint',
    foil_pref: 'any',
    allow_graded: false,
    threshold_pct: 50,
    cohort_size: 10,
    min_cohort: 5,
    importance: 'normal',
    telegram_enabled: false,
    telegram_min_discount_pct: 60,
    telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §16 case 1 — Fires: cheapest 16¢, next-10 median 32¢, all EN/NM
// ---------------------------------------------------------------------------

describe('§16 case 1 — fires at threshold 50 with 50% discount', () => {
  it('returns a DealResult with discountPct 50 and is_deal true', () => {
    // Candidate: 16¢
    const candidate = makeProduct(16);

    // Cohort: 10 listings all at 32¢ → median = 32¢
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));

    const products = [candidate, ...cohort];
    const result = evaluateBlueprint(products, defaultSettings());

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(candidate.id);
    expect(result!.baselineCents).toBe(32);
    expect(result!.discountPct).toBe(50);
    expect(result!.savingsCents).toBe(16);
    expect(result!.cohortSize).toBe(10);
  });

  it('uses the candidate as filtered[0] (cheapest), not the original order', () => {
    // Shuffle: put the 32¢ listings first, candidate last in input array.
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));
    const candidate = makeProduct(16);
    const products = [...cohort, candidate]; // candidate last in input

    const result = evaluateBlueprint(products, defaultSettings());

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(candidate.id);
    expect(result!.discountPct).toBe(50);
  });

  it('does not mutate the input array', () => {
    const products = [makeProduct(16), ...Array.from({ length: 10 }, () => makeProduct(32))];
    const original = products.map((p) => p.id);
    evaluateBlueprint(products, defaultSettings());
    expect(products.map((p) => p.id)).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// §16 case 2 — No fire (thin market): only 3 qualifying copies
// ---------------------------------------------------------------------------

describe('§16 case 2 — no fire: thin market (< min_cohort + 1 qualifying copies)', () => {
  it('returns null when only 3 EN/NM listings exist (min_cohort=5 → needs 6)', () => {
    const products = [
      makeProduct(5),
      makeProduct(30),
      makeProduct(32),
    ];

    const result = evaluateBlueprint(products, defaultSettings());
    expect(result).toBeNull();
  });

  it('returns null with exactly min_cohort qualifying copies (no candidate slot)', () => {
    // 5 copies = min_cohort, but we need min_cohort + 1 (candidate + cohort)
    const products = Array.from({ length: 5 }, (_, i) => makeProduct(30 + i));
    const result = evaluateBlueprint(products, defaultSettings());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §16 case 3 — No fire (not cheap enough): 30¢ vs median 34¢ at threshold 50
// ---------------------------------------------------------------------------

describe('§16 case 3 — no fire: candidate not cheap enough', () => {
  it('returns null when cheapest 30¢ vs median 34¢ (threshold 50 → needs ≤17¢)', () => {
    // candidate: 30¢; cohort: 10 listings at 34¢ → median = 34¢
    // is_deal = 30 <= (50/100) * 34 = 17 → false
    const candidate = makeProduct(30);
    const cohort = Array.from({ length: 10 }, () => makeProduct(34));

    const result = evaluateBlueprint([candidate, ...cohort], defaultSettings());
    expect(result).toBeNull();
  });

  it('fires when the same candidate is just at the boundary (30¢ vs 60¢ → exactly 50%)', () => {
    // Confirm the gate is inclusive (<=)
    const candidate = makeProduct(30);
    const cohort = Array.from({ length: 10 }, () => makeProduct(60));

    const result = evaluateBlueprint([candidate, ...cohort], defaultSettings());
    expect(result).not.toBeNull();
    expect(result!.discountPct).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// §16 case 4 — Condition filter: Poor copy at 5¢ excluded by min_condition NM
// ---------------------------------------------------------------------------

describe('§16 case 4 — condition filter: Poor copy excluded when min_condition=Near Mint', () => {
  it('excludes a Poor copy and does not make it the candidate', () => {
    // Poor listing at 5¢ — should be dropped before sorting
    const poor = makeProduct(5, { condition: 'Poor' });

    // 11 Near Mint copies: cheapest at 16¢ (becomes candidate), rest at 32¢
    const nmCandidate = makeProduct(16, { condition: 'Near Mint' });
    const nmCohort = Array.from({ length: 10 }, () =>
      makeProduct(32, { condition: 'Near Mint' }),
    );

    const products = [poor, nmCandidate, ...nmCohort];
    const result = evaluateBlueprint(products, defaultSettings({ min_condition: 'Near Mint' }));

    expect(result).not.toBeNull();
    // The Poor copy must NOT be the candidate
    expect(result!.product.id).not.toBe(poor.id);
    // The NM 16¢ listing IS the candidate
    expect(result!.product.id).toBe(nmCandidate.id);
    expect(result!.product.price.cents).toBe(16);
  });

  it('returns null when all qualifying copies are filtered out by condition', () => {
    // 20 Poor copies only; min_condition = Near Mint → all filtered, thin market
    const products = Array.from({ length: 20 }, () =>
      makeProduct(5, { condition: 'Poor' }),
    );
    const result = evaluateBlueprint(products, defaultSettings({ min_condition: 'Near Mint' }));
    expect(result).toBeNull();
  });

  it('drops listings with unknown/malformed condition strings instead of crashing', () => {
    // 1 malformed listing + 11 valid NM listings
    const malformed = makeProduct(1, { condition: 'NotACondition' });
    const nmCandidate = makeProduct(16);
    const nmCohort = Array.from({ length: 10 }, () => makeProduct(32));

    const products = [malformed, nmCandidate, ...nmCohort];
    // Should not throw; malformed listing dropped silently
    const result = evaluateBlueprint(products, defaultSettings());

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(nmCandidate.id);
  });

  it('accepts Slightly Played when min_condition allows it', () => {
    const spCandidate = makeProduct(16, { condition: 'Slightly Played' });
    const spCohort = Array.from({ length: 10 }, () =>
      makeProduct(32, { condition: 'Slightly Played' }),
    );

    const result = evaluateBlueprint(
      [spCandidate, ...spCohort],
      defaultSettings({ min_condition: 'Slightly Played' }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(spCandidate.id);
  });
});

// ---------------------------------------------------------------------------
// §16 case 5 — Foil filter: foil_pref=nonfoil excludes foil listings
// ---------------------------------------------------------------------------

describe('§16 case 5 — foil filter: foil_pref=nonfoil ignores foil listings entirely', () => {
  it('excludes all foil listings so a cheap foil is not the candidate', () => {
    // Foil listing at 5¢ — should be dropped entirely
    const foilCheap = makeProduct(5, { mtg_foil: true });

    // Non-foil copies: 16¢ candidate + 10 at 32¢
    const nfCandidate = makeProduct(16, { mtg_foil: false });
    const nfCohort = Array.from({ length: 10 }, () =>
      makeProduct(32, { mtg_foil: false }),
    );

    const products = [foilCheap, nfCandidate, ...nfCohort];
    const result = evaluateBlueprint(products, defaultSettings({ foil_pref: 'nonfoil' }));

    expect(result).not.toBeNull();
    // foil listing must NOT be the candidate
    expect(result!.product.id).not.toBe(foilCheap.id);
    expect(result!.product.id).toBe(nfCandidate.id);
    expect(result!.product.price.cents).toBe(16);
  });

  it('returns null when only foil listings exist and foil_pref=nonfoil', () => {
    const products = Array.from({ length: 20 }, () =>
      makeProduct(5, { mtg_foil: true }),
    );
    const result = evaluateBlueprint(products, defaultSettings({ foil_pref: 'nonfoil' }));
    expect(result).toBeNull();
  });

  it('foil_pref=foil keeps only foil listings and excludes non-foil', () => {
    // Non-foil cheap listing at 5¢ — should be excluded
    const nfCheap = makeProduct(5, { mtg_foil: false });

    // Foil copies: 16¢ candidate + 10 at 32¢
    const foilCandidate = makeProduct(16, { mtg_foil: true });
    const foilCohort = Array.from({ length: 10 }, () =>
      makeProduct(32, { mtg_foil: true }),
    );

    const products = [nfCheap, foilCandidate, ...foilCohort];
    const result = evaluateBlueprint(products, defaultSettings({ foil_pref: 'foil' }));

    expect(result).not.toBeNull();
    expect(result!.product.id).not.toBe(nfCheap.id);
    expect(result!.product.id).toBe(foilCandidate.id);
  });

  it('foil_pref=any includes both foil and non-foil listings', () => {
    // Mix of foil and non-foil; cheapest should win regardless
    const cheapFoil = makeProduct(16, { mtg_foil: true });
    const nfCohort = Array.from({ length: 10 }, () =>
      makeProduct(32, { mtg_foil: false }),
    );

    const result = evaluateBlueprint(
      [cheapFoil, ...nfCohort],
      defaultSettings({ foil_pref: 'any' }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(cheapFoil.id);
  });
});
