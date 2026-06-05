/**
 * env-local.ts — Local environment loader for the deep-sweep CLI / sidecar.
 *
 * Secrets come from .dev.vars.local, .dev.vars, or CARD_BROKER_VARS_FILE (see below).
 * The Cloudflare account id and D1 database id are baked as DEFAULT_CF_ACCOUNT_ID /
 * DEFAULT_CF_D1_DATABASE_ID — they are non-secret constants that can be overridden if
 * needed but never need to be set manually.
 *
 * Resolution order for every key (first found wins, per key):
 *   1. process.env (highest priority — set by the Tauri host when spawning the sidecar)
 *   2. the file at process.env.CARD_BROKER_VARS_FILE (absolute path, if that env var is set)
 *   3. worker/.dev.vars.local (optional convenience file for terminal use)
 *   4. worker/.dev.vars (the existing wrangler-dev secrets file — CARDTRADER_API_TOKEN /
 *      TELEGRAM_* already there are reused without duplication)
 *
 * All four sources are optional; any combination may be absent. The packaged sidecar
 * (no repo on disk) works purely from environment variables injected by the Tauri host.
 *
 * Required keys (CARDTRADER_API_TOKEN and CF_API_TOKEN must come from one of the sources
 * above — missing either → fail fast; values are never printed):
 *   CARDTRADER_API_TOKEN   CardTrader API v2 bearer token
 *   CF_API_TOKEN           Cloudflare API token scoped to D1 Edit on this account/DB
 *
 * Non-secret ids (baked constants, overridable via any source):
 *   CF_ACCOUNT_ID          defaults to DEFAULT_CF_ACCOUNT_ID (wrangler.toml value)
 *   CF_D1_DATABASE_ID      defaults to DEFAULT_CF_D1_DATABASE_ID (wrangler.toml value)
 *
 * Optional keys (runScan guards these itself via isTelegramConfigured()):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   DESKTOP_AUTH_TOKEN     (not used by runScan; included for Env completeness)
 *
 * Security:
 *   - Values are NEVER logged, printed, or included in error messages.
 *   - .dev.vars* files must be gitignored (.dev.vars* is in .gitignore).
 *   - The CF_API_TOKEN is passed only to makeD1HttpAdapter(), which stores it
 *     internally; it never surfaces in summaries or console output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeD1HttpAdapter } from './d1-http';
import type { Env } from '../src/index';

// ---------------------------------------------------------------------------
// Baked non-secret constants (same values as in wrangler.toml [[d1_databases]])
// Overridable via any source in the resolution chain above.
// ---------------------------------------------------------------------------

const DEFAULT_CF_ACCOUNT_ID    = '541d9063453516ba295a2c1cbf298129';
const DEFAULT_CF_D1_DATABASE_ID = '32265ad6-4e1d-4ef8-8086-899962fcdb1f';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All keys loadEnv() resolves — Env fields plus the CF account/db ids for
 * logging context. CF_API_TOKEN is deliberately NOT a field: it is consumed by
 * makeD1HttpAdapter() during load and never lingers on the returned struct.
 */
export interface LocalEnv extends Env {
  CF_ACCOUNT_ID: string;
  CF_D1_DATABASE_ID: string;
}

// ---------------------------------------------------------------------------
// Dotenv-style parser
// ---------------------------------------------------------------------------

/**
 * Minimal dotenv parser: reads a file and returns a Map<key, value>.
 * Supports:
 *   KEY=value          bare value
 *   KEY="value"        double-quoted value (quotes stripped)
 *   KEY='value'        single-quoted value (quotes stripped)
 *   # comment lines    skipped
 *   blank lines        skipped
 *
 * Does NOT support multiline values or escape sequences — not needed here.
 */
function parseDotenv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { continue; }

    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) { continue; } // no key or no equals

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (matching pair only).
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key) {
      map.set(key, val);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// File reader — parses a dotenv file at the given path; returns empty Map on
// any error (file absent, permission denied, resolution failure).
// ---------------------------------------------------------------------------

function readVarsFile(filePath: string): Map<string, string> {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return parseDotenv(content);
    }
  } catch {
    // Silently continue — file not accessible is non-fatal.
  }
  return new Map<string, string>();
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load environment from up to four sources, in priority order (first found wins
 * per key). All sources are optional; missing files are silently skipped.
 *
 * Resolution order:
 *   1. process.env (host-injected — highest)
 *   2. file at process.env.CARD_BROKER_VARS_FILE (absolute path, if set)
 *   3. worker/.dev.vars.local (repo-relative convenience file)
 *   4. worker/.dev.vars (repo-relative wrangler-dev secrets file — reuses
 *      CARDTRADER_API_TOKEN / TELEGRAM_* already present there)
 *
 * CF_ACCOUNT_ID and CF_D1_DATABASE_ID default to the baked constants when absent
 * from all sources, so they never need to be set manually.
 *
 * Fails fast if any REQUIRED key (CARDTRADER_API_TOKEN, CF_API_TOKEN) is still
 * missing after all sources are merged — prints the list of missing keys (never
 * their values) and exits with code 1.
 */
