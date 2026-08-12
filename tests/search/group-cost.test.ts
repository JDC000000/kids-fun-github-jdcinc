// tests/search/group-cost.test.ts — a collapsed card must not print one session's price while
// standing for sessions at other prices (F5).
//
// THE DEFECT, MEASURED RATHER THAN ARGUED. A collapsed card stands for every same-series-same-day
// occurrence (lib/search/collapse.ts) and used to print only the REPRESENTATIVE's cost, so a card
// standing for a $103 session and a $240 session said "$103". Measured on production, all-time,
// 2026-08-11: 9 collapsed groups whose members render different cost strings — $21.25 beside $85,
// $103 beside $240, and $6 beside a member with no stated cost. (Cited as measured on that date,
// not as a current count: re-measuring needs credentials, and nothing here depends on it still
// being exactly 9 — the three patterns below are synthetic fixtures of the real shapes.)
//
// It is worst exactly where it costs most. `applySort` runs per OCCURRENCE before collapsing
// (lib/search/engine.ts), and collapse keeps the first member in sorted order, so under the
// lowest-cost sort the representative is systematically the CHEAPEST member of its group: the
// parent choosing on price is the one guaranteed to be shown the lowest number in the group.
//
// WHAT THIS FILE PINS, in the order the value flows:
//   (1) `readGroupCost` — the authority. Agreement, the group range, and the decline.
//   (2) THE NO-CHANGE GUARANTEE — a card whose group has one member, or whose members agree, keeps
//       its label to the byte. This unit must not touch any card that never had the defect.
//   (3) The card's words, and that they are NOT the single-session `range` words (a hard fence).
//   (4) The pipeline: slot → DTO → Activity → label, plus the ordering that needed no change.
//   (5) The premise under two "type-required, runtime-dead" comments: `readCost` cannot produce
//       the group arm, so neither `lowestCostValue` nor the digest can ever reach it.

import { describe, expect, it } from 'vitest';
import { readCost, readGroupCost, type CostFacts } from '../../lib/search/filters/cost';
import { collapseSameDaySeries } from '../../lib/search/collapse';
import { applySort } from '../../lib/search/sort';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ScoredListing } from '../../lib/search/rank';
import type { ListingRecord } from '../../lib/search/types';
import { formatCost } from '../../app/preview/_data/format';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { SlotCost } from '../../app/preview/_data/types';

/** The card's one not-a-number read, restated here so a silent wording change fails loudly. */
const COST_UNKNOWN = 'Cost — check source';

