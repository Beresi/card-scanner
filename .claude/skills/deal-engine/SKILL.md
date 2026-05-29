---
name: deal-engine
description: The §7 deal-detection algorithm — pure functions that filter one blueprint's listings, take a MEDIAN baseline of the next-cheapest cohort, and decide is_deal/discount_pct. Load before touching src/scan/dealEngine.ts or src/scan/conditions.ts, or any condition-rank / median-baseline / threshold logic. All money is integer cents; no I/O, no Date.now(); dedupe is the repo's job, not here.
---

# Deal Engine

## Purpose
Given one blueprint's cheapest-25 marketplace listings plus the **effective per-item
settings** (inheritance already resolved upstream), decide whether the cheapest qualifying
copy is an underpriced deal and by how much. Filter → price-sort ascending → take a
**median** baseline of the next-cheapest cohort → compare the candidate against a percent
threshold. The engine is **pure**: no `fetch`, no DB, no `Date.now()`; same inputs always
yield the same `DealResult | null`. Spec: PRD §7; edge cases §13; fixtures §16. Planned
files `src/scan/dealEngine.ts` (algorithm) and `src/scan/conditions.ts` (rank ladder).

All money is **integer cents**. No floats anywhere — not in the baseline, not in
`savings_cents`. See [deal-engine doc](../../../docs/documentation/deal-engine.md).

## Inputs & defaults
Effective settings arrive pre-resolved (NULL overrides already fell back to global config
via `resolveEffective`, PRD §9a — see the **inherit-override** skill). The engine assumes
no NULLs and listings already fetched with `language=en`.

| Setting | Default | Meaning |
|---|---|---|
| `min_condition` | `Near Mint` | Lowest acceptable condition; lower-rank copies dropped. |
| `foil_pref` | `any` | `'any' \| 'foil' \| 'nonfoil'`; `any` skips the foil check. |
| `allow_graded` | `false` | When `false`, graded copies excluded. |
| `threshold_pct` | `50` | Candidate must be ≤ this % of baseline to be a deal. |
| `cohort_size` | `10` | Size of the next-cheapest comparator window. |
| `min_cohort` | `5` | Min comparators required, else skip (thin market). |

## Core patterns

### `evaluateBlueprint` — the §7 pure function
```ts
import { conditionRank } from './conditions';
import type { Product, EffectiveSettings, DealResult } from './types';

export function evaluateBlueprint(
  products: Product[],
  settings: EffectiveSettings,
): DealResult | null {
  // 1. Filter the cheapest-25 down to qualifying copies (all within one comparable set).
  const filtered = products.filter((p) =>
    p.properties_hash.mtg_language === 'en' &&
    p.on_vacation === false &&
    (settings.allow_graded || p.graded === false) &&
    p.quantity >= 1 &&
    conditionRank(p.properties_hash.condition) >= conditionRank(settings.min_condition) &&
    foilMatches(p.properties_hash.mtg_foil, settings.foil_pref) // 'any' → always true
  );

  // 2. Price-sort ascending by integer cents.
  filtered.sort((a, b) => a.price.cents - b.price.cents);

  // 3. Thin-market guard: need the candidate PLUS at least min_cohort comparators.
  if (filtered.length < settings.min_cohort + 1) return null;

  // 4. Candidate is the cheapest; cohort is the NEXT cheapest (candidate excluded).
  const candidate = filtered[0];
  const cohort = filtered.slice(1, 1 + settings.cohort_size); // start at 1, not 0
  if (cohort.length < settings.min_cohort) return null;

  // 5. Median baseline (integer cents) — never the mean.
  const baselineCents = median(cohort.map((p) => p.price.cents));

  // 6. Discount + verdict. Both compare against the baseline, not the candidate's price.
  const discountPct = Math.round((1 - candidate.price.cents / baselineCents) * 100);
  const isDeal = candidate.price.cents <= (settings.threshold_pct / 100) * baselineCents;
  if (!isDeal) return null;

  return {
    product: candidate,
    baselineCents,
    cohortSize: cohort.length,
    discountPct,
    savingsCents: baselineCents - candidate.price.cents,
  };
}

function foilMatches(isFoil: boolean, pref: EffectiveSettings['foil_pref']): boolean {
  if (pref === 'any') return true;
  return pref === 'foil' ? isFoil : !isFoil;
}
```

