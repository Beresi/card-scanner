/**
 * vars.ts — shared dotenv-style variable resolution for the Node-hosted entry
 * points (the local API server, the deep-sweep sidecar, the D1 migration tool).
 *
 * Resolution order for every key (first found wins, PER KEY):
 *   1. process.env                              (host-injected — highest)
 *   2. file at process.env.CARD_BROKER_VARS_FILE (absolute path, if set)
 *   3. worker/.dev.vars.local                   (local convenience file)
 *   4. worker/.dev.vars                         (wrangler-dev secrets file)
 *
 * All file sources are optional; any combination may be absent. A packaged
 * binary with no repo on disk works purely from process.env.
 *
 * SECURITY: values are never logged, printed, or included in error messages.
 * `.dev.vars*` is gitignored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal dotenv parser. Supports `KEY=value`, quoted values (matching pair
 * stripped), `#` comments and blank lines. No multiline values or escapes.
 */
export function parseDotenv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { continue; }

    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) { continue; }

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key) { map.set(key, val); }
  }
  return map;
}

/** Parse a dotenv file; returns an empty Map on any error (absent, unreadable). */
export function readVarsFile(filePath: string): Map<string, string> {
  try {
    if (fs.existsSync(filePath)) {
      return parseDotenv(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Non-fatal — an inaccessible file is simply skipped.
  }
  return new Map<string, string>();
}

/**
 * Resolve the worker/ directory for repo-relative lookups.
 *
 * Three call shapes have to work, which is why this is not a one-liner:
 *   • ESM source under tsx    — import.meta.url is a real file path
 *   • a bundled CJS entry     — import.meta.url is absent; __dirname is not
 *   • a packaged SEA binary   — neither resolves; there is no repo on disk, and
 *                               '' correctly means "use process.env only"
 *
 * Both the source layout (worker/scripts/x.ts) and the bundle layout
 * (worker/.build/x.cjs) sit one level below worker/, so the same `..` applies.
 *
 * CARD_BROKER_WORKER_DIR overrides everything, for any layout not anticipated
 * here.
 */
export function resolveWorkerDir(): string {
  const explicit = process.env.CARD_BROKER_WORKER_DIR;
  if (explicit) { return path.resolve(explicit); }

  // ESM: import.meta.url. Guarded because a CJS bundle has no import.meta and
  // esbuild leaves the reference to throw at runtime rather than removing it.
  try {
    const url = (import.meta as { url?: string } | undefined)?.url;
    if (url) { return path.resolve(path.dirname(fileURLToPath(url)), '..'); }
  } catch {
    // Not an ES module — fall through.
  }

  // CJS bundle: __dirname. Declared via globalThis so this compiles under the
  // ESM-targeted tsconfig, where __dirname is not in scope.
  try {
    const dir = (globalThis as { __dirname?: string }).__dirname
      ?? (typeof __dirname === 'string' ? __dirname : undefined);
    if (dir) { return path.resolve(dir, '..'); }
  } catch {
    // Neither available — fall through.
  }

  return '';
}

// __dirname exists only in a CJS bundle; declare it so the guarded reference
// above typechecks under the ESM tsconfig.
declare const __dirname: string | undefined;

/**
 * Build the per-key getter described in the file header. Sources are read once
 * up front; the returned function performs the priority walk per key.
 *
 * An EMPTY value does not count as "found" and falls through to the next source.
 * This matters: `.dev.vars.local` ships with blank `TELEGRAM_BOT_TOKEN=` /
 * `TELEGRAM_CHAT_ID=` placeholder lines, which under a plain `??` walk would
 * shadow the real values in `.dev.vars` and silently disable Telegram pushes.
 * "Present but blank" means unset, not "deliberately empty".
 */
export function makeVarGetter(): (key: string) => string | undefined {
  const workerDir = resolveWorkerDir();

  const customPath = process.env.CARD_BROKER_VARS_FILE ?? '';
  const customVars = customPath ? readVarsFile(customPath) : new Map<string, string>();
  const localVars = workerDir ? readVarsFile(path.join(workerDir, '.dev.vars.local')) : new Map<string, string>();
  const devVars = workerDir ? readVarsFile(path.join(workerDir, '.dev.vars')) : new Map<string, string>();

  /** Treat '' and undefined alike: not found, keep looking. */
  const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

  return (key: string): string | undefined =>
    nonEmpty(process.env[key]) ??
    nonEmpty(customVars.get(key)) ??
    nonEmpty(localVars.get(key)) ??
    nonEmpty(devVars.get(key));
}

/**
 * Fail fast when a required key is absent from every source.
 * Prints the missing KEY NAMES only — never a value — and exits 1.
 * Also emits a machine-readable JSON line so a spawning host can parse it.
 */
export function requireKeys(
  get: (key: string) => string | undefined,
  keys: readonly string[],
): void {
  const missing = keys.filter((k) => !get(k));
  if (missing.length === 0) { return; }

  const message = `Missing required environment variables: ${missing.join(', ')}`;
  process.stdout.write(JSON.stringify({ event: 'error', message }) + '\n');
  process.stderr.write(
    `[vars] ${message}\n` +
    `Set them as environment variables, in worker/.dev.vars, or in worker/.dev.vars.local.\n`,
  );
  process.exit(1);
}
