/**
 * Settings — single config row, grouped into 4 tabbed sections.
 *
 * Data layer: useConfig() (TanStack Query read) + useConfigMutation() (PATCH /api/config).
 * Each control calls cfg.mutate({ <field>: value }) immediately on change — only the
 * changed field is sent (Partial<Config>). Appearance is applied app-wide by
 * useApplyAppearance() in App.tsx; this view only reads/writes the config row.
 *
 * Booleans are 0|1 (DbBool) at the wire edge — converted at the Switch boundary only.
 * Money/percent values are integers — no floats stored or computed.
 *
 * Tabs:
 *   appearance   — Palette / Mode / Accent / Font / Density
 *   detection    — New-ticket defaults + Deal detection floors
 *   notifications — Telegram + quiet hours
 *   system       — Scan & data + Maintenance
 */

import React, { useEffect, useState } from 'react';

import { Btn }       from '../../components/Btn';
import { Icon }      from '../../components/Icon';
import { Panel }     from '../../components/Panel';
import { Segmented } from '../../components/Segmented';
import { Select }    from '../../components/Select';
import { Slider }    from '../../components/Slider';
import { Status }    from '../../components/Status';
import { Switch }    from '../../components/Switch';
import { useCatalogProgress, useConfig, useConfigMutation } from '../../api/hooks';
import { CONDITION_OPTIONS } from '../../lib/conditions';
import type {
  Condition,
  Density,
  DetectionMode,
  FontChoice,
  FoilPref,
  Importance,
  ScanMode,
  Theme,
  ThemePalette,
} from '../../api/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Curated accent presets — 12 colors spanning the palette spectrum. */
const ACCENT_PRESETS: string[] = [
  '#22d3ee', // cyan (default)
  '#5b8def', // blue
  '#818cf8', // indigo
  '#c084fc', // purple
  '#e879f9', // fuchsia
  '#f472b6', // pink
  '#f87171', // red
  '#f5a623', // amber
  '#fbbf24', // yellow
  '#34d399', // emerald
  '#2dd4bf', // teal
  '#a3e635', // lime
];

const PALETTE_OPTIONS: { value: ThemePalette; label: string }[] = [
  { value: 'cyan',      label: 'Cyan' },
  { value: 'obsidian',  label: 'Obsidian' },
  { value: 'matrix',    label: 'Matrix' },
  { value: 'synthwave', label: 'Synthwave' },
];

const FONT_OPTIONS: { value: FontChoice; label: string; hint: string }[] = [
  { value: 'chakra',   label: 'Chakra Petch', hint: 'Chakra Petch · IBM Plex Mono' },
  { value: 'orbitron', label: 'Orbitron',     hint: 'Orbitron · Space Mono' },
  { value: 'rajdhani', label: 'Rajdhani',     hint: 'Rajdhani · JetBrains Mono' },
  { value: 'system',   label: 'System',       hint: 'System UI · monospace' },
];


const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark',   label: 'Dark' },
  { value: 'light',  label: 'Light' },
  { value: 'system', label: 'System' },
];

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact',     label: 'Compact' },
];

const FOIL_OPTIONS: { value: FoilPref; label: string }[] = [
  { value: 'any',     label: 'Any' },
  { value: 'foil',    label: 'Foil' },
  { value: 'nonfoil', label: 'Nonfoil' },
];

const IMPORTANCE_OPTIONS: { value: Importance; label: string }[] = [
  { value: 'low',    label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high',   label: 'High' },
];

const SCAN_MODE_OPTIONS: { value: ScanMode; label: string }[] = [
  { value: 'chunked',  label: 'Chunked (free)' },
  { value: 'wholeset', label: 'Whole-set (paid)' },
];

const DETECTION_MODE_OPTIONS: { value: DetectionMode; label: string }[] = [
  { value: 'discount', label: 'Discount %' },
  { value: 'price',    label: 'Price ≤' },
];

const CURRENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
];

// ---------------------------------------------------------------------------
// Row helper
// ---------------------------------------------------------------------------

