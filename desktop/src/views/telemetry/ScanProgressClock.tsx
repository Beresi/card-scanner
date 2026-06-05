/**
 * ScanProgressClock — self-ticking elapsed-time leaf for a running scan.
 *
 * CRITICAL — timer isolation (same rule as Clock.tsx):
 *   This component owns its own setInterval (1 s) entirely within a useEffect.
 *   No state is lifted to Telemetry, so only this leaf re-renders on every tick.
 *   A tick here does NOT re-render the shell, the rail, or any animation — see
 *   README / CLAUDE.md perf note.
 *
 * Props:
 *   startedAt — SQLite UTC datetime string ('YYYY-MM-DD HH:MM:SS').
 *               Appends 'Z' before parsing (matching the project-wide convention
 *               in format.ts ago() and other UTC parse sites).
 *   className — optional extra classes passed through to the <span>.
 *
 * Output format: "Xh Ym Zs" / "Ym Zs" / "Zs" — always at least "Xs".
 * Accessibility: aria-live="off" (the parent already has a live-region label).
 */
import { useEffect, useState } from 'react';

export interface ScanProgressClockProps {
  startedAt: string;
  className?: string;
}

/** Parse a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') to a JS Date.
 *  Appends 'Z' if no timezone indicator is present — matching the convention
 *  used throughout the project (see format.ts ago(), health view timestamps). */
function parseUtcDatetime(iso: string): Date {
  const normalised = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  return new Date(normalised);
}

function formatElapsed(elapsedSec: number): string {
  const s = elapsedSec % 60;
  const totalMin = Math.floor(elapsedSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeElapsed(startEpoch: number): number {
  return Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
}

export function ScanProgressClock({ startedAt, className }: ScanProgressClockProps) {
  const startEpoch = parseUtcDatetime(startedAt).getTime();

  const [elapsedSec, setElapsedSec] = useState<number>(() => computeElapsed(startEpoch));

  useEffect(() => {
    setElapsedSec(computeElapsed(startEpoch));
    const id = window.setInterval(() => {
      setElapsedSec(computeElapsed(startEpoch));
    }, 1000);
    return () => window.clearInterval(id);
  }, [startEpoch]);

  return (
    <span
      className={className}
      aria-live="off"
    >
      {formatElapsed(elapsedSec)}
    </span>
  );
}
