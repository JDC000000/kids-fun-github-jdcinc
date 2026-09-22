// tests/analytics/kpi.test.ts — READ-SIDE product-health KPI rollups (T32).
//
// Two layers:
//  1. Pure math helpers (perDay/pct/…) — always run, no DB. These are the
//     UI-facing derivations, so their edge cases (empty data → null, div-by-zero)
//     are pinned exactly.
//  2. The real SQL rollups against real Postgres — DB-gated (skipped without
//     DATABASE_URL, like the retention/dashboard suites). Rather than truncate the
//     shared table (which sibling analytics tests also use), this seeds rows keyed
//     to GLOBALLY-UNIQUE session ids and asserts the DELTA the seed produces. The
//     COUNT(FILTER) KPIs are additive so their delta is exact; the DISTINCT
//     DAU/WAU/MAU deltas are exact too because brand-new uuid session ids cannot
//     collide with any pre-existing row. Deterministic regardless of what else is
//     already in the table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, query } from '../../lib/db/client';
import {
  getProductHealthKpis,
  perDay,
  pct,
  signedInSharePct,
  sourceCtrPct,
  zeroResultPct,
  type ProductHealthKpis,
} from '../../lib/analytics/kpi';
import { ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD } from '../../lib/security/search-rate-limit';

// ── Layer 1: pure helpers (no DB) ────────────────────────────────────────────
describe('kpi pure helpers', () => {
  it('perDay averages over the window and rounds to 1dp', () => {
    expect(perDay(70, 7)).toBe(10);
    expect(perDay(10, 7)).toBe(1.4); // 1.428… → 1.4
    expect(perDay(0, 7)).toBe(0);
  });

  it('perDay is 0 (never Infinity/NaN) for a non-positive window', () => {
    expect(perDay(10, 0)).toBe(0);
    expect(perDay(10, -3)).toBe(0);
    expect(perDay(Number.NaN, 7)).toBe(0);
  });

  it('pct returns a whole-number percentage, or null when the denominator is 0', () => {
    expect(pct(1, 4)).toBe(25);
    expect(pct(1, 3)).toBe(33); // 33.33 → 33
    expect(pct(0, 10)).toBe(0);
    expect(pct(5, 0)).toBeNull(); // no data → em-dash, not a fake 0%
    expect(pct(5, -1)).toBeNull();
  });

  it('the named ratio helpers delegate to pct correctly', () => {
    expect(sourceCtrPct(30, 100)).toBe(30); // ≥25% target met
    expect(sourceCtrPct(10, 100)).toBe(10); // below target
    expect(sourceCtrPct(1, 0)).toBeNull();
    expect(zeroResultPct(2, 8)).toBe(25);
    expect(zeroResultPct(0, 0)).toBeNull();
    expect(signedInSharePct(3, 12)).toBe(25);
    expect(signedInSharePct(0, 0)).toBeNull();
  });
});

// ── Layer 2: real SQL rollups against real Postgres ──────────────────────────
const hasDb = Boolean(process.env.DATABASE_URL);