interface RowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Row({ label, hint, children }: RowProps) {
  return (
    <div className="set-row">
      <div className="set-row-lbl">
        <span>{label}</span>
        {hint && <span className="set-row-hint">{hint}</span>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NumInput helper — plain number input styled with cb-num
// ---------------------------------------------------------------------------

interface NumInputProps {
  value: number;
  min?: number;
  max?: number;
  /** Spinner/validation step. Pass 0.01 to allow decimal (e.g. money) entry. Default 1 (integer). */
  step?: number;
  onChange: (v: number) => void;
  width?: number;
  suffix?: string;
  'aria-label'?: string;
}

function NumInput({ value, min, max, step = 1, onChange, width = 80, suffix, 'aria-label': ariaLabel }: NumInputProps) {
  // Local text state so decimal entry ("0.49", "2.5") isn't fought by the
  // controlled numeric value (Number("0.") === 0 would otherwise strip the dot).
  const [text, setText] = useState(() => String(value));

  // Re-sync from the prop only when it genuinely diverges from what's typed
  // (e.g. an external config refetch) — leaves in-progress decimals like "0." alone.
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleChange(raw: string) {
    setText(raw);
    if (raw.trim() === '') return;       // don't commit an empty field
    const n = Number(raw);
    if (!Number.isFinite(n)) return;     // ignore partial input like "-" or "1e"
    let clamped = n;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    onChange(clamped);
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        className="cb-num"
        style={{ width }}
        value={text}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setText(String(value))}
      />
      {suffix && (
        <span className="cb-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {suffix}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// QuietHoursInput — null-aware hour picker (0-23 or null/"Off")
// ---------------------------------------------------------------------------

interface QuietHourProps {
  value: number | null;
  label: string;
  onChange: (v: number | null) => void;
}

function QuietHourInput({ value, label, onChange }: QuietHourProps) {
  // Show empty string in the input when null.
  const displayValue = value !== null ? String(value).padStart(2, '0') : '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="number"
        className="cb-num cb-mono"
        style={{ width: 52, textAlign: 'center' }}
        min={0}
        max={23}
        placeholder="Off"
        value={displayValue}
        aria-label={label}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '' || raw === null) {
            onChange(null);
          } else {
            const n = Number(raw);
            if (!isNaN(n) && n >= 0 && n <= 23) onChange(n);
          }
        }}
      />
      <span className="cb-mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>:00</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type SettingsTab = 'appearance' | 'detection' | 'notifications' | 'system';

const TAB_OPTIONS: { value: SettingsTab; label: string }[] = [
  { value: 'appearance',    label: 'Appearance' },
  { value: 'detection',     label: 'Detection' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'system',        label: 'System' },
];

// ---------------------------------------------------------------------------
// Settings root
// ---------------------------------------------------------------------------

export interface SettingsProps {
  onReplayBoot?: () => void;
  onClearDeals?: () => void;
}

export function Settings({ onReplayBoot, onClearDeals }: SettingsProps = {}) {
  const { data: config } = useConfig();
  const cfg = useConfigMutation();
  const { data: catalogProg } = useCatalogProgress();

  // Active tab — ephemeral UI state only.
  const [tab, setTab] = useState<SettingsTab>('appearance');

  // Local ephemeral state for "Send test" feedback — not server data.
  const [tested, setTested] = useState(false);

  // Guard: config not yet loaded — show a minimal loading state.
  if (!config) {
    return (
      <div className="settings" style={{ padding: 'var(--pad)', maxWidth: 800, margin: '0 auto' }}>
        <span className="cb-mono cb-text-faint">Loading settings…</span>
      </div>
    );
  }

  // TypeScript doesn't narrow `config` through inner functions declared after
  // a type-guard return. Capture the narrowed (non-undefined) value here so
  // renderTabContent can close over it without a "possibly undefined" error.
  const c = config;

  // -------------------------------------------------------------------------
  // Telegram test — shows "Sent ✓" for 2.4s then reverts.
  // -------------------------------------------------------------------------
  function handleTestTelegram() {
    setTested(true);
    setTimeout(() => setTested(false), 2400);
  }

  // -------------------------------------------------------------------------
  // Tab panel content — uses narrowed `c` (same object as config).
  // -------------------------------------------------------------------------
  function renderTabContent() {
    switch (tab) {

      // ======================================================================
      // APPEARANCE — Palette / Mode / Accent / Font / Density
      // ======================================================================
      case 'appearance':
        return (
          <Panel className="set-panel">
            <Row label="Palette" hint="applies live">
              <Segmented
                value={c.theme_palette}
                options={PALETTE_OPTIONS as { value: string; label: string }[]}
                onChange={(v) =>
                  // Palette controls surfaces/backgrounds only — accent stays an
                  // independent user choice (decoupled).
                  cfg.mutate({ theme_palette: v as ThemePalette })
                }
                size="sm"
              />
            </Row>

            <Row label="Mode" hint="dark-first build">
              <Segmented
                value={c.theme}
                options={THEME_OPTIONS as { value: string; label: string }[]}
                onChange={(v) => cfg.mutate({ theme: v as Theme })}
                size="sm"
              />
            </Row>

            <Row label="Accent color" hint="applies live">
              <div className="set-swatches">
                {ACCENT_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={['set-swatch', c.accent_color === color ? 'is-on' : undefined]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ '--sw': color } as React.CSSProperties}
                    title={color}
                    aria-label={`Accent color ${color}`}
                    aria-pressed={c.accent_color === color}
                    onClick={() => cfg.mutate({ accent_color: color })}
                  />
                ))}
              </div>
            </Row>

            <Row label="Font" hint="applies live">
              <Select
                value={c.font}
                options={FONT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(v) => cfg.mutate({ font: v as FontChoice })}
                size="sm"
              />
            </Row>

            <Row label="List density" hint="applies live">
              <Segmented
                value={c.density}
                options={DENSITY_OPTIONS as { value: string; label: string }[]}
                onChange={(v) => cfg.mutate({ density: v as Density })}
                size="sm"
              />
            </Row>
          </Panel>
        );

      // ======================================================================
      // DETECTION — New-ticket defaults + Deal detection floors
      // ======================================================================
      case 'detection':
        return (
          <>
            <Panel
              title="New-ticket defaults"
              className="set-panel"
              right={<span className="cb-eyebrow">moving baseline · §9a</span>}
            >
              <p className="set-blurb">
                Items left to "inherit" follow these values live. Changing a default retroactively
                affects every inheriting watch item — it is a moving baseline, not a snapshot (§9a).
              </p>
              <div className="set-grid">
                <Row
                  label="Min discount"
                  hint="Flag a deal when the cheapest copy is at least this % below the median of the next-cheapest copies."
                >
                  <Slider
                    value={c.default_discount_pct}
                    min={10}
                    max={90}
                    step={1}
                    suffix="%"
                    label="Minimum discount percent"
                    onChange={(v) => cfg.mutate({ default_discount_pct: v })}
                  />
                </Row>

                <Row
                  label="Min gap to next"
                  hint="Also require the cheapest copy to be this % below the 2nd-cheapest copy — the price you'd actually pay next. Kills tightly-packed ladders where a penny-cheaper copy looks like a big discount. 0 = off."
                >
                  <Slider
                    value={c.default_min_gap_pct}
                    min={0}
                    max={60}
                    step={1}
                    suffix="%"
                    label="Minimum gap to next-cheapest percent"
                    onChange={(v) => cfg.mutate({ default_min_gap_pct: v })}
                  />
                </Row>

                <Row label="Default min condition">
                  <Select
                    value={c.default_min_condition}
                    options={CONDITION_OPTIONS}
                    onChange={(v) => cfg.mutate({ default_min_condition: v as Condition })}
                    size="sm"
                  />
                </Row>

                <Row label="Cohort size" hint="next-N cheapest">
                  <NumInput
                    value={c.cohort_size}
                    min={2}
                    max={50}
                    onChange={(v) => cfg.mutate({ cohort_size: v })}
                    aria-label="Cohort size"
                  />
                </Row>

                <Row label="Min comparators" hint="thin-market floor">
                  <NumInput
                    value={c.min_cohort}
                    min={1}
                    max={20}
                    onChange={(v) => cfg.mutate({ min_cohort: v })}
                    aria-label="Minimum comparators"
                  />
                </Row>

                <Row label="New-item foil pref">
                  <Segmented
                    value={c.new_ticket_foil_pref}
                    options={FOIL_OPTIONS as { value: string; label: string }[]}
                    onChange={(v) => cfg.mutate({ new_ticket_foil_pref: v as FoilPref })}
                    size="sm"
                  />
                </Row>

                <Row label="New-item importance">
                  <Segmented
                    value={c.new_ticket_importance}
                    options={IMPORTANCE_OPTIONS as { value: string; label: string }[]}
                    onChange={(v) => cfg.mutate({ new_ticket_importance: v as Importance })}
                    size="sm"
                  />
                </Row>

                <Row label="Default detection mode" hint="discount % vs absolute price">
                  <Segmented
                    value={c.default_detection_mode}
                    options={DETECTION_MODE_OPTIONS as { value: string; label: string }[]}
                    onChange={(v) => cfg.mutate({ default_detection_mode: v as DetectionMode })}
                    size="sm"
                  />
                </Row>

                <Row
                  label="Default max price"
                  hint="price-mode cap inherited by new items · empty = no default cap"
                >
                  <NumInput
                    value={c.default_max_price_cents != null ? c.default_max_price_cents / 100 : 0}
                    min={0}
                    max={100000}
                    onChange={(v) =>
                      cfg.mutate({
                        default_max_price_cents: v > 0 ? Math.round(v * 100) : null,
                      })
                    }
                    suffix={c.currency}
                    aria-label="Default maximum price cap"
                  />
                </Row>
              </div>
            </Panel>

            <Panel title="Deal detection" className="set-panel">
              <p className="set-blurb">
                Floors stop bulk/penny cards from showing as false 50%-off &ldquo;deals&rdquo;.
              </p>

              <Row label="Currency" hint="matches your CardTrader account · no conversion">
                <Select
                  value={c.currency}
                  options={CURRENCY_OPTIONS}
                  onChange={(v) => cfg.mutate({ currency: v })}
                  size="sm"
                />
              </Row>

              <Row label="Minimum listing price" hint="ignore deals on cards cheaper than this">
                <NumInput
                  value={c.min_price_cents / 100}
                  min={0}
                  max={10000}
                  step={0.01}
                  onChange={(v) => cfg.mutate({ min_price_cents: Math.round(v * 100) })}
                  suffix={c.currency}
                  aria-label="Minimum listing price"
                />
              </Row>

              <Row label="Minimum savings" hint="ignore deals whose absolute discount is below this">
                <NumInput
                  value={c.min_savings_cents / 100}
                  min={0}
                  max={10000}
                  step={0.01}
                  onChange={(v) => cfg.mutate({ min_savings_cents: Math.round(v * 100) })}
                  suffix={c.currency}
                  aria-label="Minimum absolute savings"
                />
              </Row>
            </Panel>

            <Panel title="Catalog sync" className="set-panel">
              <p className="set-blurb">
                Syncs set blueprints into a local catalog so you can watch cards by name across all
                printings. Full sync is gradual — a few sets per scan run. Enable and let it build up
                over time.
              </p>

              <Row label="Enable catalog sync" hint="pulls blueprint lists into the local catalog">
                <Switch
                  on={c.catalog_sync_enabled === 1}
                  onChange={(v) => cfg.mutate({ catalog_sync_enabled: v ? 1 : 0 })}
                  label="Catalog sync enabled"
                  aria-label="Enable catalog sync"
                />
              </Row>

              <Row
                label="Sets per run"
                hint="blueprint exports per scan tick · keep low to stay within the 50-req budget"
              >
                <NumInput
                  value={c.catalog_max_exports_per_run}
                  min={1}
                  max={10}
                  onChange={(v) => cfg.mutate({ catalog_max_exports_per_run: Math.round(v) })}
                  suffix="sets"
                  aria-label="Catalog sets exported per scan run"
                />
              </Row>

              <Row label="Sync progress" hint="read-only">
                <span
                  className="cb-mono"
                  style={{ fontSize: 12, color: 'var(--text-dim)' }}
                  aria-live="polite"
                >
                  {catalogProg != null
                    ? `${catalogProg.synced} / ${catalogProg.total} sets synced`
                    : '—'}
                </span>
              </Row>
            </Panel>
          </>
        );

      // ======================================================================
      // NOTIFICATIONS — Telegram status + quiet hours
      // ======================================================================
      case 'notifications':
        return (
          <Panel title="Notifications" className="set-panel">
            <Row label="Telegram bot" hint="@cardbroker_bot">
              <span className="set-tg">
                <Status tone="good" label="LINKED" />
                <Btn variant="ghost" onClick={handleTestTelegram}>
                  <Icon name="send" size={13} />
                  {tested ? 'Sent ✓' : 'Send test'}
                </Btn>
              </span>
            </Row>

            <Row label="Global TG min discount" hint="stricter than app min discount">
              <Slider
                value={c.telegram_min_discount_pct}
                min={30}
                max={90}
                step={1}
                suffix="%"
                label="Telegram minimum discount percent"
                onChange={(v) => cfg.mutate({ telegram_min_discount_pct: v })}
              />
            </Row>

            <Row label="Quiet hours" hint="hold pushes during this window">
              <div className="set-quiet">
                <QuietHourInput
                  value={c.quiet_hours_start}
                  label="Quiet hours start (0-23)"
                  onChange={(v) => cfg.mutate({ quiet_hours_start: v })}
                />
                <span className="cb-text-faint" style={{ fontSize: 12 }}>→</span>
                <QuietHourInput
                  value={c.quiet_hours_end}
                  label="Quiet hours end (0-23)"
                  onChange={(v) => cfg.mutate({ quiet_hours_end: v })}
                />
                {c.timezone && (
                  <span className="set-quiet-tz">{c.timezone}</span>
                )}
                <Switch
                  on={c.digest_on_quiet_end === 1}
                  onChange={(v) => cfg.mutate({ digest_on_quiet_end: v ? 1 : 0 })}
                  label="digest"
                />
              </div>
            </Row>
          </Panel>
        );

      // ======================================================================
      // SYSTEM — Scan & data + Maintenance
      // ======================================================================
      case 'system':
        return (
          <>
            <Panel title="Scan & data" className="set-panel">
              <Row label="Schedule" hint="read-only · every 2 min tick">
                <span className="set-cron">
                  */2 * * * *
                  <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>· chunked rotation · UTC</span>
                </span>
              </Row>

              <Row
                label="Scan mode"
                hint="Chunked = free tier, rotates cards over ~hourly. Whole-set = scans full sets at once, needs paid Workers."
              >
                <Segmented
                  value={c.scan_mode}
                  options={SCAN_MODE_OPTIONS as { value: string; label: string }[]}
                  onChange={(v) => cfg.mutate({ scan_mode: v as ScanMode })}
                  size="sm"
                />
              </Row>

              <Row
                label="Batch size"
                hint="cards scanned per 2-min tick (keep ≤49 on the free tier · only applies to chunked)"
              >
                <NumInput
                  value={c.scan_batch_size}
                  min={5}
                  max={49}
                  onChange={(v) => cfg.mutate({ scan_batch_size: Math.round(v) })}
                  suffix="cards"
                  aria-label="Scan batch size"
                />
              </Row>

              <Row label="CardTrader token" hint="GET /info">
                <Status tone="good" label="VALID" />
              </Row>

              <Row label="Deal retention" hint="auto-prune older · 0 = keep forever">
                <NumInput
                  value={c.deal_retention_days}
                  min={0}
                  max={365}
                  onChange={(v) => cfg.mutate({ deal_retention_days: v })}
                  suffix="days"
                  aria-label="Deal retention in days"
                />
              </Row>
            </Panel>

            <Panel title="Maintenance" className="set-panel">
              <Row label="Replay boot sequence" hint="re-runs the startup animation">
                <Btn
                  variant="ghost"
                  onClick={() => {
                    if (onReplayBoot) onReplayBoot();
                  }}
                >
                  <Icon name="bolt" size={13} />
                  Replay on reload
                </Btn>
              </Row>

              <Row label="Clear all deals" hint="irreversible">
                <Btn
                  variant="danger"
                  onClick={() => {
                    if (onClearDeals) onClearDeals();
                  }}
                >
                  <Icon name="x" size={13} />
                  Clear feed
                </Btn>
              </Row>
            </Panel>
          </>
        );
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="settings" style={{ padding: 'var(--pad)', maxWidth: 800, margin: '0 auto' }}>

      {/* Tab bar — chamfered sci-fi tabs (set-tabs); Segmented's role="tablist"
          is correct for a11y. Sits flush on top of the content (no gap). */}
      <Segmented
        className="set-tabs"
        value={tab}
        options={TAB_OPTIONS as { value: string; label: string }[]}
        onChange={(v) => setTab(v as SettingsTab)}
      />

      {/* Active tab content — one group visible at a time, flush under the tabs. */}
      <div
        role="tabpanel"
        className="set-tabpanel"
        aria-label={TAB_OPTIONS.find((o) => o.value === tab)?.label}
      >
        {renderTabContent()}
      </div>

    </div>
  );
}
