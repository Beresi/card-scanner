---
name: testing
description: How to test the CardTrader Deal Scanner — fixture-driven Vitest unit tests for the pure deal engine (§7) and Telegram routing (§8), the exact PRD §16 acceptance cases, lighter React Testing Library tests for inherit/override + feed filters, and `cargo test` for Rust host logic. Load before writing or changing any test, or when implementing the engine/routing against §16.
---

# Testing

## Purpose
The deal engine (`src/scan/dealEngine.ts`, [§7](../../../cardtrader-deal-scanner-PRD.md)) and
Telegram routing (`src/telegram/routing.ts`, [§8](../../../cardtrader-deal-scanner-PRD.md)) are
**pure functions** — no `fetch`, no DB, no clock. They are the highest-value test targets and
need **no mocks**: feed them fixture `marketplace/products` responses + resolved settings and
assert the return value. [PRD §16](../../../cardtrader-deal-scanner-PRD.md) is the spec — it
lists 10 exact acceptance cases; each becomes at least one named test. The UI gets lighter
React Testing Library tests for the inherit/override field and the feed filters. Rust host logic
(if any) uses `cargo test`. **No live-API tests, ever** — no real `marketplace/products`, no real
Telegram send. Fixtures only.

Stack: **Vitest** (Vite/TS), **React Testing Library** for components, **`cargo test`** for the
Rust host. Co-locate tests as `*.test.ts(x)` beside the unit; keep fixtures small and named per
the §16 case they cover. Run `npm test` (and `cargo test` if the host changed).

## §16 case → test map
Every acceptance case maps to a named test. Cases 1–5 are engine tests; 6–9 routing; 10 scanner.

| §16 | Case | Unit | Test name |
|---|---|---|---|
| 1 | Fires: cheapest 16¢, median 32¢, EN/NM, threshold 50 | `evaluateBlueprint` | `fires when cheapest is 50% under cohort median` |
| 2 | No fire (thin): only 3 qualifying copies | `evaluateBlueprint` | `returns null on thin market (fewer than min_cohort+1)` |
| 3 | No fire (not cheap enough): 30¢ vs median 34¢ | `evaluateBlueprint` | `returns null when candidate is above threshold` |
| 4 | Condition filter: Poor @5¢ excluded under NM min | `evaluateBlueprint` | `drops below-min-condition copies before picking candidate` |
| 5 | Foil filter: `nonfoil` ignores foil listings | `evaluateBlueprint` | `excludes foil listings when foil_pref is nonfoil` |
| 6 | Dedupe: same product_id over 2 scans → 1 row, 1 push | repo upsert + routing | `dedupes a product_id across consecutive scans` |
| 7 | Routing app-only: enabled=false, normal, 52% | `shouldNotify` | `does not send when telegram disabled and not high` |
| 8 | Routing high bypass: high item, 51% (< global 60%) | `shouldNotify` | `high importance sends even below the global discount gate` |
| 9 | Routing steep global: enabled, 65% sends / 52% app-only | `shouldNotify` | `sends at/above the discount gate, app-only below it` |
| 10 | Health: forced API 401 → scan_runs.error, clean abort | scanner | `aborts the run and records error on 401` |

## Core patterns

### Fixture-driven deal-engine test (§16 case #1)
A tiny named fixture in, a verdict out. No mocks — the engine is pure. All money is integer
cents; assert exact integers, never floats. Effective settings are already resolved upstream
(`resolveEffective`), so the test passes plain values.

```ts
import { describe, it, expect } from 'vitest';
import { evaluateBlueprint } from '@/scan/dealEngine';
import type { Product, EffectiveSettings } from '@/scan/types';

// Small, named listing factory keeps the cohort readable. Money is integer cents.
const nmEn = (cents: number, over: Partial<Product> = {}): Product => ({
  id: cents,                 // product_id; unique enough for these fixtures
  blueprint_id: 10050,
  price: { cents, currency: 'USD' },
  quantity: 1,
  graded: false,
  on_vacation: false,
  properties_hash: { condition: 'Near Mint', mtg_language: 'en', mtg_foil: false },
  ...over,
});

const DEFAULTS: EffectiveSettings = {
  min_condition: 'Near Mint',
  foil_pref: 'any',
  allow_graded: false,
  threshold_pct: 50,
  cohort_size: 10,
  min_cohort: 5,
};

describe('evaluateBlueprint — §16 case 1', () => {
  it('fires when cheapest is 50% under cohort median', () => {
    // candidate 16¢; next-10 all 32¢ → median 32¢.
    const products = [nmEn(16), ...Array.from({ length: 10 }, (_, i) => nmEn(32, { id: 100 + i }))];

    const result = evaluateBlueprint(products, DEFAULTS);

    expect(result).not.toBeNull();
    expect(result!.candidate.price.cents).toBe(16); // exact integer cents
    expect(result!.baseline_cents).toBe(32);
    expect(result!.discount_pct).toBe(50);
    expect(result!.is_deal).toBe(true);             // 16 <= (50/100)*32 = 16
  });
});
```

### Routing test — high-importance bypass (§16 case #8)
`shouldNotify` is pure: deal + ticket + config → `{ send, priority }`. A `high` item bypasses
the discount gate, so 51% off still sends even though the global Telegram gate is 60%.

