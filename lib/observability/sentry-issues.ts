// lib/observability/sentry-issues.ts — READ-ONLY Sentry issue trend (M7 / T41, G-T41-1).
//
// The operating dashboard's "is production breaking?" signal. Sentry is where KIDS
// FUN's real production errors land (T37/R29 wired both the Next app and the Fly
// worker), but nothing in this codebase has ever READ from Sentry — only written to
// it. This module is that read path, and it is deliberately the smallest one that can
// answer the two questions a daily review asks: how many issues are currently
// unresolved, and are NEW issues appearing faster or slower than before.
//
// ── THE HONESTY CONTRACT ───────────────────────────────────────────────────────
// This module NEVER invents a number. It returns a discriminated union with three
// states, and the dashboard renders each of them differently:
//   • 'unconfigured' — no read token / org / project in this environment. The panel
//                      says so and explains what to set. It does NOT render zeros.
//   • 'unavailable'  — configured, but the call failed or timed out. The panel says
//                      the trend could not be read. It does NOT render zeros.
//   • 'ok'           — real counts from the real Sentry API.
// A zero on this panel therefore always means "Sentry really reported zero", never
// "we could not tell". That distinction is the whole point of the panel: a silent 0
// on an error dashboard is worse than an explicit "unknown".
//
// ── CREDENTIAL SAFETY ──────────────────────────────────────────────────────────
// The token is read via lib/observability/config.ts, shape-validated there, and used
// ONLY as an Authorization header value. It never appears in a URL, a log line, or a
// returned `reason` string: the failure paths below surface an HTTP status code or an
// error NAME (never `err.message`, which upstream libraries have been known to build
// by echoing request headers).
//
// ── PRE-HISTORY (H1 item 3) ────────────────────────────────────────────────────
// The same honesty contract applies WITHIN the 'ok' state, along the time axis. The
// trend zero-filled every day in the window, so a day before this project was being
// watched looked exactly like a genuinely quiet day — and on an error panel those two
// readings mean opposite things. Days that closed before the configured observation
// start now carry `null`, using the identical rule the analytics dashboards use
// (lib/analytics/prehistory.ts). With no observation start configured — the default,
// and the current production state — nothing is suppressed and the trend is unchanged.
import {
  isSentryIssuesConfigured,
  sentryApiBaseUrl,
  sentryIssuesApiToken,
  sentryObservedSinceMs,
  sentryOrg,
  sentryProject,
} from './config';
// Pure, DB-free primitive — importing it here costs this module nothing and guarantees
// "before the source existed" means the same thing on the error panel as on the KPI
// cards two sections above it.
import { isPreHistory } from '@/lib/analytics/prehistory';

/** How long the dashboard is willing to wait for Sentry before giving up. */
export const SENTRY_FETCH_TIMEOUT_MS = 4_000;
/** Trailing days the issue trend covers. */
export const SENTRY_TREND_DAYS = 14;
/** Cap on issues pulled — a trend, not a log viewer. */
export const SENTRY_ISSUE_LIMIT = 100;

/**
 * One day of the issue trend.
 *
 * `newIssues` is nullable for the same structural reason TrendPoint's measures are
 * (see lib/analytics/prehistory.ts): a boolean flag alone can be ignored by a new
 * surface and still compile, whereas a nullable measure cannot reach a formatter
 * without that surface deciding, in compiler-checked code, what an unwatched day
 * looks like. INVARIANT: `preHistory === true` ⟺ `newIssues === null`.
 */
export interface SentryTrendPoint {
  /** UTC calendar day, 'YYYY-MM-DD'. */
  date: string;
  /**
   * True when this day closed before the project was being watched — nothing could
   * have been reported, so `newIssues` is null rather than 0. Always false when no
   * observation start is configured.
   */
  preHistory: boolean;
  /**
   * Issues whose FIRST occurrence was on this day (i.e. genuinely new problems).
   * Null iff pre-history. A real 0 — a watched day on which nothing broke — stays 0,
   * because that is the good news this panel exists to report.
   */
  newIssues: number | null;
}

export type SentryIssueTrend =
  | { state: 'unconfigured'; reason: string }
  | { state: 'unavailable'; reason: string }
  | {
      state: 'ok';
      org: string;
      project: string;
      windowDays: number;
      /** Unresolved issues currently open in the window. */
      unresolvedIssues: number;
      /** Total events across those issues in the window. */
      totalEvents: number;
      /** Whether the issue list hit SENTRY_ISSUE_LIMIT (so counts are a floor). */
      truncated: boolean;
      /** Oldest→newest, one entry per day, gaps zero-filled. */
      points: SentryTrendPoint[];
    };

