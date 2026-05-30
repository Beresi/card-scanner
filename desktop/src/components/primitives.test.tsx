/**
 * primitives.test.tsx — a11y and behaviour tests for Switch, Segmented, and
 * InheritField. These components are pure presentational (no hooks, no async),
 * so every test is synchronous.
 *
 * Covers §9a contract for InheritField:
 *   - inherited=true  → "inherit · {defaultLabel}" indicator, no reset button
 *   - inherited=false → "override ✕" button; clicking it calls onReset
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Switch } from './Switch';
import { Segmented } from './Segmented';
import { InheritField } from './InheritField';

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

describe('Switch', () => {
  it('renders role="switch" with aria-checked reflecting the on prop', () => {
    render(
      <Switch on={true} onChange={vi.fn()} label="Enable Telegram" />,
    );
    const btn = screen.getByRole('switch', { name: 'Enable Telegram' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-checked', 'true');
  });

  it('aria-checked is false when on=false', () => {
    render(<Switch on={false} onChange={vi.fn()} label="Enable Telegram" />);
    const btn = screen.getByRole('switch', { name: 'Enable Telegram' });
    expect(btn).toHaveAttribute('aria-checked', 'false');
  });

  it('click calls onChange with the negated value (on=false → true)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch on={false} onChange={onChange} label="Toggle" />);
    await user.click(screen.getByRole('switch', { name: 'Toggle' }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('click calls onChange with false when currently on', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch on={true} onChange={onChange} label="Toggle" />);
    await user.click(screen.getByRole('switch', { name: 'Toggle' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('Space key fires onChange with the negated value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch on={false} onChange={onChange} label="Toggle" />);
    const btn = screen.getByRole('switch', { name: 'Toggle' });
    btn.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Enter key fires onChange with the negated value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch on={true} onChange={onChange} label="Toggle" />);
    const btn = screen.getByRole('switch', { name: 'Toggle' });
    btn.focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// Segmented
// ---------------------------------------------------------------------------

describe('Segmented', () => {
  const OPTIONS = [
    { value: 'any',     label: 'Any' },
    { value: 'nonfoil', label: 'Nonfoil' },
    { value: 'foil',    label: 'Foil' },
  ];

  it('renders role="tablist" and each option as role="tab"', () => {
    render(
      <Segmented value="any" options={OPTIONS} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('the active option has aria-selected=true; others false', () => {
    render(
      <Segmented value="nonfoil" options={OPTIONS} onChange={vi.fn()} />,
    );
    const tabs = screen.getAllByRole('tab');
    const nonfoilTab = tabs.find((t) => t.textContent === 'Nonfoil')!;
    const anyTab     = tabs.find((t) => t.textContent === 'Any')!;
    expect(nonfoilTab).toHaveAttribute('aria-selected', 'true');
    expect(anyTab).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking an option calls onChange with its value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented value="any" options={OPTIONS} onChange={onChange} />,
    );
    await user.click(screen.getByRole('tab', { name: 'Foil' }));
    expect(onChange).toHaveBeenCalledWith('foil');
  });

  it('ArrowRight moves to the next option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented value="any" options={OPTIONS} onChange={onChange} />,
    );
    // Focus the active tab then press ArrowRight
    const activeTab = screen.getByRole('tab', { name: 'Any' });
    activeTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('nonfoil');
  });

  it('ArrowLeft moves to the previous option (clamped at start)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented value="any" options={OPTIONS} onChange={onChange} />,
    );
    const activeTab = screen.getByRole('tab', { name: 'Any' });
    activeTab.focus();
    // Already at start — should remain 'any'
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('any');
  });
});

// ---------------------------------------------------------------------------
// InheritField — §9a contract (the most important assertion in this file)
// ---------------------------------------------------------------------------

describe('InheritField', () => {
  it('inherited=true shows "inherit · {defaultLabel}" indicator and NO reset button', () => {
    const onReset = vi.fn();
    render(
      <InheritField
        label="Threshold"
        inherited={true}
        defaultLabel="50%"
        onReset={onReset}
      >
        <input type="range" />
      </InheritField>,
    );

    // Inherit indicator contains the text
    expect(screen.getByText(/inherit · 50%/)).toBeInTheDocument();

    // No reset button visible
    expect(
      screen.queryByRole('button', { name: /reset threshold/i }),
    ).not.toBeInTheDocument();
  });

  it('inherited=false shows the "override ✕" reset button and clicking fires onReset', async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    render(
      <InheritField
        label="Threshold"
        inherited={false}
        defaultLabel="50%"
        onReset={onReset}
      >
        <input type="range" />
      </InheritField>,
    );

    // No inherit indicator
    expect(screen.queryByText(/inherit · 50%/)).not.toBeInTheDocument();

    // Reset button is present
    const resetBtn = screen.getByRole('button', { name: /reset threshold/i });
    expect(resetBtn).toBeInTheDocument();

    // Clicking calls onReset
    await user.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('children are always rendered regardless of inherited state', () => {
    render(
      <InheritField
        label="Threshold"
        inherited={true}
        defaultLabel="50%"
        onReset={vi.fn()}
      >
        <span data-testid="child-control">control</span>
      </InheritField>,
    );
    expect(screen.getByTestId('child-control')).toBeInTheDocument();
  });
});
