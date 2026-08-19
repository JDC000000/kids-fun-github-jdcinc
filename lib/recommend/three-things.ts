// lib/recommend/three-things.ts — pick the three things the front door offers a parent who has
// typed nothing ("answer before search", Track A; docs/answer-before-search-design.md §9.2 A1/A2).
//
// PURE OVER A WIRED ENGINE, exactly like lib/email/digest.ts: given a SearchEngine, a clock and
// (optionally) an origin and the ages a parent has already told us about, it returns up to three
// filled slots and a REASON for every slot it could not fill. No DB, no network, no `new Date()`.
// All the glue — building the engine, deciding the default area, reading the on-device child
// profile — belongs to the caller, so this module is exhaustively testable against a fixture
// engine and cannot drift from what /search would show in the same environment.
//
// ── THE FOUR RULES THIS MODULE EXISTS TO KEEP (Jon's ruling, 2026-08-19) ────────────────────
//
// 1. EVERY REQUEST PASSES `minResults: 0`, WITHOUT EXCEPTION (ruling 7.5, design §2c). The
//    engine's broadening ladder relaxes DATES first, so a non-zero minimum on a "what's on right
//    now" surface prints TOMORROW's LEGO Club under a heading that says today — measured live in
//    §2c, and the honest `broadening.applied` disclosure that saves /search has nowhere to go on
//    a three-card hero. `buildSlotRequests` is the ONE place a request is constructed, and it
//    applies `minResults: 0` last, after every spread, so no future slot can opt out by accident.
//    An unfillable slot is answered by `EmptySlot`, never by widening the question.
//
// 2. SLOTS ARE FILLED FROM `response.results` ONLY — never `ageUnconfirmed`, never `expected`
//    (ruling 7.6, design §5b). `ageUnconfirmed` is the engine's holding pen for listings admitted
//    under an age filter that the SOURCE never stated an age for; /search can hold them under a
//    heading that says so, and a three-card recommendation cannot. `expected` is the
//    seasonal/evergreen section — "probably on" is not "on today".
//
// 3. THE FRONT-DOOR GATES ARE CARRIED FORWARD, NOT REINVENTED (`isShowableOnFrontDoor`). This
//    block REPLACES app/_components/HomeTodayStrip.tsx, whose two exclusions were fixed tonight
//    (9738650 / b9cdc9c / b46de05); replacing a component must not regress it.
//
// 4. NOTHING HERE PERSISTS A COORDINATE (ruling 7.4). The origin arrives as an argument and
//    leaves as a distance on a card. This module has no storage of any kind.
//
// ── CROSS-SLOT DE-DUPE AND ORDERING (A3) ───────────────────────────────────────────────────
// Designed in docs/three-things-selection-design.md and approved by Jon on 2026-08-19; the
// reasoning behind every rule below lives there rather than being restated here. The short
// version of WHY it is needed at all, measured the same day: the three gated pools hold 41 rows
// but only 33 distinct listings, the free pool's #2 IS the nearby pool's #2, and "LEGO® Block
// Party" occupies two of the four showable indoor cards at two different library branches — two
// different `seriesId`s, so `collapseSeries` cannot see it and neither could a de-dupe on ids.

import type { SearchEngine, SearchRequest, SearchResultItem } from '@/lib/search/engine';
import type { AgeBandKey, GeoPoint } from '@/lib/search/types';
// The engine's OWN predicates, reused rather than mirrored (design §9.2 A2). `isFree` is the
// authority on the word "free" for every surface in this product; `isAdultOrSeniorOnly` is the
// audience exclusion HomeTodayStrip already applies. There is no third copy of either.
import { isFree } from '@/lib/search/filters/cost';
import { isAdultOrSeniorOnly, type AudienceSignalInput } from '@/lib/search/filters/audience';
import { isConfirmedSection } from '@/lib/search/filters/status';
// The venue-identity rule the engine's own diversity cap runs on, shared rather than restated so
// the block's cross-slot preference and `capVenueRepetition`'s within-list cap cannot disagree
// about when two cards are at the same place.
import { venueIdentity } from '@/lib/search/venue-diversity';

/** The three things the front door offers. Order here is the order they are asked for. */
export type SlotKey = 'free' | 'indoor' | 'nearby';

