// tests/search/occurrence-span-honesty.test.ts — an occurrence is a SPAN, not an instant.
//
// WHAT THIS PINS, AND WHY IT EXISTS
// The first effectiveness measurement of the live product reported `?region=rmd` returning
// "expired events badged Confirmed · Checked today" — library programmes dated Wed, Jul 8 and
// Wed, Jun 24 shown on 16 August. Queried against live production (commit a5bd584), those seven
// Richmond Public Library rows turned out NOT to be expired at all:
//
//     Summer Scavenger Hunt          start 2026-07-08T07:00Z   end 2026-09-03T06:59:59Z
//     Teen Summer Reading Club 2026  start 2026-06-24T07:00Z   end 2026-09-01T06:59:59Z
//     (+5 more on the same Jun 24 → Sep 1 span)
//
// Every one carries `open_hours_state = null` and an end date weeks in the FUTURE, so the SQL
// visibility predicate was right to keep them: the programmes are running. What was wrong was
// that the product modelled every occurrence as a point in time and so described a nine-week
// programme by its first day alone — on the card ("Wed, Jul 8 · 12 AM–11:59 PM"), in the date
// filter (matched only 8 July), and in the weekly email.
//
// So these tests pin the span, from both ends:
//   · a genuinely past occurrence stays excluded, INCLUDING when it carries an open-hours string
//     that used to let it skip the date check entirely;
//   · a genuinely dateless standing record stays visible for ever, and keeps its hours text;
//   · a running multi-day occurrence matches every day it runs, not just its first.
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadPostgresListings } from '../../lib/search/postgres-repository';
import { matchesDate } from '../../lib/search/filters/time';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { DateIntent } from '../../lib/search/types';

// ── The SQL visibility predicate ──────────────────────────────────────────────────────────────
// Asserted on the query TEXT rather than against a live database so the unit lane catches a
// regression here; tests/search/postgres-repository.test.ts exercises the same predicate against
// real rows in the DB-gated lane.

