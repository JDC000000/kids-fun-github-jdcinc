// tests/cost-honesty-matrix.test.tsx
//
// ONE COST RULE, EVERY REACHABLE CELL, BOTH SURFACES AT ONCE.
//
// WHY A MATRIX AND NOT MORE EXAMPLES. The card and the weekly digest each carried their own
// hand-rolled mirror of `isFree()`, and each was right exactly where the other was wrong:
//   • known/min=null/max=0 — isFree TRUE, Free filter INCLUDES it. Email said "Free"; the CARD
//     said "Price not confirmed — check source", denying a price the filter had already claimed.
//   • known/min=0/max=null — isFree FALSE, Free filter EXCLUDES it. Card said "check source";
//     the EMAIL said "Free", in the one channel that cannot be taken back.
//   • known/min=7/max=0 — both surfaces printed "$7–$0". Nothing validates min <= max.
// Every one of those cells was reachable the day it was written, and every one of them was
// missed by example-based tests, because an example only covers the case its author enumerated
// and the whole failure was a case nobody thought to enumerate. The generalisation that hid it
// lived in a comment ("isFree requires BOTH bounds at zero" — it does not; it requires the MAX
// to be zero and lets the MIN be zero or absent), and its two worked examples were both correct.
// So this file does not pick cells. It takes every (costStatus x min x max) triple the real DTO
// admits and asserts the two surfaces and the Free filter cannot contradict each other.
//
// THE INVARIANT (lib/search/filters/cost.ts owns the implementation):
//   1. If a surface renders "Free", isFree() is true for that listing.
//   2. If isFree() is true, no surface renders a cost-unknown label.
//   3. No surface prints a number it was not given, or a contradictory one.
//   4. The two surfaces may differ in WORDS; they may not differ in CLAIM.
//
// REAL COMPONENT, REAL MAPPING, REAL FILTER. The card label is scraped out of markup rendered
// from the REAL <ActivityCard> via the REAL mapSearchItemToActivity DTO mapping; the email label
// is the REAL lib/email/format.ts#formatCost call that lib/email/digest.ts#toActivity makes over
// a REAL makeListing() ListingRecord; membership is the REAL matchesCost predicate that
// lib/search/filters/predicate.ts is the only production caller of. Nothing here re-implements a
// formatter, so no assumption can be encoded twice and agree with itself.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Same node-env markup approach as tests/ui/card-price.test.tsx: next/link renders as the plain
// <a> it becomes on the server, so this stays a pure markup check.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityCard } from '../app/preview/_components/ActivityCard';
import { mapSearchItemToActivity, type ListingRecordDto } from '../app/preview/_data/search-api';
import { formatCost as emailCostLabel } from '../lib/email/format';
import { isFree, matchesCost } from '../lib/search/filters/cost';
import { makeListing } from '../lib/search/__fixtures__/factory';

// ── The matrix ───────────────────────────────────────────────────────────────
// Bounds: the four shapes that behave differently, plus a negative. All five are reachable —
// supabase/migrations/0004_activities.sql makes both columns nullable with no check constraint,
// postgres-repository.ts carries whatever is stored, and app/admin/listings/_lib/vocab.ts's
// parseNumber accepts ANY finite number for each bound independently (no sign check, no
// min <= max check), so an admin can save every one of these through supported UI.
const BOUNDS = [null, -5, 0, 7, 30] as const;
type Bound = (typeof BOUNDS)[number];

// Every cost_status the DTO admits (app/preview/_data/search-api.ts ListingRecordDto).
const STATUSES = ['known', 'free', 'unknown', 'check_source'] as const;
type Status = (typeof STATUSES)[number];

interface Cell {
  name: string;
  status: Status;
  min: Bound;
  max: Bound;
}

const CELLS: Cell[] = STATUSES.flatMap((status) =>
  BOUNDS.flatMap((min) =>
    BOUNDS.map((max) => ({ name: `${status} / min=${String(min)} / max=${String(max)}`, status, min, max })),
  ),
);

/** 4 statuses x 5 minima x 5 maxima. Stated as a literal so a silently shrinking matrix fails. */
const EXPECTED_CELL_COUNT = 100;

// ── The two surfaces, exercised for real ─────────────────────────────────────

