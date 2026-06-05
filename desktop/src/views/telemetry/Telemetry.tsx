/**
 * Telemetry — right-rail content for the Feed, Settings, and Health views.
 *
 * Sections (top to bottom):
 *   SCAN     — MiniRadar + next-scan Clock + status indicator + "Scan now" button
 *   SESSION  — 4 stat tiles (open deals, unseen, potential savings, scans today)
 *   DISCOUNT SPREAD — horizontal bar chart over the 4 discount buckets
 *   ACTIVITY — last ~7 deals sorted by found_at desc
 *
 * Data layer: useDeals() + useScanRuns() (TanStack Query, real API).
 * Pure selectors from mock/selectors.ts compute all derived stats — they are
 * pure functions that work on real data just as well as mock data.
 *
 * Props (provided by App — do NOT change this signature):
 *   onScanNow   — optional callback wired up by the App
 *   scanning    — whether a scan is currently in progress
 *   scanTarget  — epoch ms of the next scheduled scan (passed to Clock)
 */
import { useMemo } from 'react';

import { Btn }      from '../../components/Btn';
import { Clock }    from '../../components/Clock';
import { Icon }     from '../../components/Icon';
import { PriceBar } from '../../components/PriceBar';
import { Status }   from '../../components/Status';
import { useConfig, useDeals, useHealth, useScanRuns } from '../../api/hooks';
import { ago, pct, usd } from '../../lib/format';
import {
  selectTelemetry,
} from '../../mock/selectors';
import { MiniRadar }          from './MiniRadar';
import { ScanProgressClock }  from './ScanProgressClock';

/** Staleness threshold: if a run has been open with zero blueprints scanned for
 *  longer than this we consider it dead/orphaned and stop showing the block. */
const STALL_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

export interface TelemetryProps {
  onScanNow?: () => void;
  scanning?: boolean;
  scanTarget: number;
  /** Whether local scan credentials are configured on this device. */
  scanConfigured?: boolean;
  /**
   * The run id returned by run_local_scan when the user triggered the scan.
   * Telemetry shows the SCANNING block ONLY for this specific run — never for
   * an unrelated cron row that happens to be open.
   * null = no user-initiated scan in flight → show idle content.
   */
  activeLocalRunId?: number | null;
  className?: string;
}

// ---------------------------------------------------------------------------
// Stat tile — a single labeled metric cell
// ---------------------------------------------------------------------------

interface StatTileProps {
  value: string | number;
  label: string;
  tone?: 'accent' | 'good' | 'hot';
}

