# Deal-detection Engine
> Greenfield — describes intent. Planned files: `src/scan/dealEngine.ts`,
> `src/scan/conditions.ts` (planned, `/worker` backend per [PRD §14](../../cardtrader-deal-scanner-PRD.md)).
> Pure functions — no I/O, no networking, no DB, no `Date.now()`. Directly unit-testable
> per [PRD §16](../../cardtrader-deal-scanner-PRD.md). Spec: [PRD §7](../../cardtrader-deal-scanner-PRD.md).

## Purpose
Given one blueprint's marketplace listings (the cheapest-25 array from
`marketplace/products`) plus the **effective per-item settings**, decide whether the
cheapest qualifying copy is an underpriced deal and by how much. The engine filters the
listings, price-sorts them, takes a **median** baseline of the next-cheapest cohort, and
compares the candidate against a percentage threshold. All money is **integer cents** in
the account's native currency — no floats anywhere (see
[coding-standards](../standards/coding-standards.md)).

The engine is pure: it receives already-resolved settings (inheritance applied upstream by
`resolveEffective`, [PRD §9a](../../cardtrader-deal-scanner-PRD.md)) and a product list, and
returns a `DealResult | null`. It performs no dedupe, no DB writes, no notification routing
— those belong to the scanner/repo/notifier layers.

## Inputs
Effective per-item settings (after inheritance resolution). Defaults are the global config
values a NULL override falls back to.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `min_condition` | `Condition` | `Near Mint` | Lowest acceptable condition; copies below are dropped. |
| `foil_pref` | `'any' \| 'foil' \| 'nonfoil'` | `any` | Foil filter; `any` skips the foil check entirely. |
| `allow_graded` | `boolean` | `false` | When `false`, graded copies are excluded. |
| `threshold_pct` | `integer` | `50` | Candidate must be ≤ this % of the baseline to be a deal. |
| `cohort_size` | `integer` | `10` | Size of the "next-cheapest" comparator window. |
| `min_cohort` | `integer` | `5` | Minimum comparators required; otherwise skip (thin market). |

The product list is the up-to-25 cheapest listings for one blueprint, already requested
with `language=en`. Each product carries `price.cents`, `quantity`, `graded`,
`on_vacation`, and `properties_hash.{condition, mtg_language, mtg_foil}` (shape in
[PRD §6](../../cardtrader-deal-scanner-PRD.md)).

## Condition ladder
`conditions.ts` (planned) owns the rank ladder and its helpers. Best → worst:

| Condition | Rank |
|---|---|
| Mint | 7 |
| Near Mint | 6 |
| Slightly Played | 5 |
| Moderately Played | 4 |
| Played | 3 |
| Heavily Played | 2 |
| Poor | 1 |

Helpers exported from `conditions.ts`:
- `conditionRank(c)` — rank lookup for a condition string.
- `meetsMinCondition(c, min)` — true when `conditionRank(c) >= conditionRank(min)`.

A higher rank is a better condition, so the min-condition filter keeps copies whose rank is
**at least** the minimum's rank.

## Algorithm
Per blueprint, each scan ([PRD §7](../../cardtrader-deal-scanner-PRD.md)):

```ts
// 1. Filter the cheapest-25 listings down to qualifying copies.
const filtered = products.filter(p =>
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
if (filtered.length < settings.min_cohort + 1) return null; // SKIP

// 4. Candidate is the cheapest; cohort is the NEXT cheapest (candidate excluded).
const candidate = filtered[0];
const cohort = filtered.slice(1, 1 + settings.cohort_size); // up to cohort_size copies
if (cohort.length < settings.min_cohort) return null;        // SKIP

// 5. Median baseline (integer cents) of the cohort.
const baseline_cents = median(cohort.map(p => p.price.cents));

// 6. Discount + verdict. Both compare against the baseline, not the candidate's own price.
const discount_pct = Math.round((1 - candidate.price.cents / baseline_cents) * 100);
const is_deal = candidate.price.cents <= (settings.threshold_pct / 100) * baseline_cents;
```

If `is_deal` is true the engine returns a `DealResult` (candidate listing + `baseline_cents`,
`cohort_size`, `discount_pct`); otherwise it may return the computed non-deal result or
`null` per the chosen contract. Either way the engine never writes, dedupes, or notifies.

## Key decisions
- **Median, not mean** — robust to a *second* underpriced copy. A lone anomaly in the cohort
  shifts a mean but not the median, so the baseline stays representative of the going rate.
