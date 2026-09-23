// tests/sms/weekly_picks_destination_slot.test.ts — the guaranteed "destination" pick in the
// Friday text (Jon's approval of 2026-09-23, D1–D5).
//
// Spec: documents/kids-fun/weekly-picks-destination-slot-PROPOSAL-2026-09-23.md §3 (mechanism) and
// §4 (the reach window and the age-fit rules B1–B5). Implementation: `applyDestinationSlot` in
// lib/sms/weekly-picks.ts.
//
// TWO LAYERS, ON PURPOSE.
//   • `applyDestinationSlot` directly, over hand-built items. This is where every rule is pinned,
//     because only a hand-built ten can put a band's SOLE representative exactly at the bottom, or
//     two picks at one venue exactly where the victim scan will look.
//   • `selectWeeklyPicks` over a fixture-backed REAL SearchEngine (the harness weekly_picks.test.ts
//     uses: no DB, no network, a passed clock). This is where the wiring is pinned — that the one
//     widened search really is a second engine call at the right radius and window, that the slot
//     never changes WHETHER a week sends, and that D3 reaches it from a real subscriber row.
//
// The dedicated guard for `MAX_FORCED_PICKS < DIRECT_LINK_PICKS` is the FIRST describe block and is
// deliberately NOT folded into the placement tests: if it fails, its name is the diagnosis.
import { describe, expect, it, vi } from 'vitest';
import { SearchEngine, type SearchResultItem } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { AgeBandKey, GeoPoint, ListingRecord } from '@/lib/search/types';
import {
  DESTINATION_CATEGORY_KEYS,
  DIRECT_LINK_PICKS,
  MAX_FORCED_PICKS,
  MAX_PICKS,
  MAX_PICKS_PER_VENUE,
  applyDestinationSlot,
  buildDestinationWidenRequest,
  buildPicksRequest,
  destinationSlotApplies,
  isDestinationPick,
  selectWeeklyPicks,
  spreadNamedSlots,
  type DestinationSlotInput,
  type DestinationSlotOutcome,
  type WeeklyPicksInput,
} from '@/lib/sms/weekly-picks';

// ═════════════════════════════════════════════════════════════════════════════
// THE GUARD — read this first if it fails.
// ═════════════════════════════════════════════════════════════════════════════

