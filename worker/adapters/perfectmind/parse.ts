// worker/adapters/perfectmind/parse.ts — G-T8-4: BookMe4 ClassesV2 → StructuredRecord.
//
// Four things in here are load-bearing and were each verified against real captured
// payloads (worker/adapters/perfectmind/__fixtures__/), not assumed:
//
//  1. TIME. There is no timestamp field. The instant has to be assembled from TWO
//     display fields: `OccurrenceDate` ("20260814", a LOCAL date) and
//     `EventTimeDescription` ("06:00 am - 08:00 am", LOCAL wall clock, no offset), in the
//     tenant's IANA zone. Conversion goes through worker/core/time.ts, which resolves the
//     offset actually in force at the instant — reimplementing DST here would be a second
//     copy of a rule that can rot independently. An end time EARLIER than the start is a
//     midnight-crossing session and rolls to the next day.
//
//  2. COST. `PriceRange` is NOT trustworthy on this platform, and unlike ActiveNet the
//     evidence is total rather than partial. MEASURED on NVRC's Open Gym calendar
//     2026-07-31: 50 of 50 records carry `PriceRange: "No fee"`, and every single one of
//     them has "$3" in its own EventName and "Regular admission fees apply" in its
//     Details. NVRC's own page ships JavaScript that rewrites the rendered
//     `Event price No fee` label into "Regular admission rates apply" — the vendor knows
//     the field is wrong and patches it in the browser. Telling a parent something is
//     free when it is not is this product's worst failure mode, so `PriceRange` alone can
//     NEVER produce 'free' — see classifyCost().
//
//  3. AGE. This platform exposes genuinely STRUCTURED age bounds — `MinAge`,
//     `MinAgeMonths`, `MaxAge`, `MaxAgeMonths`, `NoAgeRestriction` — which is strictly
//     better than the display string `DisplayableRestrictionsForCourses` the scoping pass
//     found, and far better than ActiveNet's free text. resolveAgeText() reads the
//     structured fields FIRST and emits a canonical phrase that T13's existing
//     deterministic normaliser (worker/core/age.ts) resolves exactly. That is deliberate
//     reuse, not a fork: this adapter does not compute month bounds itself, so there is
//     one age convention in the codebase, not two.
//
//  4. IDENTITY. `EventId` is the EVENT (series) id and repeats across dates; `CourseId`
//     likewise. Occurrence identity is EventId + OccurrenceDate + start time + facility.
import type { StructuredRecord } from '../../core/adapter';
import { zonedLocalToUtcIso } from '../../core/time';
import { VENUE_GEO_AUTHORITY, type VenueGeoAuthority } from '../../core/venue-geo-authority';
import type { BookMe4Class, CalendarFetchResult } from './client';
import { calendarPageUrl, type PerfectMindTenantConfig } from './config';

