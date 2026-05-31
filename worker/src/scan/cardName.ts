/**
 * Card-name normalisation — single source of truth for consistent name
 * matching across blueprint caching, catalog search, and watch-item creation.
 *
 * Pure module — no I/O, no networking, no DB, no Date.now().
 *
 * Normalisation rules (conservative and deterministic):
 *
 *   1. Trim leading/trailing whitespace.
 *   2. Collapse internal whitespace runs (spaces, tabs, etc.) to a single
 *      ASCII space.
 *   3. NFKD decomposition — splits composed characters into their base letter
 *      plus combining-mark code-points (e.g. "é" → "e" + U+0301).
 *   4. Strip Unicode combining marks (category Mn, regex ̀-ͯ) so
 *      "Æther" → "aether", "Jötun" → "jotun", "Lúðvík" → "ludvik".
 *      Note: Æ/æ decomposes under NFKD to "ae"/"ae" before the strip step,
 *      so ligatures and accented vowels both collapse correctly.
 *   5. Lowercase the result.
 *   6. Punctuation (apostrophes ', commas , hyphens -) is kept as-is.
 *      CardTrader uses these in names ("Gaea's Cradle", "Black Lotus", "Mind
 *      Over Matter") and both sides of any comparison normalise the same way,
 *      so preserving them is safe and avoids false collisions (e.g. between
 *      "Serra's Sanctum" and "Serras Sanctum" if we stripped apostrophes).
 *
 * Empty or whitespace-only input returns an empty string.
 *
 * PRD §6 / §9a; used in repo.ts (blueprint sync), catalog search, and watch-
 * item creation.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a CardTrader card name for reliable equality matching.
 *
 * See the module-level JSDoc for the full rule set.
 *
 * @example
 * normalizeCardName("  Lightning   Bolt ") // → "lightning bolt"
 * normalizeCardName("Æther Vial")          // → "æther vial"  (Æ has no NFKD decomposition)
 * normalizeCardName("Jötun Grunt")         // → "jotun grunt"
 * normalizeCardName("Gaea's Cradle")       // → "gaea's cradle"
 * normalizeCardName("Lúðvík's Blade")      // → "luðvik's blade"  (ð is not a combining mark)
 * normalizeCardName("   ")                 // → ""
 */
export function normalizeCardName(name: string): string {
  if (name.trim().length === 0) {
    return '';
  }

  return (
    name
      // Step 1+2: trim + collapse internal whitespace.
      .trim()
      .replace(/\s+/g, ' ')
      // Step 3: NFKD decomposition (ligatures, accents → base + combining marks).
      .normalize('NFKD')
      // Step 4: strip combining marks (U+0300–U+036F).
      .replace(/[̀-ͯ]/g, '')
      // Step 5: lowercase.
      .toLowerCase()
    // Step 6: punctuation (apostrophes, commas, hyphens) is preserved.
  );
}