```ts
import { describe, it, expect } from 'vitest';
import { shouldNotify } from '@/telegram/routing';

const config = { telegram_min_discount_pct: 60 }; // global gate, stricter than the 50% app threshold
const deal = {
  product_id: 1, discount_pct: 51,
  candidate: { price: { cents: 4900, currency: 'USD' } },
  baseline_cents: 10000, telegram_sent: false,
};

describe('shouldNotify — §16 case 8', () => {
  it('high importance sends even below the global discount gate', () => {
    const ticket = { importance: 'high', telegram_enabled: false,
                     telegram_min_discount_pct: null, telegram_max_price_cents: null,
                     telegram_min_savings_cents: null };

    const { send, priority } = shouldNotify(deal, ticket, config);

    expect(send).toBe(true);       // criterion 2 bypassed by high importance
    expect(priority).toBe('high'); // priority follows importance, not the gate
  });

  it('does not send a normal disabled item below the gate', () => { // §16 case 7
    const ticket = { importance: 'normal', telegram_enabled: false,
                     telegram_min_discount_pct: null, telegram_max_price_cents: null,
                     telegram_min_savings_cents: null };
    expect(shouldNotify(deal, ticket, config).send).toBe(false);
  });
});
```

### Component test — inherit/override field (lighter, RTL)
The override field shows the inherited global default as a placeholder and only emits a value when
the owner actually overrides; clearing it falls back to NULL (inherit). Test the behaviour, not the
styling. The feed filters get a sibling test: assert the rendered list actually shrinks to the
matching deals (coding-standards: "filters must actually filter").

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { OverrideField } from '@/components/OverrideField';

describe('OverrideField', () => {
  it('shows the inherited default and emits null when cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OverrideField label="Telegram min discount %" inherited={60} value={null} onChange={onChange} />);

    expect(screen.getByPlaceholderText(/inherited.*60/i)).toBeInTheDocument();

    await user.type(screen.getByRole('spinbutton'), '70');
    expect(onChange).toHaveBeenLastCalledWith(70);

    await user.clear(screen.getByRole('spinbutton'));
    expect(onChange).toHaveBeenLastCalledWith(null); // null ⇒ inherit
  });
});
```

## Standards
@docs/standards/coding-standards.md

## Examples (Good / Bad)

### Good
- Build a **named fixture per §16 case** (`fires_50pct`, `thin_market_3copies`,
  `nonfoil_ignores_foil`) and assert the exact `DealResult` / `{ send, priority }`.
- Call the pure function directly with no network and no mocks; vary one dimension per test
  (condition, foil, cohort size) so a failure pinpoints one branch.
- Assert money as **exact integer cents** (`toBe(32)`), and assert both the `is_deal` gate and
  the `discount_pct` separately.

### Bad
```ts
// BAD: hits the live CardTrader API — flaky, rate-limited, non-deterministic, leaks the token.
const products = await ctClient.marketplaceProducts(blueprintId);
expect(evaluateBlueprint(products, DEFAULTS)).toBeTruthy();
```
```ts
// BAD: asserts a float — money is integer cents; this will drift and lie.
expect(result.baseline_cents).toBeCloseTo(0.32);
```
```ts
// BAD: only the happy path. No thin-market, condition, foil, dedupe, or 401 case —
// so every guard in §7/§8 is untested. §16 case 1 alone is not coverage.
```

## Gotchas
- **Test the guards, not just the fires.** §16 cases 2–5 (thin market, condition filter, foil
  filter, not-cheap-enough) and 7/10 (app-only, 401) are *non*-fire / abort paths. Aim for full
  branch coverage on the engine and routing — most regressions hide in the skips.
- **Money is integer cents.** Assert exact integers (`toBe(16)`); never `toBeCloseTo`, never
  floats. `discount_pct` is `Math.round(...)`, so branch on `is_deal` for the verdict, not on the
  rounded percentage. Watch even-length `median` → average the two middles and round to an integer.
- **Pure functions need no mocks.** `evaluateBlueprint` and `shouldNotify` take no I/O — don't mock
  `fetch` or the DB to test them. If you reach for a mock, you're testing the wrong layer (dedupe is
  the repo's `UNIQUE(product_id)`; routing only checks `telegram_sent`).
- **Dedupe (§16 case 6) is not the engine's job.** Re-running `evaluateBlueprint` on the same data
  returns the same verdict — correct (referential transparency). The "one row, one push" guarantee
  is the repo upsert (`ON CONFLICT(product_id) DO NOTHING`) + the `telegram_sent` flag; test it there.
- **Inject the clock.** Quiet-hours routing takes the current hour as a parameter — never reads
  `Date.now()`. Pass it in so every §16 routing case is deterministic.
- **Two different discount gates.** The 50% app threshold (§7) decides what becomes a deal; the 60%
  Telegram gate (§8) decides what pushes. §16 case 9: 65% sends, the same item at 52% is app-only.
  Don't conflate them in assertions.
- **High importance bypasses only the discount gate** (criterion 2), not reachability/dedupe/caps.
  A `high` deal still needs Telegram wired and still respects `telegram_sent` and the optional
  price/savings caps.
- **401 (§16 case 10) aborts and alerts once** — assert `scan_runs.error` is set and the run closes
  cleanly, not that it throws to the top. No retry-spam on repeats.
- **Keep fixtures small and named per §16 case.** A 25-item blob obscures intent; 1 candidate + just
  enough cohort to clear `min_cohort` is clearer and the failure is obvious.
- **Rust host:** `cargo test` for command logic; commands return `Result<T, String>` — assert `Err`
  on fallible paths rather than relying on `unwrap()`. Keep the host thin; the scan logic is tested
  in TS, not re-tested in Rust.

## Related skills
- deal-engine — the unit under test (§7 algorithm, condition ladder, median baseline)
- telegram-notifications — routing tests (§8 should-notify decision, the four criteria)
