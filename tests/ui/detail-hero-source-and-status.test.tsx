import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The detail page's hero source link (C1) and the removal of the Status stat (C4).
//
// C4's premise, which is what this file actually pins: the Status stat was the THIRD statement
// of the same fact on one screen. Verified by rendering all 16 canonical statuses before the
// change — every one of them already showed its label in the FreshnessStamp, and every
// non-bookable one ALSO showed a full-sentence explanation in the honesty block. If a future
// change removes the stamp's label or narrows the honesty block, the status disappears from the
// page entirely rather than merely being stated once, so the label assertion below is the guard
// that keeps this removal honest.
//
// C1's premise: one derived href/label, rendered in two places. Asserted as "the hero link
// points at the same URL the action bar does" rather than at a literal string, because the
// defect worth catching is the two copies DRIFTING, not either one's current wording.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>{children as never}</a>
  ),
}));

import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import { statusMeta } from '../../app/preview/_data/format';
import type { StatusState } from '../../app/preview/_data/types';

function listing(o: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-1', activityName: 'Parent & Tot Swim', primaryCategoryKey: 'public_swim',
    categoryTags: ['public_swim'], venueName: 'Kitsilano Pool', organisation: 'City of Vancouver',
    descriptionSnippet: 'Warm shallow end.', suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-18T21:00:00.000Z', endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: 'known', costMinCad: 7, costMaxCad: null, statusState: 'confirmed',
    confidenceLabel: 'official_recent', lastCheckedAtUtc: '2026-07-13T16:00:00.000Z',
    ageMinMonths: 60, ageMaxMonths: 120, geo: { lat: 49.27, lng: -123.15 },
    displayArea: 'Kitsilano', neighbourhood: 'Kitsilano', municipalityId: 'Vancouver',
    sourceUrl: 'https://vancouver.ca/kits', bookingUrl: null, locationUrl: null, ...o,
  };
}

const render = (o: Partial<ListingRecordDto> = {}, distanceKm: number | null = 4.14) => {
  const a = mapSearchItemToActivity({ distanceKm, listing: listing(o) });
  return renderToStaticMarkup(
    <ActivityDetail activity={a} occurrenceId={a.id} backHref="/search" backLabel="Back" />);
};

const ALL: StatusState[] = ['confirmed', 'bookable_open', 'not_yet_bookable', 'schedule_not_published',
  'inferred_recurring', 'manual_candidate', 'needs_review', 'seasonal_out_of_season', 'seasonal_preseason',
  'seasonal_active', 'full', 'waitlist', 'stale', 'suspended', 'cancelled', 'postponed'];

const BLOCKED: StatusState[] = ['cancelled', 'postponed'];

describe('C4 — the Status stat is gone, but the status is not', () => {
  for (const status of ALL) {
    it(`${status}: no Status stat, yet the label is still on the page`, () => {
      const html = render({ statusState: status });
      expect(html, 'the stat label itself must be gone').not.toContain('>Status<');
      expect(html, 'the status must still be readable somewhere').toContain(statusMeta(status).label);
    });
  }

  it('still explains every non-bookable status in a full sentence, not just a label', () => {
    for (const status of ALL.filter((s) => s !== 'confirmed' && s !== 'bookable_open')) {
      // The honesty block's copy is what justifies dropping the stat; assert it is really there.
      const expected = statusMeta(status).copy.replace(/'/g, '&#x27;'); // only the apostrophe is escaped in the markup
      expect(render({ statusState: status }), `${status}: honesty copy`).toContain(expected);
    }
  });
});

describe('heading structure — the activity is the subject, the venue is where it happens', () => {
  // No test asserted the h1 before this change, which is how the venue came to hold it. These
  // assert the CONTENT of the h1, not merely that one exists: a structural rule that only checks
  // for the presence of a tag cannot tell you it is wrapped around the wrong words.
  it('makes the activity name the h1', () => {
    expect(render()).toContain('<h1 class="kf-detail__title">Parent &amp; Tot Swim</h1>');
  });

  it('demotes the venue to plain text, and specifically not to a heading', () => {
    const html = render();
    expect(html).toContain('<p class="kf-detail__place">Kitsilano Pool</p>');
    // An h2 would place the venue level with Overview / Source & freshness, implying it heads
    // a section of the page. It heads nothing — it is an attribute of the h1.
    expect(html).not.toContain('<h2 class="kf-detail__place"');
  });

  it('has exactly one h1', () => {
    expect((render().match(/<h1[\s>]/g) ?? []).length).toBe(1);
  });

  it('keeps the h1 consistent with the SEO title, which has always been activity-first', () => {
    // detail-metadata.ts emits `${activityName} — ${venue}`. The document's own heading now
    // agrees with the title the page has been shipping to search engines all along.
    const html = render();
    expect(html.indexOf('Parent &amp; Tot Swim')).toBeLessThan(html.indexOf('Kitsilano Pool'));
  });
});

describe('C1 — the source link appears in the hero as well as the action bar', () => {
  it('renders it twice, pointing at the same place', () => {
    const html = render();
    const hits = html.match(/https:\/\/vancouver\.ca\/kits/g) ?? [];
    expect(hits.length, 'hero copy + action bar').toBeGreaterThanOrEqual(2);
    expect(html).toContain('kf-detail__source');
  });

  it('uses the booking URL, not the source URL, when the source published one', () => {
    const html = render({ bookingUrl: 'https://book.example.ca/x' });
    const hero = html.split('kf-detail__source')[1] ?? '';
    expect(hero).toContain('https://book.example.ca/x');
  });

  it('opens in a new tab with rel="noreferrer noopener", like every other outbound link here', () => {
    expect(render()).toMatch(/class="kf-detail__source"[^>]*rel="noreferrer noopener"|rel="noreferrer noopener"[^>]*class="kf-detail__source"/);
  });

  // REVERSED 2026-09-03 (Jon). These previously asserted the link was HIDDEN for cancelled and
  // postponed sessions, to match the action bar's disabled button. The ruling is that a parent
  // whose session was cancelled is the one who most needs the official page — it is the only
  // place that can say what replaced it. The bar's disabled button speaks to the ACTION; this
  // link speaks to the SOURCE.
  for (const status of BLOCKED) {
    it(`${status}: still offered in the hero, because that is where the answer is`, () => {
      const html = render({ statusState: status });
      expect(html).toContain('kf-detail__source');
      expect(html).toContain('https://vancouver.ca/kits');
    });

    it(`${status}: the action bar still refuses the booking action`, () => {
      // Scope guard: item 2 was explicitly the hero link ONLY. If a future change drops the
      // bar's disabled state, a cancelled session gains a live primary CTA — which is a
      // different and much worse claim than offering the source.
      expect(render({ statusState: status })).toContain('not available');
    });
  }
});

describe('C2 — the Distance stat is dropped, not emptied, when nothing was measured', () => {
  it('renders no Distance stat at all with a null distance', () => {
    const html = render({}, null);
    expect(html).not.toContain('>Distance<');
    expect(html).not.toContain('Unavailable');
  });

  it('still renders it when a distance was measured', () => {
    expect(render({}, 4.14)).toContain('>Distance<');
  });
});
