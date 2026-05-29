---
name: component-dev
description: How to build React components for the CardTrader Deal Scanner desktop UI (React + Vite + TS in a Tauri webview). Load when creating or editing a shared primitive (Panel, Btn, Status, Tag, Segmented, Switch, InheritField, PriceBar, Clock, Icon) or any view component — file structure, typed props, className passthrough into cb- classes, presentational-vs-container split, and the leaf-Clock isolation rule. Plain CSS vars + cb- classes, NOT Tailwind.
---

# Component Development

## Purpose
Build the dashboard UI as real, typed React components — **not** the README prototype's
Babel-in-HTML + `window.*` globals + mock `data.js`. Stack is **React + Vite + TypeScript**
rendered inside a Tauri v2 webview. Single-user, English only (no i18n). Styling is **plain
CSS custom properties + `cb-` classes** (CSS Modules or co-located CSS, per the scaffold
decision) — there is **no Tailwind, no CVA, no Server Components, no `'use client'`**.

Components are **presentational**: they take typed props and render. Server data (deals,
watchlist, config, scan_runs, caches) lives upstream in feature containers/hooks via TanStack
Query (see `state-management`) — primitives never fetch. The signature shape, chamfer, glow,
and tokens come from the design system (see `design-system`); components only consume them.

## Core patterns

### File structure
One component per file, named export, co-located styles:
```
src/components/Btn/
├── Btn.tsx            # function component, typed props, no `any`
├── Btn.module.css     # optional — co-located cb- classes (or shared component CSS)
└── index.ts           # export { Btn } from './Btn'  — NAMED, never default
```
Views live under `src/views/<kebab-case>/` (e.g. `views/deal-feed/DealCard.tsx`); shared
primitives under `src/components/`. Components are `PascalCase.tsx`, hooks `useX.ts`, other
modules `camelCase.ts` (see naming-conventions).

### 1. A typed primitive with `className` passthrough + cb- classes
A function component, typed props (no `any`), variants as a string union, and the caller's
`className` **merged after** the base `cb-` classes so callers can extend without clobbering.
```tsx
import type { ButtonHTMLAttributes } from 'react';

type BtnVariant = 'primary' | 'ghost' | 'danger';

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  /** Extra classes merged AFTER the cb- base classes. */
  className?: string;
}

// tiny local join helper — no clsx/cn dependency, no Tailwind merge
function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Btn({ variant = 'primary', className, type = 'button', ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx('cb-btn', `cb-btn--${variant}`, className)}
      {...rest}
    />
  );
}
```
```css
/* Btn.module.css — consumes design tokens, never raw hex */
.cb-btn {
  font-family: 'Chakra Petch', sans-serif;
  padding: 0 var(--pad);
  color: var(--text);
  border: 1px solid var(--line-strong);
  background: var(--panel-3);
  /* signature chamfer + glow come from design-system tokens/mixins */
  clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
}
.cb-btn--primary {
  color: var(--accent-ink);
  background: var(--accent);
  box-shadow: 0 0 calc(12px * var(--glow)) var(--accent-glow);
}
.cb-btn--danger { color: var(--hot); border-color: var(--hot); }
```
The `cb-` class names match the prototype (`cb-btn`, `cb-tag`, `cb-seg`, `cb-pbar`, `cb-panel`)
so design CSS ports cleanly. Forward `...rest` so `onClick`, `aria-*`, `disabled`, `title` all
pass through. Buttons get `type="button"` by default (avoid accidental form submits).

