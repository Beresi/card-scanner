/**
 * useApplyAppearance — app-wide DOM appearance applier.
 *
 * Reads the single config row via useConfig() and, whenever the appearance
 * fields change, writes the relevant data-* attributes and CSS custom
 * properties to <body> so the design-system tokens take effect:
 *
 *   body[data-palette]  = ThemePalette  ('cyan' | 'obsidian' | 'matrix' | 'synthwave')
 *   body[data-theme]    = resolved mode ('dark' | 'light') — NEVER 'system'
 *   body[data-font]     = FontChoice    ('chakra' | 'orbitron' | 'rajdhani' | 'system')
 *   body[data-density]  = Density       ('comfortable' | 'compact')
 *   body style --accent = accent_color  (inline on <body> overrides the palette's
 *                         body-level --accent for all descendants)
 *
 * 'system' mode is resolved via matchMedia; an OS preference change re-triggers
 * the effect and the listener is cleaned up on unmount.
 *
 * While config is loading or undefined the effect is a no-op — the default
 * :root cyan-dark shows until the first successful fetch.
 *
 * Call this hook exactly once, at the top of the component tree (App.tsx).
 * It has no return value.
 */

import { useEffect } from 'react';

import { useConfig } from '../api/hooks';
import { paintFavicon } from '../lib/favicon';

export function useApplyAppearance(): void {
  const { data: config } = useConfig();

  useEffect(() => {
    // No-op while config is not yet loaded.
    if (!config) return;

    function applyTheme() {
      if (!config) return;

      // Resolve 'system' to the actual OS preference.
      const resolvedMode: 'dark' | 'light' =
        config.theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : config.theme;

      document.body.dataset.palette  = config.theme_palette;
      document.body.dataset.theme    = resolvedMode;
      document.body.dataset.font     = config.font;
      document.body.dataset.density  = config.density;

      // Set --accent inline on <body> (NOT documentElement): the palette
      // selectors set --accent on body, so a body-inline value wins for all
      // descendants. Setting it on <html> would be shadowed by the palette's
      // body-level declaration.
      document.body.style.setProperty('--accent', config.accent_color);

      // Repaint the browser tab favicon in the accent color (follows the
      // in-app accent live; no-ops in non-DOM/headless contexts).
      void paintFavicon(config.accent_color);
    }

    applyTheme();

    // Re-apply when the OS dark/light preference changes (only meaningful when
    // theme==='system'; safe to subscribe regardless — no-op otherwise).
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', applyTheme);

    return () => {
      mq.removeEventListener('change', applyTheme);
    };
  }, [
    config,
    config?.theme_palette,
    config?.theme,
    config?.font,
    config?.density,
    config?.accent_color,
  ]);
}
