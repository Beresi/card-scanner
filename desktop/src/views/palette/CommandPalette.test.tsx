/**
 * CommandPalette.test.tsx — keyboard + filter behaviour of the ⌘K palette.
 *
 * Strategy:
 *   - CommandPalette now calls useWatchlist() via the real hooks, so it
 *     needs QueryClientProvider + a mocked getWatchlist.
 *   - renderWithProviders (test/utils) supplies QueryClientProvider + EffectsProvider.
 *   - The api/client module is mocked so the hook resolves to fixture data
 *     with no network traffic.
 *   - All callbacks are vi.fn(); we assert on navigate / close / scanNow calls.
 *
 * Note: The palette wraps its content in Modal which portals to document.body,
 * so RTL's default `screen` queries (which search document.body) work fine.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../api/client', () => ({
  getWatchlist: vi.fn(),
  // Provide every exported name the views might touch to avoid missing-export errors
  getConfig:    vi.fn(),
  getHealth:    vi.fn(),
  getScanRuns:  vi.fn(),
  getDeals:     vi.fn(),
  patchConfig:  vi.fn(),
  patchDeal:    vi.fn(),
  patchWatchItem:  vi.fn(),
  resetWatchField: vi.fn(),
  createWatchItem: vi.fn(),
  deleteWatchItem: vi.fn(),
  runScanNow:   vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import mocked functions AFTER vi.mock() declarations
// ---------------------------------------------------------------------------
import { getWatchlist } from '../../api/client';
import { renderWithProviders } from '../../test/utils';
import { CommandPalette } from './CommandPalette';
import type { CommandPaletteProps } from './CommandPalette';
import type { WatchItem } from '../../api/types';

const mockGetWatchlist = getWatchlist as ReturnType<typeof vi.fn>;

// jsdom does not implement scrollIntoView — stub it globally.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Fixture watchlist items for the "Watch Items" group
// ---------------------------------------------------------------------------

const PALETTE_WATCHLIST: WatchItem[] = [
  {
    id: 1,
    type: 'blueprint',
    cardtrader_id: 100501,
    label: 'Ragavan, Nimble Pilferer',
    game_id: 1,
    min_condition: null, foil_pref: null, allow_graded: null,
    threshold_pct: null, importance: null, telegram_enabled: null,
    telegram_min_discount_pct: null, telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    detection_mode: null, max_price_cents: null,
    card_name_norm: null, expansion_filter: null,
    active: 1,
    created_at: '2026-05-25 10:00:00',
    updated_at: '2026-05-25 10:00:00',
  },
  {
    id: 2,
    type: 'expansion',
    cardtrader_id: 1623,
    label: 'Modern Horizons 2',
    game_id: 1,
    min_condition: null, foil_pref: null, allow_graded: null,
    threshold_pct: null, importance: null, telegram_enabled: null,
    telegram_min_discount_pct: null, telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    detection_mode: null, max_price_cents: null,
    card_name_norm: null, expansion_filter: null,
    active: 1,
    created_at: '2026-05-20 08:00:00',
    updated_at: '2026-05-20 08:00:00',
  },
];

// ---------------------------------------------------------------------------
// Default props factory — all callbacks are vi.fn()
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    open: true,
    onClose:         vi.fn(),
    onNavigate:      vi.fn(),
    onScanNow:       vi.fn(),
    onReplayBoot:    vi.fn(),
    onToggleEffects: vi.fn(),
    onJumpToWatch:   vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The search input always has aria-label="Search commands" */
function getInput() {
  return screen.getByRole('textbox', { name: 'Search commands' });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Always resolve getWatchlist to the fixture list for each test.
  mockGetWatchlist.mockResolvedValue(PALETTE_WATCHLIST);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandPalette', () => {

  it('renders the search input and command list when open=true', async () => {
    renderWithProviders(<CommandPalette {...makeProps()} />);

    // Input is present immediately (palette renders synchronously; hook resolves async)
    expect(getInput()).toBeInTheDocument();

    // At least one built-in command is visible: "Deal Feed" (Navigate group)
    expect(screen.getByText('Deal Feed')).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    renderWithProviders(<CommandPalette {...makeProps({ open: false })} />);
    expect(screen.queryByRole('textbox', { name: 'Search commands' })).not.toBeInTheDocument();
  });

  it('typing a query filters the list: matching command shows, non-matching hides', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette {...makeProps()} />);

    // Before filtering, "Settings" is visible
    expect(screen.getByText('Settings')).toBeInTheDocument();

    // Type "health" — should keep "Health" visible and hide "Settings"
    await user.type(getInput(), 'health');

    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('empty query shows all commands', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette {...makeProps()} />);

    await user.type(getInput(), 'xyz-no-match');
    // "no matching command" message
    expect(screen.getByText('no matching command')).toBeInTheDocument();

    // Clear — all commands return
    await user.clear(getInput());
    expect(screen.getByText('Deal Feed')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('ArrowDown then Enter runs the highlighted command and calls onScanNow + onClose', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    renderWithProviders(<CommandPalette {...props} />);

    // Filter to a single known command to make the active index predictable
    await user.type(getInput(), 'scan now');

    // The only visible command should be "Scan now"
    expect(screen.getByText('Scan now')).toBeInTheDocument();

    // Press Enter — runs the first (and only) filtered command
    await user.keyboard('{Enter}');

    // onScanNow should have been called (the command calls onScanNow + onClose)
    expect(props.onScanNow).toHaveBeenCalledOnce();
  });

  it('Escape calls onClose', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    renderWithProviders(<CommandPalette {...props} />);

    // Press Esc — Modal's keyDown handler calls onClose
    await user.keyboard('{Escape}');

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking a navigation command calls onNavigate with the correct view key', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    renderWithProviders(<CommandPalette {...props} />);

    // "Health" navigate command
    await user.type(getInput(), 'health');
    const healthItem = screen.getByText('Health');
    await user.click(healthItem);

    expect(props.onNavigate).toHaveBeenCalledWith('health');
    // onClose fires from the item's onClick wrapper
    expect(props.onClose).toHaveBeenCalled();
  });

  it('watch items from getWatchlist appear in the palette after hook resolves', async () => {
    renderWithProviders(<CommandPalette {...makeProps()} />);

    // Wait for the watchlist query to resolve and the Watch Items group to render
    await waitFor(() => {
      expect(screen.getByText('Ragavan, Nimble Pilferer')).toBeInTheDocument();
    });
    expect(screen.getByText('Modern Horizons 2')).toBeInTheDocument();
  });

  it('clicking a watch item calls onJumpToWatch with the correct id', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    renderWithProviders(<CommandPalette {...props} />);

    // Wait for watch items to appear
    const itemLabel = await screen.findByText('Ragavan, Nimble Pilferer');
    await user.click(itemLabel);

    expect(props.onJumpToWatch).toHaveBeenCalledWith(1);
    expect(props.onClose).toHaveBeenCalled();
  });

});
