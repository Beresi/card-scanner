import type { Config, Deal, Health, ScanNowResult, ScanRun, WatchItem, WatchItemCreate, ResettableField } from './types';

// ---------------------------------------------------------------------------
// Environment — base URL and dev token come from Vite env vars.
// The auth token is intentionally NOT hardcoded; the fallback empty string
// means unauthenticated dev runs will get a 401 from the Worker.
// TODO: replace AUTH_TOKEN with a Tauri secure-storage get_auth_token() call
// once security-agent lands it (src-tauri stub exists).
// ---------------------------------------------------------------------------
const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

// TODO: replace with Tauri secure-storage get_auth_token() once security-agent
// lands it (src-tauri stub exists). This env-var is for local dev ONLY.
const AUTH_TOKEN: string =
  import.meta.env.VITE_DEV_AUTH_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Typed API error
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `API error ${status}: ${code}`);
    this.name = 'ApiError';
  }
}

// Narrow an unknown value to a plain object so we can safely read properties.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody =
    init.body !== undefined &&
    init.body !== null &&
    init.method !== undefined &&
    init.method !== 'GET' &&
    init.method !== 'HEAD';

  const headers: HeadersInit = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  // 204 No Content (or genuinely empty body) → return undefined cast to T
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  if (!res.ok) {
    // Try to read a JSON {error} field; tolerate non-JSON bodies.
    let code = 'request_failed';
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body['error'] === 'string') {
        code = body['error'];
      }
    } catch {
      // Non-JSON body — keep the default code.
    }
    throw new ApiError(res.status, code);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Deal filters — only the params the server understands
// ---------------------------------------------------------------------------
export interface GetDealsFilters {
  status?: 'open' | 'all';
  min_discount?: number;
  watchlist_id?: number;
  priority?: 'high' | 'normal';
}

// ---------------------------------------------------------------------------
// Typed resource helpers
// ---------------------------------------------------------------------------

/**
 * GET /api/deals
 *
 * Query-string rules (per task spec):
 * - `status` is omitted when it's 'open' (the server default); sent as 'all' when requested.
 * - `min_discount`, `watchlist_id`, `priority` are omitted when undefined or 0/empty.
 * - URLSearchParams encodes the surviving entries.
 */
export function getDeals(filters: GetDealsFilters = {}): Promise<Deal[]> {
  const params = new URLSearchParams();

  // Only send status=all explicitly; omit status=open (server default)
  if (filters.status === 'all') {
    params.set('status', 'all');
  }

  if (filters.min_discount !== undefined && filters.min_discount > 0) {
    params.set('min_discount', String(filters.min_discount));
  }

  if (filters.watchlist_id !== undefined) {
    params.set('watchlist_id', String(filters.watchlist_id));
  }

  if (filters.priority !== undefined) {
    params.set('priority', filters.priority);
  }

  const qs = params.toString();
  return apiFetch<Deal[]>(`/api/deals${qs ? `?${qs}` : ''}`);
}

/** PATCH /api/deals/:id */
export function patchDeal(
  id: number,
  body: { seen?: boolean; dismissed?: boolean },
): Promise<Deal> {
  return apiFetch<Deal>(`/api/deals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** GET /api/watchlist */
export function getWatchlist(): Promise<WatchItem[]> {
  return apiFetch<WatchItem[]>('/api/watchlist');
}

/** GET /api/config */
export function getConfig(): Promise<Config> {
  return apiFetch<Config>('/api/config');
}

/** PATCH /api/config */
export function patchConfig(body: Partial<Config>): Promise<Config> {
  return apiFetch<Config>('/api/config', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** GET /api/health */
export function getHealth(): Promise<Health> {
  return apiFetch<Health>('/api/health');
}

/** POST /api/watchlist — create a new watch item. Override fields omitted → born inheriting. */
export function createWatchItem(body: WatchItemCreate): Promise<WatchItem> {
  return apiFetch<WatchItem>('/api/watchlist', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** PATCH /api/watchlist/:id — update explicit fields only; omit unchanged fields. */
export function patchWatchItem(id: number, body: Partial<WatchItem>): Promise<WatchItem> {
  return apiFetch<WatchItem>(`/api/watchlist/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** DELETE /api/watchlist/:id — 204 No Content → undefined. */
export function deleteWatchItem(id: number): Promise<void> {
  return apiFetch<void>(`/api/watchlist/${id}`, {
    method: 'DELETE',
  });
}

/**
 * PATCH /api/watchlist/:id/reset — null a single override field back to inherit.
 * Only 'threshold_pct' and 'telegram_min_discount_pct' are accepted; others → 400.
 */
export function resetWatchField(id: number, field: ResettableField): Promise<WatchItem> {
  return apiFetch<WatchItem>(`/api/watchlist/${id}/reset`, {
    method: 'PATCH',
    body: JSON.stringify({ field }),
  });
}

/** GET /api/scan/runs — newest-first list of up to 20 scan runs. */
export function getScanRuns(): Promise<ScanRun[]> {
  return apiFetch<ScanRun[]>('/api/scan/runs');
}

// ---------------------------------------------------------------------------
// Scan now
// ---------------------------------------------------------------------------

/** POST /api/scan/run-now — trigger an immediate scan. */
export function runScanNow(): Promise<ScanNowResult> {
  return apiFetch<ScanNowResult>('/api/scan/run-now', {
    method: 'POST',
  });
}
