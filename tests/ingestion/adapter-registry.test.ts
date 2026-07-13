import { describe, it, expect, afterAll } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { buildAdapterRegistry, resolveAdapterForSource, resolveAdapterForSourceRow } from '../../worker/core/adapter-registry';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('source→adapter registry (G-T5/G-T7-G-T9)', () => {
  it('maps configured source rows to the correct fixture-safe adapter families', () => {
    const registry = buildAdapterRegistry();

    expect(resolveAdapterForSourceRow({ family: 'activenet', name: 'City of Vancouver ActiveNet' }, registry)?.family).toBe('activenet');
    expect(resolveAdapterForSourceRow({ family: 'perfectmind', name: 'City of Richmond PerfectMind' }, registry)?.family).toBe('perfectmind');
    expect(resolveAdapterForSourceRow({ family: 'library_bibliocommons', name: 'Richmond Public Library BiblioEvents' }, registry)?.family).toBe('library');
    expect(resolveAdapterForSourceRow({ family: 'library_communico', name: 'Coquitlam Public Library Communico' }, registry)?.family).toBe('library');
    expect(resolveAdapterForSourceRow({ family: 'venue_html', name: 'Science World' }, registry)).toBeNull();
  });
});

describe.skipIf(!hasDb)('source→adapter registry DB lookup', () => {
  afterAll(async () => {
    await closePool();
  });

  it('resolves seeded source_id values without duplicating the ingestion framework', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `SELECT id FROM source WHERE family = 'perfectmind' AND name = 'NVRC (North Vancouver) PerfectMind' LIMIT 1`
    );

    const adapter = await resolveAdapterForSource(pool, source.id);

    expect(adapter?.family).toBe('perfectmind');
  });
});
