/**
 * MultiSelectDropdown — generic, reusable, presentational multi-select control.
 *
 * Emits:
 *   cb-dropdown               (position:relative wrapper — always)
 *   cb-dropdown-trigger       (the toggle button)
 *   cb-dropdown-trigger-open  (modifier — when the panel is open)
 *   cb-dropdown-panel         (the floating option panel)
 *   cb-dropdown-header        (select-all / clear-all strip)
 *   cb-dropdown-hdr-btn       (header control buttons)
 *   cb-dropdown-hdr-count     (selected count badge)
 *   cb-dropdown-list          (scrollable option list, role=listbox)
 *   cb-dropdown-opt           (one option row)
 *   cb-dropdown-opt-checked   (modifier — selected state)
 *   cb-dropdown-check         (the checkbox indicator box)
 *   cb-dropdown-opt-label     (option label text)
 *   cb-dropdown-opt-hint      (dim code/hint beside the label)
 *   cb-dropdown-empty         (empty / loading message)
 *
 * A11y:
 *   - Trigger: <button> aria-haspopup="listbox" aria-expanded={open}
 *     aria-controls={listId}.
 *   - Panel list: role="listbox" aria-multiselectable="true".
 *   - Each row: role="option" aria-selected={checked}.
 *   - Keyboard: ArrowUp/Down move focus between rows; Space/Enter toggle;
 *     Esc closes and returns focus to the trigger.
 *   - Outside-click (mousedown) closes the panel.
 *   - Reduced-motion: entrance animation is disabled via CSS media query.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Icon } from './Icon';

export interface MultiSelectOption {
  value: number;
  label: string;
  /** Optional hint shown dim beside the label — e.g. set code or "N printings". */
  hint?: string;
}

export interface MultiSelectDropdownProps {
  options: MultiSelectOption[];
  selected: number[];
  onChange: (next: number[]) => void;
  /** Text shown inside the trigger button, e.g. "All sets" / "5 of 12 sets". */
  triggerLabel: string;
  /** Show a "Select all / Clear all" header row. Default: true. */
  allOption?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Message shown when options is empty and not loading. Default: "No options". */
  emptyText?: string;
  className?: string;
}

export function MultiSelectDropdown({
  options,
  selected,
  onChange,
  triggerLabel,
  allOption = true,
  disabled = false,
  loading = false,
  emptyText = 'No options',
  className,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const uid = useId();
  const listId = `${uid}-list`;
  const triggerId = `${uid}-trigger`;

  // ---- close helpers -------------------------------------------------------

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger after a paint so the panel is gone
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, []);

  // ---- outside-click close -------------------------------------------------

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        close();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open, close]);

  // ---- option toggle -------------------------------------------------------

  function toggleValue(value: number) {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  }

  // ---- select all / clear all ----------------------------------------------

  function selectAll() {
    onChange(options.map((o) => o.value));
  }

  function clearAll() {
    onChange([]);
  }

  // ---- keyboard handling on the panel (ArrowUp/Down, Esc) ------------------

  function handleListKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRestoreFocus();
      return;
    }

    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();

    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('.cb-dropdown-opt') ?? [],
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === 'ArrowDown') {
      const next = items[idx + 1] ?? items[0];
      next?.focus();
    } else {
      const prev = items[idx - 1] ?? items[items.length - 1];
      prev?.focus();
    }
  }

  // ---- keyboard handling on option rows (Space/Enter toggle, Esc close) ----

  function handleOptKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, value: number) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleValue(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRestoreFocus();
    }
  }

  // ---- derived values ------------------------------------------------------

  const allSelected = options.length > 0 && options.every((o) => selected.includes(o.value));

  // ---- render --------------------------------------------------------------

  const isDisabled = disabled || loading;

  const triggerClass = [
    'cb-dropdown-trigger',
    open ? 'cb-dropdown-trigger-open' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  const wrapperClass = ['cb-dropdown', className].filter(Boolean).join(' ');

  return (
    <div ref={wrapperRef} className={wrapperClass}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={triggerClass}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cb-dropdown-trigger-label">
          {loading ? 'Loading…' : triggerLabel}
        </span>
        <Icon
          name="chevron"
          size={14}
          className="cb-dropdown-chevron"
          svgProps={{ 'aria-hidden': true }}
        />
      </button>

      {/* Floating panel */}
      {open && (
        <div className="cb-dropdown-panel" role="presentation">
          {/* Header: select-all / clear-all + count */}
          {allOption && (
            <div className="cb-dropdown-header">
              <button
                type="button"
                className="cb-dropdown-hdr-btn"
                onClick={selectAll}
                disabled={allSelected}
              >
                Select all
              </button>
              <button
                type="button"
                className="cb-dropdown-hdr-btn"
                onClick={clearAll}
                disabled={selected.length === 0}
              >
                Clear all
              </button>
              <span className="cb-dropdown-hdr-count">
                {selected.length}/{options.length}
              </span>
            </div>
          )}

          {/* Option list */}
          {options.length === 0 ? (
            <div className="cb-dropdown-empty" role="status">
              {loading ? 'Loading…' : emptyText}
            </div>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              className="cb-dropdown-list"
              role="listbox"
              aria-multiselectable="true"
              aria-label={triggerLabel}
              onKeyDown={handleListKeyDown}
            >
              {options.map((opt) => {
                const checked = selected.includes(opt.value);
                const optClass = [
                  'cb-dropdown-opt',
                  checked ? 'cb-dropdown-opt-checked' : undefined,
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <li key={opt.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      className={optClass}
                      onClick={() => toggleValue(opt.value)}
                      onKeyDown={(e) => handleOptKeyDown(e, opt.value)}
                    >
                      {/* Checkbox indicator */}
                      <span className="cb-dropdown-check" aria-hidden="true">
                        {checked && (
                          <Icon
                            name="check"
                            size={10}
                            svgProps={{ stroke: 'var(--accent-ink)', 'aria-hidden': true }}
                          />
                        )}
                      </span>
                      <span className="cb-dropdown-opt-label">{opt.label}</span>
                      {opt.hint !== undefined && (
                        <span className="cb-dropdown-opt-hint">{opt.hint}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