/** Insert one analytics_event row at a chosen age, keyed to a test session id. */
async function insertEvent(opts: {
  eventType: string;
  session: string;
  hoursAgo: number;
  resultSummary?: Record<string, unknown> | null;
  /** analytics_event.search_minute_request_count — the RAW count, not a boolean. Omit/null for
   *  an ordinary row ("not measured"). */
  searchMinuteRequestCount?: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO analytics_event (event_type, user_or_session, result_summary_json, created_at, search_minute_request_count)
       VALUES ($1, $2, $3::jsonb, now() - ($4 || ' hours')::interval, $5)`,
    [
      opts.eventType,
      opts.session,
      opts.resultSummary == null ? null : JSON.stringify(opts.resultSummary),
      String(opts.hoursAgo),
      opts.searchMinuteRequestCount ?? null,
    ]
  );
}

describe.skipIf(!hasDb)('getProductHealthKpis (real Postgres)', () => {
  const prefix = `kpi-test-${randomUUID().slice(0, 8)}`;
  const A = `${prefix}-a`; // busy anonymous session (searches + views + click)
  const B = `${prefix}-b`; // a second distinct viewer
  const C = `${prefix}-c`; // a signed-in account (sign-in + saved-search + opt-in)
  const D = `${prefix}-d`; // active 10 days ago only (MAU but not WAU/DAU)

  let base: ProductHealthKpis;
  let after: ProductHealthKpis;

  beforeAll(async () => {
    base = await getProductHealthKpis();

    // Session A — 3 searches (one zero-result, one broadened), 2 views, 1 outbound click.
    await insertEvent({ eventType: 'search_performed', session: A, hoursAgo: 2, resultSummary: { total: 5 } });
    await insertEvent({ eventType: 'search_performed', session: A, hoursAgo: 2, resultSummary: { total: 0 } });
    await insertEvent({ eventType: 'search_performed', session: A, hoursAgo: 2, resultSummary: { total: 12, broadened: true } });
    await insertEvent({ eventType: 'listing_viewed', session: A, hoursAgo: 2, resultSummary: { id: 'x' } });
    await insertEvent({ eventType: 'listing_viewed', session: A, hoursAgo: 2, resultSummary: { id: 'y' } });
    await insertEvent({ eventType: 'outbound_source_click', session: A, hoursAgo: 2, resultSummary: null });

    // Session B — one more distinct viewer.
    await insertEvent({ eventType: 'listing_viewed', session: B, hoursAgo: 2, resultSummary: { id: 'z' } });

    // Session C — a signed-in account with account-value signals.
    await insertEvent({ eventType: 'account_signed_in', session: C, hoursAgo: 2, resultSummary: { method: 'google' } });
    await insertEvent({ eventType: 'saved_search_created', session: C, hoursAgo: 2, resultSummary: null });
    await insertEvent({ eventType: 'weekly_email_opt_in', session: C, hoursAgo: 2, resultSummary: { optedIn: true } });
    await insertEvent({ eventType: 'weekly_email_opt_in', session: C, hoursAgo: 2, resultSummary: { optedIn: false } }); // opted OUT — not counted

    // Session D — active only 10 days ago: inside MAU (30d), outside WAU/DAU (7d/1d)
    // and outside the 7-day engagement window.
    await insertEvent({ eventType: 'search_performed', session: D, hoursAgo: 24 * 10, resultSummary: { total: 3 } });

    after = await getProductHealthKpis();
  });

  afterAll(async () => {
    try {
      await query(`DELETE FROM analytics_event WHERE user_or_session LIKE 'kpi-test-%'`);
    } finally {
      await closePool();
    }
  });

  it('engagement counts move by exactly the seeded in-window rows', () => {
    // Session D's search is 10 days old → excluded from the 7-day engagement window.
    expect(after.engagement.searches - base.engagement.searches).toBe(3);
    expect(after.engagement.searchesWithResults - base.engagement.searchesWithResults).toBe(3);
    expect(after.engagement.zeroResultSearches - base.engagement.zeroResultSearches).toBe(1);
    expect(after.engagement.broadenedSearches - base.engagement.broadenedSearches).toBe(1);
    expect(after.engagement.listingViews - base.engagement.listingViews).toBe(3); // A:2 + B:1
    expect(after.engagement.outboundClicks - base.engagement.outboundClicks).toBe(1);
  });

  it('derived engagement rates compute correctly on the seeded slice', () => {
    // The seed alone: CTR = 1 click / 3 views = 33%, zero-result = 1 / 3 = 33%.
    // Asserted on the seeded numbers directly (the helper is pure) so a populated
    // staging DB doesn't change the expected value.
    expect(sourceCtrPct(1, 3)).toBe(33);
    expect(zeroResultPct(1, 3)).toBe(33);
    // The live tiles never divide by zero even before any clicks/searches exist.
    expect(sourceCtrPct(after.engagement.outboundClicks, after.engagement.listingViews)).not.toBeNaN();
  });

  it('active-user windows include/exclude by recency (D counts for MAU only)', () => {
    // A, B, C are all active ~2h ago → each adds 1 to DAU, WAU and MAU.
    expect(after.activeUsers.dau - base.activeUsers.dau).toBe(3);
    expect(after.activeUsers.wau - base.activeUsers.wau).toBe(3);
    // A, B, C, and D (10 days ago) are all inside the 30-day MAU window.
    expect(after.activeUsers.mau - base.activeUsers.mau).toBe(4);
    // Sanity: DAU ≤ WAU ≤ MAU always holds.
    expect(after.activeUsers.dau).toBeLessThanOrEqual(after.activeUsers.wau);
    expect(after.activeUsers.wau).toBeLessThanOrEqual(after.activeUsers.mau);
  });

  it('account-value counts move by the seeded rows (opted-out opt-in excluded)', () => {
    expect(after.accountValue.savedSearches - base.accountValue.savedSearches).toBe(1);
    expect(after.accountValue.emailOptIns - base.accountValue.emailOptIns).toBe(1); // only the opted-IN row
    expect(after.accountValue.signInEvents - base.accountValue.signInEvents).toBe(1);
    expect(after.accountValue.signedInUsers - base.accountValue.signedInUsers).toBe(1); // session C
  });

  it('exposes the configured rolling windows', () => {
    expect(after.windows).toEqual({
      engagementDays: 7,
      dauDays: 1,
      wauDays: 7,
      mauDays: 30,
      accountDays: 30,
    });
  });

  // 2026-09-22 incident (supabase/migrations/0052_analytics_event_high_frequency_flag.sql):
  // a session with even ONE row at/above ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD must be excluded
  // from DAU/WAU/MAU ENTIRELY, including its OTHER, ordinary rows — the row is evidence about the
  // ACTOR, not just about itself. Session E below fires two ordinary-looking rows plus one at the
  // threshold; none of the three should move the active-user counts.
  it('excludes a session from DAU/WAU/MAU entirely once ANY of its rows reaches the exclusion threshold', async () => {
    const E = `${prefix}-e`;
    const beforeFlag = await getProductHealthKpis();

    await insertEvent({ eventType: 'search_performed', session: E, hoursAgo: 1, resultSummary: { total: 4 } });
    await insertEvent({
      eventType: 'search_performed',
      session: E,
      hoursAgo: 1,
      resultSummary: { total: 4 },
      searchMinuteRequestCount: ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
    });
    await insertEvent({ eventType: 'listing_viewed', session: E, hoursAgo: 1, resultSummary: { id: 'w' } });

    const afterFlag = await getProductHealthKpis();

    expect(afterFlag.activeUsers.dau - beforeFlag.activeUsers.dau).toBe(0);
    expect(afterFlag.activeUsers.wau - beforeFlag.activeUsers.wau).toBe(0);
    expect(afterFlag.activeUsers.mau - beforeFlag.activeUsers.mau).toBe(0);

    // Sanity check the OPPOSITE case in the same test — a session with the identical shape but
    // NO qualifying row must count normally, so the exclusion is proven to key off the count
    // crossing the threshold and not off some accidental property of the seed (e.g. "3 events in
    // an hour").
    const F = `${prefix}-f`;
    await insertEvent({ eventType: 'search_performed', session: F, hoursAgo: 1, resultSummary: { total: 4 } });
    await insertEvent({ eventType: 'search_performed', session: F, hoursAgo: 1, resultSummary: { total: 4 } });
    await insertEvent({ eventType: 'listing_viewed', session: F, hoursAgo: 1, resultSummary: { id: 'w' } });
    const afterUnflagged = await getProductHealthKpis();
    expect(afterUnflagged.activeUsers.dau - afterFlag.activeUsers.dau).toBe(1);
  });

  // The BOUNDARY, exactly: one request below the threshold is an ordinary, fast-but-real
  // session (the whole point of the 2026-09-22 revision — a parent clicking several filter
  // chips inside a minute must never be silently erased); AT the threshold, it's excluded.
  it('does not exclude a session whose peak count is exactly ONE below the threshold', async () => {
    const G = `${prefix}-g`;
    const before = await getProductHealthKpis();
    await insertEvent({
      eventType: 'search_performed',
      session: G,
      hoursAgo: 1,
      resultSummary: { total: 4 },
      searchMinuteRequestCount: ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD - 1,
    });
    const after = await getProductHealthKpis();
    expect(after.activeUsers.dau - before.activeUsers.dau).toBe(1);
  });

  // F9 (2026-09-22, third+fourth independent recheck): signedInSharePct(signedInUsers, mau)
  // pairs getAccountValue's signed_in_users against getActiveUsers's mau. Before this fix
  // signed_in_users had NO exclusion while mau did — a signed-in actor who also tripped the
  // exclusion shrank the denominator but not the numerator, inflating the ratio (and, with a
  // small enough real MAU, able to push it mathematically past 100%). Reproduced directly:
  // session H signs in AND fires a qualifying high-frequency row; it must be excluded from
  // BOTH signed_in_users and mau, so the pair stays consistent.
  it('excludes a flagged actor from signed_in_users exactly like it excludes them from mau, keeping signedInSharePct <= 100', async () => {
    const H = `${prefix}-h`;
    const before = await getProductHealthKpis();

    await insertEvent({ eventType: 'account_signed_in', session: H, hoursAgo: 1, resultSummary: { method: 'google' } });
    await insertEvent({
      eventType: 'search_performed',
      session: H,
      hoursAgo: 1,
      resultSummary: { total: 4 },
      searchMinuteRequestCount: ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
    });

    const after = await getProductHealthKpis();

    // Excluded from BOTH sides of the ratio, not just one.
    expect(after.accountValue.signedInUsers - before.accountValue.signedInUsers).toBe(0);
    expect(after.activeUsers.mau - before.activeUsers.mau).toBe(0);

    // Sanity control: an identically-shaped signed-in actor with NO flagged row counts on
    // both sides normally, proving the exclusion keys off the threshold and nothing else.
    const I = `${prefix}-i`;
    await insertEvent({ eventType: 'account_signed_in', session: I, hoursAgo: 1, resultSummary: { method: 'google' } });
    const after2 = await getProductHealthKpis();
    expect(after2.accountValue.signedInUsers - after.accountValue.signedInUsers).toBe(1);
    expect(after2.activeUsers.mau - after.activeUsers.mau).toBe(1);

    expect(signedInSharePct(after2.accountValue.signedInUsers, after2.activeUsers.mau)).toBeLessThanOrEqual(100);
  });
});
