/**
 * App — root component.
 *
 * Owns: the 3-column shell, left-rail nav, and the active view switch.
 * Server data stays in TanStack Query; only the active view key is local state.
 * No per-second ticks or always-on effects at this level (Clock isolation rule).
 */

import { useState } from 'react';

import { Btn } from './components/Btn';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { DealFeed } from './views/deal-feed/DealFeed';
import { Placeholder } from './views/Placeholder';

// ---------------------------------------------------------------------------
// Nav definition
// ---------------------------------------------------------------------------

type ViewKey = 'feed' | 'watchlist' | 'settings' | 'health';

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

// ---------------------------------------------------------------------------
// View renderer — returns the active view component.
// ---------------------------------------------------------------------------

function ActiveView({ view }: { view: ViewKey }) {
  switch (view) {
    case 'feed':
      return <DealFeed />;
    case 'watchlist':
      return <Placeholder title="Watchlist" icon="watch" />;
    case 'settings':
      return <Placeholder title="Settings" icon="gear" />;
    case 'health':
      return <Placeholder title="Health" icon="pulse" />;
  }
}

// ---------------------------------------------------------------------------
// Nav item label for the icon-only left rail format
// ---------------------------------------------------------------------------

const VIEW_ICON: Record<ViewKey, IconName> = {
  feed:      'feed',
  watchlist: 'watch',
  settings:  'gear',
  health:    'pulse',
};

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  const [view, setView] = useState<ViewKey>('feed');

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
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
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
        </aside>

        {/* Center stage */}
        <main className="cb-stage">
          <div className="cb-stage-scroll">
            <ActiveView view={view} />
          </div>
        </main>

        {/* Right rail — telemetry placeholder */}
        <aside className="cb-rail-right" aria-label="Telemetry" />
      </div>
    </>
  );
}
