// worker/core/adapter-registry.ts — source→adapter registry for the ingest poll loop.
// Maps DB source rows (family+name from supabase/seeds/sources.sql) to the
// configured fixture-safe adapter instances. This does not enable live fetching;
// terms/live-source enablement remains gated by G-T5-6/D-6 and each adapter's
// fetch() remains fixture-only until its live wiring task lands.
import type { Pool } from 'pg';
import type { Adapter } from './adapter';
import { ActiveNetAdapter, ACTIVENET_TENANTS } from '../adapters/activenet';
import { PerfectMindAdapter, PERFECTMIND_TENANTS } from '../adapters/perfectmind';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../adapters/library';

export interface SourceRegistryRow {
  id: string;
  family: string;
  name: string;
}

function key(family: string, name: string): string {
  return `${family}::${name}`;
}

/** Build the in-memory source registry from adapter config. */
export function buildAdapterRegistry(): Map<string, Adapter> {
  const registry = new Map<string, Adapter>();

  for (const tenant of ACTIVENET_TENANTS) {
    registry.set(key('activenet', tenant.sourceName), new ActiveNetAdapter(tenant));
  }
  for (const tenant of PERFECTMIND_TENANTS) {
    registry.set(key('perfectmind', tenant.sourceName), new PerfectMindAdapter(tenant));
  }
  for (const system of LIBRARY_SYSTEMS) {
    registry.set(key(system.sourceFamily, system.sourceName), new LibraryAdapter(system));
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
  registry = buildAdapterRegistry()
): Promise<Adapter | null> {
  const { rows } = await pool.query<SourceRegistryRow>(
    `SELECT id, family, name FROM source WHERE id = $1`,
    [sourceId]
  );
  if (rows.length === 0) return null;
  return resolveAdapterForSourceRow(rows[0], registry);
}