/** The subset of Sentry's issue payload this module relies on. */
interface SentryIssue {
  firstSeen?: string;
  count?: string | number;
}

/** UTC 'YYYY-MM-DD' for a Date. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket issues by the UTC day they were FIRST seen, over a gap-free trailing window.
 *
 * Pure and clock-injected so it is unit-testable without a network or a fixed date.
 * Issues first seen before the window start are counted in the totals by the caller
 * but contribute no point here — they are not *new* problems in this window.
 *
 * `observedSinceMs` is the instant this project started being watched. Days that
 * CLOSED at or before it get `newIssues: null` (nothing could have been reported)
 * rather than 0. Null/omitted — the default — suppresses nothing, exactly as
 * isPreHistory() does without an anchor. Counting still happens before suppression so
 * an issue whose `firstSeen` predates the configured anchor cannot be double-counted
 * into a later day; it simply lands on a day that is then reported as unmeasurable.
 */
export function buildIssueTrend(
  issues: SentryIssue[],
  nowMs: number,
  windowDays: number = SENTRY_TREND_DAYS,
  observedSinceMs: number | null = null
): SentryTrendPoint[] {
  const days = Math.min(90, Math.max(1, Math.trunc(windowDays)));
  const counts = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    counts.set(utcDay(new Date(nowMs - i * 86_400_000)), 0);
  }
  for (const issue of issues) {
    if (!issue.firstSeen) continue;
    const t = new Date(issue.firstSeen);
    if (Number.isNaN(t.getTime())) continue;
    const key = utcDay(t);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([date, newIssues]) => {
    // 'day' grain: these keys ARE UTC calendar days, so the shared rule applies as-is.
    const preHistory = isPreHistory(date, 'day', observedSinceMs);
    return { date, preHistory, newIssues: preHistory ? null : newIssues };
  });
}

/** Sum an issue list's event counts, tolerating Sentry's string-or-number `count`. */
export function sumIssueEvents(issues: SentryIssue[]): number {
  return issues.reduce((total, issue) => {
    const n = typeof issue.count === 'string' ? Number.parseInt(issue.count, 10) : issue.count;
    return total + (Number.isFinite(n) ? (n as number) : 0);
  }, 0);
}

/**
 * Read the live Sentry issue trend. NEVER throws and never blocks the page for longer
 * than SENTRY_FETCH_TIMEOUT_MS — an observability panel must not be able to take down
 * the dashboard that displays it.
 *
 * `nowMs` is injectable so the trend bucketing is testable against a fixed clock.
 */
export async function getSentryIssueTrend(nowMs: number = Date.now()): Promise<SentryIssueTrend> {
  if (!isSentryIssuesConfigured()) {
    return {
      state: 'unconfigured',
      reason:
        'Set SENTRY_ORG, SENTRY_PROJECT and a read-only SENTRY_ISSUES_API_TOKEN (scopes: project:read, event:read) to enable the live issue trend.',
    };
  }

  const org = sentryOrg() as string;
  const project = sentryProject() as string;
  const token = sentryIssuesApiToken() as string;

  const url = `${sentryApiBaseUrl()}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(
    project
  )}/issues/?statsPeriod=${SENTRY_TREND_DAYS}d&query=${encodeURIComponent('is:unresolved')}&limit=${SENTRY_ISSUE_LIMIT}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(SENTRY_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    // Surface the error NAME only ('TimeoutError', 'TypeError'), never its message —
    // a message can carry request detail, and request detail carries the header.
    return { state: 'unavailable', reason: `Sentry request failed (${(err as Error)?.name ?? 'unknown'}).` };
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' — the token is missing project:read / event:read scope.'
        : '';
    return { state: 'unavailable', reason: `Sentry API returned HTTP ${response.status}${hint}` };
  }

  let issues: SentryIssue[];
  try {
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      return { state: 'unavailable', reason: 'Sentry API returned an unexpected payload shape.' };
    }
    issues = body as SentryIssue[];
  } catch {
    return { state: 'unavailable', reason: 'Sentry API returned a body that was not valid JSON.' };
  }

  return {
    state: 'ok',
    org,
    project,
    windowDays: SENTRY_TREND_DAYS,
    unresolvedIssues: issues.length,
    totalEvents: sumIssueEvents(issues),
    truncated: issues.length >= SENTRY_ISSUE_LIMIT,
    points: buildIssueTrend(issues, nowMs, SENTRY_TREND_DAYS, sentryObservedSinceMs()),
  };
}
