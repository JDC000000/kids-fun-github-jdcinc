import type { HTMLAttributes } from 'react';
import { cx } from './cx';
import styles from './Badge.module.css';

/**
 * Badge — the canonical KIDS FUN status/label pill.
 *
 * A pale semantic fill + dark semantic text pill (Workbook V2 §3 semantic
 * colours / §11 confidence labels). It NEVER conveys meaning by colour alone —
 * the label is the children the caller supplies, so screen-reader and
 * colour-blind users read the state in words (WCAG 1.4.1 / D10). This is the
 * primitive the activity-card and detail-page status chips ("Confirmed",
 * "Schedule not posted yet", "Cancelled") should adopt next round.
 */
export type BadgeVariant = 'confirmed' | 'info' | 'expected' | 'cancelled' | 'neutral';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span data-variant={variant} className={cx(styles.badge, styles[variant], className)} {...rest}>
      {children}
    </span>
  );
}
