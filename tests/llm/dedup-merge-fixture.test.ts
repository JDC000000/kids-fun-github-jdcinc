// tests/llm/dedup-merge-fixture.test.ts — G-T14-4: the canonical-merge fixture (FR-17/BR-16).
//
// Proves the REAL provenance-preserving merge (lib/llm/dedup-merge.ts, G-T14-3): the SAME
// real-world activity ingested from Eventbrite + an official municipal source + an editorial
// blog collapses into ONE canonical listing that RETAINS every source's provenance — the
// exact gap the Round-25 "archive the loser" merge left open. DB-gated (skipped without
// DATABASE_URL); zero network (merge is deterministic, no LLM).
//
// Verify (scope-to-task G-T14-4 / G-T14-3):
//   • fixture merges the triple to a single canonical listing;
//   • the merged occurrence keeps ≥2 (here 3) provenance rows from DISTINCT sources;
//   • the duplicates are archived and no provenance is lost;
//   • the merge is idempotent / concurrency-safe (no double-move) and fail-closed
//     (won't merge into an archived canonical, won't merge a record into itself).
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { mergeOccurrences } from '../../lib/llm/dedup-merge';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'yy-dedup-merge';
const TAG = () => `yy-${randomUUID().slice(0, 8)}`;

type Authority = 'official' | 'editorial' | 'partner' | 'manual';

interface Seeded {
  occId: string;
  sourceId: string;
}

async function seedOcc(opts: { tag: string; suffix: string; authority: Authority; name: string; startIso: string }): Promise<Seeded> {
  const [src] = await query<{ id: string }>(
    `INSERT INTO source (family, name, authority_tier) VALUES ($1, $2, $3) RETURNING id`,
    [FAMILY, `${opts.tag}-${opts.suffix}`, opts.authority]
  );
  const [ser] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
    [`${opts.name} [${opts.tag}-${opts.suffix}]`, src.id]
  );
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, $3::timestamptz, 'needs_review') RETURNING id`,
    [ser.id, opts.name, opts.startIso]
  );
  return { occId: occ.id, sourceId: src.id };
}

interface ProvSpec {
  field: string;
  sourceUrl: string;
  sourceFamily: string;
  factOrigin?: 'source' | 'llm_normalised' | 'manual_override';
}
async function addProvenance(occId: string, rows: ProvSpec[]): Promise<void> {
  for (const r of rows) {
    await query(
      `INSERT INTO provenance (occurrence_id, field, source_url, source_family, fact_origin)
         VALUES ($1, $2, $3, $4, $5)`,
      [occId, r.field, r.sourceUrl, r.sourceFamily, r.factOrigin ?? 'source']
    );
  }
}

async function occRow(id: string) {
  const [row] = await query<{ archived_at: string | null; dedup_key: string | null; status_state: string }>(
    `SELECT archived_at, dedup_key, status_state::text AS status_state FROM activity_occurrence WHERE id = $1`,
    [id]
  );
  return row;
}
async function provFamilies(occId: string): Promise<string[]> {
  const rows = await query<{ sf: string }>(
    `SELECT DISTINCT source_family AS sf FROM provenance WHERE occurrence_id = $1 AND source_family IS NOT NULL ORDER BY 1`,
    [occId]
  );
  return rows.map((r) => r.sf);
}
async function provCount(occId: string): Promise<number> {
  const [row] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM provenance WHERE occurrence_id = $1`, [occId]);
  return Number(row.n);
}

