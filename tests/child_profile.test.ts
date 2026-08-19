// tests/child_profile.test.ts — the on-device child-profile storage layer and its band
// derivation (docs/child-first-class-profile-design.md §10, S1 + S2).
//
// Pure logic, exercised in the node environment against an injectable in-memory Storage stub
// (the suite has no jsdom; storage is injected, matching how the production code accepts a
// StorageLike). Structure mirrors app/search/_lib/anon-memory.test.ts, which is the module's
// model — same fake-Storage harness, same fixed clock, same degradation cases.
//
// The focus is the PRIVACY INVARIANT first and the mechanics second: this module stores a real
// child's age, which this product removed from the server on purpose (F-8 / PIPEDA), so the
// cases that matter most are the ones proving nothing identifying can get in or out — not the
// happy path.
//
// NB: this file lives in tests/ rather than beside lib/profile/, because vitest.workspace.ts's
// TEST_INCLUDE roots are tests/ app/ evals/ components/ — a `lib/**/*.test.ts` would never be
// collected. It reaches no database, so it belongs in the parallel `unit` lane (no entry in
// DB_INTEGRATION_SUITES).
import { describe, it, expect } from 'vitest';
import {
  CHILD_PROFILE_KEY,
  CHILD_PROFILE_VERSION,
  type StorageLike,
  clearProfile,
  packProfile,
  parseProfile,
  readProfile,
  sanitizeChildren,
  writeProfile,
} from '@/lib/profile/child-profile';
import { AGE_BAND_LOWER_MONTHS, ageMonthsToBand, childrenToAgeBands } from '@/lib/profile/child-age-bands';
import { AGE_BAND_ORDER } from '@/lib/search/filters/age';
import { AGE_OPTIONS } from '@/app/search/_lib/params';

/** A minimal, inspectable localStorage stand-in. */
function memStore(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A storage whose every method throws (private mode / disabled / quota). */
const throwingStore: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const NOW = 1_755_600_000_000; // fixed epoch ms (tests never call Date.now)

describe('sanitizeChildren — validation + the allowlist that carries the privacy invariant', () => {
  it('keeps a valid entry and mints a stable id when none was supplied', () => {
    expect(sanitizeChildren([{ ageMonths: 36 }, { ageMonths: 84 }])).toEqual([
      { id: 'c1', ageMonths: 36 },
      { id: 'c2', ageMonths: 84 },
    ]);
  });

  it('preserves a valid supplied id (edit/remove must not depend on array position)', () => {
    expect(sanitizeChildren([{ id: 'kid-A', ageMonths: 36 }])).toEqual([{ id: 'kid-A', ageMonths: 36 }]);
  });

  it('DROPS every field that is not id/ageMonths — a name can never survive the allowlist', () => {
    const out = sanitizeChildren([
      { id: 'c1', ageMonths: 36, name: 'Maya', dob: '2023-01-04', lat: 49.28, lng: -123.12, email: 'a@b.c' },
    ]);
    expect(out).toEqual([{ id: 'c1', ageMonths: 36 }]);
    expect(JSON.stringify(out)).not.toContain('Maya');
    expect(JSON.stringify(out)).not.toContain('49.28');
  });

  it('drops entries with an unusable age, keeping the rest', () => {
    expect(
      sanitizeChildren([
        { ageMonths: 36 },
        { ageMonths: -1 },
        { ageMonths: 42.5 },
        { ageMonths: Number.NaN },
        { ageMonths: '36' },
        { ageMonths: 9_999_999 },
        {},
        null,
        'nope',
        [],
      ]),
    ).toEqual([{ id: 'c1', ageMonths: 36 }]);
  });

  it('accepts the age bounds exactly: 0 months in, the 18th birthday in, one month past it out', () => {
    expect(sanitizeChildren([{ ageMonths: 0 }])).toHaveLength(1);
    expect(sanitizeChildren([{ ageMonths: 216 }])).toHaveLength(1);
    expect(sanitizeChildren([{ ageMonths: 217 }])).toHaveLength(0);
  });

  it('replaces a malformed or duplicated id rather than dropping the child', () => {
    // The age is the datum the parent gave us; the id is our own bookkeeping. Losing a child
    // over a tampered id would be the wrong trade.
    const out = sanitizeChildren([
      { id: 'dup', ageMonths: 12 },
      { id: 'dup', ageMonths: 60 },
      { id: 'has spaces & symbols!', ageMonths: 96 },
      { id: 'x'.repeat(500), ageMonths: 120 },
    ]);
    expect(out.map((c) => c.ageMonths)).toEqual([12, 60, 96, 120]);
    expect(new Set(out.map((c) => c.id)).size).toBe(4); // every id unique
    expect(out[0].id).toBe('dup');
    for (const child of out) expect(child.id).toMatch(/^[A-Za-z0-9_-]{1,24}$/);
  });

  it('caps the child count at 4 (the design’s placeholder — copy concern, revisitable)', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ageMonths: i * 12 }));
    expect(sanitizeChildren(many)).toHaveLength(4);
  });

  it('is safe on non-array input', () => {
    expect(sanitizeChildren(null)).toEqual([]);
    expect(sanitizeChildren(undefined)).toEqual([]);
    expect(sanitizeChildren({ ageMonths: 36 })).toEqual([]);
    expect(sanitizeChildren('36')).toEqual([]);
  });
});

