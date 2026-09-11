// lib/sms/weekly-picks.ts — choose the 5–10 weekend activities one subscriber's Friday text
// carries (PRD §2.2, v2.4).
//
// PURE OVER A WIRED ENGINE, exactly like lib/recommend/three-things.ts and lib/email/digest.ts:
// given a SearchEngine, a clock, a resolved origin, the subscriber's stored birth years,
// category interests and empty-week counter, it returns a decided set of picks. It sends
// nothing, writes nothing, reads no environment and constructs no Date of its own. Twilio, the
// short-link minting, `sms_send_log` and the pause transition all belong to the caller — so this
// module is exhaustively testable against a fixture engine and cannot drift from what /search
// would show in the same environment.
//
// ── WHAT THIS GENERALISES, AND WHAT IT DELIBERATELY DOES NOT COPY ─────────────────────────
// `three-things.ts` answers "the three things the front door offers" with three DIFFERENT
// questions (free / indoor / nearby), one card each, and a chooser that stops the same listing
// appearing in two slots. This is ONE question — "what is on this weekend, near this family, for
// these ages" — answered N times from a single ranked list. So the slot machinery is not carried
// over; the rules underneath it are:
//
//   * `minResults: 0` ON EVERY REQUEST, without exception (three-things.ts rule 1, Jon's ruling
//     7.5). The engine's broadening ladder relaxes DATES FIRST, so a non-zero minimum on a text
//     that says "this weekend" would quietly print next Tuesday's LEGO Club under that promise.
//     The PRD's own retry (step e) is how this surface degrades — deliberately, once, and
//     visibly in the result — and it must never be pre-empted by the engine widening silently
//     underneath it. `buildPicksRequest` is the ONE place a request is built and it applies
//     `minResults: 0` last, after every spread, so no future caller can opt out by accident.
//   * `results` ONLY — never `ageUnconfirmed`, never `expected` (three-things.ts rule 2).
//     `ageUnconfirmed` is the engine's holding pen for listings whose SOURCE never stated an
//     age; /search can hold those under a heading that says so and a text message cannot.
//     `expected` is the seasonal section — "probably on" is not "on this weekend".
//   * `isShowableOnFrontDoor` is IMPORTED from three-things.ts, not restated. Its argument is
//     that a bare recommendation carrying no heading and no caveat may not show a postponed
//     session, a listing whose source never stated an age, or adult-only programming. A 160-
//     character SMS is that same surface with even less room to qualify itself, so the gate
//     applies verbatim and a second copy could only drift from it.
//
// NOT carried over: `hasUsableStart`. That is a "can a parent still start this TODAY" preference
// for a right-now surface. This runs Friday afternoon about Saturday and Sunday, where every
// candidate starts in the future, so importing it would add a predicate that is a no-op on the
// data and a puzzle to the next reader.
//
// ── THE ORIGIN ARRIVES RESOLVED, AND THAT IS FORCED ───────────────────────────────────────
// The engine has a `saved_home` origin mode that takes a postal code — which is exactly what a
// subscriber has — and `resolveOrigin` throws `auth_required` on it unless `signedIn` is true
// (lib/geo/origin.ts:66). An SMS subscriber is NEVER signed in; that is the entire premise of
// the product. So the postal→point step happens in the caller (which holds the geocoder) and
// this module takes the resolved point, using `near_me` purely as the transport that carries a
// raw coordinate. Same shape three-things.ts settled on, for a related reason.

import type { SearchEngine, SearchRequest, SearchResultItem } from '@/lib/search/engine';
import type { AgeBandKey, GeoPoint, ListingRecord } from '@/lib/search/types';
import { AGE_BAND_ORDER } from '@/lib/search/filters/age';
import { ageMonthsToBand } from '@/lib/profile/child-age-bands';
import { RADIUS_OPTIONS_KM, DEFAULT_RADIUS_KM, distanceKm } from '@/lib/geo/radius';
import { similarity } from '@/lib/search/text/trigram';
// The shared, key-agnostic cap. This module supplies the KEY and the PARAMETERS; the rounds, the
// rank-preserving deferral and the reorder-never-drop contract all live in that file and are
// shared with /search and the front door. See `orderByVenueSpread` for why the digest passes
// options rather than the shared constants moving.
import { capByGroupingKey, venueIdentity } from '@/lib/search/venue-diversity';
import { relativeDate } from '@/lib/search/parse';
import { addDaysIso, localIsoDate } from '@/lib/search/time/vancouver';
// The front-door gate and the comparison fold, reused rather than mirrored. This module does not
// modify lib/recommend/three-things.ts and does not restate either rule.
import { foldTitleForComparison, isShowableOnFrontDoor } from '@/lib/recommend/three-things';
// Jon's §8 Q1 ruling: multi-session commitments out, one-off bookings in. SMS-scoped — see that
// file for why it re-runs the shared classifier rather than copying its vocabulary.
import { isWeeklyPickEligible } from './registration';

// ── Tunables. Every one of these is a PRD number, named so it is greppable and adjustable. ──

/** Most picks one text may carry (PRD §2.2: "N = 5–10"). */
export const MAX_PICKS = 10;
/**
 * Fewest picks that still justify a send (PRD §2.2 "a floor of 3"). Below this, after the one
 * retry, the week is an honest empty rather than a thin one.
 *
 * NOTE ON THE "5–10" RANGE: the PRD describes normal fill as 5–10 but makes only the floor a
 * gate — a 4-pick week sends as a 4-pick week and does NOT trigger the retry. That is
 * implemented exactly as specified; whether a below-5 week should also degrade is a tuning
 * question for V1's per-municipality data, not a decision to make silently here.
 */
export const FLOOR_PICKS = 3;
/** How many of the top-ranked picks get their own direct short link (PRD §2.3: "top 2–3"). */
export const DIRECT_LINK_PICKS = 3;
/** Title-similarity cutoff for the dedup pass (PRD §2.2, corrected to ~0.78 on 2026-08-26). */
export const DEDUP_TITLE_SIMILARITY = 0.78;
/**
 * Title-similarity cutoff for `sameOfferingAtVenue`, i.e. for two cards ALREADY known to be at
 * the same place. Lower than `DEDUP_TITLE_SIMILARITY` on purpose — see that predicate's header
 * for why a venue-scoped threshold may be, and for the measured band it has to sit inside.
 */
export const SAME_VENUE_TITLE_SIMILARITY = 0.7;
/** How close two venues must be to count as the same place for dedup (PRD §2.2: "~500m"). */
export const DEDUP_VENUE_RADIUS_KM = 0.5;
/** How far down the ranked list the age-coverage swap may reach (PRD §2.2: "top-20"). */
export const COVERAGE_SWAP_REACH = 20;
/**
 * Most picks one text may carry from any ONE venue (2026-09-10 venue-repetition fix).
 *
 * Two of ten is 20%. The engine's own `MAX_CARDS_PER_VENUE`/`VENUE_CAP_WINDOW` is 3 of 20, i.e.
 * 15% — this is the honest translation of that number to a smaller list, erring slightly tighter
 * because a ten-item text is read WHOLE while a search page is read from the top.
 *
 * NAMED AND GREPPABLE BECAUSE IT IS EXPECTED TO MOVE. The real cost of the tradeoff — how much
 * farther a promoted pick is than the one it deferred — is instrumented on every send
 * (`WeeklyPicks.diversity`), so this is a number to retune against measurement rather than argue
 * about. `1` would guarantee ten distinct venues at the cost of pushing more genuinely-good
 * options down in dense municipalities; `3` would reproduce today's behaviour exactly.
 */
export const MAX_PICKS_PER_VENUE = 2;
/**
 * Most picks one text may carry from any ONE category (`primaryCategoryKey`).
 *
 * A SEPARATE, ORTHOGONAL CONSTRAINT — fixing venue repetition does NOT fix this. Measured: apply
 * the venue rules alone to the Deep Cove profile's real list and it stays at NINE OF TEN
 * `public_swim`; the slots the venue cap frees simply refill with more swim at different pools.
 * A family with a 2-year-old and a 13-year-old got one skate and nine swims.
 *
 * WHY THE POOL SKEWS, because it decides how deep the cap has to reach. The digest searches with
 * `q: ''` — browse mode — so `tsRank` (the heaviest ranking component) is inert here and cannot
 * differentiate anything. What is left is four small, individually defensible biases that all
 * point the same way: `dateProximity` favours an exact-date hit over open hours, `distanceDecay`
 * favours the local pool over a destination, `statusConfidenceBoost` favours rows with published
 * schedules, and `recency` decays curated content toward zero because nothing re-ingests it.
 * Together they separate AUTOMATED, DATED, MUNICIPAL TIMETABLE content from MANUALLY CURATED
 * DESTINATION content — and that axis maps almost one-to-one onto category. Category is a proxy
 * for content provenance, which is why this is systemic rather than one family's bad luck.
 */
