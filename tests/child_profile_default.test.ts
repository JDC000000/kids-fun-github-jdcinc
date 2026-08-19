// tests/child_profile_default.test.ts — the PRECEDENCE MATRIX for the profile-derived age
// default, and the round trip that proves a default is indistinguishable from a chip tap by the
// time anything downstream reads it (design §5b/§5c/§5d; the doc's own T2).
//
// This is the file the design doc predicted would have to exist: "{URL age present / absent} ×
// {profile present / absent} × {'Any age' tapped} … the §5d bug lives in the last column and no
// existing test can see it." Every one of those cells is below, and the last column is the reason
// `age=any` was given a spelling at all.
//
// Pure logic in the node environment: no DOM, no router, no storage. That is the whole point of
// keeping the rules in app/search/_lib/profile-default.ts instead of inside a `useEffect` —
// "does a stored child silently narrow this parent's results" is decided by a function that can
// be asked directly.
//
// NB: lives in tests/ rather than beside the module, because vitest.workspace.ts's TEST_INCLUDE
// roots are tests/ app/ evals/ components/ and this one reaches no database (parallel `unit`
// lane, no entry in DB_INTEGRATION_SUITES).
import { describe, expect, it } from 'vitest';
import {
  CLEARED_FILTERS,
  DEFAULT_STATE,
  ageSelectionPatch,
  apiQuery,
  hrefFor,
  parseSearchState,
  type SearchState,
} from '@/app/search/_lib/params';
import { appliedFilterTokens } from '@/app/search/_lib/filter-summary';
import { profileDefaultBands, sameBands } from '@/app/search/_lib/profile-default';
import { CHILD_PROFILE_VERSION, MAX_AGE_MONTHS, type ChildProfile } from '@/lib/profile/child-profile';
import {
  MAX_AGE_YEARS,
  ageMonthsToYears,
  describeChildAges,
  isStorableAgeYears,
  yearsToAgeMonths,
} from '@/lib/profile/child-age-display';

/** Build a state from partial overrides on top of the defaults (mirrors params.test.ts). */
function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}

/** A profile of children aged N years each, in the shape `readProfile` returns. */
function profileOfYears(...years: number[]): ChildProfile {
  return {
    v: CHILD_PROFILE_VERSION,
    children: years.map((y, i) => ({ id: `c${i + 1}`, ageMonths: yearsToAgeMonths(y) })),
    updatedAt: 0,
  };
}

/** The state a URL parses to, so the matrix is stated in URLs rather than in hand-built states. */
function fromUrl(query: string): SearchState {
  return parseSearchState(Object.fromEntries(new URLSearchParams(query)));
}

