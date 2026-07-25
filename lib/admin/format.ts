// lib/admin/format.ts — small pure display helpers for the admin dashboard.
// Kept DB-free and side-effect-free (time is passed in) so they are unit-testable.

/** The one glyph that means "there is no number to state here". */
export const EM_DASH = '—';

/** ISO timestamp → compact "YYYY-MM-DD HH:MM:SSZ" (UTC). Null/invalid → em dash. */
export function formatTimestampUtc(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Human "age" of a timestamp relative to nowMs. Null/invalid → "never". */
export function formatAge(value: string | null | undefined, nowMs: number): string {
  if (!value) return 'never';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return 'never';
  const diffMs = Math.max(0, nowMs - t);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Milliseconds → "850ms" / "11.2s". Null → em dash. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return EM_DASH;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Interval seconds → compact cadence like "1d" / "6h" / "30m" / "45s". Null/≤0 → em dash. */
export function formatCadence(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds <= 0) return EM_DASH;
  const s = Math.round(seconds);
  if (s % 86_400 === 0) return `${s / 86_400}d`;
  if (s % 3_600 === 0) return `${s / 3_600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * Integer with thousands separators, for a count that IS KNOWN.
 *
 * ── WHY THIS ONLY ACCEPTS `number` (H1 follow-up, QA A1) ───────────────────────
 * It used to accept `number | null | undefined` and return "0" for null. That made
 * it a hole straight through the type-level guarantee the H1 change was built to
 * establish: measures were typed `number | null` so that a surface forgetting the
 * pre-history distinction would fail to COMPILE — but a surface writing
 * `<td>{formatCount(point.dau)}</td>` typechecked, linted, and rendered a confident
 * "0" for a period that never existed. The exact defect H1 removed, relocated into
 * the project's standard formatter.
 *
 * The clinching evidence was in H1's own diff: SentryIssuePanel carried a comment
 * warning the next reader that "formatCount(null) returns '0' ... the null check has
 * to happen HERE". A warning comment is only ever necessary where the compiler is
 * silent, so the comment was itself the bug report. That call site now routes through
 * {@link formatMeasure} and the comment is gone, because the compiler enforces it.
 *
 * Narrowing cost almost nothing: every production call site already passed a real
 * `number`. Passing a nullable is now a type error — use {@link formatMeasure}, and
 * if the null genuinely means zero, say so explicitly with `?? 0` at the call site
 * where that claim can be reviewed.
 *
 * NaN renders as an em-dash rather than "0": a count that is not a number is not
 * zero, and fabricating one inside the very helper being hardened would be
 * indefensible. No current call site can produce NaN, so this is unreachable today.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString('en-CA');
}

/**
 * A measure that may not exist: a real number renders normally, absence renders as an
 * em-dash. NEVER "0".
 *
 * This is the counterpart to {@link formatCount} and the correct tool for anything
 * typed `number | null` — a pre-history period (see lib/analytics/prehistory.ts), a
 * rate with no denominator, an unwatched day on the Sentry panel. The distinction it
 * protects is the whole point of the operating dashboards: "we measured zero" and
 * "there was nothing to measure" are opposite claims, and a genuine, measured 0 must
 * stay a plainly visible 0 because that is the traffic-cliff signal the daily review
 * exists to catch.
 */
export function formatMeasure(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString('en-CA');
}
