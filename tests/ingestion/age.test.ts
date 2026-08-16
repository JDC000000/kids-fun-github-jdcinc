import { describe, it, expect, afterAll } from 'vitest';
import {
  parseAgeText,
  parseAudienceLabels,
  computeAgeBandMatches,
  type AgeBandRow,
} from '../../worker/core/age';
import type { Adapter, StructuredRecord } from '../../worker/core/adapter';
import { ingestSource } from '../../worker/core/ingest';
import { getPool, query, closePool } from '../../lib/db/client';

// Deterministic-first age normaliser (T13 deterministic layer). Pure-rule tests
// run everywhere; the wiring/idempotency test needs DATABASE_URL (same harness
// as the other ingestion tests) and is skipped on a plain `npm test`.
const hasDb = Boolean(process.env.DATABASE_URL);

// Mirror of supabase/seeds/age_bands.sql — key doubles as a readable id here.
const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

const bandsFor = (text: string) => computeAgeBandMatches(parseAgeText(text), BANDS).sort();

describe('parseAgeText — deterministic age wording', () => {
  it('resolves explicit year ranges (upper is inclusive → exclusive at B+1 years)', () => {
    expect(parseAgeText('ages 0-2 years')).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 36, resolved: true });
    expect(parseAgeText('5-9 years')).toMatchObject({ ageMinMonths: 60, ageMaxMonths: 120, resolved: true });
    expect(parseAgeText('ages 2–4')).toMatchObject({ ageMinMonths: 24, ageMaxMonths: 60, resolved: true });
  });

  it('resolves month ranges without treating them as years', () => {
    expect(parseAgeText('6-18 months')).toMatchObject({ ageMinMonths: 6, ageMaxMonths: 19, resolved: true });
  });

  // A rec-centre title's most common number is a SKILL RATING, not an age. Reading a digit out
  // of a decimal produced the worst outcome the age facet can produce, in both directions:
  // "Pickleball - 3.0+" resolved to 0+ (all five bands — an adult session answering a search
  // for a baby), and "Pickleball 3.0-4.0" resolved to ages 0-4 (adult programming wearing a
  // toddler-only label). Confirmed live on 2 production listings, 2026-08-16.
  it('never reads an age out of a decimal skill rating', () => {
    for (const title of [
      'Pickleball - 3.0+',
      'Pickleball - 3.5+',
      'Badminton 2.0+',
      'Pickleball 3.0-4.0',
      'Volleyball 2.5 - 3.5',
    ]) {
      expect(parseAgeText(title), title).toMatchObject({
        ageMinMonths: null,
        ageMaxMonths: null,
        resolved: false,
      });
      expect(computeAgeBandMatches(parseAgeText(title), BANDS), title).toEqual([]);
    }
  });

  it('still finds a real age range in a title that also carries a decimal', () => {
    // The guard skips the decimal, it does not abandon the string.
    expect(parseAgeText('Level 2.0 Swim ages 3-5')).toMatchObject({
      ageMinMonths: 36,
      ageMaxMonths: 72,
      resolved: true,
    });
  });

  it('resolves open-ended minimums and "under N"', () => {
    expect(parseAgeText('ages 5+')).toMatchObject({ ageMinMonths: 60, ageMaxMonths: null, resolved: true });
    expect(parseAgeText('5 years and up')).toMatchObject({ ageMinMonths: 60, ageMaxMonths: null, resolved: true });
    expect(parseAgeText('under 5')).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 60, resolved: true });
  });

  it('resolves grade ranges into ages (grade g → age g+5)', () => {
    expect(parseAgeText('grades K-3')).toMatchObject({ ageMinMonths: 60, ageMaxMonths: 108, resolved: true });
  });

  it('resolves keyword audiences', () => {
    expect(parseAgeText('Toddler Time')).toMatchObject({ ageMinMonths: 12, ageMaxMonths: 36, resolved: true });
    expect(parseAgeText('for teens')).toMatchObject({ ageMinMonths: 144, ageMaxMonths: 216, resolved: true });
    expect(parseAgeText('Preschool storytime')).toMatchObject({ ageMinMonths: 36, ageMaxMonths: 60, resolved: true });
  });

  it('treats all-ages / family wording as an open range', () => {
    expect(parseAgeText('All ages')).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null, resolved: true, notes: 'all-ages' });
    expect(parseAgeText('Family Theatre highlighting local artists')).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null, resolved: true });
  });

  it('leaves genuinely ambiguous wording UNRESOLVED (worklist for the LLM-fallback)', () => {
    const p = parseAgeText('See event details');
    expect(p).toMatchObject({ ageMinMonths: null, ageMaxMonths: null, resolved: false });
    expect(p.notes).toContain('unresolved');
    expect(parseAgeText('')).toMatchObject({ resolved: false });
    expect(parseAgeText(undefined)).toMatchObject({ resolved: false });
  });
});

