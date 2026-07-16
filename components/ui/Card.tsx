import type { ElementType, HTMLAttributes } from 'react';
import { cx } from './cx';
import styles from './Card.module.css';

/**
 * Card — the canonical KIDS FUN content surface.
 *
 * A calm white/surface panel with a hairline border, 16px radius and the
 * Elevation-100 shadow (Workbook V2 §6). Depth comes from the small, consistent
 * elevation set + hairlines — no gradients, no glass (D10). Polymorphic via `as`
 * so it can be a <li>, <article> or <section> without extra wrappers; defaults
 * to <div>. `interactive` adds the hover lift used for tappable cards.
 */
export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  interactive?: boolean;
}

export function Card({ as, interactive = false, className, children, ...rest }: CardProps) {
  const Tag = as ?? 'div';
  return (
    <Tag className={cx(styles.card, interactive && styles.interactive, className)} {...rest}>
      {children}
    </Tag>
  );
}
