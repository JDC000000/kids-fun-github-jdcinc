// lib/analytics/prehistory.ts — the "measured zero vs. nothing to measure" primitive (H1).
//
// ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────────
// This logic used to live inside lib/analytics/operating.ts, where it was correct but
// only reachable by things willing to import a DB-coupled module — and, more
// importantly, only ever applied by a surface that REMEMBERED to apply it. Independent
// QA found the same defect shipped six times across three tasks: a period that closed
// before a data source existed rendered as a real, confident `0`, which on a dashboard
// reads as "we measured this and it was zero" — a traffic outage, a dead ingestion
// pipeline, a silent product. It was never any of those. There was simply nothing to
// measure yet.
//
// The generating cause was structural, not careless. `OperatingPeriodCounts` carries
// `partial: boolean` IN THE DATA, so a new surface cannot forget it. Pre-history was
// carried nowhere, so every new surface had to re-derive it — from the right anchor,
// for the right table — and three surfaces in a row did not. The fix is to make
// pre-history a first-class part of the data the same way `partial` already is, and to
// type the values so that rendering an unmeasurable period as a number is a COMPILE
// ERROR rather than a silent lie. See TrendPoint (lib/analytics/trends.ts) and
// SentryTrendPoint (lib/observability/sentry-issues.ts) for the two types this landed
// on, and docs/kpi-cadence.md §7.
//
// It lives here — pure, dependency-free, no database, no framework — so that
// lib/observability/ can use the identical primitive without importing the analytics
// read layer (and its pg pool) to get it. lib/analytics/operating.ts re-exports these
// verbatim, so every existing call site keeps its current import unchanged.

/** The bucket size a period series is cut into. */
export type PeriodGrain = 'day' | 'month';

/**
 * Exclusive end of a bucket, as an epoch-ms UTC instant.
 *
 * ⚠️ TIMEZONE COUPLING (known, correct today, documented rather than defended): the
 * bucket KEYS are produced by Postgres `date_trunc`, which uses the DB SESSION
 * timezone, while this function interprets them in UTC. The two agree only while the
 * database session runs in UTC — which it does on CI (the postgis container defaults
 * to UTC) and on Supabase (UTC default). If a future deployment ever sets a non-UTC
 * session timezone, bucket boundaries here would drift by the offset and pre-history
 * suppression could be off by up to a day at the edge. The fix, if that day comes, is
 * to have the SQL return an explicit UTC-normalised boundary rather than to patch the
 * arithmetic here. See docs/kpi-cadence.md §7.
 */
export function periodEndMs(periodStart: string, grain: PeriodGrain): number {
  const [year, month, day] = periodStart.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return Number.NaN;
  return grain === 'month' ? Date.UTC(year, month, 1) : Date.UTC(year, month - 1, (day ?? 1) + 1);
}

/**
 * Whether a bucket ended BEFORE the data source had any recorded history at all.
 *
 * This is the difference between "we measured zero" and "there was nothing to
 * measure", and getting it wrong is a real, load-bearing lie on a dashboard read
 * days after launch: a monthly review that compares July against a June in which the
 * product did not yet exist would report "MAU 0, steady" — flat, unremarkable, and
 * completely wrong. Pre-history buckets therefore carry `null` (→ em-dash, direction
 * 'unknown'), not 0.
 *
 * Crucially this is NOT the same as "the bucket has no events". A day AFTER launch on
 * which nobody visited is a genuine, measured zero and must keep reading 0 — that is
 * precisely the traffic-cliff signal the daily review exists to catch, and suppressing
 * it would hide an outage. Only buckets that closed before the very first record are
 * suppressed. Over-correcting into "everything before now is uncertain" is its own
 * bug, the mirror image of the one this guards against.
 *
 * The anchor is per-SOURCE, never per-product: pre-history is a property of the TABLE
 * a number is read from. Anchoring an ingestion KPI on the first analytics event once
 * hid three genuinely failed check runs behind an em-dash (see OperatingDataAnchors in
 * lib/admin/operating.ts for that post-mortem).
 *
 * When there is no recorded history at all (`firstRecordedAtMs == null`), nothing is
 * suppressed: with no anchor we cannot claim a period predates anything, so the
 * honest reading is the raw zeros. This is deliberate. A caller that wants a
 * different answer on an empty source must say so in its own prose — do not "fix" it
 * here, because "no rows yet" and "this period predates the source" are different
 * claims and only the second one is knowable from an absent anchor.
 */
export function isPreHistory(
  periodStart: string,
  grain: PeriodGrain,
  firstRecordedAtMs: number | null
): boolean {
  if (firstRecordedAtMs == null || !Number.isFinite(firstRecordedAtMs)) return false;
  const end = periodEndMs(periodStart, grain);
  return Number.isFinite(end) && end <= firstRecordedAtMs;
}

/**
 * Epoch-ms for an ISO timestamp, or null when absent/unparseable.
 *
 * Anchors arrive as ISO strings from every coverage reader in the codebase and were
 * being re-parsed with a locally-defined `parse` helper at each one. Same primitive,
 * one definition — a `NaN` anchor must degrade to "no anchor" (suppress nothing), not
 * to a comparison that silently returns false in a way nobody can trace.
 */
export function anchorMsFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
