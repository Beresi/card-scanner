/**
 * resync-catalog.ts — local FULL-HEAL catalog refresh (terminal CLI).
 *
 * The hourly cron only periodically re-checks the newest sets (where sparse-
 * snapshot freezing actually happens — see selectNextCatalogExpansions). This
 * script is the deliberate, run-it-yourself counterpart that re-pulls the WHOLE
 * back-catalogue (or any subset) at once, bypassing that window. Run it from the
 * local machine when you want to heal everything now rather than wait for the
 * cron to rotate through new releases.
 *
 * The desktop app's Settings → Maintenance → "Resync catalog" button runs the
 * same core (resyncCatalog) via the scan-local sidecar — this is the equivalent
 * terminal entry point.
 *
 * It reuses the deep-sweep sidecar's env loader, so it needs the same creds:
 *   CARDTRADER_API_TOKEN  (CardTrader v2 bearer)
 *   CF_API_TOKEN          (Cloudflare API token, D1 Edit on this account/DB)
 * sourced from process.env / worker/.dev.vars.local / worker/.dev.vars.
 *
 * Usage (terminal, from worker/):
 *   npm run catalog:resync                  # re-pull EVERY MTG set (newest id first)
 *   npm run catalog:resync -- 4415 4310     # re-pull only these expansion ids
 *   npm run catalog:resync -- --empty       # re-pull only sets with 0 cached blueprints
 *
 * Read-from-CardTrader + write-to-catalog only. NO cart/checkout/purchase path.
 * Token values are never printed.
 */

import { loadEnv } from './env-local';
import { resyncCatalog } from './catalogResync';

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

async function main(): Promise<void> {
  const env = loadEnv();

  const rawArgs = process.argv.slice(2);
  const emptyOnly = rawArgs.includes('--empty');
  const ids = rawArgs.filter((a) => /^\d+$/.test(a)).map((a) => parseInt(a, 10));

  log('\n=== Card // Broker — catalog re-sync (full heal) ===');
  log(`Target DB:   production D1 (${env.CF_D1_DATABASE_ID})`);

  const summary = await resyncCatalog(
    env,
    { ids, emptyOnly },
    {
      onStart: (total) => {
        const scope = emptyOnly ? ' (empty-only)' : ids.length ? ' (explicit ids)' : ' (all MTG)';
        log(`Sets to pull: ${total}${scope}\n`);
      },
      onSet: ({ index, total, id, name, count, delta, error }) => {
        const prefix = `[${index + 1}/${total}] #${id} ${name}`;
        if (error) {
          log(`${prefix} → FAILED: ${error}`);
        } else {
          const deltaStr = delta && delta > 0 ? ` (+${delta})` : delta && delta < 0 ? ` (${delta})` : '';
          log(`${prefix} → ${count} blueprints${deltaStr}`);
        }
      },
    },
  );

  log('');
  log('=== Re-sync complete ===');
  log(`  Synced OK:        ${summary.ok}`);
  log(`  Grew (new cards): ${summary.grew}`);
  log(`  Failed:           ${summary.failed}`);
  if (summary.failures.length > 0) {
    log('  Failed sets:');
    for (const f of summary.failures) { log(`    #${f.id} ${f.name} — ${f.error}`); }
  }
  log('');

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  const safe = (err instanceof Error ? err.message : String(err))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ct_live_\S+/gi, '[REDACTED]');
  log(`[catalog:resync] fatal: ${safe}`);
  process.exit(1);
});
