/**
 * db-bootstrap.ts — schema + migration management for the LOCAL SQLite database.
 *
 * Key fact this file relies on: `src/db/schema.sql` is kept at the CURRENT shape
 * (it already declares every column migrations 0001-0013 added). So a brand-new
 * database is created from schema.sql ALONE — the numbered migrations are
 * historical upgrade steps for an already-deployed DB and must never be replayed
 * on a fresh one. Two of them (0005, 0006) DROP and rebuild `watchlist`; replaying
 * those over live data would be destructive. verifySchema() below is the guard
 * that keeps the "schema.sql is current" assumption honest.
 *
 * Applied migrations are tracked in `_local_migrations` so that a migration added
 * AFTER go-live (0014+) is applied automatically on the next server boot, while
 * everything up to the go-live point is recorded as already-applied.
 *
 * Entry points:
 *   bootstrapLocalDb(raw)  — create-if-absent, then apply any pending migration.
 *                            Called on every server start; a no-op once current.
 *   verifySchema(raw)      — assert the live DB has every column the migrations
 *                            introduce. Used by the bootstrap self-test.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { resolveWorkerDir } from './vars';

/** Migrations that predate self-hosting. Recorded as applied on a fresh DB. */
const BASELINE_THROUGH = '0013';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function schemaPath(): string {
  return path.join(resolveWorkerDir(), 'src', 'db', 'schema.sql');
}

function migrationsDir(): string {
  return path.join(resolveWorkerDir(), 'src', 'db', 'migrations');
}

/** All migration filenames, lexically sorted (the numeric prefix makes this correct). */
function listMigrationFiles(): string[] {
  try {
    return fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Migration ledger
// ---------------------------------------------------------------------------

function ensureLedger(raw: Database.Database): void {
  raw.exec(
    'CREATE TABLE IF NOT EXISTS _local_migrations (' +
    '  name       TEXT PRIMARY KEY,' +
    "  applied_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ');',
  );
}

function appliedSet(raw: Database.Database): Set<string> {
  const rows = raw.prepare('SELECT name FROM _local_migrations').all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function recordApplied(raw: Database.Database, name: string): void {
  raw.prepare('INSERT OR IGNORE INTO _local_migrations (name) VALUES (?)').run(name);
}

/** True when the database has not been initialised yet (no `config` table). */
function isFresh(raw: Database.Database): boolean {
  const row = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='config'")
    .get();
  return row === undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BootstrapReport {
  /** True when the schema was created by this call. */
  created: boolean;
  /** Migrations executed by this call (empty in the steady state). */
  applied: string[];
  /** Migrations recorded as already-applied without running (baseline). */
  baselined: string[];
}

/**
 * Bring the database at `raw` up to the current schema.
 *
 * Fresh DB    → run schema.sql, baseline every migration through BASELINE_THROUGH.
 * Imported DB → (has tables, empty ledger) baseline the same way; a D1 export
 *               already carries the production shape.
 * Current DB  → run only migrations newer than the baseline that are not yet in
 *               the ledger, then record them.
 *
 * Idempotent: safe to call on every server start.
 */
export function bootstrapLocalDb(raw: Database.Database): BootstrapReport {
  const fresh = isFresh(raw);

  if (fresh) {
    raw.exec(fs.readFileSync(schemaPath(), 'utf-8'));
  }

  ensureLedger(raw);
  const already = appliedSet(raw);

  const applied: string[] = [];
  const baselined: string[] = [];

  for (const file of listMigrationFiles()) {
    if (already.has(file)) { continue; }

    // Everything at or below the baseline is already reflected in schema.sql
    // (fresh DB) or in the imported production data — record, do not execute.
    const prefix = file.slice(0, 4);
    if (prefix <= BASELINE_THROUGH) {
      recordApplied(raw, file);
      baselined.push(file);
      continue;
    }

    // A post-go-live migration: execute it inside a transaction, then record.
    const sql = fs.readFileSync(path.join(migrationsDir(), file), 'utf-8');
    raw.exec('BEGIN');
    try {
      raw.exec(sql);
      recordApplied(raw, file);
      raw.exec('COMMIT');
      applied.push(file);
    } catch (e) {
      raw.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { created: fresh, applied, baselined };
}

/**
 * Assert the live database declares every column the numbered migrations
 * introduce. This is the guard on the "schema.sql is current" assumption — if
 * someone adds a migration without folding it into schema.sql, a fresh local DB
 * would silently lack the column and this check fails loudly instead.
 *
 * Returns the list of missing "table.column" entries (empty = healthy).
 */
export function verifySchema(raw: Database.Database): string[] {
  // Columns each migration adds, as table → columns. Derived from the
  // ALTER TABLE ADD COLUMN / table-rebuild statements in src/db/migrations/.
  const expected: Record<string, string[]> = {
    config: [
      'theme_palette', 'font', 'currency', 'min_price_cents', 'min_savings_cents',
      'scan_mode', 'scan_batch_size', 'scan_cycle_started_at', 'default_detection_mode',
      'default_max_price_cents', 'catalog_sync_enabled', 'catalog_max_exports_per_run',
      'default_discount_pct', 'default_min_gap_pct', 'scan_interval_minutes',
      'deal_staleness_hours', 'last_maintenance_at', 'deal_retention_days',
    ],
    watchlist: [
      'type', 'cardtrader_id', 'min_discount_pct', 'min_gap_pct', 'detection_mode',
      'max_price_cents', 'card_name_norm', 'expansion_filter',
    ],
    deals: [
      'second_cheapest_cents', 'gap_pct', 'status', 'retired_at', 'avg4_cents',
      'revalidated_at',
    ],
    blueprints: ['last_scanned_at', 'name_norm'],
    expansions: ['blueprints_synced_at'],
    purchases: ['bought_at'],
  };

  const missing: string[] = [];
  for (const [table, columns] of Object.entries(expected)) {
    const info = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (info.length === 0) {
      missing.push(`${table} (table missing)`);
      continue;
    }
    const present = new Set(info.map((c) => c.name));
    for (const col of columns) {
      if (!present.has(col)) { missing.push(`${table}.${col}`); }
    }
  }
  return missing;
}
