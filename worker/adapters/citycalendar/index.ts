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
import { parseAgeText } from '../../core/age';
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
  /(?:for\s+)?(?:kids|children|families|family|all\s+ages|youth|teens?|tweens?|toddlers?|babies|baby|preschool(?:ers?)?|seniors?|adults?)[^.<\n]{0,30}/i;

/**
 * The source stating an age OUTRIGHT — "ages 7-11", "grades K-3". Preferred over
 * AGE_HINT_RE's window whenever both are present (docs/age-pattern-extraction-scope.md §8e).
 *
 * THE ROW THIS EXISTS FOR, measured on the live 2026-08-18 Trumba feed, 1 of 32:
 *   "Free Synchronized Swimming Try-it Class for Kids" — the description says "a FREE class
 *   for kids ages 7-11 who can swim 1 lap unassisted". With no structured Audiences field to
 *   consult, AGE_HINT_RE's 30-character window opened on "for Kids" and closed before the
 *   number, lifting "for Kids Come try Artistic Swimming (S" — which worker/core/age.ts
 *   scores [60,144], four years too wide at the bottom and one too wide at the top.
 *
 * DELIBERATELY BELOW the structured Audiences field, not above it. That precedence is the
 * one this adapter already got right and it is not being disturbed: a curated tag is the
 * city's own claim about who a programme is for, and this pattern is still a scan of prose.
 * It only ever competes with the OTHER prose scan, and it wins because a stated range is
 * strictly more specific than a keyword plus thirty characters of whatever followed it.
 *
 * The `ages`/`grades` word must sit IMMEDIATELY before the number — no bare `N+`, no bare
 * `N-M`. A Trumba description is dense with dates, times and street numbers, and this
 * adapter has no measured corpus of anchor phrases behind it the way the library family now
 * does; the narrow form fixes the measured defect and cannot manufacture an age from a date.
 */
const AGE_RANGE_RE = /(?:ages?|grades?)\s*[\dK][^.<\n]{0,40}/i;

