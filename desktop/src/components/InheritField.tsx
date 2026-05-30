/**
 * InheritField — labeled control wrapper with inherit / override indicator.
 *
 * Emits:
 *   cb-ifield            (root — always)
 *   cb-ifield-top        (label row — always)
 *   cb-ifield-lbl        (field label text)
 *   cb-inherit           (indicator shown when inherited=true)
 *   cb-dot + cb-dot-idle (idle dot inside cb-inherit)
 *   cb-reset             (button shown when inherited=false — the "override ✕" chip)
 *   cb-ifield-ctl        (control slot wrapper — always)
 *   cb-ifield-ctl + is-inherited  (added to control slot when inherited=true)
 *
 * Contract:
 *   - When inherited=true  → shows "inherit · {defaultLabel}" with an idle dot.
 *   - When inherited=false → shows an "override ✕" button; clicking it fires onReset.
 *   - The component NEVER resolves the effective value — that is the backend's job.
 *   - children is the actual control rendered in the .cb-ifield-ctl slot.
 */

export interface InheritFieldProps {
  /** Field label shown on the left of the top row. */
  label: string;
  /** True when the current value is inherited (null override). */
  inherited: boolean;
  /** Human-readable default label shown in the inherit indicator. */
  defaultLabel: string;
  /** Called when the user clicks "override ✕" to reset to inherited. */
  onReset: () => void;
  /** The actual form control rendered in the control slot. */
  children: React.ReactNode;
  className?: string;
}

export function InheritField({
  label,
  inherited,
  defaultLabel,
  onReset,
  children,
  className,
}: InheritFieldProps) {
  const rootClass = ['cb-ifield', className].filter(Boolean).join(' ');
  const ctlClass = ['cb-ifield-ctl', inherited ? 'is-inherited' : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      <div className="cb-ifield-top">
        <span className="cb-ifield-lbl">{label}</span>
        {inherited ? (
          <span className="cb-inherit" title="Following the global default">
            <span className="cb-dot cb-dot-idle" aria-hidden="true" />
            inherit · {defaultLabel}
          </span>
        ) : (
          <button
            type="button"
            className="cb-reset"
            onClick={onReset}
            aria-label={`Reset ${label} to default`}
          >
            override ✕
          </button>
        )}
      </div>
      <div className={ctlClass}>{children}</div>
    </div>
  );
}
