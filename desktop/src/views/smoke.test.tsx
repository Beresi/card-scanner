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
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  getCart:      vi.fn(),
  cartAdd:      vi.fn(),
  cartRemove:   vi.fn(),
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
// Includes stubs for the local scan commands used by localScan.ts / hooks.ts.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'get_local_scan_status') {
      return Promise.resolve({ configured: true, hasTelegram: false });
    }
    if (cmd === 'local_scan_available') {
      return Promise.resolve(true);
    }
    if (cmd === 'run_local_scan') {
      return Promise.resolve({ started: true, runId: 1 });
    }
    return Promise.resolve(undefined);
  }),
}));

// ---------------------------------------------------------------------------
// Import mocked functions AFTER vi.mock() declarations
// ---------------------------------------------------------------------------
import { getConfig, getHealth, getScanRuns, getDeals, getWatchlist, patchConfig } from '../api/client';
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
import type { ScanRun, WatchItem } from '../api/types';

// Cast to typed vi mock functions
const mockGetConfig    = getConfig    as ReturnType<typeof vi.fn>;
const mockGetHealth    = getHealth    as ReturnType<typeof vi.fn>;
const mockGetScanRuns  = getScanRuns  as ReturnType<typeof vi.fn>;
const mockGetDeals     = getDeals     as ReturnType<typeof vi.fn>;
const mockGetWatchlist = getWatchlist as ReturnType<typeof vi.fn>;
const mockPatchConfig  = patchConfig  as ReturnType<typeof vi.fn>;

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
    min_discount_pct: null,
    min_gap_pct: null,
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

    // scanConfigured=true mirrors the invoke mock returning { configured: true }
    // so the Scan Now button is enabled and has its normal accessible name.
    renderWithProviders(<Telemetry scanTarget={fixedTarget} scanConfigured={true} />);

    // In chunked mode the scan block shows "scanning this cycle" instead of "next scan".
    // The "Scan now" button is always present regardless of mode.
    expect(await screen.findByRole('button', { name: /scan now/i })).toBeInTheDocument();
    // Chunked-mode label should be visible once health resolves.
    expect(await screen.findByText('scanning this cycle')).toBeInTheDocument();
  });

  it('Telemetry shows SCANNING block when activeLocalRunId matches the open run id', async () => {
    mockGetDeals.mockResolvedValue([]);
    // Active run: finished_at is null — scan is in progress; id=10 matches prop.
    const activeRun: ScanRun = {
      id: 10,
      started_at: '2026-06-05 08:00:00',
      finished_at: null,
      watch_items_scanned: 7,
      blueprints_scanned: 312,
      api_calls: 15,
      deals_found: 2,
      telegram_sent: 0,
      error: null,
    };
    mockGetScanRuns.mockResolvedValue([activeRun]);
    // Health has active_watch_count so the progress bar can be determinate.
    mockGetHealth.mockResolvedValue({ ...FIXTURE_HEALTH, active_watch_count: 20 });
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    const fixedTarget = new Date('2026-06-05T09:00:00Z').getTime();
    // Pass activeLocalRunId=10 matching the run above.
    renderWithProviders(
      <Telemetry scanTarget={fixedTarget} scanConfigured={true} activeLocalRunId={10} />,
    );

    // The "SCANNING" status label must appear.
    expect(await screen.findByText('SCANNING')).toBeInTheDocument();
    // Progress text: "X / Y items" — numerator clamped to [0, 20].
    expect(await screen.findByText(/7\s*\/\s*20\s*items/)).toBeInTheDocument();
    // Detail line must show blueprints count — match against element text content.
    // The detail <span> contains "312 blueprints · 2 deals · Xs".
    expect(await screen.findByText(/312.*blueprints/s)).toBeInTheDocument();
    // The Scan Now button is still present (just disabled while scanning).
    expect(screen.getByRole('button', { name: /scan/i })).toBeInTheDocument();
    // The idle "scanning this cycle" label must NOT be visible while activeRun is set.
    expect(screen.queryByText('scanning this cycle')).not.toBeInTheDocument();
  });

  it('Telemetry hides SCANNING block when open run id does NOT match activeLocalRunId (cron row)', async () => {
    mockGetDeals.mockResolvedValue([]);
    // A cron-triggered run is open (id=99), but the user never started a local scan.
    const cronRun: ScanRun = {
      id: 99,
      started_at: '2026-06-05 08:00:00',
      finished_at: null,
      watch_items_scanned: 3,
      blueprints_scanned: 50,
      api_calls: 5,
      deals_found: 0,
      telegram_sent: 0,
      error: null,
    };
    mockGetScanRuns.mockResolvedValue([cronRun]);
    mockGetHealth.mockResolvedValue({ ...FIXTURE_HEALTH, active_watch_count: 20 });
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    const fixedTarget = new Date('2026-06-05T09:00:00Z').getTime();
    // activeLocalRunId is not passed (undefined → null inside Telemetry).
    renderWithProviders(
      <Telemetry scanTarget={fixedTarget} scanConfigured={true} />,
    );

    // Must NOT show the SCANNING block — the open run is a cron row, not the user's.
    // Wait for chunked idle content to confirm render completed past the loading state.
    expect(await screen.findByText('scanning this cycle')).toBeInTheDocument();
    expect(screen.queryByText('SCANNING')).not.toBeInTheDocument();
  });

  it('Telemetry shows idle chunked content when all runs are finished', async () => {
    mockGetDeals.mockResolvedValue([]);
    // All runs have finished_at set — no active run.
    mockGetScanRuns.mockResolvedValue(FIXTURE_SCAN_RUNS); // both have finished_at
    mockGetHealth.mockResolvedValue(FIXTURE_HEALTH);
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    const fixedTarget = new Date('2026-06-05T09:00:00Z').getTime();
    renderWithProviders(<Telemetry scanTarget={fixedTarget} scanConfigured={true} />);

    // Idle chunked mode label visible — no active run.
    expect(await screen.findByText('scanning this cycle')).toBeInTheDocument();
    // "SCANNING" status must NOT appear when no run is active.
    expect(screen.queryByText('SCANNING')).not.toBeInTheDocument();
  });

  it('Telemetry clamps progress numerator: watch_items_scanned > active_watch_count shows clamped value', async () => {
    mockGetDeals.mockResolvedValue([]);
    // Overflowing scan: scanned=25 but total=23 (backend bug being fixed).
    const overflowRun: ScanRun = {
      id: 20,
      started_at: '2026-06-05 08:00:00',
      finished_at: null,
      watch_items_scanned: 25,
      blueprints_scanned: 100,
      api_calls: 10,
      deals_found: 1,
      telegram_sent: 0,
      error: null,
    };
    mockGetScanRuns.mockResolvedValue([overflowRun]);
    mockGetHealth.mockResolvedValue({ ...FIXTURE_HEALTH, active_watch_count: 23 });
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    const fixedTarget = new Date('2026-06-05T09:00:00Z').getTime();
    // activeLocalRunId=20 matches the run.
    renderWithProviders(
      <Telemetry scanTarget={fixedTarget} scanConfigured={true} activeLocalRunId={20} />,
    );

    // Numerator must be clamped to 23 (not 25), total stays 23.
    expect(await screen.findByText(/23\s*\/\s*23\s*items/)).toBeInTheDocument();
    // "25 / 23" must never appear.
    expect(screen.queryByText(/25\s*\/\s*23/)).not.toBeInTheDocument();
  });

});

