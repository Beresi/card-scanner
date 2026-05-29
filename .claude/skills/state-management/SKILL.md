---
name: state-management
description: Client data/state for the Card // Broker desktop UI — TanStack Query for all server data (deals, watchlist, config, scan_runs, caches) with per-mutation invalidation; ONLY ephemeral UI bits in component state. Load before adding a query/mutation hook, wiring a view to the API, or deciding where a piece of state lives.
---

# State Management

## Purpose
The dashboard is a React + Vite SPA (in the Tauri webview) talking to the cloud Hono `/api`
over HTTPS. **All server data comes from the API via TanStack Query**, cached and invalidated
per mutation. **Only ephemeral UI bits live in component state** (README "State management").
There is no Next.js, no Redux, no server components.

## Core patterns

### A query hook with filters (the filter params ARE the query key)
```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/apiClient';

export interface DealFilters { status?: 'open' | 'all'; minDiscount?: number;
  watchlistId?: number; priority?: 'any' | 'high'; }

export function useDeals(filters: DealFilters) {
  return useQuery({
    queryKey: ['deals', filters],                    // filters in the key → refetch on change
    queryFn: () => api.get('/api/deals', { query: filters }),
  });
}
```

### A mutation that invalidates the right keys
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useDealPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { seen?: boolean; dismissed?: boolean } }) =>
      api.patch(`/api/deals/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] }),
  });
}
```

## The server-vs-ephemeral split
| Lives in TanStack Query (server) | Lives in component state (ephemeral) |
|---|---|
| deals, watchlist, config, scan_runs, expansion/blueprint caches, health | current view/route, selected watch-item id, add-flow-open, palette-open, toasts, scan-running flag, scan-target timestamp for the countdown |

## Invalidation map
| Mutation | Route | Invalidate |
|---|---|---|
| dismiss / mark seen | `PATCH /api/deals/:id` | `['deals']` |
| watchlist add/edit/delete | `POST/PATCH/DELETE /api/watchlist` | `['watchlist']` |
| reset field to inherit | `PATCH /api/watchlist/:id/reset` | `['watchlist']` |
| save settings | `PATCH /api/config` | `['config']` (+ apply theme/accent/density live) |
| scan now | `POST /api/scan/run-now` | `['deals']`, `['health']` |

## Standards
@docs/standards/coding-standards.md

## Examples
### Good
`useConfig()` reads the config row; the Settings save mutation patches `/api/config`, then on
success invalidates `['config']` AND applies the new accent/density by swapping CSS vars
(see design-system). Money is formatted only when rendering.

### Bad
```tsx
const [deals, setDeals] = useState([]);              // ❌ server data in component state
useEffect(() => { fetch('/api/deals').then(setDeals); }, []); // ❌ no cache/invalidation
// ❌ a once-per-second setInterval in the App root re-renders the whole tree
```

## Gotchas
- Never copy server data into `useState` — read it from Query so mutations stay consistent.
- Invalidate the *specific* keys a mutation affects; don't blow away the whole cache.
- Keep the per-second countdown OUT of global/app state — isolate it in a leaf `Clock`
  component, or entrance animations stick at `opacity:0` (README perf note).
- Apply theme/accent/density live on config-patch success (CSS-var swap), not on reload.
- Format money (integer cents → string) at render, never store formatted strings.

## Related skills
- view-dev — where these hooks are consumed
- forms — mutation-backed editors (inspector, settings, add-flow)
- inherit-override — the reset mutation nulls a column back to inherit
