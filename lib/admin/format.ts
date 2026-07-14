// lib/admin/format.ts — small pure display helpers for the admin dashboard.
// Kept DB-free and side-effect-free (time is passed in) so they are unit-testable.

const EM_DASH = '—';

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

/** Integer with thousands separators; null/undefined → "0". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0';
  return n.toLocaleString('en-CA');
}
