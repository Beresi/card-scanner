# Test Command

Run the project test suite, analyze failures, and fix them if possible.

## Steps

1. **Backend / shared (Vitest):** run `npm test` (or `npx vitest run`) for the Worker project.
2. If all pass, report the summary and continue to Rust.
3. If tests fail:
   - Read the failing test and the source it covers.
   - Decide whether the bug is in the test or the source (prefer fixing source unless the
     expectation is wrong).
   - Re-run the single file: `npx vitest run {path}`, then the whole suite for regressions.
4. **Rust host (if `src-tauri/` exists):** run `cargo test` in `src-tauri/`.

## Focus — the deal engine & routing are the priority
The highest-value tests are the **pure** functions with exact acceptance criteria:
- Deal engine (PRD §7) and Telegram routing (PRD §8) — covered by the **10 §16 acceptance
  cases** (fires / thin-market / not-cheap-enough / condition filter / foil filter / dedupe /
  routing app-only / high-importance bypass / steep-global / health-401).
- These run against **small fixture** `marketplace/products` responses — **never the live
  CardTrader API**.

## Notes / rules
- Money assertions are **integer cents** — never floats.
- Don't skip the thin-market / dedupe / 401 cases; happy-path-only is insufficient.
- Pure functions need no network mocks; inject time/ids rather than reading them.
- See `.claude/skills/testing/SKILL.md` for the §16 case→test-name map.