- **Comparisons stay within the post-filter set** — a cheap `Poor` copy is never compared
  against `Near Mint` copies, because it was dropped before sorting. The candidate and its
  cohort all clear the same min-condition / foil / graded bar.
- **Thin-market skip** — fewer than `min_cohort + 1` qualifying listings means no reliable
  baseline, so the engine returns `null` rather than fire on noise
  ([PRD §13](../../cardtrader-deal-scanner-PRD.md)).
- **Candidate excluded from its own baseline** — the cohort is `filtered[1..]`; including
  `filtered[0]` would drag the baseline toward the very price we are testing.

## Public interface
Planned exports.

| Function | Signature | Notes |
|---|---|---|
| `evaluateBlueprint` | `(products: Product[], settings: EffectiveSettings) => DealResult \| null` | Top-level entry. Filters, sorts, computes baseline + verdict. Returns `null` on thin-market / no-deal skip. Pure. |
| `conditionRank` | `(c: Condition) => number` | Rank lookup from the ladder (`conditions.ts`). |
| `meetsMinCondition` | `(c: Condition, min: Condition) => boolean` | `conditionRank(c) >= conditionRank(min)` (`conditions.ts`). |
| `median` | `(nums: number[]) => number` | Median of integer cents. Even-length: average of the two middles (round to integer cents — never emit a float). |

Invariants callers must respect: pass **resolved** settings (no NULLs — inheritance applied
upstream); pass listings already fetched with `language=en`; treat every money value as
integer cents.

## Examples

### Fires — cheapest 0.16 vs median 0.32 ([PRD §16](../../cardtrader-deal-scanner-PRD.md) case 1)
All copies EN / Near Mint. Candidate `16` cents; next-10 median `32` cents.

```text
candidate.price.cents = 16
baseline_cents        = 32   // median of the cohort
discount_pct          = round((1 - 16/32) * 100) = 50
is_deal               = 16 <= (50/100) * 32 = 16   // 16 <= 16 → true
```

Result: a deal at `discount_pct ≈ 50%`, `is_deal = true` at threshold 50. (Money shown as
`0.16` / `0.32` only in prose; the engine sees `16` / `32`.)

### No fire — thin market ([PRD §16](../../cardtrader-deal-scanner-PRD.md) case 2)
Only 3 qualifying copies after filtering. With `min_cohort = 5`, the guard
`filtered.length < min_cohort + 1` → `3 < 6` is true, so the engine returns `null`. No
baseline is computed; no deal is produced.

The full acceptance-criteria fixture set (cases 1–10 — fires, thin, not-cheap-enough,
condition filter, foil filter, dedupe, and routing) lives in
[PRD §16](../../cardtrader-deal-scanner-PRD.md). Cases 1–5 are engine tests; dedupe and
routing (6–10) are exercised at the repo/notifier layers. Each §16 case becomes at least one
named test ([coding-standards, Testing](../standards/coding-standards.md)).

## Gotchas
- **Dedupe is NOT the engine's job.** The engine evaluates a single blueprint's listings and
  returns a result; "have we seen this listing?" is the repo's `UNIQUE(product_id)` upsert
  (`ON CONFLICT(product_id) DO NOTHING`, [PRD §7](../../cardtrader-deal-scanner-PRD.md) /
  §9). Re-running the engine on the same data twice is expected to return the same verdict —
  it is referentially transparent.
- **Off-by-one in cohort slicing.** The candidate is `filtered[0]` and must be **excluded**
  from its own baseline. The cohort is `filtered.slice(1, 1 + cohort_size)` — start at index
  1, not 0. Slicing from 0 would let the cheap candidate pull the median down toward itself.
- **Integer-cents rounding of `discount_pct`.** `discount_pct` is `Math.round(...)`, so a
  reported 50% can come from a candidate that is fractionally above or below exactly half the
  baseline. The authoritative gate is `is_deal` (`candidate.cents <= threshold_pct/100 *
  baseline`), not the rounded percentage — never branch on `discount_pct` for the verdict.
- **`median` of even-length cohorts** averages the two middle values; round the result to
  integer cents so no float leaks into `baseline_cents` or downstream `savings_cents`.
- **Empty / malformed conditions** — `conditionRank` should fail loud on an unknown condition
  string rather than silently rank it 0; the wire is parsed into typed shapes at the
  boundary, so the engine can assume valid `Condition` values
  ([coding-standards, TypeScript](../standards/coding-standards.md)).