describe.skipIf(!hasDb)('dedup canonical merge — provenance preservation (real Postgres)', () => {
  afterAll(async () => {
    try {
      await query(
        `DELETE FROM provenance WHERE occurrence_id IN (
           SELECT o.id FROM activity_occurrence o
             JOIN activity_series ser ON ser.id = o.series_id
             JOIN source s ON s.id = ser.source_id
            WHERE s.family = $1)`,
        [FAMILY]
      );
      await query(
        `DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1))`,
        [FAMILY]
      );
      await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1)`, [FAMILY]);
      await query(`DELETE FROM source WHERE family = $1`, [FAMILY]);
    } finally {
      await closePool();
    }
  });

  it('collapses the Eventbrite + official + editorial triple into one canonical, preserving all three sources’ provenance', async () => {
    const tag = TAG();
    const start = '2026-10-01T15:00:00.000Z';

    // Same real-world activity, three sources, three (fuzzily) different titles.
    const official = await seedOcc({ tag, suffix: 'official', authority: 'official', name: 'Toddler Storytime Circle', startIso: start });
    const editorial = await seedOcc({ tag, suffix: 'editorial', authority: 'editorial', name: 'Toddler Storytime', startIso: start });
    const eventbrite = await seedOcc({ tag, suffix: 'eventbrite', authority: 'partner', name: 'Storytime Circle (Toddlers)', startIso: start });

    await addProvenance(official.occId, [
      { field: 'activity_name', sourceUrl: 'https://recreation.city.example/p/12345', sourceFamily: 'official-city' },
      { field: 'start_datetime_utc', sourceUrl: 'https://recreation.city.example/p/12345', sourceFamily: 'official-city' },
    ]);
    await addProvenance(editorial.occId, [
      { field: 'activity_name', sourceUrl: 'https://familyblog.example/best-storytimes', sourceFamily: 'editorial-blog' },
      { field: 'description_snippet', sourceUrl: 'https://familyblog.example/best-storytimes', sourceFamily: 'editorial-blog' },
    ]);
    await addProvenance(eventbrite.occId, [
      { field: 'activity_name', sourceUrl: 'https://eventbrite.example/e/98765', sourceFamily: 'eventbrite' },
      { field: 'booking_url', sourceUrl: 'https://eventbrite.example/e/98765', sourceFamily: 'eventbrite' },
    ]);

    // Canonical = the official record (highest authority). Merge the two lower-authority
    // duplicates into it.
    const r1 = await mergeOccurrences(official.occId, editorial.occId);
    expect(r1.status).toBe('merged');
    expect(r1.provenanceMoved).toBe(2);

    const r2 = await mergeOccurrences(official.occId, eventbrite.occId);
    expect(r2.status).toBe('merged');
    expect(r2.provenanceMoved).toBe(2);
    expect(r2.canonicalSourceFamilies).toBe(3);

    // The canonical survives, is stamped, and carries the UNION of all three sources.
    const canon = await occRow(official.occId);
    expect(canon.archived_at).toBeNull();
    expect(canon.dedup_key).toBe(`dedup:v1:${official.occId}`);
    expect(await provFamilies(official.occId)).toEqual(['editorial-blog', 'eventbrite', 'official-city']);
    expect(await provCount(official.occId)).toBe(6);
    // AC (G-T14-3): the merged occurrence keeps ≥2 provenance rows from distinct sources.
    expect((await provFamilies(official.occId)).length).toBeGreaterThanOrEqual(2);

    // Both duplicates are archived; their provenance moved off them (nothing lost).
    expect((await occRow(editorial.occId)).archived_at).not.toBeNull();
    expect((await occRow(eventbrite.occId)).archived_at).not.toBeNull();
    expect(await provCount(editorial.occId)).toBe(0);
    expect(await provCount(eventbrite.occId)).toBe(0);
  });

  it('is idempotent / concurrency-safe: re-merging an already-archived duplicate is a no-op (no double-move)', async () => {
    const tag = TAG();
    const start = '2026-10-02T15:00:00.000Z';
    const official = await seedOcc({ tag, suffix: 'official', authority: 'official', name: 'Music & Movement', startIso: start });
    const dup = await seedOcc({ tag, suffix: 'partner', authority: 'partner', name: 'Music and Movement', startIso: start });
    await addProvenance(dup.occId, [{ field: 'activity_name', sourceUrl: 'https://eventbrite.example/e/222', sourceFamily: 'eventbrite' }]);

    const first = await mergeOccurrences(official.occId, dup.occId);
    expect(first.status).toBe('merged');
    const canonAfterFirst = await provCount(official.occId);
    expect(canonAfterFirst).toBe(1);

    const again = await mergeOccurrences(official.occId, dup.occId);
    expect(again.status).toBe('duplicate_already_archived');
    expect(again.provenanceMoved).toBe(0);
    expect(await provCount(official.occId)).toBe(canonAfterFirst); // unchanged — no double-move
  });

  it('refuses to merge into an archived canonical (fail-closed); duplicate is left untouched', async () => {
    const tag = TAG();
    const start = '2026-10-03T15:00:00.000Z';
    const official = await seedOcc({ tag, suffix: 'official', authority: 'official', name: 'Lego Club', startIso: start });
    const dup = await seedOcc({ tag, suffix: 'partner', authority: 'partner', name: 'LEGO Club', startIso: start });
    await addProvenance(dup.occId, [{ field: 'activity_name', sourceUrl: 'https://eventbrite.example/e/333', sourceFamily: 'eventbrite' }]);

    await query(`UPDATE activity_occurrence SET archived_at = now() WHERE id = $1`, [official.occId]);
    const res = await mergeOccurrences(official.occId, dup.occId);
    expect(res.status).toBe('canonical_archived');
    // Duplicate not claimed, its provenance intact.
    expect((await occRow(dup.occId)).archived_at).toBeNull();
    expect(await provCount(dup.occId)).toBe(1);
  });

  it('reports canonical_not_found for a missing canonical and leaves the duplicate untouched', async () => {
    const tag = TAG();
    const start = '2026-10-04T15:00:00.000Z';
    const dup = await seedOcc({ tag, suffix: 'partner', authority: 'partner', name: 'Coding for Kids', startIso: start });
    const res = await mergeOccurrences(randomUUID(), dup.occId);
    expect(res.status).toBe('canonical_not_found');
    expect((await occRow(dup.occId)).archived_at).toBeNull();
  });

  it('throws on a self-merge (canonical === duplicate)', async () => {
    const tag = TAG();
    const start = '2026-10-05T15:00:00.000Z';
    const one = await seedOcc({ tag, suffix: 'official', authority: 'official', name: 'Swim Lessons', startIso: start });
    await expect(mergeOccurrences(one.occId, one.occId)).rejects.toThrow(/itself/);
  });

  it('does not re-create a provenance fact the canonical already holds identically (append-only, no redundant row)', async () => {
    const tag = TAG();
    const start = '2026-10-06T15:00:00.000Z';
    const official = await seedOcc({ tag, suffix: 'official', authority: 'official', name: 'Nature Walk', startIso: start });
    const dup = await seedOcc({ tag, suffix: 'partner', authority: 'partner', name: 'Nature Walk', startIso: start });

    // An identical DERIVED fact both records carry (same field + source_url + fact_origin).
    const shared: ProvSpec = { field: 'age_band', sourceUrl: 'https://derived.example/normalise', sourceFamily: 'llm', factOrigin: 'llm_normalised' };
    await addProvenance(official.occId, [
      { field: 'activity_name', sourceUrl: 'https://recreation.city.example/p/nw', sourceFamily: 'official-city' },
      shared,
    ]);
    await addProvenance(dup.occId, [
      shared, // exact duplicate of the canonical's — must NOT be re-created on merge
      { field: 'booking_url', sourceUrl: 'https://eventbrite.example/e/444', sourceFamily: 'eventbrite' },
    ]);

    const res = await mergeOccurrences(official.occId, dup.occId);
    expect(res.status).toBe('merged');
    // Only the non-duplicate (booking_url) fact moved; the identical shared fact was skipped.
    expect(res.provenanceMoved).toBe(1);
    // Canonical holds exactly ONE copy of the shared fact (no duplication introduced).
    const [copies] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM provenance WHERE occurrence_id = $1 AND field = $2 AND source_url = $3 AND fact_origin = $4`,
      [official.occId, shared.field, shared.sourceUrl, shared.factOrigin]
    );
    expect(Number(copies.n)).toBe(1);
    // The skipped identical row stays on the archived duplicate (never deleted).
    expect(await provCount(dup.occId)).toBe(1);
  });
});
