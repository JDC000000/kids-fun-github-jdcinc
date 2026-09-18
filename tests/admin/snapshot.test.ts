// tests/admin/snapshot.test.ts — the PURE half of the admin dashboard snapshot layer.
//
// No database: key derivation, age formatting, and the query-budget scope. The DB round-trip
// and the refresh job's isolation behaviour live in tests/admin/snapshot-store-db.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SNAPSHOT_KEYS,
  ALL_ADMIN_SNAPSHOT_KEYS,
  describeSnapshotAge,
  operatingSnapshotKey,
} from '../../lib/admin/snapshot';
import {
  ADMIN_ANALYTICS_QUERY_TIMEOUT_MS,
  ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS,
  adminAnalyticsQueryTimeoutMs,
  withQueryBudget,
} from '../../lib/db/budgets';
import { defaultPeriods } from '../../lib/analytics/operating';

describe('operatingSnapshotKey', () => {
  it('maps each page default to a key the refresh job actually builds', () => {
    // The point of the assertion: the page calls operatingSnapshotKey(grain, defaultPeriods(grain)),
    // so if a default ever moves without the key list moving with it, every load silently becomes
    // a cache miss. This pins the two together rather than pinning literals twice.
    for (const grain of ['day', 'month'] as const) {
      const key = operatingSnapshotKey(grain, defaultPeriods(grain));
      expect(key, `grain=${grain}`).not.toBeNull();
      expect(ALL_ADMIN_SNAPSHOT_KEYS).toContain(key!);
    }
  });

  it('is null for a period count nobody precomputed', () => {
    // ?periods=36 is reachable (MAX_PERIODS), and answering it from the 30-period row would
    // present 30 periods of data under a 36-period question. Null → the page says it has none.
    expect(operatingSnapshotKey('day', 36)).toBeNull();
    expect(operatingSnapshotKey('day', 7)).toBeNull();
    expect(operatingSnapshotKey('month', 6)).toBeNull();
  });

  it('does not answer one grain from the other grain row', () => {
    // 30 months is not 30 days. A near-miss here would be the worst kind of bug: plausible
    // numbers under the wrong label.
    expect(operatingSnapshotKey('month', 30)).toBeNull();
    expect(operatingSnapshotKey('day', 12)).toBeNull();
    expect(operatingSnapshotKey('day', 30)).toBe(ADMIN_SNAPSHOT_KEYS.operatingDay);
    expect(operatingSnapshotKey('month', 12)).toBe(ADMIN_SNAPSHOT_KEYS.operatingMonth);
  });
});

describe('ADMIN_SNAPSHOT_KEYS', () => {
  it('lists every key exactly once', () => {
    const values = Object.values(ADMIN_SNAPSHOT_KEYS);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(ALL_ADMIN_SNAPSHOT_KEYS).size).toBe(ALL_ADMIN_SNAPSHOT_KEYS.length);
  });

  it('ALL_ADMIN_SNAPSHOT_KEYS covers the whole registry', () => {
    // The refresh route validates caller-supplied keys against ALL_…; a key present in the
    // registry but missing from the list would be unbuildable and unrequestable.
    expect([...ALL_ADMIN_SNAPSHOT_KEYS].sort()).toEqual(Object.values(ADMIN_SNAPSHOT_KEYS).sort());
  });
});

describe('describeSnapshotAge', () => {
  it('describes a fresh snapshot as just now', () => {
    expect(describeSnapshotAge(0)).toBe('just now');
    expect(describeSnapshotAge(89)).toBe('just now');
  });

  it('switches to minutes, then hours, then days', () => {
    expect(describeSnapshotAge(90)).toBe('2 min ago');
    expect(describeSnapshotAge(60 * 60)).toBe('60 min ago');
    expect(describeSnapshotAge(2 * 60 * 60)).toBe('2h ago');
    expect(describeSnapshotAge(24 * 60 * 60)).toBe('24h ago');
    expect(describeSnapshotAge(5 * 86_400)).toBe('5d ago');
  });

  it('never renders a negative age', () => {
    // App clock and database clock are not the same clock. "-3 seconds ago" would read as a bug
    // in the numbers rather than as skew in the clocks.
    expect(describeSnapshotAge(-10)).toBe('just now');
  });
});

describe('query budget scope', () => {
  it('defaults to the page budget outside any scope', () => {
    expect(adminAnalyticsQueryTimeoutMs()).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  it('widens the budget inside withQueryBudget and restores it after', async () => {
    const inside = await withQueryBudget(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS, async () =>
      adminAnalyticsQueryTimeoutMs()
    );
    expect(inside).toBe(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS);
    expect(adminAnalyticsQueryTimeoutMs()).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  it('survives an await inside the scope', async () => {
    // The whole reason this is AsyncLocalStorage and not a module-level variable. The budget is
    // read ~20 frames deep, after several awaits.
    const seen = await withQueryBudget(123_456, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return adminAnalyticsQueryTimeoutMs();
    });
    expect(seen).toBe(123_456);
  });

  it('does not leak the widened budget into a CONCURRENT task', async () => {
    // ═══ THE REGRESSION THIS FILE EXISTS FOR ═══
    // A plain `let` would pass every test above and fail this one: a refresh running in the
    // same process would hand its 180s ceiling to a page request served concurrently, so an
    // abandoned page read could hold a connection for three minutes — reintroducing the exact
    // 2026-09-14 pool-exhaustion incident, but only under load and only sometimes.
    let observedOutside: number | undefined;
    await Promise.all([
      withQueryBudget(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS, async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        observedOutside = adminAnalyticsQueryTimeoutMs();
      })(),
    ]);
    expect(observedOutside).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  it('restores the budget even when the scoped work throws', async () => {
    await expect(
      withQueryBudget(999_999, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(adminAnalyticsQueryTimeoutMs()).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  it('keeps the refresh ceiling above the slowest measured read', () => {
    // getEngagementSeries measured 70,462 ms standalone on production 2026-09-18. A refresh
    // ceiling at or below that makes the job unable to build the payload it exists to build.
    expect(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS).toBeGreaterThan(70_462);
    // …and it must be MORE than the page budget, or moving work off the request path buys
    // nothing at all.
    expect(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS).toBeGreaterThan(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });
});
