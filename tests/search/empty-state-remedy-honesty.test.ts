// tests/search/empty-state-remedy-honesty.test.ts
//
// The graceful-decline remedy — "we found nothing/little, and HERE IS WHY" — had three
// defects that all pointed the same way: the surface that is supposed to explain a thin
// result set was itself inaccurate. Each is pinned below.
//
// They were rare before and are about to be common. The Free filter's whole doctrine is that
// a priced activity is never an acceptable answer to a Free query (see
// broaden-never-drops-free.test.ts), which means a thin-or-empty confirmed set is the NORMAL
// outcome of a Free search rather than an edge case — and every one of those searches lands on
// this remedy. An explanation that names the wrong constraint, or overstates what relaxing it
// would buy, is worse than silence: it sends a parent to un-tick a filter that was not the
// problem.
//
//   (b) BLOCKING CONSTRAINT WAS PICKED BY A FIXED LIST, NOT BY IMPACT. `explainEmptyState`'s
//       contract is "the constraint whose removal yields the most", but it sorted by a
//       hard-coded priority ordering and used yield only to break ties. Radius sat at the top
//       of that list and costFree near the bottom, so a query blocked overwhelmingly by Free
//       and incidentally by radius reported "distance" and never mentioned Free at all.
//
//   (c) "RELAXING IT SHOWS N MORE" REPORTED THE ABSOLUTE TOTAL, NOT THE ADDITION. Correct only
//       when starting from zero — and the engine computes this explanation for a THIN set too
//       (`scored.length < minResults`), where it overstated the remedy by exactly the number of
//       results the parent could already see.
//
//   (a) THE PAGE RENDERED IT ONLY WHEN total === 0, where `total` counts the expected/seasonal
//       section as well. So the moment the expected section had anything in it, a query whose
//       confirmed results a filter had emptied went unexplained. The engine-side half of that
//       is pinned here (the payload really does carry an explanation in that shape); the
//       placement itself lives in app/search/page.tsx next to the broadening notice.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { explainEmptyState, type ConstraintKey } from '@/lib/search/broaden';
import { describeBroadening, type AppliedRungDto } from '@/app/search/_lib/broadening-notice';
import type { ListingRecord, SearchContext } from '@/lib/search/types';

function engineFor(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
  });
}

/**
 * A minimal context with only the constraints a case actually needs switched on.
 *
 * `radiusKm` defaults to 20 because 20 is the point at which the radius stops being an ACTIVE
 * constraint (see `activeConstraints`). A default of 10 would silently add a second competitor
 * to every case here, which is exactly the kind of accidental extra arm these tests exist to
 * catch — cases that mean to exercise radius set it explicitly.
 */
function ctxWith(patch: Partial<SearchContext>): SearchContext {
  return {
    terms: [],
    widenText: false,
    radiusKm: 20,
    timeOfDay: null,
    timeOfDayAdjacent: false,
    date: null,
    bookableNow: false,
    rainyDay: false,
    dropIn: false,
    costFree: false,
    ageBands: [],
    includeExpected: false,
    includeRegistration: false,
    sort: 'best_match',
    ...patch,
  } as SearchContext;
}