export const SLOT_KEYS: readonly SlotKey[] = ['free', 'indoor', 'nearby'] as const;

/**
 * Where "near" is measured from, and what the surface may CALL that place.
 *
 * The label is carried rather than read back off `SearchResponse.origin.label`, and that is not
 * fussiness. Ruling 7.4 defaults the front door to a fixed downtown-Vancouver point that the
 * parent never chose, and `resolveOrigin`'s `near_me` mode labels its result "Near me" — a
 * sentence about the READER that nothing on a cold page load could possibly know. The engine's
 * `near_me` mode is the only transport for a raw coordinate (`area_chip` takes a region id and
 * yields a municipal centroid, not a downtown one), so this module uses it as transport and
 * leaves the words to the caller, which is the only layer that knows whether the point came from
 * a default or from a parent tapping "change area".
 */
export interface ThreeThingsOrigin {
  geo: GeoPoint;
  /** Human name for the place, e.g. "downtown Vancouver". Never "near me" unless it truly is. */
  label: string;
}

export interface ThreeThingsInput {
  engine: SearchEngine;
  /** The clock. Passed, never read from the ambient one, so every selection is reproducible. */
  now: Date;
  /**
   * Where to measure "nearby" from. Null/absent is a FIRST-CLASS state, not a degenerate one:
   * an anonymous parent on a cold page load has no origin at all (design §4), and the nearby
   * slot then reports `no_origin` rather than quietly becoming a fourth citywide list.
   */
  origin?: ThreeThingsOrigin | null;
  /** Travel radius for the nearby slot, km. */
  radiusKm?: number;
  /**
   * Age bands the parent has already told us about (lib/profile/child-profile.ts, read-only).
   * Absent/empty means NO age is known, which is the honest default: the engine's confirmation
   * signal only exists under an active age filter (design §5a), so pre-age this surface may say
   * "on today near you" and may not say "for your kid" (ruling 7.6).
   */
  ageBands?: AgeBandKey[];
}

export const DEFAULT_NEARBY_RADIUS_KM = 5;

/** Why a slot has no card. Every one of these is a sentence the surface can print (ruling 7.5). */
export type SlotEmptyReason =
  /** The nearby slot, with no origin to measure from. Not a failure — an unasked question. */
  | 'no_origin'
  /** The engine reached no cards at all for this slot's question. "Nothing indoor is on today." */
  | 'nothing_on'
  /**
   * The engine reached cards, and none was a thing this surface may stand behind — every
   * candidate failed `isShowableOnFrontDoor` or, for the free slot, `isFree`. Distinct from
   * `nothing_on` on purpose: "there is nothing indoor today" and "there is indoor content today
   * but nobody ever said who it is for" are different facts, and a surface that collapses them
   * tells a parent the catalogue is emptier than it is.
   */
  | 'none_showable';

export interface FilledSlot {
  key: SlotKey;
  state: 'filled';
  item: SearchResultItem;
}

export interface EmptySlot {
  key: SlotKey;
  state: 'empty';
  reason: SlotEmptyReason;
  /** Cards the engine reached for this slot before the front-door gates. 0 ⇔ `nothing_on`. */
  reached: number;
}

export type ThingSlot = FilledSlot | EmptySlot;

export interface ThreeThings {
  slots: ThingSlot[];
  /**
   * True when an age was actually known and passed to the engine. The surface's copy hangs off
   * this: false ⇒ "on today near you", true ⇒ the age-aware framing is available (ruling 7.6).
   * Reported rather than re-derived so the copy layer cannot reach a different conclusion than
   * the query did.
   */
  ageAware: boolean;
  /** The place "nearby" was measured from, echoed for the label. Null when there was no origin. */
  origin: ThreeThingsOrigin | null;
}

/** One slot's question and the cards it reached, before anything is chosen. */
export interface SlotCandidates {
  key: SlotKey;
  /** Showable cards, in the engine's own order. Empty when nothing survived the gates. */
  candidates: SearchResultItem[];
  /** `SearchResponse.total` — every card the engine reached, before the gates. */
  reached: number;
  /** Set when the slot's question could not be asked at all (today: only `no_origin`). */
  unaskable: SlotEmptyReason | null;
}