export const MAX_PICKS_PER_CATEGORY = 2;
/**
 * The catch-all category's looser allowance.
 *
 * `primaryCategoryKey` IS NOT UNIFORMLY GRANULAR, and pretending it is costs real choices.
 * `public_swim` is specific; `class_program` is a catch-all. Measured on the Kitsilano profile:
 * Tai Chi, Pickleball, Community Dancers and Line Dancing are ALL `class_program`, and they are
 * genuinely four different things to do on a Saturday. Capping that key at 2 removed FIVE of that
 * profile's seven picks — the category axis punishing a list whose monotony was never categorical.
 *
 * That profile's real problem is venue repetition, and the venue cap plus the same-offering
 * collapse already carry it. So the category axis does not need to, and 3 rather than 2 is the
 * honest allowance for a key holding four different activities. Named rather than special-cased
 * inline so the unevenness stays visible and can be retired when the taxonomy gets granular.
 */
export const CLASS_PROGRAM_CAP = 3;
/** The catch-all key itself. Named so the special case is greppable from both sides. */
export const CLASS_PROGRAM_CATEGORY_KEY = 'class_program';
/**
 * Total forced picks the coverage swap may make — 2 ACROSS ALL BANDS, not 2 per band (PRD v2.4
 * §2.2 step 4 made this explicit after the first draft asked the question).
 */
export const MAX_FORCED_PICKS = 2;
/**
 * Fallback radius step when the subscriber is already at or beyond the widest standard option.
 * The retry widens by one step of `RADIUS_OPTIONS_KM` (5 → 10 → 20); past 20km there is no next
 * option, so it widens by this instead of silently not widening at all.
 */
export const RADIUS_WIDEN_FALLBACK_KM = 10;
/** Oldest plausible "child" age in years, as a sanity bound on a stored birth year. */
const MAX_PLAUSIBLE_CHILD_AGE_YEARS = 25;

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Where "near" is measured from. Resolved by the caller — see the header. */
export interface PicksOrigin {
  geo: GeoPoint;
  /** Human name for the area, e.g. "East Van". Echoed back for the message copy. */
  label: string;
}

export interface PicksSubscriber {
  origin: PicksOrigin;
  /** Travel radius in km. Defaults to the product-wide default. */
  radiusKm?: number;
  /** `sms_consent.birth_years` — one YEAR per child, no month. See `ageBandsFromBirthYears`. */
  birthYears: readonly number[];
  /** `sms_consent.category_interests` — category/tag keys. Empty/absent = no category filter. */
  categoryInterests?: readonly string[];
  /** `sms_consent.consecutive_empty_weeks` BEFORE this send. Advisory only — see the result. */
  consecutiveEmptyWeeks: number;
}

