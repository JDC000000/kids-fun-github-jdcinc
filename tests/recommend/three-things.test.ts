// T1 — what the front door's "three things" block is allowed to show, and how it picks.
//
// Everything here runs against a PURPOSE-BUILT fixture engine rather than the shared
// FIXTURE_LISTINGS catalogue: the point of most of these cases is a pool of an exact size with an
// exact overlap, and a shared catalogue cannot hold still for that.
//
// ── THIS FILE CARRIES A GUARD FORWARD, NOT JUST ITS OWN CASES ────────────────────────────────
// `app/_components/home-today-strip.test.ts` was the drift guard for tonight's front-door age
// fix (9738650 / b9cdc9c / b46de05). The block under test here REPLACES that component, so the
// "front-door gates" describe below is a PORT of that suite's invariants against the new module,
// landed BEFORE the component is deleted so the guarantee never has a window where nothing holds
// it. Where a case reads oddly specific — "0 is a real number", "gate 2 is not subsumed by gate
// 1" — it is because it was written against rows measured live on 2026-08-19, and the wording is
// kept so the reason survives the move.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { isAdultOrSeniorOnly } from '@/lib/search/filters/audience';
import { readIndoorOutdoor } from '@/lib/search/indoor';
import type { ListingRecord } from '@/lib/search/types';
import { isRegistrationShaped } from '@/lib/search/filters/registration';
import {
  chooseThreeThings,
  filledSlots,
  firstEligiblePerSlot,
  foldTitleForComparison,
  gatherSlotCandidates,
  hasUsableStart,
  selectThreeThings,
  type SlotKey,
  type ThingSlot,
  type ThreeThingsInput,
} from '@/lib/recommend/three-things';

// FIXTURE_NOW is 2026-07-13T19:00:00Z — noon on a Monday in Vancouver. Every instant below is
// stated relative to that, in UTC, because the engine's date filter works in local days.
const NOW = FIXTURE_NOW;
/** 14:00 local — starts AFTER `now`, so a parent can still turn up. */
const STARTS_LATER = { startDatetimeUtc: '2026-07-13T21:00:00.000Z', endDatetimeUtc: '2026-07-13T22:00:00.000Z' };
/** 10:00–11:00 local — already over. Only reachable in a fixture: the DB read model prunes it. */
const ALREADY_STARTED = { startDatetimeUtc: '2026-07-13T17:00:00.000Z', endDatetimeUtc: '2026-07-13T18:00:00.000Z' };
/** Tomorrow. Present in the catalogue so `when=today` has something to exclude. */
const TOMORROW = { startDatetimeUtc: '2026-07-14T21:00:00.000Z', endDatetimeUtc: '2026-07-14T22:00:00.000Z' };

/** Ruling 7.4's coordinate — the same one docs/answer-before-search-design.md §2d measured from. */
const DOWNTOWN = { lat: 49.2827, lng: -123.1207 };
/** ~1 km from it. */
const NEAR_DOWNTOWN = { lat: 49.2827, lng: -123.107 };
/** ~11 km out — outside the 5 km radius, so it can be "on today" without being "nearby". */
const FAR_FROM_DOWNTOWN = { lat: 49.2, lng: -123.05 };

const FREE = { costStatus: 'free' as const, costMinCad: 0, costMaxCad: 0 };
/** Admitted by the free FILTER (unknown is never suppressed) but `isFree()` is false. */
const UNPRICED = { costStatus: 'check_source' as const, costMinCad: null, costMaxCad: null };
const PAID = { costStatus: 'known' as const, costMinCad: 5, costMaxCad: 5 };
const INDOOR_TAGS = { suitabilityTags: ['indoor'] };

/** A listing that clears both front-door gates unless a case deliberately breaks one. */
function listing(over: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    seriesId: `${over.id}-series`,
    activityName: 'Family Swim',
    venueName: 'Sunset Community Centre',
    ageMinMonths: 60,
    ageMaxMonths: 144,
    geo: FAR_FROM_DOWNTOWN,
    ...PAID,
    ...STARTS_LATER,
    ...over,
  });
}

