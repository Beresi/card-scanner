/**
 * WatchInspector.test.tsx — §9a inherit/override contract for the watchlist inspector.
 *
 * The module-level watchlist store persists across tests. We drive the store
 * by rendering a wrapper that calls select() inside useEffect (so it fires
 * after mount, not during render), which avoids the "too many re-renders" trap.
 *
 * Item id 2 ("The One Ring"):
 *   - threshold_pct = null   → INHERITING  (config default = 50%)
 *   - min_condition = 'NM'   → OVERRIDING
 *
 * Item id 1 ("Ragavan, Nimble Pilferer"):
 *   - threshold_pct = 55     → OVERRIDING
 *   - min_condition = null   → INHERITING  (config default = NM)
 */

import { useEffect } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WatchInspector } from './WatchInspector';
import { useMockWatchlist } from '../../mock/hooks';

// ---------------------------------------------------------------------------
// Wrapper: selects an item (via useEffect) then renders the inspector.
// useEffect fires after mount so the component renders fully before select()
// triggers re-render. waitFor() in each test waits for the inspector content.
// ---------------------------------------------------------------------------

function InspectorWithSelection({ id }: { id: number }) {
  const { select } = useMockWatchlist();
  useEffect(() => {
    select(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return <WatchInspector />;
}

function Deselect() {
  const { select } = useMockWatchlist();
  useEffect(() => {
    select(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Cleanup after each test — deselect to avoid cross-test bleed
// ---------------------------------------------------------------------------

afterEach(() => {
  render(<Deselect />);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatchInspector — §9a inherit / override', () => {

  it('shows "inherit · 50%" for threshold when item.threshold_pct is null (id=2)', async () => {
    render(<InspectorWithSelection id={2} />); // The One Ring: threshold_pct = null

    // Wait for useEffect to fire and the inspector to appear
    await waitFor(() =>
      expect(screen.getByText(/inherit · 50%/)).toBeInTheDocument(),
    );

    // No reset button for the Threshold field
    expect(
      screen.queryByRole('button', { name: /reset threshold/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the reset button for threshold when item.threshold_pct is set (id=1)', async () => {
    render(<InspectorWithSelection id={1} />); // Ragavan: threshold_pct = 55

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /reset threshold/i }),
      ).toBeInTheDocument(),
    );

    // No inherit indicator for the Threshold field
    expect(screen.queryByText(/inherit · 50%/)).not.toBeInTheDocument();
  });

  it('clicking the threshold reset button returns the field to inherited state (id=1)', async () => {
    const user = userEvent.setup();
    render(<InspectorWithSelection id={1} />); // Ragavan: threshold_pct = 55

    // Wait for inspector to appear with the reset button
    const resetBtn = await screen.findByRole('button', { name: /reset threshold/i });
    await user.click(resetBtn);

    // After reset the inherit indicator should appear
    await waitFor(() =>
      expect(screen.getByText(/inherit · 50%/)).toBeInTheDocument(),
    );

    // Reset button should be gone
    expect(
      screen.queryByRole('button', { name: /reset threshold/i }),
    ).not.toBeInTheDocument();

    // Restore the override so other tests that reference id=1 are unaffected.
    // We do this by re-patching via a helper component rendered in the same act.
    render(<RestoreHelper id={1} field="threshold_pct" value={55} />);
    await waitFor(() => {}); // yield to let the patch apply
  });

  it('shows "inherit · NM" for min_condition when item.min_condition is null (id=1)', async () => {
    render(<InspectorWithSelection id={1} />); // Ragavan: min_condition = null

    // config.default_min_condition = 'NM'
    await waitFor(() =>
      expect(screen.getByText(/inherit · NM/)).toBeInTheDocument(),
    );
  });

  it('shows the reset button for min_condition when it is overridden (id=2)', async () => {
    render(<InspectorWithSelection id={2} />); // The One Ring: min_condition = 'NM' (override)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /reset min condition/i }),
      ).toBeInTheDocument(),
    );
  });

  it('renders nothing when no item is selected', async () => {
    // Ensure deselected
    render(<Deselect />);
    await waitFor(() => {}); // yield

    const { container } = render(<WatchInspector />);
    // Inspector should render null (no item selected)
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restore helper — patches a numeric field back to a known value
// ---------------------------------------------------------------------------

function RestoreHelper({
  id,
  field,
  value,
}: {
  id: number;
  field: 'threshold_pct';
  value: number;
}) {
  const { patchItem } = useMockWatchlist();
  useEffect(() => {
    patchItem(id, { [field]: value });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
