/**
 * selection.ts — ephemeral watchlist selection store.
 *
 * Owns two pieces of UI state that are shared between the center-stage
 * Watchlist view, the right-rail WatchInspector/WatchSummary, and App:
 *
 *   selectedId    — which WatchItem row is selected (drives the right rail)
 *   addFlowOpen   — whether the AddFlow modal is open
 *
 * Server data (the WatchItem list, Config) comes from TanStack Query hooks.
 * This module only tracks selection — no item data lives here.
 *
 * Pattern: module-level mutable state + listener Set, exposed via
 * useSyncExternalStore so every subscriber re-renders on change.
 */

import { useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

interface SelectionState {
  selectedId: number | null;
  addFlowOpen: boolean;
}

let _state: SelectionState = {
  selectedId: null,
  addFlowOpen: false,
};

const _listeners: Set<() => void> = new Set();

function _notify() {
  _listeners.forEach((fn) => fn());
}

function _subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _getSnapshot(): SelectionState {
  return _state;
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export function select(id: number | null): void {
  if (_state.selectedId === id) return;
  _state = { ..._state, selectedId: id };
  _notify();
}

export function openAddFlow(): void {
  if (_state.addFlowOpen) return;
  _state = { ..._state, addFlowOpen: true };
  _notify();
}

export function closeAddFlow(): void {
  if (!_state.addFlowOpen) return;
  _state = { ..._state, addFlowOpen: false };
  _notify();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface WatchSelection {
  selectedId: number | null;
  select: (id: number | null) => void;
  addFlowOpen: boolean;
  openAddFlow: () => void;
  closeAddFlow: () => void;
}

/**
 * useWatchSelection — subscribe to the shared ephemeral selection store.
 *
 * Returns stable function references (the module-level mutators) so callers
 * don't need to memoize callbacks that depend on this hook.
 */
export function useWatchSelection(): WatchSelection {
  const state = useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);

  return {
    selectedId: state.selectedId,
    select,
    addFlowOpen: state.addFlowOpen,
    openAddFlow,
    closeAddFlow,
  };
}
