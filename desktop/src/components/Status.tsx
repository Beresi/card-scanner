/**
 * Status — status dot + optional label.
 *
 * Emits:
 *   cb-status            (wrapper — always)
 *   cb-dot               (the dot — always; from tokens.css)
 *   cb-dot-live          (tone="good")   ← tokens.css calls the green dot "live"
 *   cb-dot-warn          (tone="warn")
 *   cb-dot-hot           (tone="hot")
 *   cb-dot-idle          (tone="idle")
 *   cb-status-lbl        (label span — when label is provided)
 *
 * All dot classes (cb-dot, cb-dot-live, cb-dot-warn, cb-dot-hot, cb-dot-idle)
 * are defined in desktop/src/styles/tokens.css.
 * cb-status and cb-status-lbl are defined in the handoff ui.css and need to be
 * added to the real desktop CSS — flagged for the design-agent below.
 *
 * Note: the tokens.css uses "live" for the green/good dot, not "good".
 * This component accepts tone="good" in the props (semantic) and maps it
 * to cb-dot-live (visual) to match the existing class name.
 */
export type StatusTone = 'good' | 'warn' | 'hot' | 'idle';

export interface StatusProps {
  tone?: StatusTone;
  label?: string;
  className?: string;
}

// Semantic tone → existing cb-dot-* class mapping.
// "good" maps to cb-dot-live (the green glowing dot defined in tokens.css).
const DOT_CLASS: Record<StatusTone, string> = {
  good: 'cb-dot-live',
  warn: 'cb-dot-warn',
  hot:  'cb-dot-hot',
  idle: 'cb-dot-idle',
};

export function Status({ tone = 'idle', label, className }: StatusProps) {
  const rootClass = ['cb-status', className].filter(Boolean).join(' ');

  return (
    <span className={rootClass}>
      <span className={`cb-dot ${DOT_CLASS[tone]}`} aria-hidden="true" />
      {label && (
        <span className="cb-status-lbl">{label}</span>
      )}
    </span>
  );
}
