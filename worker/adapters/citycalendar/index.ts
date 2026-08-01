// worker/adapters/citycalendar/index.ts — KIDS FUN Task 9: city / parks public
// calendar adapter (TSD §5.1 Adapter C, family `city_calendar`).
//
// Live path = a municipality's PUBLIC calendar-syndication feed. The launch
// tenant is the City of Vancouver events calendar (Trumba JSON feed), whose
// items carry Park Board / community-centre / pool / park programming — the
// recreation-adjacent coverage KIDS FUN had none of. The feed is a single
// plain GET: no login, no CSRF, no session, no CAPTCHA, no headless render —
// exactly the profile that made the library RSS feeds tractable. Trumba
// publishes these feeds for "calendar subscriptions or custom publishing of
// events" and trumba.com/robots.txt allows all robots (Task 9 findings).
//
// Default mode is fixture-only; the live path is gated behind BOTH the DB terms
// gate (source terms_status='allowed' + robots_status='allowed') AND the
// env allow-list KIDS_FUN_LIVE_CITY_CALENDARS=<calendarKey>.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { politeFetch } from '../../health/policy';
import { VENUE_GEO_AUTHORITY } from '../../core/venue-geo-authority';
import { CITY_CALENDARS, getCityCalendar, type CityCalendarConfig, type CityCalendarVenueGeo } from './config';

const DEFAULT_LIMIT = 40;

/** One Trumba published-calendar JSON event (fields we consume). */
interface TrumbaEvent {
  eventID: number | string;
  seriesID?: number | string | null;
  title: string;
  description?: string;
  location?: string; // HTML anchor: <a href="http://maps.google.com/?q=<addr>">Venue, addr</a>
  locationType?: string; // 'In-Person' | null (online / unspecified)
  startDateTime?: string; // local, e.g. '2026-07-14T10:00:00'
  endDateTime?: string;
  startTimeZoneOffset?: string; // e.g. '-0700'
  endTimeZoneOffset?: string;
  allDay?: boolean;
  canceled?: boolean;
  requiresPayment?: boolean;
  permaLinkUrl?: string;
  webLink?: string;
  eventActionUrl?: string;
  customFields?: Array<{ fieldID?: number; label?: string; value?: string; type?: string }>;
}

function liveEnabledFor(calendarKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_CITY_CALENDARS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(calendarKey.toLowerCase());
}

function decodeEntities(value = ''): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#8482;|&trade;/g, '™')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trumba offsets are '-0700'; normalise to ISO '-07:00' so Date parses reliably. */
function normalizeOffset(offset?: string): string {
  if (!offset) return 'Z';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!m) return offset.includes(':') ? offset : 'Z';
  return `${m[1]}${m[2]}:${m[3]}`;
}

