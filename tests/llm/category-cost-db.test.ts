// tests/llm/category-cost-db.test.ts — G-T13-5 category/cost extension against real Postgres
// (DB-gated). Exercises detection of the deterministic residue (generic-fallback category +
// unknown cost), the transactional per-field apply with idempotent guards, the audit-trail
// anti-join that makes a decided record terminal, a dry-run, and an end-to-end pass through the
// FAKE Anthropic batch client (no live network). Includes the adversarial low-confidence no-op.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import {
  applyCategoryCostDecision,
  buildCategoryCostRequest,
  decideCategoryCost,
  detectCategoryCostCandidates,
  runCategoryCostUseCase,
  type CategoryCostCandidate,
  type CategoryCostDecision,
} from '../../lib/llm/category-cost-fallback';
import { JOB_NAMES } from '../../lib/llm/config';
import { FakeAnthropicBatchClient } from '../../lib/llm/anthropic-client';
import { runBatch } from '../../lib/llm/batch';
import { parseCategoryCostVerdict, textOf } from '../../lib/llm/prompts';

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = () => `cc-${randomUUID().slice(0, 8)}`;

/** Seed one occurrence in the "residue" state: generic title, null category, unknown cost. */
async function seedResidue(tag: string, name: string, description: string | null): Promise<string> {
  const [src] = await query<{ id: string }>(`INSERT INTO source (family, name) VALUES ('cctest', $1) RETURNING id`, [`${tag}-src`]);
  const [ser] = await query<{ id: string }>(`INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`, [`${name} [${tag}]`, src.id]);
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, description_snippet, start_datetime_utc, status_state, cost_status, primary_category_id)
       VALUES ($1, $2, $3, now(), 'needs_review', 'unknown', NULL) RETURNING id`,
    [ser.id, name, description]
  );
  return occ.id;
}

async function occRow(occId: string) {
  const [row] = await query<{ primary_category_id: string | null; cost_status: string; cost_min_cad: string | null; cost_max_cad: string | null }>(
    `SELECT primary_category_id, cost_status::text AS cost_status, cost_min_cad, cost_max_cad FROM activity_occurrence WHERE id = $1`,
    [occId]
  );
  return row;
}

async function categoryId(key: string): Promise<string> {
  const [row] = await query<{ id: string }>(`SELECT id FROM category WHERE key = $1`, [key]);
  return row.id;
}

const decision = (over: Partial<CategoryCostDecision> = {}): CategoryCostDecision => ({
  applyCategory: false,
  categoryKey: null,
  categoryConfidence: null,
  applyCost: false,
  costStatus: null,
  costMinCad: null,
  costMaxCad: null,
  costConfidence: null,
  reason: 'test',
  ...over,
});

describe.skipIf(!hasDb)('category+cost fallback (real Postgres)', () => {
  beforeEach(async () => {
    await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.categoryCost]);
    await query(`DELETE FROM llm_batch_decision WHERE job_name = $1`, [JOB_NAMES.categoryCost]);
  });
  afterAll(async () => {
    try {
      await query(`DELETE FROM llm_batch_decision WHERE job_name = $1`, [JOB_NAMES.categoryCost]);
      await query(`DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'cctest'))`);
      await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'cctest')`);
      await query(`DELETE FROM source WHERE family = 'cctest'`);
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.categoryCost]);
    } finally {
      await closePool();
    }
  });

  it('detects a generic-fallback / unknown-cost residue row and flags both fields as needed', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'A get-together.');
    const found = (await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId);
    expect(found).toBeTruthy();
    expect(found!.needsCategory).toBe(true);
    expect(found!.needsCost).toBe(true);
    expect(found!.customId).toBe(`catcost-${occId}`);
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(found!.customId)).toBe(true);
  });

  it('does NOT flag category for a title the deterministic classifier resolves specifically', async () => {
    const tag = TAG();
    // "Swim" classifies to public_swim (specific) — category is trustworthy; only cost is unknown.
    const occId = await seedResidue(tag, `Family Swim ${tag}`, null);
    const found = (await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId);
    expect(found).toBeTruthy();
    expect(found!.needsCategory).toBe(false);
    expect(found!.needsCost).toBe(true);
  });

  it('APPLIES a confident category (writes primary_category_id) and is idempotent; becomes terminal', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'Stories and songs.');
    const storyId = await categoryId('storytime');
    const cand: CategoryCostCandidate = {
      occurrenceId: occId,
      activityName: 'x',
      description: null,
      needsCategory: true,
      needsCost: false,
      currentCategoryId: null,
      customId: `catcost-${occId}`,
    };
    expect(await applyCategoryCostDecision(cand, decision({ applyCategory: true, categoryKey: 'storytime', categoryConfidence: 0.95 }))).toBe(true);
    expect((await occRow(occId)).primary_category_id).toBe(storyId);

    // Idempotent: the guard (still-null category) now fails → no second write.
    expect(await applyCategoryCostDecision(cand, decision({ applyCategory: true, categoryKey: 'storytime', categoryConfidence: 0.95 }))).toBe(false);
    expect((await occRow(occId)).primary_category_id).toBe(storyId);

    // Terminal: a decision now exists → the anti-join drops it from detection.
    expect((await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId)).toBeUndefined();
  });

  it('APPLIES a confident known cost (writes status + bounds); leaves category untouched when not needed', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'Admission $8–$20.');
    const cand: CategoryCostCandidate = {
      occurrenceId: occId,
      activityName: 'x',
      description: null,
      needsCategory: false,
      needsCost: true,
      currentCategoryId: null,
      customId: `catcost-${occId}`,
    };
    expect(await applyCategoryCostDecision(cand, decision({ applyCost: true, costStatus: 'known', costMinCad: 8, costMaxCad: 20, costConfidence: 0.9 }))).toBe(true);
    const row = await occRow(occId);
    expect(row.cost_status).toBe('known');
    expect(Number(row.cost_min_cad)).toBe(8);
    expect(Number(row.cost_max_cad)).toBe(20);
    expect(row.primary_category_id).toBeNull();

    // Idempotent: cost is no longer 'unknown' → guard fails → no second write.
    expect(await applyCategoryCostDecision(cand, decision({ applyCost: true, costStatus: 'known', costMinCad: 1, costMaxCad: 1, costConfidence: 0.9 }))).toBe(false);
    expect(Number((await occRow(occId)).cost_min_cad)).toBe(8);
  });

  it('NO-OP writes nothing but records a terminal decision so the record is not reprocessed', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, null);
    const cand: CategoryCostCandidate = {
      occurrenceId: occId,
      activityName: 'x',
      description: null,
      needsCategory: true,
      needsCost: true,
      currentCategoryId: null,
      customId: `catcost-${occId}`,
    };
    expect(await applyCategoryCostDecision(cand, decision())).toBe(false); // pure no-op decision
    const row = await occRow(occId);
    expect(row.primary_category_id).toBeNull();
    expect(row.cost_status).toBe('unknown');
    // A no-op decision row exists → terminal (dropped from detection by the anti-join).
    const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM llm_batch_decision WHERE job_name = $1 AND target_id = $2 AND action = 'no_op'`, [JOB_NAMES.categoryCost, occId]);
    expect(Number(n)).toBe(1);
    expect((await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId)).toBeUndefined();
  });

  it('end-to-end via the FAKE client: request → parse → decide → apply (category + cost)', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'Free storytime drop-in.');
    const cand = (await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId)!;
    const storyId = await categoryId('storytime');

    const client = new FakeAnthropicBatchClient({
      responder: (req) =>
        req.custom_id === cand.customId
          ? { primaryCategory: 'storytime', categoryConfidence: 0.95, costStatus: 'free', costMinCad: 0, costMaxCad: 0, costConfidence: 0.95, reason: 'free library storytime' }
          : {},
    });
    const outcome = await runBatch(client, [buildCategoryCostRequest(cand)], { pollIntervalMs: 0 });
    const item = outcome.results.get(cand.customId)!;
    const verdict = parseCategoryCostVerdict(item.result.type === 'succeeded' ? textOf(item.result.message.content) : null);
    const dec = decideCategoryCost(cand, verdict);
    expect(await applyCategoryCostDecision(cand, dec)).toBe(true);

    const row = await occRow(occId);
    expect(row.primary_category_id).toBe(storyId);
    expect(row.cost_status).toBe('free');
    expect(Number(row.cost_min_cad)).toBe(0);
  });

  it('ADVERSARIAL: a low-confidence verdict routes to a no-op — nothing is written', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'Maybe a class of some kind?');
    const cand = (await detectCategoryCostCandidates(500)).find((c) => c.occurrenceId === occId)!;

    const client = new FakeAnthropicBatchClient({
      responder: (req) =>
        req.custom_id === cand.customId
          ? { primaryCategory: 'indoor_play', categoryConfidence: 0.4, costStatus: 'known', costMinCad: 10, costMaxCad: 10, costConfidence: 0.4, reason: 'unsure' }
          : {},
    });
    const outcome = await runBatch(client, [buildCategoryCostRequest(cand)], { pollIntervalMs: 0 });
    const item = outcome.results.get(cand.customId)!;
    const verdict = parseCategoryCostVerdict(item.result.type === 'succeeded' ? textOf(item.result.message.content) : null);
    const dec = decideCategoryCost(cand, verdict);
    expect(dec.applyCategory).toBe(false);
    expect(dec.applyCost).toBe(false);
    expect(await applyCategoryCostDecision(cand, dec)).toBe(false);

    const row = await occRow(occId);
    expect(row.primary_category_id).toBeNull();
    expect(row.cost_status).toBe('unknown');
  });

  it('dry-run detects but writes nothing', async () => {
    const tag = TAG();
    const occId = await seedResidue(tag, `Neighbourhood Gathering ${tag}`, 'Free storytime.');
    const client = new FakeAnthropicBatchClient({ responder: () => ({ primaryCategory: 'storytime', categoryConfidence: 0.99, costStatus: 'free', costMinCad: 0, costMaxCad: 0, costConfidence: 0.99, reason: 'x' }) });
    const res = await runCategoryCostUseCase(client, { dryRun: true, pollIntervalMs: 0 });
    expect(res.submitted).toBe(false);
    const row = await occRow(occId);
    expect(row.primary_category_id).toBeNull();
    expect(row.cost_status).toBe('unknown');
    expect(client.submitted).toHaveLength(0);
  });
});
