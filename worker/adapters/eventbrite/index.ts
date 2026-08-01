// worker/adapters/eventbrite/index.ts — G-T10-2: organizer-scoped Eventbrite /
// partner feed adapter (TSD §5 row 10, §5.1 Adapter C, family `eventbrite_organizer`).
//
// Reads ONLY feeds an organizer owns or has explicitly authorised. The scoping
// guarantee lives in client.ts (hard-coded host + organizer id in the request PATH +
// a closed query allow-list + a runtime tripwire on the final URL) and is proven in
// tests/compliance/eventbrite-organizer-scope.test.ts. Read client.ts's header before
// changing anything here.
//
// FOUR INDEPENDENT GATES keep this off. Any ONE of them being unmet means zero
// network activity — the same layered posture as T7/T8, plus a fourth because this
// family needs a credential the others do not:
//   1. config      — an authorised organizer entry exists in EVENTBRITE_ORGANIZERS
//                    with `enabled: true`  (today: the list is EMPTY, by design)
//   2. env allow-list — KIDS_FUN_LIVE_EVENTBRITE names that organizerKey
//   3. credential  — the organizer's token is present in its configured env var
//   4. DB terms gate — source.terms_status/robots_status, enforced inside politeFetch
//                    (worker/health/policy.ts) on every request
//
// TODAY THIS ADAPTER IS FIXTURE-ONLY AND CANNOT BE OTHERWISE: no organizer has
// authorised KIDS FUN, so gate 1 fails and gate 3 has nothing to satisfy it.
// See config.ts's "HONEST ZERO" block — that is the measured outcome, not a stub.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { extractAgeWording } from '../../core/age';
import { VENUE_GEO_AUTHORITY } from '../../core/venue-geo-authority';
import {
  EVENTBRITE_ORGANIZERS,
  getEventbriteOrganizer,
  organizerTokenEnvVar,
  type EventbriteOrganizerConfig,
} from './config';
import { fetchOrganizerEvents, type EventbriteEvent } from './client';

/** Statuses that represent a real, publicly-listed event. Anything else is dropped. */
const INGESTABLE_STATUSES = new Set(['live', 'started']);

/** The env allow-list, parsed the same way every other family parses its own. */
function liveEnabledFor(organizerKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_EVENTBRITE ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(organizerKey.toLowerCase());
}

/**
 * The organizer's authorised token, or undefined. Read fresh on every call (never
 * cached into a module-level constant) so a rotated credential takes effect without a
 * redeploy, and so a test can prove the no-token path makes no request.
 */
export function organizerToken(config: EventbriteOrganizerConfig): string | undefined {
  const value = process.env[config.tokenEnvVar];
  return value && value.trim() ? value.trim() : undefined;
}

