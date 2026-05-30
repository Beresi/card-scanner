/**
 * Mock scan runs — 10 rows, mostly clean, 1-2 with an error string so the
 * health log warn-row expands. Shape MUST satisfy ScanRun exactly.
 *
 * started_at / finished_at are ~1 minute apart per run (realistic scan time).
 * Rows span the last ~10 hours (roughly one per hour, matching the cron).
 */
import type { ScanRun } from '../api/types';
import { minutesAgo } from './utils';

export const MOCK_SCAN_RUNS: ScanRun[] = [
  {
    id: 412,
    started_at: minutesAgo(6),
    finished_at: minutesAgo(5),
    watch_items_scanned: 14,
    blueprints_scanned: 1247,
    api_calls: 11,
    deals_found: 4,
    telegram_sent: 3,
    error: null,
  },
  {
    id: 411,
    started_at: minutesAgo(66),
    finished_at: minutesAgo(65),
    watch_items_scanned: 14,
    blueprints_scanned: 1247,
    api_calls: 11,
    deals_found: 2,
    telegram_sent: 1,
    error: null,
  },
  {
    id: 410,
    started_at: minutesAgo(126),
    finished_at: minutesAgo(125),
    watch_items_scanned: 14,
    blueprints_scanned: 1247,
    api_calls: 11,
    deals_found: 1,
    telegram_sent: 0,
    error: null,
  },
  {
    id: 409,
    started_at: minutesAgo(186),
    finished_at: minutesAgo(185),
    watch_items_scanned: 14,
    blueprints_scanned: 1245,
    api_calls: 11,
    deals_found: 1,
    telegram_sent: 0,
    error: null,
  },
  {
    id: 408,
    started_at: minutesAgo(246),
    finished_at: minutesAgo(245),
    watch_items_scanned: 14,
    blueprints_scanned: 1245,
    api_calls: 12,
    deals_found: 0,
    telegram_sent: 0,
    // Non-fatal: one blueprint skipped after 429 backoff
    error: 'blueprint 100503: HTTP 429 — backed off, skipped',
  },
  {
    id: 407,
    started_at: minutesAgo(306),
    finished_at: minutesAgo(305),
    watch_items_scanned: 14,
    blueprints_scanned: 1245,
    api_calls: 11,
    deals_found: 3,
    telegram_sent: 2,
    error: null,
  },
  {
    id: 406,
    started_at: minutesAgo(366),
    finished_at: minutesAgo(365),
    watch_items_scanned: 14,
    blueprints_scanned: 1244,
    api_calls: 11,
    deals_found: 0,
    telegram_sent: 0,
    error: null,
  },
  {
    id: 405,
    started_at: minutesAgo(426),
    finished_at: minutesAgo(425),
    watch_items_scanned: 14,
    blueprints_scanned: 1244,
    api_calls: 11,
    deals_found: 2,
    telegram_sent: 1,
    error: null,
  },
  {
    id: 404,
    started_at: minutesAgo(486),
    finished_at: minutesAgo(485),
    watch_items_scanned: 14,
    blueprints_scanned: 1244,
    api_calls: 13,
    deals_found: 0,
    telegram_sent: 0,
    // CardTrader /info validation failed — token check error
    error: 'GET /info returned 401 — token validation failed; scan aborted',
  },
  {
    id: 403,
    started_at: minutesAgo(546),
    finished_at: minutesAgo(545),
    watch_items_scanned: 13,
    blueprints_scanned: 1201,
    api_calls: 10,
    deals_found: 5,
    telegram_sent: 4,
    error: null,
  },
];
