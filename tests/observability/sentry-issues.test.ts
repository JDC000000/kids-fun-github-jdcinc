// tests/observability/sentry-issues.test.ts — the Sentry issue-trend read path (T41).
//
// No network is touched: the bucketing/summing helpers are pure and clock-injected,
// and the state machine is exercised by manipulating the environment. The single most
// important assertion in this file is that an unreadable Sentry NEVER degrades into
// zeros — an error dashboard that silently reads 0 when it cannot reach the error
// source is worse than one that says "unknown".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIssueTrend, getSentryIssueTrend, sumIssueEvents, SENTRY_TREND_DAYS } from '../../lib/observability/sentry-issues';
import { isSentryIssuesConfigured, sentryIssuesApiToken } from '../../lib/observability/config';

const ENV_KEYS = ['SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_ISSUES_API_TOKEN', 'SENTRY_API_BASE_URL'] as const;

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
    expect(points.reduce((sum, p) => sum + p.newIssues, 0)).toBe(0);
  });

  it('clamps a nonsense window rather than allocating unbounded buckets', () => {
    expect(buildIssueTrend([], now, 0)).toHaveLength(1);
    expect(buildIssueTrend([], now, -3)).toHaveLength(1);
    expect(buildIssueTrend([], now, 10_000)).toHaveLength(90);
    expect(buildIssueTrend([], now)).toHaveLength(SENTRY_TREND_DAYS);
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
