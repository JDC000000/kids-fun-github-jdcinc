// tests/health/stale.test.ts — G-T15-4 occurrence-level stale detection.
//  • PURE: isOccurrenceStale (grace × cadence, strict boundary) and
//    isStaleFlipEligibleSource (operator-fed sources are exempt).
//  • DB: flipStaleOccurrences demotes past-cadence live occurrences to 'stale' and leaves
//    fresh / human-terminal / never-checked / OPERATOR-FED ones alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isOccurrenceStale,
  isStaleFlipEligibleSource,
  flipStaleOccurrences,
  countStaleOccurrences,
  STALE_CADENCE_GRACE,
  STALE_FLIP_EXCLUDED_INGESTION_METHODS,
} from '../../worker/health/stale';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const agoMs = (s: number): number => NOW - s * 1000;

describe('isOccurrenceStale (pure)', () => {
  it('stale when last check older than grace × cadence', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(3 * DAY), cadenceSeconds: DAY }, NOW)).toBe(true);
  });
  it('fresh within grace', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('strict boundary exactly at grace × cadence is NOT yet stale', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(STALE_CADENCE_GRACE * DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('a never-checked occurrence is not stale', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('scales with a weekly cadence', () => {
    const week = 7 * DAY;
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(10 * DAY), cadenceSeconds: week }, NOW)).toBe(false); // <14d
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(20 * DAY), cadenceSeconds: week }, NOW)).toBe(true); // >14d
  });
  it('STALE_CADENCE_GRACE matches the source-level dashboard grace (2)', () => {
    expect(STALE_CADENCE_GRACE).toBe(2);
  });
});

describe('isStaleFlipEligibleSource (pure)', () => {
  it("an operator-fed source ('manual') is NOT eligible — it has no re-ingest path back", () => {
    expect(isStaleFlipEligibleSource('manual')).toBe(false);
  });

  it('every ingestion_method that IS auto-crawled stays eligible', () => {
    // 'semi' and 'partner' are deliberately NOT exempt: worker/scheduler/cadence.ts's
    // MANUAL_INGESTION_METHODS contains only 'manual', so these three are all scheduled and
    // their occurrences really do get re-checked. Widening the exemption to 'semi' would
    // silently stop caveating listings that a producer IS responsible for refreshing.
    for (const method of ['auto', 'semi', 'partner']) {
      expect(isStaleFlipEligibleSource(method)).toBe(true);
    }
  });

  it('the exclusion set is exactly ["manual"] — the set the tiered scheduler refuses to enqueue', () => {
    // Pinned as a literal, not derived. worker/scheduler/tiered.ts's candidate predicate says
    // `AND s.ingestion_method <> 'manual'`; this flip must exempt exactly the sources that
    // predicate refuses to schedule, because "never re-crawled" is what makes the caveat
    // permanent. If someone widens this set, they are changing which listings get caveated,
    // and that is a product decision — this assertion makes them come here and say so.
    expect([...STALE_FLIP_EXCLUDED_INGESTION_METHODS]).toEqual(['manual']);
  });
});

