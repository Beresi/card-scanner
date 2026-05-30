/**
 * BrandGlyph — the Card Broker icon rendered in the accent color.
 *
 * The source (public/app-icon.png) is white line-art on transparent; we use it
 * as a CSS mask and fill the shape with var(--accent), so the brand mark follows
 * the live accent (like the old ◈ glyph did) and can carry an accent glow.
 *
 * Replaces the ◈ text glyph in the rail brand and the boot logo.
 */

import type { CSSProperties } from 'react';

export interface BrandGlyphProps {
  /** Rendered width/height in px (square). */
  size: number;
  /** Glow blur radius in px (scaled by --glow). 0 = no glow. */
  glow?: number;
  className?: string;
}

export function BrandGlyph({ size, glow = 0, className }: BrandGlyphProps) {
  const style: CSSProperties = {
    display: 'inline-block',
    flex: 'none',
    width: size,
    height: size,
    backgroundColor: 'var(--accent)',
    WebkitMaskImage: "url('/app-icon.png')",
    maskImage: "url('/app-icon.png')",
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    ...(glow
      ? { filter: `drop-shadow(0 0 calc(${glow}px * var(--glow)) var(--accent-glow))` }
      : {}),
  };

  return <span className={className} aria-hidden="true" style={style} />;
}
