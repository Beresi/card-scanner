/**
 * Mock health — matches the enriched Health interface.
 * Reflects a healthy system state with a recent last scan.
 */
import type { Health } from '../api/types';
import { minutesAgo } from './utils';

export const MOCK_HEALTH: Health = {
  ok: true,
  service: 'cardtrader-deal-scanner',
  ts: new Date().toISOString(),
  db_ok: true,
  last_scan_at: minutesAgo(6),
  last_scan_finished_at: minutesAgo(5),
  last_scan_error: null,
  deals_found: 3,
  telegram_sent: 1,
  api_calls: 42,
};
