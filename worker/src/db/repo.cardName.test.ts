/**
 * Tests for resolveCardBlueprints() — the cache-only query that resolves
 * a normalized card name to the list of blueprint rows that match it.
 *
 * Uses the real better-sqlite3 in-memory D1 adapter (makeD1) with the full
 * schema applied, so actual SQL is exercised end-to-end — same approach as
 * scanner.chunked.test.ts and routes.test.ts.
 *
 * No CardTrader network calls.  All blueprint rows are seeded directly via
 * the raw better-sqlite3 handle.
 *
 * Covers:
 *  1. resolveCardBlueprints(db, nameNorm, null) — returns all blueprints
 *     across sets matching the normalized name.
 *  2. resolveCardBlueprints(db, nameNorm, [expansionId]) — filters to only
 *     blueprints in the given expansion(s).
 *  3. Empty / no match — returns [].
 *  4. Normalization: a row inserted with a normalized name_norm is found by
 *     the expected normalized form (confirms caller must normalize before querying).
 *  5. Empty expansionIds array [] behaves the same as null (no filter applied).
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { makeD1 } from '../api/__test-helpers__/d1';
import { resolveCardBlueprints } from './repo';
import { normalizeCardName } from '../scan/cardName';

// ---------------------------------------------------------------------------
// Seed helper — insert a minimal blueprint row directly.
// ---------------------------------------------------------------------------

function seedBlueprint(
  raw: Database.Database,
  fields: {
    id: number;
    expansion_id: number;
    name: string;
    name_norm?: string;
  },
): void {
  const { id, expansion_id, name, name_norm = normalizeCardName(name) } = fields;
  raw
    .prepare(
      `INSERT INTO blueprints (id, expansion_id, name, name_norm)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, expansion_id, name, name_norm);
}

// ---------------------------------------------------------------------------
// Case 1 — all sets: no expansionIds filter (null)
// ---------------------------------------------------------------------------

describe('resolveCardBlueprints — all sets (expansionIds = null)', () => {
  it('returns all blueprints whose name_norm matches across all sets', async () => {
    const { db, raw } = makeD1();

    // Two printings of "Lightning Bolt" in different expansions.
    seedBlueprint(raw, { id: 101, expansion_id: 1, name: 'Lightning Bolt' });
    seedBlueprint(raw, { id: 102, expansion_id: 2, name: 'Lightning Bolt' });
    // A different card in expansion 1 — must NOT appear in the result.
    seedBlueprint(raw, { id: 103, expansion_id: 1, name: 'Counterspell' });

    const results = await resolveCardBlueprints(db, 'lightning bolt', null);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual([101, 102]);
  });

  it('returns blueprint ids and expansion_ids in each result', async () => {
    const { db, raw } = makeD1();

    seedBlueprint(raw, { id: 201, expansion_id: 10, name: 'Black Lotus' });

    const results = await resolveCardBlueprints(db, 'black lotus', null);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(201);
    expect(results[0].expansion_id).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — with expansionIds filter
// ---------------------------------------------------------------------------

describe('resolveCardBlueprints — with expansionIds filter', () => {
  it('returns only blueprints in the specified expansion(s)', async () => {
    const { db, raw } = makeD1();

    // Lightning Bolt in three expansions.
    seedBlueprint(raw, { id: 301, expansion_id: 1, name: 'Lightning Bolt' });
    seedBlueprint(raw, { id: 302, expansion_id: 2, name: 'Lightning Bolt' });
    seedBlueprint(raw, { id: 303, expansion_id: 3, name: 'Lightning Bolt' });

    // Filter to expansion 2 only.
    const results = await resolveCardBlueprints(db, 'lightning bolt', [2]);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(302);
    expect(results[0].expansion_id).toBe(2);
  });

  it('accepts multiple expansion ids and returns all matching', async () => {
    const { db, raw } = makeD1();

    seedBlueprint(raw, { id: 401, expansion_id: 1, name: 'Mox Pearl' });
    seedBlueprint(raw, { id: 402, expansion_id: 2, name: 'Mox Pearl' });
    seedBlueprint(raw, { id: 403, expansion_id: 3, name: 'Mox Pearl' });

    const results = await resolveCardBlueprints(db, 'mox pearl', [1, 3]);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual([401, 403]);
  });

  it('returns [] when the expansion filter matches no blueprints', async () => {
    const { db, raw } = makeD1();

    seedBlueprint(raw, { id: 501, expansion_id: 1, name: 'Tarmogoyf' });

    // Filter to expansion 99 — not in DB.
    const results = await resolveCardBlueprints(db, 'tarmogoyf', [99]);

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — empty / no match
// ---------------------------------------------------------------------------

describe('resolveCardBlueprints — empty / no match', () => {
  it('returns [] when no blueprints match the name_norm', async () => {
    const { db, raw } = makeD1();

    seedBlueprint(raw, { id: 601, expansion_id: 1, name: 'Counterspell' });

    const results = await resolveCardBlueprints(db, 'lightning bolt', null);

    expect(results).toEqual([]);
  });

  it('returns [] from an empty blueprints table', async () => {
    const { db } = makeD1(); // no rows seeded

    const results = await resolveCardBlueprints(db, 'lightning bolt', null);

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — normalization: name_norm is matched exactly
// ---------------------------------------------------------------------------

describe('resolveCardBlueprints — name_norm matching', () => {
  it('finds a blueprint when the caller passes the normalized form of the name', async () => {
    const { db, raw } = makeD1();

    // Row stored with a normalized name_norm.
    const nameNorm = normalizeCardName('Lightning Bolt');  // → 'lightning bolt'
    seedBlueprint(raw, { id: 701, expansion_id: 1, name: 'Lightning Bolt', name_norm: nameNorm });

    const results = await resolveCardBlueprints(db, nameNorm, null);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(701);
  });

  it('does NOT find a blueprint when queried with un-normalized form (case mismatch)', async () => {
    const { db, raw } = makeD1();

    // Row stored with normalized name_norm (lowercase).
    seedBlueprint(raw, { id: 801, expansion_id: 1, name: 'Lightning Bolt' });
    // name_norm in DB = 'lightning bolt'

    // Query with non-normalized (capitalized) form — should NOT match (exact equality).
    const results = await resolveCardBlueprints(db, 'Lightning Bolt', null);

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — empty expansionIds [] treated same as null (no filter)
// ---------------------------------------------------------------------------

describe('resolveCardBlueprints — empty expansionIds [] = no filter', () => {
  it('returns all matching blueprints when expansionIds is an empty array', async () => {
    const { db, raw } = makeD1();

    seedBlueprint(raw, { id: 901, expansion_id: 1, name: 'Ancestral Recall' });
    seedBlueprint(raw, { id: 902, expansion_id: 2, name: 'Ancestral Recall' });

    // Empty array: the repo branches on `expansionIds && expansionIds.length > 0`
    // → treated same as null → no IN filter applied.
    const results = await resolveCardBlueprints(db, 'ancestral recall', []);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual([901, 902]);
  });
});