describe('GUARD: MAX_FORCED_PICKS < DIRECT_LINK_PICKS (the destination slot is only linked while this holds)', () => {
  it('MAX_FORCED_PICKS is strictly less than DIRECT_LINK_PICKS', () => {
    // The destination pick is seated directly BEHIND the age-forced picks. There are at most
    // MAX_FORCED_PICKS of those, so it lands at index MAX_FORCED_PICKS at worst — which is a LINKED
    // slot only while MAX_FORCED_PICKS < DIRECT_LINK_PICKS. Unlike applyCoverageSwap's FRONT
    // placement, this is NOT tuning-independent (independent QA c8b5's correction to the proposal).
    //
    // IF THIS FAILS: someone raised MAX_FORCED_PICKS or lowered DIRECT_LINK_PICKS. Do NOT edit this
    // test to pass. Either restore the inequality, or change applyDestinationSlot to seat the
    // destination pick at the FRONT of the selection — otherwise the "guaranteed" destination pick
    // silently ships unlinked on any week with MAX_FORCED_PICKS age-forced picks.
    expect(
      MAX_FORCED_PICKS < DIRECT_LINK_PICKS,
      `MAX_FORCED_PICKS (${MAX_FORCED_PICKS}) must be < DIRECT_LINK_PICKS (${DIRECT_LINK_PICKS}) — ` +
        'the destination slot seats its pick behind the age-forced picks and would stop being linked'
    ).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Hand-built items for the unit layer.
// ═════════════════════════════════════════════════════════════════════════════

/** Words with no shared trigrams worth speaking of, so no two titles ever read as one activity. */
const WORDS = [
  'Splash', 'Story', 'Lego', 'Puppet', 'Nature', 'Music', 'Romp', 'Studio', 'Chess', 'Dance',
  'Science', 'Yoga', 'Forest', 'Rodeo', 'Marble', 'Drama', 'Coding', 'Garden', 'Climbing',
  'Karate', 'Pottery', 'Film', 'Birding', 'Kites', 'Robots', 'Magic', 'Circus', 'Painting',
  'Origami', 'Archery', 'Fencing', 'Juggling', 'Stars', 'Fossils', 'Trains', 'Boats', 'Bugs',
  'Weaving', 'Clay', 'Drums', 'Mazes',
];

interface ItemSpec {
  cat?: string;
  bands?: AgeBandKey[];
  venue?: string;
  km?: number | null;
  title?: string;
}

let wordCursor = 0;
function item(id: string, spec: ItemSpec = {}): SearchResultItem {
  const listing: ListingRecord = makeListing({
    id,
    activityName: spec.title ?? `${WORDS[wordCursor++ % WORDS.length]} ${id}`,
    primaryCategoryKey: spec.cat ?? `type-${id}`, // unique by default — no category collisions
    ageBandMatches: spec.bands ?? ['2-4', '5-9'],
    ageMinMonths: 24,
    ageMaxMonths: 120,
    venueName: spec.venue ?? `Venue ${id}`,
    statusState: 'confirmed',
  });
  return {
    listing,
    score: 1,
    distanceKm: spec.km === undefined ? 1 : spec.km,
    components: {} as SearchResultItem['components'],
    matchedAliases: [],
    slots: [
      {
        id,
        startDatetimeUtc: listing.startDatetimeUtc,
        endDatetimeUtc: listing.endDatetimeUtc,
        costStatus: listing.costStatus,
        costMinCad: listing.costMinCad,
        costMaxCad: listing.costMaxCad,
        ageMinMonths: listing.ageMinMonths,
        ageMaxMonths: listing.ageMaxMonths,
      },
    ],
    slotDays: [],
    slotSpanEndUtc: null,
    registrationRequired: false,
  };
}

/** `n` ordinary (non-destination) picks p0..p{n-1}, in rank order. */
function ordinary(n: number, spec: ItemSpec = {}): SearchResultItem[] {
  return Array.from({ length: n }, (_, i) => item(`p${i}`, spec));
}

const ids = (items: readonly SearchResultItem[]) => items.map((i) => i.listing.id);
const BANDS: AgeBandKey[] = ['2-4', '5-9'];

/**
 * A slot input. `ranked` defaults to the selection followed by `extra` — i.e. the pipeline's
 * `ordered` list, whose head is the ten. `widen` is a spy that returns nothing unless overridden.
 */
function slotInput(
  selection: SearchResultItem[],
  extra: SearchResultItem[] = [],
  over: Partial<DestinationSlotInput> = {}
): DestinationSlotInput & { widen: ReturnType<typeof vi.fn> } {
  const widen = vi.fn(() => ({ ranked: [] as SearchResultItem[], radiusKm: 20 }));
  return {
    selection,
    ageForcedIds: new Set<string>(),
    ranked: [...selection, ...extra],
    radiusKm: 10,
    widen,
    requestedBands: BANDS,
    interests: undefined,
    maxPicks: MAX_PICKS,
    sameParentOrg: () => false,
    ...over,
  } as DestinationSlotInput & { widen: ReturnType<typeof vi.fn> };
}

const destIndex = (selection: readonly SearchResultItem[]) => selection.findIndex(isDestinationPick);

// ═════════════════════════════════════════════════════════════════════════════
// D2 — what counts as a destination.
// ═════════════════════════════════════════════════════════════════════════════

describe('D2 — the destination set', () => {
  it('is exactly the six approved keys, and storytime is NOT one of them', () => {
    expect([...DESTINATION_CATEGORY_KEYS].sort()).toEqual(
      ['attraction', 'festival_event', 'miniature_train', 'museum_venue', 'outdoor_park', 'tobogganing'].sort()
    );
    expect(DESTINATION_CATEGORY_KEYS).not.toContain('storytime');
    expect(isDestinationPick(item('s', { cat: 'storytime' }))).toBe(false);
  });

  it('folds the key exactly as the category caps do (trim + lower-case)', () => {
    expect(isDestinationPick(item('m', { cat: '  Museum_Venue ' }))).toBe(true);
    expect(isDestinationPick(item('n', { cat: '' }))).toBe(false);
  });

  it('never treats a LINKED storytime pick as satisfying the slot, and never forces one in', () => {
    const selection = [item('story', { cat: 'storytime' }), ...ordinary(9)];
    const storyCandidate = item('story2', { cat: 'storytime' });
    const museum = item('museum', { cat: 'museum_venue' });
    const r = applyDestinationSlot(slotInput(selection, [storyCandidate, museum]));
    expect(r.summary.outcome).toBe('forced');
    expect(r.summary.occurrenceId).toBe('museum'); // the storytime candidate ranked higher and was passed over
    expect(ids(r.selection)).not.toContain('story2');
  });

  it('with ONLY storytime available, the slot goes unfilled rather than calling storytime a destination', () => {
    const r = applyDestinationSlot(slotInput(ordinary(10), [item('story', { cat: 'storytime' })]));
    expect(r.summary.outcome).toBe('unfilled');
    expect(r.summary.reason).toBe('no_candidate');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D3 — stated interests.
// ═════════════════════════════════════════════════════════════════════════════

describe('D3 — a subscriber whose interests name no destination type is excluded from the slot', () => {
  it('destinationSlotApplies: none / blank = applies; destination named = applies; none named = not', () => {
    expect(destinationSlotApplies(undefined)).toBe(true);
    expect(destinationSlotApplies([])).toBe(true);
    expect(destinationSlotApplies(['  '])).toBe(true);
    expect(destinationSlotApplies(['public_swim', 'Museum_Venue '])).toBe(true);
    expect(destinationSlotApplies(['public_swim', 'skate'])).toBe(false);
    expect(destinationSlotApplies(['storytime'])).toBe(false); // D2 and D3 together
  });

  it('never fills the slot for a swim-only subscriber, even with a perfect museum candidate', () => {
    const inp = slotInput(ordinary(10, { cat: 'public_swim' }), [item('museum', { cat: 'museum_venue' })], {
      interests: ['public_swim'],
    });
    const r = applyDestinationSlot(inp);
    expect(r.summary).toMatchObject({ outcome: 'not_applicable', reason: 'interests_exclude_destinations' });
    expect(ids(r.selection)).not.toContain('museum');
    expect(inp.widen).not.toHaveBeenCalled(); // not even a search is spent on them
  });

  it('when interests DO name a destination type, the forced pick must be one they asked for', () => {
    const attraction = item('attraction', { cat: 'attraction' }); // ranked higher, but not asked for
    const museum = item('museum', { cat: 'museum_venue' });
    const r = applyDestinationSlot(
      slotInput(ordinary(10), [attraction, museum], { interests: ['public_swim', 'museum_venue'] })
    );
    expect(r.summary.occurrenceId).toBe('museum');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The three ways the slot is satisfied, and the two ways it is not.
// ═════════════════════════════════════════════════════════════════════════════

describe('already_linked — nothing changes', () => {
  it('returns the baseline spread byte-for-byte and never searches', () => {
    const selection = [item('a'), item('museum', { cat: 'museum_venue' }), ...ordinary(8)];
    const inp = slotInput(selection, [item('other-museum', { cat: 'museum_venue' })]);
    const r = applyDestinationSlot(inp);
    const baseline = spreadNamedSlots(selection, new Set(), DIRECT_LINK_PICKS, BANDS);
    expect(r.summary.outcome).toBe('already_linked');
    expect(r.summary.occurrenceId).toBe('museum');
    expect(r.selection).toEqual(baseline.selection);
    expect(r.promoted).toEqual(baseline.promoted);
    expect(inp.widen).not.toHaveBeenCalled();
  });
});

describe('already_linked is judged on the SPREAD order — the text that would actually be sent (pinned choice #9)', () => {
  it('a destination the baseline spread moves OUT of the named block is NOT "already linked": it is promoted back in', () => {
    // Pre-spread, the museum is in slot 1. But `spreadNamedSlots` phase 1 (age-band fairness)
    // vacates slot 1 for the ONLY 10–14 pick, because the museum's bands are covered by the other
    // two named picks — so in the text that would have been sent, the museum is unlinked. Judging
    // "already linked" on the pre-spread order would return that baseline and silently ship the
    // week with no linked destination. Judged on the baseline spread (the pinned choice), it is
    // promoted and seated in a linked slot, and the 10–14 child keeps a link too.
    const museum = item('museum', { cat: 'museum_venue' });
    const selection = [
      museum,
      ...ordinary(4),
      item('teen-only', { bands: ['10-14'] }),
      ...Array.from({ length: 4 }, (_, i) => item(`r${i}`)),
    ];
    const requested: AgeBandKey[] = ['2-4', '5-9', '10-14'];
    // Precondition — the spread alone really does push the museum out of the links.
    const baseline = spreadNamedSlots(selection, new Set(), DIRECT_LINK_PICKS, requested);
    expect(ids(baseline.selection).indexOf('museum')).toBeGreaterThanOrEqual(DIRECT_LINK_PICKS);

    const r = applyDestinationSlot(slotInput(selection, [], { requestedBands: requested }));
    expect(r.summary.outcome).toBe('promoted');
    expect(ids(r.selection).indexOf('museum')).toBeLessThan(DIRECT_LINK_PICKS);
    expect(ids(r.selection).slice(0, DIRECT_LINK_PICKS)).toContain('teen-only');
    expect([...ids(r.selection)].sort()).toEqual([...ids(selection)].sort()); // still a pure reorder
  });
});

describe('promoted — in the ten but unlinked: a pure reorder', () => {
  it('moves it into a linked slot; the ten stay the same ten', () => {
    const selection = [...ordinary(6), item('museum', { cat: 'museum_venue' }), ...ordinary(3).map((x, i) => item(`q${i}`))];
    const inp = slotInput(selection);
    const r = applyDestinationSlot(inp);
    expect(r.summary.outcome).toBe('promoted');
    expect(r.summary.displacedOccurrenceId).toBeNull();
    expect(destIndex(r.selection)).toBeLessThan(DIRECT_LINK_PICKS);
    expect([...ids(r.selection)].sort()).toEqual([...ids(selection)].sort());
    expect(inp.widen).not.toHaveBeenCalled();
  });

  it('with more than one unlinked destination in the ten, promotes the HIGHEST-ranked one', () => {
    const selection = [
      ...ordinary(5),
      item('festival', { cat: 'festival_event' }), // rank 6
      ...Array.from({ length: 2 }, (_, i) => item(`q${i}`)),
      item('museum', { cat: 'museum_venue' }), // rank 9
      item('q9'),
    ];
    const r = applyDestinationSlot(slotInput(selection));
    expect(r.summary.occurrenceId).toBe('festival');
    expect(r.selection.slice(0, DIRECT_LINK_PICKS).map((x) => x.listing.id)).toContain('festival');
    expect(ids(r.selection).indexOf('museum')).toBeGreaterThanOrEqual(DIRECT_LINK_PICKS); // only ONE is moved
  });
});

describe('forced — none in the ten', () => {
  it('reaches the WHOLE ranked list — no top-20 cap (proposal §4a)', () => {
    const selection = ordinary(10);
    const deep = Array.from({ length: 25 }, (_, i) => item(`deep${i}`)); // ranks 11..35
    const museum = item('museum', { cat: 'museum_venue', km: 4.2 }); // rank 36
    const inp = slotInput(selection, [...deep, museum]);
    const r = applyDestinationSlot(inp);
    expect(r.summary).toMatchObject({ outcome: 'forced', occurrenceId: 'museum', rankDepth: 36, distanceKm: 4.2, radiusKm: 10, widenedSearch: false });
    expect(inp.widen).not.toHaveBeenCalled(); // inside the radius → no second search
  });

  it('displaces the lowest-ranked pick when nothing forbids it, and seats the destination in slot 1', () => {
    const r = applyDestinationSlot(slotInput(ordinary(10), [item('museum', { cat: 'museum_venue' })]));
    expect(r.summary.displacedOccurrenceId).toBe('p9');
    expect(ids(r.selection)).not.toContain('p9');
    expect(r.selection[0].listing.id).toBe('museum');
  });

  it('adds at most ONE destination, however many candidates there are', () => {
    const extras = ['museum_venue', 'attraction', 'festival_event', 'outdoor_park'].map((cat, i) => item(`d${i}`, { cat }));
    const r = applyDestinationSlot(slotInput(ordinary(10), extras));
    expect(r.selection.filter(isDestinationPick)).toHaveLength(1);
  });
});

describe('forced_widened / unfilled — the one widened search', () => {
  it('widens ONCE when nothing inside the radius qualifies, and records the wider radius', () => {
    const far = item('far-museum', { cat: 'museum_venue', km: 13.4 });
    const inp = slotInput(ordinary(10), [], {
      widen: vi.fn(() => ({ ranked: [...ordinary(10), item('x'), far], radiusKm: 20 })),
    });
    const r = applyDestinationSlot(inp);
    expect(inp.widen).toHaveBeenCalledTimes(1);
    expect(r.summary).toMatchObject({ outcome: 'forced_widened', occurrenceId: 'far-museum', radiusKm: 20, rankDepth: 12, distanceKm: 13.4, widenedSearch: true });
    expect(destIndex(r.selection)).toBeLessThan(DIRECT_LINK_PICKS);
  });

  it('goes unfilled — honestly, with the ten untouched — when even one step out has nothing', () => {
    const selection = ordinary(10);
    const inp = slotInput(selection);
    const r = applyDestinationSlot(inp);
    expect(inp.widen).toHaveBeenCalledTimes(1);
    expect(r.summary).toMatchObject({ outcome: 'unfilled', reason: 'no_candidate', occurrenceId: null, widenedSearch: true });
    expect(r.selection).toEqual(spreadNamedSlots(selection, new Set(), DIRECT_LINK_PICKS, BANDS).selection);
  });

  it('never seats a widened candidate that is another sitting of a pick already in the ten', () => {
    // The widened list was deduped against itself, not against this week's ten.
    const selection = [...ordinary(9), item('swim', { cat: 'public_swim', venue: 'Harbour Park', title: 'Harbour Park Open Swim' })];
    const sameOffering = item('park', { cat: 'outdoor_park', venue: 'Harbour Park', title: 'Harbour Park Open Swim' });
    const inp = slotInput(selection, [], { widen: vi.fn(() => ({ ranked: [sameOffering], radiusKm: 20 })) });
    const r = applyDestinationSlot(inp);
    expect(r.summary.outcome).toBe('unfilled');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4b — the age-fit rules, one at a time.
// ═════════════════════════════════════════════════════════════════════════════

describe('B1 — the destination pick covers at least one requested band', () => {
  it('NEGATIVE: a destination covering none of the family\'s bands is never forced, even ranked first', () => {
    const teen = item('teen-museum', { cat: 'museum_venue', bands: ['10-14'] });
    const r = applyDestinationSlot(slotInput(ordinary(10), [teen]));
    expect(r.summary.outcome).toBe('unfilled');
    expect(ids(r.selection)).not.toContain('teen-museum');
  });

  it('POSITIVE: one covering a single requested band qualifies', () => {
    const one = item('toddler-museum', { cat: 'museum_venue', bands: ['2-4'] });
    const r = applyDestinationSlot(slotInput(ordinary(10), [one]));
    expect(r.summary).toMatchObject({ outcome: 'forced', occurrenceId: 'toddler-museum', bandsCovered: 1 });
  });
});

describe('B2 — most requested bands first; ties by rank in the pipeline `ordered` list', () => {
  it('POSITIVE: prefers the candidate covering MORE bands over a higher-ranked one covering fewer', () => {
    const higherOneBand = item('one', { cat: 'museum_venue', bands: ['2-4'] });
    const lowerBothBands = item('both', { cat: 'attraction', bands: ['2-4', '5-9'] });
    const r = applyDestinationSlot(slotInput(ordinary(10), [higherOneBand, lowerBothBands]));
    expect(r.summary.occurrenceId).toBe('both');
  });

  it('ties are broken by position in `ranked` — not by distance, not by category', () => {
    // The nearer museum sits LOWER in `ranked`. The pinned tie-break list is the pipeline's
    // `ordered` list, so the higher-ranked festival wins despite being farther away.
    const festival = item('festival', { cat: 'festival_event', km: 5.0 });
    const museum = item('museum', { cat: 'museum_venue', km: 0.9 });
    const r = applyDestinationSlot(slotInput(ordinary(10), [festival, museum]));
    expect(r.summary.occurrenceId).toBe('festival');

    const swapped = applyDestinationSlot(slotInput(ordinary(10), [museum, festival]));
    expect(swapped.summary.occurrenceId).toBe('museum');
  });
});

describe('B3 — the destination MAY cover fewer bands than the pick it displaces (the one licensed cost)', () => {
  it('POSITIVE: a one-band destination displaces a two-band pick, and the cost is reported', () => {
    // Every other band stays represented by the other nine, so B4 permits it.
    const r = applyDestinationSlot(slotInput(ordinary(10), [item('museum', { cat: 'museum_venue', bands: ['5-9'] })]));
    expect(r.summary).toMatchObject({ outcome: 'forced', bandsCovered: 1, displacedBandsCovered: 2 });
  });

  it('NEGATIVE (bounded): the licence is spent at most once — there is exactly one destination pick', () => {
    const extras = [item('m1', { cat: 'museum_venue', bands: ['5-9'] }), item('m2', { cat: 'attraction', bands: ['5-9'] })];
    const r = applyDestinationSlot(slotInput(ordinary(10), extras));
    expect(r.selection.filter(isDestinationPick)).toHaveLength(1);
    expect(r.selection).toHaveLength(10);
  });
});

describe('B4 — never leaves a requested band with zero picks; never displaces an age-forced pick', () => {
  const THREE: AgeBandKey[] = ['2-4', '5-9', '10-14'];

  it('POSITIVE: skips the natural lowest-ranked victim when it is a band\'s SOLE representative', () => {
    // p9 is the only pick for the 10–14-year-old. Displacing it would orphan that child.
    const selection = [...ordinary(9), item('teen-only', { bands: ['10-14'] })];
    const museum = item('museum', { cat: 'museum_venue', bands: ['2-4', '5-9'] });
    const r = applyDestinationSlot(slotInput(selection, [museum], { requestedBands: THREE }));
    expect(r.summary.outcome).toBe('forced');
    expect(r.summary.displacedOccurrenceId).toBe('p8'); // the next-lowest, NOT 'teen-only'
    expect(ids(r.selection)).toContain('teen-only');
    for (const band of THREE) {
      expect(r.selection.some((x) => x.listing.ageBandMatches.includes(band))).toBe(true);
    }
  });

  it('NEGATIVE: leaves the slot unfilled when EVERY possible victim is a band\'s sole representative', () => {
    // A six-pick text: two age-forced picks, then four picks that are each the ONLY one for their
    // band. No valid victim exists.
    const forced = Array.from({ length: 2 }, (_, i) => item(`f${i}`, { bands: ['5-9'] }));
    const soles = (['under2', '2-4', '10-14', '15+'] as AgeBandKey[]).map((b, i) => item(`sole${i}`, { bands: [b] }));
    const selection = [...forced, ...soles];
    const requested: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];
    const r = applyDestinationSlot(
      slotInput(selection, [item('museum', { cat: 'museum_venue', bands: ['5-9'] })], {
        requestedBands: requested,
        ageForcedIds: new Set(forced.map((f) => f.listing.id)),
        maxPicks: 6,
      })
    );
    expect(r.summary).toMatchObject({ outcome: 'unfilled', reason: 'no_displaceable_pick' });
    expect([...ids(r.selection)].sort()).toEqual([...ids(selection)].sort()); // nothing removed
  });

  it('never displaces an age-forced pick, even when it is the lowest-ranked pick in the ten', () => {
    const selection = ordinary(10);
    const r = applyDestinationSlot(
      slotInput(selection, [item('museum', { cat: 'museum_venue' })], {
        ageForcedIds: new Set(['p9', 'p8']), // pathological placement on purpose — they must still be skipped
      })
    );
    expect(r.summary.displacedOccurrenceId).toBe('p7');
    expect(ids(r.selection)).toEqual(expect.arrayContaining(['p8', 'p9']));
  });

  it('skips a candidate that cannot be seated and seats a LATER one that covers the band it would orphan', () => {
    // A four-pick text (maxPicks 4): two age-forced picks, then the SOLE 10–14 pick and the SOLE
    // 5–9 pick. The higher-ranked museum covers only 2–4, so displacing either organic pick would
    // orphan a child → it cannot be seated. The lower-ranked attraction covers 5–9 itself, so it
    // can displace the sole 5–9 pick without orphaning anyone. B2 tries the museum first (tie on
    // band count, higher rank); B4 moves on rather than giving up.
    const f0 = item('f0', { bands: ['2-4'] });
    const f1 = item('f1', { bands: ['2-4'] });
    const teen = item('teen-only', { bands: ['10-14'] });
    const kid = item('kid-only', { bands: ['5-9'] });
    const museum = item('museum', { cat: 'museum_venue', bands: ['2-4'] });
    const attraction = item('attraction', { cat: 'attraction', bands: ['5-9'] });
    const r = applyDestinationSlot(
      slotInput([f0, f1, teen, kid], [museum, attraction], {
        requestedBands: ['2-4', '5-9', '10-14'],
        ageForcedIds: new Set(['f0', 'f1']),
        maxPicks: 4,
      })
    );
    expect(r.summary).toMatchObject({ outcome: 'forced', occurrenceId: 'attraction', displacedOccurrenceId: 'kid-only' });
    expect(ids(r.selection)).toEqual(['f0', 'f1', 'attraction', 'teen-only']);
  });

  it('a band ALREADY unrepresented before the slot ran does not block it', () => {
    // The coverage swap could not find anything for the 10–14-year-old. That is not this slot's
    // doing, and it must not turn every such week into an unfilled slot.
    const r = applyDestinationSlot(
      slotInput(ordinary(10), [item('museum', { cat: 'museum_venue' })], { requestedBands: ['2-4', '5-9', '10-14'] })
    );
    expect(r.summary.outcome).toBe('forced');
  });
});

describe('B5 — pushing the only LINKED pick for a band down to "Also:" is allowed, and reported', () => {
  it('reports the lost named band as bandsLost', () => {
    // Two age-forced picks + the destination lock all three named slots, so the spread cannot
    // repair it: p0 — the only named voice for 10–14 — drops to slot 4.
    const f0 = item('f0', { bands: ['2-4'] });
    const f1 = item('f1', { bands: ['2-4'] });
    const selection = [f0, f1, item('p0', { bands: ['10-14'] }), ...ordinary(7, { bands: ['2-4'] }).map((x, i) => item(`q${i}`, { bands: ['2-4'] }))];
    const r = applyDestinationSlot(
      slotInput(selection, [item('museum', { cat: 'museum_venue', bands: ['2-4'] })], {
        requestedBands: ['2-4', '10-14'],
        ageForcedIds: new Set(['f0', 'f1']),
      })
    );
    expect(r.summary.outcome).toBe('forced');
    expect(ids(r.selection).slice(0, 3)).toEqual(['f0', 'f1', 'museum']);
    expect(r.summary.bandsLost).toEqual(['10-14']);
    expect(ids(r.selection)).toContain('p0'); // lost a LINK, not representation (B4)
  });

  it('reports nothing when no named band was lost', () => {
    const r = applyDestinationSlot(slotInput(ordinary(10), [item('museum', { cat: 'museum_venue' })]));
    expect(r.summary.bandsLost).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The venue cap.
// ═════════════════════════════════════════════════════════════════════════════

describe('venue cap — the slot never creates a third pick at one venue', () => {
  it('when the destination\'s venue already holds MAX_PICKS_PER_VENUE, it displaces one of THOSE picks', () => {
    expect(MAX_PICKS_PER_VENUE).toBe(2);
    const selection = [
      item('g0', { venue: 'Stanley Park', title: 'Petting Farm' }),
      item('g1', { venue: 'Stanley Park', title: 'Pitch and Putt' }),
      ...ordinary(8),
    ];
    const train = item('train', { cat: 'outdoor_park', venue: 'Stanley Park', title: 'Miniature Railway' });
    const r = applyDestinationSlot(slotInput(selection, [train]));
    expect(r.summary.outcome).toBe('forced');
    expect(r.summary.displacedOccurrenceId).toBe('g1'); // not p7, the natural lowest-ranked pick
    expect(r.selection.filter((x) => x.listing.venueName === 'Stanley Park')).toHaveLength(MAX_PICKS_PER_VENUE);
  });

  it('on a SHORT week (nothing to displace) a full venue means that candidate is skipped for the next', () => {
    const selection = [
      item('g0', { venue: 'Stanley Park', title: 'Petting Farm' }),
      item('g1', { venue: 'Stanley Park', title: 'Pitch and Putt' }),
      ...ordinary(3),
    ];
    const train = item('train', { cat: 'outdoor_park', venue: 'Stanley Park', title: 'Miniature Railway' });
    const museum = item('museum', { cat: 'museum_venue' });
    const r = applyDestinationSlot(slotInput(selection, [train, museum]));
    expect(r.summary.occurrenceId).toBe('museum');
    expect(r.selection.filter((x) => x.listing.venueName === 'Stanley Park')).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The invariants, swept across every outcome.
// ═════════════════════════════════════════════════════════════════════════════

/** One scenario per outcome, each on a FULL week of ten, with 0, 1 or 2 age-forced picks. */
function scenarios(forcedCount: number): Array<[DestinationSlotOutcome, DestinationSlotInput]> {
  const base = ordinary(10);
  const ageForcedIds = new Set(base.slice(0, forcedCount).map((x) => x.listing.id));
  const withDestAt = (index: number) => {
    const s = [...base];
    s[index] = item(`dest-at-${index}`, { cat: 'museum_venue' });
    return s;
  };
  return [
    ['already_linked', slotInput(withDestAt(forcedCount), [], { ageForcedIds })],
    ['promoted', slotInput(withDestAt(7), [], { ageForcedIds })],
    ['forced', slotInput(base, [item('museum', { cat: 'museum_venue' })], { ageForcedIds })],
    [
      'forced_widened',
      slotInput(base, [], { ageForcedIds, widen: vi.fn(() => ({ ranked: [item('far', { cat: 'attraction', km: 14 })], radiusKm: 20 })) }),
    ],
    ['unfilled', slotInput(base, [], { ageForcedIds })],
    ['not_applicable', slotInput(base, [item('museum', { cat: 'museum_venue' })], { ageForcedIds, interests: ['skate'] })],
  ];
}

describe('INVARIANT — placement: a filled slot is ALWAYS a linked slot', () => {
  for (const forcedCount of [0, 1, MAX_FORCED_PICKS]) {
    it(`with ${forcedCount} age-forced pick(s), the destination lands at index < DIRECT_LINK_PICKS, behind them`, () => {
      for (const [expected, inp] of scenarios(forcedCount)) {
        const r = applyDestinationSlot(inp);
        expect(r.summary.outcome).toBe(expected);
        if (['already_linked', 'promoted', 'forced', 'forced_widened'].includes(expected)) {
          const at = ids(r.selection).indexOf(r.summary.occurrenceId!);
          expect(at, `${expected}: destination at index ${at}`).toBeLessThan(DIRECT_LINK_PICKS);
          if (expected !== 'already_linked') expect(at).toBe(forcedCount); // directly behind the age-forced picks
          // …and the age-forced picks were not moved.
          expect(ids(r.selection).slice(0, forcedCount)).toEqual(ids(inp.selection).slice(0, forcedCount));
        }
      }
    });
  }

  it('selectWeeklyPicks marks the destination pick as a DIRECT link', () => {
    const result = selectWeeklyPicks(engineInput(neighbourhood(14).concat(museumAt('museum', 7_000))));
    const pick = result.picks.find((p) => p.item.listing.id === 'museum');
    expect(pick?.linkOrigin).toBe('direct');
  });
});

describe('INVARIANT — never thins a week', () => {
  for (const forcedCount of [0, 1, MAX_FORCED_PICKS]) {
    it(`full week, ${forcedCount} age-forced: the pick count is unchanged in all six outcomes`, () => {
      const seen = new Set<DestinationSlotOutcome>();
      for (const [expected, inp] of scenarios(forcedCount)) {
        const r = applyDestinationSlot(inp);
        seen.add(r.summary.outcome);
        expect(r.selection, expected).toHaveLength(inp.selection.length);
        expect(new Set(ids(r.selection)).size, `${expected}: no duplicates`).toBe(r.selection.length);
      }
      expect(seen.size).toBe(6);
    });
  }

  it('SHORT week: a forced pick is ADDED (count +1) and displaces nothing', () => {
    const selection = ordinary(6);
    const r = applyDestinationSlot(slotInput(selection, [item('museum', { cat: 'museum_venue' })]));
    expect(r.summary).toMatchObject({ outcome: 'forced', displacedOccurrenceId: null, displacedBandsCovered: null });
    expect(r.selection).toHaveLength(7);
    expect(ids(r.selection)).toEqual(expect.arrayContaining(ids(selection)));
  });

  it('SHORT week: every other outcome leaves the count exactly where it was', () => {
    const short = ordinary(6);
    const cases = [
      slotInput([...short.slice(0, 1), item('m', { cat: 'museum_venue' }), ...short.slice(1)]), // already linked
      slotInput([...short, item('m', { cat: 'museum_venue' })]), // promoted
      slotInput(short), // unfilled
      slotInput(short, [item('m2', { cat: 'museum_venue' })], { interests: ['skate'] }), // not applicable
    ];
    for (const inp of cases) expect(applyDestinationSlot(inp).selection).toHaveLength(inp.selection.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Wiring: selectWeeklyPicks over a real fixture engine.
// ═════════════════════════════════════════════════════════════════════════════

/** Friday 2026-08-28, 16:00 PDT — the same send moment weekly_picks.test.ts uses. */
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
const SAT = '2026-08-29';
const HOME: GeoPoint = { lat: 49.28, lng: -123.07 };
const north = (metres: number): GeoPoint => ({ lat: HOME.lat + metres / 111_320, lng: HOME.lng });
const at = (isoDate: string, localHour: number) => `${isoDate}T${String(localHour + 7).padStart(2, '0')}:00:00Z`;

const NAMES = [
  'Splash Time', 'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Dance Party', 'Science Lab', 'Yoga Kids',
  'Forest Explorers', 'Bike Rodeo', 'Marble Run', 'Drama Games', 'Coding Club', 'Garden Club',
];

function kid(partial: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    statusState: 'confirmed',
    ageMinMonths: 24,
    ageMaxMonths: 120,
    ageBandMatches: ['2-4', '5-9'],
    startDatetimeUtc: at(SAT, 10),
    endDatetimeUtc: at(SAT, 11),
    ...partial,
  });
}

/**
 * `n` distinct nearby activities, 400 m apart from 600 m out — each its own venue and its own
 * category, so neither cap nor the named-slot spread has anything to do and the ranking is
 * simply by distance.
 */
function neighbourhood(n: number, firstMetres = 600): ListingRecord[] {
  return Array.from({ length: n }, (_, i) =>
    kid({
      id: `n${i}`,
      activityName: NAMES[i % NAMES.length],
      venueName: `${NAMES[i % NAMES.length]} Hall`,
      primaryCategoryKey: `kind-${i}`,
      geo: north(firstMetres + i * 400),
    })
  );
}

function museumAt(id: string, metres: number, over: Partial<ListingRecord> = {}): ListingRecord {
  return kid({ id, activityName: 'Maritime Museum', venueName: 'Maritime Museum', primaryCategoryKey: 'museum_venue', geo: north(metres), ...over });
}

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

/** A spied engine: every request it receives, in order. */
function spiedEngine(listings: ListingRecord[]) {
  const engine = engineOver(listings);
  const calls: Array<Parameters<SearchEngine['search']>[0]> = [];
  const spied = {
    search: (req: Parameters<SearchEngine['search']>[0]) => {
      calls.push(req);
      return engine.search(req);
    },
  } as unknown as SearchEngine;
  return { engine: spied, calls };
}

function engineInput(listings: ListingRecord[], over: Partial<WeeklyPicksInput> = {}): WeeklyPicksInput {
  return {
    engine: engineOver(listings),
    now: FRIDAY_4PM,
    ...over,
    subscriber: {
      origin: { geo: HOME, label: 'East Van' },
      radiusKm: 10,
      birthYears: [2021, 2023], // 5 and 3 in 2026 → '5-9' and '2-4'
      consecutiveEmptyWeeks: 0,
      ...over.subscriber,
    },
  };
}

describe('selectWeeklyPicks — wiring', () => {
  it('forces a museum ranked past the ten into link slot 1, with ONE engine call', () => {
    const { engine, calls } = spiedEngine(neighbourhood(14).concat(museumAt('museum', 7_000)));
    const result = selectWeeklyPicks(engineInput([], { engine }));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'forced', occurrenceId: 'museum', radiusKm: 10, widenedSearch: false });
    expect(result.picks[0].item.listing.id).toBe('museum');
    expect(calls).toHaveLength(1);
  });

  it('widens ONE radius step for this pick only: 10 → 20 km, weekend window, minResults 0', () => {
    const { engine, calls } = spiedEngine(neighbourhood(14).concat(museumAt('far-museum', 13_000)));
    const result = selectWeeklyPicks(engineInput([], { engine }));
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'forced_widened', occurrenceId: 'far-museum', radiusKm: 20, widenedSearch: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ radiusKm: 20, when: 'weekend', minResults: 0 });
    expect(result.radiusKmUsed).toBe(10); // the week itself was NOT widened
    // Every other pick is still inside the subscriber's own radius.
    for (const p of result.picks) if (p.item.listing.id !== 'far-museum') expect(p.item.distanceKm!).toBeLessThanOrEqual(10);
    expect(result.picks.findIndex((p) => p.item.listing.id === 'far-museum')).toBeLessThan(DIRECT_LINK_PICKS);
  });

  it('DEGRADED week: the widen step starts from radiusKmUsed (20 → 30 km), on the retry\'s Sat–Tue window', () => {
    // Only two things within 10 km → below the floor → the retry widens the week to 20 km, where
    // there are enough. No destination within 20 km; one at 25 km.
    const near = neighbourhood(2);
    const mid = neighbourhood(6, 12_000).map((l, i) => ({ ...l, id: `mid${i}`, activityName: NAMES[(i + 6) % NAMES.length], venueName: `${NAMES[(i + 6) % NAMES.length]} Hall` }));
    const { engine, calls } = spiedEngine([...near, ...mid, museumAt('museum-25', 25_000)]);
    const result = selectWeeklyPicks(engineInput([], { engine }));
    expect(result.degradation).toBe('widened');
    expect(result.radiusKmUsed).toBe(20);
    expect(calls).toHaveLength(3); // primary, retry, and the ONE destination widen
    expect(calls[2].radiusKm).toBe(30); // one step out from radiusKmUsed, not from the base 10 km
    expect(calls[2].dateRange).toEqual(calls[1].dateRange); // the retry's own window
    expect(calls[2].minResults).toBe(0);
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'forced_widened', occurrenceId: 'museum-25', radiusKm: 30 });
  });

  it('buildDestinationWidenRequest: exactly one widenRadiusKm step past the attempt\'s own request', () => {
    const inp = engineInput([]);
    expect(buildDestinationWidenRequest(inp, 'primary')).toEqual({ ...buildPicksRequest(inp, 'primary'), radiusKm: 20 });
    expect(buildDestinationWidenRequest(inp, 'retry')).toEqual({ ...buildPicksRequest(inp, 'retry'), radiusKm: 30 });
    expect(buildDestinationWidenRequest(inp, 'retry_without_interests').radiusKm).toBe(30);
  });

  it('never decides WHETHER a week sends: a below-floor week stays empty even if the slot could add one', () => {
    // Two picks within 20 km (the retry radius) and a museum at 25 km. Were the slot to run before
    // the floor check, its short-week ADD would lift this to three and send it.
    const { engine, calls } = spiedEngine([...neighbourhood(2), museumAt('museum-25', 25_000)]);
    const result = selectWeeklyPicks(engineInput([], { engine }));
    expect(result.outcome).toBe('empty');
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'not_applicable', reason: 'empty_week' });
    expect(calls).toHaveLength(2); // primary + retry, no destination search
  });

  it('SHORT week through the real pipeline: the destination is added, not swapped', () => {
    const { engine } = spiedEngine([...neighbourhood(5), museumAt('far-museum', 13_000)]);
    const result = selectWeeklyPicks(engineInput([], { engine }));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(6);
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'forced_widened', displacedOccurrenceId: null });
    expect(result.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('D3 end to end: a swim-only subscriber gets no museum and no extra search', () => {
    const swims = neighbourhood(12).map((l) => ({ ...l, primaryCategoryKey: 'public_swim' }));
    const { engine, calls } = spiedEngine([...swims, museumAt('museum', 3_000)]);
    const result = selectWeeklyPicks(
      engineInput([], { engine, subscriber: { origin: { geo: HOME, label: 'East Van' }, radiusKm: 10, birthYears: [2021], categoryInterests: ['public_swim'], consecutiveEmptyWeeks: 0 } })
    );
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'not_applicable', reason: 'interests_exclude_destinations' });
    expect(result.picks.some((p) => p.item.listing.id === 'museum')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('#12 end to end: TWO age-forced picks AND a forced destination coexist — its cap is separate from MAX_FORCED_PICKS', () => {
    // A 1-, 3-, 7- and 12-year-old. Everything nearby is under-2 only, so the coverage swap spends
    // its full MAX_FORCED_PICKS (2-4 and 5-9; 10-14 goes without, per its cap). The destination slot
    // must STILL fire — three picks in the ten are now "forced" in some sense — and must land in the
    // last linked slot, behind the two age-forced picks, without either of them moving.
    const toddlers = neighbourhood(12).map((l) => ({ ...l, ageBandMatches: ['under2'] as AgeBandKey[], ageMinMonths: 0, ageMaxMonths: 24 }));
    const older = (['2-4', '5-9', '10-14'] as AgeBandKey[]).map((band, i) =>
      kid({
        id: `old-${band}`,
        activityName: NAMES[12 + i],
        venueName: `${NAMES[12 + i]} Hall`,
        primaryCategoryKey: `older-${i}`,
        geo: north(5_600 + i * 100),
        ageBandMatches: [band],
        ageMinMonths: 24 + i * 36,
        ageMaxMonths: 60 + i * 36,
      })
    );
    // Under-2 only, so the coverage swap cannot take it for a band of its own.
    const museum = museumAt('museum', 7_000, { ageBandMatches: ['under2'], ageMinMonths: 0, ageMaxMonths: 24 });
    const result = selectWeeklyPicks(
      engineInput([...toddlers, ...older, museum], {
        subscriber: { origin: { geo: HOME, label: 'East Van' }, radiusKm: 10, birthYears: [2025, 2023, 2019, 2014], consecutiveEmptyWeeks: 0 },
      })
    );
    expect(result.ageBands).toEqual(['under2', '2-4', '5-9', '10-14']);
    expect(result.forcedPicks.map((f) => f.band)).toEqual(['2-4', '5-9']);
    expect(result.forcedPicks).toHaveLength(MAX_FORCED_PICKS); // the destination is NOT counted here
    expect(result.diversity.destinationSlot).toMatchObject({ outcome: 'forced', occurrenceId: 'museum' });
    expect(result.picks).toHaveLength(MAX_PICKS);
    const order = result.picks.map((p) => p.item.listing.id);
    expect(order.slice(0, 3)).toEqual(['old-2-4', 'old-5-9', 'museum']); // age-forced unmoved, destination behind them
    expect(result.picks.slice(0, 3).every((p) => p.linkOrigin === 'direct')).toBe(true);
    expect(result.picks.filter((p) => p.forcedForBand).map((p) => p.forcedForBand)).toEqual(['2-4', '5-9']);
  });

  it('the novelty exclusion still applies to the destination slot (D5 is untouched, not bypassed)', () => {
    const listings = neighbourhood(14).concat(museumAt('museum', 7_000));
    const result = selectWeeklyPicks(engineInput(listings, { excludeOccurrenceIds: new Set(['museum']) }));
    expect(result.picks.some((p) => p.item.listing.id === 'museum')).toBe(false);
    expect(result.diversity.destinationSlot.outcome).toBe('unfilled');
  });
});
