// Fixture-side domain types for the mobile UI shell.
//
// These mirror the canonical `activity_occurrence` fields and enums from TSD v1.2
// §6 (status_state, cost_status) and BR-12, so the shell can be wired to the real
// search/ranking API (Track D) later with minimal reshaping. This is fixture-only
// data — no database, no network, no secrets.

/** Subset of the 16 canonical BR-12 status states that the parent-facing UI renders. */
export type StatusState =
  | 'confirmed'
  | 'bookable_open'
  | 'not_yet_bookable'
  | 'schedule_not_published'
  | 'inferred_recurring'
  | 'seasonal_out_of_season'
  | 'stale'
  | 'cancelled'
  | 'postponed';

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
 * One dated activity occurrence — the unit a parent scans.
 * Field names track TSD §6 `activity_occurrence` where practical.
 */
export interface Activity {
  id: string;
  activityName: string; // e.g. "Public skate"
  venue: string; // e.g. "Trout Lake Rink"
  area: string; // e.g. "Trout Lake"
  driveMinutes: number;
  distanceKm: number;
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
  lastCheckedIso: string; // freshness stamp source of truth
  seasonLabel?: string; // for seasonal_out_of_season copy
  indoor: boolean;
  rainyDay: boolean; // good option when it's raining
  dropIn: boolean;
  descriptionSnippet: string;
  parentNotes: string[]; // stroller/transit/sibling-fit facts
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