describe('(b) the blocking constraint is the one with the most IMPACT, not the one highest in a list', () => {
  // radius sat at priority 1 and costFree at priority 7. Yield decided nothing but ties.
  const YIELDS: Record<string, number> = { radius: 1, costFree: 40 };

  it('names Free over distance when Free is what is actually blocking the query', () => {
    const explained = explainEmptyState(
      ctxWith({ radiusKm: 10, costFree: true }),
      (variant) => {
        // The probe sees a context with exactly one constraint relaxed; identify which.
        if (variant.radiusKm > 10) return YIELDS.radius;
        if (!variant.costFree) return YIELDS.costFree;
        return 0;
      },
    );

    // Under the fixed list this returned 'radius' — a one-result relaxation reported as the
    // main thing narrowing a query that forty results were waiting behind.
    expect(explained.blockingConstraint).toBe<ConstraintKey>('costFree');
    expect(explained.message).toContain('Free filter');
    expect(explained.message).not.toContain('distance');
    expect(explained.message).toContain('40 more');
  });

  it('still names distance when distance really is the biggest unlock', () => {
    // The fix must not simply invert the old bias — the ranking has to follow the measurement.
    const explained = explainEmptyState(
      ctxWith({ radiusKm: 10, costFree: true }),
      (variant) => (variant.radiusKm > 10 ? 40 : !variant.costFree ? 1 : 0),
    );
    expect(explained.blockingConstraint).toBe<ConstraintKey>('radius');
    expect(explained.message).toContain('distance');
  });

  it('keeps `text` a last resort, never a competitor on raw yield', () => {
    // Relaxing the search terms abandons the question rather than unblocking it, and it almost
    // always "wins" on count (an unfiltered catalogue beats every real answer). Ranking by
    // yield must not promote it: 500 > 3, and the honest advice is still the Free filter.
    const explained = explainEmptyState(
      ctxWith({ terms: ['swim'], costFree: true }),
      (variant) => (variant.terms.length === 0 ? 500 : !variant.costFree ? 3 : 0),
    );
    expect(explained.blockingConstraint).toBe<ConstraintKey>('costFree');
  });

  it('falls back to `text` when no filter relaxation adds anything', () => {
    const explained = explainEmptyState(
      ctxWith({ terms: ['xylophone'], costFree: true }),
      (variant) => (variant.terms.length === 0 ? 12 : 0),
    );
    expect(explained.blockingConstraint).toBe<ConstraintKey>('text');
  });

  it('is deterministic when two constraints would add exactly the same amount', () => {
    const run = () =>
      explainEmptyState(ctxWith({ radiusKm: 10, dropIn: true }), (variant) =>
        variant.radiusKm > 10 || !variant.dropIn ? 5 : 0,
      ).blockingConstraint;
    expect(run()).toBe(run());
    expect(run()).toBe<ConstraintKey>('radius'); // the fixed list survives ONLY as a tie-break
  });
});

describe('(c) "relaxing it shows N more" is an ADDITION to what is on screen, not a total', () => {
  it('reports the delta when the parent already has results', () => {
    // 2 results now; relaxing Free would give 5. The remedy is worth THREE more, not five.
    const explained = explainEmptyState(ctxWith({ costFree: true }), () => 5, { baseline: 2 });
    expect(explained.message).toContain('3 more');
    expect(explained.message).not.toContain('5 more');
    expect(explained.singleRelaxations[0]).toMatchObject({ wouldYield: 5, addsResults: 3 });
  });

  it('says how many exact matches there actually are, rather than claiming none', () => {
    // The lede is part of the same defect: moving this notice out of the `total === 0` branch
    // (fix (a)) puts it on pages that DO have matches, where "No exact matches" would be a
    // fresh lie told by the sentence meant to end them.
    expect(explainEmptyState(ctxWith({ costFree: true }), () => 5, { baseline: 2 }).message).toContain('Only 2 exact matches');
    expect(explainEmptyState(ctxWith({ costFree: true }), () => 5, { baseline: 1 }).message).toContain('Only 1 exact match');
    expect(explainEmptyState(ctxWith({ costFree: true }), () => 5, { baseline: 0 }).message).toContain('No exact matches');
  });

  it('does not offer a relaxation that adds nothing', () => {
    // Relaxing to the same count is not a remedy, however large the total looks.
    const explained = explainEmptyState(ctxWith({ costFree: true }), () => 4, { baseline: 4 });
    expect(explained.blockingConstraint).toBeNull();
    expect(explained.message).toContain('adds nothing');
  });

  it('is unchanged for the zero-result case — delta and total coincide there', () => {
    const explained = explainEmptyState(ctxWith({ costFree: true }), () => 6, { baseline: 0 });
    expect(explained.message).toBe(
      'No exact matches. Relaxing the Free filter shows 6 more — it is the main thing narrowing your results.',
    );
  });

  it('keeps the sentence grammatical for a PLURAL constraint label', () => {
    // "The search terms is the main thing narrowing your results" — the old template made the
    // constraint the subject, so every plural label disagreed with its verb. Nearly invisible
    // while this rendered only at total===0; not once the page shows it for thin results too.
    const explained = explainEmptyState(ctxWith({ terms: ['swim'] }), () => 9, { baseline: 0 });
    expect(explained.blockingConstraint).toBe<ConstraintKey>('text');
    expect(explained.message).toContain('Relaxing the search terms shows 9 more');
    expect(explained.message).not.toContain('search terms is');
  });

  it('THE ENGINE ACTUALLY PASSES THE BASELINE — not just the function that accepts one', () => {
    // Without this the whole delta fix is unpinned end-to-end: `explainEmptyState` can take a
    // baseline, be tested with one directly, and still be called with nothing by its only
    // production caller. Reverting engine.ts to `explainEmptyState(ctx0, probe)` reddens here
    // and nowhere else.
    //
    // Two genuinely free swim sessions, three priced ones. minResults 3 makes this the THIN
    // case rather than the empty one: the parent can see 2, and dropping Free would show 5.
    const free = (id: string) =>
      makeListing({
        id,
        activityName: 'Public Swim',
        costStatus: 'free',
        startDatetimeUtc: '2026-07-13T20:00:00Z',
        seriesId: `${id}-series`,
      });
    const priced = (id: string) =>
      makeListing({
        id,
        activityName: 'Public Swim',
        costStatus: 'known',
        costMinCad: 7,
        costMaxCad: 7,
        startDatetimeUtc: '2026-07-13T20:00:00Z',
        seriesId: `${id}-series`,
      });
    const res = engineFor([
      free('base-free-1'),
      free('base-free-2'),
      priced('base-paid-1'),
      priced('base-paid-2'),
      priced('base-paid-3'),
    ]).search({ q: 'swim free', now: FIXTURE_NOW, minResults: 3, limit: 100 });

    expect(res.results).toHaveLength(2);
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('costFree');
    // 5 total minus the 2 already on screen. Reporting the total here told a parent that
    // un-ticking Free would show five more than they had, when it would show three.
    expect(res.broadening.emptyState?.message).toContain('Only 2 exact matches');
    expect(res.broadening.emptyState?.message).toContain('3 more');
    expect(res.broadening.emptyState?.message).not.toContain('5 more');
  });
});

