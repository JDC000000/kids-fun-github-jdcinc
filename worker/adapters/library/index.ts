// worker/adapters/library/index.ts — G-T9-1/2: Library adapter scaffold
// (TSD §5.1 Adapter B, PRD §8 fam 7). Family 'library'; the extract() parser is
// selected per-system by platform (BiblioCommons vs Communico), the Communico
// parser doubling as the generic per-system feed fallback.
//
// Default mode remains fixture-only. Richmond Public Library / BiblioCommons can
// be explicitly live-enabled with KIDS_FUN_LIVE_LIBRARY_SYSTEMS=rpl after D-6
// approval; the live path uses the public BiblioCommons gateway events endpoint,
// one paginated request, no login, no headless browser, no CAPTCHA bypass.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { LIBRARY_SYSTEMS, getLibrarySystem, type LibrarySystemConfig } from './config';

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
const DEFAULT_TIME_ZONE = 'America/Vancouver';
const USER_AGENT = 'KidsFunBot/0.1 (+https://kids-fun-staging-jdci-nc.vercel.app; contact: jon@crhq.ai)';

function liveEnabledFor(systemKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(systemKey.toLowerCase());
}

function stripHtml(html = ''): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function utcPartsInTimeZone(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
}

function zonedLocalToUtcIso(local: string | undefined, timeZone = DEFAULT_TIME_ZONE): string | undefined {
  if (!local) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const desiredAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const rendered = utcPartsInTimeZone(new Date(desiredAsUtc), timeZone);
  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    rendered.second
  );
  const offsetMs = renderedAsUtc - desiredAsUtc;
  return new Date(desiredAsUtc - offsetMs).toISOString();
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
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`BiblioCommons events fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as BiblioCommonsGatewayResponse;
  return mapBiblioCommonsGateway(system, body);
}

export class LibraryAdapter implements Adapter {
  readonly family = 'library';

  constructor(private readonly system: LibrarySystemConfig) {}

  async fetch(): Promise<unknown[]> {
    if (this.system.platform === 'bibliocommons' && liveEnabledFor(this.system.systemKey)) {
      return fetchBiblioCommonsEvents(this.system);
    }

    // Synthetic per-platform feed fixtures (no live request). Shape only.
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
    if (this.system.platform === 'bibliocommons') {
      return (raw as BiblioEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.branch, // branch/location provenance (G-T9-3)
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        costStatus: 'free' as const,
        ageText: e.ages,
        categoryHint: e.categoryHint ?? categoryHint(e.title),
        sourceUrl: e.url,
        bookingUrl: e.registrationRequired ? e.url : undefined,
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

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `library::${this.system.systemKey}::${record.sourceRecordId}` };
  }
}

export function loadLibraryAdapters(): LibraryAdapter[] {
  return LIBRARY_SYSTEMS.map((system) => new LibraryAdapter(system));
}

export { LIBRARY_SYSTEMS, getLibrarySystem };
