import { describe, it, expect } from 'vitest';
import { audienceTagsOf, getLibrarySystem, parseBiblioCommonsRss } from '../../worker/adapters/library';
import { parseAgeText, parseAudienceLabels, computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';
import type { LibrarySystemConfig } from '../../worker/adapters/library/config';

// REGRESSION — a source's `<category>` list is NOT an audience taxonomy.
//
// The first cut of the audience-tag fix generalised from Vancouver, whose audience tags happen
// to be the only child-shaped strings it publishes, and handed the whole `<category>` list to
// the age normaliser. QA measured the consequence on live Richmond data: items came out WIDER
// than before the fix. Richmond publishes the TOPIC tag "Child Development" — it sits beside
// "Parenting" and "Literacy, Reading, Writing" — and it contains the word "child", so the
// normaliser's broad kids rule scores it 5-11. Because a tag list resolves to the UNION of its
// tags, that vote rode along on every item carrying it: RPL's own Babytime and Play & Learn,
// both genuinely 0-24 months, were published as ALSO matching 5-9 and 10-14.
//
// Under the ORIGINAL first-match-wins ordering the topic tag could never win (a real audience
// tag always resolved first), so the union is what gave it a voice it never had. The union is
// still right — it is what makes "Toddlers + Preschool" mean both — but only over tags that
// are genuinely audiences.
//
// EVERY TAG SET BELOW IS A VERBATIM LIVE CAPTURE from Richmond's BiblioCommons RSS feed
// (gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events, 2026-08-16). Descriptions are
// real too, trimmed of accessibility boilerplate. A synthetic fixture could not have caught
// this — the VPL-only fixtures did not — so these stay real on purpose.
const RPL_RSS_LIVE_CAPTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/" version="2.0">
<channel>
<title><![CDATA[Events | Richmond Public Library]]></title>
<item>
<title><![CDATA[Babytime]]></title>
<description><![CDATA[<p>Connect with your baby through rhymes, bounces, action songs and lullabies at the Ironwood Library! Meet other parents and learn new songs. For babies age 0-18 months with a caregiver. Expectant moms and dads are welcome too!</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6a21eb7d8ea300e2631b3bbf</link>
<category><![CDATA[Babytime]]></category>
<category><![CDATA[Child Development]]></category>
<category><![CDATA[Literacy, Reading, Writing]]></category>
<category><![CDATA[Parenting]]></category>
<category><![CDATA[Baby]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-18T18:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Brighouse]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Play & Learn]]></title>
<description><![CDATA[<p>Presented by Richmond Family Place: Enjoy making friends and learning songs and rhymes with your children 0-5 years old.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6970238e2c65973d0018faf9</link>
<category><![CDATA[Play & Learn]]></category>
<category><![CDATA[Child Development]]></category>
<category><![CDATA[Literacy, Reading, Writing]]></category>
<category><![CDATA[Baby]]></category>
<category><![CDATA[Children-Preschool]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-18T20:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Brighouse]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Family Storytime]]></title>
<description><![CDATA[<p>Drop in to the Steveston Branch for songs, stories, rhymes and more at family storytime in the library! A parent/caregiver must attend with the child/ren.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/693606bb6724c63d00e5c62f</link>
<category><![CDATA[Storytime]]></category>
<category><![CDATA[Child Development]]></category>
<category><![CDATA[Literacy, Reading, Writing]]></category>
<category><![CDATA[Children-Preschool]]></category>
<category><![CDATA[Families]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T17:30:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Brighouse]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Summer School Video Games at Ironwood]]></title>
<description><![CDATA[<p>Drop in to the Ironwood Branch for some fun with video games! We're beginner and family friendly! All underage children must be accompanied by a parent or guardian.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6a2b297116554cd59fc82725</link>
<category><![CDATA[Summer Reading Club]]></category>
<category><![CDATA[Digital Literacy]]></category>
<category><![CDATA[Leisure & Entertainment]]></category>
<category><![CDATA[Children-School Age]]></category>
<category><![CDATA[Families]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T23:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Brighouse]]></bc:name></bc:location>
</item>
<item>
<title><![CDATA[Chess for Fun (All Ages)]]></title>
<description><![CDATA[<p>Drop in and play a friendly game of chess. Boards provided.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6a2b2aa48d1b82ca9f794cb0</link>
<category><![CDATA[Leisure & Entertainment]]></category>
<category><![CDATA[All Ages]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-08-17T19:00:00Z</bc:start_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name><![CDATA[Brighouse]]></bc:name></bc:location>
</item>
</channel>
</rss>`;

const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

const rpl = getLibrarySystem('rpl')!;
const events = parseBiblioCommonsRss(rpl, RPL_RSS_LIVE_CAPTURE).events;
const byTitle = (t: string) => events.find((e) => e.title === t)!;

/** Resolve exactly as worker/core/ingest.ts does. */
function resolve(title: string) {
  const e = byTitle(title);
  const parse = e.audienceLabels?.length
    ? parseAudienceLabels(e.audienceLabels)
    : e.ages
      ? parseAgeText(e.ages)
      : { ageMinMonths: null, ageMaxMonths: null, resolved: false };
  return { parse, bands: computeAgeBandMatches(parse, BANDS) };
}

describe('RPL — a topic tag is not an audience tag', () => {
  it('"Child Development" is never read as an audience, on its real tag set', () => {
    // The exact live tag list, topic tag and all.
    expect(audienceTagsOf(rpl, ['Babytime', 'Child Development', 'Literacy, Reading, Writing', 'Parenting', 'Baby', 'English'])).toEqual([
      'Babytime',
      'Baby',
    ]);
    // And on its own it is a 5-11 claim, which is exactly why it had to be excluded rather
    // than relied on to "resolve to nothing".
    expect(parseAgeText('Child Development')).toMatchObject({ ageMinMonths: 60, ageMaxMonths: 144, resolved: true });
  });

  it('RPL Babytime stays 0-24 months and does NOT pick up 5-9 / 10-14', () => {
    const { bands } = resolve('Babytime');
    expect(bands).not.toContain('5-9');
    expect(bands).not.toContain('10-14');
    expect(bands).toEqual(['under2']);
  });

  it('RPL Play & Learn stays babies-to-preschool', () => {
    const { parse, bands } = resolve('Play & Learn');
    expect(parse).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 60, resolved: true });
    expect(bands).toEqual(['under2', '2-4']);
    expect(bands).not.toContain('10-14');
  });

  it('a system with no configured audience vocabulary claims no tags at all', () => {
    // The fail-safe direction: an unvetted tenant falls back to description prose rather than
    // trusting a vocabulary nobody has checked.
    const unvetted = { ...rpl, audienceTagPatterns: undefined } as LibrarySystemConfig;
    expect(audienceTagsOf(unvetted, ['Children-Preschool', 'Child Development'])).toEqual([]);
  });

  it('anchoring keeps the "Adults" audience and rejects the "Adult Summer Reading" series', () => {
    expect(audienceTagsOf(rpl, ['Adults', 'Adult Summer Reading'])).toEqual(['Adults']);
  });
});

describe('RPL — a catch-all tag must not drown a specific one', () => {
  it('"Families" beside "Children-Preschool" does not widen to every band', () => {
    const { parse, bands } = resolve('Family Storytime');
    expect(bands).toEqual(['2-4']);
    expect(bands).not.toContain('15+');
    expect(parse.notes).toBe('audience: Children-Preschool');
  });

  it('"Families" beside "Children-School Age" keeps the school-age claim', () => {
    expect(resolve('Summer School Video Games at Ironwood').bands).toEqual(['5-9', '10-14']);
  });

  it('but a source that ONLY says "All Ages" still matches every band', () => {
    // The legitimate case has to keep working — this is Richmond genuinely saying it.
    const { parse, bands } = resolve('Chess for Fun (All Ages)');
    expect(parse).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null, resolved: true });
    expect(bands).toEqual(['under2', '2-4', '5-9', '10-14', '15+']);
  });

  it('"Children-All Ages" means all CHILD ages — never the 15+ band', () => {
    // Richmond's own prefix says the audience is children; taken at face value the "all ages"
    // half wins and a kids' bookmark contest claims the teen band.
    const p = parseAudienceLabels(['Children-All Ages']);
    expect(p).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 180, resolved: true });
    expect(computeAgeBandMatches(p, BANDS)).toEqual(['under2', '2-4', '5-9', '10-14']);
  });
});

describe('audience tags union their BANDS, not their hull', () => {
  it('two disjoint tags do not claim the bands in the gap between them', () => {
    // The hull of Babies [0,24) and Adults [228,∞) is [0,∞) — every band. The true union is
    // two. `components` is what keeps them apart.
    const p = parseAudienceLabels(['Babies', 'Adults']);
    expect(computeAgeBandMatches(p, BANDS)).toEqual(['under2', '15+']);
    // The hull is still the honest DISPLAYED range for such a listing, and is kept as such.
    expect(p).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null });
  });

  it('adjacent tags still merge into one continuous span', () => {
    // The core P0 fix must be untouched by the components change.
    const p = parseAudienceLabels(['Preschool Age Children', 'Toddlers']);
    expect(p).toMatchObject({ ageMinMonths: 12, ageMaxMonths: 60 });
    expect(computeAgeBandMatches(p, BANDS)).toEqual(['under2', '2-4']);
  });

  it('["Babies","Toddlers"] no longer fabricates the 2-4 band from the hull', () => {
    // Babies [0,24) ∪ Toddlers [12,36): genuinely reaches into 2-4 (36 > 24), so this one is a
    // real overlap and 2-4 is correct — asserted so the components change is not misread as
    // "never widen".
    const p = parseAudienceLabels(['Babies', 'Toddlers']);
    expect(computeAgeBandMatches(p, BANDS)).toEqual(['under2', '2-4']);
  });

  it('a single-tag parse is byte-identical to the pre-components behaviour', () => {
    const p = parseAudienceLabels(['Teens']);
    expect(computeAgeBandMatches(p, BANDS)).toEqual(computeAgeBandMatches({ ageMinMonths: 144, ageMaxMonths: 216 }, BANDS));
  });
});
