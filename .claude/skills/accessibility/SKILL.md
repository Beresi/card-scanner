---
name: accessibility
description: Accessibility for the Card // Broker desktop UI — full keyboard control of the ⌘K palette and overlays, focus management, ARIA for the dialog/table/segmented/switch, the ~10px min-readable floor, contrast on the dark theme, and reduced-motion. Load when building interactive components, the palette/scan/boot overlays, or the watchlist table.
---

# Accessibility

## Purpose
Single-user desktop app, but it must be fully keyboard-drivable and readable. The ⌘K command
palette is the headline keyboard surface; the dense watchlist table and the various overlays
(scan, boot, add-flow) need correct focus and ARIA. (No i18n/RTL — single-language.)

## Core patterns

### Full keyboard control of the command palette (⌘K)
```tsx
// ↑/↓ move the active row, ↵ runs it, Esc closes, mouse hover sets active. Roving selection.
function CommandPalette({ commands, onClose }: PaletteProps) {
  const [active, setActive] = useState(0);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { setActive((i) => Math.min(i + 1, commands.length - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setActive((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === 'Enter') { commands[active]?.run(); onClose(); }
    else if (e.key === 'Escape') { onClose(); }
  }
  return (
    <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
      <input autoFocus aria-label="Search commands" aria-activedescendant={`cmd-${active}`} />
      <ul role="listbox">{/* role=option, aria-selected={i===active}, id=cmd-i */}</ul>
    </div>
  );
}
```

### Focus management for modals/overlays
- On open: move focus into the dialog (the search input or first control); trap Tab within it.
- On close: return focus to the trigger (the ⌘K chip, the row, the Add button).
- `role="dialog" aria-modal="true"` + an `aria-label`; Esc always closes.

## ARIA per surface
| Surface | Roles / attributes |
|---|---|
| ⌘K palette | `role=dialog aria-modal`, input `aria-activedescendant`, `role=listbox`/`option` |
| Segmented control | `role=tablist` / `role=tab` + `aria-selected` |
| Switch | `aria-pressed` (or `role=switch aria-checked`) |
| Watchlist table | semantic `<table>`, sticky header, selected row conveyed (not color-only) |
| Toasts | `aria-live="polite"` region; never the only signal for a critical event |
| Status dots | pair the color dot with a text/`aria-label` (don't rely on color alone) |

## Readability & contrast
- Min readable **~10px** (mono micro-labels only) — never smaller (design-system).
- Dark-first: verify text tokens (`--text`, `--text-dim`) meet contrast over panel surfaces;
  don't drop to `--text-faint` for essential content.
- State (priority, seen, active) must be conveyed by more than hue — add an icon/tag/label.

## Standards
@docs/standards/coding-standards.md

## Examples
### Good
The scan overlay opens, focus lands on it, Tab cycles within it, Esc closes and returns focus to
the Scan-now button. Priority deals show a "PRIORITY" tag + hot rail, not just a red tint.

### Bad
```tsx
<div onClick={run}>Run scan</div>   // ❌ not focusable/keyboard-activatable; use <button>
// ❌ a discount conveyed only by green text; ❌ a modal that doesn't trap or restore focus
```

## Gotchas
- Every interactive element is a real `<button>`/`<a>` or has `role` + `tabindex` + key handlers.
- Trap focus in overlays; restore it on close; Esc closes everywhere.
- Honor `prefers-reduced-motion` (see animation) — overlays must be usable with motion off.
- Color is never the sole carrier of meaning.
- Keep the ~10px floor; tabular-nums for aligned numeric readouts.

## Related skills
- component-dev — building the keyboard-accessible primitives
- design-system — contrast, readable sizes, status tokens
- animation — reduced-motion, non-trapping overlays
