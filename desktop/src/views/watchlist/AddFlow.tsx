/**
 * AddFlow — modal for adding a card (blueprint) or a whole set (expansion)
 * to the watchlist.
 *
 * Wave 2 implementation: search-as-you-type via the /api/resolve endpoints.
 *
 * Two modes (Segmented toggle, default "card"):
 *
 *   Watch a card (blueprint mode):
 *     Step 1 — search expansions by name; pick one (stored as chosenExpansion).
 *              Shows a "change" chip once an expansion is chosen.
 *     Step 2 — search blueprints within chosenExpansion by name; click a result
 *              → POST /api/watchlist { type:'blueprint', cardtrader_id: bp.id,
 *                label: bp.name, game_id: 1 } → close + select.
 *
 *   Watch a whole set (expansion mode):
 *     Single-step — search expansions by name; click a result
 *     → POST /api/watchlist { type:'expansion', cardtrader_id: exp.id,
 *       label: exp.name, game_id: 1 } → close + select.
 *
 * Both searches debounce ~300 ms so the query key only changes after typing settles.
 * The enabled-gate (q.trim().length >= 2) is respected by the hooks — no request fires
 * on empty or single-char input.
 *
 * Fallback section (collapsible): paste a CardTrader URL / raw id + label → manual POST.
 * Retains full Wave-1 power-user capability; visually secondary (below search results).
 *
 * Loading / empty / error states are surfaced explicitly:
 *   - isPending (+ enabled) → "Searching…"
 *   - ApiError 502          → "CardTrader unreachable — try again later."
 *   - Other errors          → error.message
 *   - Empty results         → "No matches"
 *
 * Note on first-search latency: the server fetches & caches expansions from CardTrader
 * on the first request (~1-2s). Subsequent queries hit the cache and are fast. The UI
 * shows "Searching…" during this initial fetch, which is the correct affordance.
 *
 * A11y:
 *   - Search inputs are labeled (aria-label or associated <label>).
 *   - Results are <button> elements — keyboard reachable, activatable with Enter/Space.
 *   - Modal handles focus trap + Esc. Internal state resets on open/close.
 *   - Expansion chip has a clearly labeled "change" button.
 *
 * Props: { open, onClose } — unchanged; Watchlist.tsx wiring unchanged.
 */
import { useEffect, useState } from 'react';

import {
  useCreateWatchItem,
  useResolveBlueprints,
  useResolveExpansions,
} from '../../api/hooks';
import type { ResolveBlueprint, ResolveExpansion } from '../../api/types';
import { ApiError } from '../../api/client';
import { Btn } from '../../components/Btn';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Segmented } from '../../components/Segmented';
import { select } from './selection';

export interface AddFlowProps {
  open: boolean;
  onClose: () => void;
}

type AddMode = 'card' | 'set';

const MODAL_TITLE_ID = 'addflow-title';
const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// useDebouncedValue — delays value propagation to avoid per-keystroke queries
// ---------------------------------------------------------------------------
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

// ---------------------------------------------------------------------------
// Id / URL parsing — retained for the manual paste fallback
// ---------------------------------------------------------------------------
function parseCardtraderId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('http')) {
    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && /^\d+$/.test(last)) {
        const n = parseInt(last, 10);
        return n > 0 ? n : null;
      }
    } catch {
      // Fall through
    }
  }

  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? n : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Error message helper — surfaces 502 "upstream" distinctly
// ---------------------------------------------------------------------------
function resolveErrorMessage(err: Error): string {
  if (err instanceof ApiError && err.status === 502) {
    return 'CardTrader unreachable — try again later.';
  }
  return err.message;
}

// ---------------------------------------------------------------------------
// SearchBox — a search input with icon, used for both expansion + blueprint
// ---------------------------------------------------------------------------
interface SearchBoxProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}

