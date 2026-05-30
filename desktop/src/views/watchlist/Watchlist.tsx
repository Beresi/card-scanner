/**
 * Watchlist — center-stage view.
 *
 * Layout:
 *   command bar (.wlist-cmd) — search, filter Segmented, sort Select, Add button
 *   table (.wtable) — sticky .wt-head + scrollable .wt-body of WatchRow
 *   AddFlow modal (single instance, open state from shared store)
 *
 * Filter/sort are LOCAL state (ephemeral UI). They drive the rendered list
 * by actually slicing the items array — not by hiding DOM nodes.
 *
 * Filter options:
 *   All      — no filter
 *   Active   — item.active === 1
 *   High     — item.importance === 'high'
 *   TG       — item.telegram_enabled === 1
 *
 * Sort options:
 *   Recent     — descending by id (most-recently added first)
 *   Name       — ascending label alpha
 *   Importance — high first
 *
 * (Hits sort dropped: WatchItem has no hits field.)
 *
 * Search filters label text (case-insensitive substring match), applied
 * on top of the Segmented filter.
 *
 * AddFlow open state lives in the shared watchlist store so WatchSummary's
 * "Add card or set" button also works (single <AddFlow> rendered here).
 */
import { useState } from 'react';

import type { WatchItem } from '../../api/types';
import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { useMockConfig } from '../../mock/hooks';
import { useMockWatchlist } from '../../mock/hooks';
import { AddFlow } from './AddFlow';
import { WatchRow } from './WatchRow';

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'active' | 'high' | 'tg';
type SortKey   = 'recent' | 'name' | 'importance';

const FILTER_OPTIONS = [
  { value: 'all',    label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'high',   label: 'High' },
  { value: 'tg',     label: 'TG' },
];

const SORT_OPTIONS = [
  { value: 'recent',     label: 'Recent' },
  { value: 'name',       label: 'Name' },
  { value: 'importance', label: 'Importance' },
];

// ---------------------------------------------------------------------------
// Filtering + sorting (pure — no DOM mutation)
// ---------------------------------------------------------------------------

function applyFilter(items: WatchItem[], tab: FilterTab, q: string): WatchItem[] {
  let list = items;

  if (tab === 'active')     list = list.filter((w) => w.active === 1);
  else if (tab === 'high')  list = list.filter((w) => w.importance === 'high');
  else if (tab === 'tg')    list = list.filter((w) => w.telegram_enabled === 1);

  if (q.trim()) {
    const lower = q.toLowerCase();
    list = list.filter((w) => w.label.toLowerCase().includes(lower));
  }

  return list;
}

function applySort(items: WatchItem[], sort: SortKey): WatchItem[] {
  const sorted = [...items];
  if (sort === 'recent') {
    sorted.sort((a, b) => b.id - a.id);
  } else if (sort === 'name') {
    sorted.sort((a, b) => a.label.localeCompare(b.label));
  } else if (sort === 'importance') {
    sorted.sort((a, b) => {
      const aHigh = a.importance === 'high' ? 1 : 0;
      const bHigh = b.importance === 'high' ? 1 : 0;
      return bHigh - aHigh;
    });
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Watchlist component
// ---------------------------------------------------------------------------

export function Watchlist() {
  const {
    items,
    selectedId,
    addFlowOpen,
    select,
    openAddFlow,
    closeAddFlow,
    toggleActive,
  } = useMockWatchlist();
  const { data: config } = useMockConfig();

  // Ephemeral UI state — filter/sort/search stay in local state
  const [filter, setFilter] = useState<FilterTab>('all');
  const [sort, setSort]     = useState<SortKey>('recent');
  const [q, setQ]           = useState('');

  const filtered = applySort(applyFilter(items, filter, q), sort);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: 'var(--pad)',
      }}
    >
      {/* Command bar */}
      <div className="wlist-cmd">
        <div className="wlist-cmd-left">
          {/* Search */}
          <div className="wlist-search">
            <Icon name="search" size={14} svgProps={{ style: { color: 'var(--text-dim)' } }} />
            <input
              className="cb-input"
              style={{ border: 0, paddingLeft: 0, background: 'transparent' } as React.CSSProperties}
              placeholder="filter cards &amp; sets…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Filter watchlist by name"
            />
          </div>

          {/* Filter segmented */}
          <Segmented
            value={filter}
            options={FILTER_OPTIONS}
            onChange={(v) => setFilter(v as FilterTab)}
            size="sm"
          />
        </div>

        <div className="wlist-cmd-right">
          {/* Sort select */}
          <div className="wlist-sort">
            <span className="cb-eyebrow">sort</span>
            <Select
              value={sort}
              options={SORT_OPTIONS}
              onChange={(v) => setSort(v as SortKey)}
              size="sm"
              aria-label="Sort watchlist"
            />
          </div>

          {/* Add button */}
          <Btn
            variant="primary"
            onClick={openAddFlow}
            className="cb-btn-sm"
            aria-label="Add card or set to watchlist"
          >
            <Icon name="plus" size={14} />
            Add
          </Btn>
        </div>
      </div>

      {/* Table */}
      <div
        className="wtable"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {/* Sticky header */}
        <div className="wt-head" role="row" aria-rowindex={1}>
          <span role="columnheader" aria-label="Type" />
          <span role="columnheader">Card / Set</span>
          <span className="wr-c" role="columnheader">Cond</span>
          <span className="wr-c" role="columnheader">Foil</span>
          <span className="wr-c" role="columnheader">Thresh</span>
          <span className="wr-c" role="columnheader">Imp</span>
          <span className="wr-c" role="columnheader">TG</span>
          <span className="wr-c" role="columnheader">Hits</span>
          <span className="wr-c" role="columnheader">On</span>
        </div>

        {/* Scrollable body */}
        <div
          className="wt-body"
          role="rowgroup"
          aria-live="polite"
          aria-label="Watchlist items"
          style={{ flex: 1, minHeight: 0 }}
        >
          {filtered.length === 0 ? (
            <div className="wt-empty" role="row">
              <span role="cell">No items match this filter.</span>
            </div>
          ) : (
            filtered.map((item) => (
              <WatchRow
                key={item.id}
                item={item}
                config={config}
                isSelected={item.id === selectedId}
                onSelect={select}
                onToggleActive={toggleActive}
              />
            ))
          )}
        </div>
      </div>

      {/* AddFlow modal — single instance, open state from shared store */}
      <AddFlow open={addFlowOpen} onClose={closeAddFlow} />
    </div>
  );
}
