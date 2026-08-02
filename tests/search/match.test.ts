// tests/search/match.test.ts — Weighted tsquery + trigram matcher (G-T16-3).

import { describe, it, expect } from 'vitest';
import { WeightedTrigramMatcher, sharesInflectionalStem, MIN_PREFIX_QUERY_LENGTH } from '../../lib/search/match';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { FIXTURE_LISTINGS } from '../../lib/search/__fixtures__/listings';
import { similarity, withinOneEdit, typoSimilarity, MIN_FUZZY_QUERY_LENGTH } from '../../lib/search/text/trigram';

const resolver = new FixtureAliasResolver(ALIAS_SEED);
const matcher = new WeightedTrigramMatcher();

function listing(
  id: string,
  activityName: string,
  primaryCategoryKey: string,
  venueName: string,
  descriptionSnippet: string
) {
  return {
    ...FIXTURE_LISTINGS[0],
    id,
    seriesId: `${id}-series`,
    activityName,
    primaryCategoryKey,
    categoryTags: [],
    suitabilityTags: [],
    venueName,
    // Deliberately NOT "Vancouver Parks" — a shared organisation containing "park" would
    // make every listing a legitimate "pa" prefix hit and hide what these cases measure.
    organisation: 'City of Vancouver',
    descriptionSnippet,
  };
}

/**
 * The catalogue this defect was reported against is far larger than FIXTURE_LISTINGS, and
 * that size is exactly why it was invisible locally: five listings have no colliding
 * prefixes. These carry the vocabulary from the live report — "park"/"party" for the
 * "parade" collision, plus "swim", "storytime", "open gym" — so the regression is
 * reproducible without a database.
 */
const COLLISION_LISTINGS = [
  listing('l-swim', 'Public Swim', 'public_swim', 'Hillcrest Pool', 'Family swim session.'),
  listing('l-storytime', 'Family Storytime', 'storytime', 'Kitsilano Library', 'Stories and songs.'),
  listing('l-park', 'Nature Walk', 'outdoor_park', 'Stanley Park', 'A walk outdoors.'),
  listing('l-party', 'Birthday Party Room', 'class_program', 'Kerrisdale Centre', 'Party bookings.'),
  listing('l-gym', 'Open Gym Drop-In', 'open_gym', 'Britannia Centre', 'Family gym time.'),
];

/** Ids a single free-text term returns against a listing set (no aliases, no filters). */
function idsFor(term: string, listings = COLLISION_LISTINGS): string[] {
  return matcher
    .match(resolver.expand([term]), listings)
    .sort((a, b) => b.relevance - a.relevance)
    .map((c) => c.listing.id);
}

describe('trigram similarity (pg_trgm-compatible)', () => {
  it('scores "opengym" vs "open" above the default threshold', () => {
    expect(similarity('opengym', 'open')).toBeGreaterThanOrEqual(0.3);
  });

  // The raw pg_trgm numbers the fix had to work around — pinned so a future reader can see
  // WHY tuning the threshold was never going to be enough, without recomputing them.
  it('shows raw similarity cannot separate an inflection from trailing junk', () => {
    expect(similarity('swim', 'swimming')).toBeCloseTo(0.4, 3);
    expect(similarity('swim', 'swimxyz')).toBeCloseTo(0.444, 3);
    // The nonsense pair scores HIGHER than the real one: no cutoff exists between them.
    expect(similarity('swim', 'swimxyz')).toBeGreaterThan(similarity('swim', 'swimming'));
    // And a shared opening alone clears the 0.3 threshold at any query length.
    expect(similarity('pa', 'park')).toBeCloseTo(0.333, 3);
    expect(similarity('parade', 'park')).toBeCloseTo(0.333, 3);
  });
});

