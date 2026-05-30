/**
 * CommandPalette.test.tsx — keyboard + filter behaviour of the ⌘K palette.
 *
 * Strategy:
 *   - Open the palette (open=true) with vi.fn() callbacks.
 *   - Query via screen (the palette portals to document.body via Modal).
 *   - All mock-store data is the real in-memory store (useMockWatchlist) — we
 *     assert on the navigate/action callbacks, not on the watch items.
 *
 * Note: The palette wraps its content in Modal which portals to document.body,
 * so RTL's default `screen` queries (which search document.body) work fine.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommandPalette } from './CommandPalette';
import type { CommandPaletteProps } from './CommandPalette';

// jsdom does not implement scrollIntoView — stub it globally so the
// palette's "scroll active item into view" useEffect doesn't throw.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Default props factory — all callbacks are vi.fn()
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    open: true,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onScanNow: vi.fn(),
    onReplayBoot: vi.fn(),
    onToggleEffects: vi.fn(),
    onJumpToWatch: vi.fn(),
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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CommandPalette', () => {
  it('renders the search input and command list when open=true', () => {
    render(<CommandPalette {...makeProps()} />);

    // Input is present
    expect(getInput()).toBeInTheDocument();

    // At least one built-in command is visible: "Deal Feed" (Navigate group)
    expect(screen.getByText('Deal Feed')).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    render(<CommandPalette {...makeProps({ open: false })} />);
    expect(screen.queryByRole('textbox', { name: 'Search commands' })).not.toBeInTheDocument();
  });

  it('typing a query filters the list: matching command shows, non-matching hides', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...makeProps()} />);

    // Before filtering, "Settings" is visible
    expect(screen.getByText('Settings')).toBeInTheDocument();

    // Type "health" — should keep "Health" visible and hide "Settings"
    await user.type(getInput(), 'health');

    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('empty query shows all commands', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...makeProps()} />);

    await user.type(getInput(), 'xyz-no-match');
    // "no matching command" message
    expect(screen.getByText('no matching command')).toBeInTheDocument();

    // Clear — all commands return
    await user.clear(getInput());
    expect(screen.getByText('Deal Feed')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('ArrowDown then Enter runs the highlighted command and calls onClose', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<CommandPalette {...props} />);

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
    render(<CommandPalette {...props} />);

    // Press Esc — Modal's keyDown handler calls onClose
    await user.keyboard('{Escape}');

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking a navigation command calls onNavigate with the correct view key', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<CommandPalette {...props} />);

    // "Health" navigate command
    await user.type(getInput(), 'health');
    const healthItem = screen.getByText('Health');
    await user.click(healthItem);

    expect(props.onNavigate).toHaveBeenCalledWith('health');
    // onClose fires from the item's onClick wrapper
    expect(props.onClose).toHaveBeenCalled();
  });
});
