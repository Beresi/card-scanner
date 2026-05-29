---
name: view-dev
description: Load when building or editing a VIEW — a routed screen in the React + Vite + TS SPA (Tauri webview). Covers the four views (Deal Feed, Watchlist, Settings, Health) under src/views/<kebab>/, the 3-column shell they mount into, client-router route registration, composing components over a TanStack Query data layer, contextual right rails, and loading/empty/error states. NOT for the Worker/Hono backend (backend-dev) or shared primitives (component-dev).
---

# View Development

## Purpose
A **view** is one routed screen in the desktop SPA — a React + Vite + TypeScript app running
in a **Tauri v2 webview** (NOT Next.js: no App Router, no `page.tsx`, no Server Components, no
SSR, no `next-intl`/i18n, no metadata exports). Each of the four views lives in its own folder
under `src/views/<kebab>/` and mounts into the **3-column shell** (`LeftRail · CenterStage ·
RightRail`). A view composes shared components from `src/components/`, gets all server data from
the cloud Hono `/api/*` over **TanStack Query**, keeps only ephemeral UI bits in component state,
and renders explicit **loading / empty / error** states. Navigation is instant and client-side —
**no page reloads**.

The four views and their routes (the right rail is contextual per view):

| Path | View | Folder | Right rail |
|---|---|---|---|
| `/` (or `/feed`) | Deal Feed | `src/views/deal-feed/` | Telemetry |
| `/watchlist` | Watchlist | `src/views/watchlist/` | Inspector / summary |
| `/settings` | Settings | `src/views/settings/` | Telemetry |
| `/health` | Health | `src/views/health/` | Telemetry |

## Core patterns

### 1. A routed view: query hook + component grid + loading/empty/error
A view is a thin orchestrator. It reads filter/UI state, calls a **query hook**, and renders one
of four branches — loading, error, empty, data. It never holds server data in `useState`; that is
TanStack Query's job. Filters live in component state and **actually drive the query** (they go
into the query key and the request), they do not just hide cards with CSS.

```tsx
// src/views/deal-feed/DealFeedView.tsx
import { useState } from 'react';

import { Panel, EmptyState, ErrorState, Spinner } from '@/components';
import { DealCard } from './DealCard';
import { FeedCommandBar } from './FeedCommandBar';
import { useDeals } from './useDeals';
import type { DealFilters } from './types';

export function DealFeedView() {
  // Ephemeral UI state only — server data comes from the query.
  const [filters, setFilters] = useState<DealFilters>({
    status: 'open',
    priority: 'any',
    minDiscount: 40,
    watchlistId: null,
  });

  // Filters are part of the query key → changing them refetches/refilters live.
  const { data: deals, isPending, isError, error, refetch } = useDeals(filters);

  return (
    <section className="view view--feed">
      <FeedCommandBar filters={filters} onChange={setFilters} />

      {isPending ? (
        <Spinner label="Loading deals…" />
      ) : isError ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : deals.length === 0 ? (
        <EmptyState icon="radar" title="No deals match these filters." />
      ) : (
        // min-height:0 + overflow-y:auto on this grid, or the shell row won't scroll.
        <div className="deal-grid">
          {deals.map((deal) => (
            <DealCard key={deal.id} deal={deal} />
          ))}
        </div>
      )}
    </section>
  );
}
```

```tsx
// src/views/deal-feed/useDeals.ts — the view's data layer (TanStack Query).
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Deal } from '@/types';
import type { DealFilters } from './types';

// Wire format is snake_case (mirrors D1 + CardTrader). Money is integer CENTS.
async function fetchDeals(f: DealFilters): Promise<Deal[]> {
  const qs = new URLSearchParams({
    status: f.status,
    priority: f.priority,
    min_discount: String(f.minDiscount),
    ...(f.watchlistId ? { watchlist_id: String(f.watchlistId) } : {}),
  });
  return api.get<Deal[]>(`/api/deals?${qs}`);
}

export function useDeals(filters: DealFilters) {
  return useQuery({
    queryKey: ['deals', filters], // filters in the key → refetch when they change
    queryFn: () => fetchDeals(filters),
  });
}
```

### 2. Registering the view in the SPA router
Routes are defined once in the client router (React Router shown; TanStack Router is equivalent —
library is TBD per the desktop-shell doc). The router lives **inside** the shell so navigating
swaps only the center stage and the contextual right rail — the rail picks its content off the
active route, and there is no full-document reload. Code-split each view with `lazy()`.

```tsx
// src/App.tsx — router mounted inside the persistent 3-column shell.
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from '@/shell/Shell';
import { Spinner } from '@/components';

const DealFeedView = lazy(() => import('@/views/deal-feed/DealFeedView'));
const WatchlistView = lazy(() => import('@/views/watchlist/WatchlistView'));
const SettingsView = lazy(() => import('@/views/settings/SettingsView'));
const HealthView = lazy(() => import('@/views/health/HealthView'));

export function App() {
  return (
    <Shell>
      {/* Shell renders LeftRail + CenterStage(scroll area) + contextual RightRail */}
      <Suspense fallback={<Spinner label="Loading view…" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="/feed" element={<DealFeedView />} />
          <Route path="/watchlist" element={<WatchlistView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/health" element={<HealthView />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
```