// ── a catch-all audience is not a child-audience claim when the subject is adult-only ──
//
// THE ROW THIS EXISTS FOR, and it is not a parsing bug:
//   "International Overdose Awareness"  (eventID 150181808, listing 97670289-…)
//   customFields: [{ label: 'Audiences', value: 'All ages' }, …]
//   description:  "City Hall's flag will be at half-mast in honour of International
//                  Overdose Awareness."
// Verified against the live Trumba feed on 2026-08-18: the structured field really does
// say "All ages", and AGE_HINT_RE finds NOTHING in that title+description — so the prose
// fallback never ran and cannot be blamed. The City tags a flag observance "All ages"
// meaning "nobody is excluded from observing it"; worker/core/age.ts reads the same two
// words as an AUDIENCE and resolves [0, ∞), which publishes all five bands including
// under2. A parent filtering to ages=under2 was told a public overdose-awareness
// observance is programming for their baby. That is the defect
// lib/audit/rules/adult-subject-child-bands.ts caught at audit time; this is the same
// question asked at ingest, where the claim is actually made.
//
// WHAT THIS DOES NOT DO. The structured-field-over-prose preference below is untouched —
// "Children", "Preschoolers", "Youth", "Adults" and every other SPECIFIC tag still wins
// outright and resolves exactly as before. Only a tag that names no age group at all is
// eligible, and only when the source's own subject matter is adult-only. The result of
// suppression is SILENCE (undefined → no occurrence_age row → no bands), never a
// substituted age: a known unknown, which the search filter keeps visible, instead of a
// false statement of fact. The source's own wording is not lost — `raw` keeps the whole
// Trumba event, Audiences field included.
//
// KNOWN DUPLICATION, recorded rather than silently widened (same convention as
// worker/core/age.ts's note on the adapter AGE_HINT_REs). The three regexes below are
// copies of lib/audit/rules/{adult-subject-child-bands,adult-signals}.ts. The worker
// CANNOT import them: lib/audit/rules/adult-signals.ts imports '@/worker/core/age', and
// worker/tsconfig.json has no '@/*' alias by design — pulling it in would emit a bare
// require("@/worker/core/age") into the container and trip
// tests/scheduler/worker-image-closure.test.ts. Consolidating them into one
// worker-owned module that lib/ imports is a real, separately-QA'd change to the audit
// layer and is logged as a follow-up, not smuggled in here.
//
// STRONG MARKERS ONLY. The audit rule carries a `weak` tier ("mental health", "support
// group", "crisis") whose contract is "raises a candidate, never reports one" — it exists
// because those subjects genuinely do run as family programmes. Audit time has an
// adjudicator to make that call; ingest does not, so acting on a weak marker here would
// silently mute real listings with nobody reviewing the decision.
const ADULT_SUBJECT_RE = new RegExp(
  [
    /\b(?:overdose|naloxone|narcan|opioids?|fentanyl|harm\s+reduction|safer\s+supply|substance\s+use|drug\s+use)\b/,
    /\b(?:suicide|self[\s-]?harm)\b/,
    /\b(?:bereavement|palliative|hospice|end[\s-]of[\s-]life)\b|\bgrief\s+(?:support|group|circle|counsell?ing)\b/,
    /\b(?:domestic|intimate[\s-]partner)\s+violence\b|\bsexual\s+assault\b/,
    /\b(?:dementia|alzheimer\w*|osteoporosis|menopaus\w+|prostate|incontinence)\b/,
    /\b(?:income\s+tax|tax\s+clinic|estate\s+planning|wills?\s+and\s+estates?|retirement\s+planning|pension|mortgage)\b/,
    /\b(?:smoking|vaping|tobacco)\s+cessation\b|\bgambling\b/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
);
/** The source naming a young audience in its OWN words — copy of adult-signals.ts. */
const CHILD_AUDIENCE_RE =
  /\b(?:teens?|teenagers?|youth|kids?|child(?:ren)?|toddlers?|preschoolers?|infants?|babies|baby|famil(?:y|ies)|all[\s-]ages)\b/i;
/** A programme FOR children that adults attend — copy of adult-signals.ts. */
const CAREGIVER_PROGRAMME_RE =
  /\b(?:parent|adult|caregiver|grown[\s-]?up|mommy|mummy|daddy|guardian)s?\s*(?:&|and|\+|\/)\s*(?:tot|child|kid|baby|babies|toddler|me|preschooler)s?\b|\bfamil(?:y|ies)\b|\bcaregivers?\b|\bwith\s+(?:a\s+)?(?:parent|caregiver|guardian|grown[\s-]?up)\b|\bparent\s+participation\b/i;

/**
 * True when the wording names no age group at all — "All ages", "Families", "Everyone".
 *
 * Decided by worker/core/age.ts rather than by a fourth copy of ALL_AGES_RE: `notes ===
 * 'all-ages'` is set by exactly one branch of parseAgeText, and parseAudienceLabels already
 * relies on it as the marker for "this tag named no age group at all". Reusing it means a
 * catch-all can never mean one thing to the parser and another to this guard.
 *
 * EVERY tag must be a catch-all, not just the first. The Trumba feed publishes a single
 * value today (measured 2026-08-18: 32 events → "All ages" ×7, "Adults" ×1, absent ×24), but
 * parseAgeText checks ALL_AGES_RE before the keyword table, so a hypothetical
 * "Families, Preschoolers" would read as a pure catch-all and lose the specific half. Cheap
 * insurance against a field the city can widen without telling us.
 */
function isCatchAllAudience(wording: string): boolean {
  const tags = wording
    .split(/\s*[;,]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length === 0) return false;
  return tags.every((t) => parseAgeText(t).notes === 'all-ages');
}

/**
 * True when the source's OWN title/description names adult-only subject matter and names no
 * young audience anywhere to contradict it.
 *
 * Reads title and description ONLY — never the Audiences field, never the resolved wording.
 * That is deliberate and it is the reason the audit rule's header gives: letting the value
 * under suspicion satisfy the guard that would excuse it makes the check unfalsifiable, the
 * bug becomes its own alibi. It also has a useful consequence for the prose branch of
 * ageText(): a catch-all lifted OUT of the description ("…for all ages in the park") is
 * necessarily also matched by CHILD_AUDIENCE_RE in that same text, so it guards itself out.
 * The suppressed set is therefore exactly the set adult_subject_child_bands would report —
 * a source that said in words that a child may come is never second-guessed here.
 */
function namesAdultOnlySubject(sourceText: string): boolean {
  if (CHILD_AUDIENCE_RE.test(sourceText)) return false;
  if (CAREGIVER_PROGRAMME_RE.test(sourceText)) return false;
  return ADULT_SUBJECT_RE.test(sourceText);
}

function ageText(event: TrumbaEvent): string | undefined {
  // Prefer the feed's STRUCTURED "Audiences" custom field ("All ages", "Families",
  // "Children", "Preschoolers", "Youth", …) over a prose keyword scan. It is a
  // clean, unambiguous token that worker/core/age.ts resolves into an age band
  // accurately, avoiding the misfires a 30-char description window produces
  // (e.g. "kids" inside "Kids' Place desk for a chance to win").
  // Within the PROSE fallback, a stated range beats a keyword window — see AGE_RANGE_RE.
  const hay = `${decodeEntities(event.title)} ${decodeEntities(event.description ?? '')}`;
  const wording =
    customField(event, 'Audiences') ??
    AGE_RANGE_RE.exec(hay)?.[0]?.trim() ??
    AGE_HINT_RE.exec(hay)?.[0]?.trim();
  if (!wording) return undefined;
  // Precedence above is untouched; this only withholds a wording that claims every age
  // while the source's subject is adult-only. See the block comment above.
  if (isCatchAllAudience(wording) && namesAdultOnlySubject(hay)) return undefined;
  return wording;
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
