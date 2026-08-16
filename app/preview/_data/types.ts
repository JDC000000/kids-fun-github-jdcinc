// Fixture-side domain types for the mobile UI shell.
//
// These mirror the canonical `activity_occurrence` fields and enums from TSD v1.2
// §6 (status_state, cost_status) and BR-12, so the shell can be wired to the real
// search/ranking API (Track D) later with minimal reshaping. This is fixture-only
// data — no database, no network, no secrets.

/**
 * The 16 canonical BR-12 `status_state` values (TSD §6.2, Appendix C), in the same
 * order as the DB enum (migration 0002) and `lib/search/types.ts`. The parent-facing
 * UI renders EVERY one of them with honest copy (see `statusMeta`) — no live status may
 * fall through to a generic "Unknown", and none but `confirmed`/`bookable_open` is ever
 * shown as confirmed (UXR-06 / T-07). Mirrored here (not imported) so the fixture/demo
 * layer stays self-contained, but the value set is identical to the search lib's.
 */
export type StatusState =
  | 'confirmed'
  | 'bookable_open'
  | 'not_yet_bookable'
  | 'schedule_not_published'
  | 'inferred_recurring'
  | 'manual_candidate'
  | 'seasonal_out_of_season'
  | 'seasonal_preseason'
  | 'seasonal_active'
  | 'suspended'
  | 'stale'
  | 'cancelled'
  | 'postponed'
  | 'full'
  | 'waitlist'
  | 'needs_review';

/** How a parent actually acts on the listing (drives the booking/registration tag). */
export type BookingType = 'bookable_now' | 'drop_in' | 'registration' | 'none';

/** Canonical cost_status (TSD §6): unknown is never rendered as free. */
export type CostStatus = 'free' | 'known' | 'unknown';

/** Activity category — each owns a palette pairing + glyph in the illustration system (D4). */
export type Category =
  | 'swim'
  | 'skate'
  | 'open_gym'
  | 'storytime'
  | 'museum_arts'
  | 'nature'
  | 'festival'
  | 'indoor_play';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Confidence label (BR-13): authority × parse quality × freshness × volatility, collapsed. */
export type ConfidenceLabel = 'confirmed' | 'official' | 'editorial' | 'candidate';

/**
 * One collapsed-card member's own cost.
 *
 * A card that stands for several same-day slots of one series states the GROUP's cost, not its
 * representative's (`formatCost` → `readGroupCost`), so it needs all three cost fields from every
 * member. The same three fields `Activity` carries, mirrored here rather than imported for the same
 * reason this file mirrors the enums above: the fixture/demo layer stays self-contained, and the
 * value set is identical to the search lib's.
 */
export interface SlotCost {
  costStatus: CostStatus;
  costMinCad?: number;
  costMaxCad?: number;
}

/**
 * One dated activity occurrence — the unit a parent scans.
 * Field names track TSD §6 `activity_occurrence` where practical.
 */
export interface Activity {
  id: string;
  activityName: string; // e.g. "Public skate"
  venue: string; // e.g. "Trout Lake Rink"
  area: string; // e.g. "Trout Lake"
  /**
   * Travel from the PARENT'S origin — both `null` whenever no distance is knowable, which is
   * the DEFAULT state, not an edge case: a search with no near-me coordinates and no saved
   * location has no origin to measure from, and the engine returns `distanceKm: null` for
   * every result (lib/search/rank.ts). An un-geocoded venue is null for the same reason.
   *
   * Nullable rather than "0" or "distance from some assumed point": the mapper used to
   * synthesise a number off a hardcoded East Vancouver coordinate whenever the real one was
   * null, so every card stated a confident travel distance from a place the parent had never
   * told us about (P0 — fabricated distances). A number a parent can act on must be measured,
   * and when it cannot be measured the surfaces say so — see `formatDistance`.
   */
  driveMinutes: number | null;
  distanceKm: number | null;
  category: Category;
  ageMin: number;
  ageMax: number;
  startIso: string; // America/Vancouver, explicit offset
  endIso: string;
  timeOfDay: TimeOfDay;
  costStatus: CostStatus;
  costMinCad?: number;
  costMaxCad?: number;
  status: StatusState;
  booking: BookingType;
  confidence: ConfidenceLabel;
  sourceName: string; // e.g. "vancouver.ca"
  sourceUrl: string; // authoritative deep link (external)
  /** Optional external detail fallback while live DB detail pages are not built. */
  detailUrl?: string;
  bookingUrl?: string;
  locationUrl?: string;
  /**
   * The venue's own published phone number (`venue.phone`), verbatim as the source renders
   * it. Absent for every listing whose source family publishes no facility number — the
   * detail UI renders nothing at all in that case rather than an empty field.
   */
  venuePhone?: string;
  lastCheckedIso: string; // freshness stamp source of truth
  /**
   * How many same-series-same-day occurrences this ONE card now stands for (lib/search/collapse.ts).
   * 1 (or absent) is an ordinary single-slot card; >1 renders as "15 slots, 3:15 PM–7:30 PM" instead
   * of fifteen near-identical cards.
   */
  slotCount?: number;
  /** End of the LAST slot, when this card covers several — the closing edge of the displayed span. */
  slotEndIso?: string;
  /**
   * EVERY slot's own cost, carried only when this card stands for more than one (see `slotCount`).
   * A collapsed card whose sessions disagree on price may not print one of them as if it spoke for
   * all — `formatCost` reads this, not just the three fields above, to decide what may be said.
   *
   * ABSENT ON AN ORDINARY SINGLE-SLOT CARD, and that absence is load-bearing rather than an
   * optimisation: `formatCost` falls back to the card's own three fields, so every card that never
   * had this defect keeps exactly the label it had before.
   */
  slotCosts?: SlotCost[];
  /**
   * This listing needs registering/booking in advance; it is not something to turn up to today.
   * Only ever true on cards a parent asked to see (the registration filter is off by default), and
   * it exists so the card can say so plainly rather than sitting silently among drop-in results.
   */
  registrationRequired?: boolean;
  seasonLabel?: string; // for seasonal_out_of_season copy
  indoor: boolean;
  rainyDay: boolean; // good option when it's raining
  dropIn: boolean;
  descriptionSnippet: string;
  parentNotes: string[]; // stroller/transit/sibling-fit facts
  /** Real source-authored age guidance (occurrence_age.age_notes), surfaced verbatim when present. */
  ageNotes?: string;
}

/** Visual + copy treatment for a status — never colour-only (paired label + icon). */
export interface StatusMeta {
  /** Short label shown on the card pill. */
  label: string;
  /** Longer, honest sentence used in the expected section / detail honesty block. */
  copy: string;
  /** Which section the card sorts into. */
  section: 'confirmed' | 'expected';
  /** Design tone → CSS class suffix (confirmed | info | expected | cancelled | muted). */
  tone: 'confirmed' | 'info' | 'expected' | 'cancelled' | 'muted';
  /** Text/emoji icon paired with colour for accessibility (no colour-only status). */
  icon: string;
}
