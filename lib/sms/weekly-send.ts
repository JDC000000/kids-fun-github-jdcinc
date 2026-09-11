// lib/sms/weekly-send.ts — build one subscriber's Friday text. PURE.
//
// DRAFT (SMS pivot). The counterpart of lib/email/digest.ts: given a wired SearchEngine, a clock
// and one subscriber's stored row, it produces the message that subscriber would receive — with
// no DB, no network and no Twilio. All the I/O (loading subscribers, dispatching, logging,
// applying the status change) belongs to lib/sms/weekly-send-io.ts, exactly as
// lib/email/weekly.ts owns digest.ts's.
//
// That split is what makes this testable against the fixture engine, and it is also what stops
// the message wording drifting from what /search would show: matching REUSES the real pipeline
// (SearchEngine, via lib/sms/weekly-picks.ts) rather than reimplementing it.
//
// ── GEOCODING HAPPENS HERE, AND IT IS PURE ──────────────────────────────────────────────
// `fsaGeocoder` (lib/geo/postal-fsa.ts) is a static FSA→municipality-centroid table — a lookup,
// not a network call — so resolving the subscriber's postal code sits inside the pure builder
// rather than in the I/O layer. lib/email/weekly.ts wires the same geocoder for the same reason.
//
// This is deliberately NOT `resolveOrigin`'s `saved_home` mode, which throws `auth_required`
// unless a caller is signed in (lib/geo/origin.ts:66) — that path is for a logged-in website
// visitor. An SMS subscriber is never signed in; the resolved coordinate goes to the selector as
// a `near_me` origin, which is simply the transport for a raw point.
//
// ── FOUR OUTCOMES, AND WHY `geocode_failed` IS NOT `empty` ──────────────────────────────
// A postal code that resolves to no covered municipality gets its OWN outcome. Folding it into
// "below floor with 0 matches" would be wrong twice over: it would text a parent "nothing
// matches your area this week" about a search that never ran, and it would increment the
// empty-week counter and eventually pause them for a defect on our side. The signup form now
// rejects out-of-area postals (round 3), so a subscriber in this state is a row that predates
// that check or an FSA table that has moved — either way it is an operational problem someone
// should see, not a quiet weekend. See `nextEmptyWeekState`'s `not_attempted` branch.

