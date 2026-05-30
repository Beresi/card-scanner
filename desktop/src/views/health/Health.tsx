/**
 * Health — scan observability view.
 *
 * Shows:
 *   1. Status banner: scanner state, last-run time, next-scan countdown Clock.
 *   2. Stat tiles: aggregated metrics from the last N scan runs.
 *   3. Scan-run log: per-run table, newest first, with click-to-expand error detail.
 *
 * Data layer: useHealth() + useScanRuns() (TanStack Query, real API).
 * Loading and error states are surfaced inline — never silent.
 * Clock is the sole ticking element; all other rendering is static.
 */

import { useState } from 'react';

import { Clock }  from '../../components/Clock';
import { Icon }   from '../../components/Icon';
import { Panel }  from '../../components/Panel';
import { Status } from '../../components/Status';
import { Tag }    from '../../components/Tag';
import { useHealth, useScanRuns } from '../../api/hooks';
import { ago } from '../../lib/format';
import type { ScanRun } from '../../api/types';

// ---------------------------------------------------------------------------
// Duration helper
// ---------------------------------------------------------------------------

/**
 * Compute and format the wall-clock duration of a scan run.
 * Parses bare SQLite UTC datetimes (appending 'Z') the same way ago() does,
 * so subtraction is correct regardless of local timezone.
 * Returns "—" when finished_at is null.
 */
