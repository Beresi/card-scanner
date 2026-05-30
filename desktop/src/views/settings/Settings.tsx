/**
 * Settings — single config row, grouped into 5 panels.
 *
 * Uses useMockConfigStore() for read+write so every subscriber sees live changes.
 *
 * Live apply on mount and on change (via useEffect):
 *   Theme   → document.body.dataset.theme    (body[data-theme="light|dark|system"])
 *   Density → document.body.dataset.density  (body[data-density="compact"])
 *   Accent  → document.documentElement.style.setProperty('--accent', color)
 *             (tokens.css defines --accent on :root)
 *
 * Money / percent values are integer only — no floats ever computed or stored.
 * DbBool ↔ boolean conversion happens only at the Switch boundary.
 */

import React, { useEffect, useState } from 'react';

import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Panel } from '../../components/Panel';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { Slider } from '../../components/Slider';
import { Status } from '../../components/Status';
import { Switch } from '../../components/Switch';
import { useMockConfigStore } from '../../mock/hooks';
import type { Condition, Density, FontChoice, FoilPref, Importance, Theme, ThemePalette } from '../../api/types';

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

const CONDITION_OPTIONS: { value: string; label: string }[] = [
  { value: 'NM', label: 'NM — Near Mint' },
  { value: 'LP', label: 'LP — Lightly Played' },
  { value: 'MP', label: 'MP — Moderately Played' },
  { value: 'HP', label: 'HP — Heavily Played' },
  { value: 'D',  label: 'D — Damaged' },
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
  onChange: (v: number) => void;
  width?: number;
  suffix?: string;
  'aria-label'?: string;
}

