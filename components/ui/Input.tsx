import type { InputHTMLAttributes } from 'react';
import { cx } from './cx';
import styles from './Input.module.css';

/**
 * Input — the canonical KIDS FUN text field.
 *
 * Defaults tuned for real mobile use (Blueprint mobile-first §): 48px min target
 * (WCAG 2.5.8), 16px font so iOS never zoom-on-focuses, tabular numerals for the
 * data a parent types (dates, ages, postal codes). Server-compatible; forwards
 * every native input prop (type, name, placeholder, aria-*, enterKeyHint…).
 */
export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ type = 'text', className, ...rest }: InputProps) {
  return <input type={type} className={cx(styles.input, className)} {...rest} />;
}
