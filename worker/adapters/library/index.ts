// worker/adapters/library/index.ts — G-T9-1/2: Library adapter scaffold
// (TSD §5.1 Adapter B, PRD §8 fam 7). Family 'library'; the extract() parser is
// selected per-system by platform (BiblioCommons, Communico, or generic_rss), the
// Communico parser doubling as the generic per-system feed fallback.
//
// The generic_rss handler (NVDPL, D-12) lives in ./generic-rss.ts rather than here:
// its feed carries no structured fields at all, so it needs a free-text date parser,
// a venue resolver and a kid-relevance classifier that the other two platforms don't.
//
// Default mode remains fixture-only. Richmond Public Library / BiblioCommons can
// be explicitly live-enabled with KIDS_FUN_LIVE_LIBRARY_SYSTEMS=rpl after D-6
// approval; the live path uses the public BiblioCommons gateway events endpoint,
// one paginated request, no login, no headless browser, no CAPTCHA bypass.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { politeFetch } from '../../health/policy';
// Shared, DST-correct local-wall-clock -> UTC conversion. BiblioCommons publishes
// offset-less local timestamps, and so does ActiveNet — one implementation, in
// worker/core/time.ts, rather than a second copy of a DST rule that can rot.
import { zonedLocalToUtcIso } from '../../core/time';
import { LIBRARY_SYSTEMS, getLibrarySystem, type LibraryBranchLocation, type LibrarySystemConfig } from './config';
// Dependency-free XML/HTML text helpers, shared with the generic_rss handler rather
// than duplicated (see ./rss-text.ts header).
import { decodeXmlText, finiteFloat, firstTag, stripHtml, tagBlocks } from './rss-text';
import {
  GENERIC_RSS_FIXTURE_XML,
  assessGenericRssRun,
  parseGenericRss,
  type GenericRssEvent,
  type GenericRssHealthVerdict,
  type GenericRssParseDiagnostics,
} from './generic-rss';

/** BiblioCommons/BiblioEvents-shaped event after normalisation from gateway JSON. */
interface BiblioEvent {
  id: string;
  title: string;
  branch: string;
  startsAt: string;
  endsAt?: string;
  ages: string;
  url: string;
  registrationRequired: boolean;
  descriptionText?: string;
  categoryHint?: string;
  location?: LibraryBranchLocation;
}

/** Communico/Libnet-shaped event. */
interface CommunicoEvent {
  eventId: string;
  name: string;
  location: string;
  start: string;
  end: string;
  audience: string;
  detailUrl: string;
}

interface BiblioCommonsGatewayResponse {
  events?: { items?: string[] };
  entities?: {
    events?: Record<string, BiblioCommonsGatewayEvent>;
    locations?: Record<string, { name?: string }>;
    eventAudiences?: Record<string, { name?: string }>;
    eventTypes?: Record<string, { name?: string }>;
  };
}

interface BiblioCommonsGatewayEvent {
  id: string;
  definition?: {
    start?: string;
    end?: string;
    title?: string;
    description?: string;
    branchLocationId?: string | null;
    audienceIds?: string[];
    typeIds?: string[];
    registrationInfo?: {
      enabledMethods?: string[];
      loginToRegister?: boolean;
      maxSeats?: number | null;
      cap?: number | null;
    };
    isCancelled?: boolean;
  };
}

const DEFAULT_BIBLIOCOMMONS_LIMIT = 20;

/** Stable per-source politeness key (rate-limit + backoff state) for a library system. */
function libraryPolicyKey(system: LibrarySystemConfig): string {
  return `${system.sourceFamily}::${system.systemKey}`;
}

function liveEnabledFor(systemKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(systemKey.toLowerCase());
}

function categoryHint(title: string, typeNames: string[] = []): string | undefined {
  const t = `${title} ${typeNames.join(' ')}`.toLowerCase();
  if (/story\s*time|babytime|toddler/.test(t)) return 'storytime';
  if (/duplo|lego|free play|play/.test(t)) return 'indoor_play';
  if (/workshop|club|class|robot|steam|craft/.test(t)) return 'class_program';
  return 'class_program';
}

