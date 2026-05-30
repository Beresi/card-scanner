/**
 * WatchInspector — right-rail editor for the selected watchlist item.
 *
 * Reads both useMockWatchlist() and useMockConfig() directly from the shared
 * stores — no props needed for the data layer. App's job is simply:
 *   - render <WatchInspector /> when selectedId is non-null
 *   - render <WatchSummary /> otherwise
 *
 * §9a inherit/override: each editable field uses effOf helpers.
 * Fields with a config default are wrapped in InheritField.
 * Fields without a config default (telegram_max_price_cents, telegram_min_savings_cents)
 * are plain nullable inputs — NOT wrapped in InheritField.
 *
 * Money: telegram_max_price_cents is stored as integer cents. The input
 * edits a display string (e.g. "12.50") and converts back to cents on blur/change.
 * usd() is used only for display; the store always receives integer cents.
 */
import { useState } from 'react';

import type { Config, WatchItem } from '../../api/types';
import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { InheritField } from '../../components/InheritField';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { Slider } from '../../components/Slider';
import { Switch } from '../../components/Switch';
import { usd } from '../../lib/format';
import { useMockConfig } from '../../mock/hooks';
import { useMockWatchlist } from '../../mock/hooks';
import {
  effFoilPref,
  effImportance,
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

// ---------------------------------------------------------------------------
// Internal: the editor body (selected item guaranteed non-null here)
// ---------------------------------------------------------------------------

interface InspectorBodyProps {
  item: WatchItem;
  config: Config;
  patchItem: (id: number, patch: Partial<WatchItem>) => void;
  resetField: (id: number, field: keyof WatchItem) => void;
  removeItem: (id: number) => void;
  select: (id: number | null) => void;
}

/**
 * MaxPriceInput — controlled text input for telegram_max_price_cents.
 * Displays as a dollar-formatted string; stores integer cents on change.
 * No InheritField because there is no config default for this field.
 */
function MaxPriceInput({
  valueCents,
  onChange,
}: {
  valueCents: number | null;
  onChange: (cents: number | null) => void;
}) {
  // Local display state so the user can type freely
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
      // Revert to last known value
      setDraft(valueCents == null ? '' : (valueCents / 100).toFixed(2));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="cb-ifield-lbl">Max price</span>
        {valueCents != null && (
          <span style={{ fontFamily: 'var(--f-mono)', fontSize: 10, color: 'var(--accent)' }}>
            {usd(valueCents)}
          </span>
        )}
      </div>
      <input
        type="text"
        className="cb-input"
        value={draft}
        placeholder="no cap"
        aria-label="Maximum price cap (dollars)"
        onChange={handleChange}
        onBlur={handleBlur}
      />
    </div>
  );
}