export interface WeeklyPicksInput {
  engine: SearchEngine;
  /** The clock. Passed, never ambient, so every selection is reproducible. */
  now: Date;
  subscriber: PicksSubscriber;
  /**
   * "Are these two listings run by the same parent organisation?" — the OR-arm of the PRD's
   * venue condition.
   *
   * DEFAULTS TO "NEVER", AND THAT IS A REPORTED GAP RATHER THAN A DESIGN CHOICE. The `organisation`
   * table exists (migration 0003) and is ORPHANED: nothing in the schema references
   * `organisation(id)` — no `organisation_id` on venue, on activity_series or on
   * activity_occurrence. Migration 0010's own header records this ("the current schema has no
   * organisation link on activities … wiring a direct organisation_id is a candidate"), and
   * `lib/search/postgres-repository.ts` consequently fills `ListingRecord.organisation` with the
   * INGESTION SOURCE's name, not a parent organisation.
   *
   * Using that field as a proxy would be actively harmful here, not merely imprecise: one source
   * covers a whole municipality's recreation feed, so "same organisation" would be true for every
   * pair of listings in that municipality. Since the venue test is an OR, that arm would swallow
   * the ~500m guard entirely — and the guard is the only thing standing between this pass and the
   * failure the PRD names explicitly, "Public Swim" at two unrelated rec centres scoring 1.000 on
   * title alone. So the arm is left OFF and injectable: the day an `organisation_id` exists, this
   * becomes a one-line wiring rather than a rewrite of the dedup pass.
   */
  sameParentOrg?: (a: ListingRecord, b: ListingRecord) => boolean;
  /**
   * Occurrences this subscriber has already been sent (PRD v2.8 §2.2 step 4, the novelty filter).
   *
   * Excluded from the candidate set AFTER the dedup pass and BEFORE the age-coverage swap, so a
   * repeat is treated exactly like something that was never a candidate — it cannot be ranked, it
   * cannot be reached by a forced pick, and it cannot fill a slot toward the floor.
   *
   * NOT RELAXED BY EITHER DEGRADATION STEP, and that is explicit in the PRD: "an empty week stays
   * empty rather than re-serving a repeat pick to fill it." That property is structural here — the
   * exclusion lives on the input and `selectFrom` applies it unconditionally, so there is no
   * branch a retry could take that skips it.
   *
   * The CALLER decides the window (see `loadRecentlySentPickIds` in lib/sms/weekly-send-io.ts);
   * this module only honours the set it is handed.
   */
  excludeOccurrenceIds?: ReadonlySet<string>;
  /** Override the pick ceiling (tests, and a future per-subscriber preference). */
  maxPicks?: number;
  /** Override the send floor. */
  floorPicks?: number;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

/** Which link shape a pick gets in the message (PRD §2.3). */
export type LinkOrigin = 'direct' | 'hub';

export interface WeeklyPick {
  item: SearchResultItem;
  /** 1-based, in send order. This is the `rank` written to `sms_send_log.picks_snapshot`. */
  rank: number;
  linkOrigin: LinkOrigin;
  /** Set when the coverage swap forced this pick in to represent a band. */
  forcedForBand?: AgeBandKey;
}

export interface ForcedPick {
  band: AgeBandKey;
  occurrenceId: string;
  /** The pick it pushed out, or null when it filled a slot that was empty anyway. */
  displacedOccurrenceId: string | null;
}

/**
 * What the venue/activity diversity stages actually DID on this send.
 *
 * PURELY ADDITIVE, AND DELIBERATELY NOT PERSISTED. This is a pure function's return value: the
 * caller decides what to log or keep, and NOTHING here is written to any store by this module.
 * There is no schema change behind it — if `sms_send_log` should carry any of it, that is an
 * Operator decision routed separately, not something a selection module may assume.
 *
 * EVERY FIELD IS DERIVED FROM THE RUN THAT PRODUCED THE PICKS, never recomputed from a second
 * source. A summary that re-derives its numbers by running the rules again is a second
 * implementation that can disagree with the first, which is the one thing an instrument must not
 * do — the same argument this file already makes for reporting `degradation` rather than letting
 * the copy layer infer it.
 *
 * WHY THIS EXISTS AT ALL. The one real cost of digest-sized venue diversity is that a promoted
 * pick is by definition lower-ranked, and in this product's ranking that usually means farther
 * away. There is deliberately NO second distance ceiling guarding it — the subscriber's radius
 * already bounds it, and a second ceiling would be a filter wearing a preference's clothes.
 * Measuring it instead turns "is 2-of-10 the right number?" from an argument into something
 * `MAX_PICKS_PER_VENUE` can be retuned against after a few real sends.
 */
export interface DiversitySummary {
  /**
   * Candidates dropped because they were another sitting of an activity already kept AT THE SAME
   * VENUE (`collapseSameOfferingAtVenue`). Counted separately from `WeeklyPicks.deduped`, which
   * is the PRD's own dedup pass and answers a different question.
   */
  sameOfferingCollapsed: number;
  /**
   * How many candidates each cap pushed OUT of the ten that rank alone would have put in it.
   * Never a removal — a deferred card is still in the list, further down.
   *
   * REPORTED PER KEY because the two answer different questions and can disagree: a week can be
   * venue-diverse and category-monotonous (the Deep Cove case: nine swims across nine pools) or
   * the reverse. One combined number would hide exactly the distinction the second cap exists for.
   */
  venueCapDeferred: number;
  categoryCapDeferred: number;
  /**
   * Promotions the age-fit guard refused — a category promotion that would have served fewer of
   * the subscriber's children than the pick it jumped.
   *
   * REPORTED RATHER THAN SILENT, because a guard nobody can see is a guard nobody can tune. A high
   * number here on a wide-age household is the product working correctly (see the guard's header);
   * a high number everywhere would mean the category cap is fighting the age filter and the reach
   * or the cap needs to move.
   */
  ageFitBlocked: number;
  /** How many of the named slots hold a different pick than they would have without the spread. */
  namedSlotsPermuted: number;
  /** Every promotion, with what it cost in rank and distance. Empty on a normal send. */
  promoted: PromotedPick[];
}

/** How far the selection had to degrade. See `WeeklyPicks.degradation`. */
export type Degradation = 'none' | 'widened' | 'widened_and_interests_dropped';

/** Why a week produced nothing. Both are honest states, not failures. */
export type EmptyReason =
  /** The engine reached nothing at all for this subscriber's question, even after the retry. */
  | 'nothing_reached'
  /**
   * The engine reached listings and none survived the gates — front-door showability, the
   * category filter, or the dedup pass. Distinct from `nothing_reached` on purpose: "there is
   * nothing near you this weekend" and "there is content near you that we cannot stand behind"
   * are different facts, and collapsing them tells a parent the catalogue is emptier than it is.
   */
  | 'none_showable';

export interface WeeklyPicks {
  outcome: 'picks' | 'empty';
  /** Ranked, send-ordered. Empty when `outcome === 'empty'`. */
  picks: WeeklyPick[];
  /** Set only when `outcome === 'empty'`. */
  emptyReason: EmptyReason | null;
  /** The bands computed from `birthYears` at `now` — what was actually asked of the engine. */
  ageBands: AgeBandKey[];
  /** False when no birth year resolved: the search ran with NO age filter, honestly. */
  ageAware: boolean;
  /**
   * How far the selection had to degrade to get here (PRD v2.4 §2.2 step 5).
   *   'none'                          — the primary attempt cleared the floor.
   *   'widened'                       — step (a): one radius step out, window relaxed to Sat–Tue.
   *   'widened_and_interests_dropped' — step (b): step (a) plus the category filter dropped.
   * A caller may want to say so in the message ("we looked a bit further afield this week"); it
   * is reported rather than inferred so the copy layer cannot reach a different conclusion than
   * the selection did.
   */
  degradation: Degradation;
  /** True when either degradation step ran. Kept as the simple predicate most callers want. */
  retried: boolean;
  /** True when step (b) fired — these picks are outside the subscriber's stated interests. */
  interestsDropped: boolean;
  /** The radius actually used for the attempt these picks came from. */
  radiusKmUsed: number;
  /** `SearchResponse.total` per attempt — "did the engine reach anything at all". */
  reached: { primary: number; retry: number | null };
  /** Every forced pick the coverage swap made, in the order it made them. */
  forcedPicks: ForcedPick[];
  /** How many candidates the dedup pass collapsed away, across the attempt that produced picks. */
  deduped: number;
  /**
   * How many otherwise-eligible candidates the novelty filter removed as already-sent.
   *
   * Reported because it is the number that explains a thin week to an operator: a subscriber in a
   * sparse municipality can be pushed below the floor purely by this, and "we found six and had
   * already sent five of them" is a completely different diagnosis from "we found one".
   */
  novelExcluded: number;
  /**
   * What the venue/activity diversity stages did — see `DiversitySummary`. Always present,
   * including on an empty week (where it describes the attempt that produced the emptiness).
   */
  diversity: DiversitySummary;
  /**
   * ADVISORY. True when this empty week would be the subscriber's third in a row, i.e. the
   * caller should send the pause notice and set `status = 'paused'` (PRD §2.2 step 6).
   *
   * This module does not perform that transition and cannot: it holds no database, and the
   * counter it reasons about is passed in. Reported rather than left to the caller to recompute
   * so the rule lives in ONE place and the send job cannot reach a different conclusion than the
   * selection did.
   */
  shouldPause: boolean;
}

// ── (a) Ages ─────────────────────────────────────────────────────────────────

/**
 * The age bands a subscriber's stored birth years imply, AT `now`.
 *
 * Recomputed every send rather than stored, which is the whole reason `sms_consent` holds a year
 * instead of an age (migration 0034): a stored "4" is wrong the moment a birthday passes, a
 * stored birth year never is.
 *
 * THE PRECISION THIS CANNOT HAVE, stated where it is computed rather than only in a doc. We hold
 * a YEAR, never a month, so `age = currentYear - birthYear` is right only for children who have
 * already had this year's birthday. A child born in December 2020 reads as 5 for all of 2025
 * though they are 4 until December — near a band boundary that is a 4-year-old being offered 5–9
 * programming for most of a year. This is an ACCEPTED PRD tradeoff (§1.2: the alternative is
 * asking a parent for a minor's date of birth) and must not be "fixed" here by inventing a month.
 *
 * "Current year" is read in America/Vancouver, not UTC — on the evening of December 31st those
 * are different years, and this product is entirely local.
 *
 * A year that does not resolve to a plausible child age is SKIPPED, not defaulted to a band. An
 * unreadable row is not a reason to apply an age filter nobody asked for; if none resolve, the
 * result is no age filter at all, which is honest and is what `ageAware: false` reports.
 */
export function ageBandsFromBirthYears(
  birthYears: readonly number[] | null | undefined,
  now: Date
): AgeBandKey[] {
  if (!Array.isArray(birthYears) || birthYears.length === 0) return [];
  const currentYear = Number(localIsoDate(now).slice(0, 4));
  const bands = new Set<AgeBandKey>();
  for (const year of birthYears) {
    if (typeof year !== 'number' || !Number.isInteger(year)) continue;
    const ageYears = currentYear - year;
    if (ageYears < 0 || ageYears > MAX_PLAUSIBLE_CHILD_AGE_YEARS) continue;
    const band = ageMonthsToBand(ageYears * 12);
    if (band) bands.add(band);
  }
  return AGE_BAND_ORDER.filter((band) => bands.has(band));
}

// ── (b) The request ──────────────────────────────────────────────────────────

/**
 * Which attempt a request is for.
 *
 * There are three ATTEMPTS but only TWO distinct requests. Step (b) of the PRD's degradation
 * retry drops the subscriber's category interests — and interests are a post-filter on ranked
 * results, not a query parameter (see `matchesInterests`), so step (b) asks the engine exactly
 * the same question step (a) did. `'retry_without_interests'` therefore builds the identical
 * request, and `selectWeeklyPicks` reuses step (a)'s response rather than issuing it twice.
 */
export type Attempt = 'primary' | 'retry' | 'retry_without_interests';

/** One step wider on the product's own radius ladder; see RADIUS_WIDEN_FALLBACK_KM. */
export function widenRadiusKm(radiusKm: number): number {
  return RADIUS_OPTIONS_KM.find((r) => r > radiusKm) ?? radiusKm + RADIUS_WIDEN_FALLBACK_KM;
}

/**
 * Every request this feature issues, as data — pure and engine-free, so a guard test can
 * enumerate them rather than trusting a spy to have caught them all.
 *
 * `minResults: 0` is spread LAST on purpose. It is the one field no attempt may override, and
 * putting it after every other spread makes that structural rather than a convention a reviewer
 * has to notice twice. See this file's header for why it matters more here than anywhere.
 *
 * THE RETRY IS BUILT FROM THE ORIGINAL INPUT, NEVER FROM THE PRIMARY REQUEST. That is what
 * "non-compounding" (PRD §2.2 step 5) means structurally: there is no way to widen twice,
 * because there is no state to widen twice FROM. Both branches read `input` and nothing else.
 *
 * The retry's window: the PRD asks for "weekend + Mon/Tue", which the `when` quick-pick cannot
 * express — its vocabulary is any/today/tomorrow/weekend. `dateRange` is the engine's structured
 * form for a window the quick-picks cannot say (and it overrides any text-parsed date), so the
 * retry sends Saturday→Tuesday as a range and drops `when` entirely. The Saturday itself comes
 * from `relativeDate('weekend', now)`, the same resolver /search uses, so "this weekend" means
 * exactly the same pair of days in a text as it does on the site.
 *
 * `limit` is deliberately ABSENT, for the reason three-things.ts records: the pipeline's last
 * stage (`capVenueRepetition`) REORDERS cards, so "the head of the list holds what I am about to
 * filter for" is not a property this engine offers, and a truncated pool could hand a subscriber
 * an empty week on a weekend that had plenty.
 */
export function buildPicksRequest(input: WeeklyPicksInput, attempt: Attempt): SearchRequest {
  const { subscriber, now } = input;
  const ageBands = ageBandsFromBirthYears(subscriber.birthYears, now);
  const baseRadius = subscriber.radiusKm ?? DEFAULT_RADIUS_KM;

  const base: SearchRequest = {
    q: '',
    now,
    origin: { mode: 'near_me', coords: subscriber.origin.geo },
    // ASK THE ENGINE FOR REGISTRATION CONTENT, THEN JUDGE IT OURSELVES (PRD v2.8 §2.2 step 2).
    //
    // The engine's default (`includeRegistration: false`) excludes ALL registration-shaped
    // listings, which is right for /search and is now too broad for this surface: Jon's ruling
    // keeps a one-off that merely needs booking. `includeRegistration` is documented as an
    // inclusion widener that "can only ever ADD results", so turning it on and applying
    // `isWeeklyPickEligible` in `selectFrom` is strictly a NARROWING of what arrives, not a
    // second opinion about it — the net effect is the engine's exclusion minus the one-offs.
    includeRegistration: true,
    ...(ageBands.length > 0 ? { ageBands } : {}),
  };

  if (attempt === 'primary') {
    return { ...base, when: 'weekend', radiusKm: baseRadius, minResults: 0 };
  }


  // Both retry steps ask the SAME question — see the `Attempt` type. Step (b) differs only in
  // which of the answers it is willing to keep.

  const weekend = relativeDate('weekend', now);
  const saturday = weekend.isoDate ?? localIsoDate(now);
  return {
    ...base,
    // Saturday, Sunday, Monday, Tuesday — the PRD's "weekend + Mon/Tue".
    dateRange: { from: saturday, to: addDaysIso(saturday, 3) },
    radiusKm: widenRadiusKm(baseRadius),
    minResults: 0,
  };
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * Does this listing match at least one of the subscriber's stated interests?
 *
 * APPLIED AS A POST-FILTER, AND NOT BY CHOICE. `SearchRequest` has no structured category
 * parameter today — the only way to express a category to the engine is as free text in `q`,
 * which turns a browse into a scored text search: it would reorder the whole result set by
 * relevance to the word "swimming" and drop everything the matcher scored below threshold. That
 * is a different query, not a filtered one. So the interests are applied to the engine's own
 * ranked output instead, which leaves the ordering intact.
 *
 * IT IS A FILTER, NOT A PREFERENCE, because the PRD calls it one (§2.2 step 2). Worth knowing
 * what that costs: a subscriber who ticks one narrow interest can be filtered below the floor
 * and get an empty week on a weekend that was full of things for their kids. The PRD's retry
 * (step 5) widens radius and dates but NOT interests, so this is implemented exactly as
 * specified and flagged rather than quietly softened.
 *
 * No interests = no filter, which is the honest reading of an empty optional field.
 */
export function matchesInterests(
  listing: ListingRecord,
  interests: readonly string[] | null | undefined
): boolean {
  if (!Array.isArray(interests) || interests.length === 0) return true;
  const wanted = new Set(interests.map((i) => i.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return true;
  if (wanted.has(listing.primaryCategoryKey?.toLowerCase())) return true;
  return listing.categoryTags.some((tag) => wanted.has(tag.toLowerCase()));
}

// ── (c) The dedup pass ───────────────────────────────────────────────────────

/**
 * Do two candidates' times overlap?
 *
 * Both sides are checked slot-by-slot, not on the representative alone: a collapsed card stands
 * for every same-series occurrence (`SearchResultItem.slots`), and two cards are the same weekend
 * offering if ANY of their slots collide.
 *
 * OPEN-HOURS LISTINGS ARE HANDLED EXPLICITLY, because the alternative is a silent bug. A dateless
 * attraction (an aquarium; `startDatetimeUtc === null`) has no interval to intersect. Treating
 * null as "overlaps everything" would let a standing attraction merge with any dated programme
 * that happened to share a title; treating it as "overlaps nothing" would stop two rows for the
 * SAME aquarium from ever collapsing. So: two open-hours listings DO satisfy the time condition
 * (they are both simply "open"), an open-hours and a dated one never do.
 *
 * Comparison is inclusive at the edges — a 10:00–11:00 and an 11:00–12:00 session at one venue
 * are back-to-back sittings of one thing far more often than they are two different outings.
 */
export function timesOverlap(a: SearchResultItem, b: SearchResultItem): boolean {
  const aOpen = a.listing.openHours || a.slots.every((s) => s.startDatetimeUtc == null);
  const bOpen = b.listing.openHours || b.slots.every((s) => s.startDatetimeUtc == null);
  if (aOpen || bOpen) return aOpen && bOpen;

  for (const sa of a.slots) {
    if (sa.startDatetimeUtc == null) continue;
    const aStart = Date.parse(sa.startDatetimeUtc);
    const aEnd = sa.endDatetimeUtc ? Date.parse(sa.endDatetimeUtc) : aStart;
    if (Number.isNaN(aStart)) continue;
    for (const sb of b.slots) {
      if (sb.startDatetimeUtc == null) continue;
      const bStart = Date.parse(sb.startDatetimeUtc);
      const bEnd = sb.endDatetimeUtc ? Date.parse(sb.endDatetimeUtc) : bStart;
      if (Number.isNaN(bStart)) continue;
      if (aStart <= bEnd && bStart <= aEnd) return true;
    }
  }
  return false;
}

/**
 * Are two candidates in the same PLACE, for dedup purposes?
 *
 * Three arms, in cost order:
 *   1. The same venue name (`venueIdentity`, the repo's own venue-identity rule — shared so this
 *      pass and the engine's diversity cap cannot disagree about when two cards are at one
 *      place). This arm exists because it needs no coordinates: un-geocoded venues are normal in
 *      this catalogue, and without it two rows for the same un-geocoded rec centre could never
 *      collapse.
 *   2. Both geocoded and within ~500m (`distanceKm`, the same haversine /search ranks on).
 *   3. Same parent organisation — OFF by default and injected. See `WeeklyPicksInput.sameParentOrg`
 *      for why the schema cannot answer this today and why faking it would be worse than
 *      omitting it.
 */
export function sameishPlace(
  a: SearchResultItem,
  b: SearchResultItem,
  sameParentOrg: (x: ListingRecord, y: ListingRecord) => boolean
): boolean {
  const va = venueIdentity(a.listing.venueName);
  const vb = venueIdentity(b.listing.venueName);
  if (va && vb && va === vb) return true;
  if (a.listing.geo && b.listing.geo) {
    if (distanceKm(a.listing.geo, b.listing.geo) <= DEDUP_VENUE_RADIUS_KM) return true;
  }
  return sameParentOrg(a.listing, b.listing);
}

/**
 * Are two titles the same activity?
 *
 * TWO WAYS TO SATISFY ONE CONDITION, and the second is an addition to the PRD that is called out
 * rather than folded in silently:
 *
 *   1. `similarity() >= 0.78` — the PRD's condition, on the RAW titles, run through exactly the
 *      function the 0.78 threshold was measured with (`lib/search/text/trigram.ts`, which is
 *      pg_trgm-compatible and normalises internally). Deliberately `similarity()`, NOT
 *      `typoSimilarity()`: that one adds a single-edit guard built for one-word search queries
 *      and scores essentially every real multi-word title pair at 0.
 *   2. Identical `foldTitleForComparison` output. That fold (three-things.ts) strips the vendor
 *      packaging a trigram score cannot see past — an embedded price, a clock time, an age token,
 *      a trailing weekday, "- Set Two". "$3 Open Gym 8yrs+ Thursday" and "Open Gym" are one
 *      activity and score far below 0.78 on their raw strings. This arm is EXACT string equality
 *      after folding, not a second fuzzy threshold, so it cannot drift.
 *
 * Neither arm can merge anything on its own — `isDuplicatePair` requires the time and place
 * conditions too, which is the PRD's central point about "Public Swim" scoring 1.000 at two
 * unrelated pools.
 */
export function titlesMatch(a: ListingRecord, b: ListingRecord): boolean {
  if (similarity(a.activityName, b.activityName) >= DEDUP_TITLE_SIMILARITY) return true;
  const fa = foldTitleForComparison(a.activityName);
  return fa !== '' && fa === foldTitleForComparison(b.activityName);
}

/** All three PRD conditions, ANDed. Title alone is never enough — that is the whole design. */
export function isDuplicatePair(
  a: SearchResultItem,
  b: SearchResultItem,
  sameParentOrg: (x: ListingRecord, y: ListingRecord) => boolean
): boolean {
  return (
    titlesMatch(a.listing, b.listing) && timesOverlap(a, b) && sameishPlace(a, b, sameParentOrg)
  );
}

/**
 * Is this the SAME OFFERING at the SAME PLACE this weekend — i.e. one decision wearing two rows?
 *
 * A SIBLING OF `isDuplicatePair`, NOT A CHANGE TO IT. The two answer different questions and both
 * are worth asking:
 *   • `isDuplicatePair` — "are these two rows the same OCCURRENCE, reached from two sources?"
 *     That one is PRD-specified and QA-pinned, it is what `deduped` counts, and it is deliberately
 *     left completely untouched by this predicate's existence.
 *   • this one — "is this the same thing to DO, at this building, this weekend?" Two sittings of
 *     one activity are one decision for a parent, not two, and in a list of TEN a second sitting
 *     is a wasted slot rather than a choice.
 *
 * ═══ TIME OVERLAP IS DELIBERATELY ABSENT, AND THAT IS THE WHOLE POINT ═══
 * `isDuplicatePair` requires `timesOverlap` because it is asking whether two rows describe ONE
 * sitting; two rows for the same sitting necessarily share a time. This predicate is asking the
 * opposite question — whether a parent is being offered the same thing TWICE — and two sittings of
 * one activity are by construction at DIFFERENT times. Requiring overlap here would not merely be
 * unnecessary; it would rule out the only case this exists to catch. Measured on the catalogue's
 * own rows: West End's "Pickleball - Sun AM" (10:00) and "Pickleball - Sun PM" (12:30) do not
 * overlap at all, which is exactly why `isDuplicatePair` never saw them.
 *
 * ═══ WHY A LOWER THRESHOLD IS SAFE HERE AND WOULD NOT BE THERE ═══
 * 0.78 was measured CROSS-VENUE, where the risk it guards against is "Public Swim" scoring 1.000
 * at two unrelated pools — the PRD's own central warning. That risk is STRUCTURALLY OUT OF REACH
 * here: `sameishPlace` has already returned true, so two unrelated pools cannot reach this
 * comparison at all. What is left to get wrong is only ever a question about one building, and
 * there a looser title test costs at most one slot and buys the case above.
 *
 * ═══ THE MEASURED BAND, RE-MEASURED BEFORE THE CONSTANT WAS FROZEN (2026-09-10) ═══
 * Run against this repo's own `similarity()` on the report's real rows, not quoted from the scope:
 *
 *   similarity('Pickleball - Sun PM',             'Pickleball - Sun AM')              = 0.7500
 *   similarity('Public Swim Delbrook Whole Pool', 'Public Swim Delbrook Leisure Pool') = 0.6410
 *
 * `SAME_VENUE_TITLE_SIMILARITY = 0.70` sits inside that band with roughly equal margin on both
 * sides (0.050 below the pair that MUST merge, 0.059 above the pair that MUST NOT). The lower edge
 * is the load-bearing one: Delbrook's Whole Pool and Leisure Pool are two genuinely different
 * pools in one building, and merging them would take a real choice away from a parent rather than
 * remove a duplicate. Both numbers are pinned as tests in tests/sms/weekly_picks_diversity.test.ts
 * so a future metric or catalogue change cannot quietly move the band under this constant.
 *
 * The second arm — equal folded titles — is exact string equality after
 * `foldTitleForComparison`, the same shape `titlesMatch` uses and for the same reason: it cannot
 * drift the way a second fuzzy threshold could. Since 2026-09-10 that fold also strips a bare
 * daypart and a non-initial weekday, so the Pickleball pair now satisfies BOTH arms; the
 * threshold arm is kept because the fold cannot see every vendor's packaging.
 */
export function sameOfferingAtVenue(
  a: SearchResultItem,
  b: SearchResultItem,
  sameParentOrg: (x: ListingRecord, y: ListingRecord) => boolean
): boolean {
  if (!sameishPlace(a, b, sameParentOrg)) return false;
  if (similarity(a.listing.activityName, b.listing.activityName) >= SAME_VENUE_TITLE_SIMILARITY) {
    return true;
  }
  const fa = foldTitleForComparison(a.listing.activityName);
  return fa !== '' && fa === foldTitleForComparison(b.listing.activityName);
}

/**
 * Collapse duplicates, keeping the better-ranked member of each pair.
 *
 * Runs BEFORE the floor check (PRD §2.2 step 3: "so a collapsed pair doesn't silently eat two
 * slots") — a week that looks like it has four picks and is really two must degrade like two.
 *
 * O(n²) over the candidate list and that is fine: the list is a single weekend's showable
 * listings near one postal code, and the alternative — a blocking key to bucket by first — would
 * have to be derived from the title, which is the very thing being fuzzily compared.
 */
export function dedupeCandidates(
  candidates: SearchResultItem[],
  sameParentOrg: (x: ListingRecord, y: ListingRecord) => boolean
): { kept: SearchResultItem[]; collapsed: number } {
  const kept: SearchResultItem[] = [];
  let collapsed = 0;
  for (const candidate of candidates) {
    if (kept.some((k) => isDuplicatePair(k, candidate, sameParentOrg))) {
      collapsed += 1;
      continue;
    }
    kept.push(candidate);
  }
  return { kept, collapsed };
}

/**
 * Collapse two sittings of ONE activity at ONE venue down to the better-ranked one.
 *
 * SAME SHAPE AND SAME ORDERING RATIONALE AS `dedupeCandidates`, deliberately: walk in rank order,
 * keep the first member seen (which is the better-ranked one, because the list arrives ranked),
 * and count what was dropped. It runs IMMEDIATELY AFTER `dedupeCandidates` and therefore also
 * BEFORE the floor check, for the reason that pass already documents — a week that looks like it
 * has four picks and is really two must degrade like two, and a collapsed pair must not silently
 * eat two of the ten slots on the way past.
 *
 * IT IS THE ONLY NEW STAGE IN THIS FILE THAT REMOVES ANYTHING. Everything else this scope added
 * is a reorder. That asymmetry is the answer to "could a diversity rule empty a week?" — see
 * `selectFrom`'s header — and it is pinned from the other side by the scarcity invariants in
 * tests/sms/weekly_picks_diversity.test.ts.
 *
 * O(n²) over the candidate list, exactly as `dedupeCandidates` is, and fine for exactly the same
 * reason: the list is one weekend's showable listings near one postal code.
 */
export function collapseSameOfferingAtVenue(
  candidates: SearchResultItem[],
  sameParentOrg: (x: ListingRecord, y: ListingRecord) => boolean
): { kept: SearchResultItem[]; collapsed: number } {
  const kept: SearchResultItem[] = [];
  let collapsed = 0;
  for (const candidate of candidates) {
    if (kept.some((k) => sameOfferingAtVenue(k, candidate, sameParentOrg))) {
      collapsed += 1;
      continue;
    }
    kept.push(candidate);
  }
  return { kept, collapsed };
}

// ── (d) Age-coverage swap ────────────────────────────────────────────────────

/** Which of the requested bands a set of picks actually speaks to. */
function bandsRepresented(items: readonly SearchResultItem[]): Set<AgeBandKey> {
  const bands = new Set<AgeBandKey>();
  for (const item of items) for (const band of item.listing.ageBandMatches) bands.add(band);
  return bands;
}

export interface CoverageSwapResult {
  selection: SearchResultItem[];
  forced: ForcedPick[];
}

/**
 * Make sure every band the subscriber asked for is spoken for, within a hard cap.
 *
 * A household with a 3-year-old and an 8-year-old whose picks are all toddler content has been
 * served half a product, and rank alone will do that whenever one band's content is thinner. So
 * an unrepresented band may reach past the cut for ONE representative.
 *
 * THE CAP IS THE DESIGN, NOT A GUARD. Every forced pick is a relevance concession, so:
 *   • it may only reach into the top `COVERAGE_SWAP_REACH` (20) of the ranked, deduped list —
 *     past that a "representative" is just a low-relevance listing wearing a band label;
 *   • at most ONE forced pick per band (a band already represented is skipped);
 *   • at most `MAX_FORCED_PICKS` (2) IN TOTAL ACROSS ALL BANDS — not 2 per band.
 * If nothing qualifies inside that cap the band goes unrepresented THIS WEEK. That is the PRD's
 * explicit instruction and it is the right failure: a bad pick costs more than a missing one.
 *
 * WHEN THE SELECTION IS FULL, a forced pick displaces the LOWEST-RANKED pick that was not itself
 * forced — so two forced picks can never evict each other and the cap cannot be spent twice on
 * one slot. When the selection is not yet full nothing is displaced; the pick still counts against
 * the cap, because the cap is about how much forcing this surface does, not about how many slots
 * happened to be occupied.
 *
 * ═══ A FORCED PICK JUMPS THE QUEUE, SO IT IS ALWAYS NAMED (PRD §8 Q4, Jon-approved) ═══
 * A forced pick is placed at the FRONT of the selection, not appended to the tail.
 *
 * IT USED TO APPEND, AND THAT QUIETLY DEFEATED THE WHOLE FEATURE. lib/sms/weekly-send.ts names and
 * links only the first `DIRECT_LINK_PICKS` (3) picks; everything after folds into an anonymous
 * "+N more". A tail-appended forced pick on a full 10-pick week ranked 10 of 10 — so the pick
 * chosen SPECIFICALLY because a child's age band had no organic match was the one pick guaranteed
 * never to be named. A parent of a 12-year-old got three toddler activities named, and a count.
 *
 * JON'S RULING, verbatim: *"I approve option A. Let it jump the Q so it's always named."*
 *
 * THE COST IS REAL AND IS THE POINT, NOT A SIDE EFFECT: a lower-relevance forced pick now displaces
 * a higher-ranked organic one from the named top 2–3 on any short-band send. That tradeoff is now
 * an explicit product decision rather than a default nobody chose.
 *
 * FRONT, NOT "INSERTED AT SLOT 3". Placing it at the last named slot would displace less and still
 * satisfy "always named" TODAY — but only while `MAX_FORCED_PICKS` (2) stays ≤ `DIRECT_LINK_PICKS`
 * (3). Lower the direct-link count to 2 and a slot-3 insertion silently stops being named again,
 * with no test failing, which is precisely the failure this ruling exists to end. Front-placement
 * holds regardless of how either constant is later tuned.
 *
 * Forced picks are placed in the order they were forced (canonical youngest-band-first), so two
 * of them do not reorder each other, and the organic picks keep their relative rank order behind
 * them.
 *
 * Bands are considered in canonical youngest-first order so the outcome is deterministic.
 */
export function applyCoverageSwap(
  selection: readonly SearchResultItem[],
  ranked: readonly SearchResultItem[],
  requestedBands: readonly AgeBandKey[],
  maxPicks: number
): CoverageSwapResult {
  const picks = [...selection];
  const forced: ForcedPick[] = [];
  if (requestedBands.length === 0) return { selection: picks, forced };

  const forcedIds = new Set<string>();
  const reach = ranked.slice(0, COVERAGE_SWAP_REACH);

  for (const band of AGE_BAND_ORDER) {
    if (forced.length >= MAX_FORCED_PICKS) break;
    if (!requestedBands.includes(band)) continue;
    if (bandsRepresented(picks).has(band)) continue;

    const selectedIds = new Set(picks.map((p) => p.listing.id));
    const candidate = reach.find(
      (item) => !selectedIds.has(item.listing.id) && item.listing.ageBandMatches.includes(band)
    );
    if (!candidate) continue; // nothing qualifies within the cap — the band goes unrepresented

    let displaced: string | null = null;
    if (picks.length >= maxPicks) {
      // Lowest-ranked non-forced pick. Scan from the end: forced picks sit at the FRONT and the
      // organic ones keep their relative rank order behind them, so the last non-forced entry is
      // still the lowest-ranked organic pick.
      let victimIndex = -1;
      for (let i = picks.length - 1; i >= 0; i -= 1) {
        if (!forcedIds.has(picks[i].listing.id)) {
          victimIndex = i;
          break;
        }
      }
      if (victimIndex === -1) continue; // every pick is already forced — nothing may be evicted
      displaced = picks[victimIndex].listing.id;
      picks.splice(victimIndex, 1);
    }

    // FRONT, not tail — see the header. `forced.length` is how many are already at the front, so
    // each new one lands just behind them and the organic remainder shifts back by one.
    picks.splice(forced.length, 0, candidate);
    forcedIds.add(candidate.listing.id);
    forced.push({ band, occurrenceId: candidate.listing.id, displacedOccurrenceId: displaced });
  }

  return { selection: picks, forced };
}

// ── (e) Digest-sized venue spread ────────────────────────────────────────────

/**
 * Reorder the candidates so no venue holds more than `MAX_PICKS_PER_VENUE` of the first
 * `maxPicks` — the shared cap, called at THIS SURFACE'S SIZE and on THIS SURFACE'S KEY.
 *
 * ═══ WHY THE DIGEST PASSES OPTIONS INSTEAD OF CHANGING THE SHARED CONSTANTS ═══
 * `lib/search/venue-diversity.ts` exports the mechanism; this module supplies the numbers. Three
 * independent reasons not to retune `MAX_CARDS_PER_VENUE` / `VENUE_CAP_WINDOW` instead:
 *
 *   1. THEY ARE A DIFFERENT REPORT'S ANSWER TO A DIFFERENT MEASURED DEFECT. "3 per 20" is the
 *      2026-08-18 independent report's remedy, adopted verbatim, for SEARCH PAGES whose top rows
 *      were one community centre's whole timetable. Retuning it globally to fix a ten-item SMS
 *      digest changes /search for a problem /search does not have.
 *   2. COST, AND IT IS MEASURED IN THAT FILE RATHER THAN GUESSED HERE. The cap runs inside the
 *      broadening ladder's PROBE LOOP, so one search can pay for it ~10 times. Its rounds scale as
 *      ceil(the biggest group's share ÷ maxPerKey) — so LOWERING it globally makes it worse on
 *      precisely the pathological pages it was tuned for (5,000 cards of one venue: 253 ms before
 *      that file's optimisation, 0.6 ms after). Passing options from one caller confines the
 *      smaller divisor to one list of ~tens, where it is arithmetically free.
 *   3. FOUR OTHER CONSUMERS AND AN INVARIANT TEST DEPEND ON TODAY'S BEHAVIOUR. `engine.ts` calls
 *      the venue wrapper from `runPrimary` twice and from `runExpected` — /search, the three-card
 *      hero and both digests — and `invariants/card-honesty.test.ts` reasons about it.
 *
 * What DID change in this scope is that the shared function now takes a key. That is a strict
 * generalisation with a pinned-identical default path (see that file's property test), not a
 * change to any answer it previously gave.
 *
 * A REORDER, NEVER A FILTER — inherited, not re-argued. A card over the cap is DEFERRED to the
 * next round, not removed, so this returns exactly the cards it was given. That is what makes it
 * safe to run on the FULL candidate list before truncation, and it is why no cap in this file can
 * thin a week.
 *
 * NO ADAPTER ANY MORE. The cap used to deal only in `CollapsedListing`, so this module wrapped
 * every item to call it; now that the key is a parameter the wrapper is gone and the items are
 * passed as they are.
 */
function orderByVenueSpread(items: SearchResultItem[], maxPicks: number): SearchResultItem[] {
  return capByGroupingKey(items, (item) => venueIdentity(item.listing.venueName), {
    maxPerKey: MAX_PICKS_PER_VENUE,
    windowSize: maxPicks,
  });
}

/** How many of the subscriber's requested bands this listing actually admits. */
function bandsCovered(item: SearchResultItem, requestedBands: readonly AgeBandKey[]): number {
  if (requestedBands.length === 0) return 0;
  return requestedBands.filter((band) => item.listing.ageBandMatches.includes(band)).length;
}

/**
 * Reorder the candidates so no CATEGORY holds more than its allowance of the first `maxPicks`,
 * bounded by `COVERAGE_SWAP_REACH` and subject to the age-fit guard.
 *
 * ═══ WHY THIS RUNS AFTER THE VENUE PASS, AND NOT BEFORE ═══
 * Venue is the higher-cardinality, cheaper constraint: it satisfies itself a few positions deep,
 * so running it first costs almost nothing and hands the category pass a list that is ALREADY
 * venue-spread. Reversed, the category pass would happily seat two swims at the same pool and the
 * venue pass would then have to undo work the category pass had just justified — two passes over
 * one list, each able to defeat the other. The order is a decision, and a test fails if it is
 * swapped.
 *
 * ═══ WHY THIS KEY NEEDS A BOUNDED REACH AND THE VENUE KEY DOES NOT ═══
 * Venues are high-cardinality; categories number about ten. Measured: an UNBOUNDED cap of 2 on a
 * stratified pool reached original rank #92 to find its sixth category — which is exactly the
 * objection this scope has to answer ("don't show a family a worse, farther rock-climbing gym
 * just to hit a quota"). `COVERAGE_SWAP_REACH` bounds it, and it is REUSED rather than duplicated
 * under a new name on purpose: it is the same already-approved discipline at the same value, and
 * its own header gives the reasoning verbatim — past the reach, "a 'representative' is just a
 * low-relevance listing wearing a band label." Swap "band" for "category" and it still holds.
 *
 * Measured with the reach in place: a swim-only week (22 swims, one alternative at rank #23) comes
 * back BYTE-IDENTICAL to baseline. The alternative sits outside the reach and is never promoted.
 * That is the line, as a number rather than a promise.
 *
 * ═══ THE AGE-FIT GUARD — THE MOST IMPORTANT RULE IN THIS FILE ═══
 * See `canPromote` below. Category variety may never be bought with age fit.
 */
function orderByCategorySpread(
  items: SearchResultItem[],
  maxPicks: number,
  requestedBands: readonly AgeBandKey[],
  onBlocked: () => void
): SearchResultItem[] {
  return capByGroupingKey(items, (item) => item.listing.primaryCategoryKey?.trim().toLowerCase() || null, {
    maxPerKey: (key) => (key === CLASS_PROGRAM_CATEGORY_KEY ? CLASS_PROGRAM_CAP : MAX_PICKS_PER_CATEGORY),
    windowSize: maxPicks,
    reach: COVERAGE_SWAP_REACH,
    /**
     * ═══ THE AGE-FIT GUARD (the finding that shaped this whole design) ═══
     * A promotion may NEVER reduce age-band coverage. If the candidate about to jump the queue
     * admits FEWER of this subscriber's children than something it would jump over, the promotion
     * does not happen and the candidate is deferred alongside them instead.
     *
     * WHY THIS IS A HARD GUARD AND NOT A PREFERENCE. A large part of the swim monoculture is the
     * product answering a hard question CORRECTLY. Scored with the real ranker, `Open Gym 8yrs+`
     * is joint-first for a household of 9- and 15-year-olds and FOURTH for a household of 2- and
     * 13-year-olds — not because of a category bug, but because it does not admit a 2-year-old.
     * `ageMatchScore` returns covered/bands, so fitting 1 of 2 costs 0.3. Public swim, skating and
     * museums are among the few things that genuinely serve a toddler and a teenager at once, so a
     * wide-age household's swim-heavy list is partly just true.
     *
     * Without this guard, a category rule "fixing" that list would promote the open gym over the
     * swim and hand a parent of a 2-year-old something their toddler cannot attend — trading
     * monotony for IRRELEVANCE, which is worse. It would also be spending one mechanism to defeat
     * another: it is the exact inverse of what `applyCoverageSwap` exists to guarantee.
     *
     * Variety is found among things that fit the whole family, or it is not found this week.
     *
     * Equal coverage still promotes — the guard only ever blocks a STRICT reduction, so it costs
     * nothing when the two candidates serve the family equally well. With no bands requested there
     * is no coverage to reduce and the guard is inert.
     */
    canPromote: (candidate, deferred) => {
      if (requestedBands.length === 0) return true;
      const fit = bandsCovered(candidate, requestedBands);
      const blocked = deferred.some((other) => fit < bandsCovered(other, requestedBands));
      if (blocked) onBlocked();
      return !blocked;
    },
  });
}

// ── (f) Named-slot venue spread ──────────────────────────────────────────────

/** One named slot that was filled from further down the list, and what it cost. */
export interface PromotedPick {
  occurrenceId: string;
  /** Where it sat in the post-cap selection (0-based) before being promoted. */
  fromIndex: number;
  /** The named slot it was promoted into (0-based). */
  toIndex: number;
  /** The pick it swapped places with — the one that stopped being named. */
  displacedOccurrenceId: string;
  /** `fromIndex - toIndex`: how much deeper into the ten this named slot had to reach. */
  rankDelta: number;
  /**
   * `promoted.distanceKm - displaced.distanceKm`. Positive means the named slot got FARTHER away,
   * which is the real cost of this stage and the reason it is reported rather than assumed small.
   * Null when either card is un-geocoded — an absent coordinate is not a distance of zero.
   */
  distanceDeltaKm: number | null;
}

/**
 * Permute the chosen picks so the first `DIRECT_LINK_PICKS` are at distinct venues, where the
 * chosen picks allow it.
 *
 * ═══ SUBORDINATE TO JON'S RULING, NOT A QUALIFICATION OF IT ═══
 * `applyCoverageSwap` places a forced pick at the FRONT so it is always named — *"I approve
 * option A. Let it jump the Q so it's always named."* This stage runs AFTER that and NEVER MOVES A
 * FORCED PICK: not out of a named slot, not into one, not as the thing that gets displaced. Where
 * the two rules collide — the only card representing an unrepresented age band happens to sit at
 * a venue already named — the forced pick wins and two named picks share a venue. That is the
 * ACCEPTED outcome and not a gap in this stage: a missing age band is closer to WRONG, a repeated
 * venue is merely LESS GOOD, which is the ordering `three-things.ts#preferenceScore` already
 * establishes and this file reuses rather than re-argues.
 *
 * ═══ A PURE PERMUTATION, WHICH IS WHY IT IS FREE ═══
 * Only the first `DIRECT_LINK_PICKS` picks are named and linked; the rest fold into an anonymous
 * "+N more" (PRD §2.3), so this is the only part of venue repetition a parent sees without tapping
 * through — and on the 2026-09-10 report it was the sharpest form of it. NO CARD ENTERS OR LEAVES
 * the selection: a promotion is a SWAP, so membership is byte-identical before and after and the
 * relevance cost of this stage is exactly zero. The only thing it changes is which three get
 * named, which is the thing being fixed. When the picks do not contain enough distinct venues it
 * is a no-op — a selection that is entirely one venue is returned unchanged.
 *
 * A SWAP RATHER THAN A SPLICE-AND-SHIFT, deliberately: it is obviously a permutation by
 * construction, and it makes "the pick it displaced" a single unambiguous card, which is what the
 * telemetry has to name to be worth anything.
 *
 * AN UNNAMED VENUE IS NEVER PROMOTED FOR ITS VARIETY. `venueIdentity` returns null for an empty
 * venue name, and that null is the absence of a fact, not a venue — this module must treat it as
 * "no opinion" (the rule `venue-diversity.ts` states for every caller). So a null-venue pick
 * already in the named block never counts as a repeat, and a null-venue pick below it is never
 * promoted as though it were somewhere new.
 */
export function spreadNamedSlotVenues(
  selection: readonly SearchResultItem[],
  forcedIds: ReadonlySet<string>,
  namedCount: number
): { selection: SearchResultItem[]; promoted: PromotedPick[] } {
  const picks = [...selection];
  const promoted: PromotedPick[] = [];
  const named = Math.min(namedCount, picks.length);
  if (named < 2) return { selection: picks, promoted };

  const usedVenues = new Set<string>();
  for (let i = 0; i < named; i += 1) {
    const venue = venueIdentity(picks[i].listing.venueName);
    const isForced = forcedIds.has(picks[i].listing.id);
    if (!isForced && venue != null && usedVenues.has(venue)) {
      const swapIndex = picks.findIndex((candidate, index) => {
        if (index < named) return false; // already named — moving it here changes nothing
        if (forcedIds.has(candidate.listing.id)) return false; // a forced pick is never moved
        const v = venueIdentity(candidate.listing.venueName);
        return v != null && !usedVenues.has(v);
      });
      if (swapIndex !== -1) {
        const incoming = picks[swapIndex];
        const outgoing = picks[i];
        picks[i] = incoming;
        picks[swapIndex] = outgoing;
        promoted.push({
          occurrenceId: incoming.listing.id,
          fromIndex: swapIndex,
          toIndex: i,
          displacedOccurrenceId: outgoing.listing.id,
          rankDelta: swapIndex - i,
          distanceDeltaKm:
            incoming.distanceKm != null && outgoing.distanceKm != null
              ? incoming.distanceKm - outgoing.distanceKm
              : null,
        });
      }
    }
    const seated = venueIdentity(picks[i].listing.venueName);
    if (seated != null) usedVenues.add(seated);
  }

  return { selection: picks, promoted };
}

// ── The pipeline ─────────────────────────────────────────────────────────────

interface AttemptResult {
  selection: SearchResultItem[];
  forced: ForcedPick[];
  collapsed: number;
  novelExcluded: number;
  diversity: DiversitySummary;
}

/**
 * Everything after the search: gates → dedup → truncate → coverage swap.
 *
 * Split from the search itself because the PRD's step (b) re-runs exactly this over the SAME
 * response with `applyInterests` flipped off — see `Attempt`. Keeping the seam explicit is what
 * makes "drop the interest filter" a one-argument change rather than a second pipeline.
 */
function selectFrom(
  response: ReturnType<SearchEngine['search']>,
  input: WeeklyPicksInput,
  bands: AgeBandKey[],
  applyInterests: boolean
): AttemptResult {
  const sameParentOrg = input.sameParentOrg ?? (() => false);
  const maxPicks = input.maxPicks ?? MAX_PICKS;

  // `results` ONLY — never `ageUnconfirmed`, never `expected`. See this file's header.
  // Every other gate stays on in both retry steps: dropping interests widens WHICH activities
  // qualify, never what we are willing to stand behind.
  const showable = response.results
    .filter((item) => isShowableOnFrontDoor(item.listing))
    // PRD v2.8 §2.2 step 2 — multi-session commitments out, one-off bookings in. Applied here
    // rather than by the engine because the engine's own switch is all-or-nothing; see
    // `buildPicksRequest` for why the request asks for the wider set.
    .filter((item) => isWeeklyPickEligible(item.listing))
    .filter((item) =>
      applyInterests ? matchesInterests(item.listing, input.subscriber.categoryInterests) : true
    );

  const { kept, collapsed } = dedupeCandidates(showable, sameParentOrg);

  // ── SAME OFFERING AT ONE VENUE (2026-09-10) ─────────────────────────────────────────
  // BETWEEN the dedup pass and the novelty exclusion, for the two reasons each of its neighbours
  // already gives. After dedup, because the two answer different questions and the cheaper,
  // PRD-specified one should have its say first — and because a row that is BOTH a duplicate
  // occurrence and a second sitting must be counted once, under `deduped`, rather than twice.
  // Before novelty and before the floor check, because a collapsed pair must not silently eat two
  // of the ten slots — the same ordering rationale `dedupeCandidates` records for itself.
  const { kept: distinctOfferings, collapsed: sameOfferingCollapsed } =
    collapseSameOfferingAtVenue(kept, sameParentOrg);

  // ── NOVELTY (PRD v2.8 §2.2 step 4) ──────────────────────────────────────────────────
  // AFTER dedup and BEFORE the coverage swap, exactly as specified — and the ordering is not
  // arbitrary. After dedup, because a repeat and its duplicate should collapse first so the
  // exclusion removes one thing rather than two. Before the swap, because `fresh` is what the
  // swap both selects from AND reaches into: passing the pre-filter list would let a forced pick
  // reintroduce an already-sent occurrence through the back door.
  const alreadySent = input.excludeOccurrenceIds;
  const fresh =
    alreadySent && alreadySent.size > 0
      ? distinctOfferings.filter((item) => !alreadySent.has(item.listing.id))
      : distinctOfferings;
  const novelExcluded = distinctOfferings.length - fresh.length;

  // ── DIGEST-SIZED VENUE CAP (2026-09-10) ─────────────────────────────────────────────
  // Applied to the FULL candidate list and BEFORE the truncation, which is the entire remedy for
  // the latent failure: the engine capped at a window of 20, then this module's gates, dedup and
  // novelty removed cards underneath that promise, so the surviving top ten could straddle the
  // cap's round boundary and hold SIX from one venue. Running last, on everything, over this
  // surface's own window, means nothing downstream can undo it.
  //
  // `maxPicks` is read from the INPUT rather than the constant, so the cap tracks the list size
  // automatically if a future per-subscriber preference changes it.
  const venueOrdered = orderByVenueSpread(fresh, maxPicks);
  const beforeVenueCap = new Set(fresh.slice(0, maxPicks).map((item) => item.listing.id));
  const venueCapDeferred = venueOrdered
    .slice(0, maxPicks)
    .filter((item) => !beforeVenueCap.has(item.listing.id)).length;

  // ── CATEGORY CAP, BOUNDED (2026-09-10) ──────────────────────────────────────────────
  // AFTER the venue pass — see `orderByCategorySpread` for why that order is a decision and not
  // an accident, and for the age-fit guard that bounds what it may promote.
  let ageFitBlocked = 0;
  const ordered = orderByCategorySpread(venueOrdered, maxPicks, bands, () => {
    ageFitBlocked += 1;
  });
  const beforeCategoryCap = new Set(venueOrdered.slice(0, maxPicks).map((item) => item.listing.id));
  const afterCap = ordered.slice(0, maxPicks);
  const categoryCapDeferred = afterCap.filter((item) => !beforeCategoryCap.has(item.listing.id)).length;

  // `ordered` is the single ranked list from here on — it is what the selection is taken from AND
  // what the coverage swap reaches into, so "the top 20" means one thing rather than two.
  const { selection, forced } = applyCoverageSwap(afterCap, ordered, bands, maxPicks);

  // ── NAMED-SLOT VENUE SPREAD (2026-09-10) ────────────────────────────────────────────
  // AFTER the coverage swap, and moving none of what the swap forced — see
  // `spreadNamedSlotVenues`. A pure permutation of what is already chosen.
  const forcedIds = new Set(forced.map((f) => f.occurrenceId));
  const { selection: spread, promoted } = spreadNamedSlotVenues(
    selection,
    forcedIds,
    DIRECT_LINK_PICKS
  );

  return {
    selection: spread,
    forced,
    collapsed,
    novelExcluded,
    diversity: {
      sameOfferingCollapsed,
      venueCapDeferred,
      categoryCapDeferred,
      ageFitBlocked,
      namedSlotsPermuted: promoted.length,
      promoted,
    },
  };
}

/**
 * This subscriber's picks for this weekend. Pure: the only I/O is whatever the engine was wired
 * with by the caller.
 *
 * THE DEGRADATION LADDER (PRD v2.4 §2.2 step 5), and why it is a straight line of `if`s rather
 * than a loop:
 *
 *   primary                          — the weekend, the subscriber's radius, their interests.
 *   ↓ still below the floor
 *   (a) widened                      — one radius step out, window relaxed to Sat–Tue.
 *   ↓ still below the floor, AND they actually stated an interest
 *   (b) interests dropped            — the same widened search, minus the category post-filter.
 *   ↓ still below the floor
 *   empty week.
 *
 * "Non-compounding" is enforced STRUCTURALLY, not by discipline: `buildPicksRequest` reads only
 * the original input (see its header), so there is no accumulated state for a second widening to
 * build on, and there is no loop here that could run a third time.
 *
 * STEP (b) REUSES STEP (a)'S RESPONSE rather than searching again. Interests are a post-filter on
 * ranked results, not a query parameter, so step (b) asks the engine an identical question — and
 * issuing it twice would be both wasted work and a place for the two answers to differ.
 *
 * STEP (b) IS SKIPPED WHEN THERE IS NOTHING TO DROP. A subscriber who stated no interests has no
 * filter to relax, so firing it would be a no-op that nonetheless reported itself as a
 * degradation the subscriber never suffered. `degradation` stays `'widened'` in that case.
 */
export function selectWeeklyPicks(input: WeeklyPicksInput): WeeklyPicks {
  const floor = input.floorPicks ?? FLOOR_PICKS;
  const bands = ageBandsFromBirthYears(input.subscriber.birthYears, input.now);
  const hasInterests = (input.subscriber.categoryInterests?.length ?? 0) > 0;

  const primaryRequest = buildPicksRequest(input, 'primary');
  const primaryResponse = input.engine.search(primaryRequest);
  let attempt = selectFrom(primaryResponse, input, bands, true);

  let degradation: Degradation = 'none';
  let radiusKmUsed = primaryRequest.radiusKm ?? DEFAULT_RADIUS_KM;
  const primaryReached = primaryResponse.total;
  let retryReached: number | null = null;

  if (attempt.selection.length < floor) {
    // ── Step (a): widen radius one fixed step, relax the window to weekend + Mon/Tue.
    const retryRequest = buildPicksRequest(input, 'retry');
    const retryResponse = input.engine.search(retryRequest);
    retryReached = retryResponse.total;
    radiusKmUsed = retryRequest.radiusKm ?? radiusKmUsed;
    degradation = 'widened';
    // The retried set REPLACES the primary one rather than merging with it: it is a superset by
    // construction (wider radius, wider window, same filters), so merging could only ever
    // reintroduce candidates the retry's own dedup pass had already collapsed.
    attempt = selectFrom(retryResponse, input, bands, true);

    // NOTE: the novelty exclusion is NOT relaxed by either step. `selectFrom` reads it from the
    // input unconditionally, so there is no branch a retry could take that skips it — PRD v2.8
    // §2.2 step 6: "an empty week stays empty rather than re-serving a repeat pick to fill it."

    // ── Step (b): drop the category-interest filter before declaring an empty week.
    //
    // Interests are an OPTIONAL field stored as a HARD post-filter (the engine has no
    // soft-preference concept — see `matchesInterests`), so without this a parent who ticked one
    // narrow box could be told "nothing this weekend" on a weekend that genuinely had matches for
    // their kids just outside it. An empty text is the most expensive thing this product can
    // send; a pick slightly off-interest is not close to as costly.
    if (attempt.selection.length < floor && hasInterests) {
      degradation = 'widened_and_interests_dropped';
      attempt = selectFrom(retryResponse, input, bands, false);
    }
  }

  const reached = { primary: primaryReached, retry: retryReached };
  const retried = degradation !== 'none';
  const interestsDropped = degradation === 'widened_and_interests_dropped';

  if (attempt.selection.length < floor) {
    const lastReached = retryReached ?? primaryReached;
    return {
      outcome: 'empty',
      picks: [],
      emptyReason: lastReached === 0 ? 'nothing_reached' : 'none_showable',
      ageBands: bands,
      ageAware: bands.length > 0,
      degradation,
      retried,
      interestsDropped,
      radiusKmUsed,
      reached,
      forcedPicks: attempt.forced,
      deduped: attempt.collapsed,
      novelExcluded: attempt.novelExcluded,
      diversity: attempt.diversity,
      shouldPause: input.subscriber.consecutiveEmptyWeeks + 1 >= 3,
    };
  }

  const forcedByListing = new Map(attempt.forced.map((f) => [f.occurrenceId, f.band]));
  const picks: WeeklyPick[] = attempt.selection.map((item, index) => {
    const forcedForBand = forcedByListing.get(item.listing.id);
    return {
      item,
      rank: index + 1,
      // Top N get their own short link; the rest fold into the "+N more" hub link (PRD §2.3).
      linkOrigin: index < DIRECT_LINK_PICKS ? 'direct' : 'hub',
      ...(forcedForBand ? { forcedForBand } : {}),
    };
  });

  return {
    outcome: 'picks',
    picks,
    emptyReason: null,
    ageBands: bands,
    ageAware: bands.length > 0,
    degradation,
    retried,
    interestsDropped,
    radiusKmUsed,
    reached,
    forcedPicks: attempt.forced,
    deduped: attempt.collapsed,
    novelExcluded: attempt.novelExcluded,
    diversity: attempt.diversity,
    shouldPause: false,
  };
}

/** The picks that carry their own direct link — what the message body renders in full. */
export function directPicks(result: WeeklyPicks): WeeklyPick[] {
  return result.picks.filter((p) => p.linkOrigin === 'direct');
}

/** How many picks fold into the "+N more" hub link. */
export function hubPickCount(result: WeeklyPicks): number {
  return result.picks.filter((p) => p.linkOrigin === 'hub').length;
}
