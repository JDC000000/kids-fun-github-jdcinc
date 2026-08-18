// lib/search/collapse.ts — One card per series, not one card per time slot and not one per day.
//
// The most visible cause of "bloat" in search results needs no classification to fix: it is the
// same activity, at the same venue, rendered as a separate card for every occurrence. A
// private-lesson series can occupy fifteen consecutive cards on one date; measured across the
// staging catalogue, 43 series produced 4+ occurrences on a single day (383 occurrences). A parent
// scanning "what's on today" wants ONE "Forte Piano — Killarney" card that says "15 slots,
// 3:15 PM–7:30 PM", and the choice of slot afterwards.
//
// WHY THE KEY IS THE SERIES ALONE, NOT (SERIES, DAY). This module used to group by
// (seriesId, local start date), which fixed the many-slots-in-one-day case and left the
// many-days-in-one-week case untouched. The 2026-08-18 independent report measured what that
// costs on a real page (its P1-2): `q=open gym` returned 60 results of which 20+ were the same
// weekly programmes repeated per day — "$3 Open Gym 8yrs+ Delbrook Tuesday", "…Wednesday",
// "…Thursday", "…Friday" — `q=beach` returned a top 5 that was five copies of one thing, and
// "60 results" was really about 8 real options a parent had to deduplicate by hand. A recurring
// programme is ONE thing to decide about, so it is one card, and `slots[]` carries every
// occurrence it stands for.
//
// WHAT THAT COSTS, AND WHAT PAYS FOR IT. The old key was chosen so a card's "3:15 PM–7:30 PM"
// span could never straddle a date. That span is still the honest thing to print for a card whose
// slots share one local day — and for a card whose slots do NOT, `slotLocalDays` reports every day
// it runs so the consumer prints the DAYS ("8 slots · Tue, Wed, Thu, Fri") instead of inventing a
// time range across them. The rule is unchanged in substance: a card may only state a span it
// actually occupies. See lib/search/engine.ts (`slotSpanEndUtc` is null for a multi-day card) and
// app/preview/_data/format.ts#formatSlotSummary.
//
// Order is preserved exactly: a group appears where its FIRST member appeared in the already
// ranked+sorted input, and that member is the one rendered. So collapsing never reorders results,
// it only removes repeats — the ranking and sort layers stay the single source of truth for
// position. Slots within a group are sorted by start time so the displayed span reads
// earliest→latest regardless of the incoming sort.
//
// Open-hours listings (null start — an aquarium, a mini-train) are never collapsed: they belong to
// no point in time at all, so there is nothing to collapse them ONTO. Each keeps its own card.

import type { ScoredListing } from './rank';
import type { CostStatus, ListingRecord } from './types';
import { localIsoDate } from './time/vancouver';

/** One occurrence inside a collapsed card — enough for the UI to render a time list and a cost. */
export interface OccurrenceSlot {
  id: string;
  startDatetimeUtc: string | null;
  endDatetimeUtc: string | null;
  /**
   * THIS occurrence's own cost, so a collapsed card can state what the GROUP costs rather than what
   * its representative costs (lib/search/filters/cost.ts#readGroupCost). Members of one group do
   * disagree in production — measured 2026-08-11 on the all-time set: 9 collapsed groups whose
   * members render different cost strings, e.g. $21.25 beside $85 and $103 beside $240.
   *
   * A WIDENING, NOT A LOOKUP: `toSlot` below already holds the whole `ListingRecord`, so these three
   * fields cost no extra query and no second round trip.
   */
  costStatus: CostStatus;
  costMinCad: number | null;
  costMaxCad: number | null;
}

/** A ranked result plus every same-series occurrence it now stands for. */
export interface CollapsedListing {
  /** The occurrence that keeps the card — the best-ranked member, i.e. the first one seen. */
  representative: ScoredListing;
  /** Every occurrence in the group (including the representative), ascending by start time. */
  slots: OccurrenceSlot[];
}

/**
 * Collapse same-series occurrences into one entry each, preserving input order.
 * A listing with no start time, or with an unparseable one, is always returned on its own.
 */
