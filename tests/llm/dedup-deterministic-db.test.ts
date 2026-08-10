// tests/llm/dedup-deterministic-db.test.ts — Option D (deterministic dedup → human review)
// against real Postgres. DB-gated; skipped without DATABASE_URL.
//
// C2 IS THE LOAD-BEARING CASE AND IT RUNS FIRST. The whole option rests on a premise that
// was INFERRED from code and never executed: that an llm_batch_decision row written with NO
// model and NO confidence (llm_confidence IS NULL) still (a) renders as a dedup pair in
// /admin/qa-queue and (b) satisfies confirmDedupMerge's guard — i.e. does NOT come back
// not_a_pair. tests/admin/qa-queue-dedup-db.test.ts only ever writes llm_confidence = 0.74,
// so the null case had no coverage anywhere in the tree. If C2 is false, Option D needs a
// schema or UI change it was scoped not to need.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { confirmDedupMerge, listReviewQueue } from '@/app/admin/qa-queue/_lib/data';
import { recordDecision } from '@/lib/llm/watermark';
import { JOB_NAMES } from '@/lib/llm/config';
import { detectDedupCandidates, runDedupDetectOnlyUseCase } from '@/lib/llm/dedup';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'test_optd_dedup';
const START = '2026-12-11T18:00:00Z';
/** A second instant, so the C2 fixtures can never collide with the live-run fixtures. */
const START_RUN = '2026-12-12T18:00:00Z';

async function seedOcc(
  name: string,
  authority: string,
  status: string,
  suffix: string,
  opts: { startIso?: string; venueName?: string } = {}
): Promise<string> {
  const [src] = await query<{ id: string }>(
    // terms_status='allowed' — the 0021 invariant refuses a 'confirmed' occurrence whose
    // source has not had its terms approved.
    `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status)
       VALUES ($1, $2, $3, 'auto', 'allowed') RETURNING id`,
    [FAMILY, `${name} src ${suffix}`, authority]
  );
  let venueId: string | null = null;
  if (opts.venueName) {
    const [v] = await query<{ id: string }>(`INSERT INTO venue (name) VALUES ($1) RETURNING id`, [
      `${opts.venueName} [${FAMILY}]`,
    ]);
    venueId = v.id;
  }
  const [ser] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${name} series ${suffix}`, src.id, venueId]
  );
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, $3::timestamptz, $4::status_state) RETURNING id`,
    [ser.id, name, opts.startIso ?? START, status]
  );
  return occ.id;
}

/** Occurrence id → status_state for every live row, so a table-wide run can be undone. */
async function liveStatuses(): Promise<Map<string, string>> {
  const rows = await query<{ id: string; status_state: string }>(
    `SELECT id, status_state::text AS status_state FROM activity_occurrence WHERE archived_at IS NULL`
  );
  return new Map(rows.map((r) => [r.id, r.status_state]));
}

