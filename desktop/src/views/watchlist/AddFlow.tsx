/**
 * AddFlow — modal for adding a card (blueprint) or a whole set (expansion)
 * to the watchlist.
 *
 * Wave 1 implementation: manual CardTrader id entry / URL paste.
 * Search-as-you-type against the resolve cache is deferred to Wave 2.
 *
 * Props: { open, onClose } — the shared selection store owns the open state.
 *
 * Two modes via a Segmented toggle:
 *   - "Watch a card":     blueprint id + label + optional URL → POST /api/watchlist
 *   - "Watch a whole set": expansion id + label + optional URL → POST /api/watchlist
 *
 * On success: calls onClose() and selects the newly-created item.
 *
 * Id input accepts:
 *   - A raw positive integer (e.g. "12345")
 *   - A CardTrader URL (e.g. https://www.cardtrader.com/cards/12345) → trailing number extracted
 *
 * Validation: id must be a positive integer; label must be non-empty.
 * Submit button is disabled until the form is valid.
 *
 * Accessibility: uses the Modal primitive which handles focus trap, Esc close,
 * focus restore, and role="dialog".
 */
import { useState } from 'react';

import { useCreateWatchItem } from '../../api/hooks';
import type { WatchItemType } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Segmented } from '../../components/Segmented';
import { Btn } from '../../components/Btn';
import { select } from './selection';

export interface AddFlowProps {
  open: boolean;
  onClose: () => void;
}

type AddMode = 'card' | 'set';

const MODAL_TITLE_ID = 'addflow-title';

// ---------------------------------------------------------------------------
// Id / URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw CardTrader id or a CardTrader URL into a positive integer.
 * Returns null if the value cannot be resolved.
 *
 * Accepts:
 *   "12345"
 *   "https://www.cardtrader.com/cards/12345"
 *   "https://www.cardtrader.com/en/magic/expansions/12345"
 * (any URL whose pathname ends with a numeric segment)
 */
function parseCardtraderId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try URL parse first
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
      // Fall through to plain-number parse
    }
  }

  // Plain number
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? n : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// AddFlow component
// ---------------------------------------------------------------------------

export function AddFlow({ open, onClose }: AddFlowProps) {
  const createItem = useCreateWatchItem();

  const [mode, setMode]   = useState<AddMode>('card');
  const [idRaw, setIdRaw] = useState('');
  const [label, setLabel] = useState('');
  const [idError, setIdError]     = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);

  // Derived
  const parsedId = parseCardtraderId(idRaw);
  const idValid  = parsedId !== null;
  const labelValid = label.trim().length > 0;
  const canSubmit = idValid && labelValid && !createItem.isPending;

  function handleClose() {
    // Reset form state on close
    setMode('card');
    setIdRaw('');
    setLabel('');
    setIdError(null);
    setLabelError(null);
    createItem.reset();
    onClose();
  }

  function handleModeChange(v: string) {
    setMode(v as AddMode);
    setIdRaw('');
    setIdError(null);
  }

  function handleIdChange(e: React.ChangeEvent<HTMLInputElement>) {
    setIdRaw(e.target.value);
    setIdError(null);
  }

  function handleLabelChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLabel(e.target.value);
    setLabelError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate
    let hasError = false;
    if (!idValid) {
      setIdError('Enter a positive integer or paste a CardTrader URL.');
      hasError = true;
    }
    if (!labelValid) {
      setLabelError('Label is required.');
      hasError = true;
    }
    if (hasError) return;

    const type: WatchItemType = mode === 'set' ? 'expansion' : 'blueprint';

    createItem.mutate(
      { type, cardtrader_id: parsedId!, label: label.trim(), game_id: 1 },
      {
        onSuccess: (created) => {
          select(created.id);
          handleClose();
        },
      },
    );
  }

  const modeLabel = mode === 'card' ? 'blueprint' : 'expansion';
  const idPlaceholder =
    mode === 'card'
      ? 'blueprint id or https://www.cardtrader.com/cards/…'
      : 'expansion id or https://www.cardtrader.com/en/magic/expansions/…';

  return (
    <Modal open={open} onClose={handleClose} labelledBy={MODAL_TITLE_ID}>
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

      <Segmented
        value={mode}
        onChange={handleModeChange}
        options={[
          { value: 'card', label: 'Watch a card' },
          { value: 'set',  label: 'Watch a whole set' },
        ]}
      />

      <form className="addflow-body" onSubmit={handleSubmit} noValidate>
        {/* Id / URL field */}
        <div className="addflow-field">
          <label className="cb-eyebrow" htmlFor="addflow-id">
            CardTrader {modeLabel} id
          </label>
          <input
            id="addflow-id"
            className={`cb-input${idError ? ' cb-input-err' : ''}`}
            type="text"
            value={idRaw}
            placeholder={idPlaceholder}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={idError ? 'true' : undefined}
            aria-describedby={idError ? 'addflow-id-err' : undefined}
            onChange={handleIdChange}
          />
          {idError && (
            <span
              id="addflow-id-err"
              className="addflow-err cb-mono"
              role="alert"
            >
              {idError}
            </span>
          )}
        </div>

        {/* Label field */}
        <div className="addflow-field">
          <label className="cb-eyebrow" htmlFor="addflow-label">
            Label
          </label>
          <input
            id="addflow-label"
            className={`cb-input${labelError ? ' cb-input-err' : ''}`}
            type="text"
            value={label}
            placeholder={mode === 'card' ? 'e.g. Black Lotus' : 'e.g. Alpha'}
            autoComplete="off"
            aria-invalid={labelError ? 'true' : undefined}
            aria-describedby={labelError ? 'addflow-label-err' : undefined}
            onChange={handleLabelChange}
          />
          {labelError && (
            <span
              id="addflow-label-err"
              className="addflow-err cb-mono"
              role="alert"
            >
              {labelError}
            </span>
          )}
        </div>

        {/* Hint */}
        <p className="addflow-hint cb-mono">
          Card = CardTrader blueprint id · Set = expansion id.
          Paste a CardTrader URL or type the id directly.
          (Search-as-you-type is coming next.)
        </p>

        {/* API error */}
        {createItem.isError && (
          <p className="addflow-err cb-mono" role="alert">
            {createItem.error?.message ?? 'Failed to create item. Check the id and try again.'}
          </p>
        )}

        {/* Actions */}
        <div className="addflow-actions">
          <Btn
            variant="ghost"
            type="button"
            className="cb-btn-sm"
            onClick={handleClose}
          >
            Cancel
          </Btn>
          <Btn
            variant="primary"
            type="submit"
            className="cb-btn-sm"
            disabled={!canSubmit}
          >
            {createItem.isPending ? 'Adding…' : 'Add to watchlist'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
