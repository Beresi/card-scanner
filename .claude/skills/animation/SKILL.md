---
name: animation
description: The opt-in cyberpunk effects for Card // Broker — decrypt reveal, radar sweep + blips, incoming toasts, hot clock, boot CRT glitch, card hover. ALL transform/opacity-only, event-driven (mount/hover/scan), feature-flagged behind Tweaks, and reduced-motion aware. Load before building any effect/animation or the live-scan/boot overlays. NOT a heavy motion-library mandate.
---

# Animation & Effects

## Purpose
The look is alive with restrained, high-craft motion. Every effect is **opt-in (default on,
behind a Tweak toggle), transform/opacity-only, and event-driven** — never an always-on render
loop. Plain CSS + small React triggers; no Framer-Motion mandate (use it only if a specific
effect truly needs it).

## The effect catalogue (README)
| Effect | Trigger | Notes |
|---|---|---|
| Decrypt reveal | new deal mounts | name scrambles through glyphs → resolves (~16 frames/~500ms), staggered ~140ms/card, once per card |
| Incoming toasts | scan completion | high-priority "PRIORITY · Telegram" toast slides from top-right, auto-dismiss ~4.6s |
| Radar (scan overlay) | Scan now / palette | rings + cross + rotating conic sweep + contact pings; faster while scanning |
| Radar blips (telemetry) | ambient | contact dots fade in/out, pure CSS |
| Hot clock | final 60s of countdown | next-scan clock turns `--hot` and pulses |
| Boot CRT glitch | first load | terminal lines → logo → horizontal shake → squeeze to a line → fade |
| Card hover | hover | border lights to accent + soft glow |

## Core patterns

### Transform/opacity-only, reduced-motion aware (CSS)
```css
@keyframes cb-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.cb-deal-enter { animation: cb-rise 320ms ease-out both; }     /* GPU-friendly props only */

@media (prefers-reduced-motion: reduce) {
  .cb-deal-enter, .cb-radar-sweep, .cb-decrypt { animation: none !important; }
}
```

### Event-driven decrypt, isolated so it doesn't re-render the tree (React)
```tsx
// Runs once on mount; local state only — does NOT live in app/global state.
function ScrambleText({ text }: { text: string }) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      setShown(scramble(text, frame));            // 16 frames then resolve
      if (frame >= 16) { setShown(text); clearInterval(id); }
    }, 30);
    return () => clearInterval(id);
  }, [text]);
  return <span>{shown}</span>;
}
```

## The performance rule (non-negotiable — README)
A once-per-second app-wide re-render (e.g. a countdown in the root) caused entrance animations
to stick at `opacity:0`. **Isolate ticking timers into their own leaf component** (`Clock`) so
the rest of the tree doesn't re-render each second. Keep all animation state local to the
animating component.

## Feature flags
Each effect sits behind a Tweak toggle (decrypt, toasts, blips, hot clock, scanlines). Default
on, but the user can disable any of them; respect the flag AND `prefers-reduced-motion`.

## Standards
@docs/standards/coding-standards.md

## Examples
### Good
The radar sweep is a CSS `conic-gradient` rotated via `transform`; it speeds up by swapping a
CSS variable while `scanning`. Toasts mount on scan-complete and unmount via timeout.

### Bad
```tsx
// ❌ always-on rAF loop animating layout props for every card, every frame
useEffect(() => { const loop = () => { card.style.left = `${x++}px`; raf(loop); }; raf(loop); });
// ❌ a setInterval in the App root driving the countdown → whole tree re-renders, animations break
```

## Gotchas
- transform/opacity ONLY — never animate `left/top/width/height` (layout thrash).
- Event-driven, not always-on; unmount/clear intervals on cleanup.
- Isolate the per-second `Clock`; never tick global state.
- Honor `prefers-reduced-motion` and the per-effect Tweak flag.
- Decrypt runs once per new card (stagger ~140ms), not on every render.

## Related skills
- design-system — the tokens/glow/chamfer these effects sit on top of
- component-dev — the leaf-Clock isolation rule
- accessibility — reduced-motion + not trapping focus during overlays
