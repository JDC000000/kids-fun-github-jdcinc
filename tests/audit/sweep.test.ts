// tests/audit/sweep.test.ts — the catalogue pager, against a fake API. No network.
//
// The pager is the part of this job most likely to be wrong in a way nobody notices: an
// offset-less API plus an adaptive partition means a bug does not throw, it just returns fewer
// rows — and fewer rows means fewer findings, which reads exactly like "the catalogue is clean".
// So these tests pin the two properties that make a sweep trustworthy: it reaches rows that only
// exist deep in the partition tree, and it never claims coverage it did not achieve.
import { describe, expect, it } from 'vitest';
import { REGION_IDS, rawAgeWording, sweepCatalogue, toAuditListing } from '@/lib/audit/sources/search-api';

interface FakeRow {
  id: string;
  region: string;
  /** YYYY-MM-DD */
  date: string;
  time: string;
  ages: string[];
}

/**
 * A fake /api/search that honours region / from-to / time / age exactly as the real one does,
 * including the "empty age bands match every age filter" rule, and clamps to 100 results while
 * reporting the true pre-limit `total`.
 */
function makeFakeApi(rows: FakeRow[]) {
  let requests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    requests += 1;
    const url = new URL(String(input));
    const p = url.searchParams;
    let matched = rows;
    const region = p.get('region');
    if (region) matched = matched.filter((r) => r.region === region);
    const from = p.get('from');
    const to = p.get('to');
    if (from && to) matched = matched.filter((r) => r.date >= from && r.date <= to);
    const time = p.get('time');
    if (time) matched = matched.filter((r) => r.time === time);
    const age = p.get('age');
    if (age) matched = matched.filter((r) => r.ages.length === 0 || r.ages.includes(age));
    const sort = p.get('sort');
    // Different orderings expose a different top-100 — the property the alt-sort harvest uses.
    const ordered = sort === 'newest' ? [...matched].reverse() : matched;
    const limit = Number(p.get('limit') ?? '100');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        total: matched.length,
        results: ordered.slice(0, limit).map((r) => ({
          listing: {
            id: r.id,
            seriesId: null,
            activityName: `Activity ${r.id}`,
            primaryCategoryKey: 'class_program',
            categoryTags: ['class_program'],
            suitabilityTags: ['indoor'],
            venueName: 'V',
            organisation: 'Org',
            descriptionSnippet: '',
            openHoursLabel: null,
            ageBandMatches: r.ages,
            ageMinMonths: null,
            ageMaxMonths: null,
            ageNotes: null,
            sourceUrl: null,
          },
        })),
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requests: () => requests };
}