describe('computeAgeBandMatches — half-open overlap, no band bleed', () => {
  it('maps a range only to the bands it actually overlaps', () => {
    expect(bandsFor('5-9 years')).toEqual(['5-9']); // does NOT bleed into 2-4 or 10-14
    expect(bandsFor('ages 0-2 years')).toEqual(['2-4', 'under2']);
    expect(bandsFor('under 5')).toEqual(['2-4', 'under2']);
    expect(bandsFor('ages 5+')).toEqual(['10-14', '15+', '5-9']);
    expect(bandsFor('for teens')).toEqual(['10-14', '15+']);
  });

  it('all-ages matches every band; unknown matches none', () => {
    expect(bandsFor('All ages')).toEqual(['10-14', '15+', '2-4', '5-9', 'under2']);
    expect(computeAgeBandMatches(parseAgeText('See event details'), BANDS)).toEqual([]);
  });
});

// A source's own structured audience tags are N independent claims and resolve to their
// UNION — unlike prose, which is one claim and resolves first-keyword-wins. Keeping the two
// entry points separate is what lets prose keep its most-specific-first ordering (which exists
// to stop the broad `children` rule stealing a phrase containing a narrower word) while a tag
// list gets the answer the source actually meant.
describe('parseAudienceLabels — structured tags resolve to their union', () => {
  const bandsForLabels = (labels: string[]) =>
    computeAgeBandMatches(parseAudienceLabels(labels), BANDS).sort();

  it('unions every tag rather than taking the first keyword hit', () => {
    // VPL's Family Storytime: Toddlers [12,36) ∪ Preschool [36,60). parseAgeText over the same
    // words joined into one string would stop at "Toddlers" and silently drop the preschool
    // half — which is the whole reason this is a separate function.
    expect(parseAudienceLabels(['Storytimes', 'Preschool Age Children', 'Toddlers', 'English'])).toMatchObject({
      ageMinMonths: 12,
      ageMaxMonths: 60,
      resolved: true,
    });
    expect(parseAgeText('Storytimes, Preschool Age Children, Toddlers, English')).toMatchObject({
      ageMaxMonths: 36, // first-keyword-wins: correct for prose, lossy for a tag list
    });
  });

  it('an open-ended tag opens the whole range, and a genuine all-ages tag matches every band', () => {
    expect(parseAudienceLabels(['Babies', 'Adults'])).toMatchObject({
      ageMinMonths: 0,
      ageMaxMonths: null,
      resolved: true,
    });
    expect(bandsForLabels(['Family', 'Storytimes'])).toEqual(['10-14', '15+', '2-4', '5-9', 'under2']);
  });

  it('recognises adult/senior audiences, which prose keywords deliberately do not', () => {
    // "Adults" as a TAG is an audience. "Adults" in "Adults accompanying children under 9 must
    // stay in the library" is prose about supervision — which is exactly why this lives here
    // and not in KEYWORD_BANDS.
    expect(bandsForLabels(['Meetups', 'Adults', 'Newcomers'])).toEqual(['15+']);
    expect(bandsForLabels(['Seniors'])).toEqual(['15+']);
    expect(parseAgeText('Adults accompanying children under 9 must stay')).toMatchObject({
      ageMinMonths: 0,
      ageMaxMonths: 108, // "under 9" — the prose parser is untouched by the adult tag rule
    });
  });

  it('a tag list carrying no age signal is silence, not a claim', () => {
    expect(parseAudienceLabels(['Meetups', 'English', 'Book Clubs & Reading Circles'])).toMatchObject({
      ageMinMonths: null,
      ageMaxMonths: null,
      resolved: false,
    });
    expect(parseAudienceLabels([])).toMatchObject({ resolved: false });
    expect(parseAudienceLabels([null, undefined, '  '])).toMatchObject({ resolved: false });
  });

  it('names the tags it believed, so a wrong band can be traced to a claim', () => {
    expect(parseAudienceLabels(['Storytimes', 'Toddlers', 'English']).notes).toBe('audience: Toddlers');
  });
});

