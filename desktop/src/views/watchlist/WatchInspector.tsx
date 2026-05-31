/**
 * WatchInspector — right-rail editor for the selected watchlist item.
 *
 * Reads the selected item from:
 *   - useWatchSelection() — for selectedId + deselect
 *   - useWatchlist()      — to find the selected item by id
 *   - useConfig()         — for inherit baseline values (§9a)
 *
 * App renders <WatchInspector /> when selectedId is non-null;
 * <WatchSummary /> otherwise. No props needed — data comes from hooks.
 *
 * §9a inherit/override: each editable field uses effOf helpers.
 * Fields with a config default are wrapped in InheritField.
 * Fields without a config default (telegram_max_price_cents) are plain
 * nullable inputs — NOT wrapped in InheritField.
 *
 * Override strategy (uniform, simple):
 *   - Override a field  → usePatchWatchItem({ id, patch: { col: value } })
 *   - Reset to inherit  → usePatchWatchItem({ id, patch: { col: null } })
 *     (PATCH null nulls the column; works for all nullable override cols.)
 *
 * Detection mode (§9a):
 *   - "Discount %" (default) — existing threshold/median-baseline logic.
 *   - "Price ≤"              — fires when cheapest ≤ max_price_cents.
 *   Conditionally renders the correct control below the mode selector.
 *   In price mode the Telegram min-discount gate won't fire (discount_pct=0),
 *   so the max-price Telegram cap is surfaced as the relevant Telegram trigger.
 *
 * Card-type items (type='card'):
 *   - Show card name (label) + an editable set-filter chip list.
 *   - Hide single-printing details (cardtrader_id, foil pref) — not applicable.
 *   - expansion_filter is stored as JSON string in WatchItem; decode for display,
 *     send decoded number[] (or null) in the PATCH.
 *
 * Money: all cents inputs display as dollars (÷100), store as integer cents.
 * usd() is used only for display; the store always receives integer cents.
 */
import { useState } from 'react';

import type { Config, DetectionMode, WatchItem, WatchItemPatch } from '../../api/types';
import { useConfig, usePatchWatchItem, useDeleteWatchItem, useWatchlist, useResolveExpansions } from '../../api/hooks';
import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { InheritField } from '../../components/InheritField';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { Slider } from '../../components/Slider';
import { Switch } from '../../components/Switch';
import { usd } from '../../lib/format';
import { select } from './selection';
import { useWatchSelection } from './selection';
import {
  effDetectionMode,
  effFoilPref,
  effImportance,
  effMaxPrice,
  effMinCondition,
  effTelegramEnabled,
  effTelegramMinDiscount,
  effThreshold,
} from './effOf';

// ---------------------------------------------------------------------------
// Condition options
// ---------------------------------------------------------------------------

const CONDITION_OPTIONS = [
  { value: 'NM', label: 'NM — Near Mint' },
  { value: 'LP', label: 'LP — Light Play' },
  { value: 'MP', label: 'MP — Moderate Play' },
  { value: 'HP', label: 'HP — Heavy Play' },
  { value: 'D',  label: 'D — Damaged' },
];

const DETECTION_MODE_OPTIONS = [
  { value: 'discount', label: 'Discount %' },
  { value: 'price',    label: 'Price ≤' },
];

// ---------------------------------------------------------------------------
// SetFilterChips — editable chip list of expansion_ids for card-type items
// ---------------------------------------------------------------------------

interface SetFilterChipsProps {
  /** Decoded expansion_ids currently in the filter (empty = all sets). */
  ids: number[];
  /** Called when the user removes a chip. */
  onRemove: (id: number) => void;
  /** Called when a new expansion is added from the search below. */
  onAdd: (id: number, name: string) => void;
  /** Expansion names cache: id → name, built from previously picked sets. */
  names: Record<number, string>;
}

