/**
 * DealCard — presentational card for one Deal row.
 *
 * Purely presentational: no data fetching, no state. The parent
 * DealFeed passes callbacks for every action.
 *
 * CSS classes used: all defined in styles/components.css section H.
 */

import { invoke } from '@tauri-apps/api/core';

import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { PriceBar } from '../../components/PriceBar';
import { Tag } from '../../components/Tag';
import type { Deal } from '../../api/types';
import { ago, flag, pct, savings, usd } from '../../lib/format';
import { conditionShort } from '../../lib/conditions';

export interface DealCardProps {
  deal: Deal;
  onSeen: (id: number) => void;
  onDismiss: (id: number) => void;
  onBuy: (deal: Deal) => void;
  onAddToCart?: (deal: Deal) => void;
  busy?: boolean;
  cartBusy?: boolean;
}

// Map card condition to a Tag tone — Mint/Near Mint/Slightly Played are "good".
function conditionTone(condition: string | null): 'good' | 'default' {
  if (
    condition === 'Mint' ||
    condition === 'Near Mint' ||
    condition === 'Slightly Played'
  ) return 'good';
  return 'default';
}

export function DealCard({
  deal,
  onSeen,
  onDismiss,
  onBuy,
  onAddToCart,
  busy = false,
  cartBusy = false,
}: DealCardProps) {
  const isHigh = deal.priority === 'high';
  const isSeen = deal.seen === 1;
  const isRetired = deal.status !== 'open';

  const rootClass = [
    'deal',
    isSeen ? 'deal-seen' : undefined,
    isHigh ? 'deal-high' : undefined,
    isRetired ? 'deal-retired' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  // Headline metric = candidate vs the NEXT-cheapest copy (the price you'd
  // actually pay next). Legacy rows (pre-gap-gate) have no second_cheapest_cents,
  // so fall back to the median baseline for those.
  const hasGap = deal.second_cheapest_cents != null && deal.gap_pct != null;
  const headlinePct = hasGap ? (deal.gap_pct as number) : deal.discount_pct;
  const headlineBaseCents = hasGap ? (deal.second_cheapest_cents as number) : deal.baseline_cents;
  const headlineBaseLabel = hasGap ? 'next' : 'med';
  const savingsCents = savings(headlineBaseCents, deal.price_cents);

  // Secondary "vs avg" = mean of the next-4-cheapest copies (NULL on legacy rows).
  const avg4Pct =
    deal.avg4_cents != null && deal.avg4_cents > 0
      ? Math.round((1 - deal.price_cents / deal.avg4_cents) * 100)
      : 0;

  return (
    <article className={rootClass}>
      {/* High-priority left rail accent bar */}
      {isHigh && <div className="deal-prio-rail" aria-hidden="true" />}

      {/* Top: card name + set  |  discount % */}
      <div className="deal-top">
        <div className="deal-id">
          <span className="deal-name">{deal.card_name}</span>
          <span className="deal-set cb-mono">{deal.expansion_name ?? '—'}</span>
        </div>
        {isRetired ? (
          <div className="deal-disc">
            <span
              className={`deal-status-badge deal-status-${deal.status}`}
              title={
                deal.status === 'sold'
                  ? 'This listing is no longer on the marketplace (likely bought).'
                  : 'No longer the cheapest qualifying copy — superseded since it was found.'
              }
            >
              {deal.status === 'sold' ? 'SOLD' : 'EXPIRED'}
            </span>
          </div>
        ) : (
          <div className="deal-disc">
            <span className="deal-disc-num">−{pct(headlinePct)}</span>
            <span className="cb-eyebrow" style={{ fontSize: 10 }}>
              under {headlineBaseLabel}
            </span>
          </div>
        )}
      </div>

      {/* Pricing: price, next-cheapest baseline, savings, avg line, bar */}
      <div className="deal-pricing">
        <div className="deal-price-block">
          <span className="deal-price">{usd(deal.price_cents, deal.currency)}</span>
          <span className="deal-base">
            vs {usd(headlineBaseCents, deal.currency)} {headlineBaseLabel}
          </span>
          <span className="deal-save cb-text-good">
            save {usd(savingsCents, deal.currency)}
          </span>
          {deal.avg4_cents != null && avg4Pct > 0 && (
            <span
              className="deal-gap cb-mono"
              title="Candidate vs the average of the next-4-cheapest copies (2nd–5th)."
            >
              −{pct(avg4Pct)} vs avg {usd(deal.avg4_cents, deal.currency)}
            </span>
          )}
        </div>
        <PriceBar
          value={headlinePct}
          max={100}
          tone={isHigh ? 'hot' : 'good'}
          title={`${pct(headlinePct)} below the next-cheapest copy`}
        />
      </div>

      {/* Meta tags: condition, foil, language, quantity */}
      <div className="deal-meta">
        <Tag tone={conditionTone(deal.condition)} title={deal.condition ?? 'Unknown condition'}>
          {conditionShort(deal.condition)}
        </Tag>
        {deal.foil !== null && (
          <Tag tone={deal.foil === 1 ? 'accent' : 'default'} title="Foil">
            {deal.foil === 1 ? 'FOIL' : 'NONFOIL'}
          </Tag>
        )}
        <Tag title="Language">{deal.language ?? '—'}</Tag>
        {deal.quantity !== null && (
          <Tag title="Quantity available">q{deal.quantity}</Tag>
        )}
      </div>

      {/* Footer: seller info | action buttons */}
      <div className="deal-foot">
        <div className="deal-foot-left">
          <span className="deal-seller">
            {flag(deal.seller_country)}{flag(deal.seller_country) ? ' ' : ''}
            {deal.seller_username ?? 'unknown'}
          </span>
          <span className="deal-age">{ago(deal.found_at)}</span>
        </div>

        <div className="deal-actions">
          <Btn
            variant="primary"
            onClick={() => onBuy(deal)}
            disabled={!deal.buy_url}
            title={deal.buy_url ? 'Open on CardTrader' : 'No buy link available'}
            aria-label={`Buy ${deal.card_name}`}
          >
            <Icon name="buy" size={14} />
            Buy
          </Btn>
          {onAddToCart && (
            <Btn
              variant="ghost"
              onClick={() => onAddToCart(deal)}
              disabled={cartBusy}
              title="Add to CardTrader cart"
              aria-label={`Add ${deal.card_name} to cart`}
            >
              <Icon name="cart" size={14} />
              Cart
            </Btn>
          )}
          <Btn
            variant="ghost"
            onClick={() => onSeen(deal.id)}
            disabled={isSeen || busy}
            title="Mark as seen"
            aria-label="Mark seen"
          >
            <Icon name="eye" size={14} />
            Seen
          </Btn>
          <Btn
            variant="ghost"
            onClick={() => onDismiss(deal.id)}
            disabled={busy}
            title="Dismiss deal"
            aria-label="Dismiss deal"
          >
            <Icon name="x" size={14} />
            Dismiss
          </Btn>
        </div>
      </div>
    </article>
  );
}

/**
 * openBuyUrl — opens deal.buy_url in the system browser via the Tauri
 * open_buy_url command. Falls back to window.open when running in a
 * plain browser (npm run dev without the Tauri host).
 */
export async function openBuyUrl(url: string): Promise<void> {
  try {
    await invoke('open_buy_url', { url });
  } catch {
    // Tauri host not available (plain browser dev session) — fall back.
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
