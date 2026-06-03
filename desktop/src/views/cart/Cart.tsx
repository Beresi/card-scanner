/**
 * Cart — view container for the CardTrader cart.
 *
 * Fetches the live cart via useCart() and renders per-subcart panels.
 * Mutations (add/remove) are wired here and passed down as callbacks so
 * the presentational sub-components stay pure.
 *
 * GROUPING: CardTrader's /cart/add APPENDS a new item per call instead of
 * incrementing quantity, so the same product can appear multiple times.
 * We group cart_items by product.id within each subcart, sum quantities,
 * and render ONE row per product — matching the CardTrader website's display.
 *
 * Loading / error / empty states are surfaced inline — never silent.
 * Money is formatted ONLY via usd() from lib/format; never inline.
 * "Open cart" opens the CardTrader cart URL in the system browser via openBuyUrl.
 */

import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Panel } from '../../components/Panel';
import { Tag } from '../../components/Tag';
import { useCart, useCartAdd, useCartRemove } from '../../api/hooks';
import type { CartItem, CartItemMeta, Money, Subcart } from '../../api/types';
import { usd } from '../../lib/format';
import { conditionShort } from '../../lib/conditions';
import { openBuyUrl } from '../deal-feed/DealCard';

const CARDTRADER_CART_URL = 'https://www.cardtrader.com/cart';

// ---------------------------------------------------------------------------
// Grouping logic — aggregate duplicate product rows within a subcart
// ---------------------------------------------------------------------------

/** A cart item with quantity summed across all duplicate product rows. */
interface GroupedCartItem {
  product: CartItem['product'];
  /** Total quantity across all cart_item rows for this product. */
  quantity: number;
  /** Per-unit price in cents — identical within a group; taken from first row. */
  price_cents: number;
  price_currency: string;
  /** Enrichment meta from the first row that has it, if any. */
  meta?: CartItemMeta;
  /** Distinct sellers fulfilling this product (usually one; >1 when stock-sourced). */
  sellers: string[];
}

/**
 * groupCartGlobally — deduplicate cart lines by product.id ACROSS all subcarts.
 *
 * CardTrader keys a line by product.id, but the SAME product.id can land in
 * multiple seller subcarts when the cheapest seller is out of stock and the
 * extra copy is sourced elsewhere. Grouping per-subcart would then show the
 * same card twice. We group globally so each product is ONE row with the
 * summed quantity — matching the user's "one row per card" expectation.
 *
 * Quantities are summed; price_cents is per-unit (constant within a group);
 * meta is taken from the first item that carries it; sellers are collected.
 */
