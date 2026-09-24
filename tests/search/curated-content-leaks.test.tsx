import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Pool } from 'pg';

// Beta-readiness QA, 2026-09-24: three leaks on the operator-curated "annual events & evergreen
// venues" import, all visible on live Halloween / Christmas searches.
//
//   A. A venue-less (citywide / multi-site) row printed the INGESTION SOURCE'S internal label —
//      "Operator manual research — annual events & evergreen venues (2026-09)" — as its venue on
//      the card, the detail page and the browser tab. Cause: rowToListing fell back to
//      `source.name` when the row had no venue.
//   B. Every curated row's detail page printed our internal reviewer rationale as
//      "From the source: …". Cause: the import wrote `age_band_rationale` into
//      occurrence_age.age_notes, whose contract is a verbatim quotation of the source.
//   C. Single-day curated rows printed "10 AM–10 AM". Cause: end = NULL, which the mapper sends
//      as the start, and formatWhen printed start–start.
//
// Each case is driven through the REAL read model (rowToListing via loadPostgresListingById), the
// real mapper and the real components — the rows below are copied from production.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>{children as never}</a>
  ),
}));

import { loadPostgresListingById } from '../../lib/search/postgres-repository';
import { mapListingRecordToActivity } from '../../app/preview/_data/search-api';
import { formatWhen, formatVenue, VENUE_NOT_STATED } from '../../app/preview/_data/format';
import { activityTitle, buildDetailMetadata } from '../../app/preview/_data/detail-metadata';
import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { renderWeeklyDigest } from '../../lib/email/render';
import type { WeeklyDigest } from '../../lib/email/digest';

const CURATED_SOURCE = 'Operator manual research — annual events & evergreen venues (2026-09)';
const RATIONALE =
  "Costumed fun-run with a short kids' distance and a stroller-friendly course - strong for 5-9s, babies score low.";

type Row = Record<string, unknown>;

/** Production row "Big Halloween Run" (9ad6112e-…), venue-less, end NULL, manual tier. */
function curatedRow(o: Row = {}): Row {
  return {
    id: '9ad6112e-bd45-4ffc-9d4c-355088f43ba9',
    series_id: '10000000-0000-4000-8000-000000000009',
    activity_name: 'Big Halloween Run',
    primary_category_key: 'festival_event',
    tag_keys: [],
    venue_name: null,
    venue_address: null,
    source_name: CURATED_SOURCE,
    series_title: 'Big Halloween Run',
    source_authority_tier: 'manual',
    description_snippet: 'Costumed fun-run.',
    start_datetime_utc: '2026-10-30T17:00:00.000Z', // 10 AM Vancouver — the import's default clock
    end_datetime_utc: null,
    open_hours_state: null,
    cost_status: 'check_source',
    cost_min_cad: null,
    cost_max_cad: null,
    source_url: 'https://example.org/big-halloween-run',
    booking_url: null,
    location_url: null,
    registration_required: null,
    status_state: 'confirmed',
    confidence_label: 'high',
    last_checked_at: '2026-09-20T17:00:00.000Z',
    age_min_months: 24,
    age_max_months: 179,
    age_notes: RATIONALE,
    age_band_keys: ['2-4', '5-9', '10-14'],
    lat: null,
    lng: null,
    municipality_id: null,
    neighbourhood: null,
    display_area: null,
    phone: null,
    ...o,
  };
}

function poolReturning(row: Row): Pool {
  return { query: async () => ({ rows: [row] }) } as unknown as Pool;
}

async function load(row: Row) {
  const listing = await loadPostgresListingById(poolReturning(row), String(row.id));
  if (!listing) throw new Error('fixture row did not load');
  return listing;
}

const renderDetail = (a: ReturnType<typeof mapListingRecordToActivity>) =>
  renderToStaticMarkup(<ActivityDetail activity={a} occurrenceId={a.id} backHref="/search" backLabel="Back" />);