function StatTile({ value, label, tone }: StatTileProps) {
  const tileClass = ['tstat', tone ? `tstat-${tone}` : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={tileClass}>
      <span className="tstat-v">{value}</span>
      <span className="cb-eyebrow">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export function Telemetry({
  onScanNow,
  scanning = false,
  scanTarget,
  scanConfigured = false,
  activeLocalRunId = null,
  className,
}: TelemetryProps) {
  // Fetch all deals (dismissed + open) for the histogram and activity log.
  // Empty arrays while loading so the selectors still produce valid output.
  const { data: allDeals = [] } = useDeals({ status: 'all' });
  // Pass activeLocalRunId so the hook polls fast only while the user's run is open.
  const { data: runs = [] }     = useScanRuns(activeLocalRunId);

  // Scan mode + progress from health; config for scan_mode fallback.
  const { data: health }  = useHealth();
  const { data: config }  = useConfig();

  // Resolve which mode is active: health.scan_mode is authoritative (live);
  // fall back to config.scan_mode while health is loading.
  const scanMode = health?.scan_mode ?? config?.scan_mode ?? 'chunked';
  const isChunked = scanMode === 'chunked';

  // Chunked progress values — guard scan_total===0 to avoid divide-by-zero in PriceBar.
  const scanDone  = health?.scan_done  ?? 0;
  const scanTotal = health?.scan_total ?? 0;
  // active_watch_count: optional field added to health — undefined means unknown.
  const activeWatchCount = health?.active_watch_count;

  // ---------------------------------------------------------------------------
  // Derive the active run: ONLY show the SCANNING block for the specific run the
  // user launched (activeLocalRunId), never for a random cron row.
  //
  // Rules:
  //   1. activeLocalRunId must be non-null (a local scan was triggered).
  //   2. Find that run in the runs list by id.
  //   3. The run must still be open (finished_at === null).
  //   4. Staleness guard: if blueprints_scanned === 0 and started_at is older
  //      than STALL_THRESHOLD_MS, treat the run as dead — hide the block.
  //      A progressing run (blueprints_scanned > 0) is kept visible regardless
  //      of elapsed time (a real sweep can run a long time).
  // ---------------------------------------------------------------------------
  const activeRun = useMemo(() => {
    if (activeLocalRunId === null) return null;
    const run = runs.find((r) => r.id === activeLocalRunId) ?? null;
    if (!run || run.finished_at !== null) return null;
    // Staleness guard: open + zero progress + running > 3 min → stalled
    if (run.blueprints_scanned === 0) {
      const normalised = /Z|[+-]\d{2}:\d{2}$/.test(run.started_at)
        ? run.started_at
        : `${run.started_at}Z`;
      const startedMs = new Date(normalised).getTime();
      if (Date.now() - startedMs > STALL_THRESHOLD_MS) return null;
    }
    return run;
  }, [activeLocalRunId, runs]);

  // Derive all telemetry stats via the pure selectors (reusable, no mock data).
  const stats = useMemo(
    () => selectTelemetry(allDeals, runs),
    [allDeals, runs],
  );

  // Activity log: last 7 deals sorted by found_at descending.
  const activityLog = useMemo(
    () =>
      allDeals
        .slice()
        .sort(
          (a, b) =>
            new Date(b.found_at).getTime() - new Date(a.found_at).getTime(),
        )
        .slice(0, 7),
    [allDeals],
  );

  // Histogram fill widths — clamp 0–100, guard max=0.
  const { bucket40, bucket50, bucket60, bucket70plus } = stats.histogram;
  const maxBucket = Math.max(bucket40, bucket50, bucket60, bucket70plus, 1);

  function fillPct(n: number): string {
    const raw = (n / maxBucket) * 100;
    const clamped = Math.min(100, Math.max(0, raw));
    return `${clamped}%`;
  }

  const rootClass = ['tele', className].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>

      {/* ------------------------------------------------------------------ */}
      {/* SCAN section                                                         */}
      {/* ------------------------------------------------------------------ */}

      <div className="cb-eyebrow tele-sec">scan</div>

      <div className="tele-scan cb-bracket">
        <MiniRadar active={scanning || activeRun !== null} />

        {activeRun !== null ? (
          /* ---------------------------------------------------------------- */
          /* LIVE PROGRESS BLOCK — shown only for the user-triggered run.     */
          /* activeRun.finished_at === null; useScanRuns polls every 2 s.     */
          /* ---------------------------------------------------------------- */
          <div className="tele-scan-info">
            <Status tone="hot" label="SCANNING" />

            {/* Primary progress: watch items scanned vs total.
                Clamp the displayed numerator to [0, total] so we never show
                "X / Y" where X > Y (backend fix in flight, but defend here). */}
            {(() => {
              const rawScanned = activeRun.watch_items_scanned;
              // Only clamp when we know the total; otherwise show raw.
              const displayScanned =
                activeWatchCount !== undefined && activeWatchCount > 0
                  ? Math.min(rawScanned, activeWatchCount)
                  : rawScanned;
              return (
                <span className="cb-eyebrow" style={{ marginTop: 'var(--pad-xs, 4px)' }}>
                  {displayScanned} / {activeWatchCount ?? '—'} items
                </span>
              );
            })()}

            {/*
              Progress bar — determinate when active_watch_count is known and > 0,
              indeterminate (striped/animated) otherwise.
              Fraction is clamped to [0, 1] so the bar never overflows 100%.
              Reduced-motion: the indeterminate pulse class is guarded in effects.css
              behind @media (prefers-reduced-motion: no-preference).
            */}
            {activeWatchCount !== undefined && activeWatchCount > 0 ? (
              <PriceBar
                value={Math.min(activeRun.watch_items_scanned, activeWatchCount)}
                max={activeWatchCount}
                tone="hot"
                title={`${Math.min(activeRun.watch_items_scanned, activeWatchCount)} of ${activeWatchCount} watch items scanned`}
              />
            ) : (
              /* Indeterminate: unknown total — striped bar at 100% width */
              <div
                className="cb-pbar"
                role="progressbar"
                aria-label="Scan in progress"
                aria-valuenow={undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="cb-pbar-fill cb-pbar-fill--indeterminate" />
              </div>
            )}

            {/* Detail line: blueprints · deals · elapsed */}
            <span className="cb-mono" style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: 'var(--pad-xs, 4px)' }}>
              {activeRun.blueprints_scanned.toLocaleString()} blueprints
              {' · '}
              {activeRun.deals_found} deals
              {' · '}
              {/* ScanProgressClock is a leaf — its 1s interval only re-renders this span */}
              <ScanProgressClock startedAt={activeRun.started_at} />
            </span>
          </div>
        ) : isChunked ? (
          /* ---- CHUNKED mode: progress readout ---- */
          <div className="tele-scan-info">
            <span className="cb-eyebrow">scanning this cycle</span>
            <span className="cb-mono tele-clock">
              {activeWatchCount === 0
                ? 'idle · nothing watched'
                : scanTotal === 0
                ? 'caching sets…'
                : `${scanDone} / ${scanTotal} cards`}
            </span>
            {scanTotal > 0 && (
              <PriceBar
                value={scanDone}
                max={scanTotal}
                tone="good"
                title={`${scanDone} of ${scanTotal} cards scanned this cycle`}
              />
            )}
            <Status tone="good" label="CHUNKED · ~40/2min" />
          </div>
        ) : (
          /* ---- WHOLE-SET mode: hourly countdown ---- */
          <div className="tele-scan-info">
            <span className="cb-eyebrow">next scan</span>
            <Clock target={scanTarget} className="tele-clock" />
            <Status tone="good" label="HOURLY · ARMED" />
          </div>
        )}
      </div>

      {/* Gate: disabled + explanatory tooltip when local scan is not configured. */}
      <Btn
        variant="primary"
        disabled={scanning || !scanConfigured}
        onClick={onScanNow}
        aria-label={
          scanning
            ? 'Scan in progress'
            : !scanConfigured
            ? 'Local scan is not configured — set it up in Settings → Local Scan'
            : 'Run a scan now'
        }
        title={
          !scanConfigured
            ? "Local scan isn't set up on this device — configure it in Settings → Local Scan."
            : undefined
        }
        style={{ width: '100%' }}
      >
        <Icon name="radar" size={15} />
        {scanning ? 'Scanning…' : 'Scan now'}
      </Btn>

      {/* ------------------------------------------------------------------ */}
      {/* SESSION stats                                                        */}
      {/* ------------------------------------------------------------------ */}

      <div className="cb-eyebrow tele-sec">session</div>

      <div className="tstat-grid">
        <StatTile
          value={stats.openDeals}
          label="open deals"
          tone="accent"
        />
        <StatTile
          value={stats.unseenDeals}
          label="unseen"
          tone="hot"
        />
        <StatTile
          value={usd(stats.potentialSavingsCents)}
          label="potential save"
          tone="good"
        />
        <StatTile
          value={stats.scansToday}
          label="scans today"
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* DISCOUNT SPREAD                                                      */}
      {/* ------------------------------------------------------------------ */}

      <div className="cb-eyebrow tele-sec">discount spread</div>

      <div className="tdist">
        {(
          [
            { key: '40–49%', n: bucket40 },
            { key: '50–59%', n: bucket50 },
            { key: '60–69%', n: bucket60 },
            { key: '70+%',   n: bucket70plus },
          ] as const
        ).map(({ key, n }) => (
          <div key={key} className="tdist-row">
            <span className="tdist-k">{key}</span>
            <span className="tdist-bar">
              <span
                className="tdist-fill"
                style={{ width: fillPct(n) }}
              />
            </span>
            <span className="tdist-n">{n}</span>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* ACTIVITY log                                                         */}
      {/* ------------------------------------------------------------------ */}

      <div className="cb-eyebrow tele-sec">activity</div>

      <div className="tlog" role="list" aria-label="Recent deal activity">
        {activityLog.map((deal) => (
          <div key={deal.id} className="tlog-row" role="listitem">
            {/* Priority dot */}
            <span
              className={
                deal.priority === 'high'
                  ? 'cb-dot cb-dot-hot'
                  : 'cb-dot cb-dot-live'
              }
              aria-label={deal.priority === 'high' ? 'High priority' : 'Normal priority'}
            />

            {/* Card name — truncated via CSS */}
            <span className="tlog-name" title={deal.card_name}>
              {deal.card_name}
            </span>

            {/* Discount percentage */}
            <span
              className="tlog-disc"
              style={{ color: 'var(--good)' }}
            >
              -{pct(deal.discount_pct)}
            </span>

            {/* Relative age */}
            <span className="tlog-age">{ago(deal.found_at)}</span>
          </div>
        ))}

        {activityLog.length === 0 && (
          <div className="tlog-row">
            <span
              style={{
                gridColumn: '1 / -1',
                color: 'var(--text-faint)',
                fontSize: '12px',
              }}
            >
              No recent activity.
            </span>
          </div>
        )}
      </div>

    </div>
  );
}
