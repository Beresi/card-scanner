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
    min_discount_pct: 50,
    cohort_size: 10,
    min_cohort: 5,
    // Floors + gap gate set to 0 so existing §16 tests (penny-scale prices) remain valid.
    // Tests that exercise the floors / gap gate override these explicitly.
    min_price_cents: 0,
    min_savings_cents: 0,
    min_gap_pct: 0,
    importance: 'normal',
    telegram_enabled: false,
    telegram_min_discount_pct: 60,
    telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    // Migration 0005: default to 'discount' so existing §16 tests are unchanged.
    detection_mode: 'discount',
    max_price_cents: null,
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

// ---------------------------------------------------------------------------
// Absolute deal floors — PENNY-CARD false-positive suppression
// ---------------------------------------------------------------------------

describe('absolute deal floors — min_price_cents + min_savings_cents', () => {
  // PENNY-CARD case: ~$0.18 vs median ~$0.32; 44% off passes the % gate but
  // the absolute savings is only 14¢ — below both default floors.
  // With real defaults (min_price_cents=200, min_savings_cents=100) this
  // is correctly classified as NOT a deal.
  it('PENNY-CARD: 18¢ cheapest vs median 32¢ — fails floors → null (no false positive)', () => {
    const candidate = makeProduct(18);
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 200, min_savings_cents: 100 }),
    );

    // 18¢ fails min_price_cents=200 AND savingsCents=14 fails min_savings_cents=100
    expect(result).toBeNull();
  });

  it('PENNY-CARD: even at exactly 50% off (16¢ vs 32¢), fails floors → null', () => {
    // This is the §16 case-1 scenario but with real production floors applied.
    // 16¢ < 200¢ (min_price_cents) → not a deal in a real config.
    const candidate = makeProduct(16);
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).toBeNull();
  });

  // GENUINE DEAL: $5.00 candidate vs $11.00 cohort median — 55% off, $6 savings.
  // Passes all three gates: % (55% ≥ 50%), price (500¢ ≥ 200¢), savings (600¢ ≥ 100¢).
  it('GENUINE-DEAL: 500¢ candidate vs 1100¢ median — passes all three gates', () => {
    const candidate = makeProduct(500);
    const cohort = Array.from({ length: 10 }, () => makeProduct(1100));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(500);
    expect(result!.baselineCents).toBe(1100);
    expect(result!.savingsCents).toBe(600);
    // discountPct = round((1 - 500/1100)*100) = round(54.5...) = 55
    expect(result!.discountPct).toBe(55);
  });

  // BOUNDARY — tiny savings only: cheap card at $2.50 vs median $3.00 → 17% off.
  // Fails the % gate (17% < 50%) — already null for that reason.
  // Extra check: also fails savings floor (50¢ < 100¢) even with a loose % gate.
  it('CHEAP-CARD savings-floor: 250¢ vs 300¢ median — tiny savings (50¢ < 100¢) → null', () => {
    const candidate = makeProduct(250);
    const cohort = Array.from({ length: 10 }, () => makeProduct(300));

    // Use a very loose % threshold (min_discount_pct=90, i.e. "90% off required" — passes at just 17%) so only the savings floor blocks it.
    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_discount_pct: 90, min_price_cents: 200, min_savings_cents: 100 }),
    );

    // savingsCents = 300 - 250 = 50 < 100 → fails min_savings_cents → null
    expect(result).toBeNull();
  });

  // BOUNDARY — price floor exactly met: candidate = min_price_cents.
  it('price floor boundary: candidate exactly at min_price_cents — passes (inclusive >=)', () => {
    // candidate = 200¢ (exactly at floor), cohort median = 500¢, savings = 300¢
    // % gate: 200 <= (1-50/100)*500 = 250 → true; price: 200 >= 200 → true; savings: 300 >= 100 → true
    const candidate = makeProduct(200);
    const cohort = Array.from({ length: 10 }, () => makeProduct(500));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(200);
    expect(result!.savingsCents).toBe(300);
  });

  // BOUNDARY — price one cent below floor: candidate = min_price_cents - 1.
  it('price floor boundary: candidate one cent below min_price_cents → null', () => {
    // candidate = 199¢, floor = 200¢ → fails min_price_cents
    const candidate = makeProduct(199);
    const cohort = Array.from({ length: 10 }, () => makeProduct(500));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).toBeNull();
  });

  // BOUNDARY — savings floor exactly met: savingsCents = min_savings_cents.
  it('savings floor boundary: savings exactly at min_savings_cents — passes (inclusive >=)', () => {
    // candidate = 400¢, cohort median = 500¢, savings = 100¢ (exactly at floor)
    // % gate: 400 <= (1-50/100)*500 = 250 → false… adjust: use min_discount_pct=15
    // 400 <= (1-15/100)*500 = 425 → true; savings = 100 >= 100 → true; price: 400 >= 200 → true
    const candidate = makeProduct(400);
    const cohort = Array.from({ length: 10 }, () => makeProduct(500));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_discount_pct: 15, min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).not.toBeNull();
    expect(result!.savingsCents).toBe(100);
  });

  // BOUNDARY — savings one cent below floor.
  it('savings floor boundary: savings one cent below min_savings_cents → null', () => {
    // candidate = 401¢, cohort median = 500¢, savings = 99¢ < 100¢
    const candidate = makeProduct(401);
    const cohort = Array.from({ length: 10 }, () => makeProduct(500));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_discount_pct: 15, min_price_cents: 200, min_savings_cents: 100 }),
    );

    expect(result).toBeNull();
  });

  // With floors disabled (set to 0/0), a cheap card at 50% off still fires.
  it('floors disabled (0, 0): 16¢ vs 32¢ at 50% threshold still fires (backward compat)', () => {
    const candidate = makeProduct(16);
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ min_price_cents: 0, min_savings_cents: 0 }),
    );

    expect(result).not.toBeNull();
    expect(result!.discountPct).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Price mode (migration 0005 — detection_mode: 'price')