export function collapseSeries(scored: ScoredListing[]): CollapsedListing[] {
  const groups: CollapsedListing[] = [];
  const indexByKey = new Map<string, number>();

  for (const item of scored) {
    const slot = toSlot(item);
    const key = groupKey(item);

    // No key → uncollapsable (open-hours / undated): always its own card.
    if (key == null) {
      groups.push({ representative: item, slots: [slot] });
      continue;
    }

    const existing = indexByKey.get(key);
    if (existing == null) {
      indexByKey.set(key, groups.length);
      groups.push({ representative: item, slots: [slot] });
      continue;
    }
    groups[existing].slots.push(slot);
  }

  for (const group of groups) group.slots.sort(byStartThenId);
  return groups;
}

/**
 * The listing's `seriesId`, or null when the listing belongs to no point in time and is therefore
 * never collapsed onto anything (open-hours / undated / unparseable start).
 *
 * Exported because "what counts as ONE card" must have exactly one definition. The facet counter
 * (lib/search/facets.ts) reports counts in CARDS so its numbers match the collapsed list a parent
 * sees; it counts distinct keys with this function rather than re-deriving the rule, so the two
 * can never disagree about whether two occurrences are the same card.
 *
 * The unparseable-start arm is deliberate rather than defensive noise: a row whose start cannot be
 * read has no place in a slot list that is ordered by start and described by its span, so it keeps
 * its own card instead of being seated silently at the end of someone else's.
 */
export function collapseKey(listing: Pick<ListingRecord, 'seriesId' | 'openHours' | 'startDatetimeUtc'>): string | null {
  if (listing.openHours) return null;
  const start = listing.startDatetimeUtc;
  if (!start) return null;
  if (safeLocalIsoDate(start) == null) return null;
  return listing.seriesId;
}

/**
 * Every distinct America/Vancouver local day a card's slots fall on, ascending. Empty for a card
 * with no dated slot at all (an open-hours attraction).
 *
 * This is what lets a collapsed card describe itself honestly now that one card can span days:
 * exactly one day means the card may state a single time span ("15 slots, 3:15 PM–7:30 PM"), and
 * more than one means it must state the DAYS instead. Derived here, beside the grouping rule, so
 * the question "how many days is this card?" has the same answer everywhere it is asked.
 */
export function slotLocalDays(slots: OccurrenceSlot[]): string[] {
  const days = new Set<string>();
  for (const slot of slots) {
    if (!slot.startDatetimeUtc) continue;
    const day = safeLocalIsoDate(slot.startDatetimeUtc);
    if (day != null) days.add(day);
  }
  return [...days].sort();
}

function groupKey(item: ScoredListing): string | null {
  return collapseKey(item.candidate.listing);
}

function safeLocalIsoDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return localIsoDate(date);
}

function toSlot(item: ScoredListing): OccurrenceSlot {
  const l = item.candidate.listing;
  return {
    id: l.id,
    startDatetimeUtc: l.startDatetimeUtc,
    endDatetimeUtc: l.endDatetimeUtc,
    costStatus: l.costStatus,
    costMinCad: l.costMinCad,
    costMaxCad: l.costMaxCad,
  };
}

/** Earliest start first; ties broken by id so the slot list is deterministic. */
function byStartThenId(a: OccurrenceSlot, b: OccurrenceSlot): number {
  const av = a.startDatetimeUtc ? Date.parse(a.startDatetimeUtc) : Number.POSITIVE_INFINITY;
  const bv = b.startDatetimeUtc ? Date.parse(b.startDatetimeUtc) : Number.POSITIVE_INFINITY;
  return av - bv || a.id.localeCompare(b.id);
}

/**
 * The end of the last slot in a group — the closing edge of the card's "3:15 PM–7:30 PM" span.
 *
 * Only meaningful for a card whose slots share ONE local day; the engine reads `slotLocalDays`
 * first and publishes no span at all for a card that spans several.
 */
export function slotSpanEnd(slots: OccurrenceSlot[]): string | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const slot = slots[i];
    if (slot.endDatetimeUtc) return slot.endDatetimeUtc;
    if (slot.startDatetimeUtc) return slot.startDatetimeUtc;
  }
  return null;
}