describe('profileDefaultBands — the precedence matrix (design §5b)', () => {
  const profile = profileOfYears(3, 7); // → bands 2-4 and 5-9

  it('fills the vacuum: no age in the URL + a profile → the profile’s bands', () => {
    expect(profileDefaultBands(fromUrl(''), profile)).toEqual(['2-4', '5-9']);
    expect(profileDefaultBands(fromUrl('q=swim&region=van'), profile)).toEqual(['2-4', '5-9']);
  });

  it('RULE 1 — an explicit age= in the URL always wins, and is never overridden', () => {
    // Shareability: the sender and the receiver of this link must see the same results, so the
    // receiver's own children must not silently re-filter someone else's search.
    expect(profileDefaultBands(fromUrl('age=10-14'), profile)).toBeNull();
    expect(profileDefaultBands(fromUrl('age=under2,15%2B'), profile)).toBeNull();
    // Even when the URL happens to state exactly what the profile would have.
    expect(profileDefaultBands(fromUrl('age=2-4,5-9'), profile)).toBeNull();
  });

  it('RULE 2 — age=any wins too: the "Any age" chip must never become a no-op (§5d)', () => {
    // THE defect this whole third state exists to prevent. If `age=any` were read as "nothing
    // said, apply the profile", the one control whose job is to remove the age filter would
    // re-apply it, the parent would tap it and watch nothing change, and every test would pass.
    const anyAge = fromUrl('age=any');
    expect(anyAge).toMatchObject({ ages: [], anyAge: true });
    expect(profileDefaultBands(anyAge, profile)).toBeNull();
    expect(profileDefaultBands(fromUrl('q=swim&age=any'), profile)).toBeNull();
  });

  it('RULE 3 — no profile changes nothing, on any URL (today’s behaviour, untouched)', () => {
    expect(profileDefaultBands(fromUrl(''), null)).toBeNull();
    expect(profileDefaultBands(fromUrl('age=any'), null)).toBeNull();
    expect(profileDefaultBands(fromUrl('age=5-9'), null)).toBeNull();
  });

  it('RULE 3 — a profile with no RESOLVABLE band never produces a bare ?age=', () => {
    // Only reachable from a hand-edited blob (the store rejects these on read and write), but the
    // failure it guards is a navigation to `?age=` that filters nothing and explains nothing.
    const unresolvable: ChildProfile = {
      v: CHILD_PROFILE_VERSION,
      children: [{ id: 'c1', ageMonths: -5 }, { id: 'c2', ageMonths: 1.5 }],
      updatedAt: 0,
    };
    expect(profileDefaultBands(fromUrl(''), unresolvable)).toBeNull();
  });

  it('never answers with an empty array — null is the only "do nothing" (no empty case to fumble)', () => {
    const answers = [
      profileDefaultBands(fromUrl(''), profile),
      profileDefaultBands(fromUrl('age=any'), profile),
      profileDefaultBands(fromUrl(''), null),
    ];
    expect(answers.every((a) => a === null || a.length > 0)).toBe(true);
  });

  it('collapses siblings in one band, youngest first — the same shape a chip tap produces', () => {
    expect(profileDefaultBands(fromUrl(''), profileOfYears(6, 8))).toEqual(['5-9']);
    expect(profileDefaultBands(fromUrl(''), profileOfYears(12, 1))).toEqual(['under2', '10-14']);
    // A teen resolves like every other band: the 15+ chip is back on the rail (params.ts:112-149).
    expect(profileDefaultBands(fromUrl(''), profileOfYears(16))).toEqual(['15+']);
  });
});

describe('the round trip — a default is indistinguishable from a chip tap (design §5c option 2a)', () => {
  const profile = profileOfYears(3, 7);

  it('materialises into the SAME URL the rail’s chips would have produced', () => {
    const landing = fromUrl('q=swim');
    const bands = profileDefaultBands(landing, profile)!;
    const href = hrefFor(landing, ageSelectionPatch(bands));
    expect(href).toBe('/search?q=swim&age=2-4%2C5-9');
    // …and a parent who tapped those two chips lands on byte-identically the same URL.
    expect(href).toBe(hrefFor(landing, ageSelectionPatch(['2-4', '5-9'])));
  });

  it('U3 — the applied-filter token fires for the default, with a working one-tap removal', () => {
    // "A default that does not appear there should not ship" (§5b(2)). It appears because the
    // default IS the same `age=` state a chip selection is, by the time filter-summary sees it.
    const landing = fromUrl('');
    const bands = profileDefaultBands(landing, profile)!;
    const applied = parseSearchState(
      Object.fromEntries(new URLSearchParams(hrefFor(landing, ageSelectionPatch(bands)).split('?')[1]))
    );
    const ages = appliedFilterTokens(applied, null).find((t) => t.key === 'ages');
    expect(ages).toBeDefined();
    expect(ages!.label).toBe('Ages 2–4 & 5–9');

    // The "✕" writes age=any, which rule 2 then refuses to override — so removing the default
    // STICKS instead of being silently re-applied on the very next render.
    const cleared = hrefFor(applied, ages!.clear);
    expect(cleared).toBe('/search?age=any');
    expect(profileDefaultBands(fromUrl('age=any'), profile)).toBeNull();
  });

  it('feeds BOTH channels the way a chip does — the composed q phrase and the structured age=', () => {
    // design §2b: age is sent twice, mid-migration, and a default that fed only one of them would
    // behave differently from a chip in a way nothing in the UI could show.
    const landing = fromUrl('');
    const bands = profileDefaultBands(landing, profile)!;
    const applied = parseSearchState(
      Object.fromEntries(new URLSearchParams(hrefFor(landing, ageSelectionPatch(bands)).split('?')[1]))
    );
    const params = new URLSearchParams(apiQuery(applied));
    expect(params.get('age')).toBe('2-4,5-9');
    expect(params.get('q')).toContain('preschool'); // the 2-4 band's parent-language phrase
    expect(apiQuery(applied)).toBe(apiQuery(st({ ages: ['2-4', '5-9'] })));
  });

  it('"Clear filters" returns to the DEFAULT VIEW, so the profile applies again', () => {
    // CLEARED_FILTERS resets anyAge to FALSE on purpose (params.ts): clearing a search must not
    // double as an age opt-out, because the "Any age" chip is that and stays one tap away. The
    // consequence, pinned here rather than discovered later: a cleared search re-derives the
    // profile default, while the token's own "✕" (age=any, above) does not.
    const busy = fromUrl('q=swim&region=van&age=2-4%2C5-9&free=1');
    const cleared = hrefFor(busy, CLEARED_FILTERS);
    expect(cleared).toBe('/search?q=swim');
    expect(profileDefaultBands(fromUrl('q=swim'), profile)).toEqual(['2-4', '5-9']);
  });

  it('the profile SURVIVES "Clear filters" — clearing a search never erases a stored child (§4e)', () => {
    // Structural rather than behavioural, and that is the guarantee: nothing in the URL layer can
    // reach the store. `CLEARED_FILTERS` is a plain state patch with no storage side effect, and
    // `clearProfile` is the only eraser in the product.
    expect(Object.keys(CLEARED_FILTERS)).not.toContain('children');
    expect(profileDefaultBands(fromUrl(''), profile)).toEqual(['2-4', '5-9']);
  });
});