// ---------------------------------------------------------------------------
// Settings — scan interval control
// ---------------------------------------------------------------------------

describe('Settings: scan interval control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // patchConfig must resolve with the updated config so useConfigMutation's
    // onSuccess invalidation doesn't throw. Return the fixture with the new value.
    mockPatchConfig.mockResolvedValue({ ...FIXTURE_CONFIG, scan_interval_minutes: 30 });
  });

  it('renders the cloud scan interval input in the System tab', async () => {
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    renderWithProviders(<Settings />);

    // Navigate to the System tab.
    // There may be multiple "System" tabs in the tree (e.g. if CommandPalette is also
    // in scope); take the first match which is the Settings tab bar.
    const systemTabs = await screen.findAllByRole('tab', { name: /system/i });
    const systemTab = systemTabs[0];
    await userEvent.click(systemTab);

    // The input should be present with the fixture value (60).
    const input = await screen.findByRole('spinbutton', { name: /cloud scan interval/i });
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('60');
  });

  it('calls patchConfig with scan_interval_minutes when a valid value is entered', async () => {
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);

    renderWithProviders(<Settings />);

    // There may be multiple "System" tabs in the tree (e.g. if CommandPalette is also
    // in scope); take the first match which is the Settings tab bar.
    const systemTabs = await screen.findAllByRole('tab', { name: /system/i });
    const systemTab = systemTabs[0];
    await userEvent.click(systemTab);

    const input = await screen.findByRole('spinbutton', { name: /cloud scan interval/i });

    // Clear and type a valid new value.
    await userEvent.clear(input);
    await userEvent.type(input, '30');

    // patchConfig should have been called with the new valid value.
    await waitFor(() => {
      expect(mockPatchConfig).toHaveBeenCalledWith(
        expect.objectContaining({ scan_interval_minutes: 30 }),
      );
    });
  });

  it('blocks out-of-range values: shows an error and does not call patchConfig', async () => {
    mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);
    mockPatchConfig.mockClear();

    renderWithProviders(<Settings />);

    // There may be multiple "System" tabs in the tree (e.g. if CommandPalette is also
    // in scope); take the first match which is the Settings tab bar.
    const systemTabs = await screen.findAllByRole('tab', { name: /system/i });
    const systemTab = systemTabs[0];
    await userEvent.click(systemTab);

    const input = await screen.findByRole('spinbutton', { name: /cloud scan interval/i });

    // Enter an out-of-range value (0 is below the minimum of 1).
    await userEvent.clear(input);
    await userEvent.type(input, '0');

    // Inline error message must appear.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // patchConfig must NOT have been called with scan_interval_minutes: 0.
    expect(mockPatchConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ scan_interval_minutes: 0 }),
    );

    // Reset and try a value above the maximum.
    await userEvent.clear(input);
    await userEvent.type(input, '1441');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockPatchConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ scan_interval_minutes: 1441 }),
    );
  });
});
