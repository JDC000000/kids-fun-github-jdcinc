// app/admin/listings/_lib/vocab.ts — G-T34-3 manual-curation lane: value sets +
// validator for the manual listing-intake form. PURE (no DB) → client-safe + testable.
//
// A manually-entered listing must reproduce the structured shape the ingestion adapters
// emit (worker/core/adapter.ts StructuredRecord → activity_series + activity_occurrence)
// so it renders identically on /search and /preview/[id]. Enforced here + by the DB:
//   • occurrence needs a start datetime OR open-hours (CHECK occurrence_has_time_or_open_hours);
//   • to actually SHOW on /search it must be non-archived AND (open-hours OR a future end/start)
//     AND a non-hidden status_state (manual_candidate lands in the "expected/unverified" lane).
export const COST_STATUSES = ['unknown', 'free', 'known', 'check_source'] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

export const CONFIDENCE_LABELS = ['unscored', 'low', 'medium', 'high'] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

/** Sensible default health for a freshly hand-entered (unverified) listing. */
export const DEFAULT_MANUAL_STATUS_STATE = 'manual_candidate';

export interface ManualListingInput {
  title: string;
  /** Existing source id to attach to; empty string → the canonical Manual Curation source. */
  sourceId: string | null;
  venueName: string | null;
  venueAddress: string | null;
  displayArea: string | null;
  venueLat: number | null;
  venueLng: number | null;
  startDatetimeUtc: string | null; // normalized ISO 8601 (UTC)
  endDatetimeUtc: string | null;
  openHoursState: string | null;
  costStatus: CostStatus;
  costMinCad: number | null;
  costMaxCad: number | null;
  sourceUrl: string | null;
  bookingUrl: string | null;
  locationUrl: string | null;
  descriptionSnippet: string | null;
  statusState: string;
  confidenceLabel: ConfidenceLabel;
}

export type ManualListingFieldErrors = Partial<Record<keyof ManualListingInput, string>>;
export type ParseManualListingResult =
  | { ok: true; value: ManualListingInput }
  | { ok: false; errors: ManualListingFieldErrors };

const MAX_TEXT = 300;
const MAX_SNIPPET = 2000;

/**
 * Normalize a form datetime to a UTC ISO string, or null.
 *  • a bare datetime-local value ('YYYY-MM-DDTHH:MM[:SS]') is interpreted as UTC wall-clock;
 *  • a value already carrying Z / an offset is parsed as-is.
 * Returns the sentinel 'INVALID' when a non-empty value can't be parsed, so the caller
 * can distinguish "absent" (null) from "malformed".
 */
export function normalizeToUtcIso(value: string | undefined): string | null | 'INVALID' {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return null;
  let s = raw;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    s = (s.length === 16 ? `${s}:00` : s) + 'Z';
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'INVALID' : d.toISOString();
}

function optText(v: string | undefined, max = MAX_TEXT): string | null {
  const t = (v ?? '').trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

function parseNumber(v: string | undefined): number | null | 'INVALID' {
  const t = (v ?? '').trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'INVALID';
}

/** Validate the raw manual-listing form into a typed input, or field errors. Pure. */
export function parseManualListingInput(raw: Record<string, string | undefined>): ParseManualListingResult {
  const errors: ManualListingFieldErrors = {};

  const title = (raw.title ?? '').trim();
  if (title.length === 0) errors.title = 'Title is required.';
  else if (title.length > MAX_TEXT) errors.title = `Title must be ${MAX_TEXT} characters or fewer.`;

  const start = normalizeToUtcIso(raw.startDatetimeUtc);
  if (start === 'INVALID') errors.startDatetimeUtc = 'Enter a valid date/time (or leave blank for an open-hours listing).';
  const end = normalizeToUtcIso(raw.endDatetimeUtc);
  if (end === 'INVALID') errors.endDatetimeUtc = 'Enter a valid end date/time or leave it blank.';
  const openHoursState = optText(raw.openHoursState);

  const startIso = start === 'INVALID' ? null : start;
  const endIso = end === 'INVALID' ? null : end;

  // Mirror the DB CHECK: an occurrence needs a start time OR an open-hours string.
  if (!errors.startDatetimeUtc && !startIso && !openHoursState) {
    errors.startDatetimeUtc = 'Provide a start date/time, or an open-hours description below.';
  }
  if (startIso && endIso && new Date(endIso).getTime() < new Date(startIso).getTime()) {
    errors.endDatetimeUtc = 'End must be after start.';
  }

  const costStatus = (raw.costStatus ?? '').trim();
  if (!(COST_STATUSES as readonly string[]).includes(costStatus)) errors.costStatus = 'Choose a cost status.';

  const costMin = parseNumber(raw.costMinCad);
  if (costMin === 'INVALID') errors.costMinCad = 'Enter a number or leave blank.';
  const costMax = parseNumber(raw.costMaxCad);
  if (costMax === 'INVALID') errors.costMaxCad = 'Enter a number or leave blank.';

  const lat = parseNumber(raw.venueLat);
  const lng = parseNumber(raw.venueLng);
  if (lat === 'INVALID') errors.venueLat = 'Latitude must be a number.';
  else if (typeof lat === 'number' && (lat < -90 || lat > 90)) errors.venueLat = 'Latitude must be between -90 and 90.';
  if (lng === 'INVALID') errors.venueLng = 'Longitude must be a number.';
  else if (typeof lng === 'number' && (lng < -180 || lng > 180)) errors.venueLng = 'Longitude must be between -180 and 180.';
  const latNum = typeof lat === 'number' ? lat : null;
  const lngNum = typeof lng === 'number' ? lng : null;
  if ((latNum == null) !== (lngNum == null)) {
    // one provided without the other
    const missing = latNum == null ? 'venueLat' : 'venueLng';
    (errors as Record<string, string>)[missing] = 'Provide both latitude and longitude, or neither.';
  }

  const statusState = (raw.statusState ?? '').trim();
  if (statusState.length === 0) errors.statusState = 'Choose a health state.';

  const confidenceLabel = (raw.confidenceLabel ?? '').trim();
  if (!(CONFIDENCE_LABELS as readonly string[]).includes(confidenceLabel)) errors.confidenceLabel = 'Choose a confidence level.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      title,
      sourceId: optText(raw.sourceId, 64),
      venueName: optText(raw.venueName),
      venueAddress: optText(raw.venueAddress),
      displayArea: optText(raw.displayArea),
      venueLat: latNum,
      venueLng: lngNum,
      startDatetimeUtc: startIso,
      endDatetimeUtc: endIso,
      openHoursState,
      costStatus: costStatus as CostStatus,
      costMinCad: typeof costMin === 'number' ? costMin : null,
      costMaxCad: typeof costMax === 'number' ? costMax : null,
      sourceUrl: optText(raw.sourceUrl, MAX_TEXT),
      bookingUrl: optText(raw.bookingUrl, MAX_TEXT),
      locationUrl: optText(raw.locationUrl, MAX_TEXT),
      descriptionSnippet: optText(raw.descriptionSnippet, MAX_SNIPPET),
      statusState,
      confidenceLabel: confidenceLabel as ConfidenceLabel,
    },
  };
}