describe('sameBands — the guard on the "this came from your profile" note', () => {
  it('is exact and order-sensitive, because both sides are already AGE_ORDER-canonical', () => {
    expect(sameBands(['2-4', '5-9'], ['2-4', '5-9'])).toBe(true);
    expect(sameBands([], [])).toBe(true);
    expect(sameBands(['2-4'], ['2-4', '5-9'])).toBe(false);
    expect(sameBands(['5-9'], ['2-4'])).toBe(false);
  });
});

describe('child-age-display — years in, months stored, a phrase out', () => {
  it('derives the form’s year cap from the store’s month cap rather than restating it', () => {
    expect(MAX_AGE_YEARS).toBe(Math.floor(MAX_AGE_MONTHS / 12));
    expect(yearsToAgeMonths(MAX_AGE_YEARS)).toBeLessThanOrEqual(MAX_AGE_MONTHS);
  });

  it('converts to the START of the year, so a child is never banded older than they are', () => {
    expect(yearsToAgeMonths(3)).toBe(36); // 2-4, where a 3-year-old belongs at 3y0m and 3y11m
    expect(yearsToAgeMonths(0)).toBe(0);
    expect(ageMonthsToYears(47)).toBe(3);
    expect(ageMonthsToYears(0)).toBe(0);
  });

  it('accepts only whole years inside the caps — the input’s min/max validates nothing', () => {
    expect(isStorableAgeYears(0)).toBe(true);
    expect(isStorableAgeYears(MAX_AGE_YEARS)).toBe(true);
    expect(isStorableAgeYears(-1)).toBe(false);
    expect(isStorableAgeYears(3.5)).toBe(false);
    expect(isStorableAgeYears(MAX_AGE_YEARS + 1)).toBe(false);
    expect(isStorableAgeYears(Number.NaN)).toBe(false);
  });

  it('says the ages and NOTHING ELSE — youngest first, no name anywhere (§9-Q2)', () => {
    expect(describeChildAges(profileOfYears(7, 3).children)).toBe('a 3-year-old and a 7-year-old');
    expect(describeChildAges(profileOfYears(5).children)).toBe('a 5-year-old');
    expect(describeChildAges(profileOfYears(9, 2, 6).children)).toBe('a 2-year-old, a 6-year-old and a 9-year-old');
    expect(describeChildAges(profileOfYears(0).children)).toBe('a baby under 1');
    expect(describeChildAges([])).toBe('');
  });
});
