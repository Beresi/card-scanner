/**
 * ScanOverlay — mock scan animation rendered inside a custom overlay.
 *
 * Layout (.scan-overlay > .scan-box):
 *   Left:  .scan-radar  — concentric rings + crosshair + rotating sweep cone + ping dots
 *   Right: .scan-feed   — step log + progress bar
 *
 * Steps advance every ~360ms (~3.6s total for 10 steps).
 * On finish, calls onComplete() — App closes the overlay and pushes toasts.
 *
 * Effects gate:
 *   - Radar sweep rotation is pure CSS (.radar-sweep) — gated by effects.css body[data-fx].
 *   - Radar pings (JS-spawned dots) are only spawned when effects are ON + no reduced-motion.
 *   - When effects/reduced-motion disabled, the scan completes after a short fixed delay
 *     (720ms) and shows the final state — user is never trapped.
 *
 * Focus: overlay uses a custom portal with role="dialog" + focus trap + Esc.
 * We do NOT wrap in <Modal> here because .scan-overlay needs its own z-index (80, above
 * the palette's 70) and its own visual style (.scan-overlay/.scan-box). We implement
 * the a11y requirements directly.
 */
import {
  createPortal,
} from 'react-dom';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useEffects } from '../../effects/EffectsContext';

// ---------------------------------------------------------------------------
// Scan steps
// ---------------------------------------------------------------------------

const STEPS = [
  'open scan_runs row',
  'GET /info — validate token',
  'load active watchlist',
  'fetch marketplace/products (throttled)',
  'filter + sort listings',
  'compute median baseline',
  'threshold check + upsert deals',
  'telegram routing decision',
  'close scan_runs row',
  'scan complete',
] as const;

const STEP_INTERVAL_MS = 360;
// Fast-complete delay when effects are disabled
const FAST_COMPLETE_MS = 720;

// ---------------------------------------------------------------------------
// Ping dot shape
// ---------------------------------------------------------------------------

interface Ping {
  id: number;
  top: string;   // CSS percentage
  left: string;  // CSS percentage
}

let _pingSeq = 0;

function randomPing(): Ping {
  // Keep pings inside the inner 70% of the radar circle
  const angle = Math.random() * 2 * Math.PI;
  const radius = 15 + Math.random() * 35; // 15%–50% from center
  const top  = `${50 + Math.sin(angle) * radius}%`;
  const left = `${50 + Math.cos(angle) * radius}%`;
  return { id: ++_pingSeq, top, left };
}

// ---------------------------------------------------------------------------
// FOCUSABLE selector (same as Modal)
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// ---------------------------------------------------------------------------
// ScanOverlay
// ---------------------------------------------------------------------------

export interface ScanOverlayProps {
  open: boolean;
  onComplete: () => void;
}

export function ScanOverlay({ open, onComplete }: ScanOverlayProps) {
  const { enabled } = useEffects();
  const prefersReduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const shouldAnimate = enabled && !prefersReduced;

  const [stepDone, setStepDone] = useState(0);   // how many steps are checked
  const [pings, setPings]       = useState<Ping[]>([]);

  const panelRef    = useRef<HTMLDivElement>(null);
  const restoreRef  = useRef<Element | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Focus management
  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();
    else panel.focus();

    return () => {
      if (restoreRef.current instanceof HTMLElement) {
        restoreRef.current.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    if (restoreRef.current instanceof HTMLElement) {
      restoreRef.current.focus();
      restoreRef.current = null;
    }
  }, [open]);

  // Reset state when overlay opens
  useEffect(() => {
    if (!open) return;
    setStepDone(0);
    setPings([]);
  }, [open]);

  // Step timer
  useEffect(() => {
    if (!open) return;

    if (!shouldAnimate) {
      // Fast-complete: show final state after a short beat
      const t = setTimeout(() => {
        setStepDone(STEPS.length);
        setTimeout(() => onCompleteRef.current(), 200);
      }, FAST_COMPLETE_MS);
      return () => clearTimeout(t);
    }

    // Animated: advance one step per STEP_INTERVAL_MS
    let current = 0;
    const advance = () => {
      current += 1;
      setStepDone(current);
      if (current >= STEPS.length) {
        // Done — call onComplete after a short pause
        setTimeout(() => onCompleteRef.current(), 400);
      } else {
        id = window.setTimeout(advance, STEP_INTERVAL_MS);
      }
    };
    let id = window.setTimeout(advance, STEP_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [open, shouldAnimate]);

  // Ping spawner — spawns a new ping every ~500ms while scanning + effects on
  useEffect(() => {
    if (!open || !shouldAnimate || stepDone >= STEPS.length) return;

    const id = window.setInterval(() => {
      setPings((prev) => {
        const next = [...prev, randomPing()];
        // Keep at most 5 pings visible
        return next.length > 5 ? next.slice(next.length - 5) : next;
      });
    }, 500);

    return () => clearInterval(id);
  }, [open, shouldAnimate, stepDone]);

  // Focus trap + Esc
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Don't close mid-scan; Esc is a no-op for the scan overlay
      e.preventDefault();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  if (!open) return null;

  const progress = stepDone / STEPS.length;

  return createPortal(
    <div
      className="scan-overlay"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className="scan-box"
        role="dialog"
        aria-modal="true"
        aria-label="Scan in progress"
        tabIndex={-1}
      >
        {/* ---- Left: Radar ---- */}
        <div className="scan-radar" aria-hidden="true">
          <div className="radar-rings">
            <div className="radar-ring" />
            <div className="radar-ring" />
            <div className="radar-ring" />
          </div>

          {/* Crosshair */}
          <div className="radar-cross-h" />
          <div className="radar-cross-v" />

          {/* Rotating sweep cone (CSS-animated) */}
          <div className="radar-sweep" />

          {/* Ping dots */}
          {pings.map((ping) => (
            <div
              key={ping.id}
              className="radar-ping"
              style={{ top: ping.top, left: ping.left }}
            />
          ))}

          {/* Center readout: step count */}
          <div className="radar-center" aria-live="polite" aria-atomic="true">
            {stepDone}/{STEPS.length}
          </div>
        </div>

        {/* ---- Right: Step log ---- */}
        <div className="scan-feed">
          <div className="scan-feed-head cb-eyebrow">SCAN RUN</div>

          <div className="scan-lines" role="log" aria-label="Scan step log" aria-live="polite">
            {STEPS.map((step, i) => {
              const isDone = i < stepDone;
              const isCur  = i === stepDone - 1 && stepDone < STEPS.length;
              const lineClass = [
                'scan-line',
                isCur ? 'is-cur' : undefined,
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <div key={step} className={lineClass}>
                  <span className="scan-line-mark">
                    {isDone && !isCur ? '✓' : isCur ? '▸' : ' '}
                  </span>
                  <span>{step}</span>
                </div>
              );
            })}

            {/* Final "done" line */}
            {stepDone >= STEPS.length && (
              <div className="scan-line" style={{ marginTop: 8, color: 'var(--good)' }}>
                <span className="scan-line-mark" style={{ color: 'var(--good)' }}>✓</span>
                <span style={{ color: 'var(--good)' }}>done</span>
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div className="scan-progress" aria-hidden="true">
            <div
              className="scan-progress-fill"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