function textOf(value?: { text?: string | null } | null): string | undefined {
  const text = value?.text?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

/** Eventbrite prices arrive as `major_value` decimal strings ("12.00"). */
function majorValue(price?: { major_value?: string; value?: number } | null): number | undefined {
  if (price?.major_value != null) {
    const n = Number(price.major_value);
    if (Number.isFinite(n)) return n;
  }
  if (typeof price?.value === 'number' && Number.isFinite(price.value)) return price.value / 100;
  return undefined;
}

function coord(value?: string | null): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

interface CostFields {
  costMinCad?: number;
  costMaxCad?: number;
  costStatus: StructuredRecord['costStatus'];
}

/**
 * Cost, from the structured fields only. `is_free` is authoritative when true. When an
 * expanded ticket_availability is present its min/max are used verbatim. Otherwise the
 * record says `check_source` rather than guessing a number — the project's standing
 * posture on cost (never invent a price).
 */
function costFor(event: EventbriteEvent): CostFields {
  const availability = event.ticket_availability;
  if (event.is_free === true || availability?.is_free === true) {
    return { costMinCad: 0, costMaxCad: 0, costStatus: 'free' };
  }
  const min = majorValue(availability?.minimum_ticket_price);
  const max = majorValue(availability?.maximum_ticket_price);
  if (min != null || max != null) {
    return { costMinCad: min, costMaxCad: max ?? min, costStatus: 'known' };
  }
  return { costStatus: 'check_source' };
}

export class EventbriteAdapter implements Adapter {
  readonly family = 'eventbrite_organizer';

  constructor(private readonly config: EventbriteOrganizerConfig) {}

  /**
   * Live ONLY when all three in-process gates agree. (The fourth, the DB terms gate,
   * is enforced inside politeFetch and is deliberately not duplicated here — one
   * canonical implementation, per worker/health/policy.ts.)
   */
  isLiveFetchEnabled(): boolean {
    return (
      this.config.enabled === true &&
      liveEnabledFor(this.config.organizerKey) &&
      organizerToken(this.config) != null
    );
  }

  async fetch(): Promise<unknown[]> {
    if (!this.isLiveFetchEnabled()) return [fixtureEvent(this.config)];
    // Non-null by isLiveFetchEnabled() above; re-read rather than threaded through so
    // the token has exactly one origin (the env var named in config).
    const token = organizerToken(this.config)!;
    const { events } = await fetchOrganizerEvents(this.config, token);
    return events;
  }

  extract(raw: unknown[]): StructuredRecord[] {
    return (raw as EventbriteEvent[])
      .filter((e) => e && e.id && textOf(e.name) && e.start?.utc)
      // Cancelled/draft listings never enter the pipeline.
      .filter((e) => INGESTABLE_STATUSES.has((e.status ?? 'live').toLowerCase()))
      // ONLINE-ONLY events are dropped, deliberately and not silently: KIDS FUN answers
      // "what can we do, near us, at this time". An online event has no venue, no
      // distance and no travel time, so it cannot answer that question and would sit in
      // results as an un-filterable, un-rankable row. Dropping it here (rather than
      // ingesting a venue-less record) keeps the honest-coverage posture: we would
      // rather show nothing than show something the search cannot place.
      .filter((e) => e.online_event !== true)
      .map((e) => {
        const cost = costFor(e);
        const venue = e.venue ?? undefined;
        const venueName = venue?.name?.trim() || undefined;
        const address =
          venue?.address?.localized_address_display?.trim() ||
          [venue?.address?.address_1, venue?.address?.city, venue?.address?.region]
            .filter(Boolean)
            .join(', ') ||
          undefined;
        return {
          sourceRecordId: String(e.id),
          title: textOf(e.name)!,
          venueName,
          venueAddress: venueName ? address : undefined,
          venueLat: coord(venue?.latitude),
          venueLng: coord(venue?.longitude),
          // LIVE VENDOR PAYLOAD — same tier and same reasoning as perfectmind: Eventbrite's
          // API returns these as strings on every run, unreviewed, with nothing committed to
          // compare them against. Weakest claim in the system after the geocoder.
          venueGeoAuthority:
            coord(venue?.latitude) !== undefined && coord(venue?.longitude) !== undefined
              ? VENUE_GEO_AUTHORITY.LIVE_VENDOR_PAYLOAD
              : undefined,
          venueGeoSource:
            coord(venue?.latitude) !== undefined && coord(venue?.longitude) !== undefined
              ? 'eventbrite:api-venue'
              : undefined,
          venueMunicipalityName: venueName
            ? (venue?.address?.city?.trim() || this.config.municipality)
            : undefined,
          // Eventbrite returns an explicit UTC instant per event, so there is no
          // offset-less local wall-clock to resolve and worker/core/time.ts is
          // correctly not involved (using it would invent a conversion the payload
          // does not need). The event's own `start.timezone` is preserved in `raw`.
          startDatetimeUtc: e.start?.utc ?? undefined,
          endDatetimeUtc: e.end?.utc ?? undefined,
          ...cost,
          ageText: extractAgeWording(textOf(e.name), e.summary, textOf(e.description)),
          // No categoryHint: Eventbrite's own category ids are a different vocabulary
          // and mapping them by guesswork would fabricate certainty. The title-keyword
          // pass in worker/core/taxonomy.ts classifies these, and the confidence formula
          // correctly scores the result as a weaker parse signal than an explicit hint.
          sourceUrl: e.url ?? `https://www.eventbrite.ca/e/${e.id}`,
          bookingUrl: e.url ?? undefined,
          raw: e,
        } satisfies StructuredRecord;
      });
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `eventbrite_organizer::${this.config.organizerKey}::${record.sourceRecordId}` };
  }
}

/**
 * Shape-faithful synthetic payload for the non-live path. Deliberately synthetic (no
 * I/O, no network) so a fixture run has zero side effects; the documented-shape payload
 * that drives the contract tests lives in __fixtures__/organization-events.json.
 */
function fixtureEvent(config: EventbriteOrganizerConfig): EventbriteEvent {
  return {
    id: `${config.organizerKey}-fixture-1`,
    name: { text: 'Family Craft Drop-In' },
    summary: 'Drop-in craft session for ages 3-6 and their grown-ups.',
    description: { text: 'Drop-in craft session for ages 3-6 and their grown-ups.' },
    url: `https://www.eventbrite.ca/o/${config.organizerKey}`,
    start: { timezone: config.timezone, local: '2026-08-12T10:00:00', utc: '2026-08-12T17:00:00Z' },
    end: { timezone: config.timezone, local: '2026-08-12T11:30:00', utc: '2026-08-12T18:30:00Z' },
    status: 'live',
    is_free: true,
    online_event: false,
    organization_id: config.organizationId,
    venue: {
      id: 'fixture-venue',
      name: `${config.organizerName} Hall`,
      address: { city: config.municipality, region: 'BC' },
    },
  };
}

/** Instantiate every configured organizer adapter (today: none — see config.ts). */
export function loadEventbriteAdapters(
  configs: EventbriteOrganizerConfig[] = EVENTBRITE_ORGANIZERS
): EventbriteAdapter[] {
  return configs.map((config) => new EventbriteAdapter(config));
}

export { EVENTBRITE_ORGANIZERS, getEventbriteOrganizer, organizerTokenEnvVar };
export type { EventbriteOrganizerConfig };
