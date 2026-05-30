/**
 * Clock — self-ticking next-scan countdown leaf.
 *
 * Emits:
 *   (no root cb- class — wraps a <span> with caller's className)
 *   clk-urgent           (added when ≤ 59 s remaining)
 *
 * CRITICAL — timer isolation:
 *   This component owns its own setInterval (1 s), confined entirely
 *   within a useEffect with cleanup. NO state is lifted to the parent.
 *   A tick here re-renders only this leaf, not the shell or any
 *   view — preserving entrance animations (README perf note).
 *
 * Countdown display: "T−MM:SS" (zero-padded, monospaced).
 * When target is in the past, the remaining seconds loop forward by
 * 3600 s steps (hourly wrap) so the display never shows negative.
 * At exactly 0 it shows T−00:00 briefly before wrapping.
 *
 * Reduced-motion: the .clk-urgent pulse is defined in effects.css
 * behind the prefers-reduced-motion guard — no JS motion here.
 *
 * Props:
 *   target — epoch ms of the next scheduled scan.
 */
import { useEffect, useState } from 'react';

export interface ClockProps {
  /** Epoch ms timestamp of the next scheduled scan. */
  target: number;
  className?: string;
}

function computeRemaining(target: number): number {
  let rem = Math.floor((target - Date.now()) / 1000);
  // Wrap negative values forward by hour-length increments.
  while (rem < 0) rem += 3600;
  return rem;
}

export function Clock({ target, className }: ClockProps) {
  const [remSec, setRemSec] = useState<number>(() => computeRemaining(target));

  useEffect(() => {
    // Sync immediately on target change.
    setRemSec(computeRemaining(target));
    const id = window.setInterval(() => {
      setRemSec(computeRemaining(target));
    }, 1000);
    return () => window.clearInterval(id);
  }, [target]);

  const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
  const ss = String(remSec % 60).padStart(2, '0');
  const urgent = remSec < 60;

  const rootClass = [urgent ? 'clk-urgent' : undefined, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={rootClass || undefined}
      aria-label={`Next scan in ${mm}:${ss}`}
      aria-live="off"
    >
      {`T−${mm}:${ss}`}
    </span>
  );
}
