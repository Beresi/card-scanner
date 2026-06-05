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

import { useConfig, useDeals, useHealth, useLocalScanStatus, useRunLocalScan, useScanRuns } from './api/hooks';
import { BrandGlyph } from './components/BrandGlyph';
import { Clock } from './components/Clock';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { Status } from './components/Status';
import { ToastHost, useToasts } from './components/Toast';
import { useEffects } from './effects/EffectsContext';
import { useApplyAppearance } from './hooks/useApplyAppearance';
import { Cart } from './views/cart/Cart';
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
  { key: 'cart',      label: 'Cart',       icon: 'cart'  },
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
  cart:      ['Cart', 'your CardTrader cart'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Next scan target timestamp.
 *
 * intervalMinutes — from config.scan_interval_minutes (default 60).
 * Rounds up to the nearest whole interval boundary from the Unix epoch so the
 * countdown aligns with the configured cadence rather than drifting.
 */
function computeNextScanTarget(intervalMinutes = 60): number {
  const intervalMs = intervalMinutes * 60_000;
  return Math.ceil(Date.now() / intervalMs) * intervalMs;
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
    case 'cart':
      return <Cart />;
  }
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  // ---- Apply saved appearance (theme/palette/font/density/accent) to the DOM ----
  useApplyAppearance();

  // ---- Scan mode (for topstrip / rail-foot labels) — cached by useApplyAppearance's
  //      useConfig() call; no extra network request. ----
  const { data: health } = useHealth();
  const { data: config } = useConfig();
  const isChunked = (health?.scan_mode ?? config?.scan_mode ?? 'chunked') === 'chunked';

  // ---- View navigation ----
  const [view, setView] = useState<ViewKey>('feed');

  // ---- Boot gate ----
  // Boot plays on every launch (in-memory only — not persisted); skippable via
  // click / Enter / Esc inside BootSequence.
  const [booted, setBooted] = useState(false);

  // ---- Scan state ----
  const [scanning, setScanning]             = useState(false);
  const [nextScanTarget, setNextScanTarget] = useState<number>(computeNextScanTarget);
  // Tracks the run id returned by run_local_scan so Telemetry shows progress
  // only for the run the USER triggered (not any random cron row).
  const [activeLocalRunId, setActiveLocalRunId] = useState<number | null>(null);

  // ---- Keep the next-scan countdown aligned with the configured interval ----
  // Runs whenever config.scan_interval_minutes changes (e.g. the user just saved
  // a new value in Settings). Recomputes the target using the fresh interval so
  // the Clock leaf shows a countdown that matches the real cloud cadence.
  const scanIntervalMinutes = config?.scan_interval_minutes ?? 60;
  useEffect(() => {
    setNextScanTarget(computeNextScanTarget(scanIntervalMinutes));
  }, [scanIntervalMinutes]);

  // ---- Palette ----
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ---- Toasts ----
  const { toasts, push, dismiss } = useToasts();

  // ---- Effects flag (for palette toggle) ----
  const { enabled: fxEnabled, setEnabled: setFxEnabled } = useEffects();

  // ---- Watchlist selection (ephemeral store — drives the right rail) ----
  const { selectedId } = useWatchSelection();

  // ---- Real deals: open for the nav badge ----
  const { data: openDeals = [] } = useDeals({ status: 'open' });
  const unseenCount = openDeals.filter((d) => d.seen === 0).length;

  // ---- Local scan status — gates the Scan Now button ----
  const { data: localScanStatus } = useLocalScanStatus();
  const localScanConfigured = localScanStatus?.configured ?? false;

  // ---- Local scan mutation ----
  const runLocalScan = useRunLocalScan();

  // ---- Scan runs — watch for the user-triggered run closing ----
  // Pass activeLocalRunId so the hook polls fast only while our run is open.
  const { data: scanRuns = [] } = useScanRuns(activeLocalRunId);

  // When the tracked run closes or stalls, clear activeLocalRunId so Telemetry
  // returns to idle and useScanRuns backs off to slow polling.
  //
  // Clear conditions (mirror the staleness guard in Telemetry):
  //   a) The run's finished_at became non-null (scan completed normally).
  //   b) The run has been open for >3 min with blueprints_scanned === 0
  //      (sidecar died before doing any work — stalled).
  //   c) The run id is not found in the list yet but activeLocalRunId was set
  //      more than 3 min ago — handles the case where run_local_scan returned
  //      a runId that never appeared in scan_runs (e.g. worker restart).
  useEffect(() => {
    if (activeLocalRunId === null) return;
    const STALL_MS = 3 * 60 * 1000;
    const run = scanRuns.find((r) => r.id === activeLocalRunId);
    if (!run) return; // not in list yet — wait for the next poll
    if (run.finished_at !== null) {
      setActiveLocalRunId(null);
      return;
    }
    // Staleness guard: open + zero blueprints + running > 3 min
    if (run.blueprints_scanned === 0) {
      const normalised = /Z|[+-]\d{2}:\d{2}$/.test(run.started_at)
        ? run.started_at
        : `${run.started_at}Z`;
      const startedMs = new Date(normalised).getTime();
      if (Date.now() - startedMs > STALL_MS) {
        setActiveLocalRunId(null);
      }
    }
  }, [activeLocalRunId, scanRuns]);

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
  // startScan fires the LOCAL sidecar scan (detached). The overlay animation
  // plays while the sidecar launches; completion means "started", not "finished".
  // If the sidecar call throws (not configured, sidecar crash), we close the
  // overlay and push an error toast instead of leaving it stuck.
  const startScan = useCallback(() => {
    if (scanning) return;
    if (!localScanConfigured) return; // gate: button should already be disabled
    setScanning(true);
    runLocalScan.mutate(undefined, {
      onSuccess: (result) => {
        // Capture the run id so Telemetry tracks THIS specific run.
        // runId may be null if the sidecar hadn't emitted the started line yet
        // (rare race); in that case activeLocalRunId stays null and the block
        // won't show — acceptable graceful degradation for that edge case.
        if (result.runId !== null) {
          setActiveLocalRunId(result.runId);
        }
        // Cache invalidation (scanRuns, health) also happens inside the mutation hook.
      },
      onError: (err) => {
        // Sidecar failed to start — close overlay and surface the error.
        setScanning(false);
        push({
          title: 'Scan failed to start',
          sub: err.message,
          tone: 'hot',
          icon: 'x',
        });
      },
    });
    // The overlay timer runs independently; onScanComplete fires when it finishes.
  }, [scanning, localScanConfigured, runLocalScan, push]);

  // onScanComplete fires when the overlay animation finishes (~3.6s after startScan).
  // At that point the sidecar is still running in the background — the overlay
  // completing does NOT mean the scan is done. Show a "started" toast instead
  // of a "complete" one, and point the user to Health for progress.
  const onScanComplete = useCallback(() => {
    setScanning(false);
    setNextScanTarget(computeNextScanTarget(scanIntervalMinutes));
    setView('feed');

    push({
      title: 'Local scan started',
      sub: 'Running in the background. Progress appears in Health.',
      tone: 'accent',
      icon: 'radar',
    });
  }, [push, scanIntervalMinutes]);

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
        scanConfigured={localScanConfigured}
        activeLocalRunId={activeLocalRunId}
      />
    );
  }, [view, selectedId, scanning, nextScanTarget, startScan, localScanConfigured, activeLocalRunId]);

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
                {isChunked ? (
                  <>
                    <span className="cb-eyebrow">scanner</span>
                    <span className="cb-mono cb-text-accent">rotating</span>
                  </>
                ) : (
                  <>
                    <span className="cb-eyebrow">next scan</span>
                    <Clock target={nextScanTarget} className="cb-mono cb-text-accent" />
                  </>
                )}
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
                {isChunked ? (
                  <>
                    <span className="cb-eyebrow">scanner</span>
                    <span className="cb-mono cb-text-accent">·live·</span>
                  </>
                ) : (
                  <>
                    <span className="cb-eyebrow">next scan</span>
                    <Clock target={nextScanTarget} className="cb-mono cb-text-accent" />
                  </>
                )}
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
        scanConfigured={localScanConfigured}
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
