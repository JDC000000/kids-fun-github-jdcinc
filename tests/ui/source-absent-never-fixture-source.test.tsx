import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 'fixture source' IS NOT A SOURCE (2026-09-11, QA hardening)
//
// `hostLabel()` in search-api.ts derived the displayed source name by parsing the source URL,
// and its catch arm returned the literal string 'fixture source'. That arm was reachable in
// production: `source_url` is nullable (migration 0004), the admin listing form writes null for
// a blank field, and the mapper then substituted `'#'`, which `new URL()` rejects. So internal
// test vocabulary rendered to real parents — and not on one surface, on FOUR:
//
//   • the detail page's "Official source: fixture source · Confirmed · Checked today · …" line
//   • the freshness chip, which appears on EVERY card in the results list and in the detail hero
//   • the results card's call to action — a tappable "View on fixture source ↗"
//   • the description a shared or search-indexed link previews with (detail-metadata.ts)
//
// The fix is that there is now one reading of "is there a usable source here" (readSourceUrl),
// feeding both the href and the label, and every consumer drops the source CLAIM when there is
// none rather than printing a stand-in. Two separate judgements is exactly how a live button
// came to sit next to the words "fixture source".
//
// The string itself is the thing to assert on. It is short, distinctive, and if it ever reaches
// a parent again it will be because someone reintroduced a fallback — which is a decision that
// should have to delete a test.
// ═══════════════════════════════════════════════════════════════════════════════════════════

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>{children as never}</a>
  ),
}));

import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import { FreshnessStamp } from '../../app/preview/_components/FreshnessStamp';
import { describeActivity } from '../../app/preview/_data/detail-metadata';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { Activity } from '../../app/preview/_data/types';

/** The exact string that must never reach a parent on any surface. */
const LEAK = 'fixture source';
const REAL_SOURCE = 'https://vancouver.ca/parks/kits-pool';

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
    venuePhone: '(604) 555-0142', sourceUrl: REAL_SOURCE, bookingUrl: null,
    locationUrl: 'https://maps.google.com/?q=Kitsilano+Pool', ...o,
  } as ListingRecordDto;
}

const activity = (o: Partial<ListingRecordDto> = {}): Activity =>
  mapSearchItemToActivity({ distanceKm: 4.14, listing: listing(o) });

const detail = (o: Partial<ListingRecordDto> = {}) =>
  renderToStaticMarkup(
    <ActivityDetail activity={activity(o)} occurrenceId="occ-1" backHref="/search" backLabel="Back" />);

/** The card's "View on …" CTA only renders on an EXTERNAL card, which is what detailUrl means. */
const card = (o: Partial<ListingRecordDto> = {}) =>
  renderToStaticMarkup(
    <ActivityCard activity={{ ...activity(o), detailUrl: 'https://vancouver.ca/listing/1' }} />);

const stamp = (o: Partial<ListingRecordDto> = {}) =>
  renderToStaticMarkup(<FreshnessStamp activity={activity(o)} />);

/** Every shape of "no usable source URL", each of which used to fail differently. */
const NO_SOURCE: Array<[string, Partial<ListingRecordDto>]> = [
  ['null', { sourceUrl: null }],
  ['empty string', { sourceUrl: '' }],
  ['whitespace', { sourceUrl: '   ' }],
  // Stored as free text with no URL validation (admin vocab.ts -> optText), so a typed
  // "vancouver.ca" is kept verbatim and rendered as a RELATIVE href — tapping it navigated
  // inside the app to /activity/vancouver.ca. Every real adapter emits https:// (asserted in
  // tests/compliance/attribution.test.ts), so no working listing takes this arm.
  ['scheme-less host', { sourceUrl: 'vancouver.ca/parks' }],
  ['a bare word', { sourceUrl: 'tbc' }],
];

describe('🔴 the words "fixture source" never reach a parent, on any surface', () => {
  for (const [name, o] of NO_SOURCE) {
    it(`${name}: not on the detail page`, () => expect(detail(o)).not.toContain(LEAK));
    it(`${name}: not on a results card`, () => expect(card(o)).not.toContain(LEAK));
    it(`${name}: not in the freshness chip`, () => expect(stamp(o)).not.toContain(LEAK));
    it(`${name}: not in the shared-link preview`, () =>
      expect(describeActivity(activity(o))).not.toContain(LEAK));
  }
});

describe('🔴 no source drops the CLAIM, and only the claim', () => {
  const html = detail({ sourceUrl: null });

  it('drops "Official source:" rather than naming something that is not a source', () => {
    expect(html).not.toContain('Official source:');
  });

  it('keeps the three unrelated facts that share that sentence', () => {
    // Status, freshness and confidence are things we DO hold. Deleting them alongside the
    // source would be a much bigger loss than the defect being fixed.
    expect(html).toContain('Confirmed');
    expect(html).toContain('Checked');
    expect(html).toContain('Source &amp; freshness');
  });

  it('never opens the line on an orphaned separator', () => {
    expect(html).not.toMatch(/<p>\s*·/);
    expect(html).not.toContain('· ·');
    expect(html).not.toContain('·  ·');
  });
});

describe('🔴 the freshness chip closes up rather than leaving a gap', () => {
  const html = stamp({ sourceUrl: null });

  it('still states the status and the last check', () => {
    expect(html).toContain('Confirmed');
    expect(html).toContain('Checked');
  });

  it('renders no empty source span and no doubled separator', () => {
    expect(html).not.toContain('kf-stamp__src');
    expect(html).not.toContain('· ·');
    expect(html).not.toMatch(/·<\/span><span[^>]*>·/);
  });
});

describe('🔴 the results card CTA cannot be blank and cannot be fake', () => {
  it('falls back to the wording the detail page already uses for this case', () => {
    const html = card({ sourceUrl: null });
    expect(html).toContain('View official source');
    expect(html).not.toContain('View on');
  });

  it('still names the real host when there is one', () => {
    expect(card()).toContain('View on vancouver.ca');
  });
});

describe('🔴 the share/search preview drops the source half, not the checked half', () => {
  it('omits "Source:" when there is none but keeps the freshness sentence', () => {
    const text = describeActivity(activity({ sourceUrl: null }));
    expect(text).not.toContain('Source:');
    expect(text).toMatch(/Checked/);
  });

  it('still carries both when the source is real', () => {
    const text = describeActivity(activity());
    expect(text).toContain('Source: vancouver.ca');
  });
});

describe('the guard does NOT over-apply — a real source is untouched', () => {
  const html = detail();

  it('names the host, stripped of www, on the detail page', () => {
    expect(html).toContain('Official source:');
    expect(html).toContain('vancouver.ca');
  });

  it('still renders the hero source control pointing at the real URL', () => {
    expect(html).toContain('class="kf-detail__source"');
    expect(html).toContain(REAL_SOURCE);
  });

  it('strips a www. prefix but keeps the rest of the host verbatim', () => {
    expect(stamp({ sourceUrl: 'https://www.scienceworld.ca/visit' })).toContain('scienceworld.ca');
  });

  it('carries the href VERBATIM — a bug fix must not rewrite a working link', () => {
    // `new URL('https://vancouver.ca').href` gains a trailing slash. Parsing is for the LABEL;
    // the href a listing ships with is the href it keeps.
    const bare = 'https://vancouver.ca';
    const html2 = detail({ sourceUrl: bare });
    expect(html2).toContain(`href="${bare}"`);
    expect(html2).not.toContain(`href="${bare}/"`);
  });
});