const known = (min: number | null, max: number | null = null): CostFacts => ({
  costStatus: 'known',
  costMinCad: min,
  costMaxCad: max,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (1) readGroupCost — the authority
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('readGroupCost — what a COLLAPSED CARD may say about its cost', () => {
  it('a group of one is exactly readCost() — the same answer, cell for cell', () => {
    // The no-change guarantee at its source. Every cell the module's own docs call out, including
    // the two the pre-U4 hand-rolled mirrors disagreed about and the contradictory-bounds row.
    const cells: CostFacts[] = [
      { costStatus: 'free' },
      { costStatus: 'unknown' },
      { costStatus: 'check_source' },
      { costStatus: 'known' },
      known(null, 0), // isFree TRUE — ceiling of zero
      known(0, null), // isFree FALSE — a floor of zero is not a price
      known(0, 0),
      known(7, 0), // contradictory: an honest under-claim, never "$7–$0"
      known(-5),
      known(6),
      known(21.25),
      known(85, 85),
      known(103, 240),
    ];
    for (const cell of cells) {
      expect(readGroupCost([cell]), JSON.stringify(cell)).toEqual(readCost(cell));
    }
  });

  it('members that AGREE say what they agreed — free, one amount, one range', () => {
    expect(readGroupCost([{ costStatus: 'free' }, { costStatus: 'free' }])).toEqual({ kind: 'free' });
    expect(readGroupCost([known(85), known(85), known(85)])).toEqual({ kind: 'amount', amount: 85 });
    expect(readGroupCost([known(103, 240), known(103, 240)])).toEqual({ kind: 'range', min: 103, max: 240 });
    // Agreement is about the CLAIM, not the raw fields: `known/85/85` and `known/85/null` both read
    // as $85, so a group of the two agrees and must not be forced into a range of one number.
    expect(readGroupCost([known(85, 85), known(85)])).toEqual({ kind: 'amount', amount: 85 });
  });

  it('members that DISAGREE and all state a cost give the GROUP range', () => {
    // The three patterns measured in production, 2026-08-11.
    expect(readGroupCost([known(21.25), known(85)])).toEqual({ kind: 'group_range', min: 21.25, max: 85 });
    expect(readGroupCost([known(103), known(240)])).toEqual({ kind: 'group_range', min: 103, max: 240 });
    // …and the third one declines, below.
  });

  it('ANY member we cannot price makes the whole group DECLINE', () => {
    // The third measured pattern: $6 beside a member with no stated cost. A range missing its
    // ceiling is not a range, so the card says it has no price rather than drawing one too narrow.
    expect(readGroupCost([known(6), { costStatus: 'unknown' }])).toEqual({ kind: 'unstated' });
    expect(readGroupCost([known(6), { costStatus: 'check_source' }])).toEqual({ kind: 'unstated' });
    expect(readGroupCost([known(6), { costStatus: 'known' }])).toEqual({ kind: 'unstated' });
    // The cells readCost itself declines are declines here too, by delegation rather than by a
    // second copy of the rule: a lone zero, contradictory bounds, a negative bound.
    expect(readGroupCost([known(6), known(0, null)])).toEqual({ kind: 'unstated' });
    expect(readGroupCost([known(6), known(7, 0)])).toEqual({ kind: 'unstated' });
    expect(readGroupCost([known(6), known(-5)])).toEqual({ kind: 'unstated' });
  });

  it('spans every member, not just the first two, and orders min <= max whatever the input order', () => {
    expect(readGroupCost([known(85), known(21.25), known(240), known(103)])).toEqual({
      kind: 'group_range',
      min: 21.25,
      max: 240,
    });
    // A member that is itself a range contributes its FLOOR and its CEILING.
    expect(readGroupCost([known(85), known(103, 240)])).toEqual({ kind: 'group_range', min: 85, max: 240 });
    expect(readGroupCost([known(10, 20), known(30, 40)])).toEqual({ kind: 'group_range', min: 10, max: 40 });
  });

  it('a FREE member counts as $0 rather than blocking the range — and an all-free group is Free', () => {
    // isFree() has already ruled that session genuinely free, so 0 is a number we HOLD about it,
    // not the lone zero readCost refuses to print. It is also what lowestCostValue has always
    // ordered free at, so the aggregate and the ordering cannot disagree about what free is worth.
    expect(readGroupCost([{ costStatus: 'free' }, known(85)])).toEqual({ kind: 'group_range', min: 0, max: 85 });
    expect(readGroupCost([{ costStatus: 'free' }, { costStatus: 'free' }])).toEqual({ kind: 'free' });
    // And the cell that LOOKS free but is not stays a decline, so "$0" never appears for a listing
    // the Free filter would drop.
    expect(readGroupCost([known(0, null), known(85)])).toEqual({ kind: 'unstated' });
  });

  it('declines an empty group rather than inventing a span', () => {
    expect(readGroupCost([])).toEqual({ kind: 'unstated' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (2) THE NO-CHANGE GUARANTEE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every cost cell the card can be in, with the EXACT string it printed before this unit. */
const CARD_LABELS: [string, Parameters<typeof formatCost>[0], string][] = [
  ['free status', { costStatus: 'free' }, 'Free'],
  ['known, ceiling of zero', { costStatus: 'known', costMaxCad: 0 }, 'Free'],
  ['known, both bounds zero', { costStatus: 'known', costMinCad: 0, costMaxCad: 0 }, 'Free'],
  ['known, floor of zero only', { costStatus: 'known', costMinCad: 0 }, COST_UNKNOWN],
  ['known, no bounds at all', { costStatus: 'known' }, COST_UNKNOWN],
  ['known, negative bound', { costStatus: 'known', costMinCad: -5 }, COST_UNKNOWN],
  ['known, contradictory bounds', { costStatus: 'known', costMinCad: 7, costMaxCad: 0 }, COST_UNKNOWN],
  ['unknown status', { costStatus: 'unknown' }, COST_UNKNOWN],
  ['one amount', { costStatus: 'known', costMinCad: 85 }, '$85 approx.'],
  ['part-dollar amount', { costStatus: 'known', costMinCad: 21.25 }, '$21.25 approx.'],
  ['equal bounds', { costStatus: 'known', costMinCad: 85, costMaxCad: 85 }, '$85 approx.'],
  ['one session, spanning bounds', { costStatus: 'known', costMinCad: 103, costMaxCad: 240 }, '$103–$240'],
];

describe('the no-change guarantee — this unit must not touch a card that never had the defect', () => {
  it('a card with NO slot costs prints exactly what it printed before, in every cell', () => {
    for (const [name, activity, expected] of CARD_LABELS) {
      expect(formatCost(activity), name).toBe(expected);
    }
  });

  it('a card standing for ONE slot prints the same string as a card standing for none', () => {
    for (const [name, activity, expected] of CARD_LABELS) {
      expect(formatCost({ ...activity, slotCosts: [activity] }), name).toBe(expected);
    }
  });

  it('a card whose members AGREE prints the same string as its representative alone', () => {
    for (const [name, activity, expected] of CARD_LABELS) {
      const group = { ...activity, slotCosts: [activity, activity, activity] };
      expect(formatCost(group), name).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (3) THE CARD'S WORDS
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the card's words for a group that disagrees", () => {
  // The preview layer carries its OWN three-value CostStatus (`check_source` is mapped to
  // `unknown` on the way in by `mapCost`), so the card's slots are `SlotCost`, not `CostFacts`.
  const cardKnown = (min?: number, max?: number): SlotCost => ({
    costStatus: 'known',
    ...(min != null ? { costMinCad: min } : {}),
    ...(max != null ? { costMaxCad: max } : {}),
  });
  const groupOf = (...slotCosts: SlotCost[]) =>
    formatCost({ costStatus: 'known', costMinCad: 103, costMaxCad: 240, slotCosts });

  it('states the span, and says it VARIES', () => {
    expect(groupOf(cardKnown(103), cardKnown(240))).toBe('Varies: $103–$240');
    expect(groupOf(cardKnown(21.25), cardKnown(85))).toBe('Varies: $21.25–$85');
  });

  it('IS VISIBLY DISTINCT from one session whose own bounds span the same numbers', () => {
    // THE HARD FENCE (Jon, 2026-08-12). "$103–$240" already means ONE session priced across that
    // span; a group means one session at $103 and a different one at $240. The same string for
    // both claims would recreate the two-meanings-one-label defect this programme exists to close.
    const oneSession = formatCost({ costStatus: 'known', costMinCad: 103, costMaxCad: 240 });
    const wholeGroup = groupOf(cardKnown(103), cardKnown(240));
    expect(oneSession).toBe('$103–$240');
    expect(wholeGroup).not.toBe(oneSession);
    expect(wholeGroup.startsWith(oneSession)).toBe(false);
  });

  it('declines in the card\'s EXISTING words when a member has no stated cost', () => {
    // The decline reuses `unstated`, so this string is unchanged from today — which is what keeps
    // the card honest without inventing a fourth not-a-number label it has no room for.
    expect(groupOf(cardKnown(6), { costStatus: 'unknown' })).toBe(COST_UNKNOWN);
  });

  it('a free member widens the span to $0 rather than claiming the card is Free', () => {
    expect(groupOf({ costStatus: 'free' }, cardKnown(85))).toBe('Varies: $0–$85');
    expect(groupOf({ costStatus: 'free' }, cardKnown(85))).not.toBe('Free');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (4) THE PIPELINE — slot → DTO → Activity → label
// ─────────────────────────────────────────────────────────────────────────────────────────────

function scored(overrides: Partial<ListingRecord> & { id: string }, score = 1): ScoredListing {
  return {
    candidate: { listing: makeListing(overrides), relevance: 1, matchedTerms: [], categoryHit: true },
    score,
    distanceKm: null,
    components: {} as ScoredListing['components'],
  };
}

const PIANO = 'series-piano';
const DAY = '2026-08-08T22:15:00Z';

describe('collapseSameDaySeries carries every member\'s OWN cost', () => {
  it('puts each slot\'s three cost fields on its slot, not the representative\'s', () => {
    const groups = collapseSameDaySeries([
      scored({ id: 'a', seriesId: PIANO, startDatetimeUtc: DAY, costStatus: 'known', costMinCad: 103, costMaxCad: 103 }),
      scored({ id: 'b', seriesId: PIANO, startDatetimeUtc: '2026-08-08T23:15:00Z', costStatus: 'known', costMinCad: 240, costMaxCad: 240 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => [s.id, s.costStatus, s.costMinCad, s.costMaxCad])).toEqual([
      ['a', 'known', 103, 103],
      ['b', 'known', 240, 240],
    ]);
    // …and the group as a whole is a range the representative alone would never have printed.
    expect(readGroupCost(groups[0].slots)).toEqual({ kind: 'group_range', min: 103, max: 240 });
    expect(readCost(groups[0].representative.candidate.listing)).toEqual({ kind: 'amount', amount: 103 });
  });
});

const dto = (over: Partial<ListingRecordDto> = {}): ListingRecordDto => ({
  id: 'l1',
  activityName: 'Piano lesson',
  primaryCategoryKey: 'museum_arts',
  venueName: 'Killarney',
  organisation: null,
  descriptionSnippet: 'A piano lesson.',
  startDatetimeUtc: DAY,
  endDatetimeUtc: '2026-08-08T22:45:00Z',
  costStatus: 'known',
  costMinCad: 103,
  costMaxCad: 103,
  statusState: 'confirmed',
  confidenceLabel: 'official',
  lastCheckedAtUtc: '2026-08-08T12:00:00Z',
  ageMinMonths: 60,
  ageMaxMonths: 120,
  geo: { lat: 49.26, lng: -123.07 },
  displayArea: 'Killarney',
  neighbourhood: 'Killarney',
  municipalityId: null,
  sourceUrl: 'https://vancouver.ca/piano',
  bookingUrl: null,
  locationUrl: null,
  ...over,
});

const slot = (id: string, min: number | null, max: number | null, status: ListingRecordDto['costStatus'] = 'known') => ({
  id,
  startDatetimeUtc: DAY,
  endDatetimeUtc: '2026-08-08T22:45:00Z',
  costStatus: status,
  costMinCad: min,
  costMaxCad: max,
});

describe('the whole path a parent actually sees', () => {
  it('a DTO whose slots disagree renders the group range on the card', () => {
    const activity = mapSearchItemToActivity({
      listing: dto(),
      distanceKm: 1,
      slots: [slot('l1', 103, 103), slot('l2', 240, 240)],
    });
    expect(activity.slotCosts).toEqual([
      { costStatus: 'known', costMinCad: 103, costMaxCad: 103 },
      { costStatus: 'known', costMinCad: 240, costMaxCad: 240 },
    ]);
    expect(formatCost(activity)).toBe('Varies: $103–$240');
  });

  it('a DTO whose slots disagree AND include an unstated member declines on the card', () => {
    const activity = mapSearchItemToActivity({
      listing: dto({ costMinCad: 6, costMaxCad: 6 }),
      distanceKm: 1,
      slots: [slot('l1', 6, 6), slot('l2', null, null, 'check_source')],
    });
    expect(formatCost(activity)).toBe(COST_UNKNOWN);
  });

  it('a SINGLE-slot DTO carries no slot costs at all, so its Activity is shaped as before', () => {
    const activity = mapSearchItemToActivity({ listing: dto(), distanceKm: 1, slots: [slot('l1', 103, 103)] });
    expect(activity.slotCosts).toBeUndefined();
    expect(activity.slotCount).toBeUndefined();
    expect(formatCost(activity)).toBe('$103 approx.');
  });

  it('a DTO with no slots key at all is untouched', () => {
    const activity = mapSearchItemToActivity({ listing: dto(), distanceKm: 1 });
    expect(activity.slotCosts).toBeUndefined();
    expect(formatCost(activity)).toBe('$103 approx.');
  });
});

describe('the lowest-cost ordering needed no change, and this is why', () => {
  it('sorting runs per OCCURRENCE before collapsing, so a group already lands at its cheapest member', () => {
    const dear = scored({ id: 'dear', seriesId: PIANO, startDatetimeUtc: '2026-08-08T23:15:00Z', costStatus: 'known', costMinCad: 240, costMaxCad: 240 });
    const cheap = scored({ id: 'cheap', seriesId: PIANO, startDatetimeUtc: DAY, costStatus: 'known', costMinCad: 103, costMaxCad: 103 });
    const other = scored({ id: 'other', seriesId: 'series-swim', startDatetimeUtc: DAY, costStatus: 'known', costMinCad: 150, costMaxCad: 150 });

    const groups = collapseSameDaySeries(applySort([dear, other, cheap], 'lowest_cost'));

    // The piano group sorts at $103 — its own floor — not at the $240 member that happened to
    // arrive first, and not behind the $150 swim.
    expect(groups.map((g) => g.representative.candidate.listing.id)).toEqual(['cheap', 'other']);
    // …and the card at that position now says the group varies rather than repeating "$103".
    expect(readGroupCost(groups[0].slots)).toEqual({ kind: 'group_range', min: 103, max: 240 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (5) THE PREMISE UNDER THE TWO "TYPE-REQUIRED, RUNTIME-DEAD" ARMS
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('readCost cannot produce the group arm — the premise two comments rest on', () => {
  it('never returns `group_range` for any single listing, in any cost cell', () => {
    // `lowestCostValue` (lib/search/sort.ts) and the digest's formatCost (lib/email/format.ts) both
    // carry a `group_range` arm they document as unreachable, because both are fed `readCost` and
    // neither ever sees a group. If that ever stops being true those two comments become wrong and
    // the digest starts printing words nobody re-read — so the claim is pinned here rather than
    // left as prose. (The digest's own words for the arm cannot be exercised through its public
    // API for exactly this reason: it takes one ListingRecord and has no group concept at all.)
    const statuses = ['known', 'free', 'unknown', 'check_source'] as const;
    const bounds: (number | null)[] = [null, -5, 0, 6, 21.25, 85, 240];
    for (const costStatus of statuses) {
      for (const costMinCad of bounds) {
        for (const costMaxCad of bounds) {
          const read = readCost({ costStatus, costMinCad, costMaxCad });
          expect(read.kind, `${costStatus}/${costMinCad}/${costMaxCad}`).not.toBe('group_range');
        }
      }
    }
  });
});
