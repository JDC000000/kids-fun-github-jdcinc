/**
 * cx — tiny classNames joiner for the KIDS FUN UI primitives.
 *
 * Keeps the primitives dependency-free (no `clsx`) while giving a single,
 * unit-tested place for class composition. Falsy values (false, null, undefined,
 * '') are dropped so `cx(styles.btn, active && styles.on, className)` reads
 * cleanly at the call site.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ');
}
