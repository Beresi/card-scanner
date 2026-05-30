/**
 * POST /api/telegram/test
 *
 * Thin controller: sends a one-off test message to confirm bot + chat wiring
 * (PRD §10).  No business logic, no raw SQL here — delegates to the notifier.
 *
 * Stub state: until both Telegram secrets are provisioned, the notifier returns
 * `{ sent:false, reason:'not_configured' }` and this route answers 503 so the
 * desktop Settings view can show "Telegram not configured yet" rather than a
 * false success.  Once the secrets land it returns 200 `{ sent:true }`.
 *
 * Auth: inherited from the Bearer gate mounted on /api/* in index.ts.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { sendTestMessage } from '../telegram/notifier';

export const telegramRouter = new Hono<{ Bindings: Env }>();

// POST /api/telegram/test → notifier.sendTestMessage
telegramRouter.post('/test', async (c) => {
  const result = await sendTestMessage(c.env);
  // 200 when delivered; 503 (service not yet wired) when secrets are missing.
  return c.json(result, result.sent ? 200 : 503);
});
