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
const USER_AGENT = 'KidsFunBot/0.1 (+https://kids-fun-staging-jdci-nc.vercel.app; contact: jon@crhq.ai)';

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

function addSpecStrings(specs: string[], map: Map<number, [string, string]>): void {
  for (const spec of specs) {
    const t = TIME_RANGE_RE.exec(spec);
    if (!t) continue;
    const daysPart = spec.slice(0, t.index).trim();
    const days = daysPart ? parseDays(daysPart) : [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) map.set(d, [t[1], t[2]]);
  }
}

function addSpecObjects(specs: unknown[], map: Map<number, [string, string]>): void {
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
    const time: [string, string] = [hhmm(opens), hhmm(closes)];
    for (const d of days.length ? days : [0, 1, 2, 3, 4, 5, 6]) map.set(d, time);
  }
}

function collectOpeningHours(nodes: Record<string, unknown>[]): Map<number, [string, string]> {
  const map = new Map<number, [string, string]>();
  for (const node of nodes) {
    const oh = node['openingHours'];
    if (typeof oh === 'string') addSpecStrings([oh], map);
    else if (Array.isArray(oh)) addSpecStrings(oh.filter((x): x is string => typeof x === 'string'), map);
    const ohs = node['openingHoursSpecification'];
    if (ohs) addSpecObjects(Array.isArray(ohs) ? ohs : [ohs], map);
  }
  return map;
}

/** Summarise a day→hours map into a human open-hours state string. */
function summariseHours(dayHours: Map<number, [string, string]>): string | undefined {
  const days = [...dayHours.keys()].sort((a, b) => a - b);
  if (days.length === 0) return undefined;

  const distinct = new Set([...dayHours.values()].map((v) => v.join('-')));
  if (days.length === 7 && distinct.size === 1) {
    const [o, c] = dayHours.get(0)!;
    return `Daily ${to12h(o)}–${to12h(c)}`;
  }

  const parts: string[] = [];
  let i = 0;
  while (i < days.length) {
    let j = i;
    const key = dayHours.get(days[i])!.join('-');
    while (j + 1 < days.length && days[j + 1] === days[j] + 1 && dayHours.get(days[j + 1])!.join('-') === key) j += 1;
    const [o, c] = dayHours.get(days[i])!;
    const label = i === j ? DAY_ORDER[days[i]] : `${DAY_ORDER[days[i]]}–${DAY_ORDER[days[j]]}`;
    parts.push(`${label} ${to12h(o)}–${to12h(c)}`);
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

export function parseOpeningHours(nodes: Record<string, unknown>[]): string | undefined {
  return summariseHours(collectOpeningHours(flatten(nodes)));
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

async function fetchPage(kind: VenuePayload['kind'], url: string): Promise<VenuePayload> {
  const response = await fetch(new URL(url), {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
  });
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
      if (this.config.hoursUrl) pages.push(await fetchPage('hours', this.config.hoursUrl));
      if (this.config.eventsUrl) pages.push(await fetchPage('events', this.config.eventsUrl));
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
