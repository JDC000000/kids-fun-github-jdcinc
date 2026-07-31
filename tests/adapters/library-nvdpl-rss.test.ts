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

describe('NVDPL generic_rss — run health', () => {
  const diagnostics = (over: Record<string, unknown> = {}) => ({
    itemsInFeed: 97, emitted: 46, nonEventNotices: 1, multiDayRanges: 1,
    unparseableDateTime: 0, notKidRelevant: 49, malformedItems: 0, truncatedByLimit: false,
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

  it('ALERTS when liveEventsLimit truncated the run', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics({ truncatedByLimit: true }))).toMatchObject({
      code: 'truncated_by_limit', alert: true,
    });
  });

  it('every verdict states the tally, so a thin run is diagnosable without a re-pull', () => {
    expect(assessGenericRssRun(nvdpl(), diagnostics()).detail).toContain('46 emitted of 97 feed items');
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
