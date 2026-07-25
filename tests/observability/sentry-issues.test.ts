// tests/observability/sentry-issues.test.ts — the Sentry issue-trend read path (T41).
//
// No network is touched: the bucketing/summing helpers are pure and clock-injected,
// and the state machine is exercised by manipulating the environment. The single most
// important assertion in this file is that an unreadable Sentry NEVER degrades into
// zeros — an error dashboard that silently reads 0 when it cannot reach the error
// source is worse than one that says "unknown".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIssueTrend, getSentryIssueTrend, sumIssueEvents, SENTRY_TREND_DAYS } from '../../lib/observability/sentry-issues';
import {
  isSentryIssuesConfigured,
  sentryIssuesApiToken,
  sentryObservedSinceMs,
} from '../../lib/observability/config';

const ENV_KEYS = [
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SENTRY_ISSUES_API_TOKEN',
  'SENTRY_API_BASE_URL',
  'SENTRY_OBSERVED_SINCE',
] as const;

describe('buildIssueTrend', () => {
  // A fixed clock so the expected day keys are deterministic in every timezone.
  const now = Date.parse('2026-07-25T12:00:00Z');

  it('returns a gap-free, ascending window ending today', () => {
    const points = buildIssueTrend([], now, 5);
    expect(points).toHaveLength(5);
    expect(points.map((p) => p.date)).toEqual([
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    expect(points.every((p) => p.newIssues === 0)).toBe(true);
  });

  it('buckets issues by the UTC day they were FIRST seen', () => {
    const points = buildIssueTrend(
      [
        { firstSeen: '2026-07-24T01:00:00Z' },
        { firstSeen: '2026-07-24T23:59:59Z' },
        { firstSeen: '2026-07-25T00:00:01Z' },
      ],
      now,
      5
    );
    expect(points.find((p) => p.date === '2026-07-24')?.newIssues).toBe(2);
    expect(points.find((p) => p.date === '2026-07-25')?.newIssues).toBe(1);
  });

  it('ignores issues outside the window and malformed/missing timestamps', () => {
    const points = buildIssueTrend(
      [
        { firstSeen: '2020-01-01T00:00:00Z' }, // long before the window
        { firstSeen: 'not-a-date' },
        {}, // no firstSeen at all
      ],
      now,
      5
    );
    expect(points.reduce((sum, p) => sum + (p.newIssues ?? 0), 0)).toBe(0);
  });

  it('clamps a nonsense window rather than allocating unbounded buckets', () => {
    expect(buildIssueTrend([], now, 0)).toHaveLength(1);
    expect(buildIssueTrend([], now, -3)).toHaveLength(1);
    expect(buildIssueTrend([], now, 10_000)).toHaveLength(90);
    expect(buildIssueTrend([], now)).toHaveLength(SENTRY_TREND_DAYS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-history along the TIME axis (H1 item 3).
//
// The module's headline honesty contract covers the three STATES (unconfigured /
// unavailable / ok). This is the same contract applied within the 'ok' state: a day
// before the project was being watched is not a quiet day, and on an error panel those
// two readings mean opposite things.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIssueTrend — days before the project was watched', () => {
  const now = Date.parse('2026-07-25T12:00:00Z');
  // Watching began mid-morning on 2026-07-23.
  const watchedSince = Date.parse('2026-07-23T10:00:00Z');

  it('dashes days that CLOSED before watching began, and only those', () => {
    const points = buildIssueTrend([], now, 5, watchedSince);
    expect(points.map((p) => [p.date, p.preHistory, p.newIssues])).toEqual([
      ['2026-07-21', true, null],
      ['2026-07-22', true, null],
      // The day watching started is partially observed, so it is measurable.
      ['2026-07-23', false, 0],
      ['2026-07-24', false, 0],
      ['2026-07-25', false, 0],
    ]);
  });

  it('NO-REGRESSION: a watched day with no new issues stays a real 0, not a dash', () => {
    // This is the panel's best news — "nothing broke today" — and the mirror-image bug
    // would erase it. A quiet watched day must never be confused with an unwatched one.
    const points = buildIssueTrend([{ firstSeen: '2026-07-25T01:00:00Z' }], now, 5, watchedSince);
    const quiet = points.find((p) => p.date === '2026-07-24')!;
    expect(quiet.preHistory).toBe(false);
    expect(quiet.newIssues).toBe(0);
    expect(quiet.newIssues).not.toBeNull();
  });

  it('INVARIANT: preHistory ⟺ newIssues is null', () => {
    const points = buildIssueTrend([{ firstSeen: '2026-07-24T05:00:00Z' }], now, 5, watchedSince);
    for (const p of points) expect(p.newIssues === null).toBe(p.preHistory);
  });

  it('suppresses NOTHING when no observation start is configured (today’s behaviour)', () => {
    // The production default. Omitting the anchor must leave the trend byte-for-byte
    // what it was before H1 — this change is opt-in, not a silent behavioural shift.
    const issues = [{ firstSeen: '2026-07-24T05:00:00Z' }];
    expect(buildIssueTrend(issues, now, 5)).toEqual(buildIssueTrend(issues, now, 5, null));
    expect(buildIssueTrend(issues, now, 5).every((p) => p.preHistory === false)).toBe(true);
    expect(buildIssueTrend(issues, now, 5).every((p) => p.newIssues !== null)).toBe(true);
  });

  it('still counts a real issue on a watched day when earlier days are suppressed', () => {
    // Anti-vacuity: suppression must not swallow live data on the measurable days.
    const points = buildIssueTrend(
      [{ firstSeen: '2026-07-24T05:00:00Z' }, { firstSeen: '2026-07-24T06:00:00Z' }],
      now,
      5,
      watchedSince
    );
    expect(points.find((p) => p.date === '2026-07-24')?.newIssues).toBe(2);
    expect(points.filter((p) => p.preHistory)).toHaveLength(2);
  });
});

describe('sumIssueEvents', () => {
  it("tolerates Sentry's string-or-number count field", () => {
    expect(sumIssueEvents([{ count: '12' }, { count: 3 }])).toBe(15);
  });

  it('treats missing/garbage counts as zero rather than NaN-poisoning the total', () => {
    expect(sumIssueEvents([{ count: 'abc' }, {}, { count: 5 }])).toBe(5);
    expect(sumIssueEvents([])).toBe(0);
  });
});

describe('sentry config validation', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('treats a blank or malformed token as unconfigured rather than sending it', () => {
    process.env.SENTRY_ISSUES_API_TOKEN = '   ';
    expect(sentryIssuesApiToken()).toBeUndefined();

    process.env.SENTRY_ISSUES_API_TOKEN = 'too-short';
    expect(sentryIssuesApiToken()).toBeUndefined();

    process.env.SENTRY_ISSUES_API_TOKEN = 'has whitespace in the middle of it';
    expect(sentryIssuesApiToken()).toBeUndefined();

    process.env.SENTRY_ISSUES_API_TOKEN = 'a'.repeat(40);
    expect(sentryIssuesApiToken()).toBe('a'.repeat(40));
  });

  it('reads SENTRY_OBSERVED_SINCE, and degrades a bad value to "no anchor"', () => {
    // Unset is the default and must mean "suppress nothing".
    expect(sentryObservedSinceMs()).toBeNull();

    process.env.SENTRY_OBSERVED_SINCE = '2026-07-23T10:00:00Z';
    expect(sentryObservedSinceMs()).toBe(Date.parse('2026-07-23T10:00:00Z'));

    process.env.SENTRY_OBSERVED_SINCE = '2026-07-23';
    expect(sentryObservedSinceMs()).toBe(Date.parse('2026-07-23'));

    // A typo must NOT become epoch 0 or NaN — either would silently change what the
    // panel suppresses. It falls back to no anchor, i.e. today's behaviour.
    for (const bad of ['not-a-date', '   ', '']) {
      process.env.SENTRY_OBSERVED_SINCE = bad;
      expect(sentryObservedSinceMs()).toBeNull();
    }
  });

  it('requires org, project AND a well-formed token to be considered configured', () => {
    expect(isSentryIssuesConfigured()).toBe(false);

    process.env.SENTRY_ORG = 'org';
    process.env.SENTRY_PROJECT = 'proj';
    expect(isSentryIssuesConfigured()).toBe(false); // still no token

    process.env.SENTRY_ISSUES_API_TOKEN = 'b'.repeat(40);
    expect(isSentryIssuesConfigured()).toBe(true);
  });

  it('reports "unconfigured" — with no numbers at all — when the env is not set up', async () => {
    const trend = await getSentryIssueTrend(Date.parse('2026-07-25T12:00:00Z'));
    expect(trend.state).toBe('unconfigured');
    if (trend.state !== 'ok') {
      expect(trend.reason).toContain('SENTRY_ISSUES_API_TOKEN');
    }
    // The union must make it impossible to read counts off a non-ok state — this
    // assertion documents that guarantee for future readers.
    expect('unresolvedIssues' in trend).toBe(false);
    expect('points' in trend).toBe(false);
  });
});
