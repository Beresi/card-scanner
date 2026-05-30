/**
 * Slider — range input with mono value readout.
 *
 * Emits:
 *   feed-range           (the <input type="range">)
 *   cb-mono              (the value readout span)
 *
 * The wrapper is a plain flex container (no named class — its layout
 * is always inline within the callers' context).
 *
 * Accessibility: the range input has an accessible name via the
 * `label` prop (mapped to aria-label). If the caller passes neither
 * `label` nor `aria-label` via rest, the suffix is used as a fallback.
 */
import type { InputHTMLAttributes } from 'react';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value' | 'min' | 'max' | 'step'> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Units suffix shown in the readout, e.g. "%" */
  suffix?: string;
  /** Accessible name for the range input. Falls back to suffix if omitted. */
  label?: string;
  className?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix = '',
  label,
  className,
  ...rest
}: SliderProps) {
  const wrapClass = className ?? undefined;

  return (
    <span className={wrapClass} style={{ display: 'inline-flex', alignItems: 'center', gap: '9px' }}>
      <input
        type="range"
        className="feed-range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label ?? suffix ?? undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        {...rest}
      />
      <span className="cb-mono">
        {value}{suffix}
      </span>
    </span>
  );
}
