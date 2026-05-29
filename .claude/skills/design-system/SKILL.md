---
name: design-system
description: The cyberpunk "ops console" token system for Card // Broker — CSS custom properties (NOT Tailwind), chamfer/glow/brackets, Chakra Petch + IBM Plex Mono, density modes, live theme/accent/density var-swapping. Load before touching tokens.css, any cb- class, theme switching, or visual fidelity.
---

# Design System

## Purpose
Card // Broker is a high-fidelity, dark-first cyberpunk "ops console". Its look is defined
entirely by **CSS custom properties** and a `cb-` class system — **there is no Tailwind**.
The tokens below are FINAL (README "Design Tokens") and must be reproduced precisely. Theme,
accent, and density swap live by rewriting CSS variables on `:root`/`body`; the choices persist
in the `config` row.

## Core patterns

### The `:root` token block
```css
:root {
  /* surfaces */
  --bg: #05070b;            /* app background (cold near-black) */
  --rail: #070a10;          /* left nav + right rail (recessed) */
  --panel: #0a0f17;
  --panel-2: #0e141f;       /* raised panel (gradient top) */
  --panel-3: #121a28;       /* buttons / inputs surface */
  /* borders */
  --line: rgba(120,180,215,0.10);
  --line-strong: rgba(120,200,230,0.22);
  /* text */
  --text: #eaf2fb;
  --text-dim: #a3b5c8;
  --text-faint: #6c7e92;
  /* semantic */
  --accent: #22d3ee;        /* user-themeable */
  --accent-ink: #042027;    /* text on accent fills */
  --hot: #f0387a;           /* priority / alerts / urgency */
  --good: #45e0a0;          /* positive deltas / discounts */
  --warn: #f5b945;
  /* derived (computed from --accent) */
  --accent-soft: color-mix(in oklab, var(--accent) 16%, transparent);
  --accent-glow: color-mix(in oklab, var(--accent) 55%, transparent);
  /* density (comfortable; compact overrides --pad:12px --row:9px) */
  --pad: 18px;
  --row: 14px;
  /* shape + glow */
  --radius: 2px;            /* essentially square */
  --glow: 1;                /* 0–1.6 multiplier; dial all glow down */
  --bg-grid: rgba(80,150,190,0.045);
}
/* curated accent set the swatches offer: */
/* #22d3ee #37e0c8 #5b8cff #f0387a #f5b945 #45e0a0 */
```
Apply a theme/accent/density change by setting these vars on `:root` (or `body`) at runtime;
never recompile — just swap the variable values, persist to `config`.

### Chamfer, glow, corner brackets (the signature shapes)
```css
.cb-chamfer {                /* cut corner, NOT rounded — the signature */
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px,
                     100% 100%, 12px 100%, 0 calc(100% - 12px));
}
.cb-chamfer-sm { /* same with 7px */ }
.cb-glow { box-shadow: 0 0 calc(18px * var(--glow)) var(--accent-glow); }
.cb-active { border-color: color-mix(in oklab, var(--accent) 40%, transparent); }
.bracket { /* small L-shaped accent marks, top-left + bottom-right of focused panels */ }
```

## Typography
- Display / UI / body: **Chakra Petch** (400/500/600/700; base body **500**).
- Data / numbers: **IBM Plex Mono** (400/500/600) with `font-variant-numeric: tabular-nums`.
- Eyebrow micro-labels: IBM Plex Mono ~10.5px, `letter-spacing:.2em`, uppercase, `--text-dim`.
- Sizes: h1 22/600; deal name 16/600; price 19/700; discount% 23/700; row label 13.5/600;
  body 13–14. **Min readable ~10px** (mono micro-labels only) — never smaller.
- Bundle the fonts locally for the desktop app (don't rely on Google Fonts at runtime).

## Backdrop
44px grid (`--bg-grid`), radially masked toward center, plus a vignette. Optional CRT scanline
overlay, **off by default** (a Tweak toggle).

## Standards
@docs/standards/naming-conventions.md

## Examples
### Good
A panel uses `.cb-panel.cb-chamfer`, hairline `--line` border, text in `--text`; its discount
figure is `--good` at 23px/700 with `cb-glow`. Switching accent recolors everything because
components reference `var(--accent)`, never a literal.

### Bad
```css
.deal { background:#0a0f17; border-radius:8px;          /* ❌ hardcoded hex + rounded */
        box-shadow:0 0 18px #22d3ee; }                   /* ❌ ignores --glow multiplier */
/* ❌ Tailwind: <div className="bg-[#0a0f17] rounded-lg shadow-cyan-500/50"> */
```
Rounded corners break the cyberpunk identity; hardcoded hex breaks theming; a fixed glow
can't be dialed down.

## Gotchas
- Square `--radius: 2px` + **chamfer** is the signature — never round corners.
- All glow scales by `var(--glow)` (0–1.6) so it can be turned down — respect it.
- `--accent` is user-selectable from the curated set; reference the var, never a literal.
- Dark-first; light/system themes swap the same variable names.
- Min readable ~10px floor (mono micro-labels only).
- Honor `prefers-reduced-motion` for the effects layered on top (see animation skill).

## Related skills
- animation — the effects (decrypt, radar, toasts, boot glitch) layered over these tokens
- component-dev — components consume these tokens via cb- classes
- accessibility — contrast + readable sizes