function InspectorBody({
  item,
  config,
  patchItem,
  resetField,
  removeItem,
  select,
}: InspectorBodyProps) {
  const thrEff    = effThreshold(item, config);
  const condEff   = effMinCondition(item, config);
  const foilEff   = effFoilPref(item, config);
  const impEff    = effImportance(item, config);
  const tgEff     = effTelegramEnabled(item, config);
  const tgDiscEff = effTelegramMinDiscount(item, config);

  const effectiveThrPct = thrEff.value;
  const effectiveTgDiscPct = tgDiscEff.value;

  // Derived note for the telegram gate explanation
  function telegramNote(): string {
    if (impEff.value === 'high') {
      return 'High importance — pushes on ANY deal, bypassing the discount gate.';
    }
    if (tgEff.value) {
      return `Pushes only when discount ≥ ${effectiveTgDiscPct}% (stricter than the ${effectiveThrPct}% app threshold).`;
    }
    return 'App-only. Appears in the feed but never pings Telegram.';
  }

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
              #{item.cardtrader_id}
              {item.type === 'expansion' ? ' · expansion' : ' · blueprint'}
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

        {/* Threshold */}
        <InheritField
          label="Threshold"
          inherited={thrEff.inherited}
          defaultLabel={thrEff.defaultLabel}
          onReset={() => resetField(item.id, 'threshold_pct')}
        >
          <Slider
            label="Discount threshold"
            value={effectiveThrPct}
            min={10}
            max={90}
            step={5}
            suffix="%"
            onChange={(v) => patchItem(item.id, { threshold_pct: v })}
          />
        </InheritField>

        {/* Min condition */}
        <InheritField
          label="Min condition"
          inherited={condEff.inherited}
          defaultLabel={condEff.defaultLabel}
          onReset={() => resetField(item.id, 'min_condition')}
        >
          <Select
            value={condEff.value}
            options={CONDITION_OPTIONS}
            onChange={(v) => patchItem(item.id, { min_condition: v })}
          />
        </InheritField>

        {/* Foil preference — NOTE: foil_pref is nullable in WatchItem (override col),
            so InheritField is appropriate here. config.new_ticket_foil_pref is the default. */}
        <InheritField
          label="Foil preference"
          inherited={foilEff.inherited}
          defaultLabel={foilEff.defaultLabel}
          onReset={() => resetField(item.id, 'foil_pref')}
        >
          <Segmented
            value={foilEff.value}
            size="sm"
            options={[
              { value: 'any', label: 'Any' },
              { value: 'nonfoil', label: 'Nonfoil' },
              { value: 'foil', label: 'Foil' },
            ]}
            onChange={(v) => patchItem(item.id, { foil_pref: v as WatchItem['foil_pref'] })}
          />
        </InheritField>

        {/* Importance — nullable override col in WatchItem */}
        <InheritField
          label="Importance"
          inherited={impEff.inherited}
          defaultLabel={impEff.defaultLabel}
          onReset={() => resetField(item.id, 'importance')}
        >
          <Segmented
            value={impEff.value}
            size="sm"
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'high', label: 'High · bypass' },
            ]}
            onChange={(v) => patchItem(item.id, { importance: v as WatchItem['importance'] })}
          />
        </InheritField>

        {/* Telegram block */}
        <div className="insp-tg">
          <div className="wrow-tg-head">
            <span className="cb-eyebrow">Telegram routing</span>
            <Switch
              on={tgEff.value}
              onChange={(on) =>
                patchItem(item.id, { telegram_enabled: on ? 1 : 0 })
              }
              label="Telegram"
              aria-label="Enable Telegram for this item"
            />
          </div>

          {tgEff.value && (
            <>
              <InheritField
                label="Min discount"
                inherited={tgDiscEff.inherited}
                defaultLabel={tgDiscEff.defaultLabel}
                onReset={() => resetField(item.id, 'telegram_min_discount_pct')}
              >
                <Slider
                  label="Telegram minimum discount"
                  value={effectiveTgDiscPct}
                  min={40}
                  max={90}
                  step={5}
                  suffix="%"
                  onChange={(v) =>
                    patchItem(item.id, { telegram_min_discount_pct: v })
                  }
                />
              </InheritField>

              {/* Max price — plain nullable, no config default, no InheritField */}
              <MaxPriceInput
                valueCents={item.telegram_max_price_cents}
                onChange={(cents) =>
                  patchItem(item.id, { telegram_max_price_cents: cents })
                }
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
          onClick={() => {
            removeItem(item.id);
            select(null);
          }}
        >
          <Icon name="x" size={13} />
          Remove from watchlist
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WatchInspector — exported component reads shared store directly
// ---------------------------------------------------------------------------

export function WatchInspector() {
  const { items, selectedId, select, patchItem, resetField, removeItem } =
    useMockWatchlist();
  const { data: config } = useMockConfig();

  const item = selectedId != null ? items.find((w) => w.id === selectedId) : undefined;
  if (!item) return null;

  return (
    <InspectorBody
      item={item}
      config={config}
      patchItem={patchItem}
      resetField={resetField}
      removeItem={removeItem}
      select={select}
    />
  );
}
