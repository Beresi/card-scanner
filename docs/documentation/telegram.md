# Telegram Notifier & Routing
> Greenfield — describes intent. Planned files; no code yet. Spec:
> [PRD §8](../../cardtrader-deal-scanner-PRD.md) (the key feature). Lives in the `/worker`
> backend (PRD §14). Money is **integer cents** throughout.

## Purpose
Decide which newly-found deals are worth pinging the owner about, and send those — batched —
to Telegram. The two notification surfaces are decoupled (PRD §8): the **in-app feed gets
everything** (every `is_deal`), while **Telegram gets a strict, owner-controlled subset**.
This is the anti-spam mechanism: high-importance items ping immediately on any deal,
everything else only pings on a *really* steep discount, and the full list always lives in
the app.

The split mirrors the file split:
- [`routing.ts`](#planned-files) is a **pure decision function** — no `fetch`, no DB, no
  clock; given a deal, its ticket, and resolved config it returns *should this push and at
  what priority*. Side-effect free and unit-testable (coding-standards: pure domain logic).
- [`notifier.ts`](#planned-files) does the **I/O** — formats messages, batches, calls the
  Telegram Bot API `sendMessage`, and reports how many were sent.

## Planned files
| Path | Role |
|---|---|
| `src/telegram/routing.ts` *(planned)* | Pure §8 should-notify decision. No I/O, no clock. |
| `src/telegram/notifier.ts` *(planned)* | `sendMessage` over the Bot API + batching + message formatting. The only module here that does network I/O. |

## Routing decision (§8)
`routing.ts` evaluates each **new** deal (the truly-inserted rows from §11 step 6) against
its watch item and the resolved config. Per-ticket override fields are resolved first via
`resolveEffective(ticket, config)` (PRD §9a) — a `NULL` override falls back to the matching
`config` default. A deal pushes to Telegram **only if ALL** of the following hold:

1. **Opt-in.** The watch item has `telegram_enabled = true`, **OR** `importance = "high"`.
2. **Discount gate.** **Either** `importance = "high"` (high-importance items *bypass* the
   discount gate and push on any deal), **OR**
   `discount_pct >= telegram_min_discount_pct` — the per-item override if set, else the
   global default (`config.telegram_min_discount_pct`, default **60%**, deliberately
   stricter than the 50% app threshold in PRD §7).
3. **Optional price/savings caps** (only enforced when set):
   `candidate.cents <= telegram_max_price_cents` (NULL ⇒ no cap) **and/or**
   `savings_cents >= telegram_min_savings_cents` (NULL ⇒ no floor), where
   `savings_cents = baseline_cents - candidate.cents` (integer cents).
4. **Dedupe.** Not already sent for this `product_id` (`telegram_sent = false`). One push per
   listing, ever (PRD §7, §13).
5. **Quiet hours** *(optional, v1-optional)*. If quiet hours are configured and currently
   active, **hold** the deal and include it in the next out-of-hours digest rather than
   pushing now. See [Gotchas](#gotchas).

> **Net effect:** mark a few sets/cards as **high importance** → those ping immediately on
> any deal. Everything else only pings if the discount clears the stricter Telegram gate
> (≥ 60% vs the 50% app threshold). The full list always lives in the app — no spam.

### Result fields written per deal
After routing + send, the scanner persists onto the `deals` row (PRD §8, §9):

| Field | Type | Meaning |
|---|---|---|
| `priority` | `'high' \| 'normal'` | `'high'` iff the watch item's `importance = "high"`, else `'normal'`. |
| `telegram_sent` | `0 \| 1` | Set to `1` once the deal has been pushed. The dedupe key for criterion 4. |
| `telegram_sent_at` | `TEXT` (UTC `datetime`) | Timestamp of the push; `NULL` until sent. |

## Public interface
| Function | Module | Signature | Notes |
|---|---|---|---|
| `shouldNotify` | `routing.ts` | `(deal, ticket, config) -> { send: boolean, priority: 'high' \| 'normal' }` | Pure. Encodes criteria 1–4 (and the quiet-hours gate when a current-hour input is supplied). No I/O. |
| `sendDeals` | `notifier.ts` | `(deals, env) -> Promise<number>` (returns `sentCount`) | Formats + batches the passing deals into one (or a few) messages, calls the Bot API, returns how many deals were sent. |
| `sendTest` | `notifier.ts` | `(env) -> Promise<void>` | Sends a test message to confirm bot + chat wiring. Backs `POST /api/telegram/test` (PRD §10). |

- `shouldNotify` is the gate; `sendDeals` does the work. The scanner calls `shouldNotify` per
  new deal, collects the passers, then makes **one** `sendDeals` call for the run.
- `priority` returned by `shouldNotify` is what the scanner writes to `deals.priority`,
  regardless of whether the deal ultimately pushes (a `high` deal held by quiet hours is
  still `priority = 'high'`).

## Message format (§8)
Plain text, one block per deal (the owner can add an emoji prefix if desired). The
`· CT Zero ✓` segment is appended **only** when `can_sell_via_hub` is true.

```
Deal — {card_name} · {expansion_name}
{price} {currency}  ({discount_pct}% under median {baseline_price})
{condition} · {Foil|Non-foil} · EN · qty {quantity}
Seller: {seller_username} ({country_code}){ · CT Zero ✓ if can_sell_via_hub}
{buy_link}
```

- `{price}` / `{baseline_price}` are formatted from **integer cents** at this UI edge only
  (`formatCents(cents, currency)`); the engine and routing never see a float (coding-standards
  "Money").
- `{Foil|Non-foil}` derives from `deals.foil` (0/1); language is always `EN` (PRD §7).

## Batching
`sendDeals` combines **all** the passing new deals from a single scan into **one message**
(or a small number if length forces a split), not one message per deal — fewer pings, less
noise (PRD §8). Quiet-hours-held deals (criterion 5) are likewise flushed as a single digest
when the window ends, if that optional path is implemented.

## Dependencies
| Dependency | Why |
|---|---|
| `scan/scanner.ts` (PRD §11 step 7) | Caller: feeds new deals in, persists `priority` / `telegram_sent` / `telegram_sent_at`. |
| `resolveEffective(ticket, config)` (PRD §9a) | Resolves per-item overrides before routing. |
| Telegram Bot API `sendMessage` | The transport (`notifier.ts` only). |
| `config` row (PRD §9) | `telegram_min_discount_pct`, quiet-hours fields, timezone. |

### Secrets
| Secret | Where | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Wrangler secret (PRD §5, §12) | Bot auth for the Bot API. |
| `TELEGRAM_CHAT_ID` | Wrangler secret (PRD §5, §12) | Target chat for pushes. |

- **Never logged.** Not the token, not the chat id — never in source, D1, the client bundle,
  logs, or git (coding-standards "Logging"; shared-standards "Secrets handling"). Log
  *counts* (`telegram_sent`) and milestones, not the wiring.
- Connection status on the Settings page comes from a cached `/getMe` check (PRD §10), which
  also must not echo the token.

## Acceptance criteria (PRD §16)
Routing is a pure function with exact cases — each becomes a named test (coding-standards
"Testing"). The §16 routing cases:

| # | Case | Expectation |
|---|---|---|
| 7 | `telegram_enabled = false`, `normal`, 52% off | **App only** — fails criterion 1, no Telegram. |
| 8 | `importance = "high"`, 51% off (below global 60%) | **Fires** — criterion 2 bypassed by high importance. |
| 9 | `telegram_enabled = true`, 65% off (≥ global 60%) | **Fires.** Same item at 52% off → **app only** (fails the discount gate). |

Also relevant: §16 case 6 (dedupe) — the same `product_id` over two consecutive scans yields
**one** deal row and **one** Telegram push (criterion 4).

## Gotchas
- **High importance bypasses the discount gate but not reachability.** A `high` deal still
  needs Telegram wired (token + chat id) and still respects dedupe (criterion 4) and the
  optional caps (criterion 3). "High" only short-circuits criterion 2's discount threshold.
- **Dedupe is per `product_id`, not per blueprint.** One push per *listing*. A genuinely
  cheaper *new* listing of the same card is a different `product_id` → it can push again. The
  same listing reappearing next hour does not (PRD §7, §13). Future: re-alert on a further
  price drop (PRD §13/§17) — not v1.
- **Discount thresholds are two different gates.** The 50% app threshold (PRD §7) decides
  what becomes a deal at all; the 60% Telegram gate decides what gets pushed. A 52% deal is
  real and shows in the feed but is below the Telegram gate — exactly §16 case 9's app-only
  half. Don't conflate them.
- **Purity of `routing.ts`.** No `Date.now()` inside — if quiet-hours evaluation needs the
  current hour, pass it in (coding-standards: clock injected, not read). Keeps every §16 case
  deterministic.
- **Quiet hours / digest is v1-optional.** Implement the gate (criterion 5) plus a simple
  "flush held deals when quiet hours end" if time permits; otherwise **defer** and treat
  criterion 5 as always-pass. Quiet-hours comparisons use **local** hours per `config`
  (`quiet_hours_start`/`end`, `timezone`, default `Asia/Jerusalem`) — not UTC
  (shared-standards "Time"; PRD §8/§9).
- **Money at the format edge only.** `sendDeals` is the one place cents become a display
  string; `shouldNotify` compares raw integer cents (`telegram_max_price_cents`,
  `telegram_min_savings_cents`). Never float math (coding-standards "Money").