/**
 * Given every slot's eligible candidates, decide which card each slot shows.
 *
 * Separated from candidate-gathering because the two are different kinds of decision: gathering
 * is "what may this slot honestly show", which the rulings settle; choosing is "which one, and
 * how do we stop three slots printing one listing three times", which is A3. Keeping the seam
 * explicit is what lets T1 pin the gates against fixed candidate lists without also pinning the
 * assignment policy, and vice versa.
 *
 * A chooser MUST return a card the slot actually offered, or null. It may return null for a slot
 * whose candidate list is non-empty — that is exactly how a de-dupe policy declines a duplicate —
 * and the slot then reports `none_showable`.
 */
export type SlotChooser = (pools: SlotCandidates[], now: Date) => Map<SlotKey, SearchResultItem | null>;

/**
 * Each slot takes its own best-ranked eligible card, independently — NO cross-slot de-dupe.
 *
 * Kept, exported and named for what it is because it is the control T1 measures the real chooser
 * against: a de-dupe test that cannot show the duplicate happening without the rule is a test
 * that would pass on an empty implementation. Never use it on a real surface — measured
 * 2026-08-19, six listings sit in BOTH the free and the nearby pool (identical `listing.id`), so
 * this prints one card twice as soon as either overlap reaches a pool's head.
 */
export const firstEligiblePerSlot: SlotChooser = (pools) => {
  const picks = new Map<SlotKey, SearchResultItem | null>();
  for (const pool of pools) picks.set(pool.key, pool.candidates[0] ?? null);
  return picks;
};

// ── A3: "is this the same thing?" ───────────────────────────────────────────────────────────

/** `$3`, `$3.00`, `$0.00 - $8.75` — the currency sign is the whole evidence, as at ingest. */
const PRICE_RE = /\$\s*\d[\d.,]*/g;
/** A clock time needs a colon or a meridiem: `3:30`, `5pm`, `5 p.m.`. A bare number never is. */
const TIME_RE = /\b\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?|\b\d{1,2}\s*[ap]\.?m\.?/g;
/** `0-12yrs`, `8yrs+`, `Ages 6-13` — never what distinguishes two different activities. */
const AGE_TOKEN_RE = /\b(?:ages?\s*)?\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\s*(?:yrs?|years?)?\b|\b\d{1,2}\s*(?:yrs?|years?)\s*\+?/g;
/** A weekday. Only ever stripped from the END — see `foldTitleForComparison`. */
const TRAILING_WEEKDAY_RE = /\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\s*$/;
/** "- Set Two", "- Two Sets" — a timetable's own session numbering, not a different activity. */
const SESSION_QUALIFIER_RE = /\b(?:sets?\s+(?:one|two|three|\d)|(?:one|two|three|\d)\s+sets?)\b/g;

/**
 * A title reduced to something two cards can be COMPARED on. Never rendered — nobody reads this.
 *
 * WHY THIS IS NOT `worker/core/title.ts`, checked rather than assumed (design §2b). That module
 * already ran: `worker/core/upsert.ts` writes its output into `activity_occurrence.activity_name`
 * and keeps the source's wording in `source_title` (migration 0032), and
 * `lib/search/postgres-repository.ts:196` maps `activityName: row.activity_name` — so the string
 * arriving here is ALREADY normalised, for every row re-ingested since. Three reasons that is not
 * the end of it:
 *
 *   1. Coverage is partial. 0032's own header states the invariant — `source_title IS NULL` ⇔ the
 *      row has not been re-ingested since it shipped — so the live catalogue is MIXED and a
 *      comparison cannot assume the normaliser has run on both sides of it. The first four rules
 *      below deliberately repeat what ingest already removes, so the key is stable across both.
 *   2. Different job, opposite posture. `normalizeTitle` produces a string a PARENT READS, and is
 *      documented as deliberately timid for exactly that reason ("a bare number is NEVER a price
 *      here") after this project was burned by an over-eager title rule. A comparison key is read
 *      by nobody, so it can drop things a display normaliser must keep — the last two rules here
 *      are precisely those: a bare weekday is part of "Monday Funday" on a card and is noise in a
 *      key, and "- Set Two" is a real distinction on a timetable and not two things to do.
 *   3. `worker/` is outside this app's compilation unit (`tsconfig.json` excludes it).
 *
 * The VENUE IS DELIBERATELY NOT PART OF THE KEY. Including it would make the two "LEGO® Block
 * Party" cards distinct, which is the exact case this exists to catch. A three-card hero offers
 * three things to DO; the same thing somewhere else is not a second thing, and where-to-go is the
 * question the nearby slot's own framing answers.
 */
