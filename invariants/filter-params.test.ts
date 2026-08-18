// invariants/filter-params.test.ts — Every filter the /search URL can carry must actually reach
// the engine, and the response must SAY SO.
//
// WHAT CLASS OF BUG THIS EXISTS FOR. A filter param can be wired end-to-end in the UI — a chip a
// parent can tap, a key in the page URL, a value that round-trips through parseSearchState and
// into a saved search — and still be read by nothing on the server. Every existing test around it
// passes: the chip renders, the URL is right, the state parses, the API returns 200 with a
// plausible page of results. The only symptom is that tapping it changes nothing, which no
// assertion in the suite was looking at. Two live instances were found by an independent tester
// probing the API with the UI's own URLs (report P1-5): `bookable` (dead until the Stage 2a typed
// params landed) and `reg` (dead until this change).
//
// WHY THE TEXT COMPOSITION IS DELIBERATELY NOT SENT. `apiQuery` composes the chips into `q` as
// parent-language phrases AS WELL AS sending them structurally, so a dead structured param is
// invisible through that door — the text half quietly does the work and the page looks correct.
// These cases therefore send the /search PAGE URL (`hrefFor`, i.e. `pageParams`) verbatim, which
// carries the structured params and no composed intent. That is also exactly what a shared link,
// a saved search, a curl and every one of tonight's testers actually sends.
//
// THREE RULES OF CONSTRUCTION.
//
// 1. THE LADDER IS DECLINED (`minResults=0`, the digest's documented opt-out) on every call, for a
//    reason specific to this file: `SearchResponse.context` is the WORKING context, i.e. the one
//    the broadening ladder may have relaxed. With the ladder live, a chip that WAS read and then
//    dropped by a rung echoes back as `false`, and a chip that was never read echoes back as
//    `false` — the two states are indistinguishable exactly where it matters.
// 2. EVERY ECHO ASSERTION MUST FAIL AGAINST THE BASELINE. Each case's oracle is also run against
//    the default (no-filter) response and must reject it. An oracle that passes with the filter
//    off is measuring nothing, and this file is one `?.` away from being that.
// 3. THE CASE TABLE IS PINNED TO THE UI'S OWN FIELD LIST. `CLEARED_FILTERS` is the rail's
//    inventory of every filter field (it is what "Clear filters" resets). A field in it with no
//    case here fails the drift guard below, so a chip added to the rail cannot arrive without a
//    proof that the server reads it.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { GET } from '../app/api/search/route';
import {
  CLEARED_FILTERS,
  DEFAULT_STATE,
  hrefFor,
  type SearchState,
} from '../app/search/_lib/params';
import { CLOCKS, expectInvariant, pinClock, unpinClock, type Clock, type Violation } from './_harness';

// ── The response, as much of it as an echo assertion reads ───────────────────────────────────

interface FacetValue {
  value: string;
  selected: boolean;
}
interface ResponseBody {
  context: {
    raw: string;
    ageBands: string[];
    date: { kind: string; isoDate: string; endIsoDate?: string } | null;
    timeOfDay: string | null;
    radiusKm: number;
    costFree: boolean;
    includeRegistration: boolean;
    bookableNow: boolean;
    rainyDay: boolean;
    dropIn: boolean;
    sort: string;
  };
  origin: { mode: string; geo: { lat: number; lng: number } } | null;
  results: Array<{ slots: Array<{ id: string }> }>;
  ageUnconfirmed?: Array<{ slots: Array<{ id: string }> }>;
  expected: Array<{ slots: Array<{ id: string }> }>;
  meta: { sort: string; backend?: string };
  facets?: { groups: Array<{ key: string; values: FacetValue[] }> };
}

/**
 * Call the real route with a /search page query string.
 *
 * `facets=1` is on for every call because it is the ONE channel through which the region chips
 * are echoed: region is not a `SearchContext` field (it travels beside the context as
 * `regionChipIds`), so the areas facet group's `selected` flags are the only thing the response
 * says about which chips the server actually applied.
 */
async function call(pageQuery: string): Promise<ResponseBody> {
  const qs = [pageQuery, 'minResults=0', 'facets=1'].filter(Boolean).join('&');
  const res = await GET(new Request(`http://localhost/api/search?${qs}`));
  return (await res.json()) as ResponseBody;
}

/** The /search PAGE query string for a state — the UI's own serialization, never a hand-built one. */
function pageQuery(patch: Partial<SearchState>): string {
  return hrefFor({ ...DEFAULT_STATE, ...patch }).split('?')[1] ?? '';
}

