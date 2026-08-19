import { describe, it, expect } from 'vitest';
import { LibraryAdapter, getLibrarySystem, parseBiblioCommonsRss } from '../../worker/adapters/library';
import { parseAgeText, parseAudienceLabels, computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';

// P0 — "AGE DATA CORRUPTED": a source's own structured audience tags must never lose to a
// generic keyword scraped out of its description prose.
//
// GROUND TRUTH. Every item below is a VERBATIM capture of the live VPL BiblioCommons RSS feed
// (gateway.bibliocommons.com/v2/libraries/vpl/rss/events, pulled 2026-08-16) — real titles, real
// `<category>` tags, real description wording. Only the long accessibility `<ul>` boilerplate is
// trimmed, and the `<bc:location>` block is reduced to its name. The prose is untouched
// BECAUSE THE PROSE IS THE DEFECT: "…parents and caregivers with young children" is what the
// old parser resolved on, and any paraphrase would stop reproducing the bug.
//
// The measured failure this pins: Family Storytime (VPL tags it Toddlers + Preschool Age
// Children) was stored as ageMinMonths 60 / ageMaxMonths 144 and displayed "Ages 5–11",
// removing the single best toddler listing in the database from every toddler search. Babytime,
// from the SAME feed and the SAME parser, was correct — because its description happens to say
// "babies" before it says anything broader, so first-keyword-wins landed on the right word by
// luck. Correct-by-luck on one row and wrong on the next is the signature of a precedence bug,
// and both rows are asserted here so a future edit cannot fix one by breaking the other.
const VPL_RSS_LIVE_CAPTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/" version="2.0">
<channel>
<title><![CDATA[Events | Vancouver Public Library]]></title>
<item>
<title><![CDATA[Family Storytime]]></title>
<description><![CDATA[<p>A program for parents and caregivers with young children. Songs, rhymes, and stories are shared. Suitable for children of all ages and abilities to enjoy and learn together.</p> <p><strong>Accessibility Information</strong></p> <p>VPL is committed to making our programs accessible for all.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/69f14793defec6489cc0e8aa</link>
<category><![CDATA[Storytimes]]></category>
<category><![CDATA[Preschool Age Children]]></category>
<category><![CDATA[Toddlers]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T17:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Mount Pleasant Branch]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Babytime]]></title>
<description><![CDATA[<p>Rhymes, songs, bounces, fingerplays and stories for parents and caregivers with their babies. Recommended for newborns to approximately 18 months.</p> <p>VPL is committed to making our programs accessible for all.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/69f3ddae213814b1b5259fcb</link>
<category><![CDATA[Storytimes]]></category>
<category><![CDATA[Babies]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T18:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Renfrew Branch]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Crustaceous Crafts]]></title>
<description><![CDATA[<p>Create ocean-themed art and have some hands-on fun with simple crafts and activities. Please dress to get messy. Adults accompanying children under 9 must stay in the library for the duration of the program. Grades K-7. Drop-in.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/69f0fe59c1cf6f9a75886c76</link>
<category><![CDATA[Summer Reading Club]]></category>
<category><![CDATA[Activities & Games]]></category>
<category><![CDATA[School Age Children]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T21:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Central Library]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[ESL Conversation Practice]]></title>
<description><![CDATA[<p>Meet new friends and practice your English conversation skills with other English language learners. This is a supportive and casual meet-up.</p> <p>For intermediate speakers.</p> <p>Drop in.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/69f4d5121d82f930d3cb50da</link>
<category><![CDATA[ESL Conversation Practice]]></category>
<category><![CDATA[Classes & Workshops]]></category>
<category><![CDATA[Meetups]]></category>
<category><![CDATA[Adults]]></category>
<category><![CDATA[ESL Learners]]></category>
<category><![CDATA[Newcomers]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-16T18:30:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Fraserview Branch]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Chess Club]]></title>
<description><![CDATA[<p>Drop in and play a game. Boards provided.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/69f4d5121d82f930d3cb50db</link>
<category><![CDATA[Meetups]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-16T19:30:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Central Library]]></bc:name></bc:location>
</item>
</channel>
</rss>`;

// Mirror of supabase/seeds/age_bands.sql — key doubles as a readable id, same as
// tests/ingestion/age.test.ts.
const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

const vpl = getLibrarySystem('vpl')!;
const events = parseBiblioCommonsRss(vpl, VPL_RSS_LIVE_CAPTURE).events;
const byTitle = (title: string) => events.find((e) => e.title === title)!;

/** Resolve an event exactly the way worker/core/ingest.ts does, and report its bands. */
function resolve(title: string) {
  const e = byTitle(title);
  const parse = e.audienceLabels?.length
    ? parseAudienceLabels(e.audienceLabels)
    : e.ages
      ? parseAgeText(e.ages)
      : { ageMinMonths: null, ageMaxMonths: null, resolved: false };
  return { parse, bands: computeAgeBandMatches(parse, BANDS).sort() };
}

describe('BiblioCommons age precedence — structured audience tags beat description prose', () => {
  it("VPL's Family Storytime lands on toddlers/preschoolers, NOT the 5-11 the prose produced", () => {
    const { parse, bands } = resolve('Family Storytime');

    // The measured regression, stated as the exact numbers that were stored.
    expect(parse.ageMinMonths).not.toBe(60);
    expect(parse.ageMaxMonths).not.toBe(144);
    expect(bands).not.toContain('10-14');

    // Union of the source's two audience tags: Toddlers [12,36) ∪ Preschool [36,60).
    expect(parse).toMatchObject({ ageMinMonths: 12, ageMaxMonths: 60, resolved: true });
    expect(bands).toEqual(['2-4', 'under2']);
    // Provenance names the tags it used, so a reviewer can see WHICH claim was believed.
    expect(parse.notes).toBe('audience: Preschool Age Children, Toddlers');
  });

  it('a two-year-old is no longer filtered out of the one programme built for her', () => {
    // The whole point of the fix, expressed the way the search filter asks the question.
    expect(resolve('Family Storytime').bands).toContain('2-4');
  });

  it('the prose "suitable for children of all ages" does NOT override the audience tags', () => {
    // The description literally contains "all ages" — a welcome statement, not an audience
    // claim. Believing it would have swung this row to [0, ∞) and matched every band, which is
    // the OTHER way this listing can be wrong. The tags are the curated claim; they win.
    const { bands } = resolve('Family Storytime');
    expect(bands).not.toContain('15+');
    expect(bands).toHaveLength(2);
  });

  it('Babytime — correct before the fix, still correct after it', () => {
    const { parse, bands } = resolve('Babytime');
    expect(parse).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 24, resolved: true });
    expect(bands).toEqual(['under2']);
  });

  it('an explicit range in the description still outranks a broader audience tag', () => {
    // "Grades K-7" is the source stating ages outright and is strictly more precise than its
    // own "School Age Children" tag ([60,144)). Precision wins; the tags are the fallback, not
    // a ceiling.
    const e = byTitle('Crustaceous Crafts');
    expect(e.audienceLabels).toBeUndefined();
    expect(e.ages).toBe('Grades K-7');
    expect(resolve('Crustaceous Crafts').parse).toMatchObject({
      ageMinMonths: 60,
      ageMaxMonths: 156,
      resolved: true,
    });
  });

  it('an Adults-tagged programme resolves to adults, so it cannot surface under ?age=under2', () => {
    // 228, not 216: an "Adults" TAG resolves to BC's age of majority (19y), the same floor
    // lib/search/filters/audience.ts's ADULT_ONLY_AGE_MIN_MONTHS uses. The two used to
    // disagree by a year, so a tag-derived adult listing sat above the ingest floor and below
    // the search one. The claim under test is unchanged — this tag is never `under2`.
    const { parse, bands } = resolve('ESL Conversation Practice');
    expect(parse).toMatchObject({ ageMinMonths: 228, ageMaxMonths: null, resolved: true });
    expect(bands).toEqual(['15+']);
    expect(bands).not.toContain('under2');
  });

  it('an item whose source says NOTHING about age claims nothing — no placeholder wording', () => {
    // WAS `ages: 'See event details'`, which parsed as "wording present but unresolvable" and
    // pushed parse_quality.ageResolved from null (no claim) to false (failed parse), quietly
    // penalising confidence for the source's silence. Absent data must stay absent.
    const e = byTitle('Chess Club');
    expect(e.ages).toBeUndefined();
    expect(e.audienceLabels).toBeUndefined();
    expect(resolve('Chess Club')).toMatchObject({
      parse: { ageMinMonths: null, ageMaxMonths: null, resolved: false },
      bands: [],
    });
  });

  it('forwards exactly one age signal per record to StructuredRecord', () => {
    const records = new LibraryAdapter(vpl).extract(events);
    for (const r of records) {
      expect(Boolean(r.ageText) && Boolean(r.ageAudienceLabels)).toBe(false);
    }
    // Only the AUDIENCE tags are forwarded, not the raw `<category>` mixture. This assertion
    // used to expect the unfiltered list including "Storytimes" and "English"; that was the
    // behaviour QA measured as a live regression on Richmond, where the topic tag "Child
    // Development" rode the union and widened 0-24-month programmes to 5-11. Vancouver never
    // showed it, which is exactly why the contract is now "vetted tags only" rather than
    // "harmless tags resolve to nothing". See tests/adapters/library-rpl-audience-tags.test.ts.
    const storytime = records.find((r) => r.title === 'Family Storytime')!;
    expect(storytime.ageAudienceLabels).toEqual(['Preschool Age Children', 'Toddlers']);
  });
});