describe.skipIf(!hasDb)('age normalisation wiring into ingest (occurrence_age)', () => {
  // Track every source this test inserts so afterAll can remove ALL rows it wrote
  // to shared staging (source + series + occurrences + occurrence_age + provenance +
  // source_check_run). Without this, a leftover failed source_check_run on a pending
  // test source pollutes the admin health dashboard's "recent failures" view.
  const createdSourceIds: string[] = [];

  afterAll(async () => {
    try {
      if (createdSourceIds.length > 0) {
        // Child rows first (no ON DELETE CASCADE is assumed).
        await query(
          `DELETE FROM occurrence_age WHERE occurrence_id IN (
             SELECT o.id FROM activity_occurrence o
             JOIN activity_series s ON s.id = o.series_id
             WHERE s.source_id = ANY($1::uuid[]))`,
          [createdSourceIds]
        );
        await query(
          `DELETE FROM provenance WHERE occurrence_id IN (
             SELECT o.id FROM activity_occurrence o
             JOIN activity_series s ON s.id = o.series_id
             WHERE s.source_id = ANY($1::uuid[]))`,
          [createdSourceIds]
        );
        // G-T13-3: ingest now also writes occurrence_category_tag rows (secondary
        // categories + suitability tags), which FK-reference activity_occurrence.
        await query(
          `DELETE FROM occurrence_category_tag WHERE occurrence_id IN (
             SELECT o.id FROM activity_occurrence o
             JOIN activity_series s ON s.id = o.series_id
             WHERE s.source_id = ANY($1::uuid[]))`,
          [createdSourceIds]
        );
        await query(
          `DELETE FROM activity_occurrence WHERE series_id IN (
             SELECT id FROM activity_series WHERE source_id = ANY($1::uuid[]))`,
          [createdSourceIds]
        );
        await query(`DELETE FROM activity_series WHERE source_id = ANY($1::uuid[])`, [createdSourceIds]);
        await query(`DELETE FROM source_check_run WHERE source_id = ANY($1::uuid[])`, [createdSourceIds]);
        await query(`DELETE FROM source WHERE id = ANY($1::uuid[])`, [createdSourceIds]);
      }
    } finally {
      await closePool();
    }
  });

  function adapterWith(records: StructuredRecord[]): Adapter {
    return {
      family: 'noop',
      fetch: async () => records,
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: (r) => ({ key: `noop::${r.sourceRecordId}` }),
    };
  }

  it('writes a structured occurrence_age row and is idempotent on re-ingest', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      // terms_status='allowed': a structured record here ingests to a 'confirmed' occurrence,
      // which the 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, terms_status) VALUES ('noop', $1, 'allowed') RETURNING id`,
      [`Age Wiring Source ${crypto.randomUUID()}`]
    );
    createdSourceIds.push(source.id);
    const rid = `age-record-${crypto.randomUUID()}`;
    const records: StructuredRecord[] = [
      { sourceRecordId: rid, title: 'Baby & Me', ageText: 'ages 0-2 years', startDatetimeUtc: '2026-09-24T18:00:00.000Z', costStatus: 'free', sourceUrl: 'https://example.org/a' },
      { sourceRecordId: `${rid}-b`, title: 'Mystery Program', ageText: 'See event details', startDatetimeUtc: '2026-09-24T19:00:00.000Z', costStatus: 'free', sourceUrl: 'https://example.org/b' },
    ];
    const adapter = adapterWith(records);

    const first = await ingestSource(pool, adapter, source.id);
    expect(first.errors).toEqual([]);
    expect(first.ageResolved).toBe(1); // only the "0-2 years" record resolves

    const resolved = await query<{ age_min_months: number; age_max_months: number; matches: number; notes: string | null }>(
      `SELECT oa.age_min_months, oa.age_max_months,
              array_length(oa.age_band_matches, 1) AS matches, oa.age_notes AS notes
       FROM occurrence_age oa
       JOIN activity_occurrence o ON o.id = oa.occurrence_id
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1 AND o.source_record_id = $2`,
      [source.id, rid]
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].age_min_months).toBe(0);
    expect(resolved[0].age_max_months).toBe(36);
    expect(resolved[0].matches).toBe(2); // under2 + 2-4

    const unresolved = await query<{ age_min_months: number | null; notes: string | null }>(
      `SELECT oa.age_min_months, oa.age_notes AS notes
       FROM occurrence_age oa
       JOIN activity_occurrence o ON o.id = oa.occurrence_id
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1 AND o.source_record_id = $2`,
      [source.id, `${rid}-b`]
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].age_min_months).toBeNull();
    expect(unresolved[0].notes).toContain('unresolved');

    // Idempotent: a second identical ingest overwrites in place, no duplicate rows.
    const second = await ingestSource(pool, adapter, source.id);
    expect(second.ageResolved).toBe(1);
    const [count] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM occurrence_age oa
       JOIN activity_occurrence o ON o.id = oa.occurrence_id
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1`,
      [source.id]
    );
    expect(Number(count.n)).toBe(2);

    // Resolved age produces a provenance fact for age_min_months.
    const prov = await query<{ n: string }>(
      `SELECT count(*) AS n FROM provenance p
       JOIN activity_occurrence o ON o.id = p.occurrence_id
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1 AND p.field = 'age_min_months'`,
      [source.id]
    );
    expect(Number(prov[0].n)).toBeGreaterThanOrEqual(1);
  });
});