/** Which area chips the server reports as applied. */
function selectedAreas(body: ResponseBody): string[] {
  const group = body.facets?.groups.find((g) => g.key === 'areas');
  return (group?.values ?? []).filter((v) => v.selected && v.value !== 'any').map((v) => v.value).sort();
}

/** Every occurrence the response reached, across all three sections (the suite's set identity). */
function slotIdsOf(body: ResponseBody): Set<string> {
  const out = new Set<string>();
  for (const item of [...body.results, ...(body.ageUnconfirmed ?? []), ...body.expected]) {
    for (const slot of item.slots) out.add(slot.id);
  }
  return out;
}

function sorted(ids: Set<string>): string[] {
  return [...ids].sort();
}

// ── The case table: one row per filter the /search URL can carry ─────────────────────────────

interface ParamCase {
  name: string;
  /** URL keys this case expects the page to emit — asserted, so a chip that stops emitting fails. */
  params: string[];
  /** SearchState fields it exercises; checked against CLEARED_FILTERS by the drift guard. */
  fields: Array<keyof SearchState>;
  patch: Partial<SearchState>;
  /** Null when the response proves the param was read; otherwise the failure detail. */
  echo: (body: ResponseBody) => string | null;
}

const NEAR_ME = { lat: 49.26, lng: -123.07 };

const CASES: ParamCase[] = [
  {
    name: 'q (free text)',
    params: ['q'],
    fields: ['q'],
    patch: { q: 'open gym' },
    echo: (b) => (b.context.raw === 'open gym' ? null : `context.raw is ${JSON.stringify(b.context.raw)}`),
  },
  {
    name: 'sort',
    params: ['sort'],
    fields: ['sort'],
    patch: { sort: 'soonest' },
    echo: (b) => (b.meta.sort === 'soonest' && b.context.sort === 'soonest' ? null : `meta.sort=${b.meta.sort}, context.sort=${b.context.sort}`),
  },
  {
    // The one this file was written for: `reg` is the page URL's name for the registration
    // opt-in, and the route read only `includeRegistration` until 2026-08-18.
    name: 'reg (registration opt-in)',
    params: ['reg'],
    fields: ['includeRegistration'],
    patch: { includeRegistration: true },
    echo: (b) => (b.context.includeRegistration === true ? null : 'context.includeRegistration is false — the reg= param was ignored'),
  },
  {
    name: 'region (multi-select chips)',
    params: ['region'],
    fields: ['regions'],
    patch: { regions: ['van', 'bby'] },
    echo: (b) => {
      const applied = selectedAreas(b);
      return applied.join(',') === 'bby,van' ? null : `areas facet reports [${applied.join(', ')}] applied, not [bby, van]`;
    },
  },
  {
    name: 'when (date quick-pick)',
    params: ['when'],
    fields: ['when'],
    patch: { when: 'tomorrow' },
    echo: (b) => (b.context.date?.kind === 'tomorrow' ? null : `context.date is ${JSON.stringify(b.context.date)}`),
  },
  {
    name: 'from/to (custom date range)',
    params: ['from', 'to'],
    fields: ['dateFrom', 'dateTo'],
    patch: { dateFrom: '2026-08-20', dateTo: '2026-08-22' },
    echo: (b) =>
      b.context.date?.kind === 'range' && b.context.date.isoDate === '2026-08-20' && b.context.date.endIsoDate === '2026-08-22'
        ? null
        : `context.date is ${JSON.stringify(b.context.date)}`,
  },
  {
    name: 'time (day part)',
    params: ['time'],
    fields: ['timeOfDay'],
    patch: { timeOfDay: 'morning' },
    echo: (b) => (b.context.timeOfDay === 'morning' ? null : `context.timeOfDay is ${JSON.stringify(b.context.timeOfDay)}`),
  },
  {
    name: 'bookable (Bookable Now chip)',
    params: ['bookable'],
    fields: ['bookableNow'],
    patch: { bookableNow: true },
    echo: (b) => (b.context.bookableNow === true ? null : 'context.bookableNow is false — the bookable= param was ignored'),
  },
  {
    name: 'rainy (rainy-day / indoor chip)',
    params: ['rainy'],
    fields: ['rainyDay'],
    patch: { rainyDay: true },
    echo: (b) => (b.context.rainyDay === true ? null : 'context.rainyDay is false — the rainy= param was ignored'),
  },
  {
    name: 'dropin (drop-in chip)',
    params: ['dropin'],
    fields: ['dropIn'],
    patch: { dropIn: true },
    echo: (b) => (b.context.dropIn === true ? null : 'context.dropIn is false — the dropin= param was ignored'),
  },
  {
    name: 'free (free-only chip)',
    params: ['free'],
    fields: ['free'],
    patch: { free: true },
    echo: (b) => (b.context.costFree === true ? null : 'context.costFree is false — the free= param was ignored'),
  },
  {
    name: 'age (multi-select bands)',
    params: ['age'],
    fields: ['ages'],
    patch: { ages: ['5-9', '10-14'] },
    echo: (b) => (b.context.ageBands.join(',') === '5-9,10-14' ? null : `context.ageBands is [${b.context.ageBands.join(', ')}]`),
  },
  {
    name: 'lat/lng (near-me origin)',
    params: ['lat', 'lng'],
    fields: ['lat', 'lng'],
    patch: { ...NEAR_ME },
    echo: (b) =>
      b.origin?.mode === 'near_me' && Math.abs((b.origin?.geo.lat ?? 0) - NEAR_ME.lat) < 0.001
        ? null
        : `origin is ${JSON.stringify(b.origin)}`,
  },
  {
    // Radius only travels with an origin (the page emits it only when one is set), so this case
    // carries the coords too — it is the RADIUS value the oracle reads.
    name: 'radius (travel distance)',
    params: ['radius'],
    fields: ['radiusKm'],
    patch: { ...NEAR_ME, radiusKm: 20 },
    echo: (b) => (b.context.radiusKm === 20 ? null : `context.radiusKm is ${b.context.radiusKm}`),
  },
];

