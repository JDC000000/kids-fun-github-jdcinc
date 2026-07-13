import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { runTermsGatedIngest } from '../../worker/core/source-runner';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('Terms-gated source ingest runner safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  it('does not call live fetch when the live env is set but source terms are not approved', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'rpl';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'source-rpl',
            family: 'library_bibliocommons',
            name: 'Richmond Public Library BiblioEvents',
            terms_status: 'pending',
            robots_status: 'allowed',
          },
        ],
      })),
    };

    const result = await runTermsGatedIngest(pool as never, { id: 'source-rpl' }, 'staging');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('live fetch blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasDb)('Terms-gated source ingest runner (G-T5/D-6 staging slice)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('runs a fixture-safe staging ingest for a seeded adapter-backed source', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `SELECT id FROM source
       WHERE family = 'library_bibliocommons'
         AND name = 'Richmond Public Library BiblioEvents'
       LIMIT 1`
    );

    const previousLiveSystems = process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    try {
      const result = await runTermsGatedIngest(pool, { id: source.id }, 'staging');

      expect(result.ok).toBe(true);
      expect(result.gate.allowed).toBe(true);
      expect(result.gate.reason).toContain('staging review');
      expect(result.adapterFamily).toBe('library');
      expect(result.summary?.recordsFound).toBeGreaterThan(0);
      expect(result.summary?.occurrencesUpserted).toBeGreaterThan(0);
    } finally {
      if (previousLiveSystems) process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = previousLiveSystems;
    }
  });

  it('does not run a source explicitly blocked by terms status', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status)
       VALUES ('library_bibliocommons', $1, 'blocked')
       RETURNING id`,
      [`Blocked Library ${crypto.randomUUID()}`]
    );

    const result = await runTermsGatedIngest(pool, { id: source.id }, 'staging');

    expect(result.ok).toBe(false);
    expect(result.gate.allowed).toBe(false);
    expect(result.error).toContain('staging blocked');
  });
});
