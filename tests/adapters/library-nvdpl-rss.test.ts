import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryAdapter, getLibrarySystem } from '../../worker/adapters/library';
import {
  GENERIC_RSS_FIXTURE_XML,
  assessGenericRssRun,
  classifyKidRelevance,
  parseDateTimeRange,
  parseGenericRss,
  resolveLocation,
} from '../../worker/adapters/library/generic-rss';
import { stripHtml } from '../../worker/adapters/library/rss-text';
import { clearPolicyState } from '../../worker/health/policy';

// NVDPL (North Vancouver District Public Library) — the library family's 4th tenant and
// its only `generic_rss` platform. Decision record D-12, 2026-07-31.
//
// Every fixture in this file is a byte-faithful slice of the REAL feed captured
// 2026-07-31 (97 items), except where a case is explicitly marked SYNTHETIC because the
// shape it exercises does not occur in that pull but is a realistic drift.

const nvdpl = () => getLibrarySystem('nvdpl')!;

/** Wrap items in the real channel envelope so the parser sees what the feed sends. */
function feed(...itemsXml: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
${itemsXml.join('\n')}
</channel></rss>`;
}

function item(title: string, descriptionEscapedHtml: string, id = '900001', pubDate?: string): string {
  return `<item>
  <title>${title}</title>
  <link>https://nvdpl.events.mylibrary.digital/event?id=${id}</link>
  <guid isPermaLink="true">https://nvdpl.events.mylibrary.digital/event?id=${id}</guid>
  <description>${descriptionEscapedHtml}</description>
  <pubDate>${pubDate ?? 'Wed, 20 May 2026 16:14:59 -0700'}</pubDate>
</item>`;
}

/** The feed's real description shape: entity-escaped HTML, Date/Time in a leading <p>. */
function description(dateTime: string, body = 'Songs and rhymes. Best for infants, 0 -12 months.'): string {
  return `&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; ${dateTime}&lt;/p&gt;&lt;p&gt;${body}&lt;/p&gt;`;
}

describe('NVDPL generic_rss — free-text Date/Time parser (trap 1)', () => {
  it('parses the single-date shape the feed uses on 96 of 97 items', () => {
    expect(parseDateTimeRange('Tue, 4 Aug 2026, 10:30am - 11:00am')).toEqual({
      startLocal: '2026-08-04T10:30',
      endLocal: '2026-08-04T11:00',
      spansMultipleDates: false,
    });
  });

  it('handles the 12-hour boundary in both directions', () => {
    // 12:xxpm is NOON (12:xx), 12:xxam is MIDNIGHT (00:xx). Getting either backwards
    // shifts a listing by 12 hours while still looking like a valid time.
    expect(parseDateTimeRange('Sat, 1 Aug 2026, 11:30am - 12:30pm')).toMatchObject({
      startLocal: '2026-08-01T11:30',
      endLocal: '2026-08-01T12:30',
    });
    // SYNTHETIC: a midnight-start item does not occur in the captured pull.
    expect(parseDateTimeRange('Sat, 1 Aug 2026, 12:15am - 1:00am')).toMatchObject({
      startLocal: '2026-08-01T00:15',
      endLocal: '2026-08-01T01:00',
    });
  });

  it('parses the MULTI-DAY shape and flags it (trap 6 — the scoping pass missed this)', () => {
    // The real outlier: `Kindergarten Book Bags`. The scoping pass reported the shape as
    // 100% uniform; it is 96/97, and this is the 97th.
    expect(parseDateTimeRange('Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm')).toEqual({
      startLocal: '2026-08-24T10:00',
      endLocal: '2026-08-29T17:00',
      spansMultipleDates: true,
    });
  });

  it('rolls a midnight-crossing end onto the NEXT local day', () => {
    // SYNTHETIC shape, real hazard: without this the end would land BEFORE the start.
    expect(parseDateTimeRange('Fri, 7 Aug 2026, 11:00pm - 1:00am')).toEqual({
      startLocal: '2026-08-07T23:00',
      endLocal: '2026-08-08T01:00',
      spansMultipleDates: false,
    });
  });

  it('rolls midnight-crossing across a month boundary', () => {
    expect(parseDateTimeRange('Mon, 31 Aug 2026, 11:30pm - 12:30am')).toMatchObject({
      startLocal: '2026-08-31T23:30',
      endLocal: '2026-09-01T00:30',
    });
  });

  it('accepts long month names and en/em dashes (cheap drift tolerance)', () => {
    expect(parseDateTimeRange('Tue, 4 August 2026, 10:30am – 11:00am')).toMatchObject({
      startLocal: '2026-08-04T10:30',
      endLocal: '2026-08-04T11:00',
    });
  });

  it('returns undefined rather than guessing on anything it cannot parse', () => {
    for (const bad of [
      '',
      'Ongoing',
      'Tue, 4 Aug 2026',                         // no times at all
      'Tue, 4 Aug 2026, 10:30am',                // no end
      'Tue, 32 Aug 2026, 10:30am - 11:00am',     // impossible day
      'Tue, 31 Feb 2026, 10:30am - 11:00am',     // Date.UTC would ROLL THIS OVER to 3 Mar
      'Tue, 4 Xxx 2026, 10:30am - 11:00am',      // unknown month
      'Tue, 4 Aug 2026, 13:30pm - 2:00pm',       // hour out of 12-hour range
      'Tue, 4 Aug 2026, 10:30 - 11:00',          // no meridiem
    ]) {
      expect(parseDateTimeRange(bad), `must reject: ${bad || '(empty)'}`).toBeUndefined();
    }
  });
});

describe('NVDPL generic_rss — DST-correct local→UTC conversion (trap 3)', () => {
  it('applies PDT (-07:00) for a summer event', () => {
    const { events } = parseGenericRss(nvdpl(), feed(item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am'))));
    expect(events).toHaveLength(1);
    // 10:30 PDT = 17:30Z. Reading the wall clock as UTC would have published 03:30 local.
    expect(events[0].startsAt).toBe('2026-08-04T17:30:00.000Z');
    expect(events[0].endsAt).toBe('2026-08-04T18:00:00.000Z');
  });

  it('applies PST (-08:00) for a winter event — one shared DST-aware converter, not a fixed offset', () => {
    const { events } = parseGenericRss(
      nvdpl(),
      feed(item('Family Storytime', description('Wed, 14 Jan 2026, 10:30am - 11:00am')))
    );
    // 10:30 PST = 18:30Z. A hardcoded -7 would have produced 17:30Z here.
    expect(events[0].startsAt).toBe('2026-01-14T18:30:00.000Z');
  });
});

describe('NVDPL generic_rss — pubDate is NOT the event date (trap 2)', () => {
  it('takes the date from description and keeps pubDate as provenance only', () => {
    // Real values: this item's pubDate is 20 May for a 4 Aug event. Measured across the
    // whole live pull, 96 of 97 items disagree this way.
    const { events } = parseGenericRss(
      nvdpl(),
      feed(item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am'), '343348', 'Wed, 20 May 2026 16:14:59 -0700'))
    );
    expect(events[0].startsAt).toBe('2026-08-04T17:30:00.000Z');
    expect(events[0].startsAt).not.toContain('2026-05');
    expect(events[0].pubDate).toBe('Wed, 20 May 2026 16:14:59 -0700');
  });

  it('an item with NO parseable description date is dropped, NOT back-filled from pubDate', () => {
    // The whole trap in one assertion: pubDate is present and parseable, so a lenient
    // implementation would happily emit a May date for an event with no stated time.
    const { events, diagnostics } = parseGenericRss(
      nvdpl(),
      feed(item('Babytime', '&lt;p&gt;Songs for babies, ages 0-2. Drop in anytime.&lt;/p&gt;'))
    );
    expect(events).toHaveLength(0);
    expect(diagnostics.unparseableDateTime).toBe(1);
  });

  it('the emitted record carries no field derived from pubDate', () => {
    const adapter = new LibraryAdapter(nvdpl());
    const [record] = adapter.extract(
      parseGenericRss(nvdpl(), feed(item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am')))).events
    );
    expect(record.startDatetimeUtc).toBe('2026-08-04T17:30:00.000Z');
    expect(record.endDatetimeUtc).toBe('2026-08-04T18:00:00.000Z');
  });
});

describe('NVDPL generic_rss — venue resolution from the payload alone (trap 4)', () => {
  it('resolves from the feed’s own trailing ADDRESS BLOCK when present', () => {
    // Real: 4 of 97 items append `<p>street</p><p>city, BC</p><p>postal</p>`.
    const descriptionHtml =
      '&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Wed, 5 Aug 2026, 10:30am - 11:00am&lt;/p&gt;' +
      '&lt;p&gt;Stories under the trees. Suitable for little ones, up to 5 years old.&lt;/p&gt;' +
      '&lt;p&gt;2510 Viewlynn Dr&lt;/p&gt;&lt;p&gt;North Vancouver, BC&lt;/p&gt;&lt;p&gt;V7J 2X3&lt;/p&gt;';
    const { events } = parseGenericRss(nvdpl(), feed(item('Viewlynn Park Storytime', descriptionHtml)));
    expect(events[0].venueResolvedFrom).toBe('address_block');
    expect(events[0].venueName).toBe('Viewlynn Park');
    expect(events[0].location?.address).toBe('2510 Viewlynn Dr, North Vancouver, BC V7J 2X3');
    expect(events[0].location?.municipalityName).toBe('North Vancouver');
  });

  it('resolves from a curated location named in the TITLE', () => {
    const { events } = parseGenericRss(
      nvdpl(),
      feed(item('Summer Fun at Parkgate Library: LEGO Build-a-thon!', description('Mon, 17 Aug 2026, 3:00pm - 4:30pm', 'For kids ages 5-12.')))
    );
    expect(events[0].venueResolvedFrom).toBe('title');
    expect(events[0].venueName).toBe('Parkgate Library');
    expect(events[0].location?.municipalityName).toBe('North Vancouver');
  });

  it('falls back to a curated location named in the DESCRIPTION prose', () => {
    // Real prose: "Join us at Parkgate Library to enjoy movement-based songs…".
    const { events } = parseGenericRss(
      nvdpl(),
      feed(item('Toddlertime', description('Fri, 7 Aug 2026, 10:30am - 11:00am', 'Join us at Parkgate Library for songs and rhymes for 1 &amp;amp; 2 year-olds.')))
    );
    expect(events[0].venueResolvedFrom).toBe('description');
    expect(events[0].venueName).toBe('Parkgate Library');
  });

  it('prefers the LONGEST curated match, so a specific branch beats a bare neighbourhood', () => {
    const resolved = resolveLocation(nvdpl(), 'Storytime at Lynn Valley Library', '', 'Storytime at Lynn Valley Library');
    expect(resolved.venueName).toBe('Lynn Valley Library');
  });

  it('DEGRADES GRACEFULLY when no venue is named — no geo, no crash, no fabricated guess', () => {
    const { events } = parseGenericRss(
      nvdpl(),
      feed(item('Family Storytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am', 'Stories, rhymes and songs for the whole family! All ages.')))
    );
    expect(events).toHaveLength(1);
    expect(events[0].venueResolvedFrom).toBe('unresolved');
    // The system itself is the venue: true, and not a guess at which branch.
    expect(events[0].venueName).toBe('North Vancouver District Public Library');
    expect(events[0].location).toBeUndefined();

    const [record] = new LibraryAdapter(nvdpl()).extract(events);
    expect(record.venueLat).toBeUndefined();
    expect(record.venueLng).toBeUndefined();
    expect(record.venueAddress).toBeUndefined();
    expect(record.locationUrl).toBeUndefined();
  });

  it('NEVER emits coordinates a curated entry does not carry', () => {
    // The curated NVDPL branches are deliberately geo-less (see config.ts). If someone
    // later adds coordinates from memory rather than a verified dataset, that is a
    // fabrication — this asserts the current, honest state so the change is visible.
    const { events } = parseGenericRss(nvdpl(), GENERIC_RSS_FIXTURE_XML);
    for (const event of events) {
      expect(event.location?.lat, `${event.title} must not carry an unverified lat`).toBeUndefined();
      expect(event.location?.lng, `${event.title} must not carry an unverified lng`).toBeUndefined();
    }
  });
});

describe('NVDPL generic_rss — kid-relevance classification (trap 5)', () => {
  it('admits kid programming on a TITLE signal', () => {
    for (const title of [
      'Babytime', 'Baby Social', 'Family Storytime', 'Toddlertime', 'Tween Tuesday!',
      'Teen Crafternoon', 'Ballet Storytime with Tutu School', 'Family Bubble Dance Party',
      'Viewlynn Park Storytime', 'Creative Math Lab Series', 'Try It: Tinkercad for Kids',
      'Summer Fun at Parkgate: LEGO Build-a-thon!', 'Kindergarten Book Bags',
    ]) {
      expect(classifyKidRelevance(title, ''), title).toEqual({ kidRelevant: true, signal: 'title' });
    }
  });

  it('admits an all-ages item on a DESCRIPTION signal when the title is neutral', () => {
    // Real: "Drop-In Chess" qualifies via "Players of all ages", NOT via the word chess —
    // `chess` is deliberately absent from the title vocabulary.
    expect(classifyKidRelevance('Drop-In Chess', 'Players of all ages and skill levels are welcome.')).toEqual({
      kidRelevant: true,
      signal: 'description',
    });
    expect(classifyKidRelevance('Koala Koders: Scratch', 'For ages 9-11.')).toMatchObject({ kidRelevant: true });
  });

  it('rejects the adult programming that actually appears in this feed', () => {
    const adultProgramming: Array<[string, string]> = [
      ['Pins and Needles', 'Pins & Needles welcomes needle workers of all kinds! Gather at the Library for knitting, crocheting, sewing or other fibre arts.'],
      ['Tech Café - Capilano (Drop-In)', 'Bring your device and your questions for one-on-one tech help.'],
      ['Philosophy Gym', 'A MOOC-style presentation on the big philosophical questions of our lives. Do you crave discussions deeper than is tolerated by friends and family?'],
      ['NVDPL Writer’s Group', 'A group for local writers to share work in progress.'],
      ['Discover: 3D Printing', 'An introduction to NVDPL’s 3D printing service.'],
      ['Open Door Community Hub Drop-In', 'A welcoming, drop-in space for people to gather and connect with other members of the community.'],
    ];
    for (const [title, body] of adultProgramming) {
      expect(classifyKidRelevance(title, body), title).toMatchObject({ kidRelevant: false });
    }
  });

  it('the word "family" in adult prose does not admit an adult item', () => {
    // Philosophy Gym's real description contains "friends and family". A naive
    // description-side `family` match would have swept it in.
    expect(classifyKidRelevance('Philosophy Gym', 'discussions deeper than is tolerated by friends and family')).toEqual({
      kidRelevant: false,
      reason: 'no_kid_signal',
    });
  });

  it('REJECTS the adult "Summer Reading Rave" series (QA F-A regression)', () => {
    // 5 real occurrences were being emitted as kid programming — and then CITED in the
    // compliance doc as evidence the classifier had improved. `summer reading` is a kid
    // token in the title vocabulary and a title match short-circuits, so the adult
    // description was never consulted. Verbatim descriptions from the live feed.
    const raves: Array<[string, string]> = [
      ['Summer Reading Rave at Parkgate',
       'Step away from the noise and join us for a different kind of rave. Bring your current read, grab a mocktail and snack, and enjoy dedicated offline reading time at the library in a cozy, low-key atmosphere.'],
      ['Summer Reading Rave at Seylynn Park',
       'Bring your current read, grab a drink and a snack, and enjoy dedicated offline reading time and fresh air with other adults at Seylynn Park.'],
      ['Summer Reading Rave at Caffè Artigiano',
       'Bring your current read, grab a coffee and a snack, and enjoy dedicated offline reading time and fresh air with other adults at Caffè Artigiano Edgemont.'],
      ['Summer Reading Rave: After Hours at Parkgate Library',
       'Join us in the library "after dark"! Bring your current read, grab a mocktail and snack, and enjoy dedicated offline reading time with other adults after the library doors close for the day.'],
      ['Summer Reading Rave: After Hours at Lynn Valley Library',
       'Join us in the library "after dark"! Bring your current read, grab a mocktail and snack, and enjoy dedicated offline reading time with other adults after the library doors close for the day.'],
    ];
    for (const [title, body] of raves) {
      expect(classifyKidRelevance(title, body), title).toEqual({
        kidRelevant: false,
        reason: 'adult_only',
      });
    }
  });

  it('KEEPS the genuinely-kid "Summer Reading CLUB Celebration" items (no over-correction)', () => {
    // The discriminator has to be narrow: these are medal ceremonies for children who read
    // 50 days. A blanket "summer reading" veto would have thrown them out with the Raves.
    for (const [title, body] of [
      ['Capilano Library Summer Reading Club Celebration',
       'Have you completed your 50 days of reading for Summer Reading Club? If so, you’re invited to our celebration of reading! Join us at Capilano Library for a medal presentation with music and activities to follow.'],
      ['Family Fun Day and Lynn Valley Library Summer Reading Club Celebration',
       'Our medal ceremony will be held in the Lynn Valley Plaza as a part of Family Fun Day. Join us for the medal ceremony, music, activities, and fun!'],
    ] as Array<[string, string]>) {
      expect(classifyKidRelevance(title, body), title).toMatchObject({ kidRelevant: true });
    }
  });

  it('does not veto an after-hours KID event — "after hours" is not an adult discriminator', () => {
    // Camp Parkgate Stuffy Sleepover is a real after-hours event FOR CHILDREN. This is why
    // `after hours` / `after dark` were rejected as markers in favour of "with other
    // adults" / "mocktail".
    expect(
      classifyKidRelevance('Camp Parkgate Stuffy Sleepover',
        'Grab your favourite stuffy and join us for a camping adventure at the library! Camping-themed stories, songs, rhymes, a tasty snack, and a fun craft. Your stuffy will stay behind for a special sleepover.')
    ).toMatchObject({ kidRelevant: true });
  });

  it('an explicit adults-only marker VETOES an otherwise family-sounding item', () => {
    expect(classifyKidRelevance('Family History Workshop (55+)', 'Bring your family tree. Ages 55+.')).toEqual({
      kidRelevant: false,
      reason: 'adult_only',
    });
  });

  it('rejects a service NOTICE that carries a perfectly valid Date/Time', () => {
    // `Library Closure: BC Day` — real, and the trap: valid date, valid time, not an event.
    expect(
      classifyKidRelevance('Library Closure: BC Day', 'All locations of the library are closed today in observance of the BC Day statutory holiday.')
    ).toEqual({ kidRelevant: false, reason: 'non_event_notice' });
  });

  it('does not ingest the whole feed as if it were all kid programming', () => {
    // The fixture is a real 4-item slice: 2 kid, 1 adult, 1 closure notice.
    const { events, diagnostics } = parseGenericRss(nvdpl(), GENERIC_RSS_FIXTURE_XML);
    expect(diagnostics.itemsInFeed).toBe(4);
    expect(events.map((e) => e.title)).toEqual(['Babytime', 'Viewlynn Park Storytime']);
    expect(diagnostics.emitted).toBe(2);
    expect(diagnostics.notKidRelevant).toBe(1);
    expect(diagnostics.nonEventNotices).toBe(1);
  });
});

describe('NVDPL generic_rss — records, ids and dedup', () => {
  it('maps a kid item to a StructuredRecord with a source link and no invented fields', () => {
    const adapter = new LibraryAdapter(nvdpl());
    const { events } = parseGenericRss(nvdpl(), GENERIC_RSS_FIXTURE_XML);
    const [babytime] = adapter.extract(events);
    expect(babytime).toMatchObject({
      sourceRecordId: '343348',
      title: 'Babytime',
      venueName: 'Lynn Valley Library',
      venueMunicipalityName: 'North Vancouver',
      startDatetimeUtc: '2026-08-04T17:30:00.000Z',
      endDatetimeUtc: '2026-08-04T18:00:00.000Z',
      costStatus: 'free',
      categoryHint: 'storytime',
      sourceUrl: 'https://nvdpl.events.mylibrary.digital/event?id=343348',
    });
    expect(babytime.ageText).toMatch(/0 -12 months/);
    // The feed exposes no registration field, so none is asserted.
    expect(babytime.bookingUrl).toBeUndefined();
  });

  it('derives the source record id from the link’s ?id= query, not the path', () => {
    const { events } = parseGenericRss(nvdpl(), GENERIC_RSS_FIXTURE_XML);
    expect(events.map((e) => e.id)).toEqual(['343348', '345306']);
  });

  it('builds a stable per-system dedup key', () => {
    const adapter = new LibraryAdapter(nvdpl());
    const [record] = adapter.extract(parseGenericRss(nvdpl(), GENERIC_RSS_FIXTURE_XML).events);
    expect(adapter.dedupKeys(record)).toEqual({ key: 'library::nvdpl::343348' });
  });

  it('skips structurally unusable items instead of throwing', () => {
    const { events, diagnostics } = parseGenericRss(
      nvdpl(),
      feed('<item><description>no title, no link</description></item>', item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am')))
    );
    expect(diagnostics.malformedItems).toBe(1);
    expect(events).toHaveLength(1);
  });
});

describe('NVDPL generic_rss — multi-day ranges are excluded and COUNTED, not silently dropped', () => {
  it('excludes the multi-day item from records but reports it', () => {
    const { events, diagnostics } = parseGenericRss(
      nvdpl(),
      feed(item('Kindergarten Book Bags', description('Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm', 'For incoming kindergarteners only.')))
    );
    // A 6-day span is a registration window, not a drop-in occurrence.
    expect(events).toHaveLength(0);
    expect(diagnostics.multiDayRanges).toBe(1);
    // And it is NOT miscounted as a parse failure — the parser understood it fine.
    expect(diagnostics.unparseableDateTime).toBe(0);
  });
});

describe('NVDPL generic_rss — the diagnostics buckets ACCOUNT FOR EVERY ITEM', () => {
  // THE INVARIANT, and why it is a test rather than a comment: the buckets exist so that
  // "why did a 97-item feed yield 41 records?" is answerable off the health board without
  // re-pulling the feed. That only holds if every non-emitted item lands in exactly ONE
  // bucket. It briefly did NOT hold — an earlier revision recorded truncation as a boolean
  // and counted the dropped items nowhere, so the buckets silently failed to reconcile in
  // precisely the case where the missing number mattered most. Asserted across limits so
  // the truncating and non-truncating paths are both covered.
  const bucketSum = (d: Record<string, number | boolean>) =>
    (d.emitted as number) + (d.nonEventNotices as number) + (d.multiDayRanges as number) +
    (d.unparseableDateTime as number) + (d.notKidRelevant as number) +
    (d.malformedItems as number) + (d.droppedByLimit as number);

  const MIXED_FEED = feed(
    item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am'), '1'),
    item('Family Storytime', description('Wed, 5 Aug 2026, 10:30am - 11:00am'), '2'),
    item('Toddlertime', description('Thu, 6 Aug 2026, 10:30am - 11:00am'), '3'),
    item('Pins and Needles', description('Tue, 4 Aug 2026, 1:00pm - 2:00pm', 'Fibre arts for needle workers.'), '4'),
    item('Library Closure: BC Day', description('Mon, 3 Aug 2026, 10:00am - 6:00pm', 'All locations closed.'), '5'),
    item('Kindergarten Book Bags', description('Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm', 'Incoming kindergarteners.'), '6'),
    item('Babytime', '&lt;p&gt;No date at all, ages 0-2.&lt;/p&gt;', '7'),
    '<item><description>no title, no link</description></item>'
  );

  for (const limit of [1, 2, 3, 60]) {
    it(`reconciles to itemsInFeed at liveEventsLimit=${limit}`, () => {
      const system = { ...nvdpl(), liveEventsLimit: limit };
      const { events, diagnostics } = parseGenericRss(system, MIXED_FEED);
      expect(
        bucketSum(diagnostics as unknown as Record<string, number>),
        `buckets must account for all ${diagnostics.itemsInFeed} items: ${JSON.stringify(diagnostics)}`
      ).toBe(diagnostics.itemsInFeed);
      // And the limit is genuinely enforced, not merely reported.
      expect(events.length).toBeLessThanOrEqual(limit);
      expect(diagnostics.emitted).toBe(events.length);
    });
  }

  it('counts the items truncation actually cost, rather than only that it happened', () => {
    const { diagnostics } = parseGenericRss({ ...nvdpl(), liveEventsLimit: 1 }, MIXED_FEED);
    // 3 kid items are emittable (Babytime, Family Storytime, Toddlertime); 1 emits, 2 are lost.
    expect(diagnostics.emitted).toBe(1);
    expect(diagnostics.droppedByLimit).toBe(2);
  });

  it('drops NOTHING to the limit when the feed fits', () => {
    const { diagnostics } = parseGenericRss({ ...nvdpl(), liveEventsLimit: 60 }, MIXED_FEED);
    expect(diagnostics.droppedByLimit).toBe(0);
    expect(diagnostics.emitted).toBe(3);
  });
});

describe('NVDPL generic_rss — run health', () => {
  const diagnostics = (over: Record<string, unknown> = {}) => ({
    itemsInFeed: 97, emitted: 41, nonEventNotices: 1, multiDayRanges: 1,
    unparseableDateTime: 0, notKidRelevant: 54, malformedItems: 0, droppedByLimit: 0,
    ...over,
  });

  it('passes on the real measured shape', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics())).toMatchObject({ code: 'ok', alert: false });
  });

  it('ALERTS on an empty feed', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics({ itemsInFeed: 0, emitted: 0 }))).toMatchObject({
      code: 'empty_feed', alert: true,
    });
  });

  it('ALERTS when a non-empty feed yields zero kid records — the green-run-over-nothing case', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics({ emitted: 0 }))).toMatchObject({
      code: 'yield_collapse', alert: true,
    });
  });

  it('ALERTS when the free-text date stops parsing — the shape-drift canary', () => {
    // This is the way this adapter will actually break: the vendor rewords one string and
    // the source degrades to a low record count while still answering 200.
    expect(assessGenericRssRun(nvdpl(), diagnostics({ unparseableDateTime: 40 }))).toMatchObject({
      code: 'date_shape_drift', alert: true,
    });
  });

  it('does NOT alert when liveEventsLimit dropped records, but still says how many', () => {
    // The `truncated_by_limit` ALERT is deleted family-wide — see the deletion note in
    // worker/adapters/library/run-health.ts. It was inverted: a cap below vendor supply drops
    // records on every HEALTHY run (alert forever) and drops none on a genuinely short one
    // (silent when it matters). Via CLEAN_SUCCESS_RUN_SQL a permanent alert also means the
    // source never records a clean success and `last_success_at` never advances.
    // The COUNT survives — it is still tallied, still reconciles, still on the line.
    const verdict = assessGenericRssRun(nvdpl(), diagnostics({ droppedByLimit: 12 }));
    expect(verdict).toMatchObject({ code: 'ok', alert: false });
    expect(verdict.detail, 'the count is still reported').toContain('12 over limit');
  });

  it('every verdict states the tally, so a thin run is diagnosable without a re-pull', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics()).detail).toContain('41 emitted of 97 feed items');
  });

  it('ALERTS on a PARTIAL yield collapse against the trailing baseline (live runs only)', () => {
    // The realistic failure for a free-text source: yield falls 46 -> 5 while the feed still
    // answers 200 and emitted > 0, so every absolute-zero check passes it as green.
    const verdict = assessGenericRssRun(nvdpl(), diagnostics({ emitted: 5 }), 41, true);
    expect(verdict).toMatchObject({ code: 'yield_collapse', alert: true });
    expect(verdict.detail).toContain('trailing baseline 41');
  });

  it('does NOT alert when a live run is merely a bit thinner than baseline', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics({ emitted: 36 }), 41, true)).toMatchObject({
      code: 'ok', alert: false,
    });
  });

  it('a FIXTURE run is never compared to a live baseline — the false-alert trap', () => {
    // 2 fixture records against a live baseline of 41 is a 95% "collapse". Comparing them
    // would fire on every fixture run, i.e. the default posture and every CI run.
    expect(
      assessGenericRssRun(nvdpl(), diagnostics({ itemsInFeed: 4, emitted: 2, notKidRelevant: 1, nonEventNotices: 1, multiDayRanges: 0 }), 41, false)
    ).toMatchObject({ code: 'ok', alert: false });
  });

  it('a first run (no baseline) does not alert', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics({ emitted: 3 }), null, true)).toMatchObject({
      code: 'ok', alert: false,
    });
  });

  it('a FIXTURE run stays quiet even when the runner hands it a live baseline', async () => {
    // NOTE ON THIS TEST'S SCOPE (QA finding G-1): this asserts the fixture path only. It
    // CANNOT prove the adapter forwards the baseline — `{code:'ok'}` is the right answer
    // whether the argument is forwarded or dropped, so this expectation holds identically
    // under the original bug. It was previously named as though it proved pass-through,
    // which promised more than it delivered. The forwarding guarantee is proved by
    // 'a LIVE run below baseline alerts THROUGH the adapter' below.
    const adapter = new LibraryAdapter(nvdpl());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(41)).toMatchObject({ code: 'ok', alert: false });
  });

  it('the adapter reports health after a fixture run too, not only a live one', async () => {
    const adapter = new LibraryAdapter(nvdpl());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun()).toMatchObject({ code: 'ok', alert: false });
  });

  it('non-generic_rss platforms report no verdict rather than inventing one', async () => {
    const vpl = new LibraryAdapter(getLibrarySystem('vpl')!);
    vpl.extract(await vpl.fetch());
    expect(vpl.assessRun()).toBeNull();
  });
});

describe('NVDPL generic_rss — assessRun forwards the baseline AT THE ADAPTER BOUNDARY (QA G-1)', () => {
  // WHY THIS TEST EXISTS, and why the 68 tests before it were not enough.
  //
  // The `assessRun` baseline fix was correct end-to-end, but reintroducing the exact original
  // defect — `assessGenericRssRun(system, diagnostics)`, dropping the baseline and liveness
  // arguments — left the ENTIRE suite green. QA proved that with a revert mutation, and this
  // stream reproduced it independently before closing the gap: 68/68 still passed.
  //
  // The reason is a real testing trap worth naming: every other assessRun call in this file
  // goes through the FIXTURE path, where `live: false` means the baseline can never change
  // the verdict — `ok` is correct whether the argument is forwarded or thrown away. The
  // collapse logic itself was well covered, but only as a PURE FUNCTION invoked directly with
  // explicit arguments. The defect lived in the adapter's WIRING, and no test crossed it.
  //
  // So this test drives the LIVE path through the adapter and asserts an alert that is only
  // reachable if the baseline actually arrives. Same shape as the F-B gap: the fix was real,
  // the guard was missing.

  /** A live feed small enough that its yield collapses against a baseline of 41. */
  const SMALL_LIVE_FEED = feed(
    item('Babytime', description('Tue, 4 Aug 2026, 10:30am - 11:00am'), '1'),
    item('Family Storytime', description('Wed, 5 Aug 2026, 10:30am - 11:00am'), '2'),
    item('Toddlertime', description('Thu, 6 Aug 2026, 10:30am - 11:00am'), '3'),
    item('Tween Tuesday!', description('Fri, 7 Aug 2026, 3:30pm - 4:30pm'), '4'),
    item('Drop-In Chess', description('Sat, 8 Aug 2026, 1:00pm - 2:00pm', 'Players of all ages welcome.'), '5')
  );

  beforeEach(() => {
    // Reset the shared per-source rate-limit clock. politeFetch enforces a 3s floor per
    // source, so without this each test in this block waits it out — ~12s of pure CI idle
    // for four tests. Same reason tests/compliance/no-bypass.test.ts clears it.
    clearPolicyState();
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'nvdpl';
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(SMALL_LIVE_FEED, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      })) as unknown as typeof fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  it('a LIVE run below baseline alerts THROUGH the adapter — assessRun must forward the baseline', async () => {
    const adapter = new LibraryAdapter(nvdpl());
    const records = adapter.extract(await adapter.fetch());
    expect(records, '5 kid items emitted on the live path').toHaveLength(5);
    // 5 records against a trailing baseline of 41 is an 88% drop. This is the assertion the
    // original bug cannot satisfy: drop the baseline and the verdict is a cheerful 'ok'.
    expect(adapter.assessRun(41)).toMatchObject({ code: 'yield_collapse', alert: true });
  });

  it('the same LIVE run is healthy against a baseline it does NOT collapse against', async () => {
    // Guards the other direction: the alert must come from the comparison, not from merely
    // being a live run with few records.
    const adapter = new LibraryAdapter(nvdpl());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(6)).toMatchObject({ code: 'ok', alert: false });
  });

  it('a LIVE run with NO baseline (first run) does not alert through the adapter', async () => {
    const adapter = new LibraryAdapter(nvdpl());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(null)).toMatchObject({ code: 'ok', alert: false });
  });

  it('the adapter reports LIVE-ness, not fixture-ness, after a live fetch', async () => {
    // The liveness flag is the other half of what the bug dropped: a live run misreported as
    // a fixture run would also skip the baseline comparison and pass green.
    const adapter = new LibraryAdapter(nvdpl());
    adapter.extract(await adapter.fetch());
    const verdict = adapter.assessRun(41)!;
    expect(verdict.detail).toContain('trailing baseline 41');
  });
});

describe('NVDPL generic_rss — the triple gate (live enablement is not this adapter’s call)', () => {
  beforeEach(() => {
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  it('is OFF by default and makes ZERO network calls', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new LibraryAdapter(nvdpl());
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    const records = adapter.extract(await adapter.fetch());
    expect(spy).not.toHaveBeenCalled();
    // Fixture-only still yields real, shaped records — the same parser, no network.
    expect(records.map((r) => r.title)).toEqual(['Babytime', 'Viewlynn Park Storytime']);
  });

  it('stays OFF when a DIFFERENT system is named in the env allow-list', () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl,rpl';
    expect(new LibraryAdapter(nvdpl()).isLiveFetchEnabled()).toBe(false);
  });

  it('turns on only when nvdpl is named explicitly', () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl,nvdpl';
    expect(new LibraryAdapter(nvdpl()).isLiveFetchEnabled()).toBe(true);
  });

  it('a system without liveCapable can NEVER go live, even if the env names it', () => {
    // The Aquarium-shaped guarantee, now expressible in this family: Coquitlam has no
    // reviewed live path, so naming it is not enough.
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'cpl';
    expect(new LibraryAdapter(getLibrarySystem('cpl')!).isLiveFetchEnabled()).toBe(false);
  });

  it('the pre-existing bibliocommons gate is unchanged by the liveCapable refactor', () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl,rpl';
    expect(new LibraryAdapter(getLibrarySystem('vpl')!).isLiveFetchEnabled()).toBe(true);
    expect(new LibraryAdapter(getLibrarySystem('rpl')!).isLiveFetchEnabled()).toBe(true);
  });

  it('when live, fetches the RSS feed and parses real-shaped items', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'nvdpl';
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: async () => GENERIC_RSS_FIXTURE_XML,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LibraryAdapter(nvdpl());
    const records = adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://nvdpl.events.mylibrary.digital/rss');
    expect(records).toHaveLength(2);
    expect(records[0].startDatetimeUtc).toBe('2026-08-04T17:30:00.000Z');
  });

  it('a non-200 response fails the run rather than yielding a silent zero', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'nvdpl';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, statusText: 'Forbidden', headers: new Headers(), text: async () => '',
    })));
    await expect(new LibraryAdapter(nvdpl()).fetch()).rejects.toThrow(/403/);
  });
});

describe('NVDPL generic_rss — the config entry itself', () => {
  it('is registered as the family’s 4th tenant on its own source family', () => {
    const system = nvdpl();
    expect(system.platform).toBe('generic_rss');
    expect(system.sourceFamily).toBe('library_generic_rss');
    expect(system.sourceName).toBe('North Vancouver District Public Library Events RSS');
    expect(system.rssEventsUrl).toBe('https://nvdpl.events.mylibrary.digital/rss');
  });

  it('caps the per-run emit count', () => {
    expect(nvdpl().liveEventsLimit).toBeGreaterThan(0);
  });

  it('carries curated North Vancouver locations and NO unverified coordinates', () => {
    const locations = Object.values(nvdpl().branchLocations ?? {});
    expect(locations.length).toBeGreaterThan(0);
    for (const location of locations) {
      expect(location.municipalityName).toBe('North Vancouver');
      expect(location.lat).toBeUndefined();
      expect(location.lng).toBeUndefined();
    }
  });
});

describe('rss-text stripHtml — entity decoding is PINNED (QA F-B)', () => {
  // QA proved this fix was unpinned by deleting all six named-entity replacements plus both
  // numeric-character-ref replacements: the full 1274-test suite still passed. The fix was
  // real (a raw `&ndash;` was reaching an ageText field) but nothing held it in place. These
  // assertions are per-entity-class deliberately, so deleting any ONE replacement fails.
  it('decodes each named entity the feed actually emits', () => {
    for (const [raw, want] of [
      ['&nbsp;', ''],            // collapses to whitespace, then trims
      ['a&ndash;b', 'a–b'],
      ['a&mdash;b', 'a—b'],
      ['it&rsquo;s', 'it’s'],
      ['&lsquo;x&rsquo;', '‘x’'],
      ['&ldquo;x&rdquo;', '“x”'],
      ['a&amp;b', 'a&b'],
      ['it&#39;s', "it's"],
      ['say &quot;hi&quot;', 'say "hi"'],
    ] as Array<[string, string]>) {
      expect(stripHtml(raw), `stripHtml(${raw})`).toBe(want);
    }
  });

  it('decodes DECIMAL and HEX numeric character references', () => {
    expect(stripHtml('caf&#233;')).toBe('café');       // decimal
    expect(stripHtml('caf&#xe9;')).toBe('café');       // hex, lowercase x
    expect(stripHtml('caf&#XE9;')).toBe('café');       // hex, uppercase X
    expect(stripHtml('5 &#8211; 10')).toBe('5 – 10');  // the &ndash; codepoint, numerically
  });

  it('leaves an out-of-range numeric reference verbatim rather than corrupting it', () => {
    // Above the BMP bound the helper deliberately declines, so a malformed reference stays
    // visible as data instead of becoming a replacement character.
    expect(stripHtml('&#99999999;')).toBe('&#99999999;');
  });

  it('normalises a literal U+00A0 as well as the entity', () => {
    expect(stripHtml('a b')).toBe('a b');
  });

  it('strips markup and script/style content', () => {
    expect(stripHtml('<p>hi</p><script>evil()</script><style>x{}</style>')).toBe('hi');
  });

  it('regression: the real ageText that leaked a raw entity now reads cleanly', () => {
    // Verbatim from the live feed's "Baby Social" description.
    expect(stripHtml('For 0 &ndash; 18-month-old babies and their caregivers')).toBe(
      'For 0 – 18-month-old babies and their caregivers'
    );
  });
});
