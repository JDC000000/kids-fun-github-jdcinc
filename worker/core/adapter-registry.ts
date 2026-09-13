// worker/core/adapter-registry.ts — source→adapter registry for the ingest poll loop.
// Maps DB source rows (family+name from supabase/seeds/sources.sql) to the
// configured fixture-safe adapter instances. This does not enable live fetching;
// terms/live-source enablement remains gated by G-T5-6/D-6 and each adapter's
// fetch() remains fixture-only until its live wiring task lands.
import type { Pool } from 'pg';
import type { Adapter } from './adapter';
import { ActiveNetAdapter, ACTIVENET_TENANTS } from '../adapters/activenet';
import { createActivityAgeStore, type ActivityAgeStore } from '../adapters/activenet/activity-age-store';
import { PerfectMindAdapter, PERFECTMIND_TENANTS } from '../adapters/perfectmind';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../adapters/library';
import { CityCalendarAdapter, CITY_CALENDARS } from '../adapters/citycalendar';
import { EventbriteAdapter, EVENTBRITE_ORGANIZERS } from '../adapters/eventbrite';
import { VenueAdapter, LAUNCH_VENUES } from '../adapters/venue';

export interface SourceRegistryRow {
  id: string;
  family: string;
  name: string;
}

function key(family: string, name: string): string {
  return `${family}::${name}`;
}

export interface AdapterRegistryOptions {
  /** Cross-run activity-age answers. Supplied on the live path (which has a pool); omitted by
   *  fixture and test callers, where the adapter falls back to per-run memory only. */
  activityAgeStore?: ActivityAgeStore;
}

/** Build the in-memory source registry from adapter config. */
export function buildAdapterRegistry(opts: AdapterRegistryOptions = {}): Map<string, Adapter> {
  const registry = new Map<string, Adapter>();

  for (const tenant of ACTIVENET_TENANTS) {
    registry.set(key('activenet', tenant.sourceName), new ActiveNetAdapter(tenant, {}, opts.activityAgeStore));
  }
  for (const tenant of PERFECTMIND_TENANTS) {
    registry.set(key('perfectmind', tenant.sourceName), new PerfectMindAdapter(tenant));
  }
  for (const system of LIBRARY_SYSTEMS) {
    registry.set(key(system.sourceFamily, system.sourceName), new LibraryAdapter(system));
  }
  for (const calendar of CITY_CALENDARS) {
    registry.set(key(calendar.sourceFamily, calendar.sourceName), new CityCalendarAdapter(calendar));
  }
  // G-T10-2. EVENTBRITE_ORGANIZERS is empty today — no organizer has authorised
  // KIDS FUN (see worker/adapters/eventbrite/config.ts), so this registers NOTHING and
  // the seeded `eventbrite_organizer` placeholder source correctly resolves to null,
  // exactly as Science World's unbuilt venue row does. The loop exists so onboarding an
  // authorised organizer stays a DATA change (one config entry) rather than a code one.
  for (const organizer of EVENTBRITE_ORGANIZERS) {
    registry.set(key(organizer.sourceFamily, organizer.sourceName), new EventbriteAdapter(organizer));
  }
  for (const venue of LAUNCH_VENUES) {
    registry.set(key(venue.sourceFamily, venue.sourceName), new VenueAdapter(venue));
  }

  return registry;
}

export function resolveAdapterForSourceRow(
  source: Pick<SourceRegistryRow, 'family' | 'name'>,
  registry = buildAdapterRegistry()
): Adapter | null {
  return registry.get(key(source.family, source.name)) ?? null;
}

/** Resolve a DB source_id into an Adapter for makeTermsGatedIngestJobHandler(). */
export async function resolveAdapterForSource(
  pool: Pool,
  sourceId: string,
  registry = buildAdapterRegistry({ activityAgeStore: createActivityAgeStore(pool) })
): Promise<Adapter | null> {
  const { rows } = await pool.query<SourceRegistryRow>(
    `SELECT id, family, name FROM source WHERE id = $1`,
    [sourceId]
  );
  if (rows.length === 0) return null;
  return resolveAdapterForSourceRow(rows[0], registry);
}
