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
}): Promise<void> {
  await query(
    `INSERT INTO analytics_event (event_type, user_or_session, result_summary_json, created_at)
       VALUES ($1, $2, $3::jsonb, now() - ($4 || ' hours')::interval)`,
    [
      opts.eventType,
      opts.session,
      opts.resultSummary == null ? null : JSON.stringify(opts.resultSummary),
      String(opts.hoursAgo),
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
});