function dto(cell: Cell): ListingRecordDto {
  return {
    id: `occ-${cell.status}-${String(cell.min)}-${String(cell.max)}`,
    activityName: 'Public Swim',
    primaryCategoryKey: 'public_swim',
    categoryTags: ['public_swim'],
    venueName: 'Kitsilano Pool',
    organisation: 'City of Vancouver',
    descriptionSnippet: 'Warm shallow end.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-18T21:00:00.000Z',
    endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: cell.status,
    costMinCad: cell.min,
    costMaxCad: cell.max,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-13T16:00:00.000Z',
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: { lat: 49.27, lng: -123.15 },
    displayArea: 'Kitsilano',
    neighbourhood: 'Kitsilano',
    municipalityId: 'Vancouver',
    sourceUrl: 'https://vancouver.ca/kits',
    bookingUrl: null,
    locationUrl: null,
  };
}

function record(cell: Cell) {
  return makeListing({
    id: `rec-${cell.status}-${String(cell.min)}-${String(cell.max)}`,
    activityName: 'Public Swim',
    venueName: 'Kitsilano Pool',
    costStatus: cell.status,
    costMinCad: cell.min,
    costMaxCad: cell.max,
    startDatetimeUtc: '2026-07-18T21:00:00.000Z',
    endDatetimeUtc: '2026-07-18T23:00:00.000Z',
  });
}

/**
 * The cost text the card actually renders, scraped from real markup rather than recomputed.
 * The card's meta block is three <span>s — when, "{ages} · {cost}", and distance — so the cost
 * read is everything after the LAST " · " of the second one. Structural assertions below fail
 * loudly (rather than silently returning '') if the card's shape ever changes.
 */
function cardCostLabel(cell: Cell): string {
  const activity = mapSearchItemToActivity({ distanceKm: 4.1, listing: dto(cell) });
  const html = renderToStaticMarkup(<ActivityCard activity={activity} />);
  const meta = html.match(/<div class="kf-card__meta">([\s\S]*?)<\/div>/);
  if (!meta) throw new Error('ActivityCard no longer renders a .kf-card__meta block');
  const spans = [...meta[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) =>
    m[1].replace(/<!--[\s\S]*?-->/g, ''),
  );
  if (spans.length !== 3) throw new Error(`expected 3 meta spans on the card, saw ${spans.length}`);
  const separator = spans[1].lastIndexOf(' · ');
  if (separator === -1) throw new Error(`card meta span has no "ages · cost" separator: ${spans[1]}`);
  return spans[1].slice(separator + ' · '.length).trim();
}

// ── The closed label vocabularies ────────────────────────────────────────────
// Each surface may only ever say one of these things. An unrecognised label THROWS rather than
// being classified generously: a new word must be added here deliberately, where its claim has
// to be declared, instead of slipping through the invariant as an unclassified string.

const CARD_UNKNOWN = 'Price not confirmed — check source';
const EMAIL_UNKNOWN = ['Cost varies', 'Check source for cost', 'Cost not listed'];
const FREE = 'Free';

/** What a label CLAIMS, as opposed to how it words it. The unit of cross-surface agreement. */
type Claim = 'free' | 'number' | 'unstated';

function cardClaim(label: string): Claim {
  if (label === FREE) return 'free';
  if (label === CARD_UNKNOWN) return 'unstated';
  if (/^\$/.test(label)) return 'number';
  throw new Error(`card produced an unrecognised cost label: ${JSON.stringify(label)}`);
}

function emailClaim(label: string): Claim {
  if (label === FREE) return 'free';
  if (EMAIL_UNKNOWN.includes(label)) return 'unstated';
  if (/^\$/.test(label)) return 'number';
  throw new Error(`digest produced an unrecognised cost label: ${JSON.stringify(label)}`);
}

