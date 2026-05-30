/**
 * Select — native dropdown.
 *
 * Emits:
 *   cb-select            (native <select> — always)
 *   cb-select-sm         (size="sm" — narrow variant)
 *
 * Uses the native <select> element for full keyboard + a11y support.
 * onChange reads e.target.value and passes it to the caller.
 */
import type { SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'size'> {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function Select({
  value,
  options,
  onChange,
  size = 'md',
  className,
  ...rest
}: SelectProps) {
  const rootClass = [
    'cb-select',
    size === 'sm' ? 'cb-select-sm' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <select
      className={rootClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
