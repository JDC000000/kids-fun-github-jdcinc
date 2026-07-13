import { describe, it, expect, afterAll } from 'vitest';
import { expandAliases } from '../../lib/search/expand';
import { query, closePool } from '../../lib/db/client';

// G-T16-2 / G-T17-1 — query-time alias expansion + seed dictionary coverage
// (TSD §5A.1, §5A.2 IR-07/UXR-02).
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('expandAliases (G-T16-2)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('"open gym" expands to the open_gym category + its synonym terms', async () => {
    const expansion = await expandAliases('open gym');
    expect(expansion.canonicalCategoryKeys).toContain('open_gym');
    expect(expansion.synonymTerms).toContain('open gym');
  });

  it('an unrecognised free-text query expands to nothing (not an error)', async () => {
    const expansion = await expandAliases('xyzzy quux');
    expect(expansion.canonicalCategoryKeys).toHaveLength(0);
  });

  it('empty text short-circuits without a DB round trip', async () => {
    const expansion = await expandAliases('   ');
    expect(expansion).toEqual({ canonicalCategoryKeys: [], canonicalTagKeys: [], synonymTerms: [] });
  });
});

describe.skipIf(!hasDb)('synonym_alias seed coverage (G-T17-1 eval criteria)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('every §5A.2 canonical category has at least 3 aliases', async () => {
    const categories = ['open_gym', 'public_swim', 'skate', 'storytime', 'miniature_train', 'tobogganing', 'indoor_play'];
    const rows = await query<{ key: string; n: string }>(
      `SELECT c.key, count(sa.id) AS n
       FROM category c
       LEFT JOIN synonym_alias sa ON sa.canonical_category_id = c.id
       WHERE c.key = ANY($1)
       GROUP BY c.key`,
      [categories]
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
    for (const key of categories) {
      expect(byKey[key], `${key} should have >=3 aliases`).toBeGreaterThanOrEqual(3);
    }
  });

  it('no alias text maps to more than one category', async () => {
    const dupes = await query<{ alias_text: string; n: string }>(
      `SELECT lower(alias_text) AS alias_text, count(DISTINCT canonical_category_id) AS n
       FROM synonym_alias
       WHERE canonical_category_id IS NOT NULL
       GROUP BY lower(alias_text)
       HAVING count(DISTINCT canonical_category_id) > 1`
    );
    expect(dupes).toHaveLength(0);
  });
});