/**
 * `home=1` is the ONE page param the API deliberately does not read, and it is listed here rather
 * than left as an omission. It carries the saved-location INTENT; the postal itself is never in a
 * shareable URL, so the /search page resolves the signed-in user's saved postal server-side and
 * forwards it as `postal=…&signedIn=1`. The exception is pinned by its own test below, so "the API
 * ignores it" stays a stated design decision rather than the next dead param.
 */
const PAGE_ONLY_FIELDS: Array<keyof SearchState> = ['useSavedLocation'];

beforeAll(() => {
  pinClock(CLOCKS[0]);
});
afterAll(() => unpinClock());

// Fixture backend + no geocoding key: hermetic and offline, the same contract
// tests/search/route.test.ts keeps. Restored afterwards so no neighbour inherits it.
const savedBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
const savedGeoKey = process.env.GEOCODING_API_KEY;
beforeAll(() => {
  delete process.env.KIDS_FUN_SEARCH_BACKEND;
  delete process.env.GEOCODING_API_KEY;
});
afterAll(() => {
  if (savedBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
  else process.env.KIDS_FUN_SEARCH_BACKEND = savedBackend;
  if (savedGeoKey === undefined) delete process.env.GEOCODING_API_KEY;
  else process.env.GEOCODING_API_KEY = savedGeoKey;
});

/** Run the whole case table at one clock. Returns the violations it found. */
async function checkCasesAt(clock: Clock): Promise<{ violations: Violation[]; checked: number }> {
  pinClock(clock);
  const violations: Violation[] = [];
  let checked = 0;
  const baseline = await call(pageQuery({}));
  for (const c of CASES) {
    const qs = pageQuery(c.patch);
    const emitted = new URLSearchParams(qs);
    for (const param of c.params) {
      if (!emitted.has(param)) {
        violations.push({
          clock: clock.label,
          query: qs,
          detail: `${c.name}: the /search page URL no longer emits \`${param}\` — this case is asserting nothing`,
        });
      }
    }
    const body = await call(qs);
    checked += 1;
    const failure = c.echo(body);
    if (failure) {
      violations.push({ clock: clock.label, query: qs, detail: `${c.name} was NOT applied — ${failure}` });
    }
    // Rule 2: the same oracle must reject the no-filter response, or it proves nothing.
    if (c.echo(baseline) == null) {
      violations.push({
        clock: clock.label,
        query: qs,
        detail: `${c.name}: the echo oracle also passes with the filter OFF — it cannot detect a dead param`,
      });
    }
  }
  return { violations, checked };
}

describe('FILTER PARAMS — every /search URL filter reaches the engine', () => {
  it('each UI-generated param changes the response context echo, at every pinned clock', async () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const result = await checkCasesAt(clock);
      violations.push(...result.violations);
      checked += result.checked;
    }
    pinClock(CLOCKS[0]);
    expectInvariant('every /search URL filter param is read by the API', violations, checked);
  });

  it('the case table covers every filter field the rail can clear (drift guard)', () => {
    // CLEARED_FILTERS is the UI's own inventory of filter state. A new chip must appear in it (or
    // "Clear filters" would not clear it), so this is what makes a new chip arrive WITH a proof
    // that the server reads it, instead of a year later in a tester's report.
    const covered = new Set<string>([...CASES.flatMap((c) => c.fields), ...PAGE_ONLY_FIELDS]);
    const uncovered = Object.keys(CLEARED_FILTERS).filter((field) => !covered.has(field));
    expect(
      uncovered,
      `filter fields with no param case in this file: [${uncovered.join(', ')}]. ` +
        'Add a case proving /api/search reads the param, or add it to PAGE_ONLY_FIELDS with the reason.',
    ).toEqual([]);
  });

  it('`home=1` is the only page param the API ignores, and it is ignored deliberately', async () => {
    // The saved-location intent resolves to postal+signedIn on the server; on its own it must
    // produce no origin (and, critically, never a phantom 0,0 one).
    const body = await call(pageQuery({ useSavedLocation: true }));
    expect(new URLSearchParams(pageQuery({ useSavedLocation: true })).get('home')).toBe('1');
    expect(body.origin).toBeNull();
    // The page's forwarded form DOES resolve, which is what makes the above a routing decision
    // rather than a second dead param.
    const forwarded = await call('postal=V6X+1A1&signedIn=1');
    expect(forwarded.origin?.mode).toBe('saved_home');
  });
});