function formatDuration(run: ScanRun): string {
  if (!run.finished_at) return '—';
  try {
    // Append 'Z' to bare 'YYYY-MM-DD HH:MM:SS' strings (SQLite UTC convention).
    const normalise = (s: string) =>
      /Z|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;

    const startMs = new Date(normalise(run.started_at)).getTime();
    const endMs   = new Date(normalise(run.finished_at)).getTime();

    if (isNaN(startMs) || isNaN(endMs)) return '—';

    const totalSec = Math.round(Math.abs(endMs - startMs) / 1_000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  } catch {
    return '—';
  }
}

/**
 * Compact time-of-day label from a SQLite UTC datetime.
 * Uses the user's local time so the table is readable.
 */
function compactTime(iso: string): string {
  try {
    const normalised = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
    const d = new Date(normalised);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Stat-tile aggregates
// ---------------------------------------------------------------------------

interface StatTiles {
  totalDeals:   number;
  totalTg:      number;
  errorCount:   number;
}

function computeStats(runs: ScanRun[]): StatTiles {
  let totalDeals = 0;
  let totalTg    = 0;
  let errorCount = 0;

  for (const r of runs) {
    totalDeals += r.deals_found;
    totalTg    += r.telegram_sent;
    if (r.error !== null) errorCount += 1;
  }

  return { totalDeals, totalTg, errorCount };
}

// ---------------------------------------------------------------------------
// Token status helper
// ---------------------------------------------------------------------------

/**
 * Derive a token status label from the most recent run's error text.
 * If the latest run errored with a token/401 message → "CHECK" (warn).
 * If runs list is empty → "—" (accent tile; no data yet).
 * Otherwise → "OK" (good).
 */
function tokenStatus(runs: ScanRun[]): { label: string; tileClass: string } {
  if (runs.length === 0) return { label: '—', tileClass: 'health-tile-accent' };
  const latestError = runs[0]?.error ?? null;
  if (latestError && /401|token|unauthori[sz]ed/i.test(latestError)) {
    return { label: 'CHECK', tileClass: 'health-tile-warn' };
  }
  return { label: 'OK', tileClass: 'health-tile-good' };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface LogRowProps {
  run:        ScanRun;
  expanded:   boolean;
  onToggle:   () => void;
}

function LogRow({ run, expanded, onToggle }: LogRowProps) {
  const hasError   = run.error !== null;
  const rowClass   = ['hlog-row', hasError ? 'hlog-err' : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {/* Main data row */}
      <div
        className={rowClass}
        role={hasError ? 'button' : undefined}
        tabIndex={hasError ? 0 : undefined}
        aria-expanded={hasError ? expanded : undefined}
        onClick={hasError ? onToggle : undefined}
        onKeyDown={
          hasError
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        style={hasError ? { cursor: 'pointer' } : undefined}
        title={hasError ? (expanded ? 'Collapse error detail' : 'Expand error detail') : undefined}
      >
        <span className="cb-text-faint">#{run.id}</span>

        <span>
          {compactTime(run.started_at)}{' '}
          <span className="cb-text-faint">({ago(run.started_at)})</span>
        </span>

        <span>{formatDuration(run)}</span>
        <span>{run.watch_items_scanned}</span>
        <span>{run.blueprints_scanned.toLocaleString()}</span>
        <span>{run.api_calls}</span>

        <span className={run.deals_found > 0 ? 'cb-accent' : 'cb-text-faint'}>
          {run.deals_found}
        </span>

        <span className={run.telegram_sent > 0 ? 'cb-accent' : 'cb-text-faint'}>
          {run.telegram_sent}
        </span>

        <span>
          {hasError
            ? <Tag tone="warn">WARN</Tag>
            : <Tag tone="good">OK</Tag>
          }
        </span>
      </div>

      {/* Error detail row — visible when this error row is expanded */}
      {hasError && expanded && (
        <div className="hlog-detail" role="region" aria-label={`Error detail for run #${run.id}`}>
          <Icon name="alert" size={14} className="cb-hot" />
          <span className="cb-mono">{run.error}</span>
          <span className="cb-text-faint cb-mono">(logged, non-fatal)</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function Health() {
  // Ephemeral UI: set of expanded error-row run ids.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data: health, isPending: healthPending, isError: healthError } = useHealth();
  const { data: rawRuns, isPending: runsPending, isError: runsError } = useScanRuns();

  // Show a loading state while either query is pending.
  if (healthPending || runsPending) {
    return (
      <div className="health">
        <Panel glow className="health-banner cb-bracket">
          <div className="health-banner-in">
            <div className="health-state">
              <Status tone="idle" />
              <div>
                <div className="health-state-big">CONNECTING…</div>
                <p className="cb-eyebrow">loading health data</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  // Surface API errors inline rather than silently empty.
  if (healthError || runsError) {
    return (
      <div className="health">
        <Panel glow className="health-banner cb-bracket">
          <div className="health-banner-in">
            <div className="health-state">
              <Status tone="hot" />
              <div>
                <div className="health-state-big">API ERROR</div>
                <p className="cb-eyebrow">could not reach the health endpoint</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  // Newest first — the API already returns newest-first but sort defensively.
  const sortedRuns = [...(rawRuns ?? [])].sort((a, b) => b.id - a.id);

  const { totalDeals, totalTg, errorCount } = computeStats(sortedRuns);
  const { label: tokenLabel, tileClass: tokenTileClass } = tokenStatus(sortedRuns);

  // Derive scanner state from health fields.
  const scannerOnline = health?.ok === true && health?.db_ok === true;
  const bannerLabel   = scannerOnline ? 'SCANNER ONLINE' : 'SCANNER DEGRADED';
  const bannerSub     = scannerOnline ? 'all systems nominal' : 'check API + DB status';

  // Next hourly cron tick: top of the next whole hour from now.
  const nextScanTarget = Math.ceil(Date.now() / 3_600_000) * 3_600_000;

  // Last-run timestamp: prefer the most recent run row; fall back to health.last_scan_at.
  const lastRunAt: string | null =
    sortedRuns[0]?.started_at ?? health?.last_scan_at ?? null;

  // DB tile: show db_ok status from health.
  const dbLabel = health?.db_ok === true ? '200 OK' : 'ERROR';
  const dbTone  = health?.db_ok === true ? 'health-tile-good' : 'health-tile-warn';

  function toggleExpanded(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="health">

      {/* ------------------------------------------------------------------ */}
      {/* 1. Status banner                                                    */}
      {/* ------------------------------------------------------------------ */}
      <Panel glow className="health-banner cb-bracket">
        <div className="health-banner-in">

          {/* Left: status dot + headline + sub line */}
          <div className="health-state">
            <Status tone={scannerOnline ? 'good' : 'warn'} />
            <div>
              <div className="health-state-big">{bannerLabel}</div>
              <p className="cb-eyebrow">
                {bannerSub}
                {lastRunAt !== null && (
                  <> &middot; last run {ago(lastRunAt)} ago</>
                )}
                {lastRunAt === null && (
                  <> &middot; no scans yet</>
                )}
              </p>
            </div>
          </div>

          {/* Right: next-scan countdown */}
          <div className="health-next">
            <span className="cb-eyebrow">next scan</span>
            <Clock target={nextScanTarget} className="health-next-clock" />
          </div>

        </div>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/* 2. Stat tiles                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div className="health-stats" role="list" aria-label="System statistics">

        {/* DB / Uplink — derived from health.db_ok */}
        <div className={`health-tile cb-chamfer-sm ${dbTone}`} role="listitem">
          <span className="health-tile-v cb-mono">{dbLabel}</span>
          <span className="cb-eyebrow">cardtrader /info</span>
        </div>

        {/* Token — derived from latest run error text */}
        <div
          className={`health-tile cb-chamfer-sm ${tokenTileClass}`}
          role="listitem"
        >
          <span className="health-tile-v cb-mono">{tokenLabel}</span>
          <span className="cb-eyebrow">bearer · r/w scope</span>
        </div>

        {/* Telegram — static; config has no token_ok field */}
        <div className="health-tile cb-chamfer-sm health-tile-accent" role="listitem">
          <span className="health-tile-v cb-mono">LINKED</span>
          <span className="cb-eyebrow">@cardbroker_bot</span>
        </div>

        {/* Deals found (last N runs) */}
        <div className="health-tile cb-chamfer-sm health-tile-good" role="listitem">
          <span className="health-tile-v cb-mono">{totalDeals}</span>
          <span className="cb-eyebrow">found · last {sortedRuns.length} runs</span>
        </div>

        {/* Telegram pushed (last N runs) */}
        <div className="health-tile cb-chamfer-sm health-tile-accent" role="listitem">
          <span className="health-tile-v cb-mono">{totalTg}</span>
          <span className="cb-eyebrow">pushed · last {sortedRuns.length} runs</span>
        </div>

        {/* Errors in window */}
        <div
          className={`health-tile cb-chamfer-sm ${errorCount > 0 ? 'health-tile-warn' : 'health-tile-good'}`}
          role="listitem"
        >
          <span className="health-tile-v cb-mono">{errorCount}</span>
          <span className="cb-eyebrow">errors · in window</span>
        </div>

      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 3. Scan-run log                                                     */}
      {/* ------------------------------------------------------------------ */}
      <Panel
        title="SCAN HISTORY"
        right={
          <span className="cb-eyebrow cb-text-faint">
            last {sortedRuns.length} runs
          </span>
        }
      >
        <div className="hlog" role="table" aria-label="Scan run history">

          {/* Header */}
          <div className="hlog-h" role="row">
            <span role="columnheader">RUN</span>
            <span role="columnheader">STARTED</span>
            <span role="columnheader">DUR</span>
            <span role="columnheader">ITEMS</span>
            <span role="columnheader">BLUEPRINTS</span>
            <span role="columnheader">API</span>
            <span role="columnheader">DEALS</span>
            <span role="columnheader">TG</span>
            <span role="columnheader">STATUS</span>
          </div>

          {/* Data rows */}
          {sortedRuns.length === 0 ? (
            <div className="hlog-row" role="row">
              <span
                role="cell"
                style={{ gridColumn: '1 / -1', textAlign: 'center' }}
                className="cb-text-faint cb-mono"
              >
                No scan runs recorded yet.
              </span>
            </div>
          ) : (
            sortedRuns.map((run) => (
              <LogRow
                key={run.id}
                run={run}
                expanded={expandedIds.has(run.id)}
                onToggle={() => toggleExpanded(run.id)}
              />
            ))
          )}

        </div>
      </Panel>

    </div>
  );
}
