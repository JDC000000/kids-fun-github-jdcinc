import type { ListingRecord } from '@/lib/search/types';
import type { Activity, BookingType, Category, ConfidenceLabel, CostStatus, StatusState, TimeOfDay } from './types';

export interface ListingRecordDto {
  id: string;
  activityName: string;
  primaryCategoryKey: string;
  categoryTags?: string[];
  venueName: string;
  organisation: string | null;
  descriptionSnippet: string;
  suitabilityTags?: string[];
  startDatetimeUtc: string | null;
  endDatetimeUtc: string | null;
  costStatus: 'known' | 'free' | 'unknown' | 'check_source';
  costMinCad: number | null;
  costMaxCad: number | null;
  statusState: string;
  confidenceLabel: string;
  lastCheckedAtUtc: string | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes?: string | null;
  geo: { lat: number; lng: number } | null;
  displayArea: string | null;
  neighbourhood: string | null;
  municipalityId: string | null;
  /** venue.phone, verbatim. Optional here because most source families never populate it. */
  venuePhone?: string | null;
  sourceUrl: string | null;
  bookingUrl: string | null;
  locationUrl: string | null;
}

export interface SearchItemDto {
  listing: ListingRecordDto;
  distanceKm: number | null;
}

export interface SearchResponseDto {
  results: SearchItemDto[];
  expected: SearchItemDto[];
  meta: { fixtureBacked: boolean; sort: string; backend?: 'fixture' | 'database'; fallbackReason?: string };
}

const EAST_VAN = { lat: 49.26, lng: -123.07 };

export function searchApiUrl(): string {
  const params = new URLSearchParams({
    q: '',
    includeUnknownCost: '1',
    minResults: '100',
    limit: '100',
  });
  return `/api/search?${params.toString()}`;
}

export function mapSearchResponseToActivities(response: SearchResponseDto): Activity[] {
  const seen = new Set<string>();
  return [...response.results, ...response.expected]
    .filter((item) => {
      if (seen.has(item.listing.id)) return false;
      seen.add(item.listing.id);
      return true;
    })
    .map(mapSearchItemToActivity);
}

export function mapListingRecordToActivity(listing: ListingRecord, distanceKm: number | null = null): Activity {
  return mapSearchItemToActivity({ listing, distanceKm });
}

export function mapSearchItemToActivity(item: SearchItemDto): Activity {
  const l = item.listing;
  const startIso = l.startDatetimeUtc ?? new Date().toISOString();
  const endIso = l.endDatetimeUtc ?? l.startDatetimeUtc ?? startIso;
  const distanceKm = item.distanceKm ?? (l.geo ? distance(EAST_VAN, l.geo) : 0);
  const tags = new Set([...(l.suitabilityTags ?? []), ...(l.categoryTags ?? [])]);
  const sourceUrl = l.sourceUrl ?? '#';
  return {
    id: l.id,
    activityName: l.activityName,
    venue: l.venueName,
    area: labelArea(l),
    driveMinutes: Math.max(4, Math.round(distanceKm * 4)),
    distanceKm,
    category: mapCategory(l.primaryCategoryKey),
    ageMin: monthsToMinYears(l.ageMinMonths),
    ageMax: monthsToMaxYears(l.ageMaxMonths),
    startIso,
    endIso,
    timeOfDay: timeOfDay(startIso),
    costStatus: mapCost(l.costStatus),
    ...(l.costMinCad != null ? { costMinCad: l.costMinCad } : {}),
    ...(l.costMaxCad != null ? { costMaxCad: l.costMaxCad } : {}),
    status: mapStatus(l.statusState),
    booking: mapBooking(l.statusState, l.bookingUrl, tags),
    confidence: mapConfidence(l.confidenceLabel),
    sourceName: hostLabel(sourceUrl),
    sourceUrl,
    ...(l.bookingUrl ? { bookingUrl: l.bookingUrl } : {}),
    ...(l.locationUrl ? { locationUrl: l.locationUrl } : {}),
    ...(l.venuePhone ? { venuePhone: l.venuePhone } : {}),
    lastCheckedIso: l.lastCheckedAtUtc ?? new Date().toISOString(),
    indoor: tags.has('indoor') || ['open_gym', 'public_swim', 'skate', 'storytime', 'indoor_play'].includes(l.primaryCategoryKey),
    rainyDay: tags.has('rainy_day') || tags.has('indoor') || ['open_gym', 'public_swim', 'skate', 'storytime', 'indoor_play'].includes(l.primaryCategoryKey),
    dropIn: tags.has('drop_in'),
    descriptionSnippet: l.descriptionSnippet || `${l.activityName} at ${l.venueName}.`,
    parentNotes: [`Source: ${hostLabel(sourceUrl)}`, `Status: ${mapStatus(l.statusState).replaceAll('_', ' ')}`],
    ...(l.ageNotes ? { ageNotes: l.ageNotes } : {}),
  };
}

