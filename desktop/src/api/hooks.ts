import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  cartAdd,
  cartRemove,
  createWatchItem,
  deleteWatchItem,
  getCatalogProgress,
  getCart,
  getConfig,
  getDeals,
  getHealth,
  getResolveBlueprints,
  getResolveCards,
  getResolveExpansions,
  getScanRuns,
  getWatchlist,
  patchConfig,
  patchDeal,
  patchWatchItem,
  resetWatchField,
  runScanNow,
} from './client';
import {
  getLocalScanStatus,
  runLocalScan,
  runLocalCatalogResync,
} from './localScan';
import type { CatalogResyncResult, LocalScanStatus } from './localScan';
import type { Cart, CatalogProgress, Config, Deal, Health, ResolveBlueprint, ResolveCard, ResolveExpansion, ResettableField, ScanNowResult, ScanRun, WatchItem, WatchItemCreate, WatchItemPatch } from './types';

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
 * Used by the Health view's scan history table and the Telemetry rail's live
 * scan-progress block.
 *
 * Dynamic polling:
 *   - When `activeLocalRunId` is non-null the interval drops to 2 s so live
 *     counter updates for the user-triggered run feel immediate.
 *   - When no local run is being tracked we back off to 30 s, regardless of
 *     whether some cron row happens to be open. This prevents fast-polling
 *     forever whenever an orphaned cron row lands.
 */
export function useScanRuns(activeLocalRunId: number | null = null) {
  return useQuery<ScanRun[], Error>({
    queryKey: ['scanRuns'] as const,
    queryFn: getScanRuns,
    refetchInterval: () => {
      // Poll fast only while the user has an in-flight local scan.
      if (activeLocalRunId !== null) {
        return 2_000;
      }
      return 30_000; // idle — back off to reduce Worker load
    },
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
 * Send only the changed fields (partial patch). Uses WatchItemPatch so
 * expansion_filter can be passed as number[] | null, and detection_mode /
 * max_price_cents can be passed as null to reset them to inherit (§9a).
 * Invalidates ['watchlist'].
 */
export function usePatchWatchItem() {
  const qc = useQueryClient();
  return useMutation<WatchItem, Error, { id: number; patch: WatchItemPatch }>({
    mutationFn: ({ id, patch }) => patchWatchItem(id, patch as Partial<WatchItem>),
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
 * Only 'min_discount_pct' and 'telegram_min_discount_pct' are accepted by the server.
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

/**
 * useResolveCards — search the local blueprint catalog for card names.
 *
 * Query key: ['resolve', 'cards', q]
 * Enabled only when q has at least 2 non-space chars (server returns [] below that).
 * staleTime: 5 min — the catalog grows slowly between cron runs; no need to re-hit
 * on every keystroke mount/unmount cycle.
 *
 * Returns distinct card-name rows ({name, printings, sets}) from the cached blueprints
 * table. Never hits CardTrader; never 502. Empty while the catalog is still syncing.
 */
export function useResolveCards(q: string) {
  return useQuery<ResolveCard[], Error>({
    queryKey: ['resolve', 'cards', q] as const,
    queryFn: () => getResolveCards(q),
    enabled: q.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
}

/**
 * useCatalogProgress — polls GET /api/resolve/catalog-progress.
 *
 * Returns {total, synced} so Settings and the AddFlow modal can show
 * "matching against N of M sets synced." The catalog grows one set per cron run
 * when sync is enabled, so a 30s poll is frequent enough to feel live without
 * hammering the Worker.
 */
export function useCatalogProgress() {
  return useQuery<CatalogProgress, Error>({
    queryKey: ['catalogProgress'] as const,
    queryFn: getCatalogProgress,
    refetchInterval: 30_000,
    staleTime: 25_000,
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

// ---------------------------------------------------------------------------
// Cart hooks
// ---------------------------------------------------------------------------

/**
 * useCart — GET /api/cart.
 *
 * Fetches the current CardTrader cart. staleTime of 30s is reasonable — the
 * cart only changes when the user explicitly adds/removes items, so no
 * aggressive polling is needed. Invalidated by useCartAdd / useCartRemove.
 */
export function useCart() {
  return useQuery<Cart, Error>({
    queryKey: ['cart'] as const,
    queryFn: getCart,
    staleTime: 30_000,
  });
}

/**
 * useCartAdd — POST /api/cart/add.
 *
 * Adds a quantity of a product to the cart. Invalidates ['cart'] on success
 * so the view re-fetches and reflects the updated cart immediately.
 */
export function useCartAdd() {
  const qc = useQueryClient();
  return useMutation<Cart, Error, { productId: number; quantity: number }>({
    mutationFn: ({ productId, quantity }) => cartAdd(productId, quantity),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cart'] });
    },
  });
}

/**
 * useCartRemove — POST /api/cart/remove.
 *
 * Removes a quantity of a product from the cart. Invalidates ['cart'] on
 * success so the view re-fetches and reflects the updated cart immediately.
 */
export function useCartRemove() {
  const qc = useQueryClient();
  return useMutation<Cart, Error, { productId: number; quantity: number }>({
    mutationFn: ({ productId, quantity }) => cartRemove(productId, quantity),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cart'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Local scan hooks (Tauri sidecar — device-local, not cloud)
// ---------------------------------------------------------------------------

/**
 * useLocalScanStatus — queries whether local scan credentials are configured
 * on this device.
 *
 * Device-local data (not cloud server state), but Query is correct here for
 * caching and cross-component consistency. staleTime of 30s is generous since
 * status only changes when the user saves new credentials in Settings.
 *
 * Falls back to { configured: false, hasTelegram: false } if the Tauri host
 * is unavailable (plain browser dev session) — never throws.
 */
export function useLocalScanStatus() {
  return useQuery<LocalScanStatus, Error>({
    queryKey: ['localScanStatus'] as const,
    queryFn: getLocalScanStatus,
    staleTime: 30_000,
  });
}

/**
 * useRunLocalScan — fires the local sidecar scan (detached).
 *
 * Returns once the sidecar emits its "started" event — the scan continues
 * running in the background. Invalidates ['scanRuns'] and ['health'] on
 * success so the Health view shows the in-progress run immediately.
 *
 * Does NOT invalidate ['deals'] here — the sweep may take minutes; results
 * surface naturally as the scan_runs polling (Health) and deal-feed polling
 * pick them up.
 */
export function useRunLocalScan() {
  const qc = useQueryClient();
  return useMutation<{ started: boolean; runId: number | null }, Error, void>({
    mutationFn: () => runLocalScan(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scanRuns'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}

/**
 * useRunLocalCatalogResync — fires the local sidecar in catalog-resync mode
 * (detached) for a full-heal blueprint re-pull, bypassing the cron's "new sets
 * only" refresh window.
 *
 * Returns once the sidecar emits its "started" event; the re-pull continues for
 * ~13 minutes. Invalidates ['catalogProgress'] and the ['resolve'] caches so
 * the add-card search picks up newly-pulled cards as they land.
 */
export function useRunLocalCatalogResync() {
  const qc = useQueryClient();
  return useMutation<CatalogResyncResult, Error, void>({
    mutationFn: () => runLocalCatalogResync(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalogProgress'] });
      void qc.invalidateQueries({ queryKey: ['resolve'] });
    },
  });
}
