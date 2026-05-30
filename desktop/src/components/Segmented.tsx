/**
 * Segmented — tablist-style segmented control.
 *
 * Emits:
 *   cb-seg              (root — always)
 *   cb-seg-sm           (size="sm" — small variant via CSS descendant .cb-seg-sm .cb-seg-opt)
 *   cb-seg-opt          (each option button)
 *   cb-seg-opt + is-on  (the currently selected option)
 *
 * A11y: role="tablist" on root; each option is role="tab" + aria-selected.
 * Keyboard: Left/Right arrow moves selection (roving focus pattern).
 */

export type SegmentedOption = string | { value: string; label: string };

export interface SegmentedProps {
  value: string;
  options: SegmentedOption[];
  onChange: (v: string) => void;
  size?: 'sm' | 'md';
  className?: string;
}

function optionValue(o: SegmentedOption): string {
  return typeof o === 'string' ? o : o.value;
}

function optionLabel(o: SegmentedOption): string {
  return typeof o === 'string' ? o : o.label;
}

export function Segmented({
  value,
  options,
  onChange,
  size = 'md',
  className,
}: SegmentedProps) {
  const rootClass = [
    'cb-seg',
    size === 'sm' ? 'cb-seg-sm' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const currentIdx = options.findIndex((o) => optionValue(o) === value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = options[Math.min(currentIdx + 1, options.length - 1)];
      if (next) onChange(optionValue(next));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = options[Math.max(currentIdx - 1, 0)];
      if (prev) onChange(optionValue(prev));
    }
  }

  return (
    <div className={rootClass} role="tablist" onKeyDown={handleKeyDown}>
      {options.map((o) => {
        const val = optionValue(o);
        const lbl = optionLabel(o);
        const isActive = value === val;
        return (
          <button
            key={val}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={['cb-seg-opt', isActive ? 'is-on' : undefined]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange(val)}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}
