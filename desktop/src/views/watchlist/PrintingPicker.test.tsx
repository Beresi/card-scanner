/**
 * PrintingPicker.test.tsx — inclusion↔null mapping contract for the
 * print-restriction droplist.
 *
 * Strategy: mock api/client at the same seam as all other desktop tests so
 * the real useCardPrintings + useCatalogProgress hooks run through TanStack
 * Query without hitting the network.  renderWithProviders from test/utils
 * supplies a fresh QueryClient + EffectsProvider for each test.
 *
 * Fixture: 3 sets with ids 10, 20, 30 (Set A / Set B / Set C).
 *
 * Assertions:
 *   1. value=null (all checked) → uncheck Set A (id 10) → onChange([20, 30])
 *   2. With all 3 now notionally checked again → onChange(null) (all-sets sentinel)
 *   3. value=[10] (stored subset) → trigger label reads "1 of 3 sets"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the mocked module
// ---------------------------------------------------------------------------

vi.mock('../../api/client', () => ({
  getCardPrintings:   vi.fn(),
  getCatalogProgress: vi.fn(),
  // Other exports present so hooks that import from client don't break
  getDeals:           vi.fn(),
  patchDeal:          vi.fn(),
  getWatchlist:       vi.fn(),
  getConfig:          vi.fn(),
  patchWatchItem:     vi.fn(),
  deleteWatchItem:    vi.fn(),
  getHealth:          vi.fn(),
  getScanRuns:        vi.fn(),
  patchConfig:        vi.fn(),
  resetWatchField:    vi.fn(),
  createWatchItem:    vi.fn(),
  runScanNow:         vi.fn(),
  getResolveExpansions:   vi.fn().mockResolvedValue([]),
  getResolveBlueprints:   vi.fn().mockResolvedValue([]),
  getResolveCards:        vi.fn().mockResolvedValue([]),
  getPurchases:           vi.fn().mockResolvedValue({ total_spent_cents: 0, items: [] }),
  getCart:                vi.fn().mockResolvedValue({ items: [] }),
  cartAdd:                vi.fn(),
  cartRemove:             vi.fn(),
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports AFTER vi.mock()
// ---------------------------------------------------------------------------

import { getCardPrintings, getCatalogProgress } from '../../api/client';
import { renderWithProviders } from '../../test/utils';
import { PrintingPicker } from './PrintingPicker';
import type { ResolveCardPrinting } from '../../api/types';

const mockGetCardPrintings   = getCardPrintings   as ReturnType<typeof vi.fn>;
const mockGetCatalogProgress = getCatalogProgress as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture — 3 sets; ids are integers (money/id rule: exact integers only)
// ---------------------------------------------------------------------------

const SETS: ResolveCardPrinting[] = [
  { id: 10, code: 'AAA', name: 'Set A', printings: 1 },
  { id: 20, code: 'BBB', name: 'Set B', printings: 1 },
  { id: 30, code: 'CCC', name: 'Set C', printings: 1 },
];

// Catalog progress: fully synced (no partial-sync note rendered)
const CATALOG_DONE = { total: 100, synced: 100 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardPrintings.mockResolvedValue(SETS);
  mockGetCatalogProgress.mockResolvedValue(CATALOG_DONE);
});

/** Open the dropdown panel so option rows become visible. */
async function openDropdown(user: ReturnType<typeof userEvent.setup>) {
  // The trigger button has aria-haspopup="listbox"; its text is the triggerLabel.
  // We click the first button in the component (the trigger).
  const trigger = screen.getByRole('button', { name: /sets/i });
  await user.click(trigger);
}

/** Find an option row by its set name (role="option"). */
function getOption(name: string) {
  return screen.getByRole('option', { name: new RegExp(name, 'i') });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrintingPicker — inclusion↔null mapping', () => {

  // -------------------------------------------------------------------------
  // Test 1: value=null (all checked) → uncheck one set → emits subset array
  // -------------------------------------------------------------------------
  it('uncheck one set when value=null emits the remaining subset (not null)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <PrintingPicker cardName="Lightning Bolt" value={null} onChange={onChange} />,
    );

    // Wait for the async hook to resolve (trigger shows "All sets")
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /all sets/i })).toBeInTheDocument();
    });

    await openDropdown(user);

    // All 3 option rows must be visible
    await waitFor(() => {
      expect(getOption('Set A')).toBeInTheDocument();
    });

    // Uncheck Set A (id=10) — it is currently selected (aria-selected="true")
    await user.click(getOption('Set A'));

    // onChange must be called with [20, 30] — a plain array, NOT null
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    const emitted = onChange.mock.calls[0][0] as number[] | null;
    expect(emitted).not.toBeNull();
    expect(Array.isArray(emitted)).toBe(true);
    // Order may vary — sort both sides before comparing
    expect([...(emitted as number[])].sort((a, b) => a - b)).toEqual([20, 30]);
  });

  // -------------------------------------------------------------------------
  // Test 2: all 3 sets checked → onChange emits null (all-sets sentinel)
  // -------------------------------------------------------------------------
  it('checking all 3 sets emits null (all-sets sentinel, not [10,20,30])', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    // Start with only [20, 30] selected (Set A unchecked)
    renderWithProviders(
      <PrintingPicker cardName="Lightning Bolt" value={[20, 30]} onChange={onChange} />,
    );

    // Wait for data to load — trigger should show "2 of 3 sets"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /2 of 3 sets/i })).toBeInTheDocument();
    });

    await openDropdown(user);

    await waitFor(() => {
      expect(getOption('Set A')).toBeInTheDocument();
    });

    // Check Set A (id=10) — it is currently unchecked
    await user.click(getOption('Set A'));

    // onChange must be called with null — all known sets are now selected
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  // -------------------------------------------------------------------------
  // Test 3: value=[10] → trigger label shows "1 of 3 sets" (restricted state)
  // -------------------------------------------------------------------------
  it('value=[10] renders trigger as "1 of 3 sets" (not "All sets")', async () => {
    const onChange = vi.fn();

    renderWithProviders(
      <PrintingPicker cardName="Lightning Bolt" value={[10]} onChange={onChange} />,
    );

    // Wait for async hook to resolve and the label to update
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /1 of 3 sets/i })).toBeInTheDocument();
    });

    // "All sets" must NOT appear as the trigger label
    expect(screen.queryByRole('button', { name: /^all sets$/i })).not.toBeInTheDocument();
  });

});
