/**
 * Telegram notifier — the ONLY module that performs Telegram I/O.
 *
 * Responsibilities:
 *  - Format a passing deal into the PRD §8 plain-text block (display edge —
 *    integer cents become a "12.34" string HERE and nowhere upstream).
 *  - Batch ALL passing deals from one scan into a SINGLE `sendMessage` (the
 *    anti-spam contract: one message per run, not one per deal).
 *  - Gate every send behind `isTelegramConfigured(env)` — the off-switch. With
 *    the Telegram secrets unset (the Phase-2 stub state), every send path is a
 *    logged no-op: nothing fires, no `telegram_sent` is marked. The moment the
 *    secrets land, the same code goes live with no further changes.
 *
 * Routing (the should-notify decision) lives in `routing.ts` (pure). This file
 * never decides; it only formats + sends what it is handed.
 *
 * SECRETS INVARIANT: never log `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` (or
 * the API URL, which embeds the token) — log counts and status only.
 *
 * PRD §8 (message format + batching), §10 (POST /api/telegram/test).
 */

import type { Env } from '../index';
import type { DealInsert } from '../db/types';

// ---------------------------------------------------------------------------
// Configuration gate — the stub off-switch
// ---------------------------------------------------------------------------

/**
 * Is Telegram wired? True only when both secrets are present and non-empty.
 *
 * This is the single guard the scanner and the test route consult before any
 * network call. While it returns false, the whole Telegram path is inert.
 */
export function isTelegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(env.TELEGRAM_CHAT_ID);
}

// ---------------------------------------------------------------------------
// Formatting (display edge — cents → string lives here, never upstream)
// ---------------------------------------------------------------------------

/** The deal fields the §8 message renders. `DealInsert` satisfies this. */
export type FormattableDeal = Pick<
  DealInsert,
  | 'card_name'
  | 'expansion_name'
  | 'price_cents'
  | 'currency'
  | 'discount_pct'
  | 'baseline_cents'
  | 'condition'
  | 'foil'
  | 'quantity'
  | 'seller_username'
  | 'seller_country'
  | 'can_sell_via_hub'
  | 'buy_url'
>;

/**
 * Render integer cents as a fixed-2-decimal amount string (e.g. 1234 → "12.34").
 * The ONLY place money stops being integer cents — pure string math, no float
 * accumulation upstream.
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Format ONE deal as the PRD §8 plain-text block:
 *
 *   Deal — {card_name} · {expansion_name}
 *   {price} {currency}  ({discount_pct}% under median {baseline_price})
 *   {condition} · {Foil|Non-foil} · EN · qty {quantity}
 *   Seller: {seller_username} ({country_code}){ · CT Zero ✓ if can_sell_via_hub}
 *   {buy_link}
 */
export function formatDeal(deal: FormattableDeal): string {
  const title = deal.expansion_name
    ? `Deal — ${deal.card_name} · ${deal.expansion_name}`
    : `Deal — ${deal.card_name}`;

  const price = `${formatCents(deal.price_cents)} ${deal.currency}  (${deal.discount_pct}% under median ${formatCents(deal.baseline_cents)})`;

  const foilLabel = deal.foil ? 'Foil' : 'Non-foil';
  const qty = deal.quantity ?? '?';
  const attrs = `${deal.condition ?? 'Unknown'} · ${foilLabel} · EN · qty ${qty}`;

  const country = deal.seller_country ? ` (${deal.seller_country})` : '';
  const hub = deal.can_sell_via_hub ? ' · CT Zero ✓' : '';
  const seller = `Seller: ${deal.seller_username ?? 'unknown'}${country}${hub}`;

  const lines = [title, price, attrs, seller];
  if (deal.buy_url) {
    lines.push(deal.buy_url);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sending (guarded — no-op until secrets exist)
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Internal: POST a single text message to the Bot API. Caller pre-guards. */
async function postMessage(env: Env, text: string): Promise<void> {
  const res = await fetch(
    `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    },
  );
  if (!res.ok) {
    // Status only — never echo the URL (it embeds the token) or the body.
    throw new Error(`telegram sendMessage failed: ${res.status}`);
  }
}

/**
 * Batch all passing deals into ONE Telegram message and send it.
 *
 * Returns the number of deals sent (0 when none, or when Telegram is not yet
 * configured). GUARDED: if `!isTelegramConfigured(env)` this is a logged no-op
 * — it never touches the network and the caller leaves `telegram_sent` unset,
 * so no deals are "burned" before the bot is wired (the Phase-2 stub state).
 */
export async function sendDeals(
  deals: FormattableDeal[],
  env: Env,
): Promise<number> {
  if (deals.length === 0) {
    return 0;
  }
  if (!isTelegramConfigured(env)) {
    console.info('[telegram] not configured — skipping send', {
      count: deals.length,
    });
    return 0;
  }

  // ONE message for the whole run, deals joined by a blank line (PRD §8).
  const text = deals.map(formatDeal).join('\n\n');
  await postMessage(env, text);
  return deals.length;
}

/** Result of a manual test send (POST /api/telegram/test). */
export interface TestSendResult {
  sent: boolean;
  reason?: string;
}

/**
 * Send a one-off test message to confirm bot + chat wiring (PRD §10).
 * Same guard as `sendDeals` — returns `{ sent:false, reason:'not_configured' }`
 * while the secrets are unset.
 */
export async function sendTestMessage(env: Env): Promise<TestSendResult> {
  if (!isTelegramConfigured(env)) {
    return { sent: false, reason: 'not_configured' };
  }
  await postMessage(
    env,
    'Card // Broker — Telegram test message. Bot + chat wiring OK.',
  );
  return { sent: true };
}
