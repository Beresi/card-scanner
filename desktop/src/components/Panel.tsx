/**
 * Panel — bordered/chamfered surface with optional eyebrow header.
 *
 * Emits:  cb-panel  cb-panel-head  cb-panel-right  cb-panel-body
 *         cb-eyebrow  (optional glow variant: cb-panel-glow)
 *
 * Design note: the `glow` prop adds cb-panel-glow which applies the
 * accent-tinted outline + ambient shadow. The base cb-panel class
 * provides the gradient background and hairline border.
 */
export interface PanelProps {
  /** Short eyebrow label shown above the title (monospaced, uppercase). */
  eyebrow?: string;
  /** Panel title text rendered in the header row. */
  title?: string;
  /** Slot for controls placed on the right side of the header row. */
  right?: React.ReactNode;
  /** Whether to apply the accent glow outline variant (cb-panel-glow). */
  glow?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Panel({
  eyebrow,
  title,
  right,
  glow = false,
  children,
  className,
}: PanelProps) {
  const hasHeader = eyebrow !== undefined || title !== undefined || right !== undefined;

  const rootClass = [
    'cb-panel',
    glow ? 'cb-panel-glow' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={rootClass}>
      {hasHeader && (
        <header className="cb-panel-head">
          <div>
            {eyebrow && <p className="cb-eyebrow">{eyebrow}</p>}
            {title && <span>{title}</span>}
          </div>
          {right !== undefined && (
            <span className="cb-panel-right">{right}</span>
          )}
        </header>
      )}
      <div className="cb-panel-body">{children}</div>
    </section>
  );
}