import type { SearchEngine } from '@/lib/search/engine';
import type { AgeBandKey, ListingRecord } from '@/lib/search/types';
import { fsaGeocoder, areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { encodeShortLink } from './short-link';
import { preferencesUrl as buildPreferencesUrl, shortLinkUrl } from './config';
import {
  renderEmptyWeekMessage,
  renderPauseNoticeMessage,
  renderWeeklyMessage,
  type MessagePick,
  type NamedPick,
  type RenderedMessage,
} from './message';
import {
  DIRECT_LINK_PICKS,
  ageBandsFromBirthYears,
  selectWeeklyPicks,
  type WeeklyPicks,
} from './weekly-picks';
import type { WeekOutcome } from './empty-week';

/**
 * One `sms_consent` row, as the send job needs it.
 *
 * Deliberately the STORED shape — birth years rather than ages, a postal code rather than a
 * point — so that everything derived is derived here, at send time, from what the database
 * actually holds. Nothing upstream gets to pre-compute an age.
 */
export interface SmsSubscriber {
  id: string;
  /** `sms_consent.short_ref` — the compact alias the short-link token encodes (migration 0034). */
  shortRef: number;
  postalCode: string;
  birthYears: readonly number[];
  categoryInterests?: readonly string[];
  consecutiveEmptyWeeks: number;
  /** `sms_consent.preferences_token` — the no-login hub link in every message. */
  preferencesToken: string;
  /**
   * `sms_consent.consent_text_version` — the wording THIS subscriber agreed to.
   *
   * Carried on the row rather than passed as a send-time option, because the send log copies it
   * verbatim and `sms_send_log.consent_text_version` is NOT NULL (migration 0035). An optional
   * argument with a default would mean a placeholder like 'unknown' could be written into the
   * column an audit reads — the one column where a plausible-looking wrong value is worse than a
   * failed insert.
   */
  consentTextVersion: string;
  /** Travel radius, if the subscriber has one; otherwise the product default. */
  radiusKm?: number;
}

export interface BuildWeeklySmsInput {
  engine: SearchEngine;
  /** The clock. Passed, never ambient, so every send is reproducible. */
  now: Date;
  subscriber: SmsSubscriber;
  /**
   * `activity_occurrence.id` → `activity_occurrence.short_ref` (migration 0037).
   *
   * PASSED IN, NOT FETCHED — the direct mirror of `WeeklyDeps.createdAtMs` in
   * lib/email/weekly.ts, which carries occurrence timestamps the same way for the same reason: a
   * bulk run loads the map ONCE and reuses it across every subscriber, rather than issuing a
   * lookup per pick per subscriber. It also keeps this module free of any DB import.
   *
   * A pick whose id is absent from the map cannot be given a direct link — see
   * `directLinkablePicks` for what happens then, which is not "drop the pick".
   */
  occurrenceShortRefs: ReadonlyMap<string, number>;
  /**
   * Occurrences this subscriber has already been sent (PRD v2.8 §2.2 step 4).
   *
   * PASSED IN, like everything else this module needs — the builder stays pure and the caller owns
   * the window. Empty or absent means no novelty filtering, which is correct for a subscriber's
   * very first send.
   */
  excludeOccurrenceIds?: ReadonlySet<string>;
  /** Override the number of picks that get their own link. Defaults to the PRD's top 2-3. */
  directLinkCount?: number;
}

export type WeeklySmsOutcome =
  /** Picks selected, a real weekly message rendered. */
  | 'picks'
  /** Below the floor after both degradation retries. A searched-for, honest nothing. */
  | 'empty'
  /** The subscriber's postal code resolves to no covered municipality. See the header. */
  | 'geocode_failed';

export interface WeeklySmsPlan {
  subscriberId: string;
  outcome: WeeklySmsOutcome;
  /**
   * The message to send, or null when there is nothing to send (`geocode_failed`).
   *
   * For `empty` this is the "nothing new this week" text. It may be REPLACED by the pause notice
   * — see `pauseNoticeFor`, and the note on `outcome` below.
   */
  message: RenderedMessage | null;
  /** The full selection result, for the send log's `picks_snapshot` and for diagnostics. */
  picks: WeeklyPicks | null;
  /** Age bands computed from `birth_years` at `now`. */
  ageBands: AgeBandKey[];
  /** The subscriber's area, as the message says it ("East Van"). Null when geocoding failed. */
  areaLabel: string | null;
  /** Occurrence ids that got a direct link, in message order. */
  directOccurrenceIds: string[];
  /**
   * Picks the selector intended to link directly but that could not be linked, because their
   * occurrence had no `short_ref` in the deps map. Reported rather than silent — a non-empty
   * array means the map is stale relative to the catalogue.
   */
  unlinkableOccurrenceIds: string[];
  /** How many picks folded into the "+N more" hub link. */
  hubPickCount: number;
}

/**
 * The counter/pause outcome this plan implies (lib/sms/empty-week.ts's vocabulary).
 *
 * A tiny translation function rather than one shared enum, deliberately: the two modules answer
 * different questions. This one is about what the SEARCH produced; that one is about what the
 * COUNTER should do — and `geocode_failed` maps to `not_attempted` precisely because those two
 * questions have different answers for it.
 */
export function weekOutcomeFor(plan: WeeklySmsPlan): WeekOutcome {
  if (plan.outcome === 'picks') return 'picks';
  if (plan.outcome === 'empty') return 'empty';
  return 'not_attempted';
}

/** The pause-notice message for a subscriber, when the counter says this is the third empty week. */
export function pauseNoticeFor(subscriber: SmsSubscriber): RenderedMessage {
  return renderPauseNoticeMessage(buildPreferencesUrl(subscriber.preferencesToken));
}

/** Human age labels for the opener: 'under2' reads as "under 2", the rest are already readable. */
export function ageLabelsFor(bands: readonly AgeBandKey[]): string[] {
  return bands.map((band) => (band === 'under2' ? 'under 2' : band));
}

/**
 * The venue a pick names, or null when the catalogue has none worth printing.
 *
 * `postgres-repository.rowToListing` falls back to the SOURCE's name when a venue is missing, so
 * a "venue" can end up being something like an ingestion feed's title. Printing that in brackets
 * after an activity name would read as a place a parent could drive to. Rather than guess, the
 * only rule applied is the cheap one: an empty or whitespace venue prints nothing.
 */
function venueLabel(listing: ListingRecord): string | null {
  const name = listing.venueName?.trim();
  return name ? name : null;
}

/**
 * Which picks can actually carry a direct link, and which cannot.
 *
 * The selector decides the INTENT (which picks are worth a direct link — `linkOrigin`), and this
 * decides what is POSSIBLE (whether the occurrence has a `short_ref` to encode). Keeping those
 * two separate is why a stale deps map degrades gracefully: a pick with no short_ref is not
 * dropped from the week, it just loses its own line and folds into the "+N more" count, and the
 * next pick is promoted into its place. The alternative — dropping it — would silently shrink a
 * week below the floor for a reason that has nothing to do with the catalogue.
 */
function directLinkablePicks(
  picks: WeeklyPicks,
  shortRefs: ReadonlyMap<string, number>,
  limit: number
): { linkable: WeeklyPicks['picks']; unlinkable: string[] } {
  const linkable: WeeklyPicks['picks'] = [];
  const unlinkable: string[] = [];
  for (const pick of picks.picks) {
    if (linkable.length >= limit) break;
    if (shortRefs.has(pick.item.listing.id)) linkable.push(pick);
    else unlinkable.push(pick.item.listing.id);
  }
  return { linkable, unlinkable };
}

/**
 * Build one subscriber's weekly text.
 *
 * MAY THROW, in exactly one case, and that is intentional: `encodeShortLink` throws when
 * SMS_SHORT_LINK_SECRET is unset, because a link that cannot be verified must never be minted.
 * lib/email/weekly.ts has the identical shape — `unsubscribeUrl` throws for the same reason and
 * the orchestrator's try/catch turns it into a structured error rather than a broken message.
 * Do not catch it here: an unconfigured environment must fail loudly, not send a text with a
 * link nobody can check.
 */
export function buildWeeklySms(input: BuildWeeklySmsInput): WeeklySmsPlan {
  const { subscriber, now } = input;
  const ageBands = ageBandsFromBirthYears(subscriber.birthYears, now);
  const preferences = buildPreferencesUrl(subscriber.preferencesToken);

  // ── Geocode. Pure table lookup; null means no covered municipality. ──
  const geo = fsaGeocoder.geocodePostal(subscriber.postalCode);
  const areaLabel = areaLabelForPostal(subscriber.postalCode);
  if (!geo || !areaLabel) {
    return {
      subscriberId: subscriber.id,
      outcome: 'geocode_failed',
      message: null, // Nothing is sent. See this file's header for why silence is correct here.
      picks: null,
      ageBands,
      areaLabel: null,
      directOccurrenceIds: [],
      unlinkableOccurrenceIds: [],
      hubPickCount: 0,
    };
  }

  // ── Select. Every rule (dedup, coverage swap, both retries) lives in weekly-picks.ts. ──
  const picks = selectWeeklyPicks({
    engine: input.engine,
    now,
    subscriber: {
      origin: { geo, label: areaLabel },
      radiusKm: subscriber.radiusKm,
      birthYears: subscriber.birthYears,
      categoryInterests: subscriber.categoryInterests,
      consecutiveEmptyWeeks: subscriber.consecutiveEmptyWeeks,
    },
    excludeOccurrenceIds: input.excludeOccurrenceIds,
  });

  if (picks.outcome === 'empty') {
    return {
      subscriberId: subscriber.id,
      outcome: 'empty',
      message: renderEmptyWeekMessage(preferences),
      picks,
      ageBands,
      areaLabel,
      directOccurrenceIds: [],
      unlinkableOccurrenceIds: [],
      hubPickCount: 0,
    };
  }

  // ── Render. ──
  const limit = input.directLinkCount ?? DIRECT_LINK_PICKS;
  const { linkable, unlinkable } = directLinkablePicks(picks, input.occurrenceShortRefs, limit);

  const directPicks: MessagePick[] = linkable.map((pick) => {
    const occurrenceShortRef = input.occurrenceShortRefs.get(pick.item.listing.id) as number;
    // Per (occurrence, subscriber) — this is what makes a click attributable to one person.
    const token = encodeShortLink(occurrenceShortRef, subscriber.shortRef);
    return {
      name: pick.item.listing.activityName,
      venue: venueLabel(pick.item.listing),
      startDatetimeUtc: pick.item.slots[0]?.startDatetimeUtc ?? pick.item.listing.startDatetimeUtc,
      url: shortLinkUrl(token),
    };
  });

  // Everything the selection chose that did NOT get a link, in rank order, offered to the
  // renderer as candidates to NAME. How many of them fit is the renderer's budget call, not a
  // second constant here — see `renderWeeklyMessage`. A pick with no `short_ref` is in this list
  // too: it lost its link, which is not a reason to lose its name as well.
  const linkedIds = new Set(linkable.map((pick) => pick.item.listing.id));
  const namedPickCandidates: NamedPick[] = picks.picks
    .filter((pick) => !linkedIds.has(pick.item.listing.id))
    .map((pick) => ({
      name: pick.item.listing.activityName,
      startDatetimeUtc: pick.item.slots[0]?.startDatetimeUtc ?? pick.item.listing.startDatetimeUtc,
    }));

  const message = renderWeeklyMessage({
    totalPicks: picks.picks.length,
    ageLabels: ageLabelsFor(ageBands),
    areaLabel,
    directPicks,
    namedPickCandidates,
    preferencesUrl: preferences,
  });

  return {
    subscriberId: subscriber.id,
    outcome: 'picks',
    message,
    picks,
    ageBands,
    areaLabel,
    directOccurrenceIds: linkable.map((p) => p.item.listing.id),
    unlinkableOccurrenceIds: unlinkable,
    hubPickCount: picks.picks.length - directPicks.length,
  };
}

/**
 * `sms_send_log.picks_snapshot` (migration 0035): occurrence ids + rank, weekly sends only.
 *
 * A SNAPSHOT, not a join — it must still answer "what did this text actually say" after the
 * catalogue has been re-ingested or those rows archived. Built here so the shape lives beside the
 * message it describes rather than inside the SQL that writes it.
 */
export function picksSnapshot(plan: WeeklySmsPlan): Array<{ occurrence_id: string; rank: number }> | null {
  if (plan.outcome !== 'picks' || !plan.picks) return null;
  return plan.picks.picks.map((pick) => ({
    occurrence_id: pick.item.listing.id,
    rank: pick.rank,
  }));
}
