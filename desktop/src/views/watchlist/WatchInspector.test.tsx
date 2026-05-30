/**
 * WatchInspector.test.tsx — §9a inherit/override contract for the watchlist inspector.
 *
 * WatchInspector now reads from real TanStack Query hooks:
 *   useWatchSelection() — module-level ephemeral store (real, no mock needed)
 *   useWatchlist()      — calls getWatchlist from api/client (mocked)
 *   useConfig()         — calls getConfig from api/client (mocked)
 *   usePatchWatchItem() — calls patchWatchItem from api/client (mocked)
 *   useDeleteWatchItem()— calls deleteWatchItem from api/client (mocked)
 *
 * The selection store (selection.ts) is module-level mutable state wired with
 * useSyncExternalStore — it is NOT reset between tests automatically. We call
 * select(null) in afterEach to prevent cross-test bleed.
 *
 * §9a contract under test:
 *   INHERITING item (id=101): threshold_pct=null → "inherit · 50%" + no reset button
 *   OVERRIDING item  (id=102): threshold_pct=55 → reset button present, no inherit text
 */

import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../api/client', () => ({
  getWatchlist:    vi.fn(),
  getConfig:       vi.fn(),
  patchWatchItem:  vi.fn(),
  deleteWatchItem: vi.fn(),
  // Provide other exports so the module resolves cleanly
  getDeals:        vi.fn(),
  getHealth:       vi.fn(),
  getScanRuns:     vi.fn(),
  patchConfig:     vi.fn(),
  patchDeal:       vi.fn(),
  resetWatchField: vi.fn(),
  createWatchItem: vi.fn(),
  runScanNow:      vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import mocked functions AFTER vi.mock()
// ---------------------------------------------------------------------------
import { getWatchlist, getConfig, patchWatchItem } from '../../api/client';
import {
  renderWithProviders,
  FIXTURE_CONFIG,
  FIXTURE_WATCH_INHERITING,
  FIXTURE_WATCH_OVERRIDING,
} from '../../test/utils';
import { WatchInspector } from './WatchInspector';
import { select } from './selection';

const mockGetWatchlist   = getWatchlist   as ReturnType<typeof vi.fn>;
const mockGetConfig      = getConfig      as ReturnType<typeof vi.fn>;
const mockPatchWatchItem = patchWatchItem as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Cleanup — reset selection store and mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: both items available; patchWatchItem returns the patched item
  mockGetWatchlist.mockResolvedValue([FIXTURE_WATCH_INHERITING, FIXTURE_WATCH_OVERRIDING]);
  mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);
  // patchWatchItem resolves with null-patched version (threshold_pct nulled)
  mockPatchWatchItem.mockResolvedValue({ ...FIXTURE_WATCH_OVERRIDING, threshold_pct: null });
});

afterEach(() => {
  // Reset selection store so tests don't bleed into each other
  act(() => {
    select(null);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatchInspector — §9a inherit / override', () => {

  it('renders nothing when no item is selected', async () => {
    // Ensure deselected
    act(() => { select(null); });

    const { container } = renderWithProviders(<WatchInspector />);

    // No item selected + no hooks resolved yet → renders null
    expect(container.firstChild).toBeNull();
  });

  it('shows "inherit · 50%" for threshold when item.threshold_pct is null (id=101)', async () => {
    renderWithProviders(<WatchInspector />);

    // Select the inheriting item after render
    act(() => { select(FIXTURE_WATCH_INHERITING.id); });

    // Wait for hooks to resolve and inspector to display
    await waitFor(() => {
      expect(screen.getByText(/inherit · 50%/)).toBeInTheDocument();
    });

    // No reset button for the Threshold field when inheriting
    expect(
      screen.queryByRole('button', { name: /Reset Threshold to default/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the reset button for threshold when item.threshold_pct is set (id=102)', async () => {
    renderWithProviders(<WatchInspector />);

    act(() => { select(FIXTURE_WATCH_OVERRIDING.id); });

    // The reset button appears when the field is overriding
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reset Threshold to default/i }),
      ).toBeInTheDocument();
    });

    // No inherit indicator for the Threshold field when overriding
    expect(screen.queryByText(/inherit · 50%/)).not.toBeInTheDocument();
  });

  it('clicking the reset button calls patchWatchItem with threshold_pct: null', async () => {
    const user = userEvent.setup();

    renderWithProviders(<WatchInspector />);

    act(() => { select(FIXTURE_WATCH_OVERRIDING.id); });

    const resetBtn = await screen.findByRole('button', {
      name: /Reset Threshold to default/i,
    });
    await user.click(resetBtn);

    // The mutation should have been invoked with {id, patch: {threshold_pct: null}}
    await waitFor(() => {
      expect(mockPatchWatchItem).toHaveBeenCalledWith(
        FIXTURE_WATCH_OVERRIDING.id,
        { threshold_pct: null },
      );
    });
  });

  it('shows "inherit · NM" for min_condition when item.min_condition is null (id=102)', async () => {
    renderWithProviders(<WatchInspector />);

    // OVERRIDING item has min_condition=null → should inherit NM from config
    act(() => { select(FIXTURE_WATCH_OVERRIDING.id); });

    await waitFor(() => {
      // config.default_min_condition = 'NM'
      expect(screen.getByText(/inherit · NM/)).toBeInTheDocument();
    });
  });

  it('shows the reset button for min_condition when it is overridden (id=101)', async () => {
    renderWithProviders(<WatchInspector />);

    // INHERITING item has min_condition='NM' (explicit override)
    act(() => { select(FIXTURE_WATCH_INHERITING.id); });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reset Min condition to default/i }),
      ).toBeInTheDocument();
    });
  });

});