describe('packProfile / parseProfile round-trip', () => {
  it('packs a profile and parses it back identically', () => {
    const raw = packProfile([{ ageMonths: 36 }, { ageMonths: 84 }], NOW);
    expect(raw).not.toBeNull();
    expect(parseProfile(raw)).toEqual({
      v: CHILD_PROFILE_VERSION,
      children: [
        { id: 'c1', ageMonths: 36 },
        { id: 'c2', ageMonths: 84 },
      ],
      updatedAt: NOW,
    });
  });

  it('returns null when there is nothing worth storing', () => {
    expect(packProfile([], NOW)).toBeNull();
    expect(packProfile([{ ageMonths: -5 }], NOW)).toBeNull();
    expect(packProfile(null, NOW)).toBeNull();
  });

  it('normalises a non-finite timestamp to 0', () => {
    expect(parseProfile(packProfile([{ ageMonths: 36 }], Number.NaN))!.updatedAt).toBe(0);
  });

  it('the packed bytes contain ONLY the two stored fields — no name, coords, postal or email', () => {
    const raw = packProfile(
      [{ id: 'c1', ageMonths: 36, name: 'Maya', postal: 'V6K 1A1', lat: 49.28, email: 'p@example.com' }],
      NOW,
    )!;
    expect(raw).toBe('{"v":1,"children":[{"id":"c1","ageMonths":36}],"updatedAt":' + NOW + '}');
    for (const leak of ['Maya', 'postal', 'V6K', 'lat', '49.28', 'email', 'example.com']) {
      expect(raw).not.toContain(leak);
    }
  });
});

describe('parseProfile — validation hardening (localStorage is writable by anything on the origin)', () => {
  it('rejects absent / malformed / oversized raw', () => {
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile('')).toBeNull();
    expect(parseProfile('{not json')).toBeNull();
    expect(parseProfile('x'.repeat(5000))).toBeNull();
  });

  it('rejects a non-object envelope (including an array)', () => {
    expect(parseProfile('"a string"')).toBeNull();
    expect(parseProfile('[{"id":"c1","ageMonths":36}]')).toBeNull();
    expect(parseProfile('42')).toBeNull();
  });

  it('rejects ANY other schema version — never migrated, always treated as absent', () => {
    const body = { children: [{ id: 'c1', ageMonths: 36 }], updatedAt: NOW };
    expect(parseProfile(JSON.stringify({ ...body, v: CHILD_PROFILE_VERSION + 1 }))).toBeNull();
    expect(parseProfile(JSON.stringify({ ...body, v: CHILD_PROFILE_VERSION - 1 }))).toBeNull();
    expect(parseProfile(JSON.stringify({ ...body, v: '1' }))).toBeNull();
    expect(parseProfile(JSON.stringify(body))).toBeNull(); // no version at all
  });

  it('rejects a record whose children are missing, wrong-typed, or all invalid', () => {
    const env = (children: unknown) => JSON.stringify({ v: CHILD_PROFILE_VERSION, children, updatedAt: NOW });
    expect(parseProfile(env(undefined))).toBeNull();
    expect(parseProfile(env('c1'))).toBeNull();
    expect(parseProfile(env({ id: 'c1', ageMonths: 36 }))).toBeNull();
    expect(parseProfile(env([]))).toBeNull();
    expect(parseProfile(env([{ ageMonths: 'three' }]))).toBeNull();
  });

  it('STRIPS an identifying field from a hand-tampered blob rather than trusting it', () => {
    // Deliberately asymmetric with packProfile, which REFUSES instead. A forbidden key on the
    // way out can only be our own bug; on the way in it is a hostile or hand-edited blob, and
    // keeping the (still valid) ages while dropping the smuggled field is the better outcome.
    const tampered = JSON.stringify({
      v: CHILD_PROFILE_VERSION,
      children: [{ id: 'c1', ageMonths: 36, name: 'Maya', birthdate: '2023-01-04' }],
      updatedAt: NOW,
      email: 'parent@example.com',
    });
    const rec = parseProfile(tampered)!;
    expect(rec.children).toEqual([{ id: 'c1', ageMonths: 36 }]);
    expect(JSON.stringify(rec)).not.toContain('Maya');
    expect(JSON.stringify(rec)).not.toContain('parent@example.com');
    expect('email' in rec).toBe(false);
  });

  it('enforces the caps on READ, not just on write (a tampered blob gets no more trust)', () => {
    const rec = parseProfile(
      JSON.stringify({
        v: CHILD_PROFILE_VERSION,
        children: Array.from({ length: 9 }, (_, i) => ({ id: `k${i}`, ageMonths: 24 })),
        updatedAt: NOW,
      }),
    )!;
    expect(rec.children).toHaveLength(4);
  });
});

