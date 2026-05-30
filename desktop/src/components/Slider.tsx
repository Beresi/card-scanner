/**
 * Slider — range input with mono value readout.
 *
 * Emits:
 *   feed-range           (the <input type="range">)
 *   cb-mono              (the value readout span)
 *
 * Drag-then-commit: the thumb tracks a LOCAL value while dragging (so it moves
 * smoothly and the readout updates live), and `onChange` is only called when the
 * interaction settles — pointer up, key up, or blur. This prevents the common
 * "slider fights the server" jank where each drag tick fires an async mutation
 * and the refetched value snaps the thumb back. While not dragging, the local
 * value follows the controlled `value` prop.
 *
 * Accessibility: the range input has an accessible name via the `label` prop
 * (mapped to aria-label), falling back to `suffix`. Keyboard arrows update the
 * value live and commit on key up.
 */
import { useEffect, useRef, useState } from 'react';
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
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);

  // Follow the controlled value when the user isn't actively dragging.
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  const commit = () => {
    dragging.current = false;
    if (local !== value) onChange(local);
  };

  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: '9px' }}>
      <input
        type="range"
        className="feed-range"
        min={min}
        max={max}
        step={step}
        value={local}
        aria-label={label ?? suffix ?? undefined}
        onPointerDown={() => { dragging.current = true; }}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        {...rest}
      />
      <span className="cb-mono">
        {local}{suffix}
      </span>
    </span>
  );
}
