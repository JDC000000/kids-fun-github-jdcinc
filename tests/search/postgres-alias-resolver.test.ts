// tests/search/postgres-alias-resolver.test.ts — DB-backed alias resolver.
//
// Pure unit tests with a stubbed Pool (no live DB): the synonym_alias→AliasEntry
// mapping, drop-in parity with FixtureAliasResolver, the operator add/remove
// contract, and the TTL cache. (Live staging verification of the seeded table is
// done manually — see the Task 11 findings doc.)

import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { FixtureAliasResolver } from '../../lib/search/expand';
import {
  PostgresAliasResolver,
  loadAliasEntries,
  getPostgresAliasResolver,
  clearPostgresAliasResolverCache,
} from '../../lib/search/postgres-alias-resolver';

/** Minimal Pool stub: returns canned rows and counts how many times it was queried. */
function stubPool(rows: unknown[]): { pool: Pool; calls: () => number } {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls: () => calls };
}

/** The seeded synonym_alias rows, shaped as the JOIN in loadAliasEntries returns them. */
const DB_ROWS = ALIAS_SEED.map((e) => ({
  alias_text: e.aliasText,
  category_key: e.canonicalCategoryKey ?? null,
  tag_key: e.canonicalTagKey ?? null,
}));

afterEach(() => {
  clearPostgresAliasResolverCache();
  delete process.env.KIDS_FUN_ALIAS_CACHE_MS;
});

describe('loadAliasEntries', () => {
  it('maps synonym_alias rows (category/tag keys) into AliasEntry', async () => {
    const { pool } = stubPool([
      { alias_text: 'open gym', category_key: 'open_gym', tag_key: null },
      { alias_text: 'toddler friendly', category_key: null, tag_key: 'toddler' },
    ]);
    const entries = await loadAliasEntries(pool);
    expect(entries).toEqual([
      { aliasText: 'open gym', canonicalCategoryKey: 'open_gym' },
      { aliasText: 'toddler friendly', canonicalTagKey: 'toddler' },
    ]);
  });

  it('skips orphaned rows whose target category/tag no longer resolves', async () => {
    const { pool } = stubPool([
      { alias_text: 'open gym', category_key: 'open_gym', tag_key: null },
      { alias_text: 'ghost alias', category_key: null, tag_key: null }, // orphaned
      { alias_text: '   ', category_key: 'open_gym', tag_key: null }, // blank text
    ]);
    const entries = await loadAliasEntries(pool);
    expect(entries).toEqual([{ aliasText: 'open gym', canonicalCategoryKey: 'open_gym' }]);
  });
});

describe('PostgresAliasResolver', () => {
  it('is a drop-in for FixtureAliasResolver — identical expansion for the same rows', async () => {
    const { pool } = stubPool(DB_ROWS);
    const pg = await PostgresAliasResolver.load(pool);
    const fixture = new FixtureAliasResolver(ALIAS_SEED);

    for (const terms of [['open', 'gym'], ['family', 'swim'], ['dinosaur', 'exhibit'], ['story', 'time']]) {
      expect(pg.expand(terms)).toEqual(fixture.expand(terms));
    }
  });

  it('expands "open gym" to canonical open_gym plus sibling phrases', async () => {
    const { pool } = stubPool(DB_ROWS);
    const resolver = await PostgresAliasResolver.load(pool);
    const out = resolver.expand(['open', 'gym']);
    expect(out.canonicalCategoryKeys).toContain('open_gym');
    expect(out.matchedAliases).toContain('open gym');
    expect(out.synonymPhrases.map((p) => p.join(' '))).toEqual(
      expect.arrayContaining(['gymnasium play', 'family drop in'])
    );
  });

  it('inherits the operator-editable add/remove contract (alias-admin compatibility)', async () => {
    const { pool } = stubPool([{ alias_text: 'open gym', category_key: 'open_gym', tag_key: null }]);
    const resolver = await PostgresAliasResolver.load(pool);
    resolver.add({ aliasText: 'gymnasium play', canonicalCategoryKey: 'open_gym' });
    expect(resolver.expand(['gymnasium', 'play']).canonicalCategoryKeys).toContain('open_gym');
    resolver.remove('gymnasium play');
    expect(resolver.expand(['gymnasium', 'play']).canonicalCategoryKeys).toEqual([]);
  });
});

describe('getPostgresAliasResolver TTL cache', () => {
  it('reuses the cached resolver within the TTL window and reloads after it', async () => {
    process.env.KIDS_FUN_ALIAS_CACHE_MS = '1000';
    const { pool, calls } = stubPool(DB_ROWS);

    await getPostgresAliasResolver(pool, 0);
    await getPostgresAliasResolver(pool, 500); // within TTL → cached
    expect(calls()).toBe(1);

    await getPostgresAliasResolver(pool, 1500); // past TTL → reload
    expect(calls()).toBe(2);
  });

  it('disables caching when TTL is 0 (always reloads → operator edits immediate)', async () => {
    process.env.KIDS_FUN_ALIAS_CACHE_MS = '0';
    const { pool, calls } = stubPool(DB_ROWS);
    await getPostgresAliasResolver(pool, 0);
    await getPostgresAliasResolver(pool, 1);
    expect(calls()).toBe(2);
  });
});
