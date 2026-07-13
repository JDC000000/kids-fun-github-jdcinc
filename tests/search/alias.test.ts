// tests/search/alias.test.ts — Alias-change effect, query-time only (G-T17-2/3, IR-07/UXR-02).

import { describe, it, expect } from 'vitest';
import { AliasAdminService } from '../../lib/search/alias-admin';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

describe('operator alias edits take effect without re-index (AC G-T17-3)', () => {
  it('adding an alias immediately changes search results', () => {
    const { engine, aliasResolver } = makeFixtureEngine();
    const admin = new AliasAdminService(aliasResolver);

    // Before: "romp" is not an alias → no open_gym category hits.
    const before = engine.search({ q: 'romp', now: FIXTURE_NOW });
    const beforeHasOpenGym = before.results.some((r) => r.listing.primaryCategoryKey === 'open_gym');
    expect(beforeHasOpenGym).toBe(false);

    // Operator adds an alias at query time (no code deploy, no bulk re-index).
    admin.addAlias({ aliasText: 'romp', canonicalCategoryKey: 'open_gym' });

    // After: the very next search resolves the new alias to open_gym.
    const after = engine.search({ q: 'romp', now: FIXTURE_NOW });
    expect(after.results.some((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(true);
  });

  it('removing an alias reverts the effect', () => {
    const { engine, aliasResolver } = makeFixtureEngine();
    const admin = new AliasAdminService(aliasResolver);
    admin.addAlias({ aliasText: 'romp', canonicalCategoryKey: 'open_gym' });
    expect(engine.search({ q: 'romp', now: FIXTURE_NOW }).results.length).toBeGreaterThan(0);
    admin.removeAlias('romp');
    const reverted = engine.search({ q: 'romp', now: FIXTURE_NOW });
    expect(reverted.results.some((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(false);
  });

  it('rejects an alias with no canonical target', () => {
    const { aliasResolver } = makeFixtureEngine();
    const admin = new AliasAdminService(aliasResolver);
    expect(() => admin.addAlias({ aliasText: 'foo' })).toThrow();
  });
});