/** Small HTML fragments occasionally appear in Details. */
export function stripHtml(html: string | undefined | null): string {
  return (html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── time ────────────────────────────────────────────────────────────────────────────

/** "20260814" → "2026-08-14". Rejects anything else rather than guessing. */
export function parseOccurrenceDate(raw: string | undefined | null): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((raw ?? '').trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${y}-${mo}-${d}`;
}

/** "06:00 am" / "12:00 pm" → "06:00" / "12:00" (24h). Undefined if unparseable. */
export function parseClockTime(raw: string | undefined | null): string | undefined {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((raw ?? '').trim());
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const meridiem = m[3].toLowerCase();
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface TimeRange {
  start: string;
  end?: string;
}

/** "06:00 am - 08:00 am" → { start: '06:00', end: '08:00' }. A single time with no
 *  range ("06:00 am") yields a start and no end. */
export function parseTimeRange(raw: string | undefined | null): TimeRange | undefined {
  const text = (raw ?? '').trim();
  if (!text) return undefined;
  const [left, right] = text.split(/\s*[-–—]\s*/, 2);
  const start = parseClockTime(left);
  if (!start) return undefined;
  const end = parseClockTime(right);
  return end ? { start, end } : { start };
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export interface InstantPair {
  startDatetimeUtc: string;
  endDatetimeUtc?: string;
}

/**
 * Combine the local date and the local time range into UTC instants.
 *
 * An `end` that is not AFTER `start` means the session crosses midnight
 * ("10:00 pm - 12:30 am"), so the end date rolls forward one day. Comparing the two
 * UTC instants rather than the wall-clock strings is what makes this correct across a
 * DST transition, where a later wall clock can be an earlier instant.
 */
export function toInstants(
  localDate: string,
  range: TimeRange,
  timeZone: string
): InstantPair | undefined {
  const startDatetimeUtc = zonedLocalToUtcIso(`${localDate} ${range.start}:00`, timeZone);
  if (!startDatetimeUtc) return undefined;
  if (!range.end) return { startDatetimeUtc };

  let endDatetimeUtc = zonedLocalToUtcIso(`${localDate} ${range.end}:00`, timeZone);
  if (endDatetimeUtc && Date.parse(endDatetimeUtc) <= Date.parse(startDatetimeUtc)) {
    endDatetimeUtc = zonedLocalToUtcIso(`${addDays(localDate, 1)} ${range.end}:00`, timeZone);
  }
  return { startDatetimeUtc, endDatetimeUtc };
}

// ── cost ────────────────────────────────────────────────────────────────────────────

/** Money is being asked for: an explicit amount, or fee/admission wording. */
const FEE_LANGUAGE_RE =
  /\$\s?\d|\bfees?\s+(?:apply|are|is|per)\b|\badmission\s+(?:fee|rate|price|applies)\b|\bregular\s+admission\b|\bdrop-?in\s+(?:price|rate|fee|cost)\b|\bper\s+child\b|\bpunch\s?card\b|\bpay\s+at\b|\bincluded\s+with\s+(?:a\s+)?(?:monthly\s+)?pass\b/i;

/** Wording that positively asserts no cost. */
const FREE_LANGUAGE_RE = /\bfree\b|\bno\s+charge\b|\bno\s+fee\b|\bcomplimentary\b/i;

/** `PriceRange` as a free marker: "No fee", "Free", "$0.00". */
const FREE_PRICE_TOKEN_RE = /^(?:no\s+fee|free|no\s+charge|n\/?c|\$?\s*0(?:\.00)?)$/i;

/** `PriceRange` as one real amount: "$11.15". */
const SINGLE_PRICE_RE = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*$/;

/** `PriceRange` as a span: "$0.00 - $8.75". */
const PRICE_SPAN_RE = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*[-–—]\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/;

export interface CostVerdict {
  costStatus: NonNullable<StructuredRecord['costStatus']>;
  costMinCad?: number;
  costMaxCad?: number;
  /** Why — surfaced in the coverage report so the distribution is explainable. */
  reason: string;
}

/**
 * Honest cost classification.
 *
 * Precedence, and why:
 *   1. FEE LANGUAGE ANYWHERE (EventName, Details, PriceRange) wins over everything, and
 *      can never yield 'free'. This is the rule that catches the measured 50/50
 *      "PriceRange: No fee" + "$3 Open Gym" + "Regular admission fees apply"
 *      contradiction. It is checked FIRST, not last, because on this platform the price
 *      field being wrong is the norm rather than the exception. If the text also carries
 *      a parseable amount we report it as 'known' with that amount; otherwise
 *      'check_source'.
 *   2. A real amount or span in `PriceRange` with NO fee language → 'known'.
 *   3. 'free' requires TWO independent corroborating signals from
 *      {PriceRange is a free token, free wording in EventName/Details}, AND no fee
 *      language. One signal alone — including the price field alone — is
 *      'check_source', because one signal is exactly what was measured to be wrong
 *      100% of the time on the calendar we sampled.
 *   4. Any other non-empty price string → 'check_source'. Never coerced to 0.
 *   5. Nothing to go on → 'unknown'.
 */
export function classifyCost(record: BookMe4Class): CostVerdict {
  const priceRange = String(record.PriceRange ?? '').trim();
  const prose = `${record.EventName ?? ''} ${stripHtml(record.Details)}`;
  const allText = `${prose} ${priceRange}`;

  const span = PRICE_SPAN_RE.exec(priceRange);
  const single = SINGLE_PRICE_RE.exec(priceRange);
  const amounts: number[] | undefined = span
    ? [Number(span[1]), Number(span[2])]
    : single
      ? [Number(single[1])]
      : undefined;

  const feeLanguage = FEE_LANGUAGE_RE.test(allText);

  if (feeLanguage) {
    // A price field that reads free is contradicted by the text — trust the text.
    if (amounts && Math.max(...amounts) > 0) {
      return {
        costStatus: 'known',
        costMinCad: Math.min(...amounts),
        costMaxCad: Math.max(...amounts),
        reason: 'fee language corroborated by a priced range',
      };
    }
    // The commonest real case: EventName says "$3", PriceRange says "No fee".
    const inline = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(prose);
    if (inline) {
      const amount = Number(inline[1]);
      return {
        costStatus: 'known',
        costMinCad: amount,
        costMaxCad: amount,
        reason: `fee language with an inline amount in the listing text (price field said "${priceRange || 'nothing'}")`,
      };
    }
    return {
      costStatus: 'check_source',
      reason: `fee language present — price field "${priceRange || 'unset'}" not trusted`,
    };
  }

  if (amounts) {
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (max === 0) {
      // A genuine $0 price field with no fee language anywhere. Still needs the
      // two-signal rule below rather than short-circuiting to 'free'.
    } else {
      return { costStatus: 'known', costMinCad: min, costMaxCad: max, reason: 'PriceRange amount' };
    }
  }

  const signals = [FREE_PRICE_TOKEN_RE.test(priceRange), FREE_LANGUAGE_RE.test(prose)].filter(
    Boolean
  ).length;

  if (signals >= 2) {
    return { costStatus: 'free', costMinCad: 0, costMaxCad: 0, reason: '2 corroborating free signals' };
  }
  if (signals === 1) {
    return { costStatus: 'check_source', reason: 'single uncorroborated free signal' };
  }
  if (priceRange) {
    return { costStatus: 'check_source', reason: `unparseable price string: ${priceRange}` };
  }
  return { costStatus: 'unknown', reason: 'no price signal' };
}

// ── age ─────────────────────────────────────────────────────────────────────────────

export interface AgeVerdict {
  /** Canonical phrase handed to T13's parseAgeText(). Undefined when nothing is known. */
  ageText?: string;
  /** True when it came from the STRUCTURED fields rather than a display string. */
  deterministic: boolean;
  reason: string;
}

/** "Age: 8+" / "Age: 5 to 12" / "Age: 12 to 17 y 11m" — the display string, used only
 *  when the structured fields are unusable. */
const DISPLAY_AGE_RE = /^\s*age\s*:\s*(.+?)\s*$/i;

/**
 * Resolve age deterministically from the STRUCTURED fields, emitting a canonical phrase
 * that worker/core/age.ts resolves exactly.
 *
 * Why a phrase and not month bounds: `StructuredRecord` carries `ageText` only, and the
 * ingest pipeline runs `parseAgeText()` over it to produce `occurrence_age`. Emitting
 * bounds here would mean forking T13's inclusive-min / exclusive-max convention into a
 * second place. Emitting a canonical PHRASE keeps one convention and still makes the
 * result deterministic, because the phrase is generated from numbers, not scraped.
 *
 * Vendor quirks handled, all measured on 2026-07-31:
 *   • `NoAgeRestriction: true` → "All ages".
 *   • `MinAgeMonths` is an ADDITIONAL months component, not a substitute:
 *     `MinAge: 7, MinAgeMonths: 12` renders as "7 y 12m", i.e. 8 years. Normalised.
 *   • `MaxAge: 0, MaxAgeMonths: 0` is the vendor's "no maximum" (it renders as the
 *     nonsense "7 y 12m to 0"), NOT a maximum of zero. Treated as open-ended.
 *   • A max that is not greater than the min is incoherent → treated as open-ended
 *     rather than emitting an inverted range T13 would silently drop.
 */
export function resolveAgeText(record: BookMe4Class): AgeVerdict {
  if (record.NoAgeRestriction === true) {
    return { ageText: 'All ages', deterministic: true, reason: 'NoAgeRestriction' };
  }

  const minYears = typeof record.MinAge === 'number' ? record.MinAge : null;
  const minExtraMonths = typeof record.MinAgeMonths === 'number' ? record.MinAgeMonths : 0;
  const maxYears = typeof record.MaxAge === 'number' ? record.MaxAge : null;
  const maxExtraMonths = typeof record.MaxAgeMonths === 'number' ? record.MaxAgeMonths : 0;

  if (minYears != null || maxYears != null) {
    // Normalise the "N y 12m" form the vendor emits into whole years.
    const minTotalYears = minYears != null ? Math.floor(minYears + minExtraMonths / 12) : null;
    const maxOpenEnded = maxYears == null || (maxYears === 0 && maxExtraMonths === 0);
    // The vendor's max is inclusive of the stated point ("17 y 11m" means "under 18"),
    // and T13's "A-B" convention already includes B-year-olds, so the whole-year floor
    // is the right hand-off: 17y11m → 17 → T13 gives an exclusive max of 18 years.
    const maxTotalYears = maxOpenEnded ? null : Math.floor(maxYears! + maxExtraMonths / 12);

    if (minTotalYears != null && maxTotalYears != null && maxTotalYears >= minTotalYears) {
      return {
        ageText: `ages ${minTotalYears}-${maxTotalYears}`,
        deterministic: true,
        reason: 'structured MinAge/MaxAge',
      };
    }
    if (minTotalYears != null) {
      return {
        ageText: `ages ${minTotalYears} years and up`,
        deterministic: true,
        reason: maxTotalYears == null ? 'structured MinAge, no maximum' : 'structured MinAge (incoherent maximum ignored)',
      };
    }
    if (maxTotalYears != null) {
      return { ageText: `under ${maxTotalYears + 1}`, deterministic: true, reason: 'structured MaxAge only' };
    }
  }

  // Structured fields unusable — fall back to the display string, then to raw text, both
  // of which T13's deterministic rules handle (and its LLM fallback picks up if not).
  const display = String(record.DisplayableRestrictionsForCourses ?? '').trim();
  const stripped = DISPLAY_AGE_RE.exec(display)?.[1];
  if (stripped) {
    return { ageText: `ages ${stripped}`, deterministic: false, reason: 'DisplayableRestrictionsForCourses' };
  }
  const restrictions = String(record.AgeRestrictions ?? '').trim();
  if (restrictions) {
    return { ageText: `ages ${restrictions}`, deterministic: false, reason: 'AgeRestrictions' };
  }
  return { deterministic: false, reason: 'no age signal' };
}

// ── category ────────────────────────────────────────────────────────────────────────

/** Calendar names are a clean, structured category signal on this platform. Only
 *  unambiguous mappings; anything else is left undefined so worker/core/taxonomy.ts runs
 *  its own title rules (deterministic-first, no fork). */
const CALENDAR_CATEGORY_RULES: Array<{ re: RegExp; key: string }> = [
  { re: /swim/i, key: 'public_swim' },
  { re: /skat(?:e|ing)/i, key: 'skate' },
  { re: /open\s+gym/i, key: 'open_gym' },
  { re: /indoor\s+play|playtime|play\s+palace|parent\s+(?:and|&)\s+tot/i, key: 'indoor_play' },
];

export function categoryHintForCalendar(calendarName: string | undefined): string | undefined {
  if (!calendarName) return undefined;
  return CALENDAR_CATEGORY_RULES.find((r) => r.re.test(calendarName))?.key;
}

// ── venue ───────────────────────────────────────────────────────────────────────────

export interface VenueFields {
  venueName?: string;
  venueAddress?: string;
  venueLat?: number;
  venueLng?: number;
  venueGeoAuthority?: VenueGeoAuthority;
  venueGeoSource?: string;
}

/** Venue comes straight off the record — this platform ships an address WITH
 *  coordinates inline, so unlike ActiveNet there is no second lookup call to make. */
export function extractVenue(record: BookMe4Class): VenueFields {
  const address = record.Address ?? undefined;
  const venueName =
    (address?.AddressTag ?? '').trim() || (record.Location ?? '').trim() || undefined;
  const street = (address?.Street ?? '').trim();
  const city = (address?.City ?? '').trim();
  const postal = (address?.PostalCode ?? '').trim();
  const parts = [street, city, postal].filter(Boolean);
  const lat = typeof address?.Latitude === 'number' ? address.Latitude : undefined;
  const lng = typeof address?.Longitude === 'number' ? address.Longitude : undefined;
  return {
    venueName,
    venueAddress: parts.length ? parts.join(', ') : undefined,
    // (0,0) is the vendor's "unset", not the Gulf of Guinea.
    venueLat: lat && lng ? lat : undefined,
    venueLng: lat && lng ? lng : undefined,
    // LIVE VENDOR PAYLOAD — the lowest declared tier. This coordinate is read out of the
    // feed's own `Address` block on every single run: there is no committed value to diff
    // it against, no review, and no alarm if the vendor moves the point. A silently-moving
    // coordinate is a strictly worse failure mode than a stale one, which is why it ranks
    // below every curated source rather than above them for being "fresher".
    venueGeoAuthority: lat && lng ? VENUE_GEO_AUTHORITY.LIVE_VENDOR_PAYLOAD : undefined,
    venueGeoSource: lat && lng ? 'perfectmind:feed-address' : undefined,
  };
}

// ── occurrence identity ─────────────────────────────────────────────────────────────

export function occurrenceRecordId(record: BookMe4Class, startTime: string | undefined): string {
  const facility = (record.Facility ?? '').trim().replace(/\s+/g, '-') || 'nofac';
  return [
    record.EventId || record.CourseId || 'noid',
    (record.OccurrenceDate ?? '').replace(/[^0-9]/g, '') || 'nodate',
    (startTime ?? 'notime').replace(':', ''),
    facility,
  ].join(':');
}

// ── the parse ───────────────────────────────────────────────────────────────────────

/** Facility-closure notices are published as events on rec platforms. They are not
 *  activities and must not be listed as such. COUNTED rather than silently dropped. */
const CLOSURE_TITLE_RE = /^\s*(?:closed|cancell?ed)\b|\bcancell?ed\s*$/i;

export interface ParseOptions {
  /** Client-side date window (inclusive, YYYY-MM-DD LOCAL). The vendor's `dateString`
   *  parameter is measured to be ignored server-side, so windowing is entirely ours. */
  window?: { startDate: string; endDate: string };
}

export interface ParseResult {
  records: StructuredRecord[];
  /** Honest per-run accounting — feeds the coverage report and health check. */
  stats: {
    classesSeen: number;
    recordsEmitted: number;
    skippedClosures: number;
    skippedOutsideWindow: number;
    skippedAllDay: number;
    skippedUnparseableDate: number;
    skippedUnparseableTime: number;
    costStatusCounts: Record<string, number>;
    ageDeterministic: number;
    ageFromDisplayText: number;
    ageUnresolved: number;
    venueWithCoordinates: number;
  };
  warnings: string[];
}

export function emptyStats(): ParseResult['stats'] {
  return {
    classesSeen: 0,
    recordsEmitted: 0,
    skippedClosures: 0,
    skippedOutsideWindow: 0,
    skippedAllDay: 0,
    skippedUnparseableDate: 0,
    skippedUnparseableTime: 0,
    costStatusCounts: { free: 0, known: 0, check_source: 0, unknown: 0 },
    ageDeterministic: 0,
    ageFromDisplayText: 0,
    ageUnresolved: 0,
    venueWithCoordinates: 0,
  };
}

function parseCalendar(
  tenant: PerfectMindTenantConfig,
  calendar: CalendarFetchResult,
  opts: ParseOptions,
  stats: ParseResult['stats'],
  warnings: string[]
): StructuredRecord[] {
  const records: StructuredRecord[] = [];
  const categoryHint = categoryHintForCalendar(calendar.calendarName);
  const sourceUrl = calendarPageUrl(tenant, calendar.calendarId);

  for (const cls of calendar.classes) {
    stats.classesSeen += 1;

    const title = (cls.EventName ?? '').trim();
    if (CLOSURE_TITLE_RE.test(title)) {
      stats.skippedClosures += 1;
      continue;
    }

    const localDate = parseOccurrenceDate(cls.OccurrenceDate);
    if (!localDate) {
      stats.skippedUnparseableDate += 1;
      warnings.push(`calendar "${calendar.calendarName}": unparseable OccurrenceDate "${cls.OccurrenceDate ?? ''}"`);
      continue;
    }
    if (opts.window && (localDate < opts.window.startDate || localDate > opts.window.endDate)) {
      stats.skippedOutsideWindow += 1;
      continue;
    }

    if (cls.AllDayEvent === true) {
      // An all-day marker has no meaningful start time; listing it at midnight would be
      // an invention. Counted so the coverage report can show how many there were.
      stats.skippedAllDay += 1;
      continue;
    }

    const range = parseTimeRange(cls.EventTimeDescription);
    if (!range) {
      stats.skippedUnparseableTime += 1;
      warnings.push(
        `calendar "${calendar.calendarName}": unparseable EventTimeDescription "${cls.EventTimeDescription ?? ''}"`
      );
      continue;
    }
    const instants = toInstants(localDate, range, tenant.timezone);
    if (!instants) {
      stats.skippedUnparseableTime += 1;
      warnings.push(`calendar "${calendar.calendarName}": could not build an instant for ${localDate} ${range.start}`);
      continue;
    }

    const cost = classifyCost(cls);
    stats.costStatusCounts[cost.costStatus] = (stats.costStatusCounts[cost.costStatus] ?? 0) + 1;

    const age = resolveAgeText(cls);
    if (age.deterministic) stats.ageDeterministic += 1;
    else if (age.ageText) stats.ageFromDisplayText += 1;
    else stats.ageUnresolved += 1;

    const venue = extractVenue(cls);
    if (venue.venueLat != null) stats.venueWithCoordinates += 1;

    records.push({
      sourceRecordId: occurrenceRecordId(cls, range.start),
      title: title || 'Drop-in activity',
      venueName: venue.venueName,
      venueAddress: venue.venueAddress,
      venueLat: venue.venueLat,
      venueLng: venue.venueLng,
      venueGeoAuthority: venue.venueGeoAuthority,
      venueGeoSource: venue.venueGeoSource,
      venueMunicipalityName: venue.venueName ? tenant.municipality : undefined,
      startDatetimeUtc: instants.startDatetimeUtc,
      endDatetimeUtc: instants.endDatetimeUtc,
      costMinCad: cost.costMinCad,
      costMaxCad: cost.costMaxCad,
      costStatus: cost.costStatus,
      ageText: age.ageText,
      categoryHint,
      sourceUrl,
      raw: cls,
    });
    stats.recordsEmitted += 1;
  }
  return records;
}

/** Parse one tenant's fetched calendars into canonical records. */
export function parseTenantCalendars(
  tenant: PerfectMindTenantConfig,
  calendars: CalendarFetchResult[],
  opts: ParseOptions = {}
): ParseResult {
  const stats = emptyStats();
  const warnings: string[] = [];
  const records: StructuredRecord[] = [];

  for (const calendar of calendars) {
    records.push(...parseCalendar(tenant, calendar, opts, stats, warnings));
    if (calendar.occurrenceCount === 0) {
      // Reported as data, not absence — a calendar that returns nothing is a finding.
      warnings.push(`calendar "${calendar.calendarName}" returned zero occurrences`);
    }
  }

  return { records, stats, warnings };
}