function SearchBox({ id, label, value, placeholder, autoFocus, onChange }: SearchBoxProps) {
  return (
    <div className="addflow-search">
      <Icon name="search" size={14} svgProps={{ style: { color: 'var(--text-dim)', flexShrink: 0 } }} />
      <input
        id={id}
        className="cb-input"
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpansionResults — renders the expansion search result list
// ---------------------------------------------------------------------------
interface ExpansionResultsProps {
  q: string;
  debouncedQ: string;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: ResolveExpansion[] | undefined;
  onPick: (exp: ResolveExpansion) => void;
  /** If true, clicking picks the expansion for step-1 of card mode; label changes accordingly */
  pickLabel: string;
}

function ExpansionResults({
  q,
  debouncedQ,
  isPending,
  isError,
  error,
  data,
  onPick,
  pickLabel,
}: ExpansionResultsProps) {
  const enabled = debouncedQ.trim().length >= 2;

  // Still typing / not enough chars
  if (!enabled) {
    return (
      <p className="addflow-none cb-mono">
        {q.trim().length > 0 ? 'Keep typing…' : 'Type at least 2 characters to search.'}
      </p>
    );
  }

  // Debounce in-flight: q changed but debouncedQ hasn't settled to the new q yet
  // (or query is fetching)
  if (isPending) {
    return <p className="addflow-none cb-mono">Searching…</p>;
  }

  if (isError && error) {
    return (
      <p className="addflow-none cb-mono" style={{ color: 'var(--bad)' }} role="alert">
        {resolveErrorMessage(error)}
      </p>
    );
  }

  if (!data || data.length === 0) {
    return <p className="addflow-none cb-mono">No matches for &ldquo;{debouncedQ}&rdquo;.</p>;
  }

  return (
    <div className="addflow-results" role="listbox" aria-label="Expansion results">
      {data.map((exp) => (
        <button
          key={exp.id}
          type="button"
          className="addflow-opt"
          role="option"
          aria-selected={false}
          onClick={() => onPick(exp)}
        >
          <span className="addflow-opt-name">{exp.name}</span>
          <span className="cb-mono" style={{ fontSize: '10px', color: 'var(--text-dim)', flexShrink: 0 }}>
            {exp.code}
          </span>
          <span className="addflow-opt-add cb-mono" style={{ fontSize: '10px', color: 'var(--accent)', flexShrink: 0 }}>
            {pickLabel}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlueprintResults — renders the blueprint (card) search result list
// ---------------------------------------------------------------------------
interface BlueprintResultsProps {
  q: string;
  debouncedQ: string;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: ResolveBlueprint[] | undefined;
  onPick: (bp: ResolveBlueprint) => void;
}

function BlueprintResults({
  q,
  debouncedQ,
  isPending,
  isError,
  error,
  data,
  onPick,
}: BlueprintResultsProps) {
  const enabled = debouncedQ.trim().length >= 2;

  if (!enabled) {
    return (
      <p className="addflow-none cb-mono">
        {q.trim().length > 0 ? 'Keep typing…' : 'Type a card name to search.'}
      </p>
    );
  }

  if (isPending) {
    return <p className="addflow-none cb-mono">Searching…</p>;
  }

  if (isError && error) {
    return (
      <p className="addflow-none cb-mono" style={{ color: 'var(--bad)' }} role="alert">
        {resolveErrorMessage(error)}
      </p>
    );
  }

  if (!data || data.length === 0) {
    return <p className="addflow-none cb-mono">No cards matching &ldquo;{debouncedQ}&rdquo;.</p>;
  }

  return (
    <div className="addflow-results" role="listbox" aria-label="Card results">
      {data.map((bp) => (
        <button
          key={bp.id}
          type="button"
          className="addflow-opt"
          role="option"
          aria-selected={false}
          onClick={() => onPick(bp)}
        >
          {bp.image_url && (
            <img
              src={bp.image_url}
              alt=""
              aria-hidden="true"
              style={{ width: 32, height: 'auto', borderRadius: 'var(--radius)', flexShrink: 0 }}
            />
          )}
          <span className="addflow-opt-name">{bp.name}</span>
          <span className="addflow-opt-add cb-mono" style={{ fontSize: '10px', color: 'var(--accent)', flexShrink: 0 }}>
            + add
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManualFallback — collapsible paste-id section (Wave-1 power-user path)
// ---------------------------------------------------------------------------
interface ManualFallbackProps {
  mode: AddMode;
  onSubmit: (id: number, label: string) => void;
  isPending: boolean;
  isError: boolean;
  errorMsg: string | null;
}

function ManualFallback({ mode, onSubmit, isPending, isError, errorMsg }: ManualFallbackProps) {
  const [open, setOpen] = useState(false);
  const [idRaw, setIdRaw] = useState('');
  const [label, setLabel] = useState('');
  const [idErr, setIdErr] = useState<string | null>(null);
  const [lblErr, setLblErr] = useState<string | null>(null);

  const modeLabel = mode === 'card' ? 'blueprint' : 'expansion';
  const idPlaceholder =
    mode === 'card'
      ? 'blueprint id or https://www.cardtrader.com/cards/…'
      : 'expansion id or https://www.cardtrader.com/en/magic/expansions/…';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseCardtraderId(idRaw);
    let hasErr = false;
    if (!parsed) { setIdErr('Enter a positive integer or paste a CardTrader URL.'); hasErr = true; }
    if (!label.trim()) { setLblErr('Label is required.'); hasErr = true; }
    if (hasErr) return;
    onSubmit(parsed!, label.trim());
  }

  if (!open) {
    return (
      <button
        type="button"
        className="addflow-hint cb-mono"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', textDecoration: 'underline', textAlign: 'left', padding: 0 }}
        onClick={() => setOpen(true)}
      >
        or paste a CardTrader URL / id manually
      </button>
    );
  }

  return (
    <div className="addflow-body" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="cb-eyebrow">Manual entry</span>
        <button
          type="button"
          className="addflow-back cb-mono"
          onClick={() => setOpen(false)}
        >
          hide
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="addflow-field">
          <label className="cb-eyebrow" htmlFor="addflow-manual-id">
            CardTrader {modeLabel} id
          </label>
          <input
            id="addflow-manual-id"
            className={`cb-input${idErr ? ' cb-input-err' : ''}`}
            type="text"
            value={idRaw}
            placeholder={idPlaceholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={idErr ? 'true' : undefined}
            aria-describedby={idErr ? 'addflow-manual-id-err' : undefined}
            onChange={(e) => { setIdRaw(e.target.value); setIdErr(null); }}
          />
          {idErr && (
            <span id="addflow-manual-id-err" className="addflow-err cb-mono" role="alert">
              {idErr}
            </span>
          )}
        </div>

        <div className="addflow-field">
          <label className="cb-eyebrow" htmlFor="addflow-manual-label">
            Label
          </label>
          <input
            id="addflow-manual-label"
            className={`cb-input${lblErr ? ' cb-input-err' : ''}`}
            type="text"
            value={label}
            placeholder={mode === 'card' ? 'e.g. Black Lotus' : 'e.g. Alpha'}
            autoComplete="off"
            aria-invalid={lblErr ? 'true' : undefined}
            aria-describedby={lblErr ? 'addflow-manual-label-err' : undefined}
            onChange={(e) => { setLabel(e.target.value); setLblErr(null); }}
          />
          {lblErr && (
            <span id="addflow-manual-label-err" className="addflow-err cb-mono" role="alert">
              {lblErr}
            </span>
          )}
        </div>

        {isError && errorMsg && (
          <p className="addflow-err cb-mono" role="alert">{errorMsg}</p>
        )}

        <Btn variant="primary" type="submit" className="cb-btn-sm" disabled={isPending}>
          {isPending ? 'Adding…' : 'Add manually'}
        </Btn>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddFlow — main component
// ---------------------------------------------------------------------------

export function AddFlow({ open, onClose }: AddFlowProps) {
  const createItem = useCreateWatchItem();

  // Mode
  const [mode, setMode] = useState<AddMode>('card');

  // Expansion search (used in both modes)
  const [expQ, setExpQ] = useState('');
  const debouncedExpQ = useDebouncedValue(expQ, DEBOUNCE_MS);

  // Chosen expansion (card mode only — step 1 result)
  const [chosenExp, setChosenExp] = useState<ResolveExpansion | null>(null);

  // Blueprint search (card mode step 2)
  const [bpQ, setBpQ] = useState('');
  const debouncedBpQ = useDebouncedValue(bpQ, DEBOUNCE_MS);

  // Queries — hooks are always called; enabled gates prevent actual requests
  const expansionQuery = useResolveExpansions(debouncedExpQ);
  const blueprintQuery = useResolveBlueprints(chosenExp?.id ?? null, debouncedBpQ);

  // Reset all local state when the modal opens or closes
  useEffect(() => {
    if (!open) {
      setMode('card');
      setExpQ('');
      setChosenExp(null);
      setBpQ('');
      createItem.reset();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClose() {
    createItem.reset();
    onClose();
  }

  function handleModeChange(v: string) {
    setMode(v as AddMode);
    setExpQ('');
    setChosenExp(null);
    setBpQ('');
    createItem.reset();
  }

  // Called when user clicks an expansion result in set-mode
  function handlePickExpansionAsSet(exp: ResolveExpansion) {
    createItem.mutate(
      { type: 'expansion', cardtrader_id: exp.id, label: exp.name, game_id: 1 },
      {
        onSuccess: (created) => {
          select(created.id);
          handleClose();
        },
      },
    );
  }

  // Called when user picks an expansion in card-mode step 1
  function handleChooseExpansionForCard(exp: ResolveExpansion) {
    setChosenExp(exp);
    setExpQ('');
    setBpQ('');
  }

  // Called when user clicks a blueprint result
  function handlePickBlueprint(bp: ResolveBlueprint) {
    createItem.mutate(
      { type: 'blueprint', cardtrader_id: bp.id, label: bp.name, game_id: 1 },
      {
        onSuccess: (created) => {
          select(created.id);
          handleClose();
        },
      },
    );
  }

  // Manual fallback submit (Wave-1 path)
  function handleManualSubmit(id: number, label: string) {
    const type = mode === 'card' ? 'blueprint' : 'expansion';
    createItem.mutate(
      { type, cardtrader_id: id, label, game_id: 1 },
      {
        onSuccess: (created) => {
          select(created.id);
          handleClose();
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Determine step label for card mode
  // ---------------------------------------------------------------------------
  const cardStep = chosenExp ? 2 : 1;

  return (
    <Modal open={open} onClose={handleClose} labelledBy={MODAL_TITLE_ID}>
      {/* Header */}
      <div className="addflow-head">
        <span id={MODAL_TITLE_ID} className="cb-eyebrow">
          Add to watchlist · Magic: The Gathering
        </span>
        <button
          type="button"
          className="addflow-close"
          onClick={handleClose}
          aria-label="Close add flow"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      {/* Mode toggle */}
      <Segmented
        value={mode}
        onChange={handleModeChange}
        options={[
          { value: 'card', label: 'Watch a card' },
          { value: 'set',  label: 'Watch a whole set' },
        ]}
      />

      {/* ---- SET MODE ---- */}
      {mode === 'set' && (
        <div className="addflow-body">
          <SearchBox
            id="addflow-set-search"
            label="Search for a set by name"
            value={expQ}
            placeholder="e.g. Dominaria, Alpha, Modern Horizons…"
            autoFocus
            onChange={setExpQ}
          />

          {/* Show "Adding…" spinner when mutation is in flight */}
          {createItem.isPending ? (
            <p className="addflow-none cb-mono">Adding…</p>
          ) : createItem.isError ? (
            <p className="addflow-none cb-mono" style={{ color: 'var(--bad)' }} role="alert">
              {createItem.error?.message ?? 'Failed to add. Try again.'}
            </p>
          ) : (
            <ExpansionResults
              q={expQ}
              debouncedQ={debouncedExpQ}
              isPending={expansionQuery.isPending && expansionQuery.fetchStatus !== 'idle'}
              isError={expansionQuery.isError}
              error={expansionQuery.error}
              data={expansionQuery.data}
              onPick={handlePickExpansionAsSet}
              pickLabel="+ watch set"
            />
          )}
        </div>
      )}

      {/* ---- CARD MODE ---- */}
      {mode === 'card' && (
        <div className="addflow-body">
          {/* Step indicator */}
          <div className="addflow-step">
            <span className="cb-eyebrow" style={{ color: 'var(--text-dim)' }}>
              {cardStep === 1 ? 'Step 1 — choose a set' : 'Step 2 — search for a card'}
            </span>
            {chosenExp && (
              <button
                type="button"
                className="addflow-back cb-mono"
                onClick={() => { setChosenExp(null); setBpQ(''); }}
                aria-label="Change chosen set"
              >
                ← change set
              </button>
            )}
          </div>

          {/* Step 1: chosen-expansion chip or expansion search */}
          {chosenExp ? (
            /* Chip showing the chosen expansion */
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                background: 'var(--accent-soft)',
                border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)',
                borderRadius: 'var(--radius)',
              }}
            >
              <span className="addflow-opt-name" style={{ fontSize: 13 }}>{chosenExp.name}</span>
              <span className="cb-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{chosenExp.code}</span>
            </div>
          ) : (
            <SearchBox
              id="addflow-exp-search"
              label="Search for a set by name"
              value={expQ}
              placeholder="e.g. Dominaria, Alpha, Modern Horizons…"
              autoFocus
              onChange={setExpQ}
            />
          )}

          {/* Step 1 results (only shown before expansion is chosen) */}
          {!chosenExp && (
            <ExpansionResults
              q={expQ}
              debouncedQ={debouncedExpQ}
              isPending={expansionQuery.isPending && expansionQuery.fetchStatus !== 'idle'}
              isError={expansionQuery.isError}
              error={expansionQuery.error}
              data={expansionQuery.data}
              onPick={handleChooseExpansionForCard}
              pickLabel="→ select"
            />
          )}

          {/* Step 2: blueprint search (shown only after expansion is chosen) */}
          {chosenExp && (
            <>
              <SearchBox
                id="addflow-bp-search"
                label="Search for a card by name"
                value={bpQ}
                placeholder="e.g. Black Lotus, Ragavan…"
                autoFocus
                onChange={setBpQ}
              />

              {createItem.isPending ? (
                <p className="addflow-none cb-mono">Adding…</p>
              ) : createItem.isError ? (
                <p className="addflow-none cb-mono" style={{ color: 'var(--bad)' }} role="alert">
                  {createItem.error?.message ?? 'Failed to add. Try again.'}
                </p>
              ) : (
                <BlueprintResults
                  q={bpQ}
                  debouncedQ={debouncedBpQ}
                  isPending={blueprintQuery.isPending && blueprintQuery.fetchStatus !== 'idle'}
                  isError={blueprintQuery.isError}
                  error={blueprintQuery.error}
                  data={blueprintQuery.data}
                  onPick={handlePickBlueprint}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Manual paste fallback — Wave-1 power-user path, visually secondary */}
      <ManualFallback
        mode={mode}
        onSubmit={handleManualSubmit}
        isPending={createItem.isPending}
        isError={createItem.isError}
        errorMsg={createItem.error?.message ?? null}
      />
    </Modal>
  );
}