describe('A — a venue-less row never prints the ingestion source label as its venue', () => {
  it('read model: no venue → empty venueName, never the source name', async () => {
    const listing = await load(curatedRow());
    expect(listing.venueName).toBe('');
    // The source name is still the (internal) organisation — only the venue fallback changed.
    expect(listing.organisation).toBe(CURATED_SOURCE);
  });

  it('applies to every source, not just the curated one', async () => {
    const listing = await load(curatedRow({ source_authority_tier: 'official', source_name: 'AssessRun Quiet Source c1ff0839' }));
    expect(listing.venueName).toBe('');
  });

  it('keeps a real venue, and still reads one out of a "Title — Venue" series title', async () => {
    expect((await load(curatedRow({ venue_name: 'Stanley Park' }))).venueName).toBe('Stanley Park');
    expect((await load(curatedRow({ series_title: 'Toddler Open Gym — Bonsor Recreation Complex' }))).venueName).toBe(
      'Bonsor Recreation Complex',
    );
  });

  it('card, detail subtitle, page title and share metadata never carry the label', async () => {
    const activity = mapListingRecordToActivity(await load(curatedRow()));
    const card = renderToStaticMarkup(<ActivityCard activity={activity} />);
    const detail = renderDetail(activity);
    const meta = buildDetailMetadata(activity, activity.id);
    const surfaces = [card, detail, activityTitle(activity), JSON.stringify(meta)];
    for (const s of surfaces) {
      expect(s).not.toContain('Operator manual research');
      expect(s).not.toContain('evergreen venues');
    }
    expect(card).toContain(`<h3 class="kf-card__title">${VENUE_NOT_STATED}</h3>`);
    expect(detail).toContain(`<p class="kf-detail__place">${VENUE_NOT_STATED}</p>`);
    expect(activityTitle(activity)).toBe('Big Halloween Run · KIDS FUN');
  });

  it('a real venue still reads "{activity} — {venue}" in the title', async () => {
    const activity = mapListingRecordToActivity(await load(curatedRow({ venue_name: 'Stanley Park' })));
    expect(activityTitle(activity)).toBe('Big Halloween Run — Stanley Park · KIDS FUN');
    expect(renderToStaticMarkup(<ActivityCard activity={activity} />)).toContain('<h3 class="kf-card__title">Stanley Park</h3>');
  });

  it('formatVenue states the absence and passes a real name through', () => {
    expect(formatVenue('')).toBe(VENUE_NOT_STATED);
    expect(formatVenue('   ')).toBe(VENUE_NOT_STATED);
    expect(formatVenue(null)).toBe(VENUE_NOT_STATED);
    expect(formatVenue('Science World')).toBe('Science World');
  });

  it('the digest email omits an unknown venue rather than printing a blank or a label', async () => {
    const listing = await load(curatedRow());
    const digest: WeeklyDigest = {
      userId: 'u1',
      totalActivities: 1,
      emptySearches: [],
      shouldSend: true,
      sections: [
        {
          savedSearchId: 's1',
          label: 'Halloween',
          searchUrl: 'https://app.example/search?q=halloween',
          activities: [
            { id: listing.id, seriesId: listing.seriesId, name: listing.activityName, venue: listing.venueName, when: 'Fri, Oct 30', cost: 'Check source', url: 'https://app.example/a' },
          ],
        },
      ],
    };
    const { text, html } = renderWeeklyDigest(digest, { unsubscribeUrl: 'https://app.example/u' });
    expect(text).toContain('  • Big Halloween Run\n');
    expect(text).not.toContain('Big Halloween Run — ');
    // No empty venue line: the <br /> that followed the venue is gone with it.
    expect(html).not.toMatch(/margin-top:4px;">\s*<br \/>/);
  });
});

describe('B — operator-authored age rationale is never presented as the source’s words', () => {
  it('read model: a manual-tier source carries no ageNotes', async () => {
    expect((await load(curatedRow())).ageNotes).toBeNull();
  });

  it('a real source’s age notes still pass through verbatim', async () => {
    const listing = await load(curatedRow({ source_authority_tier: 'official', age_notes: ' Ages 0-5 with a caregiver ' }));
    expect(listing.ageNotes).toBe('Ages 0-5 with a caregiver');
  });

  it('the detail page renders no "From the source" line and none of the rationale', async () => {
    const detail = renderDetail(mapListingRecordToActivity(await load(curatedRow())));
    expect(detail).not.toContain('From the source');
    expect(detail).not.toContain('babies score low');
  });

  it('a real source’s note is still quoted on the detail page', async () => {
    const detail = renderDetail(
      mapListingRecordToActivity(await load(curatedRow({ source_authority_tier: 'official', age_notes: 'Swim Safe ratio: children under 6 must be within arm’s reach.' }))),
    );
    expect(detail).toContain('From the source: Swim Safe ratio');
  });
});

describe('C — a missing or zero-length end never prints "X–X"', () => {
  it('formatWhen: missing end, equal end and backwards end all say "See listing for times"', () => {
    const start = '2026-10-30T17:00:00.000Z';
    for (const end of [null, start, '2026-06-01T00:00:00.000Z']) {
      const when = formatWhen(start, end);
      expect(when.day).toBe('Fri, Oct 30');
      expect(when.time).toBe('See listing for times');
    }
  });

  it('a real single-day range is unchanged', () => {
    expect(formatWhen('2026-10-30T17:00:00.000Z', '2026-10-30T19:30:00.000Z').time).toBe('10 AM–12:30 PM');
  });

  it('the card and detail page for the production row show no "10 AM–10 AM"', async () => {
    const activity = mapListingRecordToActivity(await load(curatedRow()));
    const card = renderToStaticMarkup(<ActivityCard activity={activity} />);
    const detail = renderDetail(activity);
    for (const s of [card, detail]) {
      expect(s).not.toMatch(/10 AM–10 AM/);
      expect(s).toContain('See listing for times');
    }
  });
});

describe('D — operator research is never "Verified — confirmed directly by the official source"', () => {
  // Same class as B: a false claim about where the content came from. confidence() mapped a
  // manual-tier row's own 'high' label to 'official' (122 curated rows in production).
  const OFFICIAL_CLAIM = 'confirmed directly by the official source';

  it('read model: a manual-tier row is capped at editorial / inferred, whatever its own label says', async () => {
    expect((await load(curatedRow({ confidence_label: 'high' }))).confidenceLabel).toBe('editorial');
    expect((await load(curatedRow({ confidence_label: 'medium' }))).confidenceLabel).toBe('editorial');
    expect((await load(curatedRow({ confidence_label: 'low' }))).confidenceLabel).toBe('inferred');
    expect((await load(curatedRow({ confidence_label: null }))).confidenceLabel).toBe('inferred');
    // Fresh check date must not promote it either (the official_recent arm is official-only).
    expect((await load(curatedRow({ confidence_label: 'high', last_checked_at: new Date().toISOString() }))).confidenceLabel).toBe('editorial');
  });

  it('the detail page makes no official-source verification claim for a manual-tier row', async () => {
    const detail = renderDetail(mapListingRecordToActivity(await load(curatedRow({ confidence_label: 'high' }))));
    expect(detail).not.toContain(OFFICIAL_CLAIM);
    expect(detail).toContain('not directly confirmed by the venue or organiser');
  });

  it('an official source is unchanged', async () => {
    expect((await load(curatedRow({ source_authority_tier: 'official', confidence_label: 'high', last_checked_at: '2020-01-01T00:00:00.000Z' }))).confidenceLabel).toBe('official');
    const detail = renderDetail(
      mapListingRecordToActivity(await load(curatedRow({ source_authority_tier: 'official', confidence_label: 'high', last_checked_at: '2020-01-01T00:00:00.000Z' }))),
    );
    expect(detail).toContain(OFFICIAL_CLAIM);
  });

  it('other non-official tiers keep their existing mapping (out of scope, pinned so a change is deliberate)', async () => {
    expect((await load(curatedRow({ source_authority_tier: 'partner', confidence_label: 'high' }))).confidenceLabel).toBe('official');
    expect((await load(curatedRow({ source_authority_tier: 'editorial', confidence_label: 'medium' }))).confidenceLabel).toBe('editorial');
  });
});