function registrationRequired(event: BiblioCommonsGatewayEvent): boolean {
  const info = event.definition?.registrationInfo;
  return Boolean(
    info?.loginToRegister ||
      (info?.enabledMethods && info.enabledMethods.length > 0) ||
      info?.maxSeats ||
      info?.cap
  );
}

function mapBiblioCommonsGateway(system: LibrarySystemConfig, body: BiblioCommonsGatewayResponse): BiblioEvent[] {
  const ids = body.events?.items ?? [];
  const events = body.entities?.events ?? {};
  const locations = body.entities?.locations ?? {};
  const audiences = body.entities?.eventAudiences ?? {};
  const types = body.entities?.eventTypes ?? {};

  return ids.flatMap((id) => {
    const event = events[id];
    const def = event?.definition;
    if (!event || !def || !def.title || !def.start || def.isCancelled) return [];
    const branch = def.branchLocationId ? locations[def.branchLocationId]?.name : undefined;
    const location = branch ? system.branchLocations?.[branch] : undefined;
    const audienceNames = (def.audienceIds ?? []).map((a) => audiences[a]?.name).filter(Boolean) as string[];
    const typeNames = (def.typeIds ?? []).map((t) => types[t]?.name).filter(Boolean) as string[];
    const descriptionText = stripHtml(def.description);
    const ageText = [audienceNames.join(', '), descriptionText.match(/(?:ages?|children)[^.]{0,80}/i)?.[0]]
      .filter(Boolean)
      .join(' — ');
    const detailUrl = `${new URL(system.feedBaseUrl).origin}/v2/events/${event.id}`;

    return [
      {
        id: event.id,
        title: def.title,
        branch: branch ?? `${system.systemName} branch`,
        startsAt: zonedLocalToUtcIso(def.start) ?? def.start,
        endsAt: zonedLocalToUtcIso(def.end),
        ages: ageText || audienceNames.join(', ') || 'See event details',
        url: detailUrl,
        registrationRequired: registrationRequired(event),
        descriptionText,
        categoryHint: categoryHint(def.title, typeNames),
        location,
      } as BiblioEvent,
    ];
  });
}

