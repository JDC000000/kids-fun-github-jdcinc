import { describe, it, expect, afterAll } from 'vitest';
import { NoopAdapter, type Adapter, type StructuredRecord } from '../../worker/core/adapter';
import { VENUE_GEO_AUTHORITY } from '../../worker/core/venue-geo-authority';
import { ingestSource } from '../../worker/core/ingest';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// G-T5-4 — ingest runner wires series resolution into the DB-backed upsert:
// resolveSeries (create/reuse activity_series) → upsertOccurrence(series_id, …) →
// provenance → check-run. This is the "series_id wiring before any DB-backed
// occurrence upsert" the review flagged as the remaining blocker.
describe.skipIf(!hasDb)('Ingest runner series_id wiring (G-T5-4)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('routes a low-confidence generic record to needs_review (BR-13 gate), not unconditional confirmed', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Ingest Runner Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(pool, new NoopAdapter(), source.id);

    expect(summary.errors).toEqual([]);
    expect(summary.recordsFound).toBeGreaterThan(0);
    expect(summary.seriesCreated).toBe(1);
    expect(summary.occurrencesCreated).toBe(1);
    expect(summary.provenanceRows).toBeGreaterThanOrEqual(1);
    // The gate fired: the generic Noop record (generic category, unknown cost, no
    // age, unproven source) scores ~0.34 → 'low', so it is held for review.
    expect(summary.lowConfidenceFlagged).toBe(1);

    // check-run recorded as success.
    const [run] = await query<{ status: string; records_found: number }>(
      `SELECT status, records_found FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    expect(run.status).toBe('success');

    // occurrence exists and is attached to a (NOT NULL) series for this source.
    const occ = await query<{ series_id: string; status_state: string; confidence_label: string; category_key: string }>(
      `SELECT o.series_id, o.status_state, o.confidence_label, c.key AS category_key
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       LEFT JOIN category c ON c.id = o.primary_category_id
       WHERE s.source_id = $1`,
      [source.id]
    );
    expect(occ.length).toBe(1);
    expect(occ[0].series_id).not.toBeNull();
    // Was unconditionally 'confirmed'/'medium'; the real BR-13 formula + gate now
    // hold this low-confidence row for review instead of surfacing it as confirmed.
    expect(occ[0].status_state).toBe('needs_review');
    expect(occ[0].confidence_label).toBe('low');
    expect(occ[0].category_key).toBe('class_program');
  });

  it('lets a fully-structured record on a proven official source through as confirmed/high', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': this proven official source produces a high-confidence
      // 'confirmed' occurrence, which the 0021 write-time invariant permits only for a
      // terms-approved source (in production only approved sources reach ingest).
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Confident Ingest Source ${crypto.randomUUID()}`]
    );

    // Seed two prior successful checks (well within the 1-day cadence so the
    // source reads as adherent) so it has a proven track record — this drives the
    // volatility factor up via T15's source-health score.
    await query(
      `INSERT INTO source_check_run (source_id, started_at, status, records_found, duration_ms)
       VALUES ($1, now() - interval '6 hours', 'success', 5, 100),
              ($1, now() - interval '2 hours', 'success', 6, 100)`,
      [source.id]
    );

    const record: StructuredRecord = {
      sourceRecordId: `confident-${crypto.randomUUID()}`,
      title: 'Family Public Swim',
      categoryHint: 'public_swim', // explicit structured category
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      costStatus: 'free',
      ageText: '6 months to 5 years', // resolves to a structured band
      sourceUrl: 'https://yourlibrary.bibliocommons.com/v2/events/confident',
    };
    const adapter: Adapter = {
      family: 'library',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: () => ({ key: 'confident' }),
    };

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);
    expect(summary.lowConfidenceFlagged).toBe(0);

    const [occ] = await query<{ status_state: string; confidence_label: string; category_key: string }>(
      `SELECT o.status_state, o.confidence_label, c.key AS category_key
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       LEFT JOIN category c ON c.id = o.primary_category_id
       WHERE s.source_id = $1`,
      [source.id]
    );
    expect(occ.category_key).toBe('public_swim');
    expect(occ.confidence_label).toBe('high');
    expect(occ.status_state).toBe('confirmed');
  });

  // P1-3 — the normaliser end to end: a real adapter record carrying real source packaging
  // through the real runner into real columns. tests/core/title-normalize.test.ts proves the
  // string rules; this proves the WIRING, which is the half a pure test cannot reach — that
  // ingest applies it at all, that upsert persists both halves, and that the series was keyed
  // on the CLEAN title rather than the junk.
  it('strips source packaging from the title at ingest and keeps the raw wording in source_title', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('perfectmind', $1) RETURNING id`,
      [`Title Normalise Source ${crypto.randomUUID()}`]
    );

    const raw = '$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm';
    const record: StructuredRecord = {
      sourceRecordId: `titlenorm-${crypto.randomUUID()}`,
      title: raw,
      startDatetimeUtc: '2026-09-24T22:30:00.000Z',
      costMinCad: 3,
      costStatus: 'known',
      sourceUrl: 'https://example.org/perfectmind/open-gym',
    };
    const adapter: Adapter = {
      family: 'perfectmind',
      fetch: async () => [record],
      extract: (r) => r as StructuredRecord[],
      dedupKeys: () => ({ key: 'titlenorm' }),
    };

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);

    const [occ] = await query<{ activity_name: string; source_title: string; series_title: string }>(
      `SELECT o.activity_name, o.source_title, s.canonical_title AS series_title
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1`,
      [source.id]
    );

    // The price and the weekday/time are gone — both are already columns on this very row.
    expect(occ.activity_name).toBe('Open Gym 8yrs+ Delbrook');
    // …and "8yrs+" survived, because the conservatism rule is the load-bearing half.
    expect(occ.activity_name).toContain('8yrs+');
    // The source's own wording is not destroyed, only relocated.
    expect(occ.source_title).toBe(raw);
    // Series identity is keyed on the clean title, so two vendor spellings of one program
    // collapse into one series instead of forking on punctuation.
    expect(occ.series_title).toBe('Open Gym 8yrs+ Delbrook');
  });

  // G-T10-3 (IR-08) — the SAME well-parsed, terms-approved record, differing ONLY in the
  // owning source's authority_tier, must land as `manual_candidate` instead of
  // `confirmed`. This is the acceptance criterion's end-to-end proof: a real editorial
  // source through the real ingest runner writing a real row.
  //
  // Deliberately mirrors the 'confirmed/high' case above field-for-field so the ONE
  // variable is the tier — otherwise a passing assertion here could be explained by a
  // confidence difference rather than by the editorial gate.
  it('an EDITORIAL source lands as manual_candidate and is absent from confirmed results', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed' so the Round 27 cap is NOT what produces the result —
      // an editorial source that is fully terms-approved still must not be confirmed.
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('editorial_roundup', $1, 'editorial', 'allowed') RETURNING id`,
      [`Editorial Candidate Source ${crypto.randomUUID()}`]
    );
    await query(
      `INSERT INTO source_check_run (source_id, started_at, status, records_found, duration_ms)
       VALUES ($1, now() - interval '6 hours', 'success', 5, 100),
              ($1, now() - interval '2 hours', 'success', 6, 100)`,
      [source.id]
    );

    const record: StructuredRecord = {
      sourceRecordId: `editorial-${crypto.randomUUID()}`,
      title: 'Family Public Swim',
      categoryHint: 'public_swim',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      costStatus: 'free',
      ageText: '6 months to 5 years',
      sourceUrl: 'https://example-roundup.test/best-kids-swims',
    };
    const adapter: Adapter = {
      family: 'editorial_roundup',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: () => ({ key: 'editorial' }),
    };

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);
    // The BR-13 gate did NOT hold this record — its confidence is fine. The editorial
    // gate is what moved it, and the two counters say so separately.
    expect(summary.lowConfidenceFlagged).toBe(0);
    expect(summary.editorialCandidates).toBe(1);

    const [occ] = await query<{ status_state: string; confidence_label: string }>(
      `SELECT o.status_state, o.confidence_label
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1`,
      [source.id]
    );
    expect(occ.status_state).toBe('manual_candidate');
    // Confidence is UNCHANGED — 'editorial' authority scores lower than 'official' but
    // still lands medium+, which is exactly why the status gate (not the score) is what
    // has to carry this guarantee.
    expect(['medium', 'high']).toContain(occ.confidence_label);

    // "absent from confirmed results", asserted against the database rather than inferred.
    const confirmed = await query(
      `SELECT o.id FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1 AND o.status_state = 'confirmed'`,
      [source.id]
    );
    expect(confirmed).toEqual([]);

    // It IS in the admin QA queue's review set, which is the official-source verification
    // step the acceptance criterion requires before it can ever become confirmed.
    const queued = await query(
      `SELECT o.id FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1 AND o.status_state = ANY(ARRAY['needs_review','manual_candidate']::status_state[])`,
      [source.id]
    );
    expect(queued.length).toBe(1);
  });

  // G-T7R-6 — Adapter.assessRun(): an adapter over a brittle, unofficial source gets to
  // fail its OWN run. Without this, a vendor shape change or a yield collapse completes
  // without throwing and the check run reports a cheerful green over empty data.
  //
  // What this case now pins is the SPLIT introduced after the 2026-09-14 production
  // investigation: the verdict reaches the BOARD (persisted errors jsonb, health_alert
  // column, degraded status) on the very first run, but it does NOT reach
  // `summary.errors` — the array `runTermsGatedIngest` turns into a thrown job failure.
  // 182 Sentry errors and up to five redundant crawls per incident came from that one
  // array being asked to mean both things.
  it('a FIRST alerting self-assessment reaches the board but not the job', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Assess Run Source ${crypto.randomUUID()}`]
    );

    const seenBaselines: Array<number | null> = [];
    class CollapsingAdapter extends NoopAdapter {
      assessRun(baseline: number | null) {
        seenBaselines.push(baseline);
        return { code: 'yield_collapse', alert: true, detail: `1 occurrence vs baseline ${baseline}` };
      }
    }

    const summary = await ingestSource(pool, new CollapsingAdapter(), source.id);

    expect(seenBaselines, 'first run has no history to compare against').toEqual([null]);
    // THE JOB SUCCEEDS. A one-run dip is self-correcting and must not retry the crawl.
    expect(summary.errors, 'a first verdict is not an execution error').toEqual([]);
    expect(summary.healthAlert).toMatchObject({ code: 'yield_collapse' });
    // …and the board still sees everything it always did.
    expect(summary.occurrencesUpserted).toBeGreaterThan(0);
    const [run] = await query<{ status: string; errors: unknown; health_alert_code: string | null }>(
      `SELECT status, errors, health_alert_code FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    expect(run.status, 'records landed, so degraded to partial — not green').toBe('partial');
    expect(JSON.stringify(run.errors)).toMatch(/run health \[yield_collapse\]/);
    expect(run.health_alert_code).toBe('yield_collapse');
    // The verdict sits where the old `errors.push` put it — FIRST, ahead of any per-record
    // line — so the board renders the array in the order it always has.
    expect((run.errors as string[])[0]).toMatch(/^run health \[yield_collapse\]/);

    // Second run: the first run's records_found is now the trailing baseline.
    await ingestSource(pool, new CollapsingAdapter(), source.id);
    expect(seenBaselines[1]).toBe(1);
  });

  // The other half of the same rule: silence for one blip, but NOT silence for a source
  // that stays collapsed. The second consecutive verdict is what fails the job, retries
  // the crawl and reaches Sentry — the behaviour the alarm was built for, now aimed only
  // at the condition that warrants it.
  it('a SUSTAINED verdict — two consecutive runs — does fail the job', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Assess Run Sustained ${crypto.randomUUID()}`]
    );
    class AlwaysCollapsingAdapter extends NoopAdapter {
      assessRun() {
        return { code: 'yield_collapse', alert: true, detail: 'still empty' };
      }
    }

    const first = await ingestSource(pool, new AlwaysCollapsingAdapter(), source.id);
    expect(first.errors, 'run 1 is a blip').toEqual([]);

    const second = await ingestSource(pool, new AlwaysCollapsingAdapter(), source.id);
    expect(second.errors.join(' '), 'run 2 is a regression').toMatch(
      /run health \[yield_collapse\] SUSTAINED/
    );

    const [run] = await query<{ status: string; errors: unknown }>(
      `SELECT status, errors FROM source_check_run WHERE id = $1`,
      [second.checkRunId]
    );
    expect(run.status).toBe('partial');
    // The louder line replaces the plain one rather than printing the collapse twice.
    expect(
      JSON.stringify(run.errors).match(/yield_collapse/g)?.length,
      'the board states the collapse once'
    ).toBe(1);
  });

  // A DIFFERENT verdict on the next run is not a sustained collapse — the source moved
  // from one symptom to another, and the second symptom deserves its own first-run grace
  // rather than inheriting the first's strike.
  it('a different verdict code does not count as sustained', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Assess Run Switching ${crypto.randomUUID()}`]
    );
    let call = 0;
    class SwitchingAdapter extends NoopAdapter {
      assessRun() {
        call += 1;
        return call === 1
          ? { code: 'yield_collapse', alert: true, detail: 'thin' }
          : { code: 'shape_drift', alert: true, detail: 'new key' };
      }
    }
    await ingestSource(pool, new SwitchingAdapter(), source.id);
    const second = await ingestSource(pool, new SwitchingAdapter(), source.id);
    expect(second.errors).toEqual([]);
    expect(second.healthAlert).toMatchObject({ code: 'shape_drift' });
  });

  it('a non-alerting self-assessment leaves the run green', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Assess Run OK Source ${crypto.randomUUID()}`]
    );
    class HealthyAdapter extends NoopAdapter {
      assessRun() {
        return { code: 'ok', alert: false, detail: 'all good' };
      }
    }
    const summary = await ingestSource(pool, new HealthyAdapter(), source.id);
    expect(summary.errors).toEqual([]);
    const [run] = await query<{ status: string }>(
      `SELECT status FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    expect(run.status).toBe('success');
  });

  it('is idempotent: a second run reuses the series and updates the occurrence in place', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Ingest Idempotent Source ${crypto.randomUUID()}`]
    );
    const adapter = new NoopAdapter();

    const first = await ingestSource(pool, adapter, source.id);
    const second = await ingestSource(pool, adapter, source.id);

    expect(first.occurrencesCreated).toBe(1);
    expect(second.occurrencesCreated).toBe(0); // updated in place, not duplicated
    expect(second.seriesCreated).toBe(0); // series reused

    const [seriesCount] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_series WHERE source_id = $1`,
      [source.id]
    );
    expect(Number(seriesCount.n)).toBe(1);
    const [occCount] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id WHERE s.source_id = $1`,
      [source.id]
    );
    expect(Number(occCount.n)).toBe(1);
  });

  it('attaches geocoded venue metadata to the resolved series', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': this structured record ingests to a 'confirmed' occurrence,
      // which the 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, terms_status) VALUES ('library_bibliocommons', $1, 'allowed') RETURNING id`,
      [`Venue Ingest Source ${crypto.randomUUID()}`]
    );
    const record: StructuredRecord = {
      sourceRecordId: `venue-record-${crypto.randomUUID()}`,
      title: 'Family Storytime',
      venueName: 'Steveston Library (Easthope Hub)',
      venueAddress: '4320 Moncton St, Richmond, BC V7E 6T4',
      venueLat: 49.12546,
      venueLng: -123.1783832,
      // A coordinate now travels with the tier it claims — this record stands in for the
      // library family's curated branchLocations table (G-VGEO-A3).
      venueGeoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
      venueGeoSource: 'library:rpl:branch-locations',
      venueMunicipalityName: 'Richmond',
      venueDisplayArea: 'Steveston',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      endDatetimeUtc: '2026-09-24T18:30:00.000Z',
      costStatus: 'free',
      categoryHint: 'storytime',
      sourceUrl: 'https://yourlibrary.bibliocommons.com/v2/events/venue-test',
      locationUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton%20St%20Richmond%20BC%20V7E%206T4',
    };
    const adapter: Adapter = {
      family: 'library',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: () => ({ key: 'venue-record' }),
    };

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);

    const [row] = await query<{ venue_name: string; display_area: string; lat: string; lng: string; location_url: string }>(
      `SELECT v.name AS venue_name, v.display_area,
              ST_Y(v.geo::geometry)::text AS lat,
              ST_X(v.geo::geometry)::text AS lng,
              o.location_url
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       JOIN venue v ON v.id = s.venue_id
       WHERE s.source_id = $1`,
      [source.id]
    );

    expect(row.venue_name).toBe('Steveston Library (Easthope Hub)');
    expect(row.display_area).toBe('Steveston');
    expect(Number(row.lat)).toBeCloseTo(49.12546, 5);
    expect(Number(row.lng)).toBeCloseTo(-123.1783832, 5);
    expect(row.location_url).toContain('4320%20Moncton');
  });

  // ── F-11: assessRun's verdict must land somewhere queryable ───────────────────────────
  // Previously the verdict existed only as prose inside the errors array, so nothing —
  // dashboard, SLA, alerting — could find it. These two pin the plumbing end to end:
  // ingestSource → finishCheckRun → source_check_run.health_alert_code.
  function alertingAdapter(diagnostics: { code: string; alert: boolean; detail: string } | null): Adapter {
    const record: StructuredRecord = {
      sourceRecordId: `assessrun-${crypto.randomUUID()}`,
      title: 'Drop-in Family Swim',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      costStatus: 'free',
      sourceUrl: 'https://example.org/assessrun',
    };
    return {
      family: 'noop',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      assessRun: () => diagnostics,
      dedupKeys: () => ({ key: `assessrun::${record.sourceRecordId}` }),
    };
  }

  it('persists an alerting assessRun verdict to health_alert_code, on a run that still ingested', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`AssessRun Alert Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(
      pool,
      alertingAdapter({ code: 'shape_drift', alert: true, detail: 'unrecognised payload keys for burnaby: sessionKind' }),
      source.id
    );

    expect(summary.healthAlert).toEqual({
      code: 'shape_drift',
      detail: 'unrecognised payload keys for burnaby: sessionKind',
    });

    const [run] = await query<{ status: string; health_alert_code: string | null; health_alert_detail: string | null }>(
      `SELECT status, health_alert_code, health_alert_detail FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    // The run ingested its record perfectly well — this is exactly the shape that used to
    // vanish: a 'partial' with a real alarm on it.
    expect(run.status).toBe('partial');
    expect(summary.occurrencesUpserted).toBe(1);
    expect(run.health_alert_code).toBe('shape_drift');
    expect(run.health_alert_detail).toBe('unrecognised payload keys for burnaby: sessionKind');
  });

  it('leaves health_alert_code NULL when assessRun returns ok / no verdict', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`AssessRun Quiet Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(
      pool,
      alertingAdapter({ code: 'ok', alert: false, detail: 'nothing to report' }),
      source.id
    );

    expect(summary.healthAlert).toBeNull();
    const [run] = await query<{ status: string; health_alert_code: string | null }>(
      `SELECT status, health_alert_code FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    // alert=false must not degrade the run OR write a code — a non-alerting verdict is not
    // an alert, and the column is the alert predicate.
    expect(run.status).toBe('success');
    expect(run.health_alert_code).toBeNull();
  });
});
