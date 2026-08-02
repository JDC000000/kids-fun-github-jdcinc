// tests/search/match.test.ts — Weighted tsquery + trigram matcher (G-T16-3).

import { describe, it, expect } from 'vitest';
import { WeightedTrigramMatcher, sharesInflectionalStem } from '../../lib/search/match';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { FIXTURE_LISTINGS } from '../../lib/search/__fixtures__/listings';
import {
  similarity,
  overlapIsPrefixOnly,
  withinOneEdit,
  typoSimilarity,
  MIN_FUZZY_QUERY_LENGTH,
} from '../../lib/search/text/trigram';

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

describe('prefix-collision guard (lib/search/text/trigram)', () => {
  it('recognises overlap that is nothing but a shared opening', () => {
    expect(overlapIsPrefixOnly('parade', 'park')).toBe(true);
    expect(overlapIsPrefixOnly('swimxyz', 'swim')).toBe(true);
    expect(overlapIsPrefixOnly('storytimezz', 'storytime')).toBe(true);
    expect(overlapIsPrefixOnly('pa', 'park')).toBe(true);
  });

  it('does NOT flag pairs that agree past the opening', () => {
    expect(overlapIsPrefixOnly('libary', 'library')).toBe(false); // shares "ary"/"ry "
    expect(overlapIsPrefixOnly('ball', 'basketball')).toBe(false);
    expect(overlapIsPrefixOnly('zzzqqxx', 'swim')).toBe(false); // no overlap at all
  });

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
  });

  it('refuses a shared opening as evidence when the words are more than one edit apart', () => {
    expect(typoSimilarity('parade', 'park')).toBe(0);
    expect(typoSimilarity('parade', 'party')).toBe(0);
    expect(typoSimilarity('swimxyz', 'swim')).toBe(0);
    expect(typoSimilarity('storytimezz', 'storytime')).toBe(0);
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

    it('"parade" no longer returns the same result set as "pa"', () => {
      expect(idsFor('parade')).toEqual([]);
      expect(idsFor('parade')).not.toEqual(idsFor('pa'));
    });

    it('"parade" matches nothing on a shared opening alone', () => {
      expect(idsFor('parade')).not.toContain('l-park');
      expect(idsFor('parade')).not.toContain('l-party');
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

  it('scores an exact hit above an inflection, and an inflection above a thin prefix', () => {
    const exact = matcher.match(resolver.expand(['swim']), COLLISION_LISTINGS)[0].relevance;
    const stem = matcher.match(resolver.expand(['swimming']), COLLISION_LISTINGS)[0].relevance;
    const prefix = matcher.match(resolver.expand(['swi']), COLLISION_LISTINGS)[0].relevance;
    expect(exact).toBeGreaterThan(stem);
    expect(stem).toBeGreaterThan(prefix);
  });
});
