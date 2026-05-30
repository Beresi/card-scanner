/**
 * Mock hooks — thin in-memory replacements for the real TanStack Query hooks.
 *
 * CONTRACT: every hook returns an object with the same `{ data, isLoading, error }`
 * surface that TanStack Query's useQuery returns, so view components can swap
 *   import { useDeals }     from '../api/hooks'
 * for
 *   import { useMockDeals } from '../mock/hooks'
 * with NO other change.
 *
 * Watchlist and config also expose in-memory mutators so the inspector, add-flow,
 * and Settings views are interactive without a real API.
 */
import { useMemo, useState } from 'react';

import type { Config, Deal, Health, WatchItem } from '../api/types';
import type { ScanRun } from '../api/types';
import type { DealFilters } from '../api/hooks';
import { MOCK_DEALS } from './deals';
import { MOCK_WATCHLIST } from './watchlist';
import { MOCK_CONFIG } from './config';
import { MOCK_HEALTH } from './health';
import { MOCK_SCAN_RUNS } from './scanRuns';
import {
  selectTelemetry,
  type TelemetryStats,
} from './selectors';

// ---------------------------------------------------------------------------
// Shared query-result wrapper type (mirrors TanStack UseQueryResult subset)
// ---------------------------------------------------------------------------

export interface MockQueryResult<T> {
  data: T;
  isLoading: false;
  error: null;
}

// ---------------------------------------------------------------------------
// useMockDeals
//
// Applies the same server-side filtering logic that GET /api/deals?… would:
//   status='open'  → hide dismissed deals (default)
//   status='all'   → include dismissed
//   min_discount   → >= value
//   watchlist_id   → exact match
//   priority       → exact match
// ---------------------------------------------------------------------------

