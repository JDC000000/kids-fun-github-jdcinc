import type { TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import styles from './Textarea.module.css';

/**
 * Textarea — the canonical KIDS FUN multi-line text field.
 *
 * The multi-line twin of `Input`: same 16px font (so iOS never zoom-on-focuses),
 * the same token-driven border / radius / elevation and the same focus ring, so a
 * `<Textarea>` sits flush beside an `<Input>` in one form (e.g. a saved-search name
 * Input above a filters Textarea) with no visual seam — and in dark mode both share
 * the primitive's border, so a mixed form no longer splits into "crisp Input + subtle
 * bespoke textarea" (Round 12 / Task I QA finding #1). Server-compatible; forwards
 * every native textarea prop (name, rows, placeholder, maxLength, aria-*, value/onChange…).
 */
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={cx(styles.textarea, className)} {...rest} />;
}
