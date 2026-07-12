/**
 * PrintingPicker — print-restriction droplist for "any printing" watchlist items.
 *
 * Wraps MultiSelectDropdown with card-printing–specific data fetching and
 * the include↔null mapping (all known sets checked → emit null; subset → emit
 * the subset array).
 *
 * Props:
 *   cardName   — normalised display name; the server resolves printings by it.
 *   value      — current expansion_filter decoded as number[] | null.
 *                null or empty = all sets (no restriction).
 *   onChange   — emits null when ALL known sets are checked, else the subset.
 *
 * Data:
 *   useCardPrintings(cardName) — returns ResolveCardPrinting[] (id, code, name,
 *                                printings) for every set the card appears in.
 *   useCatalogProgress()       — drives the partial-catalog note.
 *
 * Inclusion logic:
 *   - If stored value contains ids not in the current known set (catalog not
 *     fully synced), those "unknown" ids are kept in the emitted subset so a
 *     partial catalog never silently drops a user restriction.
 *   - Emits null only when every known id is checked AND there are no lingering
 *     unknown ids that the user hasn't explicitly removed.
 *
 * This component is purely presentational beyond the single data hook — no
 * mutations, no routing, no business logic except the inclusion↔null mapping.
 */
import { useCatalogProgress, useCardPrintings } from '../../api/hooks';
import type { MultiSelectOption } from '../../components/MultiSelectDropdown';
import { MultiSelectDropdown } from '../../components/MultiSelectDropdown';

export interface PrintingPickerProps {
  /** Display name of the card; the server normalises it when looking up printings. */
  cardName: string;
  /**
   * Current expansion_filter decoded from the WatchItem:
   *   - null or empty array → "all sets" (no restriction)
   *   - non-empty array    → explicit subset of expansion_ids
   */
  value: number[] | null;
  /**
   * onChange callback:
   *   - emits null  when the selection covers ALL known sets (and no unknown ids
   *     remain lingering from a prior partial-catalog save).
   *   - emits a non-empty number[] when only a subset is selected.
   */
  onChange: (next: number[] | null) => void;
}

/** Derive the id set actually stored (coerce null/empty → []). */
function storedIds(value: number[] | null): number[] {
  return value && value.length > 0 ? value : [];
}

export function PrintingPicker({ cardName, value, onChange }: PrintingPickerProps) {
  const { data: sets = [], isPending, isError, error } = useCardPrintings(cardName);
  const cat = useCatalogProgress();

  // ---- build MultiSelectDropdown options ----------------------------------

  const options: MultiSelectOption[] = sets.map((s) => ({
    value: s.id,
    label: s.name,
    hint: s.code,
  }));

  // ---- compute known + unknown ids ----------------------------------------

  const knownIds = sets.map((s) => s.id);
  const stored = storedIds(value);

  // Unknown ids: stored by the user but not (yet) in the synced catalog.
  // We carry them forward so a partial catalog never silently drops a restriction.
  const unknownStoredIds = stored.filter((id) => !knownIds.includes(id));

  // ---- resolve the checked set to pass to the dropdown --------------------

  // null/empty value = all sets checked; otherwise use the stored subset.
  const checkedIds: number[] =
    value === null || value.length === 0
      ? knownIds
      : // Union: stored known ids that are in the current catalog + unknown ids
        // (unknown ids have no option row but remain in the selection)
        stored;

  // ---- handle dropdown onChange -------------------------------------------

  function handleChange(next: number[]) {
    // Preserve unknown ids that are still nominally "checked".
    // A user cannot uncheck an unknown id (there's no row for it), so we keep
    // them in the emitted subset unless all the *known* options are now checked.
    const checkedKnown = next.filter((id) => knownIds.includes(id));
    const allKnownChecked = knownIds.length > 0 && knownIds.every((id) => next.includes(id));

    if (allKnownChecked && unknownStoredIds.length === 0) {
      // All known sets selected, no stale unknown ids → treat as "all sets"
      onChange(null);
    } else {
      // Subset: checked known ids + any lingering unknown ids the user hasn't removed
      const subset = [...checkedKnown, ...unknownStoredIds];
      onChange(subset.length > 0 ? subset : null);
    }
  }

  // ---- trigger label ------------------------------------------------------

  function buildTriggerLabel(): string {
    if (value === null || value.length === 0) return 'All sets';
    if (sets.length === 0) return `${value.length} sets selected`;
    return `${checkedIds.filter((id) => knownIds.includes(id)).length} of ${sets.length} sets`;
  }

  // ---- catalog partial note -----------------------------------------------

  const catTotal = cat.data?.total ?? 0;
  const catSynced = cat.data?.synced ?? 0;
  const catPartial = catTotal > 0 && catSynced < catTotal;

  // ---- render -------------------------------------------------------------

  return (
    <div>
      <MultiSelectDropdown
        options={options}
        selected={checkedIds}
        onChange={handleChange}
        triggerLabel={buildTriggerLabel()}
        allOption={true}
        loading={isPending}
        emptyText="No printings found in the synced catalog yet."
      />

      {isError && (
        <p
          className="cb-mono"
          style={{ fontSize: 11, color: 'var(--bad)', margin: '5px 0 0', lineHeight: 1.5 }}
          role="alert"
        >
          Couldn&rsquo;t load printings — {error?.message ?? 'request failed'}.
        </p>
      )}

      {!isError && catPartial && (
        <p
          className="cb-mono"
          style={{ fontSize: 11, color: 'var(--text-dim)', margin: '5px 0 0', lineHeight: 1.5 }}
          aria-live="polite"
        >
          Matching against {catSynced}/{catTotal} sets synced — coverage grows as the catalog fills.
        </p>
      )}
    </div>
  );
}
