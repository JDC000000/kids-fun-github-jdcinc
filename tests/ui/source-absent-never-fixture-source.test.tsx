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

describe('🔴 no source STATES the absence — Jon\'s copy, and it is a contract', () => {
  const html = detail({ sourceUrl: null });

  it('says "No official source listed." on the detail page', () => {
    // Approved wording (Jon, 2026-09-11). This panel is the one place a parent is reading about
    // provenance, so the absence is the answer, not a gap. Reword only with this assertion.
    expect(html).toContain('No official source listed.');
  });

  it('never names something that is not a source', () => {
    expect(html).not.toContain('Official source:');
    expect(html).not.toContain(LEAK);
  });

  it('punctuates the sentence as a sentence, not as a list item', () => {
    // "No official source listed. · Confirmed" puts a middot after a full stop. The separator
    // belongs to the segment it follows, so it leaves with it.
    expect(html).not.toContain('listed. ·');
    expect(html).toMatch(/No official source listed\.\s*Confirmed/);
  });

  it('keeps the facts that do not depend on a source', () => {
    // Status and freshness are things we DO hold without a source. Deleting them alongside the
    // source would be a much bigger loss than the defect being fixed.
    expect(html).toContain('Confirmed');
    expect(html).toContain('Checked');
    expect(html).toContain('Source &amp; freshness');
  });

  it('does not undo itself one clause later by naming "the official source" anyway', () => {
    // The confidence sentence used to render here regardless: three of its four outputs name
    // "the official source", so this paragraph could read "No official source listed. … check
    // the official source before you rely on it." Confidence is not a fact we hold WITHOUT a
    // source — it is a claim ABOUT one — so it leaves with the source claim. Tier-by-tier
    // coverage of the same rule lives in tests/ui/confidence-sentence.test.tsx.
    expect(html).not.toContain('the official source');
    expect(html).not.toContain('Verified —');
    expect(html).not.toContain('Not yet verified');
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

describe('🔴 the sentence stays on the surface it was written for', () => {
  // Deliberately NOT reused where it does not fit. The chip is a compact token run and the CTA
  // is a button label; a full sentence in either is a worse outcome than the silence.
  it('never appears inside the freshness chip', () => {
    const html = stamp({ sourceUrl: null });
    expect(html).not.toContain('No official source listed');
    expect(html).not.toContain(LEAK);
  });

  it('never appears as a card button label', () => {
    expect(card({ sourceUrl: null })).not.toContain('No official source listed');
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

describe('🔴 the share/search preview states the absence too', () => {
  it('carries Jon\'s copy instead of "Source: …" and keeps the freshness sentence', () => {
    // A share preview is read by someone deciding whether to trust the link at all, so silence
    // about provenance is the wrong shape of answer. Same copy as the detail page.
    const text = describeActivity(activity({ sourceUrl: null }));
    expect(text).toContain('No official source listed.');
    expect(text).not.toContain('Source:');
    expect(text).not.toContain(LEAK);
    expect(text).toMatch(/Checked/);
  });

  it('joins the two sentences without a stray separator or doubled stop', () => {
    const text = describeActivity(activity({ sourceUrl: null }));
    expect(text).not.toContain('listed. ·');
    expect(text).not.toContain('..');
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


// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE EMPTY ADDRESS LINE (2026-09-11, folded in on Jon's nod)
//
// `formatVenueAddress` has always promised not to render an empty line — tests/venue-address-
// display.test.ts asserts it "returns null for absent or empty input rather than an empty
// line". The component then ignored that promise: it guarded on the RAW `activity.address`,
// which is truthy for "   " or "," while the formatter reduces both to null after stripping
// comma runs and edge punctuation. Result: <p class="kf-detail__address"></p> — a reserved
// line with nothing in it, a dead gap between the venue name and the action cluster.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('🔴 an address that formats to nothing renders no line at all', () => {
  for (const addr of ['   ', ',', ' , , ', ',,']) {
    it(`${JSON.stringify(addr)} renders no empty address paragraph`, () => {
      const html = detail({ venueAddress: addr });
      expect(html).not.toContain('<p class="kf-detail__address"></p>');
      expect(html).not.toContain('kf-detail__address');
    });
  }

  it('does NOT over-apply — a real address still renders, tidied', () => {
    const html = detail({ venueAddress: '600 Hamilton St, Vancouver, British Columbia' });
    expect(html).toContain('class="kf-detail__address"');
    expect(html).toContain('600 Hamilton St, Vancouver, BC');
  });

  it('still suppresses an address that merely repeats the venue name', () => {
    // Unchanged behaviour: the repeat check reads the RAW address, as it always did.
    const html = detail({ venueName: 'Granville Street', venueAddress: 'Granville St, Vancouver, BC' });
    expect(html).not.toContain('kf-detail__address');
  });
});