function toUtcIso(local?: string, offset?: string): string | undefined {
  if (!local) return undefined;
  const iso = `${local}${normalizeOffset(offset)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Decode a Google-Maps `?q=<address>` link into a plain address string. */
function addressFromMapsHref(href?: string): string | undefined {
  if (!href) return undefined;
  const q = /[?&]q=([^&]+)/.exec(href)?.[1];
  if (!q) return undefined;
  try {
    return decodeURIComponent(q.replace(/\+/g, ' ')).replace(/,\s*Canada\s*$/i, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

interface ParsedLocation {
  venueName?: string;
  venueAddress?: string;
  locationUrl?: string;
}

/** Inner markup of the location anchor (falls back to the raw string if no <a>). */
function anchorInner(html: string): string {
  return /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? html;
}

function parseLocation(html?: string): ParsedLocation {
  if (!html) return {};
  const href = /href="([^"]+)"/i.exec(html)?.[1];
  const addressFromLink = addressFromMapsHref(href);

  // The Trumba location anchor frequently puts the venue name and the street
  // address on SEPARATE LINES joined by <br>, e.g.
  //   "Chinatown Storytelling Centre<br />168 E Pender St, Vancouver"
  //   "City Hall<br />Vancouver City Hall<br />453 W 12th Ave, Vancouver, BC".
  // Split on <br> FIRST so the street number can never glue onto the venue name
  // (which polluted venue rows, fragmented series identity, and blocked the
  // deterministic geo-map lookup). The venue label is the first line; the full
  // address comes from the maps link (or the whole anchor text as a fallback).
  const inner = anchorInner(html);
  const firstLine = decodeEntities(inner.split(/<br\s*\/?>/i)[0]).replace(/,\s*$/, '').trim();
  const fullText = decodeEntities(inner).replace(/,\s*$/, '').trim();
  if (!firstLine && !addressFromLink) return {};

  // Within the first line, still drop a trailing inline address ("Renfrew Pool,
  // 2929 East 22nd Ave, …" / "Connaught Park - 2690 Larch Street") to keep just
  // the venue label.
  const venueName = (firstLine.split(/\s*,\s*|\s+-\s+/)[0] || firstLine).trim() || undefined;
  const locationUrl = href && /^https?:\/\//i.test(href) ? href : undefined;
  return {
    venueName,
    venueAddress: addressFromLink ?? (fullText || undefined),
    locationUrl,
  };
}

/** Case/punctuation/whitespace-insensitive key for deterministic geo matching. */
function normalizeVenueKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolve deterministic venue geo tolerant of punctuation/casing/spacing variants
 * (e.g. "Killarney Community Centre" vs "killarney  community centre"). Exact keys
 * still win; the normalized index is a safety net so a real venue is not missed —
 * and, unlike a geocoder, it only ever attaches coordinates already vetted in
 * config, so it cannot mis-locate an event.
 */
function lookupVenueGeo(
  config: CityCalendarConfig,
  venueName?: string
): CityCalendarVenueGeo | undefined {
  if (!venueName || !config.venueGeo) return undefined;
  const direct = config.venueGeo[venueName.toLowerCase().trim()];
  if (direct) return direct;
  const want = normalizeVenueKey(venueName);
  for (const [key, geo] of Object.entries(config.venueGeo)) {
    if (normalizeVenueKey(key) === want) return geo;
  }
  return undefined;
}

/** Structured custom-field value by (case-insensitive) label. */
function customField(event: TrumbaEvent, label: string): string | undefined {
  const field = (event.customFields ?? []).find(
    (f) => (f.label ?? '').trim().toLowerCase() === label.toLowerCase()
  );
  const value = field?.value ? decodeEntities(field.value).trim() : '';
  return value || undefined;
}

/**
 * A specific, searchable neighbourhood from the feed's structured "Neighbourhoods"
 * custom field — skipping citywide / non-specific values that aren't an "area".
 * Used to give unmapped venues a display area they otherwise wouldn't have.
 */
function specificNeighbourhood(event: TrumbaEvent): string | undefined {
  const raw = customField(event, 'Neighbourhoods');
  if (!raw) return undefined;
  const first = raw.split(/\s*[;,]\s*/)[0]?.trim();
  if (!first || /^(all of vancouver|citywide|various|multiple|city[-\s]?wide)$/i.test(first)) {
    return undefined;
  }
  return first;
}

function eventTypeValue(event: TrumbaEvent): string | undefined {
  const field = (event.customFields ?? []).find((f) => (f.label ?? '').toLowerCase() === 'event type');
  return field?.value ? decodeEntities(field.value).toLowerCase() : undefined;
}

// Map to a valid primary-category key ONLY when the signal is unambiguous;
// otherwise leave undefined so taxonomy.classifyPrimaryCategory() runs its
// title-keyword pass (swim / skate / park / open_gym / storytime / …).
function categoryHint(event: TrumbaEvent): string | undefined {
  const title = decodeEntities(event.title).toLowerCase();
  const type = eventTypeValue(event) ?? '';
  if (/swim|pool|aquatic/.test(title)) return 'public_swim';
  if (/skat(e|ing)|rink/.test(title)) return 'skate';
  if (/open\s*gym|gymnasium/.test(title)) return 'open_gym';
  if (/story\s*time|babytime/.test(title)) return 'storytime';
  if (/festival|celebration/.test(type) || /festival/.test(title)) return 'festival_event';
  if (/\bpark\b|music in the park/.test(title)) return 'outdoor_park';
  return undefined;
}

const AGE_HINT_RE =
  /(?:for\s+)?(?:kids|children|families|family|all\s+ages|youth|teens?|tweens?|toddlers?|babies|baby|preschool(?:ers)?|seniors?|adults?)[^.<\n]{0,30}/i;

function ageText(event: TrumbaEvent): string | undefined {
  // Prefer the feed's STRUCTURED "Audiences" custom field ("All ages", "Families",
  // "Children", "Preschoolers", "Youth", …) over a prose keyword scan. It is a
  // clean, unambiguous token that worker/core/age.ts resolves into an age band
  // accurately, avoiding the misfires a 30-char description window produces
  // (e.g. "kids" inside "Kids' Place desk for a chance to win").
  const audience = customField(event, 'Audiences');
  if (audience) return audience;
  const hay = `${decodeEntities(event.title)} ${decodeEntities(event.description ?? '')}`;
  const m = AGE_HINT_RE.exec(hay);
  return m ? m[0].trim() : undefined;
}

export class CityCalendarAdapter implements Adapter {
  readonly family = 'city_calendar';

  constructor(private readonly config: CityCalendarConfig) {}

  isLiveFetchEnabled(): boolean {
    return liveEnabledFor(this.config.calendarKey);
  }

  async fetch(): Promise<unknown[]> {
    if (this.isLiveFetchEnabled()) {
      return fetchTrumbaFeed(this.config);
    }
    // Synthetic fixture (no live request). Shape only.
    const fixture: TrumbaEvent = {
      eventID: `${this.config.calendarKey}-fixture-1`,
      title: 'Free Family Swim',
      description: 'Drop-in family swim for all ages at the community pool.',
      location: '<a href="http://maps.google.com/?q=Renfrew+Pool%2C+Vancouver%2C+BC">Renfrew Pool, Vancouver, BC</a>',
      locationType: 'In-Person',
      startDateTime: '2026-07-15T15:00:00',
      endDateTime: '2026-07-15T16:30:00',
      startTimeZoneOffset: '-0700',
      endTimeZoneOffset: '-0700',
      allDay: false,
      canceled: false,
      requiresPayment: false,
      permaLinkUrl: `${this.config.calendarUrl}#${this.config.calendarKey}-fixture-1`,
    };
    return [fixture];
  }

  extract(raw: unknown[]): StructuredRecord[] {
    return (raw as TrumbaEvent[])
      .filter((e) => e && !e.canceled && e.title && e.startDateTime)
      .map((e) => {
        const loc = parseLocation(e.location);
        const geo = lookupVenueGeo(this.config, loc.venueName);
        const requiresPayment = e.requiresPayment === true;
        return {
          sourceRecordId: String(e.eventID),
          title: decodeEntities(e.title),
          venueName: loc.venueName,
          venueAddress: geo?.address ?? loc.venueAddress,
          venueLat: geo?.lat,
          venueLng: geo?.lng,
          // Curated by a human, but with no per-entry provenance and no recorded
          // measurement to audit it against — so it ranks below both of activenet's tiers.
          // That is what settles the four venues the two families share (Killarney,
          // Kitsilano, Renfrew Park, Trout Lake, up to ~802 m apart) permanently onto
          // venue-geo.ts's measured-better values instead of onto whichever cron ran last.
          venueGeoAuthority: geo ? VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL : undefined,
          venueGeoSource: geo ? `citycalendar:${this.config.calendarKey}:config` : undefined,
          venueMunicipalityName: loc.venueName ? this.config.municipality : undefined,
          // Curated geo-map display area wins; otherwise fall back to the feed's
          // structured neighbourhood so unmapped venues still get a searchable area.
          venueDisplayArea: geo?.displayArea ?? specificNeighbourhood(e),
          startDatetimeUtc: toUtcIso(e.startDateTime, e.startTimeZoneOffset),
          endDatetimeUtc: toUtcIso(e.endDateTime, e.endTimeZoneOffset),
          costMinCad: requiresPayment ? undefined : 0,
          costMaxCad: requiresPayment ? undefined : 0,
          costStatus: requiresPayment ? ('check_source' as const) : ('free' as const),
          ageText: ageText(e),
          categoryHint: categoryHint(e),
          sourceUrl: e.permaLinkUrl || e.webLink || e.eventActionUrl || this.config.calendarUrl,
          bookingUrl: e.eventActionUrl || undefined,
          locationUrl: loc.locationUrl,
          raw: e,
        } satisfies StructuredRecord;
      });
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `city_calendar::${this.config.calendarKey}::${record.sourceRecordId}` };
  }
}

async function fetchTrumbaFeed(config: CityCalendarConfig): Promise<TrumbaEvent[]> {
  // Routed through the polite fetch seam (G-T15-5): identified UA + conditional headers,
  // per-source rate limiting, and 403/429 backoff — the wiring the audit flagged as missing.
  const response = await politeFetch(
    `city_calendar::${config.calendarKey}`,
    new URL(config.feedUrl),
    { headers: { accept: 'application/json' } },
    { family: 'city_calendar' }
  );
  if (!response.ok) {
    throw new Error(`City calendar feed fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as unknown;
  const items = Array.isArray(body) ? (body as TrumbaEvent[]) : [];
  const limit = config.liveEventsLimit ?? DEFAULT_LIMIT;
  return items.slice(0, limit);
}

export function loadCityCalendarAdapters(): CityCalendarAdapter[] {
  return CITY_CALENDARS.map((config) => new CityCalendarAdapter(config));
}

export { CITY_CALENDARS, getCityCalendar };
