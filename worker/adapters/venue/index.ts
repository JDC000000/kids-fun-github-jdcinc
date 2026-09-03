// worker/adapters/venue/index.ts — G-T11-1: Venue (museum / attraction) adapter
// (TSD §5.1 Adapter D, family `venue_html`, PRD §8 fam 4-5).
//
// Parses the SEMI-STRUCTURED HTML a museum/attraction publishes — specifically
// the schema.org structured data embedded in its public pages (the machine
// layer publishers add for SEO): `openingHours` / `OpeningHoursSpecification`
// for standing admission, and `Event` nodes for one-off programmes. It reads
// exactly one credential-free GET per configured page (identified bot UA, no
// login, no cookie, no headless render), and it defers the series-vs-occurrence
// split to worker/adapters/venue/separate.ts (G-T11-2): open hours become one
// open_hours_state series, special events become discrete dated occurrences.
//
// Default mode is fixture-only (zero network). The live path is gated behind
// BOTH the DB terms gate (worker/core/terms-gate.ts) AND the env allow-list
// KIDS_FUN_LIVE_VENUES=<venueKey>, and is only offered for venues explicitly
// marked liveCapable after a real robots.txt + ToS review (see config.ts).
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { politeFetch } from '../../health/policy';
import {
  LAUNCH_VENUES,
  getVenue,
  type VenueConfig,
  type VenueFixtureEvent,
} from './config';
import {
  separateVenueRecords,
  type VenueIdentity,
  type SpecialEventInput,
} from './separate';

const DEFAULT_EVENTS_LIMIT = 25;
const USER_AGENT = 'KidsFunBot/0.1 (+https://kidsfunapp.ca; contact: jon@crhq.ai)';

/** One fetched (or synthesised) venue page carrying schema.org data. */
interface VenuePayload {
  kind: 'hours' | 'events';
  url: string;
  html: string;
}

interface VenueEventParsed {
  slug: string;
  title: string;
  startDatetimeUtc: string;
  endDatetimeUtc?: string;
  costStatus: SpecialEventInput['costStatus'];
  ageText?: string;
  url?: string;
}

function liveEnabledFor(venueKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_VENUES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(venueKey.toLowerCase());
}

// ── schema.org JSON-LD extraction ────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten arbitrary JSON-LD (arrays, `@graph`, `itemListElement`) into a flat
 *  list of object nodes so a single scan can find hours + Event nodes wherever
 *  the publisher nested them. */
function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
    return;
  }
  if (!isRecord(value)) return;
  out.push(value);
  if ('@graph' in value) collectNodes(value['@graph'], out);
  if ('itemListElement' in value) collectNodes(value['itemListElement'], out);
  if ('item' in value) collectNodes(value['item'], out);
}

const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;
  LD_JSON_RE.lastIndex = 0;
  while ((match = LD_JSON_RE.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      collectNodes(JSON.parse(raw), nodes);
    } catch {
      // Malformed JSON-LD block — skip; a bad block never sinks the whole parse.
    }
  }
  return nodes;
}

function typeOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

// ── open-hours parsing (openingHours + OpeningHoursSpecification) ─────────────

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_ALIASES: Record<string, number> = {
  mo: 0, mon: 0, monday: 0,
  tu: 1, tue: 1, tues: 1, tuesday: 1,
  we: 2, wed: 2, wednesday: 2,
  th: 3, thu: 3, thur: 3, thurs: 3, thursday: 3,
  fr: 4, fri: 4, friday: 4,
  sa: 5, sat: 5, saturday: 5,
  su: 6, sun: 6, sunday: 6,
};

const TIME_RANGE_RE = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/;

