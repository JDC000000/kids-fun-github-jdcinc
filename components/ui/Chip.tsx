import type { ButtonHTMLAttributes, ElementType } from 'react';
import { cx } from './cx';
import styles from './Chip.module.css';

/**
 * Chip — the canonical KIDS FUN SELECTION control (filter chips, sort/cost chips,
 * and the list/map segmented toggle).
 *
 * This is a distinct vocabulary from `Button`, NOT a Button variant. A `Button`
 * is a one-shot CTA (Leaf action fill, D10); a `Chip` carries a SELECTED / PRESSED
 * *state* — the selection is expressed with `aria-current` or `aria-pressed`, which
 * the *caller* supplies so each real usage keeps its exact semantics. The primitive
 * owns only the visual state + the checkmark, never the aria — so it can never quietly
 * change a control's meaning (Workbook V2 §7 "Button and chip states").
 *
 * ⚠️ ARIA-by-element: `aria-pressed` is a BUTTON-only toggle state — only pass it on the
 * default `<button>` / `segmented` variant (e.g. the list/map view toggle). When the chip
 * renders as a link (`as={Link}` / `as="a"`, implicit `role="link"`), the ONLY valid
 * selected-state attribute is `aria-current` — passing `aria-pressed` on an anchor is a
 * WCAG 4.1.2 / axe `aria-allowed-attr` violation. The URL-driven filter chips therefore use
 * `aria-current` uniformly for both radio-like and multi-select groups.
 *
 * Two shapes:
 *   rail       = the standalone scroll-snap pill (filter / sort / cost). Selected =
 *                pale-confirmed fill + dark-confirmed text + a ✓ (never colour alone,
 *                WCAG 1.4.1 / D10). `size="sm"` gives the tighter sort/cost density.
 *   segmented  = a segment inside a shared bordered container (the list/map view
 *                toggle). Selected/on = Forest-ink on Leaf = 7.61:1 in BOTH schemes
 *                (a FIXED brand pair). This REPLACES the old white-on-Leaf on-state,
 *                which was 2.17:1 and FAILED WCAG AA — the same class of bug Task K
 *                fixed on the search submit. Fixed for good, contrast-tested.
 *
 * `action` is the low-frequency "Near me" affordance: an anchor-outlined rail chip
 * (Leaf stays reserved for the one primary Search CTA, Workbook §7).
 *
 * Server-compatible: no hooks, no `use client`. Renders a native `<button>` by
 * default (so a Server Component can use it with zero client JS); `as="a"` /
 * `as={Link}` renders a real anchor for a URL-driven filter (right-/middle-click,
 * open-in-new-tab, share) and `as="span"` renders a static, non-interactive
 * status indicator ("Near you"). Every native prop (aria-*, onClick, disabled,
 * href…) passes straight through.
 */
export type ChipVariant = 'rail' | 'segmented';
export type ChipSize = 'md' | 'sm';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 'rail' (default) = standalone pill; 'segmented' = a segment in a shared toggle. */
  variant?: ChipVariant;
  /** Rail density: 'md' (default, 40px filter chip) vs 'sm' (32px sort/cost chip). Ignored by 'segmented'. */
  size?: ChipSize;
  /** Visual selected/on state. Drives the fill + (rail only) the ✓. The caller still
   *  passes the matching `aria-current`/`aria-pressed` so selection SEMANTICS are exact. */
  selected?: boolean;
  /** Rail-only anchor-outline affordance for the low-frequency "Near me" control. */
  action?: boolean;
  /**
   * Render as a different element so a real link / static indicator can share the
   * chip system. `as="a"` / `as={Link}` keeps anchor semantics; `as="span"` renders
   * a non-interactive status chip. Defaults to a native `<button>`.
   */
  as?: ElementType;
  /** Anchor destination when `as` renders a link (ignored by the default `<button>`). */
  href?: string;
  /** Anchor target/rel when `as` renders a link. */
  target?: string;
  rel?: string;
}

export function Chip({
  variant = 'rail',
  size = 'md',
  selected = false,
  action = false,
  as,
  type,
  className,
  children,
  ...rest
}: ChipProps) {
  const Tag = as ?? 'button';
  // A real <button> defaults to type="button" so a chip inside a <form> never becomes
  // an accidental submit; a polymorphic element (<a>, Link, <span>) must NOT carry one.
  const typeAttr = Tag === 'button' ? type ?? 'button' : type;
  // Selected rail chips show the state as fill AND a ✓ (never colour alone, D10). The
  // segmented toggle expresses its on-state with the fill + aria-pressed, not a ✓.
  const showCheck = variant === 'rail' && selected;
  return (
    <Tag
      type={typeAttr}
      data-variant={variant}
      data-size={variant === 'rail' ? size : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cx(
        styles.chip,
        styles[variant],
        variant === 'rail' && size === 'sm' && styles.sm,
        selected && styles.selected,
        action && styles.action,
        className,
      )}
      {...rest}
    >
      {showCheck && (
        <span className={styles.check} aria-hidden="true">
          ✓
        </span>
      )}
      {children}
    </Tag>
  );
}
