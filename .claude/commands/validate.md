# Validate Command

Run the full verification pipeline across both targets before a commit/PR/deploy.

## Steps

1. Run sequentially (each must pass before the next):
   - `npx tsc --noEmit` — TypeScript validation (Worker + frontend)
   - `npx eslint .` — lint (and `cargo clippy` if `src-tauri/` exists)
   - `npm test` — Vitest suite (+ `cargo test` if `src-tauri/` exists)
   - `npm run build` — Vite frontend build (and `npm run tauri build` only when explicitly
     producing a desktop bundle — it's slow/per-OS; skip for routine validation)
2. If any step fails: report the failing step + errors, fix, re-run from that step onward.
3. Report final status: typecheck + lint + tests green = ready for PR; backend deploy is a
   separate step (see `/deploy`).

## When to use
After completing any feature work, before a commit or PR. For a quick inner-loop check, run
`/lint` + `/test`; use `/validate` for the full gate.

## Notes
- The §16 deal-engine/routing tests are the core correctness gate — they must pass.
- Backend (`wrangler deploy`) and desktop (`tauri build`) ship independently; validating does
  not deploy.
