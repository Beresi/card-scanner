/**
 * Unit tests for parseCart() — the boundary parser for the live CardTrader
 * GET /cart response.
 *
 * These tests drive parseCart() directly on static JSON fixtures — no network,
 * no mocks beyond the input data itself. All money values are asserted as
 * integer cents only (never floats).
 *
 * PRD §6: money is integer cents; §10: cart read/add/remove only (no purchase).
 * CLAUDE.md: "Money is always integer cents — never floats".
 *
 * The REAL_CART_JSON fixture is the exact live response captured on 2026-06-01.
 * It is the regression guard for the upstream_error / 500 bug caused by the old
 * parser expecting per-subcart money fields that the live API does not return.
 */

import { describe, it, expect } from 'vitest';
import { parseCart, CardTraderError } from './types';

// ---------------------------------------------------------------------------
// The EXACT live CardTrader GET /cart response (captured 2026-06-01, status 200)
// This is the primary regression fixture.
// ---------------------------------------------------------------------------

const REAL_CART_JSON = {
  id: 8481423,
  total: { cents: 599, currency: 'USD' },
  subtotal: { cents: 599, currency: 'USD' },
  safeguard_fee_amount: { cents: 0, currency: 'USD' },
  ct_zero_fee_amount: { cents: 0, currency: 'USD' },
  payment_method_fee_fixed_amount: { cents: 35, currency: 'USD' },
  payment_method_fee_percentage_amount: { cents: 30, currency: 'USD' },
  shipping_cost: { cents: 0, currency: 'USD' },
  subcarts: [
    {
      id: 14519504,
      seller: { id: 34089, username: 'Ct connect' },
      via_cardtrader_zero: true,
      cart_items: [
        {
          quantity: 1,
          price_cents: 49,
          price_currency: 'USD',
          product: { id: 404673249, name_en: 'Glissa Sunslayer' },
        },
        {
          quantity: 1,
          price_cents: 277,
          price_currency: 'USD',
          product: { id: 418888878, name_en: 'Tezzeret, Betrayer of Flesh' },
        },
      ],
    },
  ],
  billing_address: null,
  shipping_address: null,
};

// ---------------------------------------------------------------------------
// Regression guard — parseCart on the exact live response must not throw.
// ---------------------------------------------------------------------------

describe('parseCart() — regression guard against live response shape', () => {
  it('does NOT throw on the exact captured live CartTrader /cart JSON', () => {
    expect(() => parseCart(REAL_CART_JSON)).not.toThrow();
  });

  it('cart.id === 8481423', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.id).toBe(8481423);
  });

  it('cart.subtotal.cents === 599 (integer cents)', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.subtotal).toBeDefined();
    expect(cart.subtotal!.cents).toBe(599);
    expect(Number.isInteger(cart.subtotal!.cents)).toBe(true);
  });

  it('cart.total.cents === 599 (integer cents)', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.total).toBeDefined();
    expect(cart.total!.cents).toBe(599);
    expect(Number.isInteger(cart.total!.cents)).toBe(true);
  });

  it('cart.shipping_cost.cents === 0 (integer cents)', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.shipping_cost).toBeDefined();
    expect(cart.shipping_cost!.cents).toBe(0);
    expect(Number.isInteger(cart.shipping_cost!.cents)).toBe(true);
  });

  it('cart.payment_method_fee_fixed_amount.cents === 35 (integer cents)', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.payment_method_fee_fixed_amount).toBeDefined();
    expect(cart.payment_method_fee_fixed_amount!.cents).toBe(35);
    expect(Number.isInteger(cart.payment_method_fee_fixed_amount!.cents)).toBe(true);
  });

  it('cart.payment_method_fee_percentage_amount.cents === 30 (integer cents)', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.payment_method_fee_percentage_amount).toBeDefined();
    expect(cart.payment_method_fee_percentage_amount!.cents).toBe(30);
    expect(Number.isInteger(cart.payment_method_fee_percentage_amount!.cents)).toBe(true);
  });

  it('subcarts[0].seller.username === "Ct connect"', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.subcarts).toHaveLength(1);
    expect(cart.subcarts[0]!.seller.username).toBe('Ct connect');
  });

  it('subcarts[0].via_cardtrader_zero === true', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.subcarts[0]!.via_cardtrader_zero).toBe(true);
  });

  it('subcarts[0].cart_items[0] matches the first line item exactly', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.subcarts[0]!.cart_items[0]).toEqual({
      quantity: 1,
      price_cents: 49,
      price_currency: 'USD',
      product: { id: 404673249, name_en: 'Glissa Sunslayer' },
    });
  });

  it('subcarts[0].cart_items[1] matches the second line item exactly', () => {
    const cart = parseCart(REAL_CART_JSON);
    expect(cart.subcarts[0]!.cart_items[1]).toEqual({
      quantity: 1,
      price_cents: 277,
      price_currency: 'USD',
      product: { id: 418888878, name_en: 'Tezzeret, Betrayer of Flesh' },
    });
  });
});

// ---------------------------------------------------------------------------
// Empty-cart guard — no money fields, empty subcarts.
// ---------------------------------------------------------------------------

describe('parseCart() — empty cart', () => {
  it('returns an empty-cart object without throwing', () => {
    expect(() => parseCart({ id: 1, subcarts: [] })).not.toThrow();
  });

  it('empty cart has undefined money fields (not an error)', () => {
    const cart = parseCart({ id: 1, subcarts: [] });
    expect(cart.id).toBe(1);
    expect(cart.subcarts).toEqual([]);
    expect(cart.total).toBeUndefined();
    expect(cart.subtotal).toBeUndefined();
    expect(cart.shipping_cost).toBeUndefined();
    expect(cart.safeguard_fee_amount).toBeUndefined();
    expect(cart.ct_zero_fee_amount).toBeUndefined();
    expect(cart.payment_method_fee_fixed_amount).toBeUndefined();
    expect(cart.payment_method_fee_percentage_amount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wrapped cart — optional { cart: { ... } } outer object.
// ---------------------------------------------------------------------------

describe('parseCart() — optional cart wrapper', () => {
  it('unwraps a { cart: { id, subcarts } } envelope', () => {
    const wrapped = { cart: { id: 42, subcarts: [] } };
    const cart = parseCart(wrapped);
    expect(cart.id).toBe(42);
    expect(cart.subcarts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error paths — structural violations must throw CardTraderError.
// ---------------------------------------------------------------------------

describe('parseCart() — error paths', () => {
  it('throws CardTraderError when input is not an object', () => {
    expect(() => parseCart('not an object')).toThrow(CardTraderError);
    expect(() => parseCart(null)).toThrow(CardTraderError);
    expect(() => parseCart([1, 2, 3])).toThrow(CardTraderError);
  });

  it('throws CardTraderError when cart.id is missing', () => {
    expect(() => parseCart({ subcarts: [] })).toThrow(CardTraderError);
  });

  it('throws CardTraderError when cart.id is not an integer', () => {
    expect(() => parseCart({ id: 'abc', subcarts: [] })).toThrow(CardTraderError);
    expect(() => parseCart({ id: 1.5, subcarts: [] })).toThrow(CardTraderError);
  });
});
