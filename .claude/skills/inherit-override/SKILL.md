---
name: inherit-override
description: The §9a defaults-and-inheritance pattern shared by the backend and the UI — per-ticket override columns are NULL→fall back to the config default at scan time (a moving baseline); explicit values are sticky. Load when resolving effective watch-item settings, building the inherit-vs-override UI, implementing PATCH /api/watchlist/:id/reset, or touching watchlist defaults.
---

# Inherit / Override (PRD §9a)

## Purpose
Watch items inherit their settings from the global `config` row unless explicitly overridden.
This rule lives on BOTH sides: the **backend** resolves effective values at scan time; the
**UI** shows whether each field is inheriting or overridden and offers a one-tap reset. Getting
this consistent is critical — it's the difference between "defaults are a moving baseline" and
silent drift.

## The rule
```
effective_value = ticket.value   IF ticket.value IS NOT NULL   ELSE   config.matching_default
```
- A ticket left at `NULL` **follows the global default — even if that default changes later**
  (moving baseline).
- A ticket with an explicit value is **sticky**: changing the global default does not touch it.
- New tickets are **born inheriting** — the new-ticket form is pre-filled from `config` for
  display, but the override columns are saved as `NULL` (they *reference*, never *copy*).
- Reset = set the column back to `NULL` (PATCH `/api/watchlist/:id/reset`).

Override columns (watchlist): `threshold_pct`, `min_condition`, `foil_pref`, `allow_graded`,
`importance`, `telegram_enabled`, `telegram_min_discount_pct`, `telegram_max_price_cents`,
`telegram_min_savings_cents`. Each maps to a `config` default (deal-logic defaults or
`new_ticket_*` / notification globals).

## Core patterns

### Backend — resolve once, in one place
```ts
// Resolve a watch item's effective settings against the config row. The ONLY place this
// rule lives; scanner + routing both call it. Never scatter `?? config.x` across call sites.
export function resolveEffective(ticket: WatchlistRow, config: ConfigRow): EffectiveSettings {
  return {
    thresholdPct:            ticket.threshold_pct            ?? config.default_threshold_pct,
    minCondition:            ticket.min_condition            ?? config.default_min_condition,
    foilPref:                ticket.foil_pref, // NOT NULL column — always explicit
    allowGraded:             ticket.allow_graded,
    importance:              ticket.importance,
    telegramEnabled:         ticket.telegram_enabled,
    telegramMinDiscountPct:  ticket.telegram_min_discount_pct ?? config.telegram_min_discount_pct,
    telegramMaxPriceCents:   ticket.telegram_max_price_cents,   // NULL = no cap
    telegramMinSavingsCents: ticket.telegram_min_savings_cents, // NULL = no floor
  };
}
```
> Note: in the §9 schema some columns are `NOT NULL DEFAULT` (e.g. `foil_pref`, `importance`,
> `allow_graded`, `telegram_enabled`) and some are nullable overrides (`threshold_pct`,
> `telegram_min_discount_pct`, `telegram_max_price_cents`, `telegram_min_savings_cents`). Only
> the nullable ones fall back to a `config` default; confirm against `schema.sql` and treat
> that schema as the source of truth for which columns are inheritable.

### UI — show inherit vs override, reset nulls the column
```tsx
// One field in the watchlist inspector. `value === null` ⇒ inheriting.
<InheritField
  label="Discount threshold"
  inherited={ticket.threshold_pct === null}
  defaultLabel={`${config.default_threshold_pct}%`}
  onReset={() => resetField('threshold_pct')}   // PATCH /api/watchlist/:id/reset
>
  <ThresholdSlider
    value={ticket.threshold_pct ?? config.default_threshold_pct}
    onChange={(v) => patchField('threshold_pct', v)}  // setting a value makes it sticky
  />
</InheritField>
```
Inheriting → `inherit · {default}` (mono, dim, idle dot). Overridden → an `override ✕` chip
that resets to `NULL` on click.

## Standards
@docs/standards/shared-standards.md
@docs/standards/coding-standards.md

## Examples
### Good
A user creates a watch item with no edits → all override columns `NULL`. The owner later raises
`config.default_threshold_pct` from 50→55 → that item now scans at 55 automatically. Another
item explicitly set to 40 stays at 40.

### Bad
```ts
// ❌ Copies the default into the row at creation — breaks the moving baseline forever.
await createWatchItem({ threshold_pct: config.default_threshold_pct });
// ❌ Inheritance resolved ad-hoc in the scanner with a different fallback than the UI shows.
const t = ticket.threshold_pct || 50;   // also wrong: 0 would fall through (use ?? not ||)
```

## Gotchas
- Use `??` (nullish), never `||` — `0` is a valid override and `||` would discard it.
- New items store `NULL`, not the copied default value.
- Reset = `NULL` the column, not "set to current default value".
- The UI's displayed default and the backend's resolved default MUST be the same `config` field.
- Resolve in ONE backend helper; both `scanner` and `telegram/routing` consume it.

## Related skills
- d1-database — the watchlist/config columns and the reset query
- forms — the `InheritField` control
- telegram-notifications — consumes the resolved telegram_* settings
- deal-engine — consumes the resolved threshold/condition/foil settings
