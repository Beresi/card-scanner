/**
 * Btn — chamfered action button.
 *
 * Emits:
 *   cb-btn               (base — always)
 *   cb-btn-primary       (variant="primary")
 *   cb-btn-ghost         (variant="ghost")   ← cb-btn-quiet in the handoff CSS; alias here
 *   cb-btn-danger        (variant="danger")
 *
 * Note: the handoff CSS uses cb-btn-quiet for the "ghost" look.
 * This component emits cb-btn-ghost for the ghost variant AND cb-btn-quiet as a
 * secondary alias so the existing handoff CSS picks it up with zero CSS additions.
 * The design-agent should add a cb-btn-ghost rule (or an alias) in the component CSS.
 *
 * All DOM button attributes (aria-*, data-*, disabled, title, form, …) pass through
 * via rest spread.
 */
import type { ButtonHTMLAttributes } from 'react';

export type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  className?: string;
}

// Variant → cb- modifier mapping.
// ghost maps to cb-btn-quiet (handoff name) so existing CSS covers it without new rules.
const VARIANT_CLASS: Record<BtnVariant, string | undefined> = {
  default: undefined,
  primary: 'cb-btn-primary',
  ghost: 'cb-btn-ghost cb-btn-quiet',
  danger: 'cb-btn-danger',
};

export function Btn({
  variant = 'default',
  className,
  type = 'button',
  children,
  ...rest
}: BtnProps) {
  const rootClass = [
    'cb-btn',
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={rootClass} {...rest}>
      {children}
    </button>
  );
}
