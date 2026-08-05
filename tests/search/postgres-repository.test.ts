import { afterAll, describe, expect, it } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { resolveSeries } from '../../worker/core/series';
import { upsertOccurrence } from '../../worker/core/upsert';
import { isRegistrationShaped } from '../../lib/search/filters/registration';
import { loadPostgresListingById, loadPostgresListings } from '../../lib/search/postgres-repository';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { RegionHierarchy } from '../../lib/geo/region';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Postgres search repository', () => {
  afterAll(async () => {
    await closePool();
  });

  it('maps occurrence + series + source rows into the search read model', async () => {
    const pool = getPool();
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': these fixtures insert 'confirmed' occurrences, which the
      // 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Repository Test Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Family Storytime — Test Branch ${suffix}`, source.id]
    );
    const [occurrence] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at
       ) VALUES ($1,$2,$3,$4,'2026-09-17T17:30:00Z','2026-09-17T18:00:00Z','free',$5,'confirmed','high',now())
       RETURNING id`,
      [series.id, `repo-test-${suffix}`, `Family Storytime ${suffix}`, category.id, 'https://example.org/events/repo-test']
    );

    const listings = await loadPostgresListings(pool);
    const listing = listings.find((l) => l.id === occurrence.id);

    expect(listing).toBeTruthy();
    expect(listing?.activityName).toBe(`Family Storytime ${suffix}`);
    expect(listing?.primaryCategoryKey).toBe('storytime');
    expect(listing?.categoryTags).toContain('storytime');
    expect(listing?.venueName).toContain('Test Branch');
    expect(listing?.organisation).toBe(`Repository Test Source ${suffix}`);
    expect(listing?.statusState).toBe('confirmed');
    expect(listing?.confidenceLabel).toBe('official_recent');
    expect(listing?.costStatus).toBe('free');
    expect(listing?.sourceUrl).toBe('https://example.org/events/repo-test');

    const detailListing = await loadPostgresListingById(pool, occurrence.id);
    expect(detailListing?.id).toBe(occurrence.id);
    expect(detailListing?.activityName).toBe(`Family Storytime ${suffix}`);
  });

  it('feeds DB storytime listings through the search engine', async () => {
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': these fixtures insert 'confirmed' occurrences, which the
      // 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Engine Test Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Family Storytime — Test Branch ${suffix}`, source.id]
    );
    const [occurrence] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at
       ) VALUES ($1,$2,$3,$4,'2026-09-17T17:30:00Z','2026-09-17T18:00:00Z','free',$5,'confirmed','high',now())
       RETURNING id`,
      [series.id, `engine-test-${suffix}`, `Family Storytime ${suffix}`, category.id, 'https://example.org/events/engine-test']
    );

    const listings = await loadPostgresListings(getPool());
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      fixtureBacked: false,
    });

    const response = engine.search({ q: 'storytime', minResults: 1, limit: 5 });
    expect(response.results.some((item) => item.listing.id === occurrence.id)).toBe(true);
    expect(response.meta.fixtureBacked).toBe(false);
  });


  it('does not load malformed IDs for detail pages', async () => {
    await expect(loadPostgresListingById(getPool(), 'not-a-uuid')).resolves.toBeNull();
  });

  it('does not return expired fixed-time occurrences from the live read model', async () => {
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': these fixtures insert 'confirmed' occurrences, which the
      // 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Expired Repository Source ${crypto.randomUUID()}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Past Family Storytime ${crypto.randomUUID()}`, source.id]
    );
    const [occurrence] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at
       ) VALUES ($1,$2,'Past Family Storytime',$3, now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'free', 'https://example.org/past', 'confirmed', 'high', now())
       RETURNING id`,
      [series.id, `past-${crypto.randomUUID()}`, category.id]
    );

    const listings = await loadPostgresListings(getPool());
    expect(listings.some((l) => l.id === occurrence.id)).toBe(false);
    await expect(loadPostgresListingById(getPool(), occurrence.id)).resolves.toBeNull();
  });

  // The reason the detail page could not show a phone number was NOT policy — the listing
  // SELECT simply never fetched `v.phone`, and this query is aggregated, so a new venue
  // column has to be added to the GROUP BY as well or Postgres rejects it outright. Both
  // read paths are asserted (list + detail-by-id): they are separate SQL statements sharing
  // one builder, and a phone that reaches the list but not the detail page is the exact
  // shape of failure that would ship silently.
  it('carries venue.phone through both read paths, and leaves it null when the venue has none', async () => {
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('activenet', $1, 'official', 'allowed') RETURNING id`,
      [`Phone Repository Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'public_swim' LIMIT 1`);
    const [withPhone] = await query<{ id: string }>(
      `INSERT INTO venue (name, phone) VALUES ($1, $2) RETURNING id`,
      [`Phone Test Centre ${suffix}`, '(604) 555-0142']
    );
    const [noPhone] = await query<{ id: string }>(`INSERT INTO venue (name) VALUES ($1) RETURNING id`, [
      `Phoneless Test Branch ${suffix}`,
    ]);

    const occurrenceAt = async (venueId: string, label: string): Promise<string> => {
      const [series] = await query<{ id: string }>(
        `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ($1, $2, $3) RETURNING id`,
        [`${label} ${suffix}`, source.id, venueId]
      );
      const [occurrence] = await query<{ id: string }>(
        `INSERT INTO activity_occurrence (
           series_id, source_record_id, activity_name, primary_category_id,
           start_datetime_utc, end_datetime_utc, cost_status, source_url,
           status_state, confidence_label, last_checked_at
         ) VALUES ($1,$2,$3,$4,'2026-09-17T17:30:00Z','2026-09-17T18:00:00Z','free',$5,'confirmed','high',now())
         RETURNING id`,
        [series.id, `${label}-${suffix}`, `${label} ${suffix}`, category.id, 'https://example.org/events/phone-test']
      );
      return occurrence.id;
    };

    const phoneOccurrenceId = await occurrenceAt(withPhone.id, 'Phone Family Swim');
    const phonelessOccurrenceId = await occurrenceAt(noPhone.id, 'Phoneless Family Swim');

    const listings = await loadPostgresListings(getPool());
    expect(listings.find((l) => l.id === phoneOccurrenceId)?.venuePhone).toBe('(604) 555-0142');
    expect(listings.find((l) => l.id === phonelessOccurrenceId)?.venuePhone).toBeNull();

    await expect(loadPostgresListingById(getPool(), phoneOccurrenceId)).resolves.toMatchObject({
      venuePhone: '(604) 555-0142',
    });
    await expect(loadPostgresListingById(getPool(), phonelessOccurrenceId)).resolves.toMatchObject({
      venuePhone: null,
    });
  });

  // When the repository is asked for a bounded diagnostic page, a hidden-status row that survives
  // into the result set has consumed a slot a showable row could have had. Filtering in SQL is what
  // makes any explicit cap buy usable rows. Asserted against a REAL query rather than the in-memory
  // predicate, because the in-memory one would have gone on passing while the budget quietly leaked.
  it('never loads hidden-status rows into an explicitly capped list, but still resolves them by id', async () => {
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Hidden Status Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Hidden Status Series ${suffix}`, source.id]
    );
    const insert = async (statusState: string, confidence: string) => {
      const [row] = await query<{ id: string }>(
        `INSERT INTO activity_occurrence (
           series_id, source_record_id, activity_name, primary_category_id,
           start_datetime_utc, end_datetime_utc, cost_status, source_url,
           status_state, confidence_label, last_checked_at
         ) VALUES ($1,$2,$3,$4, now() + interval '1 hour', now() + interval '2 hours', 'free', 'https://example.org/hidden', $5, $6, now())
         RETURNING id`,
        [series.id, `hidden-${statusState}-${suffix}`, `Hidden ${statusState} ${suffix}`, category.id, statusState, confidence]
      );
      return row.id;
    };

    const needsReviewId = await insert('needs_review', 'low');
    const confirmedId = await insert('confirmed', 'high');

    const listings = await loadPostgresListings(getPool(), { limit: 1000 });
    expect(listings.some((l) => l.id === confirmedId)).toBe(true);
    expect(listings.some((l) => l.id === needsReviewId)).toBe(false);
    // No hidden status of any kind reaches the read model.
    expect(listings.some((l) => ['cancelled', 'suspended', 'needs_review'].includes(l.statusState))).toBe(false);

    // The detail path is deliberately NOT narrowed: it has no cap to protect and is reached by an
    // explicit id, so already-shared links keep resolving.
    await expect(loadPostgresListingById(getPool(), needsReviewId)).resolves.toMatchObject({
      id: needsReviewId,
      statusState: 'needs_review',
    });
  });

  // ── Option A / QA round 139 F1: the WRITE -> READ -> PREDICATE chain ──────────────────
  //
  // The adapter and predicate halves were unit-tested independently and both were correct,
  // but nothing exercised the SQL between them. Six mutations survived that gap: dropping
  // the column from listingSelectSql, coercing it with `?? false` in rowToListing, and the
  // upsert's EXCLUDED-vs-COALESCE distinction among them. Each of those silently converts
  // "the source said nothing" (NULL, ~99% of the corpus) into "the source says drop-in", or
  // loses the signal entirely, with every unit test still green.
  //
  // This drives the REAL chain: upsertOccurrence writes -> loadPostgresListings reads ->
  // isRegistrationShaped decides. No stubs anywhere in the middle.
  it('round-trips registration_required through SQL and into the search predicate', async () => {
    const pool = getPool();
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, terms_status)
       VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Registration Roundtrip Source ${suffix}`]
    );
    const { seriesId } = await resolveSeries(pool, {
      sourceId: source.id,
      canonicalTitle: `Registration Roundtrip ${suffix}`,
    });

    // Titles chosen so the TITLE HEURISTIC and the PERSISTED FACT disagree in both
    // directions. If the column is dropped or coerced anywhere along the way, the heuristic
    // answers instead and these assertions flip — which is exactly what the survivors did.
    const write = async (recordId: string, title: string, registrationRequired?: boolean) => {
      const { occurrenceId } = await upsertOccurrence(
        pool,
        seriesId,
        {
          sourceRecordId: recordId,
          title,
          startDatetimeUtc: '2026-09-17T17:30:00.000Z',
          endDatetimeUtc: '2026-09-17T18:00:00.000Z',
          costStatus: 'free' as const,
          sourceUrl: 'https://example.org/events/reg-roundtrip',
          ...(registrationRequired === undefined ? {} : { registrationRequired }),
        },
        { statusState: 'confirmed', confidenceLabel: 'high' }
      );
      return occurrenceId;
    };

    // Drop-in-SHAPED title, but the source says you must register.
    const factTrueId = await write(`rt-true-${suffix}`, `Baby Storytime ${suffix}`, true);
    // Course-SHAPED title, but the source says you need not.
    const factFalseId = await write(`rt-false-${suffix}`, `Skating Level 1 ${suffix}`, false);
    // The silent majority.
    const factNullId = await write(`rt-null-${suffix}`, `Frozen Ballet Dance Camp ${suffix}`);

    // CLEANUP IS MANDATORY HERE, not hygiene. These rows are confirmed + future-dated, so
    // they enter the shared DB lane's read model and are visible to every suite that reads a
    // global aggregate. Leaving them behind broke tests/email/weekly_send.test.ts (they
    // displaced its "new activity") and this file's own engine test — the exact cross-file
    // interference vitest.workspace.ts documents. try/finally so it runs on assertion
    // failure too, otherwise one red test poisons every subsequent run.
    try {
    const listings = await loadPostgresListings(pool, { limit: 1000 });
    const byId = (id: string) => listings.find((l) => l.id === id)!;

    // 1. The column survives the SELECT and reaches ListingRecord with its value intact.
    expect(byId(factTrueId).registrationRequired).toBe(true);
    expect(byId(factFalseId).registrationRequired).toBe(false);
    // 2. NULL stays NULL. `?? false` in rowToListing would make this `false` and assert
    //    "drop-in" over the whole silent corpus; a dropped column would make it `undefined`.
    expect(byId(factNullId).registrationRequired).toBeNull();

    // 3. The predicate consumes it end-to-end, overriding the title in BOTH directions.
    expect(isRegistrationShaped(byId(factTrueId))).toBe(true);
    expect(isRegistrationShaped(byId(factFalseId))).toBe(false);
    // 4. …and the silent row still falls through to the unchanged heuristic ('camp').
    expect(isRegistrationShaped(byId(factNullId))).toBe(true);

    // 5. The DETAIL path reads the same column through the same SQL, so a card and the page
    //    it opens can never disagree about whether registration is required.
    for (const id of [factTrueId, factFalseId, factNullId]) {
      const detail = await loadPostgresListingById(pool, id);
      expect(detail!.registrationRequired).toBe(byId(id).registrationRequired);
      expect(isRegistrationShaped(detail!)).toBe(isRegistrationShaped(byId(id)));
    }

    // 6. Re-ingest CORRECTS the row (EXCLUDED overwrite, not COALESCE) — verified through
    //    the read model rather than a direct SELECT, so the whole chain has to carry it.
    await write(`rt-false-${suffix}`, `Skating Level 1 ${suffix}`, true);
    const reread = await loadPostgresListings(pool, { limit: 1000 });
    expect(reread.find((l) => l.id === factFalseId)!.registrationRequired).toBe(true);
    } finally {
      // Scoped to THIS test's own source id — never a blanket DELETE over the table, which
      // is its own well-documented way to break neighbouring suites.
      await query(
        `DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id = $1)`,
        [source.id]
      );
      await query(`DELETE FROM activity_series WHERE source_id = $1`, [source.id]);
      await query(`DELETE FROM source WHERE id = $1`, [source.id]);
    }
  });
});
