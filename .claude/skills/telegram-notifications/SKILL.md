---
name: telegram-notifications
description: The §8 Telegram anti-spam routing + notifier — app feed gets every deal, Telegram gets a strict opt-in subset. Load before touching src/telegram/routing.ts (the pure shouldNotify predicate) or src/telegram/notifier.ts (sendMessage I/O, batching, message formatting), or when implementing the §16 routing cases (7/8/9), the discount-gate / high-importance bypass, telegram_sent dedupe, or the plain-text message format.
---

# Telegram Notifications

## Purpose
THE key product feature (PRD §8). Two notification surfaces are **decoupled**: the in-app
feed gets **everything** (every `is_deal`); Telegram gets a **strict, owner-controlled
subset**. This is the anti-spam mechanism — high-importance items ping on any deal,
everything else pings only on a *really* steep discount, and the full list always lives in
the app.

The split mirrors the file split:
- `src/telegram/routing.ts` *(planned)* — **pure** §8 should-notify decision. No `fetch`,
  no DB, no `Date.now()`. Side-effect free, unit-testable, deterministic per §16.
- `src/telegram/notifier.ts` *(planned)* — the **only** module here that does I/O: formats +
  batches passing deals, calls the Bot API `sendMessage`, returns how many were sent.

The scanner calls `shouldNotify` per new deal, collects the passers, then makes **one**
`sendDeals` call for the run. Effective per-item settings arrive **pre-resolved** via
`resolveEffective(ticket, config)` (PRD §9a) — NULL override falls back to the config default.

## Core patterns

### `shouldNotify` — the pure §8 predicate (all criteria must hold)
```ts
type Priority = 'high' | 'normal';

// `eff` is the already-resolved effective config for this ticket (inherit/override done).
interface EffectiveTelegram {
  telegram_enabled: boolean;
  importance: 'high' | 'normal';
  telegram_min_discount_pct: number;        // per-item override else global default (60)
  telegram_max_price_cents: number | null;  // NULL ⇒ no cap
  telegram_min_savings_cents: number | null; // NULL ⇒ no floor
}
interface RoutableDeal {
  product_id: number;
  discount_pct: number;     // integer percent
  candidate_cents: number;  // integer cents
  baseline_cents: number;   // integer cents
  telegram_sent: boolean;   // dedupe key (criterion 4)
}

export function shouldNotify(
  deal: RoutableDeal,
  eff: EffectiveTelegram,
  // quiet hours v1-optional: pass currentHourLocal to evaluate, omit to always-pass
  currentHourLocal?: number,
  quiet?: { start: number; end: number },
): { send: boolean; priority: Priority } {
  const isHigh = eff.importance === 'high';
  const priority: Priority = isHigh ? 'high' : 'normal'; // written regardless of send

  // 1. Opt-in: enabled OR high importance
  if (!eff.telegram_enabled && !isHigh) return { send: false, priority };

  // 2. Discount gate: high bypasses it; else must clear the (stricter, 60%) TG threshold
  if (!isHigh && deal.discount_pct < eff.telegram_min_discount_pct) {
    return { send: false, priority };
  }

  // 3. Optional caps (only when set). savings = baseline - candidate, integer cents.
  if (eff.telegram_max_price_cents !== null &&
      deal.candidate_cents > eff.telegram_max_price_cents) {
    return { send: false, priority };
  }
  const savings_cents = deal.baseline_cents - deal.candidate_cents;
  if (eff.telegram_min_savings_cents !== null &&
      savings_cents < eff.telegram_min_savings_cents) {
    return { send: false, priority };
  }

  // 4. Dedupe: one push per product_id, ever
  if (deal.telegram_sent) return { send: false, priority };

  // 5. Quiet hours (v1-optional): hold → digest. Clock injected, never read here.
  if (quiet && currentHourLocal !== undefined && inQuietHours(currentHourLocal, quiet)) {
    return { send: false, priority }; // held; caller flushes in next out-of-hours digest
  }

  return { send: true, priority };
}
```

### `sendDeals` — batch all passers into ONE message
```ts
export async function sendDeals(deals: SendableDeal[], env: Env): Promise<number> {
  if (deals.length === 0) return 0;

  // ONE message for the whole run (split only if length forces it) — not one per deal.
  const text = deals.map(formatDeal).join('\n\n');

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
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
    // Log a count + status, NEVER the token or chat id.
    throw new Error(`telegram sendMessage failed: ${res.status}`);
  }
  return deals.length;
}

// Plain text per deal; cents → string only here (the UI edge). `· CT Zero ✓` ONLY if can_sell_via_hub.
function formatDeal(d: SendableDeal): string {
  const ctZero = d.can_sell_via_hub ? ' · CT Zero ✓' : '';
  const foil = d.foil ? 'Foil' : 'Non-foil';
  return [
    `Deal — ${d.card_name} · ${d.expansion_name}`,
    `${formatCents(d.candidate_cents, d.currency)} ${d.currency}  ` +
      `(${d.discount_pct}% under median ${formatCents(d.baseline_cents, d.currency)})`,
    `${d.condition} · ${foil} · EN · qty ${d.quantity}`,
    `Seller: ${d.seller_username} (${d.country_code})${ctZero}`,
    d.buy_link,
  ].join('\n');
}
```

