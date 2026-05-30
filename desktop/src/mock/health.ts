/**
 * Mock health — matches the Health interface (loose shape with index signature).
 * Reflects a healthy system state with a recent last scan.
 */
import type { Health } from '../api/types';
import { minutesAgo } from './utils';

export const MOCK_HEALTH: Health = {
  status: 'ok',
  token_ok: true,
  db_ok: true,
  last_scan_at: minutesAgo(6),
  last_scan_error: null,
};