export function foldTitleForComparison(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks left behind by NFKD
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(PRICE_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(AGE_TOKEN_RE, ' ')
    .replace(SESSION_QUALIFIER_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(TRAILING_WEEKDAY_RE, '')
    .trim();
}

/** The identities a placed card occupies, so a later slot can tell it is being offered again. */
interface PlacedKeys {
  seriesIds: Set<string>;
  titles: Set<string>;
  venues: Set<string>;
}

function emptyPlaced(): PlacedKeys {
  return { seriesIds: new Set(), titles: new Set(), venues: new Set() };
}

/**
 * Would showing this card repeat something already on the page?
 *
 * Two independent tests, and neither subsumes the other:
 *   • `seriesId` — the same programme. Each slot is its OWN pipeline run, and `collapseSeries`
 *     keeps whichever member ranked best UNDER THAT RUN'S ORDERING; the nearby slot sorts by
 *     distance and the free slot by best_match, so one series can hand two slots two different
 *     representative `listing.id`s. A de-dupe on ids alone would not see it.
 *   • the folded title — the same programme run as two different series, which is what the two
 *     library branches' "LEGO® Block Party" is and what the design document's two Zumba classes
 *     were. Nothing else in the codebase can catch this class at all.
 *
 * ERRING TOWARD MERGING IS DELIBERATE (design §2d). A false merge costs one slot one candidate
 * and it moves to the next. A false split puts two cards reading the same name side by side on
 * the product's primary claim, in front of a parent who has typed nothing and has no reason to
 * give it a second chance. The costs are not comparable and this must not pretend they are.
 */
function repeatsPlaced(item: SearchResultItem, placed: PlacedKeys): boolean {
  const { listing } = item;
  if (placed.seriesIds.has(listing.seriesId)) return true;
  const title = foldTitleForComparison(listing.activityName);
  return title !== '' && placed.titles.has(title);
}

function remember(item: SearchResultItem, placed: PlacedKeys): void {
  const { listing } = item;
  placed.seriesIds.add(listing.seriesId);
  const title = foldTitleForComparison(listing.activityName);
  if (title !== '') placed.titles.add(title);
  const venue = venueIdentity(listing.venueName);
  if (venue) placed.venues.add(venue);
}

/**
 * Can a parent still START this today?
 *
 * The read model keeps an occurrence until its `end_datetime_utc`, so `when=today` at 3 p.m.
 * includes a programme that began at noon. /search can show that honestly in a list; a card under
 * a heading that says you could do this now cannot, because its own printed time reads as past.
 *
 * A PREFERENCE, NEVER A FILTER (design §3b). As a hard filter this empties every slot at 8 p.m.
 * on a night the catalogue still holds content, and it would throw away a two-hour drop-in that
 * started twenty minutes ago — a perfectly good answer. Measured 2026-08-19 at 15:15 PT: 32 of 48
 * free, 3 of 4 indoor and 15 of 19 nearby gated cards still qualified, so on real data it changes
 * WHICH card is picked without emptying anything.
 *
 * An open-hours card (null start) always qualifies: an aquarium is available whenever it is open,
 * which is the entire meaning of that null (see `ListingRecord.openHours`).
 */
export function hasUsableStart(item: SearchResultItem, now: Date): boolean {
  const cutoff = now.getTime();
  return item.slots.some((slot) => {
    if (slot.startDatetimeUtc == null) return true;
    const start = Date.parse(slot.startDatetimeUtc);
    return Number.isNaN(start) || start >= cutoff;
  });
}

/**
 * How much this surface would rather show this card, among ones it is equally allowed to show.
 *
 * Two preferences, and the ordering between them is the decision: a card that has already
 * finished starting is closer to being WRONG, while a repeated venue is merely LESS GOOD, so a
 * usable start outranks venue variety rather than being traded against it. Both are preferences —
 * neither can empty a slot (see `chooseThreeThings`), which is the same posture
 * `capVenueRepetition` takes within a list and for the same reason: ruling 7.5's empty state is
 * for genuine scarcity, and must never be spent on a rule of ours.
 */
function preferenceScore(item: SearchResultItem, placed: PlacedKeys, now: Date): number {
  const usable = hasUsableStart(item, now) ? 2 : 0;
  const venue = venueIdentity(item.listing.venueName);
  const fresh = venue && placed.venues.has(venue) ? 0 : 1;
  return usable + fresh;
}

/**
 * THE SHIPPED CHOOSER (A3). Fill greedily, POOREST POOL FIRST.
 *
 * Tonight that order is indoor (4 candidates) → free (18) → nearby (19). The reasoning is not
 * that indoor matters most; it is that a slot holding four candidates which loses its only good
 * one to a slot holding nineteen alternatives goes empty for no reason, and an empty slot is the
 * most expensive thing this surface can print. The order is COMPUTED from the pools rather than
 * hard-coded because the ranking is seasonal — on a rainy Saturday indoor is plausibly the
 * fattest pool and free the thinnest, and a fixed `indoor → free → nearby` would then be
 * systematically backwards.
 *
 * DELIBERATELY GREEDY, NOT AN OPTIMAL MATCHING. A 3×N bipartite matching would fill strictly more
 * slots in a rare arrangement; the gain is at most one card and the cost is code no future reader
 * can check by eye against what the page shows. If a measurement ever shows greedy leaving slots
 * empty that a matching would fill, that is the moment to revisit.
 *
 * The residual case is NOT a bug and must not be routed around: greedy can leave slot A empty
 * while slot B holds a card A would have accepted, when B chose first and A's remaining
 * candidates all repeat placed cards. That is ruling 7.5's case exactly — fewer cards, honestly.
 *
 * Fill order is not render order. `selectThreeThings` returns slots in `SLOT_KEYS` order however
 * this filled them, because a parent must not see the page reshuffle between visits for reasons
 * invisible to them.
 */
export const chooseThreeThings: SlotChooser = (pools, now) => {
  const picks = new Map<SlotKey, SearchResultItem | null>();
  const placed = emptyPlaced();

  // Total comparator — never relies on sort stability. Scarcest first; ties by declared slot
  // order so the same pools always produce the same page.
  const order = [...pools].sort(
    (a, b) =>
      a.candidates.length - b.candidates.length ||
      SLOT_KEYS.indexOf(a.key) - SLOT_KEYS.indexOf(b.key),
  );

  for (const pool of order) {
    let best: SearchResultItem | null = null;
    let bestScore = -1;
    for (const item of pool.candidates) {
      if (repeatsPlaced(item, placed)) continue;
      const score = preferenceScore(item, placed, now);
      // Strictly greater — ties keep the EARLIER card, i.e. the engine's own ranking decides
      // whenever the preferences do not. That is what keeps this a tie-breaker rather than a
      // second opinion about what is best (design §3).
      if (score > bestScore) {
        best = item;
        bestScore = score;
        if (score === 3) break; // nothing can outrank both preferences; stop looking.
      }
    }
    picks.set(pool.key, best);
    if (best) remember(best, placed);
  }

  return picks;
};

/**
 * The subset of a listing the front-door gate reads — so the engine's `ListingRecord` and the
 * wire DTO both satisfy it without a cast.
 *
 * Same idiom as `cost.ts#CostFacts` and `audience.ts#AudienceSignalInput`, and for the same
 * reason those exist: the alternative is a second copy of the rule living in whatever tool wants
 * to measure the pool (scripts/three-things-pool-probe.ts is exactly that caller), and a
 * measurement that reimplements the thing it measures cannot detect the thing going wrong.
 */
export interface FrontDoorSignalInput extends AudienceSignalInput {
  statusState: string;
}

/**
 * Is this a card the FRONT DOOR may show, with no section heading and no caveat to carry it?
 *
 * Both gates are carried verbatim from app/_components/HomeTodayStrip.tsx#isFrontDoorCandidate —
 * the component this block replaces — because replacing a surface must not quietly undo the fix
 * that shipped on it hours earlier (b9cdc9c). Read that function's header for the measurement
 * behind each gate; the short version is that neither subsumes the other:
 *
 *   1. `ageMinMonths == null` — the SOURCE never stated an age. A genuinely resolved all-ages
 *      listing holds `0`, a real number, so all-ages content stays visible and only the true
 *      unknown is dropped. This is what keeps "Zumba" and "Muay Thai Kickboxing" off a page
 *      headed "for your kids".
 *   2. `isAdultOrSeniorOnly` — "Adult 19yrs+ Swim" is stored with `age_min_months = 0`, so it
 *      clears gate 1 on a real number and is caught only by the title/audience signal.
 *
 * Gate 2 is redundant against today's engine (`passesAllFilters` applies it to every row) and is
 * asserted anyway, for the same reason the strip asserts it: this module does not otherwise
 * depend on that upstream guarantee, and a hard exclusion is the wrong place to rely on one.
 *
 * Unlike the strip, this reads a full `ListingRecord` rather than a UI DTO, so the numeric age
 * bounds and `ageNotes` are both first-hand — no mapping stands between the gate and the row.
 *
 * THE THIRD GATE IS NOT IN THE STRIP'S FUNCTION, AND HAS TO BE HERE. The strip reached its
 * status rule a layer later, by taking `partitionSections(...).confirmed` over already-mapped
 * activities. This module reads the ENGINE's `results`, which is the `primary` status class —
 * a wider set that includes `stale`, `full`, `waitlist`, `postponed` and `not_yet_bookable`.
 * Those are honest in a list where every card wears its own status stamp, and wrong as one of
 * three bare recommendations: a parent sent to a postponed session has been sent to something
 * that is not happening. Reading `results` without this gate would therefore have REGRESSED the
 * component it replaces while appearing to carry its rules forward — which is exactly what the
 * ported test caught, and why the port ran before the delete rather than after.
 */
export function isShowableOnFrontDoor(listing: FrontDoorSignalInput): boolean {
  if (!isConfirmedSection(listing)) return false;
  if (listing.ageMinMonths == null) return false;
  return !isAdultOrSeniorOnly(listing);
}

/**
 * The extra predicate a slot applies on top of the front-door gates, or null when the engine's
 * own filter is the whole story.
 *
 * ONLY THE FREE SLOT HAS ONE, AND IT IS THE POINT OF THE SLOT. `free: true` is a FILTER, not a
 * free predicate: `matchesCost` deliberately admits unknown/check_source prices too, because
 * Jon's 2026-08-11/17 ruling is that an unpriced listing is never suppressed. Measured live
 * 2026-08-19, `when=today&free=1` reached 101 cards of which 20 in the first 100 are genuinely
 * `isFree()`. A slot that printed the filter's output under the word "Free" would be wrong about
 * the price roughly four times in five. `isFree()` — the one authority every cost string in the
 * product derives from — decides what may wear the word.
 *
 * The indoor slot needs none: `rainyDay: true` runs the engine's own `isRainyDayFriendly`, which
 * is the honest tag-evidence signal ruling 7.3 selected. It is NOT `readIndoorOutdoor` from
 * lib/search/indoor.ts, whose wider facility-type set counts outdoor pools as indoor (design
 * §3b); that set is right for the card's own label and wrong for a headline claim.
 *
 * The nearby slot needs none: the engine's radius filter already answered the question, and
 * `distanceKm` is on every item it returned.
 */
function slotPredicate(key: SlotKey): ((item: SearchResultItem) => boolean) | null {
  return key === 'free' ? (item) => isFree(item.listing) : null;
}

/**
 * Every request this feature issues, as data — pure, engine-free and exported so a guard test
 * can enumerate them rather than trusting a spy to have caught them all (design §9.3 T2).
 *
 * `minResults: 0` is spread LAST on purpose. It is the one field no slot may ever override, and
 * putting it after every other spread makes that structural instead of a convention a reviewer
 * has to notice three times.
 *
 * `limit` is deliberately ABSENT. Two reasons, and the second is the load-bearing one:
 *   • This runs IN-PROCESS against a warm, per-instance catalogue cache (server-engine.ts), so
 *     there is no payload to shrink — the reason HomeTodayStrip needed a limit was that it
 *     shipped its candidate pool over HTTP.
 *   • A limit would be applied by the engine BEFORE this module's gates, and the last stage of
 *     the pipeline is `capVenueRepetition`, which REORDERS cards. Measured live 2026-08-19 on
 *     `when=today&free=1`: the first non-free card sits at index 16 while 20 of the first 100 are
 *     free, because the venue cap deferred four library cards past it. So "the head of the list
 *     contains what I am about to filter for" is not a property this pipeline offers, and a
 *     truncated pool could hand a slot `none_showable` on a day it had plenty. (Note in passing:
 *     that reorder also invalidates design §2d's "index of the first non-free result is the
 *     complete count" methodology.)
 *
 * The nearby slot is omitted entirely when there is no origin — an unasked question, not an
 * unanswered one, so nothing is sent and `no_origin` is reported instead.
 */
export function buildSlotRequests(input: ThreeThingsInput): Array<{ key: SlotKey; request: SearchRequest }> {
  const base: SearchRequest = {
    q: '',
    now: input.now,
    // Ruling 7.2 — "right now" means "something happening today". Not a start-time window:
    // `when` is the only shape the engine expresses this in, and design §7.2 records that a
    // narrower reading is not currently a parameter at all.
    when: 'today',
    ...(input.ageBands && input.ageBands.length > 0 ? { ageBands: input.ageBands } : {}),
  };

  const requests: Array<{ key: SlotKey; request: SearchRequest }> = [
    // Sent as a Free SEARCH, not just post-filtered, so the request is self-describing and a
    // "see all the free things on today" link can reuse it verbatim. `isFree` still decides what
    // may be SHOWN — see `slotPredicate`.
    { key: 'free', request: { ...base, free: true, minResults: 0 } },
    { key: 'indoor', request: { ...base, rainyDay: true, minResults: 0 } },
  ];

  if (input.origin) {
    requests.push({
      key: 'nearby',
      request: {
        ...base,
        origin: { mode: 'near_me', coords: input.origin.geo },
        radiusKm: input.radiusKm ?? DEFAULT_NEARBY_RADIUS_KM,
        sort: 'distance',
        minResults: 0,
      },
    });
  }

  return requests;
}

/**
 * Run each slot's question and keep only the cards it may honestly show.
 *
 * `reached` is `SearchResponse.total`, which counts BOTH primary sections — it answers "did the
 * engine find anything for this question at all", and an age-unconfirmed card is something the
 * engine found. Reading `results.length` instead would report "nothing is on" for a slot whose
 * cards exist but are all unattributed, which is the opposite of what the empty-slot copy needs
 * to distinguish (`nothing_on` vs `none_showable`).
 */
export function gatherSlotCandidates(input: ThreeThingsInput): SlotCandidates[] {
  const asked = buildSlotRequests(input);
  const pools: SlotCandidates[] = [];

  for (const key of SLOT_KEYS) {
    const req = asked.find((r) => r.key === key);
    if (!req) {
      pools.push({ key, candidates: [], reached: 0, unaskable: 'no_origin' });
      continue;
    }

    const response = input.engine.search(req.request);
    const extra = slotPredicate(key);
    // `results` ONLY — see rule 2 in this file's header. `ageUnconfirmed` and `expected` are
    // never read here, by any slot, under any condition.
    const candidates = response.results
      .filter((item) => isShowableOnFrontDoor(item.listing))
      .filter((item) => (extra ? extra(item) : true));

    pools.push({ key, candidates, reached: response.total, unaskable: null });
  }

  return pools;
}

/**
 * The front door's three things. Up to three filled slots, and a reason for every empty one.
 *
 * Pure: the only I/O is whatever the engine was wired with by the caller.
 */
export function selectThreeThings(
  input: ThreeThingsInput,
  chooser: SlotChooser = chooseThreeThings,
): ThreeThings {
  const pools = gatherSlotCandidates(input);
  const picks = chooser(pools, input.now);

  const slots: ThingSlot[] = pools.map((pool) => {
    const pick = picks.get(pool.key) ?? null;
    if (pick) return { key: pool.key, state: 'filled', item: pick };
    if (pool.unaskable) return { key: pool.key, state: 'empty', reason: pool.unaskable, reached: 0 };
    return {
      key: pool.key,
      state: 'empty',
      reason: pool.reached === 0 ? 'nothing_on' : 'none_showable',
      reached: pool.reached,
    };
  });

  return {
    slots,
    ageAware: (input.ageBands?.length ?? 0) > 0,
    origin: input.origin ?? null,
  };
}

/** The filled slots, in slot order — what a caller renders. */
export function filledSlots(three: ThreeThings): FilledSlot[] {
  return three.slots.filter((s): s is FilledSlot => s.state === 'filled');
}
