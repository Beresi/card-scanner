# Lint Command

Run linting + type-checking across both build targets, then fix what's found.

## Steps

1. Run in parallel (TypeScript side):
   - `npx eslint .` (or `npm run lint`)
   - `npx tsc --noEmit` (or `npm run type-check`)
2. Rust host (if `src-tauri/` exists), in parallel:
   - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
3. If all pass, report success and stop.
4. If issues found:
   - Auto-fixable ESLint: `npx eslint --fix {path}`; formatting: `npx prettier --write {path}`
     and `cargo fmt`.
   - TypeScript / clippy errors: read the file, understand the issue, fix the root cause.
   - Re-run the relevant check to verify.

## Key rules
- Never suppress with `// @ts-ignore`, `// eslint-disable`, or `#[allow(...)]` — fix the cause.
- No `any` — use `unknown` + narrowing at boundaries (untrusted CardTrader/API JSON).
- Remove unused imports; use `import type` for type-only imports.
- Rust commands return `Result`; no `unwrap()` on fallible I/O (clippy will flag many of these).
- Money stays integer cents; reject float-money types.
