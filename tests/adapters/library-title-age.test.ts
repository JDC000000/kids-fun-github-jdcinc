import { describe, it, expect } from 'vitest';
import { getLibrarySystem, parseBiblioCommonsRss, resolveBiblioCommonsAgeSignal } from '../../worker/adapters/library';
import { anchoredBareAgeWording, parseGenericRss } from '../../worker/adapters/library/generic-rss';
import { parseAgeText, parseAudienceLabels, computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';

// Unit 4 of docs/age-pattern-extraction-scope.md — §8d "library: add the title to the haystack,
// anchored", plus the anchored bare-range acceptance that goes with it.
//
// TWO DEFECTS, ONE GATE. Both library parsers ran their age regexes over the DESCRIPTION only,
// and both required the literal word `ages`/`grades` IMMEDIATELY before the number. So:
//   • an age stated only in the title never reached worker/core/age.ts at all; and
//   • an age stated in the description in any other English shape ("must be 6-12 years old",
//     "Must be 18+", "aged 4-8 years") was invisible too — at which point a broad AUDIENCE TAG
//     won by default, which is worse than silence because it publishes a confident wrong answer.
//
// GROUND TRUTH. Every feed item below is a VERBATIM capture of the live 2026-08-18 pull the
// design document measured (RPL BiblioCommons RSS, NVDPL generic RSS). Titles, `<category>`
// tags and description prose are untouched BECAUSE THE PROSE IS THE DEFECT — the sentence
// "You must be 6-12 years old by August 31st" is the exact string the old gate could not see,
// and paraphrasing it would stop reproducing the bug. Only inert boilerplate (image enclosures,
// the policy `<figure>` block, accessibility copy) is trimmed.

const RPL_RSS_LIVE_CAPTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/" version="2.0">
<channel>
<title><![CDATA[Events | Richmond Public Library]]></title>
<item><title><![CDATA[Kids' Bookmark Contest]]></title><description><![CDATA[<p>Do you love to create? Design and colour your own bookmark using the Summer Reading Club theme: Under the Sea! Then hand it in to the Kids' Place desk for a chance to win. Each winner will receive 10 copies of their bookmark to keep as well as a book prize!</p><p>You must be 6-12 years old by August 31st to participate. Each person may only enter one time this summer.</p>]]></description><link>https://yourlibrary.bibliocommons.com/events/6a2b2aa48d1b82ca9f794cbf</link><category><![CDATA[Summer Reading Club]]></category><category><![CDATA[Arts]]></category><category><![CDATA[Children-All Ages]]></category><category><![CDATA[English]]></category><bc:start_date>2026-06-24T07:00:00Z</bc:start_date><bc:is_cancelled>false</bc:is_cancelled><bc:location><bc:name>Brighouse</bc:name></bc:location></item>
<item><title><![CDATA[Richmond Reads: Summer Book Club 2026]]></title><description><![CDATA[<p>From June 24 to August 31, the community is invited to read bestselling author Robyn Harding's newest book<em> Strangers in the Villa</em>. Read on for Richmond Reads activities.</p>
<ul><li>Robyn Harding will speak about her writing and new book &#8211; July 7 from 7:00 &#8211; 8:00pm at Brighouse Library. Register early as this event will be popular!</li><li>Take part in RPL's Richmond Reads Summer Passport Challenge happening June 24- August 31. Pick up an Adult Summer Passport Challenge at any branch. Complete 3 or more mini challenges for a chance to win a gift basket. <strong>Must be 18+ to enter</strong>. This contest closes at 9pm PDT on August 31.</li><li>Visit any branch from July 2 to August 25 and enter a weekly prize draw to win additional prizes.</li></ul>]]></description><link>https://yourlibrary.bibliocommons.com/events/6a2b43eb7f943b5200520624</link><category><![CDATA[Books &amp; Reading]]></category><category><![CDATA[All Ages]]></category><category><![CDATA[English]]></category><bc:start_date>2026-06-24T07:00:00Z</bc:start_date><bc:is_cancelled>false</bc:is_cancelled><bc:location><bc:name>Brighouse</bc:name></bc:location></item>
<item><title><![CDATA[LEGO Club - Ages 8-12]]></title><description><![CDATA[<p>Join us for LEGO Club! Build with our LEGO collection and make new friends. For ages 8-12.</p>]]></description><link>https://yourlibrary.bibliocommons.com/events/6a2b43eb7f943b5200520626</link><category><![CDATA[Activities &amp; Games]]></category><category><![CDATA[Children-School Age]]></category><category><![CDATA[English]]></category><bc:start_date>2026-08-20T23:00:00Z</bc:start_date><bc:is_cancelled>false</bc:is_cancelled><bc:location><bc:name>Brighouse</bc:name></bc:location></item>
<item><title><![CDATA[Cricut Make and Take - Registered]]></title><description><![CDATA[<p>Learn to use the library's Cricut cutting machine and take home what you make.</p>]]></description><link>https://yourlibrary.bibliocommons.com/events/6a2b43eb7f943b5200520627</link><category><![CDATA[Classes &amp; Workshops]]></category><category><![CDATA[Adults]]></category><category><![CDATA[Teens]]></category><category><![CDATA[English]]></category><bc:start_date>2026-08-21T23:00:00Z</bc:start_date><bc:is_cancelled>false</bc:is_cancelled><bc:location><bc:name>Brighouse</bc:name></bc:location></item>
</channel>
</rss>`;

const NVDPL_RSS_LIVE_CAPTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>NVDPL Events</title>
<item>
  <title>Camp Parkgate Stuffy Sleepover</title>
  <link>https://nvdpl.events.mylibrary.digital/event?id=345121</link>
  <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Tue, 25 Aug 2026, 6:00pm - 7:15pm&lt;/p&gt;&lt;p&gt;Grab your favourite stuffy and join us for a camping adventure at the library! We'll gather around the 'campfire' for camping-themed stories, songs, rhymes, a tasty snack, and a fun craft.&lt;/p&gt;
&lt;p&gt;The stuffed animals will be sleeping over, the kids will not be!&lt;/p&gt;
&lt;p&gt;This program is best suited for children aged 4-8 years. Registration is required.&lt;/p&gt;</description>
  <pubDate>Mon, 17 Aug 2026 00:37:42 -0700</pubDate>
</item>
<item>
  <title>Crafternoon</title>
  <link>https://nvdpl.events.mylibrary.digital/event?id=345122</link>
  <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Wed, 26 Aug 2026, 3:00pm - 4:30pm&lt;/p&gt;&lt;p&gt;Drop in to our craft table for kids and make 10+ crafts to take home. Supplies provided while they last.&lt;/p&gt;</description>
  <pubDate>Mon, 17 Aug 2026 00:37:42 -0700</pubDate>
</item>
</channel>
</rss>`;

/** Mirror of supabase/seeds/age_bands.sql — same table as tests/ingestion/age.test.ts. */
const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

const rpl = getLibrarySystem('rpl')!;
const nvdpl = getLibrarySystem('nvdpl')!;
const rplEvents = parseBiblioCommonsRss(rpl, RPL_RSS_LIVE_CAPTURE).events;
const nvdplEvents = parseGenericRss(nvdpl, NVDPL_RSS_LIVE_CAPTURE).events;

/** Resolve an event exactly the way worker/core/ingest.ts does, and report its bands. */
function resolve(e: { ages?: string; audienceLabels?: string[] }) {
  const parse = e.audienceLabels?.length
    ? parseAudienceLabels(e.audienceLabels)
    : e.ages
      ? parseAgeText(e.ages)
      : { ageMinMonths: null, ageMaxMonths: null, resolved: false };
  return { parse, bands: computeAgeBandMatches(parse, BANDS).sort() };
}

const rplByTitle = (t: string) => rplEvents.find((e) => e.title === t)!;
const nvdplByTitle = (t: string) => nvdplEvents.find((e) => e.title === t)!;

describe('library — an age the source states outright beats a broad audience tag (§8d)', () => {
  it('RPL Kids\' Bookmark Contest: "must be 6-12 years old" beats the tag "Children-All Ages"', () => {
    const e = rplByTitle("Kids' Bookmark Contest");

    // What shipped before this unit: the obligation phrase was invisible, so the ONLY signal
    // left was the tag, and 0-15 years is not what the contest rules say.
    expect(e.audienceLabels).toBeUndefined();
    expect(e.ages).toBe('6-12 years old');

    const { parse, bands } = resolve(e);
    expect(parse).toMatchObject({ ageMinMonths: 72, ageMaxMonths: 156, resolved: true });
    expect(bands).toEqual(['10-14', '5-9']);
    // The measured before-state, pinned as the thing that must NOT come back.
    expect(parse.ageMinMonths).not.toBe(0);
    expect(bands).not.toContain('under2');
  });

  it('RPL Richmond Reads: "Must be 18+" stops an adult book club matching every age band', () => {
    // THE SAFETY-DIRECTION ROW. The tag "All Ages" resolved to [0, ∞) — all five bands — for a
    // contest whose own rules say 18+. A parent filtering to ages=under2 was offered it.
    const e = rplByTitle('Richmond Reads: Summer Book Club 2026');
    expect(e.ages).toBe('18+');

    const { parse, bands } = resolve(e);
    expect(parse).toMatchObject({ ageMinMonths: 216, ageMaxMonths: null, resolved: true });
    expect(bands).toEqual(['15+']);
    expect(bands).not.toContain('under2');
    expect(bands).not.toContain('2-4');
  });

  it('the dates and clock times all over that same description are not read as ages', () => {
    // "June 24- August 31", "7:00 - 8:00pm", "9pm PDT", "July 2 to August 25", "Complete 3 or
    // more". The anchored form has to walk past every one of them to reach "Must be 18+", and
    // AGE_NUMBER's lookarounds are what stop the clock time being eligible in the first place.
    const { parse } = resolve(rplByTitle('Richmond Reads: Summer Book Club 2026'));
    expect(parse.ageMinMonths).toBe(216);
    expect(parse.ageMaxMonths).toBeNull();
  });

  it('NVDPL Camp Parkgate Stuffy Sleepover: "aged 4-8 years" is no longer dropped entirely', () => {
    // Before: AGE_TEXT_RE needed the literal word ages/grades before the number, so this item
    // emitted NO ageText at all and produced no occurrence_age row.
    const e = nvdplByTitle('Camp Parkgate Stuffy Sleepover');
    expect(e.ages).toBe('4-8 years');
    expect(resolve(e).parse).toMatchObject({ ageMinMonths: 48, ageMaxMonths: 108, resolved: true });
    expect(resolve(e).bands).toEqual(['2-4', '5-9']);
  });

  it('a title stating an age outright is scanned — it used to be invisible', () => {
    // The title-blindness itself, isolated: same tags, same silence in the description.
    const e = rplByTitle('LEGO Club - Ages 8-12');
    expect(e.ages).toBe('Ages 8-12');
    expect(resolve(e).parse).toMatchObject({ ageMinMonths: 96, ageMaxMonths: 156 });
  });

  it('an item with no age wording anywhere still resolves on its tags, unchanged', () => {
    const e = rplByTitle('Cricut Make and Take - Registered');
    expect(e.ages).toBeUndefined();
    expect(e.audienceLabels).toEqual(['Adults', 'Teens']);
    expect(resolve(e).parse).toMatchObject({ ageMinMonths: 144, ageMaxMonths: null });
  });
});

describe('library — the anchor is what stops a quantity being published as an age', () => {
  // THE FAILURE MODE §8d NAMES BY NAME. `parseAgeText('10+ crafts')` returns [120, null]: a
  // craft-table supply count published as "ages 10 and up". An UNANCHORED bare `N+` acceptance
  // would have made that a live defect on the very feed this unit widens, so the anchor
  // requirement is not a stylistic preference — it is the thing keeping the widening safe.
  it('"make 10+ crafts" is NOT read as an age, on the real parser', () => {
    const e = nvdplByTitle('Crafternoon');
    expect(e.ages).toBeUndefined();
    expect(resolve(e)).toMatchObject({ parse: { resolved: false }, bands: [] });
  });

  it('confirms the number itself WOULD have resolved — the gate is the only thing stopping it', () => {
    expect(parseAgeText('10+ crafts')).toMatchObject({ ageMinMonths: 120, ageMaxMonths: null });
  });

  it.each([
    ['make 10+ crafts to take home', undefined],
    ['Open 9-5 daily', undefined],
    ['Enter to win 1 of 5 prizes', undefined],
    ['Runs June 24- August 31', undefined],
    ['Doors 6:00-8:00 pm', undefined],
    ['Tickets are $5+ at the door', undefined],
    ['a 10-visit, 1 month Fit Card', undefined],
    ['You must be 6-12 years old', '6-12 years old'],
    ['Must be 18+ to enter', '18+'],
    ['best suited for children aged 4-8 years', '4-8 years'],
    ['Recommended for 3-5 year olds', '3-5 year old'],
    // DELIBERATE LIMIT, asserted rather than left as a silent gap: a range whose unit sits on
    // the FIRST number ("18 months-3 years", "6 mo-5 yrs") is not accepted. §8d scoped this
    // widening to `N-M years` / `N+`, and requiring the unit on the SECOND number is precisely
    // what stops "June 24- August 31" and "1 of 5 prizes" being eligible. The mixed-unit shape
    // is real, but it is ActiveNet's (§8a) and it has ZERO occurrences on the measured library
    // corpus — so it stays out until something measures it here.
    ['for children 18 months-3 years', undefined],
  ])('anchoredBareAgeWording(%j) -> %j', (text, expected) => {
    expect(anchoredBareAgeWording(text)).toBe(expected);
  });
});

describe('library — precedence and the haystack boundary', () => {
  it('the anchored form is a FALLBACK: an explicit "ages N" phrase still wins', () => {
    // Ordering matters because both can match the same text. If the anchored form ran first it
    // could change the winner on rows that already resolve correctly; as a second attempt it can
    // only ever speak where the vetted pattern is silent.
    expect(
      resolveBiblioCommonsAgeSignal('Storytime', 'For ages 2-5. Adults must be 19+ to register.', [])
    ).toEqual({ ages: 'ages 2-5' });
  });

  it('a curated audience tag still beats a description KEYWORD — only explicit ages outrank it', () => {
    // The §8d widening is deliberately confined to the two EXPLICIT tiers. This is the
    // library-age-precedence.test.ts contract, re-asserted here so a future edit to the haystack
    // cannot quietly reopen it.
    expect(
      resolveBiblioCommonsAgeSignal('Family Storytime', 'A program for parents and caregivers with young children.', [
        'Toddlers',
      ])
    ).toEqual({ audienceLabels: ['Toddlers'] });
  });

  it('a kid word in the TITLE is not promoted to an age claim', () => {
    // Widening the keyword tier to the title would be the kid-coded-title-marker inference that
    // was measured at a 57% error rate and deleted (worker/core/title.ts). Explicit ages only.
    expect(resolveBiblioCommonsAgeSignal('Teen Movie Night', 'Popcorn provided. Drop in.', [])).toEqual({});
  });

  it('the title cannot be spliced onto the description to manufacture a range', () => {
    // The haystack joins with ". " precisely because every pattern here is bounded by [^.<\n].
    // Without the terminator, "Summer Camp 8" + "12 spaces left" reads as "8. 12" → a range.
    expect(resolveBiblioCommonsAgeSignal('Craft Camp for children 8', '12 spots left, register early.', [])).toEqual(
      {}
    );
  });
});
