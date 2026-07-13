import { describe, it, expect, afterAll } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { runTermsGatedIngest } from '../../worker/core/source-runner';

const hasDb = Boolean(process.env.DATABASE_URL);

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

    const result = await runTermsGatedIngest(pool, { id: source.id }, 'staging');

    expect(result.ok).toBe(true);
    expect(result.gate.allowed).toBe(true);
    expect(result.gate.reason).toContain('staging review');
    expect(result.adapterFamily).toBe('library');
    expect(result.summary?.recordsFound).toBeGreaterThan(0);
    expect(result.summary?.occurrencesUpserted).toBeGreaterThan(0);
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
