/**
 * Purchases — the savings ledger view.
 *
 * Shows how much the owner has saved over time by confirming deals as bought.
 * Data layer: usePurchases() (GET /api/purchases — TanStack Query). The ledger
 * is a standalone server-side table, so it survives deal pruning and watchlist
 * removal; this view just reads and formats it.
 *
 * Money is formatted ONLY via usd() from lib/format; never inline.
 * Loading / error / empty states are surfaced inline — never silent.
 */

import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Panel } from '../../components/Panel';
import { Tag } from '../../components/Tag';
import { usePurchases } from '../../api/hooks';
import type { Purchase } from '../../api/types';
import { ago, usd } from '../../lib/format';
import { conditionShort } from '../../lib/conditions';

// ---------------------------------------------------------------------------
// Ledger row — one confirmed purchase
// ---------------------------------------------------------------------------

function PurchaseRow({ item }: { item: Purchase }) {
  return (
    <div className="purchase-row">
      <div className="purchase-row-identity">
        <span className="purchase-row-name" title={item.card_name}>
          {item.card_name}
        </span>
        <div className="purchase-row-chips">
          {item.expansion_name && <Tag title="Set">{item.expansion_name}</Tag>}
          {item.condition && (
            <Tag title={item.condition}>{conditionShort(item.condition)}</Tag>
          )}
          {item.foil === 1 && <Tag tone="accent" title="Foil">FOIL</Tag>}
          {item.language && <Tag title="Language">{item.language}</Tag>}
        </div>
      </div>

      <div className="purchase-row-money">
        <span className="purchase-row-paid cb-mono" title="Price paid">
          {usd(item.paid_cents, item.currency)}
        </span>
        <span className="purchase-row-saved cb-mono cb-text-good" title="Saved vs the next-cheapest copy">
          +{usd(item.saved_cents, item.currency)} saved
        </span>
      </div>

      <span className="purchase-row-age cb-text-faint" title={item.bought_at}>
        {ago(item.bought_at)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View container
// ---------------------------------------------------------------------------

export function Purchases() {
  const { data, isPending, isError, error, refetch } = usePurchases();

  // --- Loading ---
  if (isPending) {
    return (
      <div className="purchases-view" style={{ padding: 'var(--pad)' }}>
        <div className="feed-empty">
          <Icon name="check" size={32} />
          <p>Loading purchases…</p>
        </div>
      </div>
    );
  }

  // --- Error ---
  if (isError) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div className="purchases-view" style={{ padding: 'var(--pad)' }}>
        <div className="feed-empty">
          <Icon name="alert" size={32} />
          <p>{message}</p>
          <Btn variant="ghost" onClick={() => void refetch()}>
            Retry
          </Btn>
        </div>
      </div>
    );
  }

  const { total_saved_cents, total_paid_cents, count, currency, items } = data;

  return (
    <div
      className="purchases-view"
      style={{ padding: 'var(--pad)', maxWidth: 1480, margin: '0 auto' }}
    >
      {/* Hero — cumulative savings */}
      <Panel glow className="purchases-hero cb-bracket">
        <div className="purchases-hero-in">
          <div className="purchases-hero-main">
            <span className="cb-eyebrow">total saved over time</span>
            <span className="purchases-hero-saved cb-text-good">
              {usd(total_saved_cents, currency)}
            </span>
          </div>
          <div className="purchases-hero-stats">
            <div className="purchases-stat">
              <span className="purchases-stat-v cb-mono">{count}</span>
              <span className="cb-eyebrow">cards bought</span>
            </div>
            <div className="purchases-stat">
              <span className="purchases-stat-v cb-mono">
                {usd(total_paid_cents, currency)}
              </span>
              <span className="cb-eyebrow">total paid</span>
            </div>
          </div>
        </div>
      </Panel>

      {/* Ledger */}
      {count === 0 ? (
        <div className="feed-empty">
          <Icon name="check" size={32} />
          <p>No purchases yet. Mark a deal as bought to start tracking your savings.</p>
        </div>
      ) : (
        <Panel eyebrow="LEDGER" title="Purchases" right={
          <span className="cb-eyebrow cb-text-faint">newest first</span>
        }>
          <div className="purchase-rows">
            {items.map((item) => (
              <PurchaseRow key={item.id} item={item} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