function parseDays(daysPart: string): number[] {
  const out = new Set<number>();
  for (const chunk of daysPart.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = chunk.split(/\s*[-–—]\s*/);
    if (range.length === 2) {
      const a = DAY_ALIASES[range[0].toLowerCase()];
      const b = DAY_ALIASES[range[1].toLowerCase()];
      if (a === undefined || b === undefined) continue;
      let i = a;
      for (let guard = 0; guard < 7; guard += 1) {
        out.add(i);
        if (i === b) break;
        i = (i + 1) % 7;
      }
    } else {
      const d = DAY_ALIASES[chunk.toLowerCase()];
      if (d !== undefined) out.add(d);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function hhmm(value: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : value.trim();
}

function to12h(value: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return value.trim();
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return min === '00' ? `${h} ${ampm}` : `${h}:${min} ${ampm}`;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** One opening window on one day, as the local wall-clock "HH:MM" pair the source published. */
export interface HoursWindow {
  opens: string;
  closes: string;
}

/**
 * A venue's published week, kept in the shape the SOURCE published it: seven days, each holding
 * zero or more opening windows. Monday-first (index 0 = Monday), so the index is the same day
 * number `DAY_ALIASES` produces.
 *
 * A day with an EMPTY window list is a day the source did not say the venue is open, and that is a
 * load-bearing distinction — it is the difference between "closed Mondays" and "we don't know about
 * Mondays", which the flattened sentence could not express at all.
 *
 * WHY PER-DAY AND NOT WEEKDAY/WEEKEND. Real venue weeks do not divide into two buckets: closed
 * Mondays, a late Thursday, a midday break on Sundays. A weekday/weekend pair cannot hold any of
 * those, and forcing a week into it asserts hours on days the venue never claimed — the exact
 * "arrive at a closed building" failure this structure exists to prevent. Per-day is what
 * schema.org publishes and it is strictly richer: a weekday/weekend read is derivable from it,
 * while it is not recoverable from a weekday/weekend pair.
 */
export interface WeeklyHours {
  /** Monday-first, always length 7. Index 0 = Monday … 6 = Sunday. */
  days: HoursWindow[][];
}

function emptyWeek(): WeeklyHours {
  return { days: [[], [], [], [], [], [], []] };
}

function minutesOf(hhmmValue: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmmValue);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** [open, close) in minutes; a close at or before the open is read as running to end of day. */
function windowBounds(w: HoursWindow): [number, number] {
  const open = minutesOf(w.opens);
  const close = minutesOf(w.closes);
  return [open, close > open ? close : close + 1440];
}

function overlaps(a: HoursWindow, b: HoursWindow): boolean {
  const [aOpen, aClose] = windowBounds(a);
  const [bOpen, bClose] = windowBounds(b);
  return aOpen < bClose && bOpen < aClose;
}

/**
 * Add one window to one day.
 *
 * DISJOINT WINDOWS ACCUMULATE; AN OVERLAPPING ONE REPLACES WHAT IT OVERLAPS. Both patterns are real
 * and they mean opposite things. A venue that closes over lunch publishes two disjoint windows for
 * one day and both are true — this used to `map.set` and keep only the last, so a 10–1 / 2–5 day
 * was published as "2 PM–5 PM" and the morning simply vanished. A venue that publishes a general
 * week and then a more specific line for one day publishes OVERLAPPING windows, and there the later,
 * more specific spec is meant to win; replacing on overlap keeps that behaviour rather than printing
 * a contradictory "9 AM–5 PM, 10 AM–4 PM".
 */
function addWindow(week: WeeklyHours, day: number, window: HoursWindow): void {
  const kept = week.days[day].filter((existing) => !overlaps(existing, window));
  kept.push(window);
  kept.sort((a, b) => windowBounds(a)[0] - windowBounds(b)[0]);
  week.days[day] = kept;
}

function addSpecStrings(specs: string[], week: WeeklyHours): void {
  for (const spec of specs) {
    const t = TIME_RANGE_RE.exec(spec);
    if (!t) continue;
    const daysPart = spec.slice(0, t.index).trim();
    // No day part at all is schema.org's "every day". A day part that is PRESENT but parses to
    // nothing is not — `parseDays` returns [] and the loop below adds nothing, which is the
    // fail-safe reading: we were told specific days and could not read them, so we claim none.
    const days = daysPart ? parseDays(daysPart) : ALL_DAYS;
    for (const d of days) addWindow(week, d, { opens: hhmm(t[1]), closes: hhmm(t[2]) });
  }
}

function addSpecObjects(specs: unknown[], week: WeeklyHours): void {
  for (const s of specs) {
    if (!isRecord(s)) continue;
    const opens = s['opens'];
    const closes = s['closes'];
    if (typeof opens !== 'string' || typeof closes !== 'string') continue;
    const dow = s['dayOfWeek'];
    const dowList = Array.isArray(dow) ? dow : [dow];
    const days: number[] = [];
    for (const d of dowList) {
      if (typeof d !== 'string') continue;
      const name = d.split('/').pop()!.toLowerCase();
      const idx = DAY_ALIASES[name];
      if (idx !== undefined) days.push(idx);
    }
    // A SPEC THAT STATES DAYS WE CANNOT READ CLAIMS NO DAYS AT ALL.
    //
    // This used to fall back to all seven whenever `days` came out empty, which conflated two
    // opposite cases. `dayOfWeek` ABSENT genuinely means every day. `dayOfWeek` PRESENT but
    // unreadable — the object form `{"@id": "https://schema.org/Saturday"}`, a locale spelling, a
    // typo — means the venue named specific days and we failed to parse them, and publishing that
    // as "open daily" is how a Saturday-only venue came to be advertised as open all week. A parent
    // acts on those hours; being silent about a day is recoverable, being wrong about it is not.
    // `addSpecStrings` above already fails safe the same way for an unreadable day part.
    const dayOfWeekStated = dow !== undefined && dow !== null;
    if (days.length === 0 && dayOfWeekStated) continue;
    for (const d of days.length ? days : ALL_DAYS) addWindow(week, d, { opens: hhmm(opens), closes: hhmm(closes) });
  }
}

function collectOpeningHours(nodes: Record<string, unknown>[]): WeeklyHours {
  const week = emptyWeek();
  for (const node of nodes) {
    const oh = node['openingHours'];
    if (typeof oh === 'string') addSpecStrings([oh], week);
    else if (Array.isArray(oh)) addSpecStrings(oh.filter((x): x is string => typeof x === 'string'), week);
    const ohs = node['openingHoursSpecification'];
    if (ohs) addSpecObjects(Array.isArray(ohs) ? ohs : [ohs], week);
  }
  return week;
}

/** True when the source stated no hours at all — so no open-hours record should be built. */
export function isEmptyWeek(hours: WeeklyHours): boolean {
  return hours.days.every((windows) => windows.length === 0);
}

/** The comparable identity of one day's windows, so two days can be tested for "same hours". */
function dayKey(windows: HoursWindow[]): string {
  return windows.map((w) => `${w.opens}-${w.closes}`).join('|');
}

/** "10 AM–1 PM, 2–5 PM" — every window the venue published for that day, in order. */
function formatDayWindows(windows: HoursWindow[]): string {
  return windows.map((w) => `${to12h(w.opens)}–${to12h(w.closes)}`).join(', ');
}

/**
 * Render a week as the human open-hours sentence (`open_hours_state`).
 *
 * DERIVED FROM THE STRUCTURE, NEVER ASSEMBLED ALONGSIDE IT, so the sentence cannot come to disagree
 * with the schedule it is meant to describe. Days the source never claimed are simply absent from
 * the sentence — a gap breaks a day run, so a venue closed on Mondays reads "Tue–Sun …" and never
 * "Daily".
 */
export function formatWeeklyHours(hours: WeeklyHours): string | undefined {
  const open = ALL_DAYS.filter((d) => hours.days[d].length > 0);
  if (open.length === 0) return undefined;

  const distinct = new Set(open.map((d) => dayKey(hours.days[d])));
  if (open.length === 7 && distinct.size === 1) return `Daily ${formatDayWindows(hours.days[0])}`;

  const parts: string[] = [];
  let i = 0;
  while (i < open.length) {
    let j = i;
    const key = dayKey(hours.days[open[i]]);
    while (j + 1 < open.length && open[j + 1] === open[j] + 1 && dayKey(hours.days[open[j + 1]]) === key) j += 1;
    const label = i === j ? DAY_ORDER[open[i]] : `${DAY_ORDER[open[i]]}–${DAY_ORDER[open[j]]}`;
    parts.push(`${label} ${formatDayWindows(hours.days[open[i]])}`);
    i = j + 1;
  }
  return parts.join('; ');
}

/** Flatten possibly-nested JSON-LD nodes (@graph / ItemList) so a caller can pass
 *  either the flat list extractJsonLdNodes() produces or raw parsed nodes. */
function flatten(nodes: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) collectNodes(n, out);
  return out;
}

/**
 * The venue's published week, per day, straight off its schema.org markup.
 *
 * THE STRUCTURE IS THE PARSE RESULT; the sentence is a rendering of it. This used to be the other
 * way round — `parseOpeningHours` was the only entry point and it flattened a day→hours map into a
 * string on the way out, so the per-day facts the source had actually published were destroyed at
 * the adapter boundary and nothing downstream could ever answer "is it open today?". Recovering
 * them from the sentence afterwards would mean re-parsing our own prose, which is the manufactured
 * claim this codebase keeps removing. Keeping the structure costs nothing: the parser already built
 * it internally.
 */
export function parseWeeklyHours(nodes: Record<string, unknown>[]): WeeklyHours | undefined {
  const week = collectOpeningHours(flatten(nodes));
  return isEmptyWeek(week) ? undefined : week;
}

/**
 * The human open-hours sentence for a venue's markup — `open_hours_state`, verbatim-equivalent to
 * what the venue published. Unchanged signature; it is now `parseWeeklyHours` rendered, so it is
 * correct by construction rather than assembled by a second pass over the same data.
 */
export function parseOpeningHours(nodes: Record<string, unknown>[]): string | undefined {
  const week = parseWeeklyHours(nodes);
  return week ? formatWeeklyHours(week) : undefined;
}

// ── special-event parsing (schema.org Event + subtypes) ──────────────────────

function toUtcIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function slugFromUrl(url: string | undefined, fallback: string): string {
  if (url) {
    const cleaned = url.split(/[?#]/)[0].replace(/\/$/, '');
    const last = cleaned.split('/').pop();
    if (last) return last;
  }
  return fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'event';
}

function costFromOffers(node: Record<string, unknown>): SpecialEventInput['costStatus'] {
  const offers = node['offers'];
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const o of list) {
    if (!isRecord(o)) continue;
    const price = o['price'];
    const n = typeof price === 'number' ? price : typeof price === 'string' ? Number(price) : NaN;
    if (Number.isFinite(n) && n === 0) return 'free';
  }
  return 'check_source';
}

export function parseVenueEvents(nodes: Record<string, unknown>[]): VenueEventParsed[] {
  const out: VenueEventParsed[] = [];
  const seen = new Set<string>();
  for (const node of flatten(nodes)) {
    if (!typeOf(node).some((t) => /event$/i.test(t))) continue;
    const title = typeof node['name'] === 'string' ? (node['name'] as string).trim() : '';
    const startDatetimeUtc = toUtcIso(node['startDate']);
    if (!title || !startDatetimeUtc) continue;
    const url = typeof node['url'] === 'string' ? (node['url'] as string) : undefined;
    const slug = slugFromUrl(url, title);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const age = node['typicalAgeRange'];
    out.push({
      slug,
      title,
      startDatetimeUtc,
      endDatetimeUtc: toUtcIso(node['endDate']),
      costStatus: costFromOffers(node),
      ageText: typeof age === 'string' && age.trim() ? age.trim() : undefined,
      url,
    });
  }
  return out;
}

// ── fixture synthesis (no network) ───────────────────────────────────────────

function fixtureEventNode(config: VenueConfig, event: VenueFixtureEvent): Record<string, unknown> {
  const url = event.url ?? `${config.officialUrl.replace(/\/$/, '')}/event/${event.slug}/`;
  return {
    '@type': 'Event',
    name: event.title,
    startDate: event.startDatetimeUtc,
    endDate: event.endDatetimeUtc,
    url,
    typicalAgeRange: event.typicalAgeRange,
    location: { '@type': 'Place', name: config.venueName, address: config.address },
    offers: event.costStatus === 'free' ? { '@type': 'Offer', price: 0, priceCurrency: 'CAD' } : undefined,
  };
}

function buildFixturePages(config: VenueConfig): VenuePayload[] {
  const hoursLd = {
    '@context': 'https://schema.org',
    '@type': config.venueCategory === 'museum_venue' ? ['Museum', 'Organization'] : ['EntertainmentBusiness', 'Organization'],
    name: config.venueName,
    url: config.officialUrl,
    address: config.address,
    openingHours: [config.fixtureOpenHours],
  };
  const eventsLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: config.fixtureEvents.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: fixtureEventNode(config, e),
    })),
  };
  const page = (title: string, ld: unknown): string =>
    `<!doctype html><html><head><title>${title} — ${config.venueName}</title>` +
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>` +
    `</head><body><h1>${config.venueName}</h1></body></html>`;
  return [
    { kind: 'hours', url: config.hoursUrl ?? config.officialUrl, html: page('Plan Your Visit', hoursLd) },
    { kind: 'events', url: config.eventsUrl ?? config.officialUrl, html: page('What’s On', eventsLd) },
  ];
}

// ── live fetch (single credential-free GET per page) ─────────────────────────

async function fetchPage(
  kind: VenuePayload['kind'],
  url: string,
  venueKey: string
): Promise<VenuePayload> {
  // H4: routed through the shared polite seam rather than global fetch(). This adapter
  // was the last one still calling fetch() directly, which meant it had no request
  // deadline (the hang this fix exists for), no per-source rate limiting and no 403/429
  // circuit breaker. Its own identified UA is passed through unchanged — politeFetch
  // leaves a caller-supplied User-Agent alone — so the crawl identity does not change.
  const response = await politeFetch(
    `venue_html::${venueKey}`,
    new URL(url),
    { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT } },
    { family: 'venue_html' }
  );
  if (!response.ok) {
    throw new Error(`Venue ${kind} page fetch failed: ${response.status} ${response.statusText}`);
  }
  return { kind, url, html: await response.text() };
}

function venueIdentity(config: VenueConfig): VenueIdentity {
  return {
    venueKey: config.venueKey,
    venueName: config.venueName,
    venueCategory: config.venueCategory,
    officialUrl: config.officialUrl,
    address: config.address,
    displayArea: config.displayArea,
    municipality: config.municipality,
    lat: config.geo?.lat,
    lng: config.geo?.lng,
  };
}

export class VenueAdapter implements Adapter {
  readonly family = 'venue_html';

  constructor(private readonly config: VenueConfig) {}

  isLiveFetchEnabled(): boolean {
    return Boolean(this.config.liveCapable) && liveEnabledFor(this.config.venueKey);
  }

  async fetch(): Promise<unknown[]> {
    if (this.isLiveFetchEnabled()) {
      const pages: VenuePayload[] = [];
      // Live venues currently expose a schema.org open-hours page; the events
      // page is only wired when the venue publishes schema.org Event data.
      if (this.config.hoursUrl) pages.push(await fetchPage('hours', this.config.hoursUrl, this.config.venueKey));
      if (this.config.eventsUrl) pages.push(await fetchPage('events', this.config.eventsUrl, this.config.venueKey));
      return pages;
    }
    return buildFixturePages(this.config);
  }

  extract(raw: unknown[]): StructuredRecord[] {
    const pages = raw as VenuePayload[];
    const nodes = pages.flatMap((p) => extractJsonLdNodes(p.html));
    const hoursUrl = pages.find((p) => p.kind === 'hours')?.url ?? this.config.officialUrl;
    const eventsUrl = pages.find((p) => p.kind === 'events')?.url ?? this.config.officialUrl;

    const openHoursState = parseOpeningHours(nodes);
    const events = parseVenueEvents(nodes).slice(0, this.config.liveEventsLimit ?? DEFAULT_EVENTS_LIMIT);

    const eventInputs: SpecialEventInput[] = events.map((e) => ({
      slug: e.slug,
      title: e.title,
      startDatetimeUtc: e.startDatetimeUtc,
      endDatetimeUtc: e.endDatetimeUtc,
      costStatus: e.costStatus,
      ageText: e.ageText,
      sourceUrl: e.url ?? eventsUrl,
    }));

    const { all } = separateVenueRecords(venueIdentity(this.config), {
      openHours: openHoursState
        ? {
            openHoursState,
            admissionLabel: this.config.admissionLabel,
            costStatus: this.config.admissionCostStatus,
            sourceUrl: hoursUrl,
          }
        : undefined,
      events: eventInputs,
    });
    return all;
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `venue_html::${this.config.venueKey}::${record.sourceRecordId}` };
  }
}

export function loadVenueAdapters(): VenueAdapter[] {
  return LAUNCH_VENUES.map((config) => new VenueAdapter(config));
}

export { LAUNCH_VENUES, getVenue };