export function useMockDeals(
  filters: DealFilters = {},
): MockQueryResult<Deal[]> {
  const data = useMemo(() => {
    let list = MOCK_DEALS.slice();

    // status filter: 'open' (default) hides dismissed; 'all' shows everything
    if (!filters.status || filters.status === 'open') {
      list = list.filter((d) => d.dismissed === 0);
    }

    if (filters.min_discount !== undefined) {
      list = list.filter((d) => d.discount_pct >= filters.min_discount!);
    }

    if (filters.watchlist_id !== undefined) {
      list = list.filter((d) => d.watchlist_id === filters.watchlist_id);
    }

    if (filters.priority !== undefined) {
      list = list.filter((d) => d.priority === filters.priority);
    }

    return list;
  }, [
    filters.status,
    filters.min_discount,
    filters.watchlist_id,
    filters.priority,
  ]);

  return { data, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// useMockConfig + useMockConfigStore
//
// A tiny module-level mutable store so Settings can PATCH config and any
// component that calls useMockConfig() reads back the updated value.
//
// useMockConfigStore() → [config, patchConfig]  — for Settings (read + write)
// useMockConfig()      → { data, isLoading, error }  — for read-only consumers
// ---------------------------------------------------------------------------

// Module-level mutable store — survives re-renders, shared across hook calls
// within the same session (resets on page reload).
let _config: Config = { ...MOCK_CONFIG };
const _configListeners: Set<() => void> = new Set();

function _notifyConfigListeners() {
  _configListeners.forEach((fn) => fn());
}

/**
 * useMockConfigStore — returns the current config and a patchConfig mutator.
 * Intended for the Settings view which both reads and writes.
 *
 * @returns [config, patchConfig]
 */
export function useMockConfigStore(): [Config, (patch: Partial<Config>) => void] {
  const [, rerender] = useState(0);

  // Register / unregister listener for cross-component sync
  useMemo(() => {
    const trigger = () => rerender((n) => n + 1);
    _configListeners.add(trigger);
    return () => _configListeners.delete(trigger);
  }, []);

  function patchConfig(patch: Partial<Config>) {
    _config = { ...(_config), ...patch };
    _notifyConfigListeners();
  }

  return [_config, patchConfig];
}

/**
 * useMockConfig — read-only view of the config (mirrors useConfig shape).
 */
export function useMockConfig(): MockQueryResult<Config> {
  const [config] = useMockConfigStore();
  return { data: config, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// useMockWatchlist  (module-level shared store — same pattern as useMockConfig)
//
// Module-level mutable state + listener Set so that Watchlist (center) and
// WatchInspector / WatchSummary (right rail) always share the SAME snapshot.
// Any component can call useMockWatchlist() and will automatically re-render
// when any mutation fires _notifyWatchlistListeners().
//
// Returned shape:
//   {
//     data: WatchItem[];          — full list (for the table view)
//     isLoading: false;
//     error: null;
//     items: WatchItem[];         — alias for data (ergonomic destructuring)
//     selectedId: number | null;  — currently selected row
//     addFlowOpen: boolean;       — whether the AddFlow modal is open
//     select(id: number | null): void;
//     openAddFlow(): void;
//     closeAddFlow(): void;
//     patchItem(id: number, patch: Partial<WatchItem>): void;
//     resetField(id: number, field: keyof WatchItem): void;
//     addItem(partial: Pick<WatchItem,'type'|'cardtrader_id'|'label'|'game_id'>): void;
//     removeItem(id: number): void;
//     toggleActive(id: number): void;
//   }
// ---------------------------------------------------------------------------

export interface WatchlistMutators {
  /** Full item list — same as .data, provided for ergonomic destructuring */
  items: WatchItem[];
  /** Currently selected row id (for the inspector panel) */
  selectedId: number | null;
  /** Whether the AddFlow modal is open (shared so center + summary can both trigger it) */
  addFlowOpen: boolean;
  /** Select a row (or deselect with null) */
  select: (id: number | null) => void;
  /** Open the AddFlow modal */
  openAddFlow: () => void;
  /** Close the AddFlow modal */
  closeAddFlow: () => void;
  /** Partially update a watch item (mirrors PATCH /api/watchlist/:id) */
  patchItem: (id: number, patch: Partial<WatchItem>) => void;
  /**
   * Reset an override field back to null / inherit
   * (mirrors PATCH /api/watchlist/:id/reset { field }).
   * Only nullable override columns may be reset.
   */
  resetField: (id: number, field: keyof WatchItem) => void;
  /**
   * Add a new watch item. Override columns are NOT pre-filled —
   * new tickets are born inheriting (all override columns null).
   */
  addItem: (
    partial: Pick<WatchItem, 'type' | 'cardtrader_id' | 'label' | 'game_id'>,
  ) => void;
  /** Remove a watch item (mirrors DELETE /api/watchlist/:id) */
  removeItem: (id: number) => void;
  /** Flip active 0↔1 */
  toggleActive: (id: number) => void;
}

export interface MockWatchlistResult extends MockQueryResult<WatchItem[]>, WatchlistMutators {}

// ---------------------------------------------------------------------------
// Module-level state — shared across all useMockWatchlist() callers
// ---------------------------------------------------------------------------

interface WatchlistState {
  items: WatchItem[];
  selectedId: number | null;
  addFlowOpen: boolean;
}

let _watchlist: WatchlistState = {
  items: [...MOCK_WATCHLIST],
  selectedId: null,
  addFlowOpen: false,
};

const _watchlistListeners: Set<() => void> = new Set();

function _notifyWatchlistListeners() {
  _watchlistListeners.forEach((fn) => fn());
}

let _nextWatchlistId = 100;

function _nowStr(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Mutators — operate on module-level state and notify all listeners
// ---------------------------------------------------------------------------

function _select(id: number | null) {
  _watchlist = { ..._watchlist, selectedId: id };
  _notifyWatchlistListeners();
}

function _openAddFlow() {
  _watchlist = { ..._watchlist, addFlowOpen: true };
  _notifyWatchlistListeners();
}

function _closeAddFlow() {
  _watchlist = { ..._watchlist, addFlowOpen: false };
  _notifyWatchlistListeners();
}

function _patchItem(id: number, patch: Partial<WatchItem>) {
  _watchlist = {
    ..._watchlist,
    items: _watchlist.items.map((item) =>
      item.id === id
        ? { ...item, ...patch, updated_at: _nowStr() }
        : item,
    ),
  };
  _notifyWatchlistListeners();
}

function _resetField(id: number, field: keyof WatchItem) {
  _watchlist = {
    ..._watchlist,
    items: _watchlist.items.map((item) => {
      if (item.id !== id) return item;
      return { ...item, [field]: null, updated_at: _nowStr() };
    }),
  };
  _notifyWatchlistListeners();
}

function _addItem(
  partial: Pick<WatchItem, 'type' | 'cardtrader_id' | 'label' | 'game_id'>,
) {
  const now = _nowStr();
  const newItem: WatchItem = {
    id: _nextWatchlistId++,
    type: partial.type,
    cardtrader_id: partial.cardtrader_id,
    label: partial.label,
    game_id: partial.game_id,
    // All override columns null — new tickets are born inheriting
    min_condition: null,
    foil_pref: null,
    allow_graded: null,
    threshold_pct: null,
    importance: null,
    telegram_enabled: null,
    telegram_min_discount_pct: null,
    telegram_max_price_cents: null,
    telegram_min_savings_cents: null,
    active: 1,
    created_at: now,
    updated_at: now,
  };
  _watchlist = {
    ..._watchlist,
    items: [newItem, ..._watchlist.items],
    selectedId: newItem.id,
  };
  _notifyWatchlistListeners();
}

function _removeItem(id: number) {
  _watchlist = {
    ..._watchlist,
    items: _watchlist.items.filter((item) => item.id !== id),
    selectedId: _watchlist.selectedId === id ? null : _watchlist.selectedId,
  };
  _notifyWatchlistListeners();
}

function _toggleActive(id: number) {
  _watchlist = {
    ..._watchlist,
    items: _watchlist.items.map((item) =>
      item.id === id
        ? { ...item, active: item.active === 1 ? 0 : 1, updated_at: _nowStr() }
        : item,
    ),
  };
  _notifyWatchlistListeners();
}

// ---------------------------------------------------------------------------
// useMockWatchlist — subscribe to the shared store
// ---------------------------------------------------------------------------

export function useMockWatchlist(): MockWatchlistResult {
  const [, rerender] = useState(0);

  // Register / unregister listener for cross-component sync (same pattern as config)
  useMemo(() => {
    const trigger = () => rerender((n) => n + 1);
    _watchlistListeners.add(trigger);
    return () => _watchlistListeners.delete(trigger);
  }, []);

  const { items, selectedId, addFlowOpen } = _watchlist;

  return {
    data: items,
    isLoading: false,
    error: null,
    items,
    selectedId,
    addFlowOpen,
    select: _select,
    openAddFlow: _openAddFlow,
    closeAddFlow: _closeAddFlow,
    patchItem: _patchItem,
    resetField: _resetField,
    addItem: _addItem,
    removeItem: _removeItem,
    toggleActive: _toggleActive,
  };
}

// ---------------------------------------------------------------------------
// useMockHealth
// ---------------------------------------------------------------------------

export function useMockHealth(): MockQueryResult<Health> {
  return { data: MOCK_HEALTH, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// useMockScanRuns
// ---------------------------------------------------------------------------

export function useMockScanRuns(): MockQueryResult<ScanRun[]> {
  return { data: MOCK_SCAN_RUNS, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// useMockTelemetry
//
// Computes the right-rail telemetry stats from MOCK_DEALS + MOCK_SCAN_RUNS.
// Re-memoizes whenever the deal list or scan runs change.
// ---------------------------------------------------------------------------

export function useMockTelemetry(): TelemetryStats {
  const { data: deals } = useMockDeals({ status: 'all' });
  const { data: scanRuns } = useMockScanRuns();
  return useMemo(
    () => selectTelemetry(deals, scanRuns),
    [deals, scanRuns],
  );
}