### `median` + `conditionRank` helpers
```ts
// conditions.ts — the rank ladder owns "best→worst" and "at least min condition".
const CONDITION_RANK = {
  Mint: 7, 'Near Mint': 6, 'Slightly Played': 5, 'Moderately Played': 4,
  Played: 3, 'Heavily Played': 2, Poor: 1,
} as const;
export type Condition = keyof typeof CONDITION_RANK;

export function conditionRank(c: Condition): number {
  const rank = CONDITION_RANK[c];
  if (rank === undefined) throw new Error(`Unknown condition: ${c}`); // fail loud
  return rank;
}

// Higher rank = better condition → keep copies whose rank is AT LEAST the minimum's.
export function meetsMinCondition(c: Condition, min: Condition): boolean {
  return conditionRank(c) >= conditionRank(min);
}

// median of integer cents — even length averages the two middles, rounded to cents.
export function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
```

## Standards
@docs/standards/coding-standards.md

## Examples (Good / Bad)

### Good — §16 case #1 (fires, median baseline)
All copies EN / Near Mint. Candidate `16` cents; next-10 cohort median `32` cents.
```ts
// candidate.price.cents = 16
// baselineCents         = median(cohort) = 32   // NOT the mean
// discountPct           = Math.round((1 - 16/32) * 100) = 50
// isDeal                = 16 <= (50/100) * 32 = 16   // 16 <= 16 → true
// → DealResult { baselineCents: 32, discountPct: 50, savingsCents: 16 }
```
Money is shown as `0.16` / `0.32` only in prose; the engine only ever sees `16` / `32`.

### Bad — mean baseline + thin-market fire
```ts
// ❌ mean is dragged down by a SECOND underpriced copy → wrong baseline / false verdict
const baseline = cohort.reduce((a, p) => a + p.price.cents, 0) / cohort.length;
// ❌ no thin-market guard: 3 qualifying copies still produce a "deal" off noise
const candidate = filtered[0];
const cohort = filtered.slice(0); // ❌ includes candidate → median pulled toward it
```
§16 case #2: only 3 qualifying copies, `min_cohort = 5` → `filtered.length < 6` is true →
return `null`. No baseline computed, no deal. A mean would also let one anomalous cohort
listing skew the going-rate; the median is robust to it (PRD §7 "median, not mean").

## Gotchas
- **Median, not mean.** A second underpriced copy in the cohort shifts a mean but not the
  median; the baseline must stay representative of the going rate (PRD §7).
- **Off-by-one in the cohort slice.** Candidate is `filtered[0]` and must be **excluded**
  from its own baseline. Cohort is `filtered.slice(1, 1 + cohort_size)` — start at index
  `1`, not `0`. Slicing from `0` lets the cheap candidate pull the median toward itself.
- **Integer-cents rounding of `discount_pct`.** `discount_pct` is `Math.round(...)`, so a
  reported `50%` can come from a candidate fractionally above/below half the baseline. The
  authoritative gate is `is_deal` (`candidate.cents <= threshold_pct/100 * baseline`) —
  **never branch the verdict on the rounded `discount_pct`**. `median` of an even-length
  cohort averages the two middles, rounded to integer cents — no float in `baselineCents`.
- **Dedupe is NOT this skill's job.** The engine returns a verdict for one blueprint; "have
  we seen this listing?" is the repo's `ON CONFLICT(product_id) DO NOTHING` upsert (PRD §7,
  §9 — see the **d1-database** skill). Re-running on the same data returns the same result.
- **Pure — no I/O, no `Date.now()`.** No `fetch`, no DB, no clock reads. Resolved settings
  and the product list come in as arguments; a `DealResult | null` comes out. This is what
  makes the §16 fixtures direct unit tests.
- **Thin-market skip is two checks.** `filtered.length < min_cohort + 1` (before slicing)
  **and** `cohort.length < min_cohort` (after slicing, since the cheapest-25 cap or short
  lists can leave a cohort below `cohort_size`).
- **`conditionRank` fails loud** on an unknown condition string rather than ranking it `0`.
  The wire is parsed into typed `Condition`s at the boundary; the engine trusts that.

## Related skills
- **cardtrader-api** — supplies the cheapest-25 product lists (`marketplace/products`, `language=en`).
- **inherit-override** — resolves effective per-item settings (`resolveEffective`, §9a) before they reach the engine.
- **testing** — §16 fixture cases 1–5 are the engine's named unit tests.
- **d1-database** — owns the `UNIQUE(product_id)` upsert/dedupe the engine deliberately does not do.
