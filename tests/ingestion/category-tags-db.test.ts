import { describe, it, expect, afterAll } from 'vitest';
import type { Adapter, StructuredRecord } from '../../worker/core/adapter';
import { ingestSource } from '../../worker/core/ingest';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// G-T13-3 — secondary categories + suitability tags are actually CLASSIFIED and
// WRITTEN into occurrence_category_tag at ingest time (the join table, its FTS
// re-index trigger and the read side all already existed; nothing in the ingest
// path ever populated it). Canonical AC (scope-to-task v1.1): "multi-category
// fixture (e.g. swim + toddler) assigns 1 primary + secondaries".
describe.skipIf(!hasDb)('Occurrence category-tag write side (G-T13-3)', () => {
  afterAll(async () => {
    await closePool();
  });

  // A genuinely overlapping fixture: primarily a swim, but ALSO an open-gym
  // drop-in — not a trivial single-category record.
  const multiCategoryRecord: StructuredRecord = {
    sourceRecordId: 'multi-cat-1',
    title: 'Family Swim & Open Gym Drop-in',
    categoryHint: 'public_swim',
    startDatetimeUtc: '2026-09-24T18:00:00.000Z',
    costStatus: 'free',
    sourceUrl: 'https://example.org/multi-cat',
  };

  function multiCategoryAdapter(): Adapter {
    return {
      family: 'library',
      fetch: async () => [multiCategoryRecord],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: () => ({ key: 'multi-cat' }),
    };
  }

  async function occurrenceIdForSource(sourceId: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `SELECT o.id FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       WHERE s.source_id = $1`,
      [sourceId]
    );
    return row.id;
  }

  it('assigns 1 primary + secondaries + suitability tags for an overlapping record', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('library_bibliocommons', $1) RETURNING id`,
      [`Multi Category Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(pool, multiCategoryAdapter(), source.id);
    expect(summary.errors).toEqual([]);
    expect(summary.secondaryCategoriesWritten).toBe(1); // open_gym
    expect(summary.suitabilityTagsWritten).toBe(2); // drop_in + free

    const occurrenceId = await occurrenceIdForSource(source.id);

    // Exactly ONE primary category on the occurrence itself.
    const [primary] = await query<{ key: string }>(
      `SELECT c.key FROM activity_occurrence o
       JOIN category c ON c.id = o.primary_category_id
       WHERE o.id = $1`,
      [occurrenceId]
    );
    expect(primary.key).toBe('public_swim');

    // Secondary categories live in occurrence_category_tag as category rows —
    // NOT the primary, and never duplicating it.
    const secondaryRows = await query<{ key: string }>(
      `SELECT c.key FROM occurrence_category_tag oct
       JOIN category c ON c.id = oct.category_id
       WHERE oct.occurrence_id = $1 AND oct.tag_type = 'category'
       ORDER BY c.key`,
      [occurrenceId]
    );
    expect(secondaryRows.map((r) => r.key)).toEqual(['open_gym']);

    // Suitability tags live in occurrence_category_tag as tag rows.
    const suitabilityRows = await query<{ key: string }>(
      `SELECT t.key FROM occurrence_category_tag oct
       JOIN tag t ON t.id = oct.tag_id
       WHERE oct.occurrence_id = $1 AND oct.tag_type = 'suitability'
       ORDER BY t.key`,
      [occurrenceId]
    );
    expect(suitabilityRows.map((r) => r.key)).toEqual(['drop_in', 'free']);

    // The 0010 FTS trigger re-indexed the occurrence when the suitability tags
    // were inserted: the 'free' lexeme comes ONLY from the tag label (it is not in
    // the activity name), so a match proves the write side now feeds the read/FTS
    // path end-to-end.
    const [tsv] = await query<{ has_free: boolean }>(
      `SELECT search_tsv @@ plainto_tsquery('english', 'free') AS has_free
       FROM activity_occurrence WHERE id = $1`,
      [occurrenceId]
    );
    expect(tsv.has_free).toBe(true);
  });

  it('is idempotent: re-ingesting the same record does not duplicate category-tag rows', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('library_bibliocommons', $1) RETURNING id`,
      [`Idempotent Category Source ${crypto.randomUUID()}`]
    );
    const adapter = multiCategoryAdapter();

    const first = await ingestSource(pool, adapter, source.id);
    const second = await ingestSource(pool, adapter, source.id);

    expect(first.secondaryCategoriesWritten).toBe(1);
    expect(first.suitabilityTagsWritten).toBe(2);
    // Second run hits ON CONFLICT DO NOTHING — no new rows written.
    expect(second.secondaryCategoriesWritten).toBe(0);
    expect(second.suitabilityTagsWritten).toBe(0);

    const occurrenceId = await occurrenceIdForSource(source.id);
    const [{ n }] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM occurrence_category_tag WHERE occurrence_id = $1`,
      [occurrenceId]
    );
    expect(Number(n)).toBe(3); // 1 secondary category + 2 suitability tags, still
  });
});
