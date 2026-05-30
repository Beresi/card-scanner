/**
 * AddFlow — modal for adding a card (blueprint) or a whole set (expansion)
 * to the watchlist.
 *
 * Props: { open, onClose } — the shared watchlist store owns the open state;
 * this component is purely presentational and delegates addItem through the store.
 *
 * Two modes via a Segmented toggle:
 *   - "Watch a whole set": search MOCK_EXPANSIONS by name/code → pick → addItem
 *   - "Watch a card": step 1 pick a set, step 2 search MOCK_BLUEPRINTS by name → pick → addItem
 *
 * On success: calls addItem then onClose (the shared store will auto-select the new item).
 *
 * Accessibility: uses the Modal primitive which handles focus trap, Esc close,
 * focus restore, and role="dialog".
 *
 * Data: MOCK_EXPANSIONS / MOCK_BLUEPRINTS are local imports for the mock phase.
 * Feature-agent will replace with TanStack Query hooks later.
 */
import { useState } from 'react';

import type { WatchItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Segmented } from '../../components/Segmented';
import { MOCK_BLUEPRINTS } from '../../mock/blueprints';
import { MOCK_EXPANSIONS, type MockExpansion } from '../../mock/expansions';
import { useMockWatchlist } from '../../mock/hooks';

export interface AddFlowProps {
  open: boolean;
  onClose: () => void;
}

type AddMode = 'card' | 'set';

// ---------------------------------------------------------------------------
// SetSearch — shared expansion search UI used in both modes
// ---------------------------------------------------------------------------

interface SetSearchProps {
  q: string;
  onQChange: (q: string) => void;
  onPick: (exp: MockExpansion) => void;
  /** Label shown on each result row's right side */
  pickLabel: string;
  autoFocus?: boolean;
}