async function archivedCount(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM activity_occurrence WHERE archived_at IS NOT NULL`
  );
  return Number(row.n);
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM llm_batch_decision
      WHERE target_id IN (
        SELECT o.id FROM activity_occurrence o
          JOIN activity_series ser ON ser.id = o.series_id
          JOIN source s ON s.id = ser.source_id
         WHERE s.family = $1)`,
    [FAMILY]
  );
  await query(
    `DELETE FROM provenance WHERE occurrence_id IN (
       SELECT o.id FROM activity_occurrence o
         JOIN activity_series ser ON ser.id = o.series_id
         JOIN source s ON s.id = ser.source_id
        WHERE s.family = $1)`,
    [FAMILY]
  );
  await query(
    `DELETE FROM activity_occurrence WHERE series_id IN (
       SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1))`,
    [FAMILY]
  );
  await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1)`, [FAMILY]);
  await query(`DELETE FROM source WHERE family = $1`, [FAMILY]);
  await query(`DELETE FROM venue WHERE name LIKE $1`, [`%[${FAMILY}]`]);
}

describe.skipIf(!hasDb)('Option D — deterministic dedup routed to review (real Postgres)', () => {
  let adminId = '';
  let canonId = '';
  let dupId = '';

  beforeAll(async () => {
    await cleanup();
    const [admin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);

    canonId = await seedOcc('Preschool Storytime', 'official', 'confirmed', 'canon');
    dupId = await seedOcc('Preschool Storytime', 'official', 'manual_candidate', 'dup');
  });

  afterAll(async () => {
    try {
      await cleanup();
      // admin_audit_log FKs the admin row, so the audit trail this suite wrote must go first.
      await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    } finally {
      await closePool();
    }
  });

  // ── C2 — the stop condition, proven by execution rather than by reading the SQL ────────
  it('C2: a NULL-confidence decision row renders in the QA queue and merges — not not_a_pair', async () => {
    // Written through the SAME recordDecision the deterministic path uses, with NO
    // llmConfidence at all (undefined → bound as null) and NO model anywhere in sight.
    await recordDecision({
      jobName: JOB_NAMES.dedup,
      useCase: 'dedup',
      targetId: dupId,
      relatedId: canonId,
      customId: `dedup-${dupId}`,
      action: 'route_to_review',
      deterministicScore: 0.71,
      detail: { reason: 'Deterministic blocking match; no model consulted.', suspectedDuplicateOf: canonId },
    });

    const [stored] = await query<{ llm_confidence: number | null }>(
      `SELECT llm_confidence FROM llm_batch_decision WHERE target_id = $1 AND action = 'route_to_review'`,
      [dupId]
    );
    expect(stored).toBeTruthy();
    expect(stored.llm_confidence).toBeNull(); // the premise under test, not an incidental

    // (a) it RENDERS as a dedup pair.
    const queue = await listReviewQueue(500);
    const mine = queue.find((r) => r.id === dupId);
    expect(mine, 'null-confidence dedup row must appear in the QA queue').toBeTruthy();
    expect(mine!.dedup, 'must render as a dedup PAIR, not a generic single record').toBeTruthy();
    expect(mine!.dedup!.canonicalId).toBe(canonId);
    expect(mine!.dedup!.llmConfidence).toBeNull();
    expect(mine!.dedup!.deterministicScore).toBeCloseTo(0.71, 5);
    // canonicalAvailable false would withdraw the merge affordance from the UI.
    expect(mine!.dedup!.canonicalAvailable, 'merge must be offered to the reviewer').toBe(true);

    // (b) the human merge guard ACCEPTS it.
    const merged = await confirmDedupMerge(dupId, canonId, 'C2 probe', adminId);
    expect(merged.ok, `confirmDedupMerge refused: ${merged.ok ? '' : merged.reason}`).toBe(true);
  });

  // ── C3 + C4 — the whole run, against the deployed schema, archiving nothing ────────────
  //
  // The fixtures are built to the exact shape production actually contains: an identical
  // title at an identical start instant, published by two DIFFERENT official sources, at two
  // DIFFERENT venues. That pair scores well above the 0.55 auto-merge bar — i.e. it is one of
  // the 40 that an enabled auto-merge would destroy — and the assertions below are what makes
  // "we routed it instead" a measured fact rather than an intention.
  describe('a full deterministic run', () => {
    let rplId = '';
    let vplId = '';
    let archivedBefore = 0;
    let statusesBefore = new Map<string, string>();
    let result: Awaited<ReturnType<typeof runDedupDetectOnlyUseCase>>;

    beforeAll(async () => {
      // Both 'official' — mirrors supabase/seeds/sources.sql, where all four live sources
      // share authority_tier='official' and chooseCanonical's authority tie-break is inert.
      rplId = await seedOcc('Babytime Drop-In', 'official', 'needs_review', 'rpl', {
        startIso: START_RUN,
        venueName: 'Brighouse Branch',
      });
      vplId = await seedOcc('Babytime Drop-In', 'official', 'needs_review', 'vpl', {
        startIso: START_RUN,
        venueName: 'Kitsilano Branch',
      });

      // A first run must consider everything: clear this job's watermark.
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);
      archivedBefore = await archivedCount();
      statusesBefore = await liveStatuses();

      result = await runDedupDetectOnlyUseCase();

      // detectDedupCandidates is table-wide, so this run can legitimately route OTHER
      // suites' fixtures too. Put every row that is not mine back exactly as it was, so this
      // file cannot become the cause of a neighbouring suite's failure.
      const after = await liveStatuses();
      for (const [id, before] of statusesBefore) {
        if (id === rplId || id === vplId) continue;
        if (after.get(id) !== before) {
          await query(`UPDATE activity_occurrence SET status_state = $2::status_state WHERE id = $1`, [id, before]);
          await query(`DELETE FROM llm_batch_decision WHERE target_id = $1 AND job_name = $2`, [id, JOB_NAMES.dedup]);
        }
      }
    });

    it('C3: the shipped detector executes against the deployed schema (0019 present)', async () => {
      // watermarkPredicate reads llm_batch_run — a missing 0019 THROWS here rather than
      // returning zero rows, so a non-empty result is the schema check.
      const candidates = await detectDedupCandidates(500);
      expect(Array.isArray(candidates)).toBe(true);
      expect(result.considered).toBeGreaterThan(0); // non-vacuous: it really saw the pair
    });

    it('routes the cross-source pair to a human and submits nothing', async () => {
      expect(result.mode).toBe('deterministic');
      expect(result.submitted).toBe(false);
      expect(result.routedToReview).toBeGreaterThan(0);
      expect(result.actioned).toBeGreaterThan(0);

      const [flagged] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activity_occurrence
          WHERE id = ANY($1::uuid[]) AND status_state = 'manual_candidate' AND archived_at IS NULL`,
        [[rplId, vplId]]
      );
      expect(Number(flagged.n), 'exactly one side of the pair is flagged for review').toBe(1);
    });

    it('C4: archives NOTHING — the archived count is unchanged across the run', async () => {
      expect(await archivedCount()).toBe(archivedBefore);
      const [live] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activity_occurrence WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [[rplId, vplId]]
      );
      expect(Number(live.n), 'both real events survive the run').toBe(2);
    });

    it('C4: writes no auto_merge decision and stamps no dedup_key', async () => {
      expect(result.autoMerged).toBe(0);
      const [merges] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM llm_batch_decision WHERE job_name = $1 AND action = 'auto_merge'`,
        [JOB_NAMES.dedup]
      );
      expect(Number(merges.n)).toBe(0);
      const [stamped] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activity_occurrence WHERE id = ANY($1::uuid[]) AND dedup_key IS NOT NULL`,
        [[rplId, vplId]]
      );
      expect(Number(stamped.n), 'dedup_key is written only by a merge').toBe(0);
    });

    it('scores the pair ABOVE the auto-merge bar and routes it anyway', async () => {
      const [row] = await query<{ deterministic_score: number | null; llm_confidence: number | null; action: string }>(
        `SELECT deterministic_score, llm_confidence, action FROM llm_batch_decision
          WHERE job_name = $1 AND target_id = ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 1`,
        [JOB_NAMES.dedup, [rplId, vplId]]
      );
      expect(row).toBeTruthy();
      expect(row.action).toBe('route_to_review');
      // Identical titles: this is the 40-pair production shape, comfortably over 0.55.
      expect(row.deterministic_score).toBeGreaterThan(0.55);
      expect(row.llm_confidence, 'no model ran, so no confidence may be recorded').toBeNull();
    });

    it('surfaces the venue disagreement to the reviewer instead of acting on it', async () => {
      // The FLAGGED side is the one carrying the pairing. Both fixtures happen to sit in a
      // REVIEW_STATE here, and the canonical is the older row, so a naive find() by id would
      // return the canonical's generic (dedup-less) queue entry instead.
      const [flagged] = await query<{ id: string }>(
        `SELECT id FROM activity_occurrence
          WHERE id = ANY($1::uuid[]) AND status_state = 'manual_candidate' AND archived_at IS NULL`,
        [[rplId, vplId]]
      );
      expect(flagged, 'one side was routed to review').toBeTruthy();
      const queue = await listReviewQueue(500);
      const mine = queue.find((r) => r.id === flagged.id);
      expect(mine, 'the routed pair reaches the human queue').toBeTruthy();
      expect(mine!.dedup).toBeTruthy();
      expect(mine!.dedup!.llmConfidence).toBeNull();
      expect(mine!.dedup!.canonicalAvailable).toBe(true);
      // The reason is what the QA queue actually renders (detail->>'reason').
      expect(mine!.dedup!.reason).toContain('DIFFERENT venue rows');
      expect(mine!.dedup!.reason).toMatch(/no model was consulted/i);

      // …and it is recorded structurally too, so the pairs a human adjudicates become a
      // queryable labelled set — the eval artefact that does not exist today and that any
      // future model-based adjudication would have to be measured against.
      const [decision] = await query<{ venue_signal: string | null }>(
        `SELECT detail->>'venueSignal' AS venue_signal FROM llm_batch_decision
          WHERE target_id = $1 AND action = 'route_to_review' ORDER BY created_at DESC LIMIT 1`,
        [flagged.id]
      );
      expect(decision.venue_signal).toBe('different_venue');
    });

    it('records the run as deterministic in the shared watermark row', async () => {
      const [run] = await query<{ last_status: string | null; records_considered: number }>(
        `SELECT last_status, records_considered FROM llm_batch_run WHERE job_name = $1`,
        [JOB_NAMES.dedup]
      );
      expect(run).toBeTruthy();
      expect(run.last_status).toBe('ok_deterministic');
      expect(run.records_considered).toBe(result.considered);
    });

    it('is idempotent: a second run re-routes nothing (the pair has left the pool)', async () => {
      const before = await archivedCount();
      const second = await runDedupDetectOnlyUseCase();
      expect(second.autoMerged).toBe(0);
      expect(await archivedCount()).toBe(before);
      const [stillFlagged] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activity_occurrence
          WHERE id = ANY($1::uuid[]) AND status_state = 'manual_candidate' AND archived_at IS NULL`,
        [[rplId, vplId]]
      );
      expect(Number(stillFlagged.n)).toBe(1);
    });

    it('dry-run counts without routing anything new', async () => {
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);
      const before = await liveStatuses();
      const dry = await runDedupDetectOnlyUseCase({ dryRun: true });
      expect(dry.routedToReview).toBe(0);
      expect(dry.actioned).toBe(0);
      expect(dry.autoMerged).toBe(0);
      const after = await liveStatuses();
      for (const [id, state] of before) expect(after.get(id)).toBe(state);
      const [run] = await query<{ last_status: string | null }>(
        `SELECT last_status FROM llm_batch_run WHERE job_name = $1`,
        [JOB_NAMES.dedup]
      );
      expect(run.last_status).toBe('dry_run_deterministic');
    });
  });
});