/** Every dollar figure a label prints, in order. Signed, so "$-5" cannot hide as 5. */
function printedAmounts(label: string): number[] {
  return [...label.matchAll(/\$(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

describe('cost honesty — the full (status x min x max) matrix', () => {
  it(`covers every reachable cell (${EXPECTED_CELL_COUNT})`, () => {
    expect(CELLS).toHaveLength(EXPECTED_CELL_COUNT);
    expect(new Set(CELLS.map((c) => c.name)).size).toBe(EXPECTED_CELL_COUNT);
  });

  for (const cell of CELLS) {
    it(cell.name, () => {
      const listing = record(cell);
      const card = cardCostLabel(cell);
      const email = emailCostLabel(listing);
      const free = isFree(listing);
      const inFreeFilter = matchesCost(listing, { free: true });
      const given = [cell.min, cell.max].filter((n): n is Exclude<Bound, null> => n != null);

      // (1) + (2) as one biconditional, on each surface: the word "Free" appears if and only if
      // isFree() says free. Left to right that is "no surface invents free"; right to left it is
      // "no surface hedges about a listing the Free filter is already returning as free".
      expect(cardClaim(card) === 'free', `card said ${JSON.stringify(card)}, isFree=${free}`).toBe(free);
      expect(emailClaim(email) === 'free', `email said ${JSON.stringify(email)}, isFree=${free}`).toBe(free);

      // (4) The surfaces choose their own words; they do not choose the claim.
      expect(cardClaim(card), `card ${JSON.stringify(card)} vs email ${JSON.stringify(email)}`).toBe(
        emailClaim(email),
      );

      // (3) Numbers are given, not generated — and never contradictory.
      for (const label of [card, email]) {
        const amounts = printedAmounts(label);
        for (const n of amounts) {
          expect(given, `${label} printed $${n}, which we were never given`).toContain(n);
          expect(n, `${label} printed a negative cost`).toBeGreaterThanOrEqual(0);
        }
        if (amounts.length === 2) {
          expect(amounts[0], `${label} printed a backwards range`).toBeLessThanOrEqual(amounts[1]);
          expect(amounts, `${label} printed a range that is not the given bounds`).toEqual([cell.min, cell.max]);
        }
        expect(amounts.length, `${label} printed more than two figures`).toBeLessThanOrEqual(2);
      }

      // Free-filter agreement, both directions that are in scope here:
      // free listings are always returned under the Free filter...
      if (free) expect(inFreeFilter, 'isFree but the Free filter drops it').toBe(true);
      // ...and a listing showing a PRICE never survives it, so no parent ever ticks Free and
      // keeps looking at a priced card.
      if (cardClaim(card) === 'number') expect(inFreeFilter, 'a priced card survived the Free filter').toBe(false);
    });
  }

  it('is non-vacuous: every claim and every label in both vocabularies really occurs', () => {
    // A NULL RESULT IS NOT A MATCH. Each assertion above is conditional, so a matrix that
    // silently produced one claim for all 100 cells would satisfy every one of them. This is the
    // positive control: the matrix genuinely exercises all three claims and all five labels.
    const cardLabels = new Set(CELLS.map(cardCostLabel));
    const emailLabels = new Set(CELLS.map((c) => emailCostLabel(record(c))));
    const claims = new Set(CELLS.map((c) => cardClaim(cardCostLabel(c))));

    expect(claims).toEqual(new Set<Claim>(['free', 'number', 'unstated']));
    expect(cardLabels).toContain(FREE);
    expect(cardLabels).toContain(CARD_UNKNOWN);
    expect([...cardLabels].some((l) => l.startsWith('$'))).toBe(true);
    for (const label of EMAIL_UNKNOWN) expect(emailLabels, `digest never said ${label}`).toContain(label);
    expect(emailLabels).toContain(FREE);
    expect([...emailLabels].some((l) => l.startsWith('$'))).toBe(true);
  });
});

describe('isFree() is the authority, and its asymmetry is pinned', () => {
  // isFree() must not move: the Free filter, the card and the digest all derive from it, so a
  // refactor that "tidied" it would silently relabel listings on both surfaces at once. The
  // true-set below is written out as DATA rather than recomputed from the rule — a restatement
  // would move with the code it is supposed to hold still (and a restatement is precisely how
  // the original defect got in).
  const FREE_CELLS = new Set<string>([
    // costStatus 'free' is free whatever the bounds say — the status is the source's own answer.
    ...BOUNDS.flatMap((min) => BOUNDS.map((max) => `free|${String(min)}|${String(max)}`)),
    // ...and exactly two 'known' cells, no others.
    'known|null|0',
    'known|0|0',
  ]);

  it('holds for all 100 cells, 27 of them free', () => {
    expect(FREE_CELLS.size).toBe(27);
    let trueCount = 0;
    for (const cell of CELLS) {
      const expected = FREE_CELLS.has(`${cell.status}|${String(cell.min)}|${String(cell.max)}`);
      expect(isFree(record(cell)), cell.name).toBe(expected);
      if (expected) trueCount += 1;
    }
    expect(trueCount).toBe(27);
  });

  it('THE ASYMMETRY: max must be exactly 0; min may be 0 OR ABSENT', () => {
    // The single sentence a formatter comment got wrong ("requires BOTH bounds at zero"), stated
    // here as executable fact. If someone "fixes" isFree to be symmetric, this fails by name.
    expect(isFree(makeListing({ costStatus: 'known', costMinCad: null, costMaxCad: 0 }))).toBe(true);
    expect(isFree(makeListing({ costStatus: 'known', costMinCad: 0, costMaxCad: null }))).toBe(false);
    expect(isFree(makeListing({ costStatus: 'known', costMinCad: 0, costMaxCad: 0 }))).toBe(true);
    expect(isFree(makeListing({ costStatus: 'known', costMinCad: null, costMaxCad: null }))).toBe(false);
  });
});

describe('the four defect cells, by name', () => {
  const label = (status: Status, min: Bound, max: Bound) => {
    const cell: Cell = { name: '', status, min, max };
    return { card: cardCostLabel(cell), email: emailCostLabel(record(cell)) };
  };

  it('known/null/0 — the CARD no longer denies a price the Free filter already claimed', () => {
    const { card, email } = label('known', null, 0);
    expect(isFree(makeListing({ costStatus: 'known', costMinCad: null, costMaxCad: 0 }))).toBe(true);
    expect(card).toBe(FREE); // was 'Price not confirmed — check source'
    expect(email).toBe(FREE);
  });

  it('known/0/null — the EMAIL no longer promises free for a listing the Free filter drops', () => {
    const listing = makeListing({ costStatus: 'known', costMinCad: 0, costMaxCad: null });
    expect(isFree(listing)).toBe(false);
    expect(matchesCost(listing, { free: true })).toBe(false);
    const { card, email } = label('known', 0, null);
    expect(email).toBe('Cost varies'); // was 'Free'
    expect(card).toBe(CARD_UNKNOWN);
  });

  it('known/7/0 — a contradictory range is an honest under-claim, not "$7–$0"', () => {
    const { card, email } = label('known', 7, 0);
    expect(card).toBe(CARD_UNKNOWN); // was '$7–$0'
    expect(email).toBe('Cost varies'); // was '$7–$0'
  });

  it('known/null/null — unchanged: still not free on either surface', () => {
    const { card, email } = label('known', null, null);
    expect(card).toBe(CARD_UNKNOWN);
    expect(email).toBe('Cost varies');
  });
});

describe('OUT OF SCOPE, PINNED NOT FIXED: known-with-no-usable-bounds vs genuinely unknown', () => {
  // WHAT QA FOUND, AND WHY IT IS STILL HERE. known/null/null and known/0/null now print exactly
  // the same words to a parent as a genuinely-unknown listing ("Price not confirmed — check source" on the
  // card), yet the Free filter EXCLUDES them while INCLUDING the true-unknown row. A parent ticks
  // Free, watches one card vanish and an identically-worded one stay.
  //
  // That is real. It is also a PRODUCT decision — resolving it changes which listings parents see
  // in results, which is Jon's call, not an implementer's. So it is pinned here rather than
  // changed: these assertions describe today's behaviour exactly, and whoever makes that call
  // will find this test failing with the reason written next to it.
  const knownNoBounds = makeListing({ costStatus: 'known', costMinCad: null, costMaxCad: null });
  const knownZeroFloor = makeListing({ costStatus: 'known', costMinCad: 0, costMaxCad: null });
  const trulyUnknown = makeListing({ costStatus: 'unknown' });

  it('the card words them identically', () => {
    expect(cardCostLabel({ name: '', status: 'known', min: null, max: null })).toBe(CARD_UNKNOWN);
    expect(cardCostLabel({ name: '', status: 'known', min: 0, max: null })).toBe(CARD_UNKNOWN);
    expect(cardCostLabel({ name: '', status: 'unknown', min: null, max: null })).toBe(CARD_UNKNOWN);
  });

  it('the Free filter does NOT treat them identically (unchanged, deliberately)', () => {
    expect(matchesCost(knownNoBounds, { free: true })).toBe(false);
    expect(matchesCost(knownZeroFloor, { free: true })).toBe(false);
    expect(matchesCost(trulyUnknown, { free: true })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — THE THIRD SURFACE: the front door's "Something free" slot.
//
// The card and the digest each state a cost. This one does something neither of them does: it
// puts a listing under a HEADING THAT MAKES THE CLAIM ITSELF ("Something free"), where the words
// a parent reads first are the block's, not the card's. So the invariant has a second half here —
// the slot must only ever offer a genuinely free listing, AND the card it renders must corroborate
// the heading rather than contradict it two lines below.
//
// This is the cell the whole feature could have got wrong. `free: true` is a FILTER and admits
// unknown/check_source prices deliberately (Jon, 2026-08-11/17: an unpriced listing is never
// suppressed) — measured live 2026-08-19, `when=today&free=1` reached 101 cards of which 20 of
// the first 100 were genuinely free. A slot built on the filter would have printed "Something
// free" over a listing whose price nobody knows roughly four times in five. `isFree()` is what
// decides, and this asserts that across all 100 cells rather than on the examples someone
// happened to think of — the same argument the top of this file makes.
// ─────────────────────────────────────────────────────────────────────────────

import { SearchEngine } from '../lib/search/engine';
import { InMemoryListingRepository } from '../lib/search/repository';
import { FixtureAliasResolver } from '../lib/search/expand';
import { RegionHierarchy } from '../lib/geo/region';
import { fsaGeocoder } from '../lib/geo/postal-fsa';
import { REGIONS } from '../lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '../lib/search/__fixtures__/aliases';
import { FIXTURE_NOW } from '../lib/search/__fixtures__/engine';
import { gatherSlotCandidates } from '../lib/recommend/three-things';

/** The same cost cell, as a listing that is on TODAY relative to FIXTURE_NOW and clears the gates. */
function frontDoorRecord(cell: Cell) {
  return makeListing({
    id: `fd-${cell.status}-${String(cell.min)}-${String(cell.max)}`,
    seriesId: `fd-series-${cell.status}-${String(cell.min)}-${String(cell.max)}`,
    activityName: 'Public Swim',
    venueName: 'Kitsilano Pool',
    costStatus: cell.status,
    costMinCad: cell.min,
    costMaxCad: cell.max,
    statusState: 'confirmed',
    ageMinMonths: 60,
    ageMaxMonths: 120,
    startDatetimeUtc: '2026-07-13T21:00:00.000Z',
    endDatetimeUtc: '2026-07-13T22:00:00.000Z',
    geo: { lat: 49.27, lng: -123.15 },
  });
}

/** Is this cost shape something the front door's free slot would actually offer a parent? */
function freeSlotOffers(cell: Cell): boolean {
  const record = frontDoorRecord(cell);
  const pools = gatherSlotCandidates({
    engine: new SearchEngine({
      repository: new InMemoryListingRepository([record]),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      geocoder: fsaGeocoder,
    }),
    now: FIXTURE_NOW,
    origin: null,
  });
  return pools.find((p) => p.key === 'free')!.candidates.some((c) => c.listing.id === record.id);
}

describe('T4 — the front door’s free slot obeys the same one rule', () => {
  it('offers a cell if and only if isFree() is true for it, across all 100', () => {
    const disagreements = CELLS.filter((cell) => freeSlotOffers(cell) !== isFree(record(cell)));
    expect(disagreements.map((c) => c.name)).toEqual([]);
  });

  it('is non-vacuous: the slot really does accept some cells and reject others', () => {
    // Without this, the assertion above passes on a slot that offers nothing at all — which is
    // exactly how a broken gate looks from the outside.
    const offered = CELLS.filter(freeSlotOffers);
    expect(offered.length).toBe(27); // the same 27 free cells the isFree() block above counts
    expect(offered.length).toBeLessThan(EXPECTED_CELL_COUNT);
  });

  it('never offers a cell the FILTER admits but isFree() rejects — the 4-in-5 defect', () => {
    // The concrete shape measured live: check_source with no bounds. matchesCost lets it through
    // under `free`, and it must still never reach a slot headed "Something free".
    const unpriced: Cell = { name: 'check_source / min=null / max=null', status: 'check_source', min: null, max: null };
    expect(matchesCost(record(unpriced), { free: true })).toBe(true); // the filter admits it…
    expect(isFree(record(unpriced))).toBe(false); // …and it is not free…
    expect(freeSlotOffers(unpriced)).toBe(false); // …so the slot declines it.
  });

  it('and the card under the heading corroborates it — the block and the card cannot disagree', () => {
    // The cross-surface claim this file exists for, applied to the new pairing: whenever the slot
    // offers a listing, the card rendered inside that slot says "Free" — never a number, never
    // "check source" two lines under a heading that already promised free.
    for (const cell of CELLS.filter(freeSlotOffers)) {
      expect({ cell: cell.name, label: cardCostLabel(cell) }).toEqual({ cell: cell.name, label: FREE });
    }
  });
});