describe('coincidence guard (lib/search/text/trigram)', () => {
  it('measures single edits, including adjacent transpositions', () => {
    expect(withinOneEdit('soccor', 'soccer')).toBe(true); // substitution
    expect(withinOneEdit('gymm', 'gym')).toBe(true); // insertion
    expect(withinOneEdit('siwm', 'swim')).toBe(true); // transposition
    expect(withinOneEdit('parade', 'park')).toBe(false);
    expect(withinOneEdit('swimxyz', 'swim')).toBe(false);
    expect(withinOneEdit('storytimezz', 'storytime')).toBe(false);
  });

  it('keeps genuine misspellings fuzzy-matchable', () => {
    expect(typoSimilarity('libary', 'library')).toBeGreaterThan(0);
    expect(typoSimilarity('soccor', 'soccer')).toBeGreaterThan(0);
    expect(typoSimilarity('gymm', 'gym')).toBeGreaterThan(0);
    expect(typoSimilarity('swiming', 'swimming')).toBeGreaterThan(0);
  });

  /**
   * An honest limitation, pinned so nobody "fixes" it by loosening the threshold. A
   * transposition inside a short word destroys almost every trigram — siwm and swim share
   * only "  s" — so pg_trgm cannot see the resemblance no matter how the guard is written.
   * The edit bound accepts the pair; the similarity floor is what turns it down.
   */
  it('cannot rescue a transposition in a short word, and does not pretend to', () => {
    expect(withinOneEdit('siwm', 'swim')).toBe(true);
    expect(similarity('siwm', 'swim')).toBeLessThan(0.3);
    expect(typoSimilarity('siwm', 'swim')).toBe(0);
  });

  it('refuses overlap at the START of a word when the pair is more than one edit apart', () => {
    expect(typoSimilarity('parade', 'park')).toBe(0);
    expect(typoSimilarity('parade', 'party')).toBe(0);
    expect(typoSimilarity('swimxyz', 'swim')).toBe(0);
    expect(typoSimilarity('storytimezz', 'storytime')).toBe(0);
  });

  /**
   * QA re-verify of the first revision: the guard was originally stated over the common
   * PREFIX, which is where the bug was reported rather than where it lives. A shared ENDING
   * collides just as readily, and "swimmer" was reaching Summer Reading Club through it.
   * These pin the guard as a whole-word question so that asymmetry cannot come back.
   */
  it('refuses overlap at the END of a word on the same terms', () => {
    expect(similarity('swimmer', 'summer')).toBeGreaterThanOrEqual(0.3); // raw score still clears
    expect(typoSimilarity('swimmer', 'summer')).toBe(0); // ...but two edits apart
    expect(similarity('length', 'strength')).toBeGreaterThanOrEqual(0.3);
    expect(typoSimilarity('length', 'strength')).toBe(0);
  });

  it(`declines to fuzzy-match queries under ${MIN_FUZZY_QUERY_LENGTH} characters`, () => {
    expect(MIN_FUZZY_QUERY_LENGTH).toBe(4);
    expect(typoSimilarity('big', 'bit')).toBe(0); // one edit apart, but a third of the word
    expect(typoSimilarity('pa', 'park')).toBe(0);
  });
});

