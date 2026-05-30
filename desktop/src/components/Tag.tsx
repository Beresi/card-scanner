/**
 * Tag — small inline chip for metadata, priority, and status labels.
 *
 * Emits:
 *   cb-tag               (base — always)
 *   cb-tag-accent        (tone="accent")
 *   cb-tag-good          (tone="good")
 *   cb-tag-hot           (tone="hot")
 *   cb-tag-warn          (tone="warn")
 *   (no modifier for tone="default" — uses the base cb-tag neutral style)
 *
 * All cb-tag-* modifier classes exist in the handoff ui.css.
 */
export type TagTone = 'default' | 'good' | 'warn' | 'hot' | 'accent';

export interface TagProps {
  tone?: TagTone;
  /** Optional native title tooltip. */
  title?: string;
  children: React.ReactNode;
  className?: string;
}

const TONE_CLASS: Record<TagTone, string | undefined> = {
  default: undefined,
  accent:  'cb-tag-accent',
  good:    'cb-tag-good',
  hot:     'cb-tag-hot',
  warn:    'cb-tag-warn',
};

export function Tag({ tone = 'default', title, children, className }: TagProps) {
  const rootClass = [
    'cb-tag',
    TONE_CLASS[tone],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={rootClass} title={title}>
      {children}
    </span>
  );
}
