import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import styles from './Button.module.css';

/**
 * Button — the canonical KIDS FUN action control.
 *
 * Brand spec (Workbook V2 §7 "Button and chip states"):
 *   primary   = Leaf fill + Forest-ink text (the one action colour, D10)
 *   secondary = white/surface fill + neutral border + ink text
 *   ghost     = transparent, ink text (low-emphasis inline action)
 *
 * Server-compatible: no hooks, no `use client`. It renders a native <button>,
 * so a parent Server Component (e.g. the home hero's plain <form>) can use it
 * with zero client JS. Attach handlers from a client component if you need them.
 * All native button props (type, disabled, aria-*, form actions…) pass through.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Stretch to the full width of the container (e.g. sticky bottom action bar). */
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  fullWidth = false,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      className={cx(styles.btn, styles[variant], fullWidth && styles.block, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
