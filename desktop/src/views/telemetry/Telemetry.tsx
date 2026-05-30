/**
 * Telemetry — right-rail content for the Feed, Settings, and Health views.
 *
 * Sections (top to bottom):
 *   SCAN     — MiniRadar + next-scan Clock + status indicator + "Scan now" button
 *   SESSION  — 4 stat tiles (open deals, unseen, potential savings, scans today)
 *   DISCOUNT SPREAD — horizontal bar chart over the 4 discount buckets
 *   ACTIVITY — last ~7 deals sorted by found_at desc
 *
 * Data is sourced from mock hooks (useMockTelemetry, useMockDeals). Wave 3 wiring
 * will swap these for real TanStack Query hooks without touching this component.
 *
 * The Clock leaf owns its own setInterval — this component never ticks itself.
 * MiniRadar's sweep animation is pure CSS — no JS motion here.
 *
 * Props:
 *   onScanNow   — optional callback wired up by the App (Wave 3)
 *   scanning    — whether a scan is currently in progress
 *   scanTarget  — epoch ms of the next scheduled scan (passed to Clock)
 */
import { useMemo } from 'react';

import { Btn } from '../../components/Btn';
import { Clock } from '../../components/Clock';
import { Icon } from '../../components/Icon';
import { Status } from '../../components/Status';
import { useMockDeals } from '../../mock/hooks';
import { useMockTelemetry } from '../../mock/hooks';
import { ago, pct, usd } from '../../lib/format';
import { MiniRadar } from './MiniRadar';

export interface TelemetryProps {
  onScanNow?: () => void;
  scanning?: boolean;
  scanTarget: number;
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
  className,
}: TelemetryProps) {
  const stats = useMockTelemetry();
  const { data: allDeals } = useMockDeals({ status: 'all' });

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
        <MiniRadar active={scanning} />
        <div className="tele-scan-info">
          <span className="cb-eyebrow">next scan</span>
          <Clock target={scanTarget} className="tele-clock" />
          <Status tone="good" label="HOURLY · ARMED" />
        </div>
      </div>

      <Btn
        variant="primary"
        disabled={scanning}
        onClick={onScanNow}
        aria-label={scanning ? 'Scan in progress' : 'Run a scan now'}
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
