/**
 * Tests for normalizeCardName() — the pure card-name normalisation helper.
 *
 * The function is the single source of truth for consistent name matching
 * across blueprint caching, catalog search, and watch-item creation.
 *
 * Rules under test (from the module JSDoc):
 *  1. Trim leading/trailing whitespace.
 *  2. Collapse internal whitespace runs to a single ASCII space.
 *  3. NFKD decomposition — ligatures/accented chars split to base + combining marks.
 *  4. Strip combining marks (U+0300–U+036F).
 *  5. Lowercase.
 *  6. Punctuation (apostrophes, commas, hyphens) preserved.
 *
 * All tests are deterministic — pure function, no I/O, no network.
 */

import { describe, it, expect } from 'vitest';
import { normalizeCardName } from './cardName';

// ---------------------------------------------------------------------------
// Basic whitespace handling
// ---------------------------------------------------------------------------

describe('normalizeCardName — whitespace', () => {
  it('trims leading and trailing spaces', () => {
    expect(normalizeCardName('  Lightning Bolt  ')).toBe('lightning bolt');
  });

  it('collapses multiple internal spaces to one', () => {
    expect(normalizeCardName('Lightning   Bolt')).toBe('lightning bolt');
  });

  it('collapses tabs and mixed whitespace', () => {
    expect(normalizeCardName('Lightning\t\tBolt')).toBe('lightning bolt');
  });

  it('empty string returns empty string', () => {
    expect(normalizeCardName('')).toBe('');
  });

  it('whitespace-only string returns empty string', () => {
    expect(normalizeCardName('   ')).toBe('');
  });

  it('single word with no spaces is lowercased', () => {
    expect(normalizeCardName('Counterspell')).toBe('counterspell');
  });
});

// ---------------------------------------------------------------------------
// Case folding
// ---------------------------------------------------------------------------

describe('normalizeCardName — case folding', () => {
  it('lowercases all ASCII letters', () => {
    expect(normalizeCardName('Black Lotus')).toBe('black lotus');
  });

  it('lowercases mixed case', () => {
    expect(normalizeCardName('bLaCk LoTuS')).toBe('black lotus');
  });
});

// ---------------------------------------------------------------------------
// Diacritics and NFKD normalisation
// ---------------------------------------------------------------------------

describe('normalizeCardName — diacritics (NFKD + combining mark strip)', () => {
  it('strips accent from é (e + U+0301)', () => {
    // "é" → NFKD → "e" + U+0301 → strip → "e"
    expect(normalizeCardName('Élan')).toBe('elan');
  });

  it('handles Æther Vial (Æ lowercases to æ, not split to ae)', () => {
    // "Æ" does NOT decompose to "AE" under NFKD (U+00C6 has no canonical decomposition).
    // It lowercases to "æ" (U+00E6) — matching is still symmetric since both the DB
    // name_norm and the lookup key go through the same normalizeCardName call.
    // Note: the module JSDoc example is aspirational; the actual output is 'æther vial'.
    expect(normalizeCardName('Æther Vial')).toBe('æther vial');
  });

  it('handles ö (Jötun Grunt)', () => {
    expect(normalizeCardName('Jötun Grunt')).toBe('jotun grunt');
  });

  it('handles acute accent over u (Lúðvík example)', () => {
    // Covers compound accented chars: ú → u, ð → ð (no combining mark), ví → vi
    // Actual: "Lúðvík" → lower NFKD strip → "luðvik"
    // ð (eth) has no combining mark → preserved as-is after lower
    expect(normalizeCardName("Lúðvík's Blade")).toBe("luðvik's blade");
  });
});

// ---------------------------------------------------------------------------
// Punctuation preservation
// ---------------------------------------------------------------------------

describe('normalizeCardName — punctuation preserved', () => {
  it('preserves apostrophe (single quote)', () => {
    expect(normalizeCardName("Gaea's Cradle")).toBe("gaea's cradle");
  });

  it("preserves apostrophe in a multi-word name — Serra's Sanctum", () => {
    expect(normalizeCardName("Serra's Sanctum")).toBe("serra's sanctum");
  });

  it('preserves hyphen', () => {
    expect(normalizeCardName('Will-o-the-Wisp')).toBe('will-o-the-wisp');
  });

  it('preserves comma', () => {
    // Unusual but the rule is to keep commas.
    expect(normalizeCardName('Sword, Shield')).toBe('sword, shield');
  });
});

// ---------------------------------------------------------------------------
// Idempotence — normalizing an already-normalized name returns the same value
// ---------------------------------------------------------------------------

describe('normalizeCardName — idempotence', () => {
  it('already-normalized input is unchanged', () => {
    const name = "gaea's cradle";
    expect(normalizeCardName(name)).toBe(name);
  });

  it('double normalization gives same result', () => {
    const once = normalizeCardName('  Æther   Vial ');
    const twice = normalizeCardName(once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// Real card names from CardTrader data
// ---------------------------------------------------------------------------

describe('normalizeCardName — real CardTrader card names', () => {
  it('Lightning Bolt', () => {
    expect(normalizeCardName('Lightning Bolt')).toBe('lightning bolt');
  });

  it('Mox Pearl', () => {
    expect(normalizeCardName('Mox Pearl')).toBe('mox pearl');
  });

  it('Mind Over Matter', () => {
    expect(normalizeCardName('Mind Over Matter')).toBe('mind over matter');
  });

  it('Tarmogoyf', () => {
    expect(normalizeCardName('Tarmogoyf')).toBe('tarmogoyf');
  });
});