function labelArea(l: ListingRecordDto): string {
  // BUG-008: never fall back to the raw municipalityId — it is an opaque UUID, not a
  // human area name. When neighbourhood and displayArea are both absent, go straight
  // to the generic 'Metro Vancouver' rather than rendering a database id on the card.
  return l.neighbourhood ?? l.displayArea ?? 'Metro Vancouver';
}

function mapCategory(key: string): Category {
  if (key === 'public_swim') return 'swim';
  if (key === 'skate') return 'skate';
  if (key === 'open_gym') return 'open_gym';
  if (key === 'storytime') return 'storytime';
  if (key === 'indoor_play') return 'indoor_play';
  if (key === 'nature') return 'nature';
  if (key === 'festival') return 'festival';
  return 'museum_arts';
}

function mapCost(status: ListingRecordDto['costStatus']): CostStatus {
  if (status === 'free') return 'free';
  if (status === 'known') return 'known';
  return 'unknown';
}

/** The 16 canonical BR-12 status_state values (TSD §6.2), kept in sync with StatusState. */
const CANONICAL_STATUS: ReadonlySet<StatusState> = new Set<StatusState>([
  'confirmed',
  'bookable_open',
  'not_yet_bookable',
  'schedule_not_published',
  'inferred_recurring',
  'manual_candidate',
  'seasonal_out_of_season',
  'seasonal_preseason',
  'seasonal_active',
  'suspended',
  'stale',
  'cancelled',
  'postponed',
  'full',
  'waitlist',
  'needs_review',
]);

/**
 * Pass a canonical status through verbatim so the UI can render its true, honest copy
 * (see statusMeta). Previously this COLLAPSED distinct states into approximations —
 * full/waitlist → "Opens soon", seasonal_active/preseason → "Usually weekly",
 * manual_candidate → "Not posted yet" — which overstated availability and violated the
 * confirmed/expected honesty rule (UXR-06 / T-07). Any unexpected string degrades to
 * `needs_review` ("Unverified — check the source"), never to a confirmed-looking state.
 */
function mapStatus(status: string): StatusState {
  return CANONICAL_STATUS.has(status as StatusState) ? (status as StatusState) : 'needs_review';
}

/**
 * Statuses that must never present a book / register / drop-in affordance, because the
 * spot is not actually open (full, waitlist, suspended, cancelled, postponed) or the
 * listing itself is unverified/out of season. The source CTA still remains the authority
 * on the detail page (Appendix C) — this only suppresses the misleading card chip.
 */
const NON_BOOKABLE_STATUSES: ReadonlySet<StatusState> = new Set<StatusState>([
  'full',
  'waitlist',
  'suspended',
  'cancelled',
  'postponed',
  'seasonal_out_of_season',
  'seasonal_preseason',
  'manual_candidate',
  'needs_review',
]);

function mapBooking(status: string, bookingUrl: string | null, tags: Set<string>): BookingType {
  if (status === 'bookable_open') return 'bookable_now';
  if (NON_BOOKABLE_STATUSES.has(mapStatus(status))) return 'none';
  if (tags.has('drop_in')) return 'drop_in';
  if (bookingUrl) return 'registration';
  return 'none';
}

function mapConfidence(confidence: string): ConfidenceLabel {
  if (confidence === 'official_recent') return 'confirmed';
  if (confidence === 'official') return 'official';
  if (confidence === 'editorial') return 'editorial';
  return 'candidate';
}

function monthsToMinYears(months: number | null): number {
  if (months == null) return 0;
  return Math.max(0, Math.floor(months / 12));
}

function monthsToMaxYears(months: number | null): number {
  if (months == null) return 18;
  return Math.max(0, Math.floor(Math.max(0, months - 1) / 12));
}

function timeOfDay(iso: string): TimeOfDay {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hour12: false }).format(new Date(iso)));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'fixture source';
  }
}

function distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}