function NumInput({ value, min, max, onChange, width = 80, suffix, 'aria-label': ariaLabel }: NumInputProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        className="cb-num"
        style={{ width }}
        value={value}
        min={min}
        max={max}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
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
// Settings root
// ---------------------------------------------------------------------------

export interface SettingsProps {
  onReplayBoot?: () => void;
  onClearDeals?: () => void;
}

export function Settings({ onReplayBoot, onClearDeals }: SettingsProps = {}) {
  const [config, patchConfig] = useMockConfigStore();

  // Local ephemeral state for "Send test" feedback — not server data.
  const [tested, setTested] = useState(false);

  // -------------------------------------------------------------------------
  // Live apply: all appearance attrs/vars → DOM.
  // Runs on mount and whenever any appearance field changes.
  //
  // DOM contract (tokens.css and its parallel agent consume these exactly):
  //   body[data-palette]   = ThemePalette   ('cyan' | 'obsidian' | 'matrix' | 'synthwave')
  //   body[data-theme]     = resolved mode  ('dark' | 'light') — NEVER 'system'
  //   body[data-font]      = FontChoice     ('chakra' | 'orbitron' | 'rajdhani' | 'system')
  //   body[data-density]   = Density        ('comfortable' | 'compact')
  //   :root { --accent }   = accent_color   (CSS hex color string)
  //
  // 'system' mode is resolved here via matchMedia; OS changes re-apply live
  // via a change listener that is cleaned up on unmount.
  // -------------------------------------------------------------------------
  useEffect(() => {
    function applyTheme() {
      const mode: 'dark' | 'light' =
        config.theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : config.theme;
      document.body.dataset.palette = config.theme_palette;
      document.body.dataset.theme   = mode;
      document.body.dataset.font    = config.font;
      document.body.dataset.density = config.density;
      document.documentElement.style.setProperty('--accent', config.accent_color);
    }

    applyTheme();

    // Re-apply when the OS dark/light preference changes (only relevant when
    // config.theme === 'system'; safe to subscribe always — no-op otherwise).
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', applyTheme);
    return () => {
      mq.removeEventListener('change', applyTheme);
    };
  }, [config.theme_palette, config.theme, config.font, config.density, config.accent_color]);

  // -------------------------------------------------------------------------
  // Telegram test mock — shows "Sent ✓" for 2.4s then reverts.
  // -------------------------------------------------------------------------
  function handleTestTelegram() {
    setTested(true);
    setTimeout(() => setTested(false), 2400);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="settings" style={{ padding: 'var(--pad)', maxWidth: 800, margin: '0 auto' }}>

      {/* ================================================================ */}
      {/* 1. APPEARANCE                                                    */}
      {/* ================================================================ */}
      <Panel title="Appearance" className="set-panel">
        <Row label="Palette" hint="applies live">
          <Segmented
            value={config.theme_palette}
            options={PALETTE_OPTIONS as { value: string; label: string }[]}
            onChange={(v) =>
              // Palette controls surfaces/backgrounds only — accent stays an
              // independent user choice (decoupled).
              patchConfig({ theme_palette: v as ThemePalette })
            }
            size="sm"
          />
        </Row>

        <Row label="Mode" hint="dark-first build">
          <Segmented
            value={config.theme}
            options={THEME_OPTIONS as { value: string; label: string }[]}
            onChange={(v) => patchConfig({ theme: v as Theme })}
            size="sm"
          />
        </Row>

        <Row label="Accent color" hint="applies live">
          <div className="set-swatches">
            {ACCENT_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={['set-swatch', config.accent_color === color ? 'is-on' : undefined]
                  .filter(Boolean)
                  .join(' ')}
                style={{ '--sw': color } as React.CSSProperties}
                title={color}
                aria-label={`Accent color ${color}`}
                aria-pressed={config.accent_color === color}
                onClick={() => patchConfig({ accent_color: color })}
              />
            ))}
          </div>
        </Row>

        <Row label="Font" hint="applies live">
          <Select
            value={config.font}
            options={FONT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => patchConfig({ font: v as FontChoice })}
            size="sm"
          />
        </Row>

        <Row label="List density" hint="applies live">
          <Segmented
            value={config.density}
            options={DENSITY_OPTIONS as { value: string; label: string }[]}
            onChange={(v) => patchConfig({ density: v as Density })}
            size="sm"
          />
        </Row>
      </Panel>

      {/* ================================================================ */}
      {/* 2. NEW-TICKET DEFAULTS                                           */}
      {/* ================================================================ */}
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
          <Row label="Default threshold" hint="deal trigger">
            <Slider
              value={config.default_threshold_pct}
              min={10}
              max={90}
              step={1}
              suffix="%"
              label="Default threshold percent"
              onChange={(v) => patchConfig({ default_threshold_pct: v })}
            />
          </Row>

          <Row label="Default min condition">
            <Select
              value={config.default_min_condition}
              options={CONDITION_OPTIONS}
              onChange={(v) => patchConfig({ default_min_condition: v as Condition })}
              size="sm"
            />
          </Row>

          <Row label="Cohort size" hint="next-N cheapest">
            <NumInput
              value={config.cohort_size}
              min={2}
              max={50}
              onChange={(v) => patchConfig({ cohort_size: v })}
              aria-label="Cohort size"
            />
          </Row>

          <Row label="Min comparators" hint="thin-market floor">
            <NumInput
              value={config.min_cohort}
              min={1}
              max={20}
              onChange={(v) => patchConfig({ min_cohort: v })}
              aria-label="Minimum comparators"
            />
          </Row>

          <Row label="New-item foil pref">
            <Segmented
              value={config.new_ticket_foil_pref}
              options={FOIL_OPTIONS as { value: string; label: string }[]}
              onChange={(v) => patchConfig({ new_ticket_foil_pref: v as FoilPref })}
              size="sm"
            />
          </Row>

          <Row label="New-item importance">
            <Segmented
              value={config.new_ticket_importance}
              options={IMPORTANCE_OPTIONS as { value: string; label: string }[]}
              onChange={(v) => patchConfig({ new_ticket_importance: v as Importance })}
              size="sm"
            />
          </Row>
        </div>
      </Panel>

      {/* ================================================================ */}
      {/* 3. NOTIFICATIONS                                                 */}
      {/* ================================================================ */}
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

        <Row label="Global TG min discount" hint="stricter than app threshold">
          <Slider
            value={config.telegram_min_discount_pct}
            min={30}
            max={90}
            step={1}
            suffix="%"
            label="Telegram minimum discount percent"
            onChange={(v) => patchConfig({ telegram_min_discount_pct: v })}
          />
        </Row>

        <Row label="Quiet hours" hint="hold pushes during this window">
          <div className="set-quiet">
            <QuietHourInput
              value={config.quiet_hours_start}
              label="Quiet hours start (0-23)"
              onChange={(v) => patchConfig({ quiet_hours_start: v })}
            />
            <span className="cb-text-faint" style={{ fontSize: 12 }}>→</span>
            <QuietHourInput
              value={config.quiet_hours_end}
              label="Quiet hours end (0-23)"
              onChange={(v) => patchConfig({ quiet_hours_end: v })}
            />
            {config.timezone && (
              <span className="set-quiet-tz">{config.timezone}</span>
            )}
            <Switch
              on={config.digest_on_quiet_end === 1}
              onChange={(v) => patchConfig({ digest_on_quiet_end: v ? 1 : 0 })}
              label="digest"
            />
          </div>
        </Row>
      </Panel>

      {/* ================================================================ */}
      {/* 4. SCAN & DATA                                                   */}
      {/* ================================================================ */}
      <Panel title="Scan & data" className="set-panel">
        <Row label="Schedule" hint="read-only in v1">
          <span className="set-cron">
            0 * * * *
            <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>· hourly · UTC</span>
          </span>
        </Row>

        <Row label="Account currency" hint="per-deal; no conversion in v1">
          {/* Config has no currency field — currency lives per-deal row. Display placeholder. */}
          <span className="cb-mono" style={{ color: 'var(--text-dim)' }}>—</span>
        </Row>

        <Row label="CardTrader token" hint="GET /info">
          <Status tone="good" label="VALID" />
        </Row>

        <Row label="Deal retention" hint="auto-prune older · 0 = keep forever">
          <NumInput
            value={config.deal_retention_days}
            min={0}
            max={365}
            onChange={(v) => patchConfig({ deal_retention_days: v })}
            suffix="days"
            aria-label="Deal retention in days"
          />
        </Row>
      </Panel>

      {/* ================================================================ */}
      {/* 5. MAINTENANCE                                                   */}
      {/* ================================================================ */}
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

    </div>
  );
}
