/**
 * DealFeed — the Deal Feed view (container).
 *
 * Owns ephemeral filter UI state; delegates all server data to useDeals()
 * and all mutations to useDealMutation(). Never holds server data in useState.
 *
 * Filter controls drive GET /api/deals via query-key changes — no CSS hiding.
 */

import { useState } from 'react';

import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import type { DealFilters } from '../../api/hooks';
import { useCartAdd, useDeals, useDealMutation, useDeleteWatchItem } from '../../api/hooks';
import type { Deal } from '../../api/types';
import { ApiError } from '../../api/client';
import { savings, usd } from '../../lib/format';
import { DealCard, openBuyUrl } from './DealCard';

// Preset min-discount filter values offered in the command bar.
const DISCOUNT_PRESETS = [
  { label: 'Any', value: undefined },
  { label: '≥40%', value: 40 },
  { label: '≥50%', value: 50 },
  { label: '≥60%', value: 60 },
] as const;

type DiscountPreset = (typeof DISCOUNT_PRESETS)[number]['value'];

export function DealFeed() {
  // ---------------------------------------------------------------------------
  // Ephemeral UI filter state — these drive the query key and the API request.
  // ---------------------------------------------------------------------------
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [minDiscount, setMinDiscount] = useState<DiscountPreset>(undefined);
  const [priority, setPriority] = useState<'high' | 'normal' | undefined>(undefined);

  // After a deal is marked bought, hold it here to drive the "remove from
  // watchlist?" confirmation modal (null = closed).
  const [confirmRemove, setConfirmRemove] = useState<Deal | null>(null);

  // Build the filter object that is passed into useDeals.
  // min_discount is omitted when undefined (no threshold filter).
  const filters: DealFilters = {
    status,
    ...(minDiscount !== undefined ? { min_discount: minDiscount } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };

  // ---------------------------------------------------------------------------
  // Server data — TanStack Query; never in useState.
  // ---------------------------------------------------------------------------
  const { data: deals, isLoading, isError, error, refetch } = useDeals(filters);
  const mutation    = useDealMutation();
  const cartAdd     = useCartAdd();
  const deleteWatch = useDeleteWatchItem();

  // ---------------------------------------------------------------------------
  // Action handlers — delegate to the mutation; cache invalidates on success.
  // ---------------------------------------------------------------------------
  function handleBought(deal: Deal) {
    // Records a purchase-ledger entry and retires the deal (server-side), then
    // prompts whether to stop watching the card now that it's bought.
    mutation.mutate(
      { id: deal.id, patch: { bought: true } },
      { onSuccess: () => setConfirmRemove(deal) },
    );
  }

  function handleConfirmRemove() {
    if (confirmRemove === null) return;
    deleteWatch.mutate(confirmRemove.watchlist_id, {
      onSettled: () => setConfirmRemove(null),
    });
  }

  function handleDismiss(id: number) {
    mutation.mutate({ id, patch: { dismissed: true } });
  }

  function handleBuy(deal: Deal) {
    if (!deal.buy_url) return;
    void openBuyUrl(deal.buy_url);
  }

  function handleAddToCart(deal: Deal) {
    cartAdd.mutate({ productId: deal.product_id, quantity: 1 });
  }

  // ---------------------------------------------------------------------------
  // Error message — surface ApiError details to help with auth issues.
  // ---------------------------------------------------------------------------
  function errorMessage(err: Error): string {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return `Authentication error (401 ${err.code}). Check VITE_DEV_AUTH_TOKEN in your .env.`;
      }
      return `API error ${err.status}: ${err.code}`;
    }
    return err.message;
  }

  // ---------------------------------------------------------------------------
  // Readout summary text.
  // ---------------------------------------------------------------------------
  function readoutSummary(): string {
    const parts: string[] = [];
    parts.push(`status: ${status}`);
    if (minDiscount !== undefined) parts.push(`≥${minDiscount}% off`);
    if (priority !== undefined) parts.push(`${priority} priority`);
    return parts.join(' · ');
  }

  const dealCount = deals?.length ?? 0;

  return (
    <div style={{ padding: 'var(--pad)', maxWidth: 1480, margin: '0 auto' }}>

      {/* ---- Command bar ---- */}
      <div className="feed-cmd">
        <div className="feed-cmd-left">
          {/* Status: Open / All */}
          <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Deal status filter">
            <Btn
              variant={status === 'open' ? 'primary' : 'ghost'}
              onClick={() => setStatus('open')}
              aria-pressed={status === 'open'}
              title="Active deals + recently-expired ones (shown for 12h, dimmed, before they auto-hide). Excludes dismissed and sold."
            >
              Open
            </Btn>
            <Btn
              variant={status === 'all' ? 'primary' : 'ghost'}
              onClick={() => setStatus('all')}
              aria-pressed={status === 'all'}
              title="Show all deals including seen/dismissed and retired (sold/expired)"
            >
              All
            </Btn>
          </div>

          {/* Min discount presets */}
          <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Minimum discount filter">
            {DISCOUNT_PRESETS.map((preset) => (
              <Btn
                key={preset.label}
                variant={minDiscount === preset.value ? 'primary' : 'ghost'}
                onClick={() => setMinDiscount(preset.value)}
                aria-pressed={minDiscount === preset.value}
                title={preset.value !== undefined ? `Show deals with at least ${preset.value}% discount` : 'No minimum discount'}
              >
                {preset.label}
              </Btn>
            ))}
          </div>

          {/* Priority filter */}
          <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Priority filter">
            <Btn
              variant={priority === undefined ? 'primary' : 'ghost'}
              onClick={() => setPriority(undefined)}
              aria-pressed={priority === undefined}
              title="Show all priorities"
            >
              Any priority
            </Btn>
            <Btn
              variant={priority === 'high' ? 'primary' : 'ghost'}
              onClick={() => setPriority('high')}
              aria-pressed={priority === 'high'}
              title="Show high-priority deals only"
            >
              <Icon name="bolt" size={13} />
              High
            </Btn>
          </div>
        </div>

        {/* Refresh */}
        <Btn
          variant="ghost"
          onClick={() => void refetch()}
          disabled={isLoading}
          title="Refresh deal list"
          aria-label="Refresh"
        >
          <Icon name="radar" size={14} />
          Refresh
        </Btn>
      </div>

      {/* ---- Readout strip ---- */}
      <div className="feed-readout" role="status" aria-live="polite">
        {!isLoading && !isError && (
          <>
            <b>{dealCount}</b>
            {dealCount === 1 ? ' deal' : ' deals'}
            <span className="feed-dot" aria-hidden="true">·</span>
            <span>{readoutSummary()}</span>
          </>
        )}
        {isLoading && <span>Loading…</span>}
        {isError && error && (
          <span style={{ color: 'var(--hot)' }}>
            <Icon name="alert" size={13} />
            {' '}{errorMessage(error)}
          </span>
        )}
      </div>

      {/* ---- Deal grid / states ---- */}
      {isLoading ? (
        <div className="feed-list">
          <div className="feed-empty">
            <Icon name="radar" size={32} />
            <p>Scanning for deals…</p>
          </div>
        </div>
      ) : isError && error ? (
        <div className="feed-list">
          <div className="feed-empty">
            <Icon name="alert" size={32} />
            <p>{errorMessage(error)}</p>
            <Btn variant="ghost" onClick={() => void refetch()}>
              Retry
            </Btn>
          </div>
        </div>
      ) : dealCount === 0 ? (
        <div className="feed-list">
          <div className="feed-empty">
            <Icon name="radar" size={32} />
            <p>No deals match these filters.</p>
          </div>
        </div>
      ) : (
        <div className="feed-list">
          {(deals ?? []).map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              onBought={handleBought}
              onDismiss={handleDismiss}
              onBuy={handleBuy}
              onAddToCart={handleAddToCart}
              busy={mutation.isPending}
              cartBusy={cartAdd.isPending}
            />
          ))}
        </div>
      )}

      {/* ---- Bought → "remove from watchlist?" confirmation ---- */}
      <Modal
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        labelledBy="bought-confirm-title"
        className="confirm-modal"
      >
        {confirmRemove !== null && (
          <>
            <div className="confirm-modal-head">
              <Icon name="check" size={16} className="cb-text-good" />
              <span id="bought-confirm-title" className="cb-eyebrow">
                Bought · saved{' '}
                {usd(
                  savings(
                    confirmRemove.second_cheapest_cents ?? confirmRemove.baseline_cents,
                    confirmRemove.price_cents,
                  ),
                  confirmRemove.currency,
                )}
              </span>
            </div>
            <p className="confirm-modal-body">
              <b>{confirmRemove.card_name}</b> is logged in Purchases. Stop watching
              this card and remove it from your watchlist?
            </p>
            <p className="confirm-modal-note cb-text-faint">
              Removing also clears its other open deals. Your purchase record is kept.
            </p>
            <div className="confirm-modal-foot">
              <Btn
                variant="ghost"
                onClick={() => setConfirmRemove(null)}
                disabled={deleteWatch.isPending}
              >
                Keep watching
              </Btn>
              <Btn
                variant="danger"
                onClick={handleConfirmRemove}
                disabled={deleteWatch.isPending}
              >
                {deleteWatch.isPending ? 'Removing…' : 'Remove from watchlist'}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