function SetFilterChips({ ids, onRemove, onAdd, names }: SetFilterChipsProps) {
  const [q, setQ] = useState('');

  // Debounce the expansion search to avoid per-keystroke queries.
  const [debouncedQ, setDebouncedQ] = useState('');
  const [debTimer, setDebTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  function handleQChange(v: string) {
    setQ(v);
    if (debTimer) clearTimeout(debTimer);
    const t = setTimeout(() => setDebouncedQ(v), 300);
    setDebTimer(t);
  }

  const expansionQuery = useResolveExpansions(debouncedQ);
  const enabled = debouncedQ.trim().length >= 2;

  return (
    <div className="set-filter-chips" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Chip list — current selected sets */}
      {ids.length > 0 ? (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
          aria-label="Selected set restrictions"
        >
          {ids.map((id) => (
            <span
              key={id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                background: 'var(--accent-soft)',
                border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                borderRadius: 'var(--radius)',
                fontSize: 11,
                fontFamily: 'var(--f-mono)',
                color: 'var(--text)',
              }}
            >
              {names[id] ?? `#${id}`}
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  color: 'var(--text-dim)',
                  lineHeight: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                aria-label={`Remove set ${names[id] ?? id}`}
                onClick={() => onRemove(id)}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span
          className="cb-mono"
          style={{ fontSize: 11, color: 'var(--text-faint)' }}
        >
          All sets (no restriction)
        </span>
      )}

      {/* Search to add a set restriction */}
      <div className="addflow-search">
        <Icon name="search" size={12} svgProps={{ style: { color: 'var(--text-dim)', flexShrink: 0 } }} />
        <input
          type="text"
          className="cb-input"
          value={q}
          placeholder="Restrict to a set…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search for a set to add as a filter restriction"
          onChange={(e) => handleQChange(e.target.value)}
        />
      </div>

      {/* Search results */}
      {enabled && (
        <div style={{ maxHeight: 120, overflowY: 'auto' }}>
          {expansionQuery.isPending && expansionQuery.fetchStatus !== 'idle' ? (
            <p className="addflow-none cb-mono" style={{ margin: 0 }}>Searching…</p>
          ) : expansionQuery.isError ? (
            <p className="addflow-none cb-mono" style={{ margin: 0, color: 'var(--bad)' }}>
              {expansionQuery.error?.message ?? 'Search failed'}
            </p>
          ) : expansionQuery.data && expansionQuery.data.length > 0 ? (
            <div className="addflow-results" role="listbox" aria-label="Set search results">
              {expansionQuery.data
                .filter((exp) => !ids.includes(exp.id))
                .map((exp) => (
                  <button
                    key={exp.id}
                    type="button"
                    className="addflow-opt"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      onAdd(exp.id, exp.name);
                      setQ('');
                      setDebouncedQ('');
                    }}
                  >
                    <span className="addflow-opt-name" style={{ fontSize: 12 }}>{exp.name}</span>
                    <span className="cb-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      {exp.code}
                    </span>
                    <span className="cb-mono" style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>
                      + add
                    </span>
                  </button>
                ))}
            </div>
          ) : enabled && !expansionQuery.isPending ? (
            <p className="addflow-none cb-mono" style={{ margin: 0 }}>No matches</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: the editor body (selected item guaranteed non-null here)
// ---------------------------------------------------------------------------

interface InspectorBodyProps {
  item: WatchItem;
  config: Config;
}

/**
 * MaxPriceInput — controlled text input for a price cap in cents.
 * Displays as a dollar-formatted string; stores integer cents on blur.
 * Used for both telegram_max_price_cents and max_price_cents.
 */
function MaxPriceInput({
  id,
  valueCents,
  placeholder,
  label,
  onChange,
}: {
  id: string;
  valueCents: number | null;
  placeholder: string;
  label: string;
  onChange: (cents: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(
    valueCents == null ? '' : (valueCents / 100).toFixed(2),
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
  }

  function handleBlur() {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onChange(null);
      return;
    }
    const parsed = parseFloat(trimmed);
    if (!isNaN(parsed) && parsed >= 0) {
      const cents = Math.round(parsed * 100);
      onChange(cents);
      setDraft((cents / 100).toFixed(2));
    } else {
      setDraft(valueCents == null ? '' : (valueCents / 100).toFixed(2));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="cb-ifield-lbl">{label}</span>
        {valueCents != null && (
          <span style={{ fontFamily: 'var(--f-mono)', fontSize: 10, color: 'var(--accent)' }}>
            {usd(valueCents)}
          </span>
        )}
      </div>
      <input
        id={id}
        type="text"
        className="cb-input"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        onChange={handleChange}
        onBlur={handleBlur}
      />
    </div>
  );
}

function InspectorBody({ item, config }: InspectorBodyProps) {
  const patchItem  = usePatchWatchItem();
  const deleteItem = useDeleteWatchItem();

  const thrEff      = effThreshold(item, config);
  const condEff     = effMinCondition(item, config);
  const foilEff     = effFoilPref(item, config);
  const impEff      = effImportance(item, config);
  const tgEff       = effTelegramEnabled(item, config);
  const tgDiscEff   = effTelegramMinDiscount(item, config);
  const detectEff   = effDetectionMode(item, config);
  const maxPriceEff = effMaxPrice(item, config);

  const effectiveThrPct    = thrEff.value;
  const effectiveTgDiscPct = tgDiscEff.value;
  const effectiveDetect    = detectEff.value;

  // Decode expansion_filter JSON string → number[] for display
  const parsedExpansionFilter: number[] = (() => {
    if (!item.expansion_filter) return [];
    try {
      const parsed = JSON.parse(item.expansion_filter);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'number');
    } catch {
      // ignore malformed
    }
    return [];
  })();

  // Local cache of expansion names for chip display (id → name).
  // Pre-populated from any chips already stored; additions fill it in.
  const [expansionNames, setExpansionNames] = useState<Record<number, string>>(() =>
    Object.fromEntries(parsedExpansionFilter.map((id) => [id, `#${id}`])),
  );

  // Helper: build a WatchItemPatch and fire the mutation
  function patch(p: WatchItemPatch) {
    patchItem.mutate({ id: item.id, patch: p });
  }

  // Helper: null a field back to inherit
  function resetField(col: 'threshold_pct' | 'min_condition' | 'foil_pref' | 'importance' |
    'telegram_enabled' | 'telegram_min_discount_pct' | 'detection_mode' | 'max_price_cents') {
    patchItem.mutate({ id: item.id, patch: { [col]: null } as WatchItemPatch });
  }

  // Set-filter chip handlers
  function handleAddSet(id: number, name: string) {
    setExpansionNames((prev) => ({ ...prev, [id]: name }));
    const newIds = [...parsedExpansionFilter.filter((x) => x !== id), id];
    patch({ expansion_filter: newIds });
  }

  function handleRemoveSet(id: number) {
    const newIds = parsedExpansionFilter.filter((x) => x !== id);
    patch({ expansion_filter: newIds.length > 0 ? newIds : null });
  }

  // Derived note for the telegram gate explanation
  function telegramNote(): string {
    if (effectiveDetect === 'price') {
      return 'Price mode: deals always carry 0% discount — the min-discount Telegram gate will not fire. Use the max-price cap below (or set importance to High) to control Telegram pushes.';
    }
    if (impEff.value === 'high') {
      return 'High importance — pushes on ANY deal, bypassing the discount gate.';
    }
    if (tgEff.value) {
      return `Pushes only when discount ≥ ${effectiveTgDiscPct}% (stricter than the ${effectiveThrPct}% app threshold).`;
    }
    return 'App-only. Appears in the feed but never pings Telegram.';
  }

  function handleRemove() {
    deleteItem.mutate(item.id, {
      onSuccess: () => select(null),
    });
  }

  const isCard = item.type === 'card';

  return (
    <div className="insp">
      {/* Head: type icon + label + id + close */}
      <div className="insp-head">
        <div className="insp-head-id">
          <Icon
            name={item.type === 'expansion' ? 'layers' : 'card'}
            size={16}
            svgProps={{
              style: { color: item.type === 'expansion' ? 'var(--accent)' : 'var(--text-dim)', flexShrink: 0 },
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div className="insp-title">{item.label}</div>
            <div className="insp-sub cb-mono">
              {isCard ? (
                'any printing · card'
              ) : (
                <>#{item.cardtrader_id}{item.type === 'expansion' ? ' · expansion' : ' · blueprint'}</>
              )}
            </div>
          </div>
        </div>
        <Btn
          variant="ghost"
          className="cb-btn-sm cb-btn-ico"
          onClick={() => select(null)}
          aria-label="Close inspector"
          title="Close inspector"
        >
          <Icon name="x" size={14} />
        </Btn>
      </div>

      {/* Body: editable fields */}
      <div className="insp-body">

        {/* Card-type: set filter */}
        {isCard && (
          <div className="insp-section">
            <span className="cb-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Set restriction
            </span>
            <SetFilterChips
              ids={parsedExpansionFilter}
              names={expansionNames}
              onAdd={handleAddSet}
              onRemove={handleRemoveSet}
            />
          </div>
        )}

        {/* Detection mode */}
        <InheritField
          label="Detection mode"
          inherited={detectEff.inherited}
          defaultLabel={detectEff.defaultLabel}
          onReset={() => resetField('detection_mode')}
        >
          <Segmented
            value={effectiveDetect}
            size="sm"
            options={DETECTION_MODE_OPTIONS}
            onChange={(v) => patch({ detection_mode: v as DetectionMode })}
          />
        </InheritField>

        {/* Detection control — conditional on mode */}
        {effectiveDetect === 'discount' ? (
          /* Discount mode: existing threshold slider */
          <InheritField
            label="Threshold"
            inherited={thrEff.inherited}
            defaultLabel={thrEff.defaultLabel}
            onReset={() => resetField('threshold_pct')}
          >
            <Slider
              label="Discount threshold"
              value={effectiveThrPct}
              min={10}
              max={90}
              step={5}
              suffix="%"
              onChange={(v) => patch({ threshold_pct: v })}
            />
          </InheritField>
        ) : (
          /* Price mode: max price input wrapped in InheritField */
          <InheritField
            label="Max price"
            inherited={maxPriceEff.inherited}
            defaultLabel={maxPriceEff.defaultLabel}
            onReset={() => resetField('max_price_cents')}
          >
            <MaxPriceInput
              id="insp-max-price"
              valueCents={maxPriceEff.value}
              placeholder="no cap set"
              label="Maximum price (dollars)"
              onChange={(cents) => patch({ max_price_cents: cents })}
            />
          </InheritField>
        )}

        {/* Min condition — not relevant for card-type in price mode but still useful */}
        <InheritField
          label="Min condition"
          inherited={condEff.inherited}
          defaultLabel={condEff.defaultLabel}
          onReset={() => resetField('min_condition')}
        >
          <Select
            value={condEff.value}
            options={CONDITION_OPTIONS}
            onChange={(v) => patch({ min_condition: v })}
          />
        </InheritField>

        {/* Foil preference — hide for card-type (any printing watches all foil states) */}
        {!isCard && (
          <InheritField
            label="Foil preference"
            inherited={foilEff.inherited}
            defaultLabel={foilEff.defaultLabel}
            onReset={() => resetField('foil_pref')}
          >
            <Segmented
              value={foilEff.value}
              size="sm"
              options={[
                { value: 'any',     label: 'Any' },
                { value: 'nonfoil', label: 'Nonfoil' },
                { value: 'foil',    label: 'Foil' },
              ]}
              onChange={(v) => patch({ foil_pref: v as WatchItem['foil_pref'] })}
            />
          </InheritField>
        )}

        {/* Importance */}
        <InheritField
          label="Importance"
          inherited={impEff.inherited}
          defaultLabel={impEff.defaultLabel}
          onReset={() => resetField('importance')}
        >
          <Segmented
            value={impEff.value}
            size="sm"
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'high',   label: 'High · bypass' },
            ]}
            onChange={(v) => patch({ importance: v as WatchItem['importance'] })}
          />
        </InheritField>

        {/* Telegram block */}
        <div className="insp-tg">
          <div className="wrow-tg-head">
            <span className="cb-eyebrow">Telegram routing</span>
            <Switch
              on={tgEff.value}
              onChange={(on) => patch({ telegram_enabled: on ? 1 : 0 })}
              label="Telegram"
              aria-label="Enable Telegram for this item"
            />
          </div>

          {tgEff.value && (
            <>
              {/* Discount-mode: show min-discount gate; price-mode: gate is irrelevant */}
              {effectiveDetect === 'discount' && (
                <InheritField
                  label="Min discount"
                  inherited={tgDiscEff.inherited}
                  defaultLabel={tgDiscEff.defaultLabel}
                  onReset={() => resetField('telegram_min_discount_pct')}
                >
                  <Slider
                    label="Telegram minimum discount"
                    value={effectiveTgDiscPct}
                    min={40}
                    max={90}
                    step={5}
                    suffix="%"
                    onChange={(v) => patch({ telegram_min_discount_pct: v })}
                  />
                </InheritField>
              )}

              {/* Max price cap — always shown when Telegram is on; especially relevant
                  in price mode where the discount gate won't fire (discount_pct=0). */}
              <MaxPriceInput
                id="insp-tg-max-price"
                valueCents={item.telegram_max_price_cents}
                placeholder="no cap"
                label="Telegram max price cap (dollars)"
                onChange={(cents) => patch({ telegram_max_price_cents: cents })}
              />
            </>
          )}

          <p className="wrow-note cb-mono" style={{ marginTop: 4 }}>
            {telegramNote()}
          </p>
        </div>

      </div>

      {/* Footer: remove */}
      <div className="insp-foot">
        <Btn
          variant="danger"
          className="cb-btn-sm"
          onClick={handleRemove}
          disabled={deleteItem.isPending}
        >
          <Icon name="x" size={13} />
          {deleteItem.isPending ? 'Removing…' : 'Remove from watchlist'}
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WatchInspector — exported component reads real hooks directly
// ---------------------------------------------------------------------------

export function WatchInspector() {
  const { selectedId } = useWatchSelection();
  const { data: items = [] } = useWatchlist();
  const { data: config } = useConfig();

  const item = selectedId != null ? items.find((w) => w.id === selectedId) : undefined;

  // Render null if nothing selected, item not found, or config still loading
  if (!item || !config) return null;

  return <InspectorBody item={item} config={config} />;
}
