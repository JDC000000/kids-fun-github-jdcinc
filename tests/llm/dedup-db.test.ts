// tests/llm/dedup-db.test.ts — G-T14-2 against real Postgres (DB-gated; skipped without
// DATABASE_URL). Exercises detection, the transactional apply (auto-merge / route-to-review
// / skip) with idempotency, and one end-to-end run with the FAKE client (zero network).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import {
  applyDedupDecision,
  detectDedupCandidates,
  runDedupUseCase,
  type DedupCandidate,
  type DedupDecision,
} from '../../lib/llm/dedup';
import { JOB_NAMES } from '../../lib/llm/config';
import { FakeAnthropicBatchClient, type BatchRequest } from '../../lib/llm/anthropic-client';

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = () => `vv-dedup-${randomUUID().slice(0, 8)}`;

interface Seeded {
  occId: string;
}
async function seedOccurrence(opts: {
  tag: string;
  sourceSuffix: string;
  authority: 'official' | 'partner';
  name: string;
  startIso: string;
}): Promise<Seeded> {
  const [src] = await query<{ id: string }>(
    `INSERT INTO source (family, name, authority_tier) VALUES ('vvtest', $1, $2) RETURNING id`,
    [`${opts.tag}-${opts.sourceSuffix}`, opts.authority]
  );
  const [ser] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
    [`${opts.name} [${opts.tag}-${opts.sourceSuffix}]`, src.id]
  );
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, $3::timestamptz, 'needs_review') RETURNING id`,
    [ser.id, opts.name, opts.startIso]
  );
  return { occId: occ.id };
}

function candidateFor(leftId: string, rightId: string, det: number): DedupCandidate {
  const customId = `dedup-${leftId}`;
  const mk = (id: string, authority: string) => ({
    id,
    name: 'Toddler Storytime Circle',
    description: null,
    sourceName: 's',
    authorityTier: authority,
    confidenceLabel: 'unscored',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  return { left: mk(leftId, 'partner'), right: mk(rightId, 'official'), startUtc: null, deterministicScore: det, customId };
}

async function occ(id: string) {
  const [row] = await query<{ status_state: string; archived_at: string | null; dedup_key: string | null }>(
    `SELECT status_state::text AS status_state, archived_at, dedup_key FROM activity_occurrence WHERE id = $1`,
    [id]
  );
  return row;
}

describe.skipIf(!hasDb)('dedup adjudication (real Postgres)', () => {
  beforeEach(async () => {
    await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);
  });
  afterAll(async () => {
    try {
      await query(`DELETE FROM llm_batch_decision WHERE job_name = $1`, [JOB_NAMES.dedup]);
      await query(`DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'vvtest'))`);
      await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = 'vvtest')`);
      await query(`DELETE FROM source WHERE family = 'vvtest'`);
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);
    } finally {
      await closePool();
    }
  });

  it('detects a same-start, cross-source, similar-title pair as a candidate', async () => {
    const tag = TAG();
    const start = '2026-09-01T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Storytime ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Storytime ${tag}`, startIso: start });
    const candidates = await detectDedupCandidates(500);
    const mine = candidates.find((c) => [c.left.id, c.right.id].includes(a.occId) && [c.left.id, c.right.id].includes(b.occId));
    expect(mine).toBeTruthy();
    expect(mine!.deterministicScore).toBeGreaterThanOrEqual(0.55);
    // custom_id must satisfy Anthropic's required pattern.
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(mine!.customId)).toBe(true);
  });

  it('AUTO-MERGE archives the duplicate, stamps the canonical dedup_key, and is idempotent', async () => {
    const tag = TAG();
    const start = '2026-09-02T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Music ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Music ${tag}`, startIso: start });
    // canonical = higher authority (official = a); duplicate = b.
    const cand = candidateFor(a.occId, b.occId, 0.9);
    const decision: DedupDecision = { action: 'auto_merge', canonicalId: a.occId, duplicateId: b.occId, deterministicScore: 0.9, llmConfidence: 0.95, reason: 'same' };

    expect(await applyDedupDecision(cand, decision)).toBe(true);
    expect((await occ(b.occId)).archived_at).not.toBeNull();
    expect((await occ(a.occId)).dedup_key).toBe(`dedup:v1:${a.occId}`);
    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM llm_batch_decision WHERE target_id = $1 AND action = 'auto_merge'`, [b.occId]);
    expect(Number(n)).toBe(1);

    // Idempotent: re-apply archives nothing new.
    expect(await applyDedupDecision(cand, decision)).toBe(false);
  });

  it('ROUTE-TO-REVIEW flags the duplicate as manual_candidate (surfaces in the QA queue), idempotently', async () => {
    const tag = TAG();
    const start = '2026-09-03T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Art ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Art ${tag}`, startIso: start });
    const cand = candidateFor(a.occId, b.occId, 0.5);
    const decision: DedupDecision = { action: 'route_to_review', canonicalId: a.occId, duplicateId: b.occId, deterministicScore: 0.5, llmConfidence: 0.7, reason: 'maybe' };

    expect(await applyDedupDecision(cand, decision)).toBe(true);
    expect((await occ(b.occId)).status_state).toBe('manual_candidate');
    expect((await occ(b.occId)).archived_at).toBeNull(); // NOT merged — just flagged
    expect(await applyDedupDecision(cand, decision)).toBe(false); // already flagged
  });

  it('SKIP mutates nothing but records the decision', async () => {
    const tag = TAG();
    const start = '2026-09-04T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Swim ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Lane ${tag}`, startIso: start });
    const cand = candidateFor(a.occId, b.occId, 0.6);
    const decision: DedupDecision = { action: 'skip', canonicalId: a.occId, duplicateId: b.occId, deterministicScore: 0.6, llmConfidence: 0.9, reason: 'distinct' };

    expect(await applyDedupDecision(cand, decision)).toBe(false);
    expect((await occ(b.occId)).status_state).toBe('needs_review'); // untouched
    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM llm_batch_decision WHERE target_id = $1 AND action = 'skip'`, [b.occId]);
    expect(Number(n)).toBe(1);
  });

  it('runs end-to-end with the fake client: my pair auto-merges; a second run does not re-touch it', async () => {
    const tag = TAG();
    const start = '2026-09-05T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Dance ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Dance ${tag}`, startIso: start });
    // Detection collapses the symmetric pair to the row with the smaller (fresh) left id.
    const myKey = `dedup-${a.occId < b.occId ? a.occId : b.occId}`;

    // Residue-safe responder: only MY pair is a duplicate; everything else is a confident
    // NON-duplicate → skip (no mutation of any other suite's rows).
    const client = new FakeAnthropicBatchClient({
      responder: (r: BatchRequest) =>
        r.custom_id === myKey
          ? { isDuplicate: true, confidence: 0.97, reason: 'same' }
          : { isDuplicate: false, confidence: 0.99, reason: 'distinct' },
    });

    const res = await runDedupUseCase(client, { dryRun: false, pollIntervalMs: 0 });
    expect(res.submitted).toBe(true);
    expect(res.autoMerged).toBeGreaterThanOrEqual(1);
    expect((await occ(b.occId)).archived_at).not.toBeNull();
    expect((await occ(a.occId)).dedup_key).toBe(`dedup:v1:${a.occId}`);

    // Second run: watermark advanced + my records now terminal → nothing to re-do for them.
    const res2 = await runDedupUseCase(client, { dryRun: false, pollIntervalMs: 0 });
    expect(res2.considered).toBe(0);
  });

  it('dry-run detects but writes nothing', async () => {
    const tag = TAG();
    const start = '2026-09-06T18:00:00.000Z';
    const a = await seedOccurrence({ tag, sourceSuffix: 'a', authority: 'official', name: `Yoga ${tag}`, startIso: start });
    const b = await seedOccurrence({ tag, sourceSuffix: 'b', authority: 'partner', name: `Yoga ${tag}`, startIso: start });
    const client = new FakeAnthropicBatchClient({ responder: () => ({ isDuplicate: true, confidence: 0.99, reason: 'x' }) });
    const res = await runDedupUseCase(client, { dryRun: true, pollIntervalMs: 0 });
    expect(res.submitted).toBe(false);
    expect((await occ(a.occId)).dedup_key).toBeNull();
    expect((await occ(b.occId)).archived_at).toBeNull();
    expect(client.submitted).toHaveLength(0);
  });
});