```tsx
// Navigation is client-side — never an <a href> that reloads the document.
import { NavLink } from 'react-router-dom';
// In LeftRail: active item gets cyan text + soft fill + 2px left bar.
<NavLink to="/feed" className={({ isActive }) => (isActive ? 'nav nav--active' : 'nav')}>
  Deal Feed
</NavLink>
```

## Standards
@docs/standards/coding-standards.md
@docs/standards/shared-standards.md

## Examples (Good / Bad)

**Good — server data via a query hook, only UI state local, all four branches handled**
```tsx
const [selectedId, setSelectedId] = useState<number | null>(null); // ephemeral UI
const { data, isPending, isError } = useWatchlist();               // server data
if (isPending) return <Spinner />;
if (isError) return <ErrorState onRetry={refetch} />;
if (data.length === 0) return <EmptyState title="Watchlist is empty." />;
return <WatchlistTable rows={data} selectedId={selectedId} onSelect={setSelectedId} />;
```

**Bad — Next.js / SSR patterns (this is NOT Next.js)**
```tsx
// ❌ No `page.tsx`, no Server Components, no `async function Page()`, no `await getData()`
//    at module/render top, no `generateMetadata`, no `next-intl`, no `next/link`.
export default async function Page() {        // ❌ server component pattern — does not exist here
  const deals = await fetch('/api/deals');    // ❌ no SSR data fetch
  return <DealFeed deals={deals} />;
}
```

**Bad — server data parked in useState (it goes stale, never invalidates)**
```tsx
const [deals, setDeals] = useState<Deal[]>([]);          // ❌ server data in local state
useEffect(() => { fetch('/api/deals').then(/* setDeals */); }, []); // ❌ no caching/invalidation
// ✅ Use useQuery(['deals', filters], …) instead; mutations invalidate the key.
```

**Bad — no empty state / fake filtering**
```tsx
return <div className="deal-grid">{deals.map((d) => <DealCard key={d.id} deal={d} />)}</div>;
// ❌ Renders nothing on []  — needs an explicit EmptyState branch.
// ❌ If a filter only toggles `.hidden` CSS instead of feeding the query key → fake filtering.
```

## Gotchas
- **This is a Vite SPA in a Tauri webview, NOT Next.js.** No `src/app/`, no `page.tsx`/`layout.tsx`,
  no Server Components, no SSR, no metadata exports, no `next-intl`/i18n, no `next/link`. Views are
  plain client components under `src/views/<kebab>/`, routed by a client router.
- **`min-height: 0` grid scroll trap** — the center stage and its inner scroll area each need
  `min-height: 0` (+ `overflow-y: auto` on the inner one), or the grid row grows to content height
  and the page won't scroll. A view's scrolling grid/table must live in that inner area.
- **Right rail collapses below 1180px** (`display: none`, not just narrowed). Views must stay
  functional with no rail — never put unique controls only in the rail.
- **Loading / empty / error are all required.** Surface API failures as inline UI (the "API 200"
  strip flips to error); never render a silent empty list on error. Use TanStack Query's
  `isPending` / `isError` / empty-array branches.
- **Filters must actually filter.** Filter state goes into the query key and the `GET /api/deals`
  request — never fake it by hiding cards with CSS.
- **Server data lives in TanStack Query, not `useState`.** Only ephemeral UI (selected row,
  modal/palette open, toasts, filter inputs, scan-target timestamp) is component state. Mutations
  (dismiss, mark-seen, reset-to-inherit) **invalidate** the relevant query key.
- **Money is integer cents** end to end; format only at the edge with `formatCents(cents, currency)`.
  Wire fields are `snake_case`; map to camelCase internally if you like.
- **Isolate the countdown `Clock`** into its own leaf component — a once-per-second tick in a view
  or the shell re-renders the whole tree and freezes entrance animations at `opacity: 0`.
- **Inheritance is displayed, not resolved, in the UI.** Render inherit-vs-override per field; the
  backend resolves effective values at scan time (PRD §9a). Don't compute the effective value here.
- **Buy opens the system browser** via the Tauri opener/shell plugin (`open_buy_url`) — never an
  in-webview navigation (no in-app purchase, PRD non-goal).

## Related skills
- state-management — TanStack Query patterns (query keys, invalidation, the ephemeral-vs-server split)
- component-dev — the shared primitives (`Panel`, `DealCard`, `Tag`, `InheritField`, `Clock`, …) views compose
- forms — inspector / settings / add-flow inputs (sliders, segmented, switches, inherit/override)