export function loadEnv(): LocalEnv {
  // Attempt to resolve the worker directory for repo-relative file lookups.
  // Wrapped in try/catch: inside a packaged SEA/pkg binary import.meta.url may
  // not be resolvable — fall back to an empty path so the file sources are simply
  // skipped (the sidecar works from process.env only).
  let workerDir = '';
  try {
    const thisFile = fileURLToPath(import.meta.url);
    workerDir = path.resolve(path.dirname(thisFile), '..');
  } catch {
    // Packaged binary — repo-relative files are unavailable; use process.env only.
  }

  // --- Source 2: CARD_BROKER_VARS_FILE (absolute path from env) ---
  const customFilePath = process.env.CARD_BROKER_VARS_FILE ?? '';
  const customFileVars = customFilePath ? readVarsFile(customFilePath) : new Map<string, string>();

  // --- Source 3: worker/.dev.vars.local ---
  const localVarsPath = workerDir ? path.join(workerDir, '.dev.vars.local') : '';
  const localVars = localVarsPath ? readVarsFile(localVarsPath) : new Map<string, string>();

  // --- Source 4: worker/.dev.vars ---
  const devVarsPath = workerDir ? path.join(workerDir, '.dev.vars') : '';
  const devVars = devVarsPath ? readVarsFile(devVarsPath) : new Map<string, string>();

  /**
   * Resolve a key: process.env FIRST (host-injected values win), then
   * CARD_BROKER_VARS_FILE, then .dev.vars.local, then .dev.vars, then undefined.
   */
  function get(key: string): string | undefined {
    return (
      process.env[key] ??
      customFileVars.get(key) ??
      localVars.get(key) ??
      devVars.get(key)
    );
  }

  // ---------------------------------------------------------------------------
  // Validate required keys — fail fast, never print values
  // ---------------------------------------------------------------------------
  const REQUIRED_KEYS = [
    'CARDTRADER_API_TOKEN',
    'CF_API_TOKEN',
  ] as const;

  const missing = REQUIRED_KEYS.filter((k) => !get(k));
  if (missing.length > 0) {
    // Emit structured JSON to stdout so the Rust host can parse it, then also
    // write a human-readable message to stderr.
    const message = `Missing required environment variables: ${missing.join(', ')}`;
    process.stdout.write(JSON.stringify({ event: 'error', message }) + '\n');
    process.stderr.write(
      `[env-local] ${message}\n` +
      `Set them as environment variables, in worker/.dev.vars, or in worker/.dev.vars.local.\n`,
    );
    process.exit(1);
  }

  // Non-secret ids: use the resolved value if present, else fall back to the baked constant.
  const CF_ACCOUNT_ID     = get('CF_ACCOUNT_ID')    ?? DEFAULT_CF_ACCOUNT_ID;
  const CF_D1_DATABASE_ID = get('CF_D1_DATABASE_ID') ?? DEFAULT_CF_D1_DATABASE_ID;
  const CF_API_TOKEN      = get('CF_API_TOKEN')!;

  // Build the D1 REST adapter — the only place CF_API_TOKEN is consumed.
  const db = makeD1HttpAdapter(CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN);

  return {
    // D1 binding — backed by the REST adapter.
    DB: db,

    // CardTrader token — passed to the scanner client factory.
    CARDTRADER_API_TOKEN: get('CARDTRADER_API_TOKEN')!,

    // Telegram — optional; isTelegramConfigured() gates pushes when absent.
    TELEGRAM_BOT_TOKEN: get('TELEGRAM_BOT_TOKEN') ?? '',
    TELEGRAM_CHAT_ID:   get('TELEGRAM_CHAT_ID')   ?? '',

    // Desktop auth token — not used by runScan; included for Env completeness.
    DESKTOP_AUTH_TOKEN: get('DESKTOP_AUTH_TOKEN') ?? '',

    // CF context — account/db id only, surfaced so the CLI entry point can log
    // progress context. CF_API_TOKEN is intentionally NOT returned: it was
    // consumed by makeD1HttpAdapter() above and must not linger on this struct.
    CF_ACCOUNT_ID,
    CF_D1_DATABASE_ID,
  };
}
