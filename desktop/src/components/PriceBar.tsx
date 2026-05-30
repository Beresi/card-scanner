/**
 * PriceBar — horizontal fill gauge showing price as a fraction of the baseline.
 *
 * Emits:
 *   cb-pbar              (track — always)
 *   cb-pbar-fill         (fill div — always)
 *   cb-pbar-fill--good   (tone="good")   ← NOT yet in desktop CSS; see design-agent note below
 *   cb-pbar-fill--hot    (tone="hot")    ← NOT yet in desktop CSS; see design-agent note below
 *   cb-pbar-base         (baseline tick at 100%)
 *
 * All cb-pbar-* base classes exist in the handoff ui.css; the tone modifier
 * classes (cb-pbar-fill--good, cb-pbar-fill--hot) are NEW and must be added
 * by the design-agent.  The default fill colour already uses --good per
 * the handoff, so tone="good" is visually identical to no modifier until the
 * design-agent differentiates hot.
 *
 * Props:
 *   value   — current value (e.g. discount_pct 0–100, or raw price cents)
 *   max     — 100 by default; set to baseline_cents when passing raw prices
 *   tone    — colour variant; the caller decides which tone fits the deal priority
 *   title   — optional tooltip; defaults to "{value}% of baseline"
 *
 * The component ONLY renders the bar. It does NOT compute price ratios —
 * the caller (DealCard etc.) derives value/max from the deal data and passes
 * the result in.
 */
export type PriceBarTone = 'default' | 'good' | 'hot';

export interface PriceBarProps {
  /** Numerator value (e.g. discount_pct, or raw price cents). */
  value: number;
  /** Denominator; defaults to 100 (i.e. value is already a percentage). */
  max?: number;
  tone?: PriceBarTone;
  /** Override the generated title tooltip. */
  title?: string;
  className?: string;
}

const FILL_TONE_CLASS: Record<PriceBarTone, string | undefined> = {
  default: undefined,
  good:    'cb-pbar-fill--good',
  hot:     'cb-pbar-fill--hot',
};

export function PriceBar({
  value,
  max = 100,
  tone = 'default',
  title,
  className,
}: PriceBarProps) {
  // Clamp fill to [0, 100]%.  Use a minimum of 4% so the fill is always visible.
  const pct = Math.max(4, Math.min(100, (value / (max === 0 ? 1 : max)) * 100));
  const tooltipText = title ?? `${Math.round(pct)}% of baseline`;

  const trackClass = ['cb-pbar', className].filter(Boolean).join(' ');
  const fillClass  = ['cb-pbar-fill', FILL_TONE_CLASS[tone]].filter(Boolean).join(' ');

  return (
    <div className={trackClass} title={tooltipText} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={fillClass} style={{ width: `${pct}%` }} />
      <div className="cb-pbar-base" />
    </div>
  );
}