describe('readProfile / writeProfile / clearProfile against a Storage stub', () => {
  it('write then read yields the same children', () => {
    const store = memStore();
    expect(writeProfile([{ ageMonths: 36 }, { ageMonths: 84 }], NOW, store)).toBe(true);
    expect(store.map.get(CHILD_PROFILE_KEY)).toBeTruthy();
    expect(readProfile(store)!.children.map((c) => c.ageMonths)).toEqual([36, 84]);
  });

  it('writeProfile is a no-op that PRESERVES an existing profile when there is nothing to store', () => {
    const store = memStore();
    writeProfile([{ ageMonths: 36 }], NOW, store);
    expect(writeProfile([], NOW, store)).toBe(false);
    expect(writeProfile([{ ageMonths: -1 }], NOW, store)).toBe(false);
    // "Remove my last child" must be spelled as clearProfile, never as a write of an empty
    // list — one eraser, so no accidental empty-array call can wipe a parent's profile.
    expect(readProfile(store)!.children).toEqual([{ id: 'c1', ageMonths: 36 }]);
  });

  it('clearProfile erases the profile entirely', () => {
    const store = memStore();
    writeProfile([{ ageMonths: 36 }], NOW, store);
    clearProfile(store);
    expect(readProfile(store)).toBeNull();
    expect(store.map.has(CHILD_PROFILE_KEY)).toBe(false);
  });

  it('a stored blob from another schema version reads as absent and is never migrated', () => {
    const store = memStore({
      [CHILD_PROFILE_KEY]: JSON.stringify({ v: 99, children: [{ id: 'c1', ageMonths: 36 }], updatedAt: NOW }),
    });
    expect(readProfile(store)).toBeNull();
  });

  it('degrades to no-op when storage is null (SSR / unavailable)', () => {
    expect(readProfile(null)).toBeNull();
    expect(writeProfile([{ ageMonths: 36 }], NOW, null)).toBe(false);
    expect(() => clearProfile(null)).not.toThrow();
  });

  it('never throws when storage itself throws (private mode / quota exceeded)', () => {
    expect(readProfile(throwingStore)).toBeNull();
    expect(writeProfile([{ ageMonths: 36 }], NOW, throwingStore)).toBe(false);
    expect(() => clearProfile(throwingStore)).not.toThrow();
  });

  it('uses its own namespaced key and never touches the anon-memory one', () => {
    const store = memStore({ kf_last_search: 'someone else’s data' });
    writeProfile([{ ageMonths: 36 }], NOW, store);
    clearProfile(store);
    expect(store.map.get('kf_last_search')).toBe('someone else’s data');
    expect(CHILD_PROFILE_KEY).toBe('kf_child_profile');
  });
});