async function fetchBiblioCommonsEvents(system: LibrarySystemConfig): Promise<BiblioEvent[]> {
  if (!system.gatewayEventsUrl) {
    throw new Error(`No BiblioCommons gateway URL configured for ${system.systemKey}`);
  }
  const url = new URL(system.gatewayEventsUrl);
  url.searchParams.set('limit', String(system.liveEventsLimit ?? DEFAULT_BIBLIOCOMMONS_LIMIT));
  // Polite fetch seam (G-T15-5): identified UA + conditional headers + rate limit + backoff.
  const response = await politeFetch(
    libraryPolicyKey(system),
    url,
    { headers: { accept: 'application/json' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`BiblioCommons events fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as BiblioCommonsGatewayResponse;
  return mapBiblioCommonsGateway(system, body);
}

// --- BiblioCommons RSS/XML feed path (ToS-permitted automated-access mechanism) ---
// The feed is machine-generated and stable: CDATA-wrapped text nodes plus the
// BiblioCommons `bc:` namespace (start_date in UTC, structured location w/ geo).
// A small dependency-free extractor keeps the worker runtime at pg+puppeteer-core
// (no XML-parser dep, no lockfile churn) and matches the adapter's existing
// regex-based stripHtml style.

function toUtcIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function eventIdFromLink(link: string): string {
  const cleaned = link.split(/[?#]/)[0].replace(/\/$/, '');
  return cleaned.split('/').pop() || cleaned;
}

// Prefer an explicit numeric age/grade range (e.g. "ages 0-2", "grades K-3");
// fall back to a keyword audience hint. Raw wording only — normalizeHook/T13
// resolves it to structured age bands downstream.
const AGE_RANGE_RE = /(?:ages?|grades?)\s*[\dK][^.<\n]{0,40}/i;
const AGE_HINT_RE =
  /(?:children|kids|teens?|tweens?|youth|toddlers?|babies|baby|infants?|preschool(?:ers)?|kindergarten|family|all ages)[^.<\n]{0,40}/i;

/** Case/punctuation-insensitive key so a feed branch name matches a config key. */
function normalizeBranchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rssLocation(system: LibrarySystemConfig, itemXml: string): LibraryBranchLocation | undefined {
  const [locBlock] = tagBlocks(itemXml, 'bc:location');
  if (!locBlock) return undefined;
  const name = firstTag(locBlock, 'bc:name');
  const number = firstTag(locBlock, 'bc:number');
  const street = firstTag(locBlock, 'bc:street');
  const city = firstTag(locBlock, 'bc:city');
  const state = firstTag(locBlock, 'bc:state') || 'BC';
  const zip = firstTag(locBlock, 'bc:zip');
  let lat = finiteFloat(firstTag(locBlock, 'bc:latitude'));
  let lng = finiteFloat(firstTag(locBlock, 'bc:longitude'));

  const streetLine = [number, street].filter(Boolean).join(' ');
  const feedAddress = [streetLine, city, [state, zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const feedDisplayArea = (name ?? '').replace(/\s+Branch$/i, '').trim() || (city ?? '');

  // Deterministic fallback: when the feed's bc:location block is incomplete (most
  // often a missing bc:latitude/longitude for an online / desk / virtual item),
  // fill the gaps from the curated branchLocations entry for that branch, matched
  // case/punctuation-insensitively on the branch name. Revives the intentionally
  // retained config fallback so a geo-less item still lands with coordinates,
  // address and municipality where we have them — never calling an external
  // geocoder.
  const fallback =
    name && system.branchLocations
      ? Object.entries(system.branchLocations).find(
          ([key]) => normalizeBranchKey(key) === normalizeBranchKey(name)
        )?.[1]
      : undefined;

  if ((lat === undefined || lng === undefined) && fallback?.lat !== undefined && fallback?.lng !== undefined) {
    lat = fallback.lat;
    lng = fallback.lng;
  }

  const address = feedAddress || fallback?.address || (name ?? '');
  const municipalityName = city || fallback?.municipalityName || '';
  const displayArea = fallback?.displayArea || feedDisplayArea;

  // Keep the location as long as ANY provenance survives (name, address, or geo).
  // Previously a missing lat/lng dropped the whole block — losing the branch
  // address AND municipality (region filter) even when the feed carried them.
  if (!name && !feedAddress && lat === undefined) return undefined;

  return {
    address,
    lat,
    lng,
    municipalityName,
    displayArea,
    locationUrl: address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : '',
  };
}

function parseBiblioCommonsRss(system: LibrarySystemConfig, xml: string): BiblioEvent[] {
  const items = tagBlocks(xml, 'item');
  const limit = system.liveEventsLimit ?? DEFAULT_BIBLIOCOMMONS_LIMIT;
  const events: BiblioEvent[] = [];

  for (const item of items) {
    if ((firstTag(item, 'bc:is_cancelled') ?? '').toLowerCase() === 'true') continue;
    const title = firstTag(item, 'title');
    const link = firstTag(item, 'link');
    const start = toUtcIso(firstTag(item, 'bc:start_date'));
    if (!title || !link || !start) continue;

    const descriptionHtml = firstTag(item, 'description') ?? '';
    const descriptionText = stripHtml(descriptionHtml);
    const categories = tagBlocks(item, 'category').map((c) => decodeXmlText(c)).filter(Boolean);
    const location = rssLocation(system, item);
    const branch = firstTag(tagBlocks(item, 'bc:location')[0] ?? '', 'bc:name') || `${system.systemName} branch`;
    const ageText =
      descriptionText.match(AGE_RANGE_RE)?.[0]?.trim() ||
      descriptionText.match(AGE_HINT_RE)?.[0]?.trim() ||
      categories.join(', ') ||
      'See event details';

    events.push({
      id: eventIdFromLink(link),
      title,
      branch,
      startsAt: start,
      endsAt: toUtcIso(firstTag(item, 'bc:end_date')),
      ages: ageText,
      url: link,
      registrationRequired: /registration\s+required/i.test(descriptionText),
      descriptionText,
      categoryHint: categoryHint(title, categories),
      location,
    });
    if (events.length >= limit) break;
  }
  return events;
}

async function fetchBiblioCommonsRss(system: LibrarySystemConfig): Promise<BiblioEvent[]> {
  if (!system.rssEventsUrl) {
    throw new Error(`No BiblioCommons RSS URL configured for ${system.systemKey}`);
  }
  const response = await politeFetch(
    libraryPolicyKey(system),
    new URL(system.rssEventsUrl),
    { headers: { accept: 'application/rss+xml, application/xml, text/xml' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`BiblioCommons RSS fetch failed: ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  return parseBiblioCommonsRss(system, xml);
}

// --- generic_rss feed path (NVDPL, D-12) ---------------------------------------
// Same seam, same politeness, same single unauthenticated GET as the BiblioCommons RSS
// path above — the ONLY difference is which parser reads the body. Deliberately does not
// fork politeFetch: rate limiting, the 403/429 breaker, the identified UA, the request
// deadline and the conditional headers all stay in one place.

async function fetchGenericRss(system: LibrarySystemConfig): Promise<GenericRssEvent[]> {
  if (!system.rssEventsUrl) {
    throw new Error(`No RSS URL configured for ${system.systemKey}`);
  }
  const response = await politeFetch(
    libraryPolicyKey(system),
    new URL(system.rssEventsUrl),
    { headers: { accept: 'application/rss+xml, application/xml, text/xml' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`Generic RSS fetch failed: ${response.status} ${response.statusText}`);
  }
  return parseAndRecordGenericRss(system, await response.text());
}

/** Parse a generic_rss body and record its tallies for assessRun(). Used by BOTH the live
 *  and fixture paths, so run health is exercised in tests rather than only in production. */
function parseAndRecordGenericRss(system: LibrarySystemConfig, xml: string): GenericRssEvent[] {
  const { events, diagnostics } = parseGenericRss(system, xml);
  lastGenericRssDiagnostics.set(system.systemKey, diagnostics);
  return events;
}

/** Last run's parse tallies per system, so assessRun() can report on what fetch() saw.
 *  Module-scoped for the same reason the PerfectMind adapter keeps its own run health:
 *  the Adapter interface hands assessRun() only a baseline count, not the parse result. */
const lastGenericRssDiagnostics = new Map<string, GenericRssParseDiagnostics>();

export class LibraryAdapter implements Adapter {
  readonly family = 'library';

  constructor(private readonly system: LibrarySystemConfig) {}

  /**
   * TRIPLE GATE. All three must hold before a single byte leaves the process:
   *   1. config  — `liveCapable: true` on this system (a reviewed live path exists);
   *   2. env     — this systemKey named in KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
   *   3. DB      — terms_status ∈ {allowed, summarise_only} AND robots_status = 'allowed',
   *                enforced independently inside politeFetch (worker/health/policy.ts),
   *                so it holds even if 1 and 2 are misconfigured.
   * Default posture with no env var set is fixture-only and ZERO network calls.
   */
  isLiveFetchEnabled(): boolean {
    return this.system.liveCapable === true && liveEnabledFor(this.system.systemKey);
  }

  async fetch(): Promise<unknown[]> {
    if (this.isLiveFetchEnabled()) {
      if (this.system.platform === 'generic_rss') {
        return fetchGenericRss(this.system);
      }
      // Prefer the ToS-permitted RSS/XML feed where configured (e.g. VPL);
      // fall back to the public JSON gateway (e.g. RPL) otherwise.
      if (this.system.rssEventsUrl) {
        return fetchBiblioCommonsRss(this.system);
      }
      return fetchBiblioCommonsEvents(this.system);
    }

    // Synthetic per-platform feed fixtures (no live request). Shape only.
    if (this.system.platform === 'generic_rss') {
      // Mirrors a real NVDPL item, escaped-HTML description and all, so the fixture path
      // exercises the same parser the live path does rather than a hand-built object that
      // could drift from it.
      return parseAndRecordGenericRss(this.system, GENERIC_RSS_FIXTURE_XML);
    }
    if (this.system.platform === 'bibliocommons') {
      const events: BiblioEvent[] = [
        {
          id: `${this.system.systemKey}-baby-storytime-1`,
          title: 'Baby Storytime',
          branch: `${this.system.systemName} — Central`,
          startsAt: '2026-07-15T17:30:00.000Z',
          endsAt: '2026-07-15T18:00:00.000Z',
          ages: '0-2 years',
          url: `${this.system.feedBaseUrl}/${this.system.systemKey}-baby-storytime-1`,
          registrationRequired: false,
        },
      ];
      return events;
    }
    const events: CommunicoEvent[] = [
      {
        eventId: `${this.system.systemKey}-toddler-storytime-1`,
        name: 'Toddler Storytime',
        location: `${this.system.systemName} — City Centre`,
        start: '2026-07-15T16:30:00.000Z',
        end: '2026-07-15T17:00:00.000Z',
        audience: 'Ages 2-5',
        detailUrl: `${this.system.feedBaseUrl}/${this.system.systemKey}-toddler-storytime-1`,
      },
    ];
    return events;
  }

  extract(raw: unknown[]): StructuredRecord[] {
    if (this.system.platform === 'generic_rss') {
      return (raw as GenericRssEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.venueName,
        // Every venue field stays undefined unless the curated table or the feed's own
        // address block supplied it. A geo-less venue is the honest outcome here, not a
        // failure — see the branchLocations comment in ./config.ts.
        venueAddress: e.location?.address || undefined,
        venueLat: e.location?.lat,
        venueLng: e.location?.lng,
        venueMunicipalityName: e.location?.municipalityName || undefined,
        venueDisplayArea: e.location?.displayArea || undefined,
        // Parsed from the free-text Date/Time inside `description`, NEVER from pubDate.
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        // NVDPL library programming is free to attend; the feed publishes no cost field,
        // and 'free' matches the rest of the library family.
        costStatus: 'free' as const,
        ageText: e.ages,
        categoryHint: e.categoryHint,
        sourceUrl: e.url,
        // The feed exposes no registration flag at all, so no bookingUrl is asserted.
        locationUrl: e.location?.locationUrl || undefined,
        raw: e,
      }));
    }
    if (this.system.platform === 'bibliocommons') {
      return (raw as BiblioEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.branch, // branch/location provenance (G-T9-3)
        venueAddress: e.location?.address,
        venueLat: e.location?.lat,
        venueLng: e.location?.lng,
        venueMunicipalityName: e.location?.municipalityName,
        venueDisplayArea: e.location?.displayArea,
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        costStatus: 'free' as const,
        ageText: e.ages,
        categoryHint: e.categoryHint ?? categoryHint(e.title),
        sourceUrl: e.url,
        bookingUrl: e.registrationRequired ? e.url : undefined,
        locationUrl: e.location?.locationUrl,
        raw: e,
      }));
    }
    return (raw as CommunicoEvent[]).map((e) => ({
      sourceRecordId: e.eventId,
      title: e.name,
      venueName: e.location,
      startDatetimeUtc: e.start,
      endDatetimeUtc: e.end,
      costStatus: 'free' as const,
      ageText: e.audience,
      categoryHint: 'storytime',
      sourceUrl: e.detailUrl,
      raw: e,
    }));
  }

  /**
   * Only the generic_rss platform self-assesses. The BiblioCommons feeds publish
   * structured, versioned fields whose breakage is loud; NVDPL's date, venue and audience
   * all come out of free text, so this source can answer HTTP 200 with a perfectly valid
   * feed and still yield nothing — a green run over an empty municipality. That is what
   * this reports. Returns null for the other platforms rather than inventing a verdict.
   */
  assessRun(): GenericRssHealthVerdict | null {
    if (this.system.platform !== 'generic_rss') return null;
    const diagnostics = lastGenericRssDiagnostics.get(this.system.systemKey);
    if (!diagnostics) return null;
    return assessGenericRssRun(this.system, diagnostics);
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `library::${this.system.systemKey}::${record.sourceRecordId}` };
  }
}

export function loadLibraryAdapters(): LibraryAdapter[] {
  return LIBRARY_SYSTEMS.map((system) => new LibraryAdapter(system));
}

export { LIBRARY_SYSTEMS, getLibrarySystem };