describe('inflectional stem sharing', () => {
  it('recognises the common English inflections, both directions', () => {
    expect(sharesInflectionalStem('swimming', 'swim')).toBe(true);
    expect(sharesInflectionalStem('swimmer', 'swim')).toBe(true);
    expect(sharesInflectionalStem('swimmers', 'swim')).toBe(true);
    expect(sharesInflectionalStem('skater', 'skate')).toBe(true);
    expect(sharesInflectionalStem('skaters', 'skate')).toBe(true);
    expect(sharesInflectionalStem('dancer', 'dance')).toBe(true);
    expect(sharesInflectionalStem('swim', 'swimming')).toBe(true);
    expect(sharesInflectionalStem('running', 'run')).toBe(true);
    expect(sharesInflectionalStem('dancing', 'dance')).toBe(true);
    expect(sharesInflectionalStem('classes', 'class')).toBe(true);
    expect(sharesInflectionalStem('lessons', 'lesson')).toBe(true);
    expect(sharesInflectionalStem('libraries', 'library')).toBe(true);
  });

  it('does not treat arbitrary trailing characters as an inflection', () => {
    expect(sharesInflectionalStem('swimxyz', 'swim')).toBe(false);
    expect(sharesInflectionalStem('storytimezz', 'storytime')).toBe(false);
    expect(sharesInflectionalStem('parade', 'park')).toBe(false);
    expect(sharesInflectionalStem('bus', 'bu')).toBe(false); // base under three characters
  });

  /**
   * "-er" is not reliably a suffix, so the stemmer only accepts the forms that require a real
   * spelling change (undoubled consonant, restored silent e). Without that restriction a
   * search for "mother" would return moth listings.
   */
  it('does not treat a word merely ENDING in -er as an agent noun', () => {
    expect(sharesInflectionalStem('mother', 'moth')).toBe(false);
    expect(sharesInflectionalStem('corner', 'corn')).toBe(false);
    expect(sharesInflectionalStem('water', 'wat')).toBe(false);
    expect(sharesInflectionalStem('summer', 'summ')).toBe(false);
  });

  /**
   * THE ONE THAT WOULD REINTRODUCE THE BUG FROM THE OTHER SIDE. "summer" is itself in the
   * live vocabulary, so a careless -er rule re-links swimmer and summer through the STEM
   * tier — a different mechanism reaching the identical wrong result, and one the trigram
   * guard would never see because the stem tier never consults it.
   */
  it('never re-links swimmer and summer through the stem tier', () => {
    expect(sharesInflectionalStem('swimmer', 'summer')).toBe(false);
    expect(sharesInflectionalStem('swimmers', 'summer')).toBe(false);
    expect(sharesInflectionalStem('swimmer', 'summers')).toBe(false);
    // ...while the route that SHOULD carry it stays open.
    expect(sharesInflectionalStem('swimmer', 'swim')).toBe(true);
  });

  /**
   * False-root guard on the undouble path. Undoubling cannot tell an agent noun from any
   * other doubled-consonant word, so it turns "matter" into "mat" and "manner" into "man" —
   * and both of those ARE live catalogue tokens. Swept over the real 1204-word vocabulary,
   * every false root bottomed out at three characters while every true agentive stem reached
   * four or came through the silent-e path, which is where MIN_AGENTIVE_STEM_LENGTH sits.
   */
  it('does not manufacture three-letter roots from doubled non-agentive words', () => {
    expect(sharesInflectionalStem('matter', 'mat')).toBe(false);
    expect(sharesInflectionalStem('matters', 'mat')).toBe(false);
    expect(sharesInflectionalStem('manner', 'man')).toBe(false);
    expect(sharesInflectionalStem('ladder', 'lad')).toBe(false);
    expect(sharesInflectionalStem('supper', 'sup')).toBe(false);
    expect(sharesInflectionalStem('copper', 'cop')).toBe(false);
    expect(sharesInflectionalStem('butter', 'but')).toBe(false);
    expect(sharesInflectionalStem('dinner', 'din')).toBe(false);
    // Singular/plural of the same word is not a false root and must survive.
    expect(sharesInflectionalStem('matter', 'matters')).toBe(true);
  });

  /**
   * The reliable inflections keep the lower floor — "-ing" really is a gerund in a way
   * "-er" is not an agent — so this asymmetry is linguistic, not arbitrary.
   */
  it('keeps the lower floor for the reliable inflections', () => {
    expect(sharesInflectionalStem('running', 'run')).toBe(true);
    expect(sharesInflectionalStem('runner', 'run')).toBe(false); // the disclosed cost
  });
});

/**
 * Executable form of documents/kids-fun/search-prefix-match-repro.sh. EVERY probe in that
 * script appears here — the ones that changed and the ones that must not — so the defect
 * cannot come back as quietly as it arrived.
 */
