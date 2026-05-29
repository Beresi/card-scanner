---
name: forms
description: Form/editor patterns for the Card // Broker dashboard — the watchlist inspector, Settings panels, and the add-flow modal. Controlled inputs wired to TanStack Query mutations, the InheritField control, and the prototype's segmented/switch/slider/select primitives. Load before building or editing any editor or input. Plain CSS-var inputs, NOT a heavy form library.
---

# Forms

## Purpose
This app's "forms" are editors backed by the API: the **watchlist inspector** (per-item
settings with inherit/override), the **Settings** panels (the single `config` row), and the
**add-flow modal** (watch a card or a whole set). Inputs are controlled React components wired
to TanStack Query mutations — there is no React-Hook-Form/Zod mandate; keep it lightweight.

## Core patterns

### A controlled field that mutates on change
```tsx
// Inspector field — change writes through to the API and invalidates the cache.
const patch = useWatchlistPatch(item.id);   // TanStack Query mutation (see state-management)

<Segmented
  value={effective.foilPref}
  options={[{ value: 'any', label: 'Any' }, { value: 'foil', label: 'Foil' },
            { value: 'nonfoil', label: 'Non-foil' }]}
  onChange={(foil_pref) => patch.mutate({ foil_pref })}
/>
```

### A field that can inherit (the signature control)
```tsx
// Wrap any per-ticket field that falls back to a config default. See the inherit-override skill.
<InheritField
  label="Telegram min discount"
  inherited={item.telegram_min_discount_pct === null}
  defaultLabel={`${config.telegram_min_discount_pct}%`}
  onReset={() => resetField.mutate('telegram_min_discount_pct')}  // PATCH /:id/reset → NULL
>
  <Slider min={0} max={100}
    value={item.telegram_min_discount_pct ?? config.telegram_min_discount_pct}
    onChange={(v) => patch.mutate({ telegram_min_discount_pct: v })} />
</InheritField>
```

## The primitives (rebuilt from the prototype)
| Control | Used for |
|---|---|
| `Segmented` | foil pref, importance (Normal/High), theme, density, feed filters |
| `Switch` | active toggle, telegram_enabled, digest, scanlines |
| `Slider` (range) | threshold %, min-discount, global TG min-discount |
| `Select` | min condition, sort, watch-item filter |
| text/number input | max price (cents → display), quiet hours, search |
| `InheritField` | any per-ticket field with a config fallback |

## Add-flow (modal)
Segmented "Watch a card" / "Watch a whole set". **Set:** search cached `expansions`
(`GET /api/resolve/expansions?q=`) → pick. **Card:** pick a set → search cached `blueprints`
(`GET /api/resolve/blueprints?expansion_id=&q=`) → pick. Also accept a pasted CardTrader card
URL and parse the id (best effort). Submit creates a watch item born inheriting (override
columns `NULL`).

## Standards
@docs/standards/coding-standards.md

## Examples
### Good
Money inputs edit a display value but store **integer cents**; a max-price field shows `$12.50`
and persists `1250`. Validation is inline and minimal; the Save/Add button disables until valid.

### Bad
```tsx
// ❌ storing a float for money; ❌ copying the default in instead of leaving NULL
patch.mutate({ telegram_max_price_cents: 12.5 });
// ❌ holding the whole config in useState and POSTing the entire blob on every keystroke
```

## Gotchas
- Money fields: edit a display string, persist **integer cents** (`$X.XX` ↔ cents at the edge).
- Inherit fields store `NULL` when inheriting; reset nulls the column (don't write the default).
- Use `??` not `||` when showing the effective value (`0` is a real override).
- New watch items are born inheriting — don't pre-write override columns.
- Settings = the single `config` row; changing a default retroactively affects inheriting items
  (surface that note in the UI).

## Related skills
- inherit-override — the §9a rule behind InheritField
- state-management — the mutation hooks these inputs call
- view-dev — the views that host these editors