function capturingPool(rows: Record<string, unknown>[] = []) {
  const calls: string[] = [];
  const pool = {
    query: async (text: string) => {
      calls.push(text);
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

/** Collapse whitespace so the assertions read as SQL rather than as indentation. */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

describe('visible-occurrence predicate (lib/search/postgres-repository)', () => {
  it('lets a row skip the date check ONLY when it has no start datetime at all', async () => {
    const { pool, calls } = capturingPool();

    await loadPostgresListings(pool);

    // The dateless arm must require the date to be ACTUALLY ABSENT. Migration 0004's constraint
    // is `CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS NOT NULL)` — an OR, not an
    // exclusive one — so nothing in the schema stops a row carrying both. Testing only
    // `open_hours_state IS NOT NULL` would let such a row hide a long-past date behind an hours
    // string and stay visible for ever.
    expect(flatten(calls[0])).toContain(
      '(o.start_datetime_utc IS NULL AND o.open_hours_state IS NOT NULL)'
    );
    expect(flatten(calls[0])).toContain(
      'OR COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()'
    );
    // Regression guard on the exact defect shape: the bare hours test must not survive anywhere
    // in the predicate as an independent escape hatch.
    expect(flatten(calls[0])).not.toContain('(o.open_hours_state IS NOT NULL OR COALESCE');
  });

  it('judges a dated occurrence on its END, so a multi-week programme stays visible mid-run', async () => {
    const { pool, calls } = capturingPool();

    await loadPostgresListings(pool);

    // COALESCE(end, start) — not start alone. Summer Scavenger Hunt started five weeks before the
    // measurement date and had three more weeks to run; judging it on `start` would have hidden a
    // programme a parent could still take their child to.
    expect(flatten(calls[0])).toContain('COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()');
    expect(flatten(calls[0])).toContain('o.archived_at IS NULL');
  });

  it('carries the standing-hours sentence into the read model instead of dropping it', async () => {
    const { pool } = capturingPool([
      {
        id: 'oh-1',
        series_id: 'oh-series',
        activity_name: 'General Admission',
        primary_category_key: 'museum_venue',
        tag_keys: [],
        venue_name: 'H.R. MacMillan Space Centre',
        source_name: 'Space Centre',
        series_title: 'General Admission — H.R. MacMillan Space Centre',
        source_authority_tier: 'official',
        description_snippet: '',
        start_datetime_utc: null,
        end_datetime_utc: null,
        open_hours_state: '  Daily 10:00 AM–5:00 PM  ',
        cost_status: 'check_source',
        cost_min_cad: null,
        cost_max_cad: null,
        source_url: 'https://example.org/admission',
        booking_url: null,
        location_url: null,
        registration_required: null,
        status_state: 'confirmed',
        confidence_label: 'high',
        last_checked_at: '2026-08-16T01:00:00Z',
        age_min_months: null,
        age_max_months: null,
        age_notes: null,
        age_band_keys: [],
        lat: null,
        lng: null,
        municipality_id: null,
        neighbourhood: null,
        display_area: null,
        phone: null,
      },
    ]);

    const [listing] = await loadPostgresListings(pool);

    expect(listing.openHours).toBe(true);
    expect(listing.startDatetimeUtc).toBeNull();
    // Selected in SQL but previously never mapped, which left the card with no date AND no hours
    // — and therefore with nothing to print but a fabricated timestamp.
    expect(listing.openHoursLabel).toBe('Daily 10:00 AM–5:00 PM');
  });
});

// ── The date filter ───────────────────────────────────────────────────────────────────────────

describe('matchesDate treats an occurrence as a span (lib/search/filters/time)', () => {
  /** The real Summer Scavenger Hunt row, verbatim from live production on 2026-08-16. */
  const scavengerHunt = makeListing({
    id: 'rmd-scavenger-hunt',
    activityName: 'Summer Scavenger Hunt',
    startDatetimeUtc: '2026-07-08T07:00:00.000Z', // 2026-07-08 00:00 Vancouver
    endDatetimeUtc: '2026-09-03T06:59:59.000Z', // 2026-09-02 23:59 Vancouver
  });

  const singleDay = makeListing({
    id: 'rmd-chess',
    activityName: 'Chess for Fun (All Ages)',
    startDatetimeUtc: '2026-08-16T21:00:00.000Z', // 2026-08-16 14:00 Vancouver
    endDatetimeUtc: '2026-08-16T23:30:00.000Z',
  });

  const point = (isoDate: string): DateIntent => ({ kind: 'explicit', isoDate, weekday: null });
  const range = (isoDate: string, endIsoDate: string): DateIntent => ({
    kind: 'range',
    isoDate,
    endIsoDate,
    weekday: null,
  });

  it('matches a running multi-day programme on a day in the MIDDLE of its run', () => {
    // The defect this whole unit exists for: on 16 August the programme is on, and a parent
    // asking "what is on today?" was told it was not.
    expect(matchesDate(scavengerHunt, point('2026-08-16'))).toBe(true);
  });

  it('matches it on its first and last days', () => {
    expect(matchesDate(scavengerHunt, point('2026-07-08'))).toBe(true);
    expect(matchesDate(scavengerHunt, point('2026-09-02'))).toBe(true);
  });

  it('does not match before it starts or after it ends', () => {
    expect(matchesDate(scavengerHunt, point('2026-07-07'))).toBe(false);
    expect(matchesDate(scavengerHunt, point('2026-09-03'))).toBe(false);
  });

  it('leaves an ordinary same-day occurrence exactly as it was', () => {
    expect(matchesDate(singleDay, point('2026-08-16'))).toBe(true);
    expect(matchesDate(singleDay, point('2026-08-15'))).toBe(false);
    expect(matchesDate(singleDay, point('2026-08-17'))).toBe(false);
  });

  it('overlaps a requested date RANGE rather than requiring the start day to fall inside it', () => {
    const midRun = range('2026-08-15', '2026-08-18');
    expect(matchesDate(scavengerHunt, midRun)).toBe(true);
    expect(matchesDate(singleDay, midRun)).toBe(true);
    expect(matchesDate(scavengerHunt, range('2026-09-04', '2026-09-10'))).toBe(false);
  });

  it('never widens a match on a backwards or unparseable end datetime', () => {
    const backwards = makeListing({
      id: 'backwards',
      startDatetimeUtc: '2026-08-16T21:00:00.000Z',
      endDatetimeUtc: '2026-06-01T00:00:00.000Z',
    });
    const unparseable = makeListing({
      id: 'unparseable',
      startDatetimeUtc: '2026-08-16T21:00:00.000Z',
      endDatetimeUtc: 'not-a-date',
    });
    for (const listing of [backwards, unparseable]) {
      expect(matchesDate(listing, point('2026-08-16'))).toBe(true);
      expect(matchesDate(listing, point('2026-06-01'))).toBe(false);
      expect(matchesDate(listing, point('2026-08-17'))).toBe(false);
    }
  });

  it('keeps a genuinely dateless standing record available on every day', () => {
    const standing = makeListing({ id: 'standing', openHours: true, openHoursLabel: 'Daily 10 AM–5 PM' });
    expect(matchesDate(standing, point('2026-08-16'))).toBe(true);
    expect(matchesDate(standing, point('2027-01-01'))).toBe(true);
  });
});
