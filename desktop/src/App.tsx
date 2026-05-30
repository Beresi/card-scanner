/**
 * App — root component.
 *
 * Owns:
 *   - 3-column shell: left rail (brand + nav + system foot), center stage
 *     (per-view topstrip header + scrolling content), view-aware right rail
 *   - Boot gate (first-run BootSequence via localStorage 'cardbroker_booted')
 *   - Scan overlay (ScanOverlay, fires real POST /api/scan/run-now)
 *   - ⌘K / Ctrl+K command palette (CommandPalette)
 *   - Toasts (useToasts + ToastHost)
 *   - View-aware right rail:
 *       watchlist → WatchInspector (when selectedId set) | WatchSummary
 *       others    → Telemetry
 *   - Appearance: useApplyAppearance() applies saved theme/palette/font/density/accent
 *     to the DOM on mount and whenever config changes.
 *
 * State is ephemeral only — server data lives in TanStack Query.
 * No per-second ticks at this level (Clock isolation rule: the only tickers
 * are Clock leaves inside the topstrip / rail-foot / Telemetry / Health).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useDeals, useRunScan } from './api/hooks';
import { BrandGlyph } from './components/BrandGlyph';
import { Clock } from './components/Clock';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { Status } from './components/Status';
import { ToastHost, useToasts } from './components/Toast';
import { useEffects } from './effects/EffectsContext';
import { useApplyAppearance } from './hooks/useApplyAppearance';
import { DealFeed } from './views/deal-feed/DealFeed';
import { Health } from './views/health/Health';
import { CommandPalette } from './views/palette/CommandPalette';
import { ScanOverlay } from './views/scan/ScanOverlay';
import { BootSequence } from './views/boot/BootSequence';
import { Settings } from './views/settings/Settings';
import type { ViewKey } from './views/types';
import { Telemetry } from './views/telemetry/Telemetry';
import { WatchInspector } from './views/watchlist/WatchInspector';
import { WatchSummary } from './views/watchlist/WatchSummary';
import { Watchlist } from './views/watchlist/Watchlist';
import { useWatchSelection, select as selectWatchItem } from './views/watchlist/selection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface NavEntry {
  key: ViewKey;
  label: string;
  icon: IconName;
}

const NAV: NavEntry[] = [
  { key: 'feed',      label: 'Deal Feed',  icon: 'feed'  },
  { key: 'watchlist', label: 'Watchlist',  icon: 'watch' },
  { key: 'settings',  label: 'Settings',   icon: 'gear'  },
  { key: 'health',    label: 'Health',     icon: 'pulse' },
];

/** Per-view topstrip header + sub-header (eyebrow). */
const TITLES: Record<ViewKey, [string, string]> = {
  feed:      ['Deal Feed', 'underpriced-copy hunter · live'],
  watchlist: ['Watchlist', 'cards & sets under surveillance'],
  settings:  ['Settings', 'one config · the single source of truth'],
  health:    ['Health', 'scanner observability'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Next hourly cron tick at the top of the next whole hour from now. */
function computeNextScanTarget(): number {
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
}

// ---------------------------------------------------------------------------
// ActiveView
// ---------------------------------------------------------------------------

interface ActiveViewProps {
  view: ViewKey;
  onReplayBoot: () => void;
  onClearDeals: () => void;
}

function ActiveView({ view, onReplayBoot, onClearDeals }: ActiveViewProps) {
  switch (view) {
    case 'feed':
      return <DealFeed />;
    case 'watchlist':
      return <Watchlist />;
    case 'settings':
      return <Settings onReplayBoot={onReplayBoot} onClearDeals={onClearDeals} />;
    case 'health':
      return <Health />;
  }
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  // ---- Apply saved appearance (theme/palette/font/density/accent) to the DOM ----
  useApplyAppearance();

  // ---- View navigation ----
  const [view, setView] = useState<ViewKey>('feed');

  // ---- Boot gate ----
  // Boot plays on every launch (in-memory only — not persisted); skippable via
  // click / Enter / Esc inside BootSequence.
  const [booted, setBooted] = useState(false);

  // ---- Scan state ----
  const [scanning, setScanning]             = useState(false);
  const [nextScanTarget, setNextScanTarget] = useState<number>(computeNextScanTarget);

  // ---- Palette ----
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ---- Toasts ----
  const { toasts, push, dismiss } = useToasts();

  // ---- Effects flag (for palette toggle) ----
  const { enabled: fxEnabled, setEnabled: setFxEnabled } = useEffects();

  // ---- Watchlist selection (ephemeral store — drives the right rail) ----
  const { selectedId } = useWatchSelection();

  // ---- Real deals: high-priority for scan-complete toasts; open for the nav badge ----
  const { data: priorityDeals = [] } = useDeals({ status: 'open', priority: 'high' });
  const { data: openDeals = [] }     = useDeals({ status: 'open' });
  const unseenCount = openDeals.filter((d) => d.seen === 0).length;

  // ---- Scan-now mutation ----
  const runScan = useRunScan();

  // ---- Global ⌘K / Ctrl+K hotkey ----
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- Scan flow ----
  const startScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    // Fire the real run-now mutation; cache invalidation happens in onSuccess.
    // The animation overlay runs ~3.6s regardless; the refetch lands when it lands.
    runScan.mutate();
  }, [scanning, runScan]);

  const onScanComplete = useCallback(() => {
    setScanning(false);
    setNextScanTarget(computeNextScanTarget());
    setView('feed');

    // Push 1–2 toasts from high-priority open deals (refetched by mutation onSuccess)
    const topDeals = priorityDeals.slice(0, 2);
    if (topDeals.length === 0) {
      push({
        title: 'Scan complete',
        sub: 'No new high-priority deals.',
        tone: 'accent',
        icon: 'radar',
      });
    } else {
      topDeals.forEach((deal) => {
        push({
          title: `PRIORITY · ${deal.card_name}`,
          sub: `−${deal.discount_pct}% · ${deal.expansion_name ?? ''}`,
          tone: 'hot',
          icon: 'bolt',
        });
      });
    }
  }, [priorityDeals, push]);

  // ---- Replay boot ----
  const onReplayBoot = useCallback(() => {
    setBooted(false);
  }, []);

  // ---- Clear deals toast ----
  const onClearDeals = useCallback(() => {
    push({ title: 'Feed cleared', sub: 'All deals removed.', tone: 'accent', icon: 'x' });
  }, [push]);

  // ---- Toggle effects ----
  const onToggleEffects = useCallback(() => {
    setFxEnabled(!fxEnabled);
    push({
      title: fxEnabled ? 'Motion effects off' : 'Motion effects on',
      tone: 'accent',
    });
  }, [fxEnabled, setFxEnabled, push]);

  // ---- Jump to watch item ----
  const onJumpToWatch = useCallback(
    (id: number) => {
      selectWatchItem(id);
      setView('watchlist');
    },
    [],
  );

  // ---- Right rail content ----
  const rightRail = useMemo(() => {
    if (view === 'watchlist') {
      return selectedId != null ? <WatchInspector /> : <WatchSummary />;
    }
    return (
      <Telemetry
        onScanNow={startScan}
        scanning={scanning}
        scanTarget={nextScanTarget}
      />
    );
  }, [view, selectedId, scanning, nextScanTarget, startScan]);

  // ---- Boot gate: render BootSequence instead of shell ----
  if (!booted) {
    return (
      <>
        <BootSequence onDone={() => setBooted(true)} />
        {/* ToastHost stays accessible even during boot */}
        <ToastHost toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  const [title, subtitle] = TITLES[view];

  return (
    <>
      {/* Global backdrop: grid + vignette (z-index 0, pointer-events none) */}
      <div className="cb-app-bg" aria-hidden="true" />
      <div className="cb-app-vignette" aria-hidden="true" />

      {/* 3-column shell */}
      <div className="cb-shell">

        {/* Left rail — brand + navigation + system foot */}
        <aside className="cb-rail-left" aria-label="Main navigation">
          {/* Brand mark */}
          <div className="rail-brand">
            <BrandGlyph size={22} glow={12} className="rail-glyph" />
            <span className="rail-brand-text">
              <b>CARD</b><span className="rail-slash">//</span>BROKER
            </span>
          </div>

          {/* Nav entries */}
          <nav className="rail-nav">
            {NAV.map((entry) => {
              const isActive = view === entry.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={isActive ? 'rail-item is-on' : 'rail-item'}
                  onClick={() => setView(entry.key)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon name={entry.icon} size={18} />
                  <span>{entry.label}</span>
                  {entry.key === 'feed' && unseenCount > 0 && (
                    <span className="rail-badge cb-mono">{unseenCount}</span>
                  )}
                  {isActive && <span className="rail-active-bar" aria-hidden="true" />}
                </button>
              );
            })}
          </nav>

          {/* System status foot */}
          <div className="rail-foot">
            <div className="rail-sys">
              <div className="rail-sys-row">
                <Status tone="good" label="SCANNER ONLINE" />
              </div>
              <div className="rail-sys-row">
                <span className="cb-eyebrow">next scan</span>
                <Clock target={nextScanTarget} className="cb-mono cb-text-accent" />
              </div>
              <div className="rail-sys-row">
                <span className="cb-eyebrow">currency</span>
                <span className="cb-mono">USD</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Center stage — topstrip header + scrolling content */}
        <main className="cb-stage">
          <header className="topstrip">
            <div className="topstrip-title">
              <h1>{title}</h1>
              <span className="cb-eyebrow">{subtitle}</span>
            </div>
            <div className="topstrip-right">
              <button
                type="button"
                className="cmdk-chip"
                onClick={() => setPaletteOpen(true)}
                title="Command palette (⌘K)"
                aria-label="Open command palette"
              >
                <Icon name="search" size={13} />
                <span className="cb-mono">⌘K</span>
              </button>
              <span className="topstrip-div" aria-hidden="true" />
              <div className="topstrip-clock">
                <span className="cb-eyebrow">next scan</span>
                <Clock target={nextScanTarget} className="cb-mono cb-text-accent" />
              </div>
              <span className="topstrip-div" aria-hidden="true" />
              <Status tone="good" label="API 200" />
            </div>
          </header>

          <div className="cb-stage-scroll">
            <div className="stage-inner">
              <ActiveView
                view={view}
                onReplayBoot={onReplayBoot}
                onClearDeals={onClearDeals}
              />
            </div>
          </div>
        </main>

        {/* Right rail — view-aware */}
        <aside className="cb-rail-right" aria-label="Telemetry and details">
          {rightRail}
        </aside>
      </div>

      {/* ---- Overlays (mount order: scan > palette, both above shell) ---- */}

      {/* Scan overlay — z-index 80, above palette (70) */}
      <ScanOverlay open={scanning} onComplete={onScanComplete} />

      {/* Command palette — z-index 70 */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(v) => {
          setView(v);
          setPaletteOpen(false);
        }}
        onScanNow={() => {
          setPaletteOpen(false);
          startScan();
        }}
        onReplayBoot={() => {
          onReplayBoot();
          setPaletteOpen(false);
        }}
        onToggleEffects={() => {
          onToggleEffects();
          setPaletteOpen(false);
        }}
        onJumpToWatch={(id) => {
          onJumpToWatch(id);
          setPaletteOpen(false);
        }}
      />

      {/* Toasts — z-index 60 */}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