describe('FILTER PARAMS — a multi-select keeps every value it was sent', () => {
  it('region= is additive in BOTH spellings: csv, repeated, and the union of the singles', async () => {
    // The array-drop this pins: `region=van&region=bby` read through URLSearchParams.get() kept
    // 'van' alone, so a two-municipality search silently returned one municipality's listings.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      pinClock(clock);
      const van = slotIdsOf(await call('region=van'));
      const bby = slotIdsOf(await call('region=bby'));
      const union = sorted(new Set([...van, ...bby]));
      for (const spelling of ['region=van,bby', 'region=van&region=bby']) {
        const both = sorted(slotIdsOf(await call(spelling)));
        checked += 1;
        if (both.join('|') !== union.join('|')) {
          violations.push({
            clock: clock.label,
            query: spelling,
            detail:
              `${spelling} returned ${both.length} occurrence(s), the union of the single-chip searches has ${union.length} ` +
              `(van=${van.size}, bby=${bby.size}) — values are being dropped`,
          });
        }
        const applied = selectedAreas(await call(spelling));
        if (applied.join(',') !== 'bby,van') {
          violations.push({
            clock: clock.label,
            query: spelling,
            detail: `${spelling}: the areas facet reports [${applied.join(', ')}] applied, not both chips`,
          });
        }
      }
      // Non-vacuity: the two municipalities must actually hold different listings here, or the
      // union above would be satisfied by dropping one of them.
      if (sorted(van).join('|') === sorted(bby).join('|')) {
        violations.push({
          clock: clock.label,
          query: 'region=van vs region=bby',
          detail: 'the two chips return the same occurrences — the fixture catalogue cannot exercise the union',
        });
      }
    }
    pinClock(CLOCKS[0]);
    expectInvariant('multi-value region params keep every value', violations, checked);
  });

  it('age= is additive in BOTH spellings (the same reader, the same defect)', async () => {
    const csv = await call('age=5-9,10-14');
    const repeated = await call('age=5-9&age=10-14');
    expect(csv.context.ageBands).toEqual(['5-9', '10-14']);
    expect(repeated.context.ageBands).toEqual(['5-9', '10-14']);
  });
});

describe('FILTER PARAMS — the page vocabulary and the API vocabulary agree', () => {
  it('`reg=1` and `includeRegistration=1` mean the same thing to the API', async () => {
    // Every other chip param is spelled identically on both sides; registration was the one that
    // was not, which is exactly how it stayed unread. Both spellings, one meaning.
    const viaPage = await call('reg=1');
    const viaApi = await call('includeRegistration=1');
    const off = await call('');
    expect(viaPage.context.includeRegistration).toBe(true);
    expect(viaApi.context.includeRegistration).toBe(true);
    expect(off.context.includeRegistration).toBe(false);
  });

  it('an explicit includeRegistration=0 is not overridden by a stale reg=1 in the same URL', async () => {
    const body = await call('includeRegistration=0&reg=1');
    expect(body.context.includeRegistration).toBe(false);
  });
});
