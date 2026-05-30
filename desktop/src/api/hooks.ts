import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createWatchItem,
  deleteWatchItem,
  getConfig,
  getDeals,
  getHealth,
  getResolveBlueprints,
  getResolveExpansions,
  getScanRuns,
  getWatchlist,
  patchConfig,
  patchDeal,
  patchWatchItem,
  resetWatchField,
  runScanNow,
} from './client';
import type { Config, Deal, Health, ResolveBlueprint, ResolveExpansion, ResettableField, ScanNowResult, ScanRun, WatchItem, WatchItemCreate } from './types';

// ---------------------------------------------------------------------------
// Filter shape — used by the Deal Feed command bar
// ---------------------------------------------------------------------------
export interface DealFilters {
  status?: 'open' | 'all';
  min_discount?: number;
  watchlist_id?: number;
  priority?: 'high' | 'normal';
}

// ---------------------------------------------------------------------------
// Deal Feed hooks
// ---------------------------------------------------------------------------

/**
 * useDeals — fetches the deal list filtered by the command bar controls.
 *
 * The filter object is part of the query key so any control change triggers
 * a real refetch against GET /api/deals?…; no client-side CSS hiding.
 */
export function useDeals(filters: DealFilters = {}) {
  return useQuery<Deal[], Error>({
    queryKey: ['deals', filters] as const,
    queryFn: () => getDeals(filters),
  });
}

/**
 * useDealMutation — mark-seen / dismiss a deal.
 *
 * Invalidates ['deals'] on success so all active deal queries (regardless of
 * the filter combination) re-fetch and reflect the change.
 */
