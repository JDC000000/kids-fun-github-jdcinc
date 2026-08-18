// tests/llm/age-db.test.ts — G-T13-5 against real Postgres (DB-gated). Exercises detection
// of the deterministic parser's unresolved residue, the transactional apply (resolve /
// no-op) with band-overlap matching + idempotency, and a dry-run of the use case.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { applyAgeDecision, detectAgeCandidates, runAgeUseCase, type AgeCandidate, type AgeDecision } from '../../lib/llm/age-fallback';
import { JOB_NAMES } from '../../lib/llm/config';
import { FakeAnthropicBatchClient } from '../../lib/llm/anthropic-client';
import { isAdultOrSeniorOnly } from '../../lib/search/filters/audience';

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = () => `vv-age-${randomUUID().slice(0, 8)}`;

async function seedUnresolved(tag: string, name: string, rawAge: string): Promise<string> {
  const [src] = await query<{ id: string }>(`INSERT INTO source (family, name) VALUES ('vvtest', $1) RETURNING id`, [`${tag}-src`]);
  const [ser] = await query<{ id: string }>(`INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`, [`${name} [${tag}]`, src.id]);
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, now(), 'needs_review') RETURNING id`,
    [ser.id, name]
  );
  await query(
    `INSERT INTO occurrence_age (occurrence_id, age_min_months, age_max_months, age_band_matches, age_notes)
       VALUES ($1, NULL, NULL, '{}', $2)`,
    [occ.id, `unresolved: ${rawAge}`]
  );
  return occ.id;
}

async function ageRow(occId: string) {
  const [row] = await query<{ age_min_months: number | null; age_max_months: number | null; age_notes: string; age_band_matches: string[] }>(
    `SELECT age_min_months, age_max_months, age_notes, age_band_matches FROM occurrence_age WHERE occurrence_id = $1`,
    [occId]
  );
  return row;
}

describe.skipIf(!hasDb)('age-parse fallback (real Postgres)', () => {
  beforeEach(async () => {
    await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.age]);
  });
  afterAll(async () => {
    try {
      await query(`DELETE FROM llm_batch_decision WHERE job_name = $1`, [JOB_NAMES.age]);
      await query(`DELETE FROM occurrence_age WHERE occurrence_id IN (SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id JOIN source src ON src.id = s.source_id WHERE src.family = 'vvtest')`);
      await query(`DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'vvtest'))`);
      await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'vvtest')`);
      await query(`DELETE FROM source WHERE family = 'vvtest'`);
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.age]);
    } finally {
      await closePool();
    }
  });

  it('detects a deterministic-parser residue row and recovers the raw wording', async () => {
    const tag = TAG();
    const occId = await seedUnresolved(tag, `Camp ${tag}`, 'walkers to grade three-ish');
    const found = (await detectAgeCandidates(500)).find((c) => c.occurrenceId === occId);
    expect(found).toBeTruthy();
    expect(found!.rawAgeText).toBe('walkers to grade three-ish');
    expect(found!.customId).toBe(`age-${occId}`);
    // custom_id must satisfy Anthropic's required pattern.
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(found!.customId)).toBe(true);
  });

  it('APPLIES a confident resolution: writes bounds, overlapping band matches, and a terminal note; idempotent', async () => {
    const tag = TAG();
    const occId = await seedUnresolved(tag, `Kinder ${tag}`, 'K through grade 3');
    const cand: AgeCandidate = { occurrenceId: occId, activityName: 'x', rawAgeText: 'K through grade 3', customId: `age:${occId}` };
    const decision: AgeDecision = { action: 'apply', ageMinMonths: 60, ageMaxMonths: 108, llmConfidence: 0.85, reason: 'K–3' };

    expect(await applyAgeDecision(cand, decision)).toBe(true);
    const row = await ageRow(occId);
    expect(row.age_min_months).toBe(60);
    expect(row.age_max_months).toBe(108);
    // The source's own wording survives the resolve, verbatim and first; the model's reason is
    // recorded on the llm_batch_decision row instead of overwriting the source (see
    // stampAgeNotes and tests/llm/age-provenance.test.ts).
    expect(row.age_notes).toBe('K through grade 3 (llm-resolved)');
    expect(row.age_band_matches.length).toBeGreaterThanOrEqual(1);
    // Every matched band genuinely overlaps [60,108).
    const bands = await query<{ lo: number; hi: number | null }>(
      `SELECT lower_months_inclusive AS lo, upper_months_exclusive AS hi FROM age_band WHERE id = ANY($1::uuid[])`,
      [row.age_band_matches]
    );
    for (const b of bands) expect(b.lo < 108 && (b.hi ?? Infinity) > 60).toBe(true);

    // Idempotent: the unresolved-guard now fails → no second write.
    expect(await applyAgeDecision(cand, decision)).toBe(false);
    expect((await ageRow(occId)).age_min_months).toBe(60);
  });

  it('NO-OP leaves the bounds null but stamps a terminal marker so it is not reprocessed', async () => {
    const tag = TAG();
    const occId = await seedUnresolved(tag, `Poster ${tag}`, 'see poster for details');
    const cand: AgeCandidate = { occurrenceId: occId, activityName: 'x', rawAgeText: 'see poster for details', customId: `age:${occId}` };
    const decision: AgeDecision = { action: 'no_op', ageMinMonths: null, ageMaxMonths: null, llmConfidence: 0.3, reason: 'no info' };

    expect(await applyAgeDecision(cand, decision)).toBe(false);
    const row = await ageRow(occId);
    expect(row.age_min_months).toBeNull();
    expect(row.age_notes).toBe('see poster for details (llm-unresolved)');
    // No longer detected (dropped off the 'unresolved:%' worklist).
    expect((await detectAgeCandidates(500)).find((c) => c.occurrenceId === occId)).toBeUndefined();
  });

  it('KEEPS the adult/senior hard exclusion working on a row it resolves', async () => {
    // The defect this test exists for: the apply branch used to replace the source's own
    // audience wording with the model's reasoning, and lib/search/filters/audience.ts reads
    // exactly that field to decide whether adult-only programming is removed from a kids app.
    // A resolved row therefore stopped being excluded — silently, and only for rows the LLM had
    // touched. Asserted end-to-end here (real UPDATE → real read → real filter), because the
    // format contract lives in the SQL parameter, not in a helper.
    const tag = TAG();
    const name = `Overdose Response Basics ${tag}`;
    const raw = 'International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English';
    const occId = await seedUnresolved(tag, name, raw);

    const before = await ageRow(occId);
    const asListing = (r: Awaited<ReturnType<typeof ageRow>>) => ({
      activityName: name,
      ageMinMonths: r.age_min_months,
      ageMaxMonths: r.age_max_months,
      ageNotes: r.age_notes,
    });
    expect(isAdultOrSeniorOnly(asListing(before))).toBe(true);

    const cand: AgeCandidate = { occurrenceId: occId, activityName: name, rawAgeText: raw, customId: `age-${occId}` };
    // A CONFIDENT and WRONG resolution — the shape that hurts. The bounds say "kids"; the
    // source says "Adults". The source's claim must still win.
    const decision: AgeDecision = { action: 'apply', ageMinMonths: 24, ageMaxMonths: 60, llmConfidence: 0.95, reason: 'Reads as an all-ages community talk.' };
    expect(await applyAgeDecision(cand, decision)).toBe(true);

    const after = await ageRow(occId);
    expect(after.age_min_months).toBe(24);
    expect(after.age_notes.startsWith(raw)).toBe(true);
    expect(after.age_notes).not.toContain('all-ages community talk');
    expect(isAdultOrSeniorOnly(asListing(after))).toBe(true);
  });

  it('keeps the same exclusion working on a row it declines to resolve (no_op)', async () => {
    // The no_op branch already re-embedded the raw text, but under an `llm-unresolved: ` PREFIX
    // that AGE_NOTES_MARKER does not step over — so the tag anchor never reached "Adults" and
    // this path silently lost the exclusion too. Same stamp, same guarantee.
    const tag = TAG();
    const name = `Tech Help ${tag}`;
    const raw = 'Digital Essentials, Computer & Technology Training, Adults, Seniors, English';
    const occId = await seedUnresolved(tag, name, raw);
    const cand: AgeCandidate = { occurrenceId: occId, activityName: name, rawAgeText: raw, customId: `age-${occId}` };

    expect(await applyAgeDecision(cand, { action: 'no_op', ageMinMonths: null, ageMaxMonths: null, llmConfidence: 0.2, reason: 'ambiguous' })).toBe(false);

    const row = await ageRow(occId);
    expect(row.age_notes.startsWith(raw)).toBe(true);
    expect(isAdultOrSeniorOnly({ activityName: name, ageMinMonths: row.age_min_months, ageMaxMonths: row.age_max_months, ageNotes: row.age_notes })).toBe(true);
  });

  it('dry-run detects but writes nothing', async () => {
    const tag = TAG();
    const occId = await seedUnresolved(tag, `Dry ${tag}`, 'ages unclear');
    const client = new FakeAnthropicBatchClient({ responder: () => ({ resolved: true, ageMinMonths: 0, ageMaxMonths: 24, confidence: 0.99, reason: 'x' }) });
    const res = await runAgeUseCase(client, { dryRun: true, pollIntervalMs: 0 });
    expect(res.submitted).toBe(false);
    expect((await ageRow(occId)).age_notes.startsWith('unresolved')).toBe(true);
    expect(client.submitted).toHaveLength(0);
  });
});