function engineOf(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

function input(listings: ListingRecord[], over: Partial<ThreeThingsInput> = {}): ThreeThingsInput {
  return {
    engine: engineOf(listings),
    now: NOW,
    origin: { geo: DOWNTOWN, label: 'downtown Vancouver' },
    ...over,
  };
}

/** What each slot ended up holding: a listing id, or the reason it is empty. */
function outcome(slots: ThingSlot[]): Record<SlotKey, string> {
  const out = {} as Record<SlotKey, string>;
  for (const slot of slots) out[slot.key] = slot.state === 'filled' ? slot.item.listing.id : `empty:${slot.reason}`;
  return out;
}

const idsIn = (key: SlotKey, pools: ReturnType<typeof gatherSlotCandidates>) =>
  pools.find((p) => p.key === key)!.candidates.map((c) => c.listing.id);

// ─────────────────────────────────────────────────────────────────────────────
// A2 — the slot predicates are the engine's own, and the free one is not the free FILTER
// ─────────────────────────────────────────────────────────────────────────────
describe('slot predicates', () => {
  it('offers the free slot only listings isFree() is true for — not everything the free filter admits', () => {
    const rows = [
      listing({ id: 'unpriced', activityName: 'Open Gym', ...UNPRICED }),
      listing({ id: 'genuinely-free', activityName: 'Story Time', ...FREE }),
    ];
    const pools = gatherSlotCandidates(input(rows));
    expect(idsIn('free', pools)).toEqual(['genuinely-free']);

    // VACUITY CONTROL. The unpriced row must actually be in the engine's own answer to the same
    // question, or this proves nothing: `matchesCost` deliberately admits unknown/check_source
    // under `free`, on Jon's 2026-08-11/17 ruling that an unpriced listing is never suppressed.
    // So it is the module's isFree() post-filter that removed it, not the engine.
    const engineSaw = engineOf(rows)
      .search({ q: '', now: NOW, when: 'today', free: true, minResults: 0 })
      .results.map((r) => r.listing.id);
    expect(engineSaw).toContain('unpriced');
  });

  it('offers the indoor slot the rainy-day TAG set, not the card label’s wider facility set', () => {
    // The divergence lib/search/indoor.ts documents: `public_swim` reads as Indoor on a card
    // (facility type) but carries no indoor EVIDENCE, and Metro Vancouver has outdoor pools.
    // Ruling 7.3 picked the honest signal for this slot.
    const pool = listing({ id: 'pool', activityName: 'Public Swim', primaryCategoryKey: 'public_swim' });
    const tagged = listing({ id: 'tagged', activityName: 'Play Palace', ...INDOOR_TAGS });
    const pools = gatherSlotCandidates(input([pool, tagged]));
    expect(idsIn('indoor', pools)).toEqual(['tagged']);

    // VACUITY CONTROL: the two rules genuinely disagree about this row, which is the whole
    // reason the ruling had to choose. If readIndoorOutdoor ever stops calling it indoor, this
    // case has silently stopped testing the divergence.
    expect(readIndoorOutdoor({
      primaryCategoryKey: 'public_swim',
      tags: new Set<string>(),
      activityName: 'Public Swim',
      descriptionSnippet: '',
    })).toBe('indoor');
  });

  it('measures the nearby slot from the origin, and asks nothing at all without one', () => {
    const rows = [
      listing({ id: 'close', activityName: 'Story Time', geo: NEAR_DOWNTOWN }),
      listing({ id: 'far', activityName: 'Open Gym', geo: FAR_FROM_DOWNTOWN }),
    ];
    expect(idsIn('nearby', gatherSlotCandidates(input(rows)))).toEqual(['close']);

    const withoutOrigin = gatherSlotCandidates(input(rows, { origin: null }));
    const nearby = withoutOrigin.find((p) => p.key === 'nearby')!;
    expect(nearby.candidates).toEqual([]);
    // `no_origin` is an UNASKED question, not an unanswered one — and `reached: 0` here means
    // "nothing was requested", which is why the empty-state copy distinguishes it from
    // `nothing_on` ("we asked and today has none").
    expect(nearby.unaskable).toBe('no_origin');
    expect(nearby.reached).toBe(0);
  });

  it('asks about TODAY, not about the catalogue', () => {
    const pools = gatherSlotCandidates(
      input([
        listing({ id: 'today', activityName: 'Story Time', ...FREE }),
        listing({ id: 'tomorrow', activityName: 'Open Gym', ...FREE, ...TOMORROW }),
      ]),
    );
    expect(idsIn('free', pools)).toEqual(['today']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from app/_components/home-today-strip.test.ts — the front-door age/audience gates.
// ─────────────────────────────────────────────────────────────────────────────
describe('front-door gates (ported from HomeTodayStrip’s drift guard)', () => {
  /** The rows measured at the top of the live strip on 2026-08-19, in this module's shape. */
  const UNRESOLVED: ListingRecord[] = [
    listing({ id: 'zumba', activityName: 'Group Fitness - Zumba', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Group Fitness - Zumba', ...FREE }),
    listing({ id: 'muaythai', activityName: 'Muay Thai Kickboxing', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Muay Thai Kickboxing', ...FREE }),
  ];

  it('is an UNRESOLVED-AGE problem, not an adult-signal miss — so gate 1 is what catches it', () => {
    for (const row of UNRESOLVED) {
      expect(isAdultOrSeniorOnly(row)).toBe(false); // nothing for the hard exclusion to catch
      expect(row.ageMinMonths).toBeNull();
    }
    const pools = gatherSlotCandidates(input(UNRESOLVED));
    expect(idsIn('free', pools)).toEqual([]);
  });

  it('the engine DELIBERATELY returns those rows — the gate here is not redundant', () => {
    // /search shows them under an "Age not stated by source" heading. This block has no heading
    // and no room for one. If the engine ever starts excluding them, this gate becomes dead code
    // and this case is how anyone finds out.
    const engineSaw = engineOf(UNRESOLVED)
      .search({ q: '', now: NOW, when: 'today', free: true, minResults: 0 })
      .results.map((r) => r.listing.id);
    expect(engineSaw).toEqual(expect.arrayContaining(['zumba']));

    // `muaythai` STOPPED being one of them on 2026-09-15, for a reason that has nothing to do
    // with age. The registration vocabulary gained the martial-arts disciplines
    // (lib/search/filters/registration.ts), so this row now leaves the DEFAULT view as a
    // registration-shaped programme — correctly: "Muay Thai Kickboxing" is a live production
    // title and it is a course. Asserted explicitly rather than quietly dropped from the list,
    // because the two exclusions are different mechanisms and the whole point of this case is
    // that the age one still fires.
    expect(isRegistrationShaped({ activityName: 'Muay Thai Kickboxing' })).toBe(true);
    expect(engineSaw).not.toContain('muaythai');
  });

  it('keeps a genuinely resolved ALL-AGES listing — 0 is a real number, not an unknown', () => {
    const pools = gatherSlotCandidates(
      input([listing({ id: 'allages', activityName: 'Drop-in Playtime', ageMinMonths: 0, ageMaxMonths: null, ...FREE })]),
    );
    expect(idsIn('free', pools)).toEqual(['allages']);
  });

  it('excludes adult-only programming whose age IS resolved — gate 2 is not subsumed by gate 1', () => {
    // "Adult 19yrs+ Swim" is stored with age_min_months = 0 (audience.ts's own note on the
    // mis-parse), so it clears gate 1 on a real number. Only the title signal catches it.
    const pools = gatherSlotCandidates(
      input([
        listing({ id: 'adult-swim', activityName: 'Adult 19yrs+ Swim', ageMinMonths: 0, ageMaxMonths: null, ...FREE }),
        listing({ id: 'seniors', activityName: 'Mah Jong', ageMinMonths: 660, ageMaxMonths: null, ...FREE }),
        listing({ id: 'kids', activityName: 'Story Time', ...FREE }),
      ]),
    );
    expect(idsIn('free', pools)).toEqual(['kids']);
  });

  it('keeps a parent-and-child session even though it says "adult"', () => {
    const pools = gatherSlotCandidates(
      input([listing({ id: 'with-adult', activityName: 'Family Badminton (6-13 with adult)', ageMinMonths: 72, ageMaxMonths: 168, ...FREE })]),
    );
    expect(idsIn('free', pools)).toEqual(['with-adult']);
  });

  it('shows only the CONFIRMED status class — the gate adds a constraint, it does not open one', () => {
    const pools = gatherSlotCandidates(
      input([
        listing({ id: 'stale', activityName: 'Story Time', statusState: 'stale', ...FREE }),
        listing({ id: 'bookable', activityName: 'Open Gym', statusState: 'bookable_open', ...FREE }),
      ]),
    );
    expect(idsIn('free', pools)).toEqual(['bookable']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — cross-slot de-duplication
// ─────────────────────────────────────────────────────────────────────────────
describe('cross-slot de-duplication', () => {
  /** One card that qualifies for all three slots at once — free, indoor-tagged, and close by. */
  const OMNI = listing({ id: 'omni', activityName: 'Play Palace', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN });

  it('never shows one listing twice — and the control proves the duplicate is real', () => {
    const rows = [OMNI];

    // CONTROL: without the rule, this listing fills every slot. A de-dupe test that cannot show
    // the duplicate happening is a test that would pass on an empty implementation.
    const unguarded = selectThreeThings(input(rows), firstEligiblePerSlot);
    expect(filledSlots(unguarded).map((s) => s.item.listing.id)).toEqual(['omni', 'omni', 'omni']);

    const guarded = selectThreeThings(input(rows));
    expect(filledSlots(guarded).map((s) => s.item.listing.id)).toEqual(['omni']);
  });

  it('catches the same SERIES reaching two slots as two different occurrences', () => {
    // Each slot is its own pipeline run and `collapseSeries` keeps whichever member ranked best
    // under THAT run's ordering — the nearby slot sorts by distance, the free slot by best_match
    // — so one series can hand two slots two different `listing.id`s. An id-only de-dupe misses
    // this entirely, which is why `seriesId` is checked first.
    const rows = [
      listing({ id: 'occ-a', seriesId: 'shared-series', activityName: 'Play Palace', ...FREE, geo: NEAR_DOWNTOWN }),
      listing({ id: 'occ-b', seriesId: 'shared-series', activityName: 'Play Palace', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
    ];
    const picked = filledSlots(selectThreeThings(input(rows))).map((s) => s.item.listing.seriesId);
    expect(picked).toEqual(['shared-series']);
  });

  it('catches the same PROGRAMME run as two series at two venues — the measured LEGO case', () => {
    // Two different seriesIds at two different library branches, so neither collapseSeries nor an
    // id/series de-dupe can see it. Measured live 2026-08-19: this pair was two of the FOUR
    // showable indoor cards in the whole region.
    const rows = [
      listing({ id: 'lego-wpg', seriesId: 's1', activityName: 'LEGO® Block Party', venueName: 'West Point Grey Branch', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
      listing({ id: 'lego-ren', seriesId: 's2', activityName: 'LEGO Block Party', venueName: 'Renfrew Branch', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
    ];
    const picked = filledSlots(selectThreeThings(input(rows))).map((s) => s.item.listing.id);
    expect(picked).toHaveLength(1);
    expect(['lego-wpg', 'lego-ren']).toContain(picked[0]);
  });

  it('does not merge two genuinely different activities at one venue', () => {
    const rows = [
      listing({ id: 'swim', activityName: 'Family Swim', venueName: 'Hillcrest', ...FREE, geo: NEAR_DOWNTOWN }),
      listing({ id: 'gym', activityName: 'Open Gym', venueName: 'Hillcrest', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
    ];
    expect(filledSlots(selectThreeThings(input(rows)))).toHaveLength(2);
  });
});

describe('foldTitleForComparison', () => {
  it('merges the shapes it is meant to, against titles measured live on 2026-08-19', () => {
    const same = (a: string, b: string) => expect(foldTitleForComparison(a)).toBe(foldTitleForComparison(b));
    same('LEGO® Block Party', 'LEGO Block Party');
    same('Indoor Soccer - Wed', 'Indoor Soccer');
    same('Strong HIIT Conditioning - Two Sets', 'Strong HIIT Conditioning - Set Two');
    same('$3 Open Gym 8yrs+ Delbrook', 'Open Gym Delbrook');
    same('Play Palace - 0-12yrs', 'Play Palace');
    same('Public Swim  |  Teach Pool', 'public swim teach pool');
  });

  it('keeps genuinely different activities apart', () => {
    const differ = (a: string, b: string) =>
      expect(foldTitleForComparison(a)).not.toBe(foldTitleForComparison(b));
    differ('Family Swim', 'Family Badminton');
    differ('Open Gym', 'Open Skate');
    // A weekday is only noise at the END of a title. "Monday Funday" is a real programme name and
    // the ingest normaliser leaves it alone for exactly this reason.
    differ('Monday Funday', 'Funday');
  });

  it('never yields an empty key for a real title, because an empty key must not group anything', () => {
    // `repeatsPlaced` ignores an empty fold on purpose — two untitled rows are not "the same
    // thing". This pins that the ordinary path cannot reach that branch by accident.
    for (const name of ['LEGO® Block Party', '$3 Open Gym', 'Play Palace - 0-12yrs']) {
      expect(foldTitleForComparison(name)).not.toBe('');
    }
  });

  // ── 2026-09-10: the bare daypart and the non-initial weekday ──────────────────────────────
  // Added with the two rules themselves, against rows measured on the live catalogue for the
  // weekly-SMS venue/activity repetition fix. See the constants in three-things.ts for the
  // reasoning; these pin the behaviour.

  it('merges two sittings of one activity that differ only by daypart — the measured Pickleball case', () => {
    const same = (a: string, b: string) => expect(foldTitleForComparison(a)).toBe(foldTitleForComparison(b));
    // The headline case. Before this rule the two folded to DIFFERENT keys and their raw strings
    // scored 0.750 — under every threshold in the repo — so nothing could see them as one thing.
    same('Pickleball - Sun AM', 'Pickleball - Sun PM');
    same('Pickleball - Sun AM', 'Pickleball');
    same('Open Gym A.M.', 'Open Gym P.M.');
    // A weekday that is neither trailing nor leading.
    same('Indoor Soccer Wed Drop In', 'Indoor Soccer Drop In');
    expect(foldTitleForComparison('Pickleball - Sun AM')).toBe('pickleball');
  });

  it('leaves a daypart-shaped WORD alone — the rule reads a token, not a substring', () => {
    // `\b` and the trailing `(?![a-z0-9])` are the whole guard, and each one is load-bearing:
    // "amazing"/"camp"/"program" have the letters and no token boundary around them.
    expect(foldTitleForComparison('Amazing Race')).toBe('amazing race');
    expect(foldTitleForComparison('Summer Camp Fun')).toBe('summer camp fun');
    expect(foldTitleForComparison('Program Launch')).toBe('program launch');
    expect(foldTitleForComparison('Jam Session Kids')).toBe('jam session kids');
    // And a clock time is still TIME_RE's job, not the daypart rule's — "5pm" leaves nothing behind.
    expect(foldTitleForComparison('Open Gym 5pm')).toBe('open gym');
  });

  it('strips DECOMPOSED ACCENTS, so one accented title cannot split from its plain twin', () => {
    // THIS TEST EXISTS BECAUSE THE RULE IT COVERS IS WRITTEN IN INVISIBLE CHARACTERS.
    // The fold's first step is NFKD, which decomposes "é" into "e" + an invisible combining
    // acute; the next step deletes the combining marks (U+0300-U+036F). Until this case was
    // added, NOTHING in the suite exercised that second step — so if the character class ever
    // silently degraded (the failure mode that makes an invisible literal dangerous: it becomes
    // something else and everything still compiles), every test would still have passed while the
    // catalogue quietly split "Café Storytime" from "Cafe Storytime" into two different things.
    //
    // Same defensive shape as tests/sms/keywords.test.ts's "does NOT let a DECOMPOSED accent be
    // deleted into a bare keyword", which guards the equivalent step in the SMS normaliser.
    const same = (a: string, b: string) => expect(foldTitleForComparison(a)).toBe(foldTitleForComparison(b));
    same('Café Storytime', 'Cafe Storytime');
    same('Crème Brûlée Club', 'Creme Brulee Club');
    same('Piñata Party', 'Pinata Party');
    same('Zoë and Friends', 'Zoe and Friends');
    // The letter must SURVIVE the strip — only the mark is removed, never the character it sat on.
    expect(foldTitleForComparison('Café Storytime')).toBe('cafe storytime');
    // And an accented title still differs from a genuinely different one.
    expect(foldTitleForComparison('Café Storytime')).not.toBe(foldTitleForComparison('Cafe Swim'));
  });

  it('keeps a LEADING weekday, because there it is the programme NAME and not a timetable note', () => {
    // The existing `differ('Monday Funday', 'Funday')` case above is the reason the new rule is
    // "non-initial" rather than "anywhere". Restated here from the other side so the POSITION is
    // pinned as the evidence, not just the one string that exposed it.
    expect(foldTitleForComparison('Monday Funday')).toBe('monday funday');
    expect(foldTitleForComparison('Sunday Brunch Club')).toBe('sunday brunch club');
    expect(foldTitleForComparison('Saturday Stories')).toBe('saturday stories');
    // …while the same weekday AFTER the activity name is still noise, as it always was.
    expect(foldTitleForComparison('Stories Saturday')).toBe('stories');
    // A title that is NOTHING BUT a weekday still folds to the empty key — that is what stops a
    // bare weekday becoming a grouping identity, and it is why the trailing rule is kept.
    expect(foldTitleForComparison('Sunday')).toBe('');
  });

  it('does not disturb the LEGO Block Party fixture — the case the fold exists for', () => {
    // The regression this file most needs to catch. The measured LEGO pair is the reason
    // `foldTitleForComparison` exists at all, and neither new rule touches either string: same
    // key before, same key after, and the three-card hero still collapses the pair to one card.
    expect(foldTitleForComparison('LEGO® Block Party')).toBe('lego block party');
    expect(foldTitleForComparison('LEGO Block Party')).toBe('lego block party');

    const rows = [
      listing({ id: 'lego-wpg', seriesId: 's1', activityName: 'LEGO® Block Party', venueName: 'West Point Grey Branch', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
      listing({ id: 'lego-ren', seriesId: 's2', activityName: 'LEGO Block Party', venueName: 'Renfrew Branch', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
    ];
    const picked = filledSlots(selectThreeThings(input(rows))).map((s) => s.item.listing.id);
    expect(picked).toHaveLength(1);
    expect(['lego-wpg', 'lego-ren']).toContain(picked[0]);

    // And every other title this file already measures folds to exactly what it did before.
    expect(foldTitleForComparison('$3 Open Gym 8yrs+ Delbrook')).toBe('open gym delbrook');
    expect(foldTitleForComparison('Play Palace - 0-12yrs')).toBe('play palace');
    expect(foldTitleForComparison('Strong HIIT Conditioning - Set Two')).toBe('strong hiit conditioning');
    expect(foldTitleForComparison('Public Swim  |  Teach Pool')).toBe('public swim teach pool');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — assignment and ordering
// ─────────────────────────────────────────────────────────────────────────────
describe('assignment', () => {
  it('fills the SCARCEST slot first, so a thin slot does not lose its only card to a fat one', () => {
    // `shared` is the only indoor card AND is free; `spare` is only free. Filling in slot-declared
    // order (free first) would take `shared` for the free slot and empty the indoor one. Poorest
    // pool first gives indoor the card it has no alternative to, and free takes `spare`.
    const rows = [
      listing({ id: 'shared', activityName: 'Play Palace', ...FREE, ...INDOOR_TAGS }),
      listing({ id: 'spare', activityName: 'Story Time', ...FREE }),
    ];
    expect(outcome(selectThreeThings(input(rows, { origin: null })).slots)).toEqual({
      free: 'spare',
      indoor: 'shared',
      nearby: 'empty:no_origin',
    });

    // CONTROL: the naive order really does lose the indoor slot, so the rule is doing work.
    const naive = outcome(selectThreeThings(input(rows, { origin: null }), firstEligiblePerSlot).slots);
    expect(naive.free).toBe('shared');
    expect(naive.indoor).toBe('shared'); // …the same card printed twice, which is the defect
  });

  it('prefers a card a parent can still start, without ever emptying a slot for it', () => {
    const rows = [
      listing({ id: 'over', activityName: 'Story Time', ...FREE, ...ALREADY_STARTED }),
      listing({ id: 'upcoming', activityName: 'Open Gym', ...FREE, ...STARTS_LATER }),
    ];
    // Both are eligible and `over` ranks first (it starts sooner, and the empty-query ranking is
    // soonest-ish). The preference is what moves `upcoming` ahead of it.
    expect(outcome(selectThreeThings(input(rows, { origin: null })).slots).free).toBe('upcoming');

    // A PREFERENCE, NOT A FILTER. With nothing left that has yet to start, the slot still fills —
    // at 8pm a hard filter would empty every slot on a night the catalogue still holds content.
    const onlyOver = [listing({ id: 'over', activityName: 'Story Time', ...FREE, ...ALREADY_STARTED })];
    expect(outcome(selectThreeThings(input(onlyOver, { origin: null })).slots).free).toBe('over');
  });

  it('prefers a venue not already on the page, and still fills when there is no other', () => {
    const rows = [
      listing({ id: 'indoor-hill', activityName: 'Play Palace', venueName: 'Hillcrest', ...INDOOR_TAGS, ...FREE }),
      listing({ id: 'free-hill', activityName: 'Story Time', venueName: 'Hillcrest', ...FREE }),
      listing({ id: 'free-kits', activityName: 'Open Gym', venueName: 'Kitsilano', ...FREE }),
    ];
    const picked = outcome(selectThreeThings(input(rows, { origin: null })).slots);
    expect(picked.indoor).toBe('indoor-hill'); // scarcest pool goes first, and takes Hillcrest
    expect(picked.free).toBe('free-kits'); // …so the free slot prefers the other venue

    const sameVenueOnly = rows.filter((r) => r.id !== 'free-kits');
    const forced = outcome(selectThreeThings(input(sameVenueOnly, { origin: null })).slots);
    expect(forced.free).toBe('free-hill'); // preference yields rather than empty the slot
  });

  it('renders in slot order however it filled — the page must not reshuffle between visits', () => {
    const rows = [
      listing({ id: 'indoor-only', activityName: 'Play Palace', ...INDOOR_TAGS }),
      listing({ id: 'free-only', activityName: 'Story Time', ...FREE }),
      listing({ id: 'near-only', activityName: 'Open Gym', geo: NEAR_DOWNTOWN }),
    ];
    const three = selectThreeThings(input(rows));
    expect(three.slots.map((s) => s.key)).toEqual(['free', 'indoor', 'nearby']);
  });

  it('is deterministic — the same catalogue produces the same page', () => {
    const rows = [
      listing({ id: 'a', activityName: 'Story Time', ...FREE, ...INDOOR_TAGS, geo: NEAR_DOWNTOWN }),
      listing({ id: 'b', activityName: 'Open Gym', ...FREE, geo: NEAR_DOWNTOWN }),
      listing({ id: 'c', activityName: 'Play Palace', ...FREE, ...INDOOR_TAGS }),
    ];
    const once = outcome(selectThreeThings(input(rows)).slots);
    for (let i = 0; i < 5; i += 1) expect(outcome(selectThreeThings(input(rows)).slots)).toEqual(once);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A6 — every partial-fill case, and the reason each empty slot carries
// ─────────────────────────────────────────────────────────────────────────────
describe('partial fill (ruling 7.5)', () => {
  it('fills three when three different things qualify', () => {
    const rows = [
      listing({ id: 'f', activityName: 'Story Time', ...FREE }),
      listing({ id: 'i', activityName: 'Play Palace', ...INDOOR_TAGS }),
      listing({ id: 'n', activityName: 'Open Gym', geo: NEAR_DOWNTOWN }),
    ];
    expect(outcome(selectThreeThings(input(rows)).slots)).toEqual({ free: 'f', indoor: 'i', nearby: 'n' });
  });

  it('fills two and says why the third is empty', () => {
    const rows = [
      listing({ id: 'f', activityName: 'Story Time', ...FREE }),
      listing({ id: 'n', activityName: 'Open Gym', geo: NEAR_DOWNTOWN }),
    ];
    expect(outcome(selectThreeThings(input(rows)).slots)).toEqual({
      free: 'f',
      indoor: 'empty:nothing_on',
      nearby: 'n',
    });
  });

  it('fills one', () => {
    const rows = [listing({ id: 'i', activityName: 'Play Palace', ...INDOOR_TAGS })];
    const slots = outcome(selectThreeThings(input(rows, { origin: null })).slots);
    expect(slots).toEqual({ free: 'empty:nothing_on', indoor: 'i', nearby: 'empty:no_origin' });
  });

  it('fills none, and every slot still says why', () => {
    const three = selectThreeThings(input([listing({ id: 'tomorrow', activityName: 'Story Time', ...FREE, ...TOMORROW })]));
    expect(filledSlots(three)).toEqual([]);
    expect(outcome(three.slots)).toEqual({
      free: 'empty:nothing_on',
      indoor: 'empty:nothing_on',
      nearby: 'empty:nothing_on',
    });
  });

  it('distinguishes "nothing is on" from "something is on but we cannot stand behind it"', () => {
    // THE DISTINCTION THAT EARNS ITS KEEP. Measured 2026-08-19, both indoor cards within 5 km of
    // downtown carried `ageMinMonths: null` — so the honest empty-slot line there is "nothing we
    // can vouch for", not "nothing indoor is on today". Collapsing the two would tell a parent
    // the catalogue is emptier than it is.
    const rows = [
      listing({ id: 'unattributed', activityName: 'Indoor Soccer', ageMinMonths: null, ageMaxMonths: null, ...INDOOR_TAGS }),
    ];
    const slots = selectThreeThings(input(rows, { origin: null })).slots;
    const indoor = slots.find((s) => s.key === 'indoor')!;
    expect(indoor.state).toBe('empty');
    if (indoor.state === 'empty') {
      expect(indoor.reason).toBe('none_showable');
      expect(indoor.reached).toBe(1); // the engine DID reach a card; we declined to show it
    }
    // …and the free slot, asked the same day about nothing at all, says the other thing.
    const free = slots.find((s) => s.key === 'free')!;
    if (free.state === 'empty') {
      expect(free.reason).toBe('nothing_on');
      expect(free.reached).toBe(0);
    }
  });
});

describe('hasUsableStart', () => {
  it('treats an open-hours card as always startable — that is what the null start means', () => {
    const standing = listing({ id: 'aquarium', activityName: 'General Admission', openHours: true, startDatetimeUtc: null, endDatetimeUtc: null });
    expect(hasUsableStart({ listing: standing, slots: [{ id: standing.id, startDatetimeUtc: null, endDatetimeUtc: null, costStatus: 'known', costMinCad: null, costMaxCad: null, ageMinMonths: null, ageMaxMonths: null }] } as never, NOW)).toBe(true);
  });
});

describe('the chooser contract', () => {
  it('only ever returns cards the slot actually offered', () => {
    const rows = [
      listing({ id: 'f', activityName: 'Story Time', ...FREE }),
      listing({ id: 'i', activityName: 'Play Palace', ...INDOOR_TAGS }),
    ];
    const pools = gatherSlotCandidates(input(rows));
    const picks = chooseThreeThings(pools, NOW);
    for (const pool of pools) {
      const pick = picks.get(pool.key);
      if (pick) expect(pool.candidates).toContain(pick);
    }
  });
});
