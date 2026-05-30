/**
 * BootSequence — first-run CRT terminal intro.
 *
 * Renders full-screen (.boot), z-index 100 (above everything).
 * Phases: 'lines' → 'logo' → 'out' → calls onDone().
 *
 * The .boot-out class + effects.css cb-boot-off animation collapse
 * the screen with a CRT glitch, then onDone() is called after 620ms.
 *
 * Click/keypress anywhere skips to onDone() immediately (via the skip path).
 *
 * Effects gate:
 *   - effects ON + no reduced-motion: full animated sequence with cb-flicker-in
 *     on each line, logo fade, CRT glitch exit (~5s total).
 *   - effects OFF or reduced-motion: minimal instant boot — skips straight to
 *     onDone() after a brief 480ms beat (never traps the user).
 *
 * A11y: the .boot div is the focus target on mount (tabIndex=0). It announces
 * "Boot sequence" to screen readers. The skip hint is always present.
 */
import {
  useEffect,
  useRef,
  useState,
} from 'react';

import { useEffects } from '../../effects/EffectsContext';

// ---------------------------------------------------------------------------
// Boot lines (from the design handoff boot.jsx)
// ---------------------------------------------------------------------------

interface BootLine {
  text: string;
  cls?: string;   // extra className for this line
  delay?: number; // ms to wait before this line appears (cumulative)
}

const BOOT_LINES: BootLine[] = [
  { text: 'CARD//BROKER  v1.0.0  ·  deal-scanner kernel', cls: 'boot-head' },
  { text: '> establishing uplink · cloudflare edge ............. OK',      delay: 360 },
  { text: '> cardtrader api · GET /info ....................... 200',       delay: 300 },
  { text: '> auth token · bearer scope [read·write] ........... VALID',    delay: 300 },
  { text: '> mounting D1 · cardtrader_scanner ................. OK',        delay: 260 },
  { text: '> loading watchlist ............................ 8 ITEMS',       delay: 300 },
  { text: '> expansion cache ........................... 412 SETS',         delay: 220 },
  { text: '> blueprint cache ....................... 38,114 CARDS',         delay: 240 },
  { text: '> telegram bot · @cardbroker_bot · getMe ......... LINKED',      delay: 320 },
  { text: '> cron · 0 * * * * · next scan T-53:12 ............. ARMED',    delay: 300 },
  { text: '> scanner online.',                        cls: 'boot-ok',      delay: 420 },
];

type Phase = 'lines' | 'logo' | 'out';

// ---------------------------------------------------------------------------
// BootSequence
// ---------------------------------------------------------------------------

export interface BootSequenceProps {
  onDone: () => void;
}

export function BootSequence({ onDone }: BootSequenceProps) {
  const { enabled } = useEffects();
  const prefersReduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const shouldAnimate = enabled && !prefersReduced;

  const [shown, setShown]   = useState(0);
  const [phase, setPhase]   = useState<Phase>('lines');
  const skipRef             = useRef(false);
  const onDoneRef           = useRef(onDone);
  onDoneRef.current         = onDone;

  // If effects are off / reduced-motion, call onDone almost immediately
  useEffect(() => {
    if (shouldAnimate) return;
    const t = setTimeout(() => onDoneRef.current(), 480);
    return () => clearTimeout(t);
  }, [shouldAnimate]);

  // Animated sequence
  useEffect(() => {
    if (!shouldAnimate) return;

    let cancelled = false;

    async function run() {
      for (let i = 0; i < BOOT_LINES.length; i++) {
        if (cancelled || skipRef.current) break;
        const delay = BOOT_LINES[i].delay ?? 220;
        await wait(delay);
        if (cancelled || skipRef.current) break;
        setShown(i + 1);
      }
      if (cancelled || skipRef.current) return;

      await wait(320);
      if (cancelled) return;

      setPhase('logo');
      await wait(1150);
      if (cancelled) return;

      triggerExit();
    }

    run();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAnimate]);

  function triggerExit() {
    setPhase('out');
    setTimeout(() => onDoneRef.current(), 620);
  }

  function skip() {
    if (skipRef.current) return;
    skipRef.current = true;
    setShown(BOOT_LINES.length);
    setPhase('logo');
    // Brief pause on the logo before exiting
    setTimeout(triggerExit, 700);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      skip();
    }
  }

  // For non-animated mode, render nothing (onDone fires in effect above)
  if (!shouldAnimate) return null;

  const rootClass = ['boot', phase === 'out' ? 'boot-out' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClass}
      role="dialog"
      aria-modal="true"
      aria-label="Boot sequence"
      tabIndex={0}
      onClick={skip}
      onKeyDown={handleKeyDown}
    >
      {/* Moving scan band (pure CSS sweep) */}
      <div className="boot-scan" aria-hidden="true" />

      <div className="boot-inner">

        {/* ---- Terminal lines phase ---- */}
        {phase === 'lines' && (
          <div className="boot-term" aria-live="polite" aria-atomic="false">
            {BOOT_LINES.slice(0, shown).map((line, i) => (
              <div
                key={i}
                className={['boot-line', 'boot-line-in', line.cls].filter(Boolean).join(' ')}
              >
                {line.text}
              </div>
            ))}
            {shown < BOOT_LINES.length && (
              <span className="boot-cursor cb-cursor-blink" aria-hidden="true">
                ▊
              </span>
            )}
          </div>
        )}

        {/* ---- Logo phase ---- */}
        {(phase === 'logo' || phase === 'out') && (
          <div className="boot-logo" aria-label="Card Broker logo">
            <div className="boot-logo-mark" aria-hidden="true">◈</div>
            <div className="boot-logo-text">
              <span className="boot-logo-1">CARD</span>
              <span className="boot-logo-slash">//</span>
              <span className="boot-logo-2">BROKER</span>
            </div>
            <div className="boot-logo-sub">underpriced-copy hunter · online</div>
          </div>
        )}

      </div>

      {/* Skip hint */}
      {phase === 'lines' && (
        <div className="boot-skip" aria-hidden="true">
          click anywhere to skip
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny async helper
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