export function useDealMutation() {
  const qc = useQueryClient();
  return useMutation<
    Deal,
    Error,
    { id: number; patch: { seen?: boolean; dismissed?: boolean } }
  >({
    mutationFn: ({ id, patch }) => patchDeal(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Config hook
// ---------------------------------------------------------------------------

/**
 * useConfig — reads the single config row.
 *
 * Used by Settings view and by the watchlist inspector to display inherit
 * baseline values (§9a). Stale after 30s (global default from QueryClient).
 */
export function useConfig() {
  return useQuery<Config, Error>({
    queryKey: ['config'] as const,
    queryFn: getConfig,
  });
}

/**
 * useConfigMutation — saves partial config changes.
 *
 * Invalidates ['config'] on success so Settings and the inspector both
 * reflect the updated defaults immediately.
 */
export function useConfigMutation() {
  const qc = useQueryClient();
  return useMutation<Config, Error, Partial<Config>>({
    mutationFn: (body) => patchConfig(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Watchlist hook
// ---------------------------------------------------------------------------

/**
 * useWatchlist — fetches all watchlist items.
 *
 * Used by the Watchlist view and by the Deal Feed's watch-item <select>.
 */
export function useWatchlist() {
  return useQuery<WatchItem[], Error>({
    queryKey: ['watchlist'] as const,
    queryFn: getWatchlist,
  });
}

// ---------------------------------------------------------------------------
// Health hook
// ---------------------------------------------------------------------------

/**
 * useHealth — fetches the health endpoint.
 *
 * Used by the Health view and the "API 200" status strip. Failures must flip
 * the strip to an error state — never silently empty (coding-standards §error).
 */
export function useHealth() {
  return useQuery<Health, Error>({
    queryKey: ['health'] as const,
    queryFn: getHealth,
    // Poll so the chunked scan progress (scan_done / scan_total) climbs live,
    // and any stale cached health (e.g. from before a deploy) self-corrects.
    refetchInterval: 15_000,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Scan runs hook
// ---------------------------------------------------------------------------

/**
 * useScanRuns — fetches the scan run log (newest first, ≤20 rows).
 *
 * Used by the Health view's scan history table.
 */
export function useScanRuns() {
  return useQuery<ScanRun[], Error>({
    queryKey: ['scanRuns'] as const,
    queryFn: getScanRuns,
    // Poll so the Health view's run log + counts refresh as the cron ticks.
    refetchInterval: 30_000,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Watchlist mutations
// ---------------------------------------------------------------------------

/**
 * useCreateWatchItem — POST /api/watchlist.
 *
 * Override columns omitted from the body → new ticket is born inheriting (§9a).
 * Invalidates ['watchlist'] so the table and inspector reflect the new item.
 */
export function useCreateWatchItem() {
  const qc = useQueryClient();
  return useMutation<WatchItem, Error, WatchItemCreate>({
    mutationFn: (body) => createWatchItem(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
}

/**
 * usePatchWatchItem — PATCH /api/watchlist/:id.
 *
 * Send only the changed fields (partial patch). Invalidates ['watchlist'].
 */
export function usePatchWatchItem() {
  const qc = useQueryClient();
  return useMutation<WatchItem, Error, { id: number; patch: Partial<WatchItem> }>({
    mutationFn: ({ id, patch }) => patchWatchItem(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
}

/**
 * useDeleteWatchItem — DELETE /api/watchlist/:id.
 *
 * Cascade-deletes the item's deals, so both ['watchlist'] and ['deals'] are
 * invalidated on success.
 */
export function useDeleteWatchItem() {
  const qc = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id) => deleteWatchItem(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
      void qc.invalidateQueries({ queryKey: ['deals'] });
    },
  });
}

/**
 * useResetWatchField — PATCH /api/watchlist/:id/reset { field }.
 *
 * Nulls a single resettable override column back to inherit (§9a).
 * Only 'threshold_pct' and 'telegram_min_discount_pct' are accepted by the server.
 * Invalidates ['watchlist'] so the inspector flips back to "inherit · {default}".
 */
export function useResetWatchField() {
  const qc = useQueryClient();
  return useMutation<WatchItem, Error, { id: number; field: ResettableField }>({
    mutationFn: ({ id, field }) => resetWatchField(id, field),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Resolve / search hooks (add-flow search-as-you-type)
// ---------------------------------------------------------------------------

/**
 * useResolveExpansions — search expansions (sets) by name.
 *
 * Query key: ['resolve', 'expansions', q]
 * Enabled only when q has at least 2 non-space chars (avoids firing on empty/1-char).
 * staleTime: 5 min — the server cache is stable; no need to refetch on every re-mount.
 *
 * First call may take ~1-2s (server fetches all expansions from CardTrader + caches);
 * subsequent calls for any q hit the server cache and are fast.
 */
export function useResolveExpansions(q: string) {
  return useQuery<ResolveExpansion[], Error>({
    queryKey: ['resolve', 'expansions', q] as const,
    queryFn: () => getResolveExpansions(q),
    enabled: q.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
}

/**
 * useResolveBlueprints — search blueprints (cards) within a chosen expansion.
 *
 * Query key: ['resolve', 'blueprints', expansionId, q]
 * Enabled only when expansionId is non-null AND q has at least 2 non-space chars.
 * staleTime: 5 min — set blueprint lists are stable within a session.
 *
 * First call for a given expansion may take ~1-2s (server fetches that set's blueprints
 * from CardTrader + caches); subsequent q changes within that expansion are fast.
 */
export function useResolveBlueprints(expansionId: number | null, q: string) {
  return useQuery<ResolveBlueprint[], Error>({
    queryKey: ['resolve', 'blueprints', expansionId, q] as const,
    queryFn: () => getResolveBlueprints(expansionId!, q),
    enabled: expansionId !== null && q.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Scan now mutation
// ---------------------------------------------------------------------------

/**
 * useRunScan — POST /api/scan/run-now.
 *
 * Triggers an immediate scan. On success invalidates ['deals'], ['scanRuns'],
 * and ['health'] so all live queries pick up new data when the scan finishes.
 */
export function useRunScan() {
  const qc = useQueryClient();
  return useMutation<ScanNowResult, Error, void>({
    mutationFn: () => runScanNow(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      void qc.invalidateQueries({ queryKey: ['scanRuns'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}
