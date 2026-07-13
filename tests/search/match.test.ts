// tests/search/match.test.ts — Weighted tsquery + trigram matcher (G-T16-3).

import { describe, it, expect } from 'vitest';
import { WeightedTrigramMatcher } from '../../lib/search/match';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { FIXTURE_LISTINGS } from '../../lib/search/__fixtures__/listings';
import { similarity } from '../../lib/search/text/trigram';

const resolver = new FixtureAliasResolver(ALIAS_SEED);
const matcher = new WeightedTrigramMatcher();

describe('trigram similarity (pg_trgm-compatible)', () => {
  it('scores "opengym" vs "open" above the default threshold', () => {
    expect(similarity('opengym', 'open')).toBeGreaterThanOrEqual(0.3);
  });
});

describe('WeightedTrigramMatcher', () => {
  it('matches an open-gym listing despite the "opengym" typo (AC G-T16-3)', () => {
    const expanded = resolver.expand(['opengym']); // no alias hit → relies on trigram fallback
    const candidates = matcher.match(expanded, FIXTURE_LISTINGS);
    const ids = candidates.map((c) => c.listing.id);
    expect(ids).toContain('l-opengym-van');
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
});
