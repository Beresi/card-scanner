/**
 * Switch — toggle button.
 *
 * Emits:
 *   cb-switch            (root button — always)
 *   cb-switch + is-on    (when on=true)
 *   cb-switch-knob       (the sliding indicator span)
 *
 * A11y: role="switch", aria-checked={on}. Accepts an optional visible
 * label rendered beside the toggle; also used as aria-label when no
 * visible label is needed by the caller.
 */
import type { ButtonHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick'> {
  on: boolean;
  onChange: (v: boolean) => void;
  /** Visible text label rendered beside the switch. Also used as aria-label
   *  when no explicit aria-label is provided. */
  label?: string;
  className?: string;
}

export function Switch({
  on,
  onChange,
  label,
  className,
  ...rest
}: SwitchProps) {
  const rootClass = [
    'cb-switch',
    on ? 'is-on' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={rootClass}
        onClick={() => onChange(!on)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange(!on);
          }
        }}
        {...rest}
      >
        <span className="cb-switch-knob" />
      </button>
      {label && (
        <span aria-hidden="true" style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          {label}
        </span>
      )}
    </span>
  );
}
