/**
 * DealFeed.test.tsx — RTL + Vitest tests for the Deal Feed view.
 *
 * Strategy: mock the client module (getDeals / patchDeal) so the real
 * hooks → TanStack Query → view wiring is exercised without any network.
 * Also mock @tauri-apps/api/core so invoke('open_buy_url') doesn't throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DealFeed } from './DealFeed';
import type { Deal } from '../../api/types';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports are evaluated
// ---------------------------------------------------------------------------

// Mock the client module so no real fetch happens.
vi.mock('../../api/client', () => ({
  getDeals: vi.fn(),
  patchDeal: vi.fn(),
  cartAdd: vi.fn(),
  cartRemove: vi.fn(),
  // ApiError is used by the view for instanceof checks — keep the real class.
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

// Mock Tauri invoke so Buy doesn't throw in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import mocked functions AFTER vi.mock() declarations
// ---------------------------------------------------------------------------
import { getDeals, patchDeal } from '../../api/client';

const mockGetDeals = getDeals as ReturnType<typeof vi.fn>;
const mockPatchDeal = patchDeal as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture helpers — all money is integer cents; booleans are 0|1 per DbBool
// ---------------------------------------------------------------------------

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 1,
    watchlist_id: 10,
    blueprint_id: 100,
    product_id: 1001,
    card_name: 'Lightning Bolt',
    expansion_name: 'Alpha',
    seller_username: 'seller1',
    seller_country: 'US',
    condition: 'Near Mint',
    language: 'en',
    foil: 0,
    can_sell_via_hub: 1,
    quantity: 4,
    // price_cents=1234 → usd() → "$12.34"
    price_cents: 1234,
    currency: 'USD',
    baseline_cents: 2500,
    cohort_size: 10,
    discount_pct: 51,
    priority: 'normal',
    buy_url: 'https://www.cardtrader.com/cards/100',
    found_at: '2024-01-01 10:00:00',
    seen: 0,
    dismissed: 0,
    telegram_sent: 0,
    telegram_sent_at: null,
    ...overrides,
  };
}

// A second distinct deal for multi-card tests
const DEAL_A = makeDeal({ id: 1, product_id: 1001, card_name: 'Lightning Bolt', price_cents: 1234 });
const DEAL_B = makeDeal({ id: 2, product_id: 1002, card_name: 'Counterspell', price_cents: 5000 });

// ---------------------------------------------------------------------------
// Test wrapper — fresh QueryClient per test (retry:false so errors surface fast)
// ---------------------------------------------------------------------------

function renderFeed() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DealFeed />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DealFeed', () => {

  // -------------------------------------------------------------------------
  // Test 1: renders deals and formats money correctly
  // -------------------------------------------------------------------------
  it('renders deals: card names appear and money is formatted as dollars (not raw cents)', async () => {
    mockGetDeals.mockResolvedValueOnce([DEAL_A, DEAL_B]);

    renderFeed();

    // Both card names must appear after the async query resolves
    expect(await screen.findByText('Lightning Bolt')).toBeInTheDocument();
    expect(await screen.findByText('Counterspell')).toBeInTheDocument();

    // price_cents=1234 → usd(1234, 'USD') → "$12.34" — never raw "1234"
    expect(screen.getByText('$12.34')).toBeInTheDocument();

    // Raw cents must NOT appear as a standalone text node
    expect(screen.queryByText('1234')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Test 2: filter buttons drive query re-invocations with correct args
  // -------------------------------------------------------------------------
  it('filter controls pass the right DealFilters to getDeals on each change', async () => {
    const user = userEvent.setup();
    // Return an empty list for every call so the view renders without error
    mockGetDeals.mockResolvedValue([]);

    renderFeed();

    // Wait for initial load (status='open', no min_discount, no priority)
    await waitFor(() => expect(mockGetDeals).toHaveBeenCalledTimes(1));
    expect(mockGetDeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'open' }),
    );

    // Click "All" status button → re-query with status:'all'
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(mockGetDeals).toHaveBeenCalledTimes(2));
    expect(mockGetDeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'all' }),
    );

    // Click "≥50%" min-discount button → re-query with min_discount:50
    await user.click(screen.getByRole('button', { name: '≥50%' }));
    await waitFor(() => expect(mockGetDeals).toHaveBeenCalledTimes(3));
    expect(mockGetDeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ min_discount: 50 }),
    );

    // Click "High" priority button → re-query with priority:'high'
    // The button text is "High" (preceded by a bolt icon rendered as aria-hidden SVG)
    await user.click(screen.getByRole('button', { name: /high/i }));
    await waitFor(() => expect(mockGetDeals).toHaveBeenCalledTimes(4));
    expect(mockGetDeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ priority: 'high' }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Dismiss calls patchDeal and triggers a re-fetch (invalidation)
  // -------------------------------------------------------------------------
  it('dismiss: calls patchDeal({dismissed:true}) and invalidation triggers a re-fetch', async () => {
    const user = userEvent.setup();

    // First fetch returns the deal; after mutation resolves, second fetch returns []
    mockGetDeals
      .mockResolvedValueOnce([DEAL_A])
      .mockResolvedValueOnce([]);
    // patchDeal resolves with the patched deal
    mockPatchDeal.mockResolvedValueOnce({ ...DEAL_A, dismissed: 1 });

    renderFeed();

    // Wait for the deal to render
    expect(await screen.findByText('Lightning Bolt')).toBeInTheDocument();

    // Click the Dismiss button for this card
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss deal' });
    await user.click(dismissBtn);

    // patchDeal must be called with (id, { dismissed: true }) — the two-arg signature
    await waitFor(() => {
      expect(mockPatchDeal).toHaveBeenCalledWith(DEAL_A.id, { dismissed: true });
    });

    // After mutation success, QueryClient invalidates ['deals'] → getDeals re-invoked
    await waitFor(() => {
      expect(mockGetDeals.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: Seen calls patchDeal with {seen:true}; disabled when already seen
  // -------------------------------------------------------------------------
  it('seen: calls patchDeal({seen:true}); Seen button disabled when deal.seen===1', async () => {
    const user = userEvent.setup();

    const seenDeal = makeDeal({ id: 3, seen: 1, card_name: 'Dark Ritual' });
    mockGetDeals.mockResolvedValueOnce([DEAL_A, seenDeal]);
    mockPatchDeal.mockResolvedValueOnce({ ...DEAL_A, seen: 1 });

    renderFeed();

    // Wait for both cards
    expect(await screen.findByText('Lightning Bolt')).toBeInTheDocument();
    expect(await screen.findByText('Dark Ritual')).toBeInTheDocument();

    // Click Seen on the unseen deal (Lightning Bolt — first "Mark seen" button)
    const seenBtns = screen.getAllByRole('button', { name: 'Mark seen' });
    // First button belongs to Lightning Bolt (unseen), second to Dark Ritual (already seen)
    await user.click(seenBtns[0]);

    await waitFor(() => {
      expect(mockPatchDeal).toHaveBeenCalledWith(DEAL_A.id, { seen: true });
    });

    // The Dark Ritual Seen button should be disabled because seen===1
    expect(seenBtns[1]).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Empty state — no deals → "No deals match these filters."
  // -------------------------------------------------------------------------
  it('empty state: shows "No deals match these filters." when getDeals returns []', async () => {
    mockGetDeals.mockResolvedValueOnce([]);

    renderFeed();

    expect(
      await screen.findByText('No deals match these filters.'),
    ).toBeInTheDocument();

    // No deal cards should be rendered
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Test 6: Error state — ApiError 401 → auth hint appears
  // -------------------------------------------------------------------------
  it('error state: ApiError 401 shows auth hint with VITE_DEV_AUTH_TOKEN', async () => {
    // Import the mock ApiError class (same shape as the real one)
    const { ApiError } = await import('../../api/client');
    mockGetDeals.mockRejectedValueOnce(new ApiError(401, 'unauthorized'));

    renderFeed();

    // The 401-specific message appears in both the readout strip and the empty
    // state <p> — the view renders it in two places. Use findAllByText and
    // assert at least one match is in the document.
    const matches = await screen.findAllByText(
      /Authentication error \(401 unauthorized\)\. Check VITE_DEV_AUTH_TOKEN/,
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]).toBeInTheDocument();
  });

});