function groupCartGlobally(subcarts: Subcart[]): GroupedCartItem[] {
  const map = new Map<number, GroupedCartItem>();
  for (const sc of subcarts) {
    const seller = sc.seller.username;
    for (const item of sc.cart_items) {
      const existing = map.get(item.product.id);
      if (existing) {
        existing.quantity += item.quantity;
        if (!existing.meta && item.meta) existing.meta = item.meta;
        if (!existing.sellers.includes(seller)) existing.sellers.push(seller);
      } else {
        map.set(item.product.id, {
          product: item.product,
          quantity: item.quantity,
          price_cents: item.price_cents,
          price_currency: item.price_currency,
          meta: item.meta,
          sellers: [seller],
        });
      }
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// CartLine — one grouped line item inside a subcart
// ---------------------------------------------------------------------------

interface CartLineProps {
  item: GroupedCartItem;
  onDecrement: () => void;
  onIncrement: () => void;
  onRemove: () => void;
  busy: boolean;
}

/** Map condition string to a Tag tone — same logic as DealCard. */
function conditionTone(condition: string | null | undefined): 'good' | 'default' {
  if (
    condition === 'Mint' ||
    condition === 'Near Mint' ||
    condition === 'Slightly Played'
  ) return 'good';
  return 'default';
}

function CartLine({ item, onDecrement, onIncrement, onRemove, busy }: CartLineProps) {
  const { product, quantity, price_cents, price_currency, meta } = item;
  const lineTotalCents = price_cents * quantity;

  // Disable + when we know the available quantity and we've reached it
  const availQty = meta?.available_quantity ?? null;
  const incrementDisabled = busy || (availQty !== null && quantity >= availQty);

  return (
    <div className="cart-line">

      {/* Column 1: thumbnail */}
      <div className="cart-line-thumb">
        {meta?.image_url ? (
          <img
            src={meta.image_url}
            loading="lazy"
            alt={product.name_en}
          />
        ) : (
          <Icon name="card" size={22} />
        )}
      </div>

      {/* Column 2: identity — name + metadata chips */}
      <div className="cart-line-identity">
        <span className="cart-line-name" title={product.name_en}>
          {product.name_en}
        </span>
        <div className="cart-line-chips">
          {meta?.expansion_name && (
            <Tag title="Set">{meta.expansion_name}</Tag>
          )}
          {meta?.condition && (
            <Tag
              tone={conditionTone(meta.condition)}
              title={meta.condition}
            >
              {conditionShort(meta.condition)}
            </Tag>
          )}
          {meta?.foil === 1 && (
            <Tag tone="accent" title="Foil">FOIL</Tag>
          )}
          {meta?.foil === 0 && (
            <Tag title="Non-foil">NONFOIL</Tag>
          )}
          {meta?.language && (
            <Tag title="Language">{meta.language}</Tag>
          )}
          {item.sellers.length === 1 && (
            <Tag title="Seller">{item.sellers[0]}</Tag>
          )}
          {item.sellers.length > 1 && (
            <Tag title={item.sellers.join(', ')}>{item.sellers.length} sellers</Tag>
          )}
        </div>
      </div>

      {/* Column 3: unit price + line total */}
      <div className="cart-line-price-col">
        <span className="cart-line-unit-price cb-mono">
          {usd(price_cents, price_currency)}
        </span>
        {quantity > 1 && (
          <span className="cart-line-total-price cb-mono">
            {usd(lineTotalCents, price_currency)} total
          </span>
        )}
      </div>

      {/* Column 4: quantity stepper */}
      <div
        className="cart-line-qty"
        role="group"
        aria-label={`Quantity controls for ${product.name_en}`}
      >
        <Btn
          variant="ghost"
          onClick={onDecrement}
          disabled={busy}
          title="Remove one"
          aria-label={`Remove one ${product.name_en}`}
        >
          −
        </Btn>
        <span className="cart-line-qty-num cb-mono">
          {quantity}
          {availQty !== null && (
            <span className="cart-line-qty-avail"> of {availQty}</span>
          )}
        </span>
        <Btn
          variant="ghost"
          onClick={onIncrement}
          disabled={incrementDisabled}
          title="Add one"
          aria-label={`Add one ${product.name_en}`}
        >
          +
        </Btn>
      </div>

      {/* Column 5: remove all (icon-only trash) */}
      <div className="cart-line-remove">
        <Btn
          variant="ghost"
          className="cart-line-trash"
          onClick={onRemove}
          disabled={busy}
          title="Remove from cart"
          aria-label={`Remove ${product.name_en} from cart`}
        >
          <Icon name="trash" size={16} />
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CartTotals — top-level cart money (subtotal, shipping, fees, total)
// ---------------------------------------------------------------------------

function MoneyRow({ label, money }: { label: string; money?: Money }) {
  if (!money) return null;
  return (
    <>
      <span className="cb-eyebrow">{label}</span>
      <span className="cb-mono">{usd(money.cents, money.currency)}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cart view (container)
// ---------------------------------------------------------------------------

export function Cart() {
  const { data: cart, isPending, isFetching, isError, error, refetch } = useCart();
  const cartAddMutation    = useCartAdd();
  const cartRemoveMutation = useCartRemove();

  const isBusy = cartAddMutation.isPending || cartRemoveMutation.isPending;

  function RefreshBtn() {
    return (
      <Btn
        variant="ghost"
        onClick={() => void refetch()}
        disabled={isFetching || isBusy}
        title="Refresh cart from CardTrader"
        aria-label="Refresh cart"
      >
        <Icon name="radar" size={14} />
        {isFetching ? 'Refreshing…' : 'Refresh'}
      </Btn>
    );
  }

  function handleDecrement(productId: number) {
    cartRemoveMutation.mutate({ productId, quantity: 1 });
  }

  function handleIncrement(productId: number) {
    cartAddMutation.mutate({ productId, quantity: 1 });
  }

  function handleRemoveAll(productId: number, quantity: number) {
    cartRemoveMutation.mutate({ productId, quantity });
  }

  // --- Loading ---
  if (isPending) {
    return (
      <div className="cart-view" style={{ padding: 'var(--pad)' }}>
        <div className="feed-empty">
          <Icon name="cart" size={32} />
          <p>Loading cart…</p>
        </div>
      </div>
    );
  }

  // --- Error ---
  if (isError) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div className="cart-view" style={{ padding: 'var(--pad)' }}>
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

  const subcarts = cart?.subcarts ?? [];

  // --- Empty ---
  if (subcarts.length === 0) {
    return (
      <div className="cart-view" style={{ padding: 'var(--pad)' }}>
        <div className="feed-empty">
          <Icon name="cart" size={32} />
          <p>Your CardTrader cart is empty.</p>
        </div>
        <div className="cart-footer">
          <RefreshBtn />
          <Btn
            variant="ghost"
            onClick={() => void openBuyUrl(CARDTRADER_CART_URL)}
            title="Open your cart on CardTrader"
          >
            <Icon name="ext" size={14} />
            Open cart on CardTrader
          </Btn>
        </div>
      </div>
    );
  }

  // Group ALL lines across subcarts by product.id — one row per product.
  const grouped = groupCartGlobally(subcarts);
  const itemCount = grouped.reduce((n, it) => n + it.quantity, 0);

  // Grand total: prefer the API's authoritative `total`; fall back to the
  // summed line items when an empty/partial cart omits it.
  const fallbackCurrency =
    cart?.subtotal?.currency ?? grouped[0]?.price_currency ?? 'USD';
  const grandTotal: Money =
    cart?.total ?? {
      cents: grouped.reduce((s, it) => s + it.price_cents * it.quantity, 0),
      currency: fallbackCurrency,
    };

  return (
    <div className="cart-view" style={{ padding: 'var(--pad)', maxWidth: 1480, margin: '0 auto' }}>

      {/* Header: item count + refresh */}
      <div className="cart-head">
        <span className="cb-eyebrow">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
        <RefreshBtn />
      </div>

      {/* One row per product (grouped across sellers) */}
      <Panel eyebrow="CART" title="Items">
        <div className="cart-lines">
          {grouped.map((item) => (
            <CartLine
              key={item.product.id}
              item={item}
              onDecrement={() => handleDecrement(item.product.id)}
              onIncrement={() => handleIncrement(item.product.id)}
              onRemove={() => handleRemoveAll(item.product.id, item.quantity)}
              busy={isBusy}
            />
          ))}
        </div>
      </Panel>

      {/* Cart-level totals (all money is top-level on the cart) */}
      <div className="cart-grand-total cb-panel">
        <div className="cart-subcart-costs">
          <MoneyRow label="Subtotal" money={cart?.subtotal} />
          <MoneyRow label="Shipping" money={cart?.shipping_cost} />
          <MoneyRow label="Safeguard fee" money={cart?.safeguard_fee_amount} />
          <MoneyRow label="CT Zero fee" money={cart?.ct_zero_fee_amount} />
          <MoneyRow label="Payment fee (fixed)" money={cart?.payment_method_fee_fixed_amount} />
          <MoneyRow label="Payment fee (%)" money={cart?.payment_method_fee_percentage_amount} />
        </div>
        <div className="cart-grand-total-vals">
          <span className="cb-eyebrow">Grand total</span>
          <span className="cb-mono cart-grand-total-val">
            {usd(grandTotal.cents, grandTotal.currency)}
          </span>
        </div>
      </div>

      {/* Footer: open in browser */}
      <div className="cart-footer">
        <Btn
          variant="primary"
          onClick={() => void openBuyUrl(CARDTRADER_CART_URL)}
          title="Open your cart on CardTrader"
        >
          <Icon name="ext" size={14} />
          Open cart on CardTrader
        </Btn>
      </div>

    </div>
  );
}