function SetSearch({ q, onQChange, onPick, pickLabel, autoFocus }: SetSearchProps) {
  const lower = q.toLowerCase();
  const results = MOCK_EXPANSIONS.filter(
    (e) =>
      e.name.toLowerCase().includes(lower) ||
      e.code.toLowerCase().includes(lower),
  );

  return (
    <>
      <div className="addflow-search">
        <Icon name="search" size={15} svgProps={{ style: { color: 'var(--text-dim)' } }} />
        <input
          className="cb-input"
          style={{ border: 0, paddingLeft: 0, background: 'transparent' } as React.CSSProperties}
          placeholder="search expansions by name or code…"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          autoFocus={autoFocus}
          aria-label="Search expansions"
        />
      </div>
      <div className="addflow-results" role="listbox" aria-label="Expansion results">
        {results.length === 0 && (
          <p className="addflow-none cb-mono">no expansions match</p>
        )}
        {results.map((exp) => (
          <button
            key={exp.id}
            className="addflow-opt"
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onPick(exp)}
          >
            <Icon name="layers" size={15} svgProps={{ style: { color: 'var(--accent)' } }} />
            <span className="addflow-opt-name">{exp.name}</span>
            <span className="cb-mono" style={{ fontSize: 10, color: 'var(--text-faint)' } as React.CSSProperties}>
              {exp.code.toUpperCase()}
            </span>
            <span className="addflow-opt-add cb-mono" style={{ fontSize: 11, color: 'var(--text-dim)' } as React.CSSProperties}>
              {pickLabel}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SetMode — watch a whole expansion
// ---------------------------------------------------------------------------

interface SetModeProps {
  onAdd: (partial: Pick<WatchItem, 'type' | 'cardtrader_id' | 'label' | 'game_id'>) => void;
  onClose: () => void;
}

function SetMode({ onAdd, onClose }: SetModeProps) {
  const [q, setQ] = useState('');

  return (
    <div className="addflow-body">
      <SetSearch
        q={q}
        onQChange={setQ}
        autoFocus
        pickLabel="add ›"
        onPick={(exp) => {
          onAdd({ type: 'expansion', cardtrader_id: exp.id, label: exp.name, game_id: exp.game_id });
          onClose();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CardMode — watch a specific card (2-step)
// ---------------------------------------------------------------------------

interface CardModeProps {
  onAdd: (partial: Pick<WatchItem, 'type' | 'cardtrader_id' | 'label' | 'game_id'>) => void;
  onClose: () => void;
}

function CardMode({ onAdd, onClose }: CardModeProps) {
  const [selectedExp, setSelectedExp] = useState<MockExpansion | null>(null);
  const [expQ, setExpQ] = useState('');
  const [cardQ, setCardQ] = useState('');

  if (!selectedExp) {
    return (
      <div className="addflow-body">
        <div className="addflow-step">
          <span className="cb-eyebrow">Step 1 · pick the set</span>
        </div>
        <SetSearch
          q={expQ}
          onQChange={setExpQ}
          autoFocus
          pickLabel="select ›"
          onPick={(exp) => {
            setSelectedExp(exp);
            setCardQ('');
          }}
        />
      </div>
    );
  }

  const lower = cardQ.toLowerCase();
  const cards = MOCK_BLUEPRINTS.filter(
    (b) => b.expansion_id === selectedExp.id && b.name.toLowerCase().includes(lower),
  );

  return (
    <div className="addflow-body">
      <div className="addflow-step">
        <button
          type="button"
          className="addflow-back"
          onClick={() => { setSelectedExp(null); setExpQ(''); }}
        >
          &lsaquo; change set
        </button>
        <span className="cb-eyebrow">
          Step 2 · pick a card in{' '}
          <span style={{ color: 'var(--accent)' }}>{selectedExp.name}</span>
        </span>
      </div>

      <div className="addflow-search">
        <Icon name="search" size={15} svgProps={{ style: { color: 'var(--text-dim)' } }} />
        <input
          className="cb-input"
          style={{ border: 0, paddingLeft: 0, background: 'transparent' } as React.CSSProperties}
          placeholder="search cards…"
          value={cardQ}
          onChange={(e) => setCardQ(e.target.value)}
          autoFocus
          aria-label="Search cards"
        />
      </div>

      <div className="addflow-results" role="listbox" aria-label="Card results">
        {cards.length === 0 && (
          <p className="addflow-none cb-mono">no cached cards match</p>
        )}
        {cards.map((bp) => (
          <button
            key={bp.id}
            className="addflow-opt"
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => {
              onAdd({ type: 'blueprint', cardtrader_id: bp.id, label: bp.name, game_id: selectedExp.game_id });
              onClose();
            }}
          >
            <Icon name="card" size={15} svgProps={{ style: { color: 'var(--text-dim)' } }} />
            <span className="addflow-opt-name">{bp.name}</span>
            <span className="cb-mono" style={{ fontSize: 10, color: 'var(--text-faint)' } as React.CSSProperties}>
              #{bp.id}
            </span>
            <Icon name="plus" size={14} className="addflow-opt-add" svgProps={{ style: { color: 'var(--text-dim)' } }} />
          </button>
        ))}
      </div>

      <p className="addflow-hint cb-mono">
        tip · only locally-cached cards are shown; more sets coming when the API is wired
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddFlow — exported component
// ---------------------------------------------------------------------------

const MODAL_TITLE_ID = 'addflow-title';

export function AddFlow({ open, onClose }: AddFlowProps) {
  const { addItem } = useMockWatchlist();
  const [mode, setMode] = useState<AddMode>('card');

  // Reset mode when modal is closed
  function handleClose() {
    setMode('card');
    onClose();
  }

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
        onChange={(v) => setMode(v as AddMode)}
        options={[
          { value: 'card', label: 'Watch a card' },
          { value: 'set',  label: 'Watch a whole set' },
        ]}
      />

      {mode === 'set' ? (
        <SetMode onAdd={addItem} onClose={handleClose} />
      ) : (
        <CardMode onAdd={addItem} onClose={handleClose} />
      )}
    </Modal>
  );
}
