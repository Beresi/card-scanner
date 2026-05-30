/**
 * ScrambleText — decrypt-reveal animation.
 *
 * When active AND effects are enabled AND prefers-reduced-motion is
 * no-preference: animates text char-by-char over 16 frames (32ms each)
 * with random glyph noise, after `delay` ms. Resolves to the final
 * text and stops — fires once, no loop.
 *
 * When any guard fails (effects off, reduced-motion, or active=false):
 * renders `text` plainly and immediately.
 *
 * Props:
 *   text     — the final resolved string to display
 *   active   — trigger the reveal (default false)
 *   delay    — ms to wait before starting (default 0)
 *   className — forwarded to the <span> root
 */
import { useEffect, useRef, useState } from 'react';

import { useEffects } from './EffectsContext';

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&/<>*+=';
const TOTAL_FRAMES = 16;
const FRAME_INTERVAL_MS = 32;

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

function scramble(text: string, frame: number): string {
  const revealed = Math.floor((frame / TOTAL_FRAMES) * text.length);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (i < revealed || text[i] === ' ') {
      out += text[i];
    } else {
      out += randomGlyph();
    }
  }
  return out;
}

export interface ScrambleTextProps {
  text: string;
  active?: boolean;
  delay?: number;
  className?: string;
}

export function ScrambleText({
  text,
  active = false,
  delay = 0,
  className,
}: ScrambleTextProps) {
  const { enabled } = useEffects();

  // Check prefers-reduced-motion once at mount (stable per session — no need to
  // reactively re-check; if it changes mid-session we accept a stale value).
  const prefersReduced = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  // Whether to animate: all three guards must pass.
  const shouldAnimate = active && enabled && !prefersReduced.current;

  const [display, setDisplay] = useState<string>(text);

  useEffect(() => {
    // If we won't animate, immediately resolve to the final text.
    if (!shouldAnimate) {
      setDisplay(text);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let frame = 0;

    timeoutId = setTimeout(() => {
      intervalId = setInterval(() => {
        frame += 1;
        if (frame >= TOTAL_FRAMES) {
          clearInterval(intervalId);
          setDisplay(text);
        } else {
          setDisplay(scramble(text, frame));
        }
      }, FRAME_INTERVAL_MS);
    }, delay);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== undefined) clearInterval(intervalId);
      // On cleanup, snap to final text so the element is always readable.
      setDisplay(text);
    };
  }, [shouldAnimate, text, delay]);

  return <span className={className}>{display}</span>;
}