### Message format template (PRD §8)
```
Deal — {card_name} · {expansion_name}
{price} {currency}  ({discount_pct}% under median {baseline_price})
{condition} · {Foil|Non-foil} · EN · qty {quantity}
Seller: {seller_username} ({country_code}){ · CT Zero ✓ if can_sell_via_hub}
{buy_link}
```

### Result fields written per deal (scanner persists onto `deals`)
| Field | Type | Meaning |
|---|---|---|
| `priority` | `'high' \| 'normal'` | `'high'` iff `importance = "high"` — written even if held by quiet hours. |
| `telegram_sent` | `0 \| 1` | Set to `1` once pushed. The dedupe key for criterion 4. |
| `telegram_sent_at` | `TEXT` (UTC `datetime`) | Push timestamp; `NULL` until sent. |

## Standards
@docs/standards/coding-standards.md

- Money is **integer cents** everywhere in routing; cents become a string ONLY in
  `formatDeal` (`formatCents`), never a float.
- `routing.ts` is pure: no `fetch`, no DB, no `Date.now()` — the current hour is injected.
- Secrets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are Wrangler secrets, read from `env`,
  **never logged** (not in source, D1, the bundle, logs, or git). Log counts, not wiring.

## Examples (Good / Bad)

### Good — §16 case 7: app-only normal deal
```ts
// telegram_enabled = false, normal, 52% off → fails criterion 1 (opt-in). App feed only.
shouldNotify(
  { product_id: 1, discount_pct: 52, candidate_cents: 4000, baseline_cents: 8300, telegram_sent: false },
  { telegram_enabled: false, importance: 'normal', telegram_min_discount_pct: 60,
    telegram_max_price_cents: null, telegram_min_savings_cents: null },
); // → { send: false, priority: 'normal' }
```

### Good — §16 case 8: high importance bypasses the gate
```ts
// importance = high, 51% off (below global 60) → criterion 2 bypassed. FIRES.
shouldNotify(
  { product_id: 2, discount_pct: 51, candidate_cents: 5000, baseline_cents: 10200, telegram_sent: false },
  { telegram_enabled: false, importance: 'high', telegram_min_discount_pct: 60,
    telegram_max_price_cents: null, telegram_min_savings_cents: null },
); // → { send: true, priority: 'high' }
```

### Good — §16 case 9: steep global fires; shallow same item is app-only
```ts
const eff = { telegram_enabled: true, importance: 'normal', telegram_min_discount_pct: 60,
              telegram_max_price_cents: null, telegram_min_savings_cents: null } as const;
// 65% off ≥ 60 → FIRES
shouldNotify({ product_id: 3, discount_pct: 65, candidate_cents: 3500, baseline_cents: 10000, telegram_sent: false }, eff);
// → { send: true, priority: 'normal' }
// same item at 52% off → fails the discount gate → app only
shouldNotify({ product_id: 3, discount_pct: 52, candidate_cents: 4800, baseline_cents: 10000, telegram_sent: false }, eff);
// → { send: false, priority: 'normal' }
```

### Bad
```ts
// ✗ Reads the clock inside the pure function (breaks determinism / §16 tests)
if (new Date().getHours() >= quiet.start) return { send: false, priority };
// ✗ Conflates the two gates: 50% app threshold is NOT the 60% Telegram gate
if (deal.discount_pct < 50) return { send: false, priority };
// ✗ One message per deal — spam (must batch the whole run into one)
for (const d of deals) await sendDeals([d], env);
// ✗ Logs the wiring
console.log(`sending to ${env.TELEGRAM_CHAT_ID} with ${env.TELEGRAM_BOT_TOKEN}`);
```

## Gotchas
- **High importance bypasses the discount gate, not the rest.** `high` short-circuits only
  criterion 2. It still needs Telegram wired, still respects dedupe (criterion 4) and the
  optional caps (criterion 3).
- **Dedupe is per `product_id`, via `telegram_sent` — not per blueprint.** One push per
  *listing*, ever. A genuinely cheaper *new* listing of the same card is a different
  `product_id` and can push again; the same listing reappearing next hour does not.
- **Two different discount gates.** The 50% app threshold (§7) decides what becomes a deal
  at all; the 60% Telegram gate decides what pushes. A 52% deal is real in the feed but
  below the Telegram gate (§16 case 9's app-only half). Don't conflate them.
- **Never log the token or chat id.** Log counts (`sentCount`) and milestones only —
  not in source, D1, the client bundle, logs, or git. `/getMe` status checks must not echo
  the token either.
- **Batch, don't ping per deal.** `sendDeals` combines all passers from a run into one
  message (split only if length forces it).
- **Quiet hours / digest is v1-optional.** Implement the gate (criterion 5) + a simple
  "flush held deals when quiet hours end" if time permits, else defer and treat it as
  always-pass. Comparisons use **local** hours per `config` (`quiet_hours_start`/`end`,
  `timezone`, default `Asia/Jerusalem`) — not UTC. The hour is injected, never read.
- **`priority` is written regardless of send.** A `high` deal held by quiet hours is still
  `priority = 'high'` on the `deals` row.

## Related skills
- deal-engine — produces the deals being routed
- cardtrader-api — buy link in the message
- inherit-override — effective TG settings