// ── S2: months → the product's band vocabulary ────────────────────────────────────────────

describe('ageMonthsToBand — the seeded boundaries, inclusive low / exclusive high', () => {
  it('maps each band’s first and last month to that band', () => {
    const cases: Array<[number, string]> = [
      [0, 'under2'],
      [23, 'under2'],
      [24, '2-4'],
      [59, '2-4'],
      [60, '5-9'],
      [119, '5-9'],
      [120, '10-14'],
      [179, '10-14'],
      [180, '15+'],
    ];
    for (const [months, band] of cases) expect(ageMonthsToBand(months)).toBe(band);
  });

  it('treats 15+ as genuinely open-ended, with no special case anywhere', () => {
    expect(ageMonthsToBand(216)).toBe('15+'); // the 18th birthday, the storage cap
    expect(ageMonthsToBand(9_000)).toBe('15+'); // beyond anything storable — still just the top band
  });

  it('returns null for anything that is not a real month count', () => {
    for (const bad of [-1, 42.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ageMonthsToBand(bad)).toBeNull();
    }
    expect(ageMonthsToBand('36' as unknown as number)).toBeNull();
    expect(ageMonthsToBand(null as unknown as number)).toBeNull();
  });

  it('every derivable band is one the rail can actually select (the §2a gap is closed)', () => {
    // The design doc (written against f59cd71) names "a profile can express an age the chip UI
    // cannot" as a real hole, because 15+ had no chip. Jon reinstated it 2026-08-18. This is
    // the assertion that would fail if a band were ever dropped from the rail again while the
    // taxonomy kept it — which is the shape of the hole, not just its one instance.
    const chipKeys = new Set(AGE_OPTIONS.map((o) => o.key));
    const derivable = new Set(
      Array.from({ length: 217 }, (_, months) => ageMonthsToBand(months)).filter(Boolean),
    );
    expect([...derivable].filter((band) => !chipKeys.has(band!))).toEqual([]);
    expect(derivable.size).toBe(AGE_BAND_ORDER.length); // and every band is reachable from some age
  });

  it('states a bound for every band in the union, in the canonical order (compile-time + runtime)', () => {
    expect(Object.keys(AGE_BAND_LOWER_MONTHS).sort()).toEqual([...AGE_BAND_ORDER].sort());
    const lowers = AGE_BAND_ORDER.map((b) => AGE_BAND_LOWER_MONTHS[b]);
    expect(lowers).toEqual([...lowers].sort((a, b) => a - b)); // youngest-first, strictly rising
    expect(new Set(lowers).size).toBe(lowers.length);
    expect(lowers[0]).toBe(0); // the bands partition [0, ∞) — no month falls outside
  });
});

describe('childrenToAgeBands — a profile as a band selection', () => {
  it('derives one band per child, de-duplicated, in canonical youngest-first order', () => {
    // Sam (7) then Maya (3): the OUTPUT order is the band order, not the input order, so the
    // result is indistinguishable from a selection a parent tapped (parseOrderedCsv/toggleInList).
    expect(
      childrenToAgeBands([
        { id: 'c1', ageMonths: 84 },
        { id: 'c2', ageMonths: 36 },
      ]),
    ).toEqual(['2-4', '5-9']);
  });

  it('collapses two children in the same band to one band (the bands are an OR-set, not a multiset)', () => {
    expect(
      childrenToAgeBands([
        { id: 'c1', ageMonths: 60 },
        { id: 'c2', ageMonths: 96 },
      ]),
    ).toEqual(['5-9']);
  });

  it('skips a child whose age does not resolve rather than defaulting it into a band', () => {
    expect(
      childrenToAgeBands([
        { id: 'c1', ageMonths: 36 },
        { id: 'c2', ageMonths: -4 },
        null as never,
      ]),
    ).toEqual(['2-4']);
  });

  it('yields an empty selection for an empty/unusable profile — i.e. no age filter', () => {
    expect(childrenToAgeBands([])).toEqual([]);
    expect(childrenToAgeBands(null as never)).toEqual([]);
  });

  it('a teenager derives 15+, which now has a chip and a round-tripping URL spelling', () => {
    expect(childrenToAgeBands([{ id: 'c1', ageMonths: 15 * 12 }])).toEqual(['15+']);
  });
});