describe('sweepCatalogue', () => {
  it('takes a single page when the catalogue fits', async () => {
    const rows: FakeRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${i}`,
      region: REGION_IDS[0],
      date: '2026-08-20',
      time: 'morning',
      ages: ['2-4'],
    }));
    const api = makeFakeApi(rows);
    const result = await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl });
    expect(result.listings).toHaveLength(40);
    expect(result.coverage).toBe(1);
    expect(api.requests()).toBe(1);
  });

  it('partitions down to region + date + time + age and reaches every row', async () => {
    // 600 rows spread over 3 regions × 20 days × 3 day-parts — no single cell above the limit
    // only because the partition actually recurses. This is the case the first version of the
    // date dimension silently failed: it split once and then gave up.
    const rows: FakeRow[] = [];
    let n = 0;
    for (const region of REGION_IDS.slice(0, 3)) {
      for (let d = 1; d <= 20; d++) {
        for (const time of ['morning', 'afternoon', 'evening']) {
          for (let k = 0; k < 4; k++) {
            rows.push({
              id: `id-${n++}`,
              region,
              date: `2026-09-${String(d).padStart(2, '0')}`,
              time,
              ages: ['5-9'],
            });
          }
        }
      }
    }
    expect(rows).toHaveLength(720);
    const api = makeFakeApi(rows);
    const result = await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl });
    expect(result.listings).toHaveLength(720);
    expect(result.coverage).toBe(1);
    expect(result.truncatedCells).toHaveLength(0);
  });

  it('splits a TWO-DAY window (the bug that truncated 198 cells against production)', async () => {
    // Everything on two adjacent days, same region/time/age. The only axis that can separate
    // them is the date, and the window is two days wide — the exact shape a midpoint that
    // refuses endpoint-equal values cannot split.
    const rows: FakeRow[] = [];
    for (let i = 0; i < 120; i++) {
      rows.push({
        id: `id-${i}`,
        region: REGION_IDS[0],
        date: i < 60 ? '2026-09-13' : '2026-09-14',
        time: 'afternoon',
        ages: ['15+'],
      });
    }
    const api = makeFakeApi(rows);
    const result = await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl });
    expect(result.listings).toHaveLength(120);
    expect(result.truncatedCells).toHaveLength(0);
  });

  it('records an unsplittable cell instead of silently capping it', async () => {
    // 150 rows on ONE day, one day-part, one age band: no dimension can divide them.
    const rows: FakeRow[] = Array.from({ length: 150 }, (_, i) => ({
      id: `id-${i}`,
      region: REGION_IDS[0],
      date: '2026-09-13',
      time: 'afternoon',
      ages: ['15+'],
    }));
    const api = makeFakeApi(rows);
    const result = await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl });
    expect(result.truncatedCells.length).toBeGreaterThan(0);
    expect(result.truncatedCells[0].total).toBe(150);
    // The alt-sort harvest recovers the tail: best_match's first 100 plus newest's first 100
    // (the reversed order) covers all 150.
    expect(result.listings).toHaveLength(150);
    // And coverage is reported as a measurement, never assumed.
    expect(result.coverage).toBe(1);
  });

  it('reports coverage below 1 when rows are genuinely unreachable', async () => {
    // 400 rows in one indivisible cell: even four orderings cannot expose more than the top
    // 100 of each, and two of the sorts here return the same order.
    const rows: FakeRow[] = Array.from({ length: 400 }, (_, i) => ({
      id: `id-${i}`,
      region: REGION_IDS[0],
      date: '2026-09-13',
      time: 'afternoon',
      ages: ['15+'],
    }));
    const api = makeFakeApi(rows);
    const result = await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl });
    expect(result.listings.length).toBeLessThan(400);
    expect(result.coverage).toBeLessThan(1);
    expect(result.catalogueTotal).toBe(400);
  });

  it('honours the request cap rather than hammering the API forever', async () => {
    const rows: FakeRow[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `id-${i}`,
      region: REGION_IDS[i % 5],
      date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      time: ['morning', 'afternoon', 'evening'][i % 3],
      ages: ['5-9'],
    }));
    const api = makeFakeApi(rows);
    await expect(
      sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: api.fetchImpl, maxRequests: 5 })
    ).rejects.toThrow(/request cap/);
  });

  it('always asks for registration-required listings', async () => {
    const api = makeFakeApi([]);
    let seen = '';
    const spy = (async (input: string | URL | Request) => {
      seen = String(input);
      return api.fetchImpl(input as string);
    }) as unknown as typeof fetch;
    await sweepCatalogue({ baseUrl: 'https://example.test', mode: 'as_served', fetchImpl: spy });
    expect(seen).toContain('includeRegistration=1');
  });
});

describe('toAuditListing', () => {
  it('recovers the raw source wording from the parser tag', () => {
    expect(rawAgeWording('unresolved: Adults, English')).toBe('Adults, English');
    expect(rawAgeWording('all-ages')).toBe('all-ages');
    expect(rawAgeWording(null)).toBe('');
  });

  it('keeps the served tags in as_served mode and re-derives them in post_fix mode', () => {
    const row = {
      id: 'x',
      seriesId: null,
      activityName: 'T',
      primaryCategoryKey: 'class_program',
      categoryTags: ['class_program', 'free'],
      suitabilityTags: ['free', 'indoor'],
      venueName: 'V',
      organisation: 'O',
      descriptionSnippet: null,
      openHoursLabel: null,
      ageBandMatches: [],
      ageMinMonths: null,
      ageMaxMonths: null,
      ageNotes: null,
      sourceUrl: null,
    };
    expect(toAuditListing(row, 'as_served').derived.suitabilityTags).toEqual(['free', 'indoor']);
    expect(toAuditListing(row, 'post_fix').derived.suitabilityTags).toEqual(['free']);
  });
});
