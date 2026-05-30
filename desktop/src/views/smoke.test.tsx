/**
 * smoke.test.tsx — render-smoke tests for top-level views.
 *
 * Asserts each view mounts without throwing and shows a known key landmark.
 * Catches runtime crashes (missing context, bad hook calls) that tsc misses.
 *
 * DealFeed already has its own test suite; the remaining four views are covered here.
 *
 * Provider strategy:
 *   - Health, Watchlist, Settings, Telemetry all use mock hooks (no TanStack Query)
 *     so no QueryClientProvider is needed.
 *   - EffectsProvider is needed only if a view calls useEffects(); Settings
 *     and Health do NOT import useEffects() directly, but we wrap all views for
 *     safety — it is cheap and harmless.
 *   - Tauri invoke is mocked for any view that may transitively import it.
 *
 * Telemetry requires a `scanTarget` prop (epoch ms of the next scan).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub Tauri so invoke doesn't throw in jsdom
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { EffectsProvider } from '../effects/EffectsContext';
import { Settings }   from './settings/Settings';
import { Health }     from './health/Health';
import { Watchlist }  from './watchlist/Watchlist';
import { Telemetry }  from './telemetry/Telemetry';

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function Wrap({ children }: { children: React.ReactNode }) {
  return <EffectsProvider>{children}</EffectsProvider>;
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('View render-smoke', () => {

  it('Settings mounts and shows "Appearance"', () => {
    render(
      <Wrap>
        <Settings />
      </Wrap>,
    );
    // The Appearance panel heading is always present
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('Health mounts and shows "SCANNER ONLINE"', () => {
    render(
      <Wrap>
        <Health />
      </Wrap>,
    );
    expect(screen.getByText('SCANNER ONLINE')).toBeInTheDocument();
  });

  it('Watchlist mounts and shows a known mock item label', () => {
    render(
      <Wrap>
        <Watchlist />
      </Wrap>,
    );
    // "Ragavan, Nimble Pilferer" is always in MOCK_WATCHLIST (id=1)
    expect(screen.getByText('Ragavan, Nimble Pilferer')).toBeInTheDocument();
  });

  it('Telemetry mounts and shows "next scan"', () => {
    // Fixed epoch so Clock doesn't rely on real Date.now() for the label
    const fixedTarget = new Date('2026-06-01T12:00:00Z').getTime();

    render(
      <Wrap>
        <Telemetry scanTarget={fixedTarget} />
      </Wrap>,
    );
    // The eyebrow label "next scan" is always rendered in the SCAN section
    // Note: there may be multiple; findAllByText is safe but getByText is fine
    // if there's exactly one; use getAllByText to be safe.
    const labels = screen.getAllByText('next scan');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

});