// ---------------------------------------------------------------------------

describe("price mode — detection_mode: 'price'", () => {
  // Case 1: cheapest passing listing ≤ max_price_cents → deal with self-baseline
  it('fires: cheapest 100¢ ≤ max_price_cents 200¢ → discountPct=0, baselineCents=candidate price', () => {
    const candidate = makeProduct(100);
    const cohort = Array.from({ length: 3 }, () => makeProduct(300));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ detection_mode: 'price', max_price_cents: 200 }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.id).toBe(candidate.id);
    expect(result!.product.price.cents).toBe(100);    // integer cents
    expect(result!.discountPct).toBe(0);               // no discount relative to a baseline
    expect(result!.savingsCents).toBe(0);              // no savings relative to a baseline
    expect(result!.baselineCents).toBe(100);           // self-baseline = candidate price
  });

  // Case 2: cheapest > max_price_cents → null
  it('no deal: cheapest 201¢ > max_price_cents 200¢ → returns null', () => {
    const candidate = makeProduct(201);
    const cohort = Array.from({ length: 10 }, () => makeProduct(500));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ detection_mode: 'price', max_price_cents: 200 }),
    );

    expect(result).toBeNull();
  });

  // Case 3: single listing (thin market that would fail discount-mode min_cohort) → still deals
  it('thin market: single listing at 50¢ ≤ max_price_cents 100¢ → deal (no min_cohort guard)', () => {
    const candidate = makeProduct(50);

    const result = evaluateBlueprint(
      [candidate],
      defaultSettings({ detection_mode: 'price', max_price_cents: 100 }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(50);
    expect(result!.cohortSize).toBe(1);   // total passing listings = 1 (informational)
    expect(result!.discountPct).toBe(0);
  });

  // Case 4: condition/foil filter still drops listings in price mode — the next
  // passing listing after the excluded one becomes the candidate
  it('condition filter still active: Poor copy at 5¢ excluded → 150¢ NM copy is candidate', () => {
    const poor = makeProduct(5, { condition: 'Poor' });
    const nmCandidate = makeProduct(150, { condition: 'Near Mint' });
    const nmCohort = Array.from({ length: 3 }, () =>
      makeProduct(500, { condition: 'Near Mint' }),
    );

    const result = evaluateBlueprint(
      [poor, nmCandidate, ...nmCohort],
      defaultSettings({ detection_mode: 'price', max_price_cents: 200, min_condition: 'Near Mint' }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.id).not.toBe(poor.id);
    expect(result!.product.id).toBe(nmCandidate.id);
    expect(result!.product.price.cents).toBe(150);
  });

  // Case 5: max_price_cents is null → returns null (no ceiling configured)
  it('max_price_cents null → returns null (no ceiling to test against)', () => {
    const candidate = makeProduct(50);

    const result = evaluateBlueprint(
      [candidate],
      defaultSettings({ detection_mode: 'price', max_price_cents: null }),
    );

    expect(result).toBeNull();
  });

  // Case 6: anti-penny floors do NOT block price mode
  // 50¢ candidate with max_price_cents=100¢, but min_price_cents=200¢ → still a deal
  it('anti-penny floor ignored: 50¢ candidate, max_price_cents=100¢, min_price_cents=200¢ → deal', () => {
    const candidate = makeProduct(50);

    const result = evaluateBlueprint(
      [candidate],
      defaultSettings({
        detection_mode: 'price',
        max_price_cents: 100,
        min_price_cents: 200,      // would block in discount mode, not in price mode
        min_savings_cents: 500,    // also would block in discount mode
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(50);
    expect(result!.discountPct).toBe(0);
  });

  // Case 7: regression — discount mode still behaves identically when detection_mode='discount'
  it('regression: discount mode unchanged — 16¢ vs median 32¢ at threshold 50 fires', () => {
    const candidate = makeProduct(16);
    const cohort = Array.from({ length: 10 }, () => makeProduct(32));

    const result = evaluateBlueprint(
      [candidate, ...cohort],
      defaultSettings({ detection_mode: 'discount' }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(16);
    expect(result!.baselineCents).toBe(32);
    expect(result!.discountPct).toBe(50);
    expect(result!.savingsCents).toBe(16);
    expect(result!.cohortSize).toBe(10);
  });

  // Boundary: candidate exactly at max_price_cents → fires (inclusive ≤)
  it('boundary: candidate exactly at max_price_cents → deal (inclusive <=)', () => {
    const candidate = makeProduct(200);

    const result = evaluateBlueprint(
      [candidate],
      defaultSettings({ detection_mode: 'price', max_price_cents: 200 }),
    );

    expect(result).not.toBeNull();
    expect(result!.product.price.cents).toBe(200);
    expect(result!.baselineCents).toBe(200);
  });

  // cohortSize reflects total passing listings (informational)
  it('cohortSize equals total passing listings (informational, includes candidate)', () => {
    const candidate = makeProduct(50);
    const others = Array.from({ length: 4 }, () => makeProduct(300));

    const result = evaluateBlueprint(
      [candidate, ...others],
      defaultSettings({ detection_mode: 'price', max_price_cents: 100 }),
    );

    expect(result).not.toBeNull();
    expect(result!.cohortSize).toBe(5); // 1 candidate + 4 others, all pass filters
  });

  // All listings filtered out → returns null without crashing
  it('all listings filtered out by condition → returns null', () => {
    const products = Array.from({ length: 5 }, () =>
      makeProduct(5, { condition: 'Poor' }),
    );

    const result = evaluateBlueprint(
      products,
      defaultSettings({ detection_mode: 'price', max_price_cents: 100, min_condition: 'Near Mint' }),
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap-to-next-cheapest gate (migration 0009)
//
// Real-world reports: the median baseline sits well above the cheapest copy on
// any upward-sloping ladder, so the cheapest copy looked like a 30% deal even
// when the next copy was pennies more. The gap gate requires the candidate to be
// at least min_gap_pct% below the 2nd-cheapest qualifying copy.
// ---------------------------------------------------------------------------

describe('gap-to-next gate — suppresses tightly-packed ladders', () => {
  // Mana Sculpt (live): 1.83 cheapest, next 1.99 → only 8% gap. Median ~2.67
  // makes it LOOK like 31%, but you'd actually pay 1.99 if you missed it.
  const manaSculpt = [
    makeProduct(183),
    makeProduct(199), makeProduct(223), makeProduct(249), makeProduct(261),
    makeProduct(262), makeProduct(267), makeProduct(267), makeProduct(269),
    makeProduct(270), makeProduct(270),
  ];

  it('rejects Mana Sculpt at min_gap_pct 15 (8% gap to next copy)', () => {
    // min_discount_pct 0 isolates the gap gate (median gate always passes).
    const result = evaluateBlueprint(
      manaSculpt,
      defaultSettings({ min_discount_pct: 0, min_gap_pct: 15 }),
    );
    expect(result).toBeNull();
  });

  it('fires Mana Sculpt only when the gap gate is disabled (min_gap_pct 0)', () => {
    const result = evaluateBlueprint(
      manaSculpt,
      defaultSettings({ min_discount_pct: 0, min_gap_pct: 0 }),
    );
    expect(result).not.toBeNull();
    expect(result!.secondCheapestCents).toBe(199);
    expect(result!.gapPct).toBe(8); // round(1 - 183/199) = 8
  });

  it('keeps a genuine deal (Ravenous: 2.12 vs next 2.99 = 29% gap) at min_gap_pct 15', () => {
    const ravenous = [
      makeProduct(212),
      makeProduct(299), makeProduct(302), makeProduct(307), makeProduct(317),
      makeProduct(327), makeProduct(327), makeProduct(347), makeProduct(360),
      makeProduct(370), makeProduct(380),
    ];
    const result = evaluateBlueprint(
      ravenous,
      defaultSettings({ min_discount_pct: 0, min_gap_pct: 15 }),
    );
    expect(result).not.toBeNull();
    expect(result!.secondCheapestCents).toBe(299);
    expect(result!.gapPct).toBe(29); // round(1 - 212/299) = 29
    // avg of next 4 (299,302,307,317) = 1225/4 = 306.25 → 306
    expect(result!.avg4Cents).toBe(306);
  });

  it('avg4Cents is the mean of the next-4-cheapest (price mode self-baselines)', () => {
    // Discount mode: candidate 100, next four 200,220,240,260 → avg 230.
    const products = [
      makeProduct(100),
      makeProduct(200), makeProduct(220), makeProduct(240), makeProduct(260),
      makeProduct(300), makeProduct(300), makeProduct(300), makeProduct(300),
      makeProduct(300), makeProduct(300),
    ];
    const result = evaluateBlueprint(products, defaultSettings({ min_discount_pct: 0, min_gap_pct: 0 }));
    expect(result!.avg4Cents).toBe(230); // (200+220+240+260)/4

    // Price mode: self-baseline (no cohort to average).
    const priceModeProducts = [makeProduct(180), makeProduct(185), makeProduct(190)];
    const pm = evaluateBlueprint(
      priceModeProducts,
      defaultSettings({ detection_mode: 'price', max_price_cents: 200 }),
    );
    expect(pm!.avg4Cents).toBe(180);
  });

  it('gate is on the integer-cents comparison, not the rounded gapPct (boundary)', () => {
    // second-cheapest 100¢, min_gap_pct 20 → candidate must be ≤ 80¢.
    // 80¢ passes (exactly 20% below); 81¢ fails.
    const pass = evaluateBlueprint(
      [makeProduct(80), ...Array.from({ length: 10 }, () => makeProduct(100))],
      defaultSettings({ min_discount_pct: 0, min_gap_pct: 20 }),
    );
    expect(pass).not.toBeNull();

    const fail = evaluateBlueprint(
      [makeProduct(81), ...Array.from({ length: 10 }, () => makeProduct(100))],
      defaultSettings({ min_discount_pct: 0, min_gap_pct: 20 }),
    );
    expect(fail).toBeNull();
  });

  it('price mode ignores the gap gate (self-baseline: gapPct 0, second = candidate)', () => {
    const products = [makeProduct(180), makeProduct(185), makeProduct(190)];
    const result = evaluateBlueprint(
      products,
      defaultSettings({ detection_mode: 'price', max_price_cents: 200, min_gap_pct: 90 }),
    );
    expect(result).not.toBeNull();
    expect(result!.gapPct).toBe(0);
    expect(result!.secondCheapestCents).toBe(180);
  });
});