describe('search-prefix-match repro (registry round 97)', () => {
  describe('DESIRABLE — query is a prefix of the token; keep working', () => {
    it('"swi" still matches "swim"', () => {
      expect(idsFor('swi')).toContain('l-swim');
    });

    it('"swim" matches exactly, unaffected', () => {
      expect(idsFor('swim')).toContain('l-swim');
    });

    it('scores a longer prefix above a thinner one', () => {
      const strong = matcher.match(resolver.expand(['swi']), COLLISION_LISTINGS);
      const thin = matcher.match(resolver.expand(['sw']), COLLISION_LISTINGS);
      expect(strong[0].relevance).toBeGreaterThan(thin[0].relevance);
    });
  });

  describe('THE DEFECT — token is a prefix of the query', () => {
    it('"swimming" still reaches "swim" — as an inflection, not as trigram overlap', () => {
      expect(idsFor('swimming')).toContain('l-swim');
    });

    it('"swimxyz" no longer matches "swim"', () => {
      expect(idsFor('swimxyz')).toEqual([]);
    });

    it('"storytimezz" no longer matches "storytime"', () => {
      expect(idsFor('storytimezz')).toEqual([]);
    });
  });

  describe('SHORT-PREFIX COLLISION — the user-visible harm', () => {
    it('"pa" returns its prefix matches (park, party)', () => {
      expect(idsFor('pa').sort()).toEqual(['l-park', 'l-party']);
    });

    /**
     * Independent QA (round 97) built a third server with only MIN_PREFIX_QUERY_LENGTH flipped
     * to 3 and measured it against the live catalogue: "sw", "op", "ki" and "ba" all dropped
     * from real results to zero and two-character type-ahead stopped working. Two is measured,
     * not assumed — this pins it so a later tightening has to argue with the evidence.
     */
    it('keeps two-character prefix queries working (QA-measured, do not raise to 3)', () => {
      expect(MIN_PREFIX_QUERY_LENGTH).toBe(2);
      expect(idsFor('sw')).toContain('l-swim');
      expect(idsFor('pa').length).toBeGreaterThan(0);
    });

    it('"parade" no longer returns the same result set as "pa"', () => {
      expect(idsFor('parade')).toEqual([]);
      expect(idsFor('parade')).not.toEqual(idsFor('pa'));
    });

    it('"parade" matches nothing on a shared opening alone', () => {
      expect(idsFor('parade')).not.toContain('l-park');
      expect(idsFor('parade')).not.toContain('l-party');
    });
  });

  /**
   * Found by independent QA against the first revision of this branch, NOT by the original
   * report. "swimmer" lost every swim session (the stem tier did not know the agentive -er)
   * and kept "Summer Reading Club" (the guard only looked at the common prefix, and
   * swimmer/summer collide on their ENDING) — strictly worse than the pre-fix baseline for
   * that query, and the same harm class this branch exists to remove.
   */
  describe('SUFFIX COLLISION — the regression QA caught', () => {
    const SUMMER_LISTINGS = [
      ...COLLISION_LISTINGS,
      listing('l-summer', 'Summer Reading Club', 'storytime', 'Kitsilano Library', 'Read all summer.'),
    ];

    it('"swimmer" finds swim sessions', () => {
      expect(idsFor('swimmer', SUMMER_LISTINGS)).toContain('l-swim');
    });

    it('"swimmer" does NOT find Summer Reading Club', () => {
      expect(idsFor('swimmer', SUMMER_LISTINGS)).not.toContain('l-summer');
    });

    it('"swimmers" and "skaters" reach their activity through the stem tier', () => {
      expect(idsFor('swimmers', SUMMER_LISTINGS)).toContain('l-swim');
      expect(idsFor('swimmers', SUMMER_LISTINGS)).not.toContain('l-summer');
    });

    it('"summer" still finds the summer listing it actually belongs to', () => {
      expect(idsFor('summer', SUMMER_LISTINGS)).toEqual(['l-summer']);
    });
  });

  describe('CONTROLS — already correct, must not regress', () => {
    it('"aswimb" returns nothing (token not leading)', () => {
      expect(idsFor('aswimb')).toEqual([]);
    });

    it('"zzzqqxx" returns nothing (gibberish → honest empty state)', () => {
      expect(idsFor('zzzqqxx')).toEqual([]);
    });
  });
});

