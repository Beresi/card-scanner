import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getConfig,
  getDeals,
  getHealth,
  getWatchlist,
  patchConfig,
  patchDeal,
} from './client';
import type { Config, Deal, Health, WatchItem } from './types';

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
  });
}