describe('(a) a query whose CONFIRMED results were emptied still carries an explanation', () => {
  // The production repro: /search?free=1&region=nvan returned blockingConstraint 'costFree'
  // and a full message in the JSON, while the page rendered a screen of expected-section cards
  // and no reason at all — because it gated the notice on `confirmed + expected === 0`.
  const PAID_CONFIRMED = makeListing({
    id: 'remedy-paid',
    activityName: 'Public Swim',
    costStatus: 'known',
    costMinCad: 7,
    costMaxCad: 7,
    startDatetimeUtc: '2026-07-13T20:00:00Z',
  });
  const UNPRICED_PRESEASON = makeListing({
    id: 'remedy-preseason',
    activityName: 'Outdoor Pool Summer Season',
    costStatus: 'unknown',
    statusState: 'seasonal_preseason',
    startDatetimeUtc: '2026-07-13T20:00:00Z',
  });

  it('explains itself even though the expected section filled the page', () => {
    const res = engineFor([PAID_CONFIRMED, UNPRICED_PRESEASON]).search({
      q: 'free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });

    // The exact shape the page used to swallow: nothing confirmed, something to render.
    expect(res.results).toHaveLength(0);
    expect(res.expected.length).toBeGreaterThan(0);

    // The engine's half of the contract — the page reads `emptyState.message` and now renders
    // it whenever it is present, next to the broadening notice, rather than only at zero.
    expect(res.broadening.emptyState).not.toBeNull();
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('costFree');
    expect(res.broadening.emptyState?.message).toContain('Free filter');
  });

  it('and the priced confirmed listing is still nowhere in either section', () => {
    const res = engineFor([PAID_CONFIRMED, UNPRICED_PRESEASON]).search({
      q: 'free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    const shown = [...res.results, ...res.expected].map((r) => r.listing.id);
    expect(shown).not.toContain('remedy-paid');
    expect(shown).toContain('remedy-preseason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four ways this fix goes wrong, each measured on shipped main before the fix
// and each pinned here. They are grouped because they share one root: the empty-state
// explanation is a REMEDY, and a remedy that fires when nothing is wrong, names a
// constraint that filters nothing, or is silenced in the one case it exists for, is
// not a smaller version of the right behaviour — it is a different defect.
// ─────────────────────────────────────────────────────────────────────────────

describe('a radius that cannot filter anything is never named as the blocker', () => {
  it('does not name distance on an ORIGINLESS search, however narrow radiusKm looks', () => {
    // `withinRadius` only runs when an origin resolved (filters/predicate.ts), so on an
    // originless search `radiusKm: 10` is a setting, not a constraint. `activeConstraints`
    // pushed it anyway — the sibling of the rung that 707fda6 gated on `hasOrigin`, left
    // ungated — so the explanation went on blaming "distance" for searches that were never
    // distance-filtered. Removing the `opts.hasOrigin !== false` guard reddens this.
    const explained = explainEmptyState(
      ctxWith({ radiusKm: 10, costFree: true }),
      (variant) => (!variant.costFree ? 7 : 0),
      { hasOrigin: false },
    );
    expect(explained.singleRelaxations.map((r) => r.constraint)).not.toContain('radius');
    expect(explained.blockingConstraint).toBe<ConstraintKey>('costFree');
    expect(explained.message).not.toContain('distance');
  });

  it('still offers distance when an origin really did resolve', () => {
    const explained = explainEmptyState(
      ctxWith({ radiusKm: 10 }),
      () => 7,
      { hasOrigin: true },
    );
    expect(explained.blockingConstraint).toBe<ConstraintKey>('radius');
  });
});

describe('a page that is merely SHORT of its minimum is not a page with a problem', () => {
  // The browse page asks for 60 results. A perfectly good page of 14 is "too few" by that
  // measure and lands in the same branch as a genuinely empty search — so the naive version
  // of the render fix ("just drop the total === 0 guard") published a remedy for a page with
  // nothing wrong with it: "No exact matches ... relaxing it shows 14 more", where there ARE
  // matches and 14 is the current total rather than an increment.
  const freeSwim = (id: string) =>
    makeListing({
      id,
      activityName: 'Public Swim',
      costStatus: 'free',
      startDatetimeUtc: '2026-07-13T20:00:00Z',
      seriesId: `${id}-series`,
    });

  it('emits NO explanation for a bare browse whose only fault is a high minResults', () => {
    const res = engineFor([freeSwim('browse-1'), freeSwim('browse-2'), freeSwim('browse-3')]).search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 60,
      limit: 100,
    });
    expect(res.results.length).toBeGreaterThan(0); // the page is fine
    expect(res.broadening.emptyState).toBeNull(); // ...so there is nothing to remedy
  });

  it('still explains a genuinely EMPTY set, even when no single relaxation would help', () => {
    // The other side of the same guard: a blank page always gets an answer, and "widening one
    // filter will not change this" is a legitimate one. Suppressing on `blockingConstraint ==
    // null` alone would have silenced exactly the searches that most need explaining.
    const res = engineFor([freeSwim('lonely-1')]).search({
      q: 'trampoline',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    expect(res.results).toHaveLength(0);
    expect(res.broadening.emptyState).not.toBeNull();
    expect(res.broadening.emptyState?.message).toBeTruthy();
  });
});

describe('the Free decline explains itself WITHOUT the broadening notice', () => {
  it('emptyState names the Free filter while describeBroadening() stays null', () => {
    // The tempting guard for the render fix is "only show the explanation when the broadening
    // notice is showing". It is wrong, and it fails in precisely the case this unit exists to
    // protect. The two mechanisms are ANTI-CORRELATED here: the notice reports what the ladder
    // CHANGED, and on a Free decline the ladder deliberately changes nothing it could report —
    // it reaches `expected_section`, which describeBroadening treats as silent by design. The
    // explanation, meanwhile, is present and correct. Gate one on the other and the app goes
    // quiet in the one case where it has something true and useful to say.
    const priced = (id: string) =>
      makeListing({
        id,
        activityName: 'Public Swim',
        costStatus: 'known',
        costMinCad: 7,
        costMaxCad: 7,
        startDatetimeUtc: '2026-07-13T20:00:00Z',
        seriesId: `${id}-series`,
      });
    const res = engineFor([priced('decline-1'), priced('decline-2')]).search({
      q: 'swim free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });

    // The honest decline: nothing free here, and nothing priced smuggled in to pad it.
    expect(res.results).toHaveLength(0);
    expect(res.expected).toHaveLength(0);

    // The notice has nothing to report — every rung that fired was a silent one.
    expect(describeBroadening(res.broadening.applied as AppliedRungDto[])).toBeNull();

    // ...and the explanation carries the whole disclosure on its own.
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('costFree');
    expect(res.broadening.emptyState?.message).toContain('Free filter');
  });
});