### 2. The isolated leaf `Clock` (perf-critical)
The next-scan countdown ticks once per second. If that tick lives in the root, the **whole tree
re-renders every second** and entrance animations stick at `opacity:0` (README perf note). Keep
the timer in its own **leaf** component so only the clock re-renders. The parent passes a stable
target timestamp; the clock owns its own interval.
```tsx
import { useEffect, useState } from 'react';

export interface ClockProps {
  /** Epoch ms of the next scan. The countdown derives from this. */
  targetAt: number;
  className?: string;
}

function remaining(targetAt: number): number {
  return Math.max(0, targetAt - Date.now());
}

export function Clock({ targetAt, className }: ClockProps) {
  const [msLeft, setMsLeft] = useState(() => remaining(targetAt));

  useEffect(() => {
    setMsLeft(remaining(targetAt));
    const id = window.setInterval(() => setMsLeft(remaining(targetAt)), 1000);
    return () => window.clearInterval(id);
  }, [targetAt]);

  const total = Math.floor(msLeft / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const hot = total <= 60; // hot-clock effect: pulse --hot in the final 60s

  return (
    <time
      className={['cb-clock', hot && 'cb-clock--hot', className].filter(Boolean).join(' ')}
      aria-label={`Next scan in ${mm}:${ss}`}
    >
      {mm}:{ss}
    </time>
  );
}
```
Render it as a leaf — `<Clock targetAt={nextScanAt} />` — beside the content, never as a
provider wrapping the tree. The interval is local; no parent re-renders on tick.

## Standards
@docs/standards/naming-conventions.md
@docs/standards/coding-standards.md

## Examples (Good / Bad)

**Good** — presentational primitive, typed props, cb- classes from tokens, named export,
caller `className` merged last:
```tsx
export interface TagProps {
  tone?: 'neutral' | 'priority' | 'sent' | 'good';
  children: React.ReactNode;
  className?: string;
}
export function Tag({ tone = 'neutral', children, className }: TagProps) {
  return (
    <span className={['cb-tag', `cb-tag--${tone}`, className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}
```

**Bad** — Tailwind utility classes, raw hex, a default export, and data-fetching inside a
primitive:
```tsx
// ❌ Tailwind + raw hex (no Tailwind in this project; use cb- classes + tokens)
// ❌ default export (must be named)
// ❌ fetch inside a primitive (data lives in a feature container/hook)
export default function Tag({ tone }: { tone: any }) {            // ❌ `any`
  const { data } = useQuery(['deals'], fetchDeals);               // ❌ primitive fetching
  return <span className="px-2 py-1 rounded bg-[#22d3ee] text-xs">{data?.length}</span>;
}
```

**Bad** — the prototype's window-global pattern (do NOT port):
```tsx
// ❌ prototype scaffolding — Babel-in-HTML global export
window.Btn = function Btn(props) { /* ... */ };
```

## Gotchas
- **No Tailwind.** Style with CSS custom properties (`--accent`, `--panel-2`, `--pad`,
  `--glow`, …) + `cb-` classes (`cb-btn`, `cb-tag`, `cb-seg`, `cb-pbar`, `cb-panel`). Never
  raw hex in components — pull the token (design-system owns the values).
- **Named exports, not default.** `index.ts` re-exports the named symbol so imports stay
  consistent and refactors don't silently rename.
- **Isolate the ticking `Clock`.** A once-per-second tick in the root re-renders the whole
  tree and freezes entrance animations at `opacity:0`. Keep the countdown (and any timer/
  animation state) in a **leaf** component (README perf note, coding-standards).
- **Primitives are presentational.** No `fetch`, no TanStack Query, no `Date.now()`-driven
  business logic in a primitive (the Clock's local tick is the one allowed timer). Data comes
  from feature containers/hooks above (state-management).
- **No `any`.** `strict: true`; type props explicitly, extend the right
  `HTMLAttributes`/`…HTMLAttributes<HTMLElement>` so DOM props/`aria-*`/`ref` pass through.
- **Merge `className` last** so callers can extend the `cb-` base without overriding it.
- **Money is integer cents** — a primitive that shows a price takes a pre-formatted string or
  calls `formatCents` at the edge; never compute/store float money in a component.
- **Accessibility baseline:** semantic HTML (`<button>`, `<time>`, `<nav>`, `<table>`), real
  keyboard support (the ⌘K palette needs ↑/↓/↵/Esc; toggles are focusable), and `aria-*`
  where the visual cue isn't enough (e.g. the Clock's `aria-label`). See `accessibility`.
- **No i18n.** Single-user English — write strings directly; there is no `t()` indirection.

## Related skills
- `design-system` — tokens / chamfer / glow / `cb-` class styling the components consume
- `accessibility` — keyboard, ARIA, semantic HTML for the primitives and the palette
- `state-management` — where server data actually lives (TanStack Query, not in primitives)