describe.skipIf(!hasDb)('flipStaleOccurrences (DB)', () => {
  const TAG = `t15stale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sourceId = '';
  let seriesId = '';
  // The operator-fed twin of the source above. Same family, same 1-day cadence, same
  // terms approval — the ONLY difference is ingestion_method, so any behavioural
  // difference between the two is attributable to that column and nothing else.
  let manualSourceId = '';
  let manualSeriesId = '';
  const occ = {
    fresh: '',
    stale: '',
    cancelled: '',
    seasonalActive: '',
    noCheck: '',
    manualPastThreshold: '',
    manualLongPastThreshold: '',
  };

  async function mkOcc(
    name: string,
    status: string,
    lastCheckedDaysAgo: number | null,
    targetSeriesId?: string
  ): Promise<string> {
    const lc = lastCheckedDaysAgo == null ? 'NULL' : `now() - interval '${lastCheckedDaysAgo} days'`;
    const [r] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, last_checked_at)
       VALUES ($1, $2, now() + interval '5 days', $3::status_state, ${lc}) RETURNING id`,
      [targetSeriesId ?? seriesId, name, status]
    );
    return r.id;
  }

  beforeAll(async () => {
    const [s] = await query<{ id: string }>(
      // terms_status='allowed': mkOcc seeds 'confirmed' occurrences (later flipped to stale),
      // which the 0021 write-time invariant permits only for a terms-approved source.
      //
      // ingestion_method='auto' IS LOAD-BEARING AND MUST STAY EXPLICIT. source.ingestion_method
      // is NOT NULL DEFAULT 'manual' (0003_core_places.sql:34), so omitting it — as this
      // fixture used to — silently made this an OPERATOR-FED source, which the flip now
      // exempts. Every assertion below about a row being demoted would then have passed
      // vacuously in the wrong direction (i.e. gone red), and a future author "tidying" this
      // column away would turn the whole DB half of this file into a test of the exemption.
      `INSERT INTO source (family, name, baseline_cadence, terms_status, ingestion_method)
       VALUES ('noop', $1, '1 day', 'allowed', 'auto') RETURNING id`,
      [`${TAG} src`]
    );
    sourceId = s.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`${TAG} series`, sourceId]
    );
    seriesId = ser.id;

    const [manualSrc] = await query<{ id: string }>(
      `INSERT INTO source (family, name, baseline_cadence, terms_status, ingestion_method)
       VALUES ('noop', $1, '1 day', 'allowed', 'manual') RETURNING id`,
      [`${TAG} manual src`]
    );
    manualSourceId = manualSrc.id;
    const [manualSer] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`${TAG} manual series`, manualSourceId]
    );
    manualSeriesId = manualSer.id;

    // cadence = 1 day, grace = 2 → threshold 2 days.
    occ.fresh = await mkOcc(`${TAG} fresh`, 'confirmed', 0); // checked ~now → fresh
    occ.stale = await mkOcc(`${TAG} stale`, 'confirmed', 3); // 3d > 2d → stale
    occ.cancelled = await mkOcc(`${TAG} cancelled`, 'cancelled', 5); // not demotable
    occ.seasonalActive = await mkOcc(`${TAG} seasonal`, 'seasonal_active', 5); // demotable → stale
    occ.noCheck = await mkOcc(`${TAG} nocheck`, 'confirmed', null); // never checked → not stale
    // Past the threshold on EVERY axis except ingestion_method — same status, same cadence,
    // an age the ingested twin above is demoted for.
    occ.manualPastThreshold = await mkOcc(`${TAG} manual 3d`, 'confirmed', 3, manualSeriesId);
    // 400 days: no plausible cadence makes this "recently checked", so the exemption is the
    // only thing that can be keeping it. Guards against a threshold-arithmetic false pass.
    occ.manualLongPastThreshold = await mkOcc(`${TAG} manual 400d`, 'confirmed', 400, manualSeriesId);
  });

  afterAll(async () => {
    for (const id of Object.values(occ)) if (id) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [id]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (manualSeriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [manualSeriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    if (manualSourceId) await query(`DELETE FROM source WHERE id = $1`, [manualSourceId]);
    await closePool();
  });

  async function statusOf(id: string): Promise<string> {
    const [r] = await query<{ status_state: string }>(`SELECT status_state FROM activity_occurrence WHERE id = $1`, [id]);
    return r.status_state;
  }

  it('flips only the past-cadence, live-status occurrences to stale', async () => {
    const result = await flipStaleOccurrences(getPool());
    expect(result.flipped).toContain(occ.stale);
    expect(result.flipped).toContain(occ.seasonalActive);
    expect(result.flipped).not.toContain(occ.fresh);
    expect(result.flipped).not.toContain(occ.cancelled);
    expect(result.flipped).not.toContain(occ.noCheck);

    expect(await statusOf(occ.stale)).toBe('stale');
    expect(await statusOf(occ.seasonalActive)).toBe('stale');
    expect(await statusOf(occ.fresh)).toBe('confirmed');
    expect(await statusOf(occ.cancelled)).toBe('cancelled'); // human-terminal untouched
    expect(await statusOf(occ.noCheck)).toBe('confirmed');
  });

  // ── THE EXEMPTION, BOTH DIRECTIONS ────────────────────────────────────────────────────
  // One direction alone is half a guard: "manual is not flipped" passes just as well if the
  // flip is broken and demotes nothing at all. The paired assertion on `occ.stale` — same
  // status, same cadence, a SHORTER overdue age, differing only in ingestion_method — is
  // what makes this evidence about the exclusion rather than about the statement running.
  it('does NOT flip a past-threshold occurrence under an OPERATOR-FED source, while flipping its ingested twin', async () => {
    // Fresh run so `flipped` describes this call. The ingested rows above are already
    // 'stale' and no longer candidates ('stale' ∉ STALE_DEMOTE_FROM), so re-seed one.
    const ingestedTwin = await mkOcc(`${TAG} twin 3d`, 'confirmed', 3);
    try {
      const result = await flipStaleOccurrences(getPool());

      // POSITIVE: the auto-crawled source's row IS demoted at 3 days overdue.
      expect(result.flipped).toContain(ingestedTwin);
      expect(await statusOf(ingestedTwin)).toBe('stale');

      // NEGATIVE: the operator-fed source's rows are untouched at 3 days AND at 400.
      expect(result.flipped).not.toContain(occ.manualPastThreshold);
      expect(result.flipped).not.toContain(occ.manualLongPastThreshold);
      expect(await statusOf(occ.manualPastThreshold)).toBe('confirmed');
      expect(await statusOf(occ.manualLongPastThreshold)).toBe('confirmed');
    } finally {
      await query(`DELETE FROM activity_occurrence WHERE id = $1`, [ingestedTwin]);
    }
  });

  // NOT WRITTEN, DELIBERATELY: a `{ grace: 0 }` run to prove the exemption is not a
  // threshold artefact. flipStaleOccurrences is an UNSCOPED table-wide UPDATE, so grace 0
  // makes every checked row in the whole database a candidate — it would demote other
  // suites' leaked fixtures (whose last_checked_at ≈ now() is the only thing sparing them
  // today) and turn this file into a source of order-dependent failures across the serial
  // db lane. The 400-day row above buys the same evidence against a 2-day threshold
  // without mutating a single row outside this fixture.

  it('countStaleOccurrences includes the freshly-flipped rows and is idempotent', async () => {
    const before = await countStaleOccurrences(getPool());
    expect(before.staleCount).toBeGreaterThanOrEqual(2);
    // Re-running the flip is a no-op (already stale, and 'stale' is not in the demote-from set).
    const again = await flipStaleOccurrences(getPool());
    expect(again.flipped).not.toContain(occ.stale);
  });
});
