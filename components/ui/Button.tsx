import type { ButtonHTMLAttributes, ElementType } from 'react';
import { cx } from './cx';
import styles from './Button.module.css';

/**
 * Button — the canonical KIDS FUN action control.
 *
 * Brand spec (Workbook V2 §7 "Button and chip states"):
 *   primary   = Leaf fill + Forest-ink text (the one action colour, D10)
 *   secondary = white/surface fill + neutral border + ink text
 *   outline   = transparent + Leaf BORDER + ink text — the one action colour used as an
 *               outline rather than a fill, so a secondary action reads as on-brand and
 *               clearly interactive without becoming a second primary on the same screen
 *   ghost     = transparent, ink text (low-emphasis inline action)
 *   danger    = red-brown fill + white text for destructive actions
 *               (e.g. account deletion) — factual, not alarming (Workbook V2 §3)
 *
 * Server-compatible: no hooks, no `use client`. It renders a native <button>,
 * so a parent Server Component (e.g. the home hero's plain <form>) can use it
 * with zero client JS. Attach handlers from a client component if you need them.
 * All native button props (type, disabled, aria-*, form actions…) pass through.
 *
 * Polymorphic via `as`: `as="a"` (or `as={Link}`) renders a real anchor so a
 * NAVIGATION action (e.g. a saved-search "Open" link) can share the button system
 * while keeping anchor semantics — right-click, middle-click, open-in-new-tab —
 * that a <button> cannot provide. `size="sm"` gives a compact list-row-density
 * control, so a matched link+button pair (e.g. "Open" + "Delete") can both adopt
 * the primitive without a full 48px CTA blowing up the row height.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Compact list-row density ('sm', 36px) vs the default 48px CTA ('md'). */
  size?: ButtonSize;
  /** Stretch to the full width of the container (e.g. sticky bottom action bar). */
  fullWidth?: boolean;
  /**
   * Render as a different element/component so a real link can share the button
   * system. `as="a"` or `as={Link}` keeps anchor semantics a <button> can't. The
   * default renders a native <button>.
   */
  as?: ElementType;
  /** Anchor destination when `as` renders a link (ignored by the default <button>). */
  href?: string;
  /** Anchor target/rel when `as` renders a link. */
  target?: string;
  rel?: string;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  as,
  type,
  className,
  children,
  ...rest
}: ButtonProps) {
  const Tag = as ?? 'button';
  // A real <button> defaults to type="button" so it never becomes an accidental
  // form submit; a polymorphic element (<a>, Link) must NOT carry a button `type`.
  const typeAttr = Tag === 'button' ? type ?? 'button' : type;
  return (
    <Tag
      type={typeAttr}
      data-variant={variant}
      data-size={size}
      className={cx(
        styles.btn,
        styles[variant],
        size === 'sm' && styles.sm,
        fullWidth && styles.block,
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
