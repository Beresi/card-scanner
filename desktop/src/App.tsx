/**
 * App — root component.
 *
 * Owns:
 *   - 3-column shell, left-rail nav, active view switch
 *   - Boot gate (first-run BootSequence via localStorage 'cardbroker_booted')
 *   - Scan overlay (ScanOverlay, mock animation)
 *   - ⌘K / Ctrl+K command palette (CommandPalette)
 *   - Toasts (useToasts + ToastHost)
 *   - View-aware right rail:
 *       watchlist → WatchInspector (when selectedId set) | WatchSummary
 *       others    → Telemetry
 *
 * State is ephemeral only — server data lives in TanStack Query.
 * No per-second ticks at this level (Clock isolation rule: the only tickers
 * are Clock leaves inside Telemetry / Health).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Btn } from './components/Btn';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { ToastHost, useToasts } from './components/Toast';
import { useEffects } from './effects/EffectsContext';
import { useMockDeals } from './mock/hooks';
import { useMockWatchlist } from './mock/hooks';
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOOTED_KEY = 'cardbroker_booted';

// Nav definition
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

const VIEW_ICON: Record<ViewKey, IconName> = {
  feed:      'feed',
  watchlist: 'watch',
  settings:  'gear',
  health:    'pulse',
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
      return (
        <Settings
          onReplayBoot={onReplayBoot}
          onClearDeals={onClearDeals}
        />
      );
    case 'health':
      return <Health />;
  }
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  // ---- View navigation ----
  const [view, setView] = useState<ViewKey>('feed');

  // ---- Boot gate ----
  // Read once from localStorage; after BootSequence.onDone() it is written + set true.
  const [booted, setBooted] = useState<boolean>(
    () => localStorage.getItem(BOOTED_KEY) === '1',
  );

  // ---- Scan state ----
  const [scanning, setScanning]             = useState(false);
  const [nextScanTarget, setNextScanTarget] = useState<number>(computeNextScanTarget);

  // ---- Palette ----
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ---- Toasts ----
  const { toasts, push, dismiss } = useToasts();

  // ---- Effects flag (for palette toggle) ----
  const { enabled: fxEnabled, setEnabled: setFxEnabled } = useEffects();

  // ---- Watchlist shared store (to branch the right rail + jump-to-item) ----
  const { selectedId, select: selectWatchItem } = useMockWatchlist();

  // ---- Mock deals for scan-complete toasts ----
  const { data: allDeals } = useMockDeals({ status: 'open', priority: 'high' });

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
  }, [scanning]);

  const onScanComplete = useCallback(() => {
    setScanning(false);
    setNextScanTarget(computeNextScanTarget());
    setView('feed');

    // Push 1–2 toasts from high-priority mock deals
    const topDeals = allDeals.slice(0, 2);
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
          sub: `−${deal.discount_pct}% · ${deal.expansion_name}`,
          tone: 'hot',
          icon: 'bolt',
        });
      });
    }
  }, [allDeals, push]);

  // ---- Replay boot ----
  const onReplayBoot = useCallback(() => {
    localStorage.removeItem(BOOTED_KEY);
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
    [selectWatchItem],
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
        <BootSequence
          onDone={() => {
            localStorage.setItem(BOOTED_KEY, '1');
            setBooted(true);
          }}
        />
        {/* ToastHost stays accessible even during boot */}
        <ToastHost toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  return (
    <>
      {/* Global backdrop: 44px grid + vignette (z-index 0, pointer-events none) */}
      <div className="cb-app-bg" aria-hidden="true" />
      <div className="cb-app-vignette" aria-hidden="true" />

      {/* 3-column shell */}
      <div className="cb-shell">

        {/* Left rail — navigation */}
        <aside className="cb-rail-left" aria-label="Main navigation">
          {/* App wordmark */}
          <div
            style={{
              padding: '16px var(--pad) 12px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <p className="cb-eyebrow" style={{ marginBottom: 0, fontSize: 10 }}>
              card // broker
            </p>
          </div>

          {/* Nav entries */}
          <nav style={{ padding: '8px 0' }}>
            {NAV.map(({ key, label }) => {
              const isActive = view === key;
              return (
                <Btn
                  key={key}
                  variant="ghost"
                  onClick={() => setView(key)}
                  aria-current={isActive ? 'page' : undefined}
                  title={label}
                  className={isActive ? 'cb-nav-active' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    borderRadius: 0,
                    clipPath: 'none',
                    border: 'none',
                    borderLeft: isActive
                      ? '2px solid var(--accent)'
                      : '2px solid transparent',
                    paddingLeft: 16,
                    color: isActive ? 'var(--text)' : 'var(--text-dim)',
                    background: isActive ? 'var(--panel-2)' : 'transparent',
                    fontFamily: 'var(--f-display)',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 500,
                    letterSpacing: '0.04em',
                    marginBottom: 2,
                  }}
                >
                  <Icon name={VIEW_ICON[key]} size={15} />
                  {label}
                </Btn>
              );
            })}
          </nav>

          {/* ⌘K hint chip at the bottom of the left rail */}
          <div
            style={{
              marginTop: 'auto',
              padding: '12px var(--pad)',
              borderTop: '1px solid var(--line)',
            }}
          >
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette (⌘K)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'transparent',
                border: '1px solid var(--line)',
                color: 'var(--text-faint)',
                fontFamily: 'var(--f-mono)',
                fontSize: 10,
                padding: '5px 9px',
                cursor: 'pointer',
                width: '100%',
                letterSpacing: '0.06em',
              }}
            >
              <Icon name="search" size={11} />
              ⌘K
            </button>
          </div>
        </aside>

        {/* Center stage */}
        <main className="cb-stage">
          <div className="cb-stage-scroll">
            <ActiveView
              view={view}
              onReplayBoot={onReplayBoot}
              onClearDeals={onClearDeals}
            />
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