describe('WeightedTrigramMatcher', () => {
  it('matches an open-gym listing despite the "opengym" typo (AC G-T16-3)', () => {
    const expanded = resolver.expand(['opengym']); // no alias hit → relies on the fuzzy fallback
    const candidates = matcher.match(expanded, FIXTURE_LISTINGS);
    const ids = candidates.map((c) => c.listing.id);
    expect(ids).toContain('l-opengym-van');
  });

  it('reaches "opengym" as a compound of two real tokens, not as trailing junk', () => {
    // "open" + "gym" are both tokens of the listing; "swim" + "xyz" is not — which is the
    // whole distinction the compound tier exists to make.
    expect(idsFor('opengym')).toContain('l-gym');
    expect(idsFor('swimxyz')).toEqual([]);
  });

  it('ranks exact category matches above unrelated listings for "open gym"', () => {
    const expanded = resolver.expand(['open', 'gym']);
    const candidates = matcher.match(expanded, FIXTURE_LISTINGS).sort((a, b) => b.relevance - a.relevance);
    // every returned candidate is in the open_gym category (category boost + OR terms)
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].listing.primaryCategoryKey).toBe('open_gym');
    expect(candidates.some((c) => c.listing.primaryCategoryKey === 'aquarium')).toBe(false);
  });

  it('browse mode (no text intent) returns all listings at relevance 0', () => {
    const expanded = resolver.expand([]);
    const candidates = matcher.match(expanded, FIXTURE_LISTINGS);
    expect(candidates.length).toBe(FIXTURE_LISTINGS.length);
    expect(candidates.every((c) => c.relevance === 0)).toBe(true);
  });

  /**
   * An infix tier (token.includes(term)) shipped here briefly and was REMOVED after QA
   * measured it against the uncapped corpus: on the 500 rows actually served it produced ten
   * pairs with only two genuine rescues, and even its best tightening still carried ~11%
   * coincidental matches. A tier that is mostly coincidence cannot live in a file whose
   * thesis is replacing coincidence with deliberate rules. These pin the absence, since the
   * tier is easy to re-add on intuition and its cost is only visible on the full corpus.
   */
  describe('unanchored substring matching stays out', () => {
    const SPORT_LISTINGS = [
      listing('l-basketball', 'Youth Basketball', 'class_program', 'Britannia Centre', 'Drop-in hoops.'),
      listing('l-swim', 'Public Swim', 'public_swim', 'Hillcrest Pool', 'Family swim session.'),
    ];

    it('does not match a term buried mid-token (belongs in expand.ts aliases)', () => {
      expect(idsFor('ball', SPORT_LISTINGS)).toEqual([]);
    });

    it('still refuses the reverse direction, which is the original defect', () => {
      expect(idsFor('swimxyz', SPORT_LISTINGS)).toEqual([]);
      expect(idsFor('basketballxyz', SPORT_LISTINGS)).toEqual([]);
    });

    it('leading matches are unaffected', () => {
      expect(idsFor('bask', SPORT_LISTINGS)).toEqual(['l-basketball']);
      expect(idsFor('basketball', SPORT_LISTINGS)).toEqual(['l-basketball']);
    });
  });

  it('scores an exact hit above an inflection, and an inflection above a thin prefix', () => {
    const exact = matcher.match(resolver.expand(['swim']), COLLISION_LISTINGS)[0].relevance;
    const stem = matcher.match(resolver.expand(['swimming']), COLLISION_LISTINGS)[0].relevance;
    const prefix = matcher.match(resolver.expand(['swi']), COLLISION_LISTINGS)[0].relevance;
    expect(exact).toBeGreaterThan(stem);
    expect(stem).toBeGreaterThan(prefix);
  });
});
