/**
 * smoke.test.tsx — render-smoke tests for top-level views.
 *
 * Asserts each view mounts without throwing and shows a known key landmark
 * after the async TanStack Query resolves to fixture data.
 *
 * Provider strategy:
 *   - All four views call real hooks (useConfig, useHealth, useScanRuns,
 *     useDeals, useWatchlist) so every render needs QueryClientProvider.
 *   - renderWithProviders (test/utils) wraps in QueryClientProvider (fresh,
 *     retry:false) + EffectsProvider.
 *   - The api/client module is mocked so no real network is touched.
 *   - @tauri-apps/api/core invoke is mocked (transitively imported by some views).
 *
 * Async assertions use findBy* (waitFor internally) so they resolve only after
 * the query promise settles to the fixture value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Mock the entire api/client module so no real fetch ever fires.
vi.mock('../api/client', () => ({
  getConfig:    vi.fn(),
  getHealth:    vi.fn(),
  getScanRuns:  vi.fn(),
  getDeals:     vi.fn(),
  getWatchlist: vi.fn(),
  patchConfig:  vi.fn(),
  patchDeal:    vi.fn(),
  patchWatchItem:  vi.fn(),
  resetWatchField: vi.fn(),
  createWatchItem: vi.fn(),
  deleteWatchItem: vi.fn(),
  runScanNow:   vi.fn(),
  getResolveExpansions: vi.fn().mockResolvedValue([]),
  getResolveBlueprints: vi.fn().mockResolvedValue([]),
  getResolveCards:      vi.fn().mockResolvedValue([]),
  getCatalogProgress:   vi.fn().mockResolvedValue({ total: 0, synced: 0 }),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message?: string) {
      super(message ?? `API error ${status}: ${code}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  },
}));

// Stub Tauri so invoke doesn't throw in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import mocked functions AFTER vi.mock() declarations
// ---------------------------------------------------------------------------
import { getConfig, getHealth, getScanRuns, getDeals, getWatchlist } from '../api/client';
import {
  renderWithProviders,
  FIXTURE_CONFIG,
  FIXTURE_HEALTH,
  FIXTURE_SCAN_RUNS,
} from '../test/utils';

import { Settings }  from './settings/Settings';
import { Health }    from './health/Health';
import { Watchlist } from './watchlist/Watchlist';
import { Telemetry } from './telemetry/Telemetry';
import type { WatchItem } from '../api/types';

// Cast to typed vi mock functions
const mockGetConfig    = getConfig    as ReturnType<typeof vi.fn>;
const mockGetHealth    = getHealth    as ReturnType<typeof vi.fn>;
const mockGetScanRuns  = getScanRuns  as ReturnType<typeof vi.fn>;
const mockGetDeals     = getDeals     as ReturnType<typeof vi.fn>;
const mockGetWatchlist = getWatchlist as ReturnType<typeof vi.fn>;

// A minimal WatchItem list — enough for the Watchlist smoke test.
const SMOKE_WATCHLIST: WatchItem[] = [
  {
    id: 1,
    type: 'blueprint',
    cardtrader_id: 100501,
    label: 'Ragavan, Nimble Pilferer',
    game_id: 1,
    min_condition: null,
    foil_pref: null,
    allow_graded: null,
    threshold_pct: null,
    importance: null,
    telegram_enabled: null,
    telegram_min_discount_pct: null,
    telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    detection_mode: null,
    max_price_cents: null,
    card_name_norm: null,
    expansion_filter: null,
    active: 1,
    created_at: '2026-05-25 10:00:00',
    updated_at: '2026-05-25 10:00:00',
  },
];

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('View render-smoke', () => {

  it('Settings mounts and shows "Appearance" after config loads', async () => {
    mockGetConfig.mockResolvedValueOnce(FIXTURE_CONFIG);

    renderWithProviders(<Settings />);

    // Settings shows "Loading settings…" until config resolves;
    // findByText waits for the Appearance panel heading to appear.
    expect(await screen.findByText('Appearance')).toBeInTheDocument();
  });

  it('Health mounts and shows "SCANNER ONLINE" after health + scan-runs load', async () => {
    mockGetHealth.mockResolvedValueOnce(FIXTURE_HEALTH);
    mockGetScanRuns.mockResolvedValueOnce(FIXTURE_SCAN_RUNS);

    renderWithProviders(<Health />);

    // Health shows "CONNECTING…" while pending; after both queries resolve
    // it renders the banner with "SCANNER ONLINE".
    expect(await screen.findByText('SCANNER ONLINE')).toBeInTheDocument();
  });

  it('Watchlist mounts and shows a known mock item label after watchlist loads', async () => {
    mockGetWatchlist.mockResolvedValueOnce(SMOKE_WATCHLIST);
    mockGetConfig.mockResolvedValueOnce(FIXTURE_CONFIG);

    renderWithProviders(<Watchlist />);

    expect(
      await screen.findByText('Ragavan, Nimble Pilferer'),
    ).toBeInTheDocument();
  });

  it('Telemetry mounts and shows the scan section landmark', async () => {
    // Telemetry uses useDeals + useScanRuns + useHealth + useConfig.
    mockGetDeals.mockResolvedValue([]);
    mockGetScanRuns.mockResolvedValue([]);
    mockGetHealth.mockResolvedValue(FIXTURE_HEALTH);   // scan_mode: 'chunked'
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    const fixedTarget = new Date('2026-06-01T12:00:00Z').getTime();

    renderWithProviders(<Telemetry scanTarget={fixedTarget} />);

    // In chunked mode the scan block shows "scanning this cycle" instead of "next scan".
    // The "Scan now" button is always present regardless of mode.
    expect(await screen.findByRole('button', { name: /scan now/i })).toBeInTheDocument();
    // Chunked-mode label should be visible once health resolves.
    expect(await screen.findByText('scanning this cycle')).toBeInTheDocument();
  });

});
