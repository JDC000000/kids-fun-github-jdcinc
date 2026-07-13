// tests/search/expand.test.ts — Query-time alias expansion (G-T16-2).

import { describe, it, expect } from 'vitest';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';

describe('FixtureAliasResolver.expand', () => {
  const resolver = new FixtureAliasResolver(ALIAS_SEED);

  it('expands "open gym" to canonical open_gym plus sibling synonym phrases (AC G-T16-2)', () => {
    const out = resolver.expand(['open', 'gym']);
    expect(out.canonicalCategoryKeys).toContain('open_gym');
    expect(out.matchedAliases).toContain('open gym');
    // sibling aliases become AND-matched phrases (gymnasium play, family drop-in, ...)
    const phraseKeys = out.synonymPhrases.map((p) => p.join(' '));
    expect(phraseKeys).toEqual(expect.arrayContaining(['gymnasium play', 'family drop in']));
    expect(out.originalTerms).toEqual([]); // both tokens consumed by the alias
  });

  it('leaves non-alias free-text terms as originalTerms', () => {
    const out = resolver.expand(['dinosaur', 'exhibit']);
    expect(out.canonicalCategoryKeys).toEqual([]);
    expect(out.originalTerms).toEqual(['dinosaur', 'exhibit']);
  });

  it('matches multi-word aliases greedily and resolves a single canonical', () => {
    const out = resolver.expand(['family', 'swim']);
    expect(out.canonicalCategoryKeys).toEqual(['public_swim']);
  });
});
