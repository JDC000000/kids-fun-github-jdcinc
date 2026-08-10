// tests/llm/dedup-adjudication-db.test.ts — 0030: a human's "not a duplicate" verdict is
// DURABLE. DB-gated; skipped without DATABASE_URL.
//
// THE DEFECT THESE GUARD, restated so a failure here is readable without archaeology:
// rejectDedupPair sets status_state='confirmed' (which detectDedupCandidates' `fresh` CTE
// ACCEPTS — it excludes only 'manual_candidate') and bumps last_checked_at (which clears the
// incremental watermark). So before 0030 the act of dismissing a pair was exactly what
// re-qualified it, and the next run re-routed the pair the human had just dismissed.
//
// EACH TEST BELOW NAMES THE MUTATION THAT REDDENS IT. That is not decoration: three of these
// would pass against an implementation that is wrong in a way the obvious test cannot see.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { rejectDedupPair } from '@/app/admin/qa-queue/_lib/data';
import { JOB_NAMES } from '@/lib/llm/config';
import { chooseCanonical, decideDedupDeterministic, detectDedupCandidates, runDedupDetectOnlyUseCase } from '@/lib/llm/dedup';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'test_adjudication';
/** Distinct instants so each fixture group can only ever match within itself. */
const START_PAIR = '2027-03-04T17:00:00Z';
const START_TRIPLE = '2027-03-05T17:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const WATERMARK = '2021-01-01T00:00:00Z';

async function seedOcc(name: string, suffix: string, venueName: string, startIso: string): Promise<string> {
  const [src] = await query<{ id: string }>(
    // terms_status='allowed' — 0021's invariant refuses a 'confirmed' occurrence whose source
    // has not had its terms approved, and the reject path sets exactly that.
    `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status)
       VALUES ($1, $2, 'official', 'auto', 'allowed') RETURNING id`,
    [FAMILY, `${name} src ${suffix}`]
  );
  const [v] = await query<{ id: string }>(`INSERT INTO venue (name) VALUES ($1) RETURNING id`, [
    `${venueName} [${FAMILY}]`,
  ]);
  const [ser] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${name} series ${suffix}`, src.id, v.id]
  );
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, created_at)
       VALUES ($1, $2, $3::timestamptz, 'needs_review', $4::timestamptz) RETURNING id`,
    [ser.id, name, startIso, PAST]
  );
  return occ.id;
}

/**
 * Make EXACTLY the given rows watermark-fresh, and nothing else in the fixture set.
 * watermarkPredicate qualifies a row when greatest(created_at, coalesce(last_checked_at,
 * created_at)) > last_watermark; every fixture is created_at=PAST with a NULL last_checked_at,
 * so bumping last_checked_at on one row is the only thing that lifts it over WATERMARK.
 * This is what lets a test choose which occurrence lands on the JOIN's LEFT side.
 */
async function freshenOnly(ids: string[]): Promise<void> {
  await query(
    `UPDATE activity_occurrence SET last_checked_at = NULL
      WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1))`,
    [FAMILY]
  );
  if (ids.length > 0) {
    await query(`UPDATE activity_occurrence SET last_checked_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  }
  await query(
    `INSERT INTO llm_batch_run (job_name, last_watermark) VALUES ($1, $2::timestamptz)
       ON CONFLICT (job_name) DO UPDATE SET last_watermark = EXCLUDED.last_watermark`,
    [JOB_NAMES.dedup, WATERMARK]
  );
}

/** Candidate pairs among the fixture ids only — detectDedupCandidates is table-wide. */
async function fixturePairs(ids: string[]): Promise<string[]> {
  const set = new Set(ids);
  const cands = await detectDedupCandidates();
  return cands
    .filter((c) => set.has(c.left.id) && set.has(c.right.id))
    .map((c) => (c.left.id < c.right.id ? `${c.left.id}|${c.right.id}` : `${c.right.id}|${c.left.id}`));
}

async function occ(id: string) {
  const [row] = await query<{ status_state: string; last_checked_at: string | null }>(
    `SELECT status_state::text AS status_state, last_checked_at::text AS last_checked_at
       FROM activity_occurrence WHERE id = $1`,
    [id]
  );
  return row;
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM dedup_pair_adjudication WHERE occurrence_low IN (
       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
         JOIN source src ON src.id = s.source_id WHERE src.family = $1)
        OR occurrence_high IN (
       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
         JOIN source src ON src.id = s.source_id WHERE src.family = $1)`,
    [FAMILY]
  );
  await query(
    `DELETE FROM llm_batch_decision WHERE target_id IN (
       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
         JOIN source src ON src.id = s.source_id WHERE src.family = $1)`,
    [FAMILY]
  );
  await query(
    `DELETE FROM provenance WHERE occurrence_id IN (
       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
         JOIN source src ON src.id = s.source_id WHERE src.family = $1)`,
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

describe.skipIf(!hasDb)('0030 — a human dedup verdict is durable (real Postgres)', () => {
  let adminId = '';
  let pairA = '';
  let pairB = '';
  let tripleA = '';
  let tripleB = '';
  let tripleC = '';

  beforeAll(async () => {
    await cleanup();
    const [admin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);

    // Mirrors the measured production cohort: identical title, identical start instant, two
    // different official sources, two different venues (the Richmond x Vancouver library shape).
    pairA = await seedOcc('Babytime Drop-In', 'a', 'Brighouse Branch', START_PAIR);
    pairB = await seedOcc('Babytime Drop-In', 'b', 'Kitsilano Branch', START_PAIR);

    // A THREE-way cluster at a different instant, for the pair-scoping guard.
    tripleA = await seedOcc('Toddler Music Circle', 'ta', 'Ta Branch', START_TRIPLE);
    tripleB = await seedOcc('Toddler Music Circle', 'tb', 'Tb Branch', START_TRIPLE);
    tripleC = await seedOcc('Toddler Music Circle', 'tc', 'Tc Branch', START_TRIPLE);
  });

  afterAll(async () => {
    try {
      await cleanup();
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);
      await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    } finally {
      await closePool();
    }
  });

  // ── 1. THE DEFECT ITSELF, END TO END, THROUGH THE REAL RUNNER ────────────────────────────
  it('route → human reject → re-run does NOT re-route the pair (the rejection is durable)', async () => {
    // detectDedupCandidates is table-wide and runDedupDetectOnlyUseCase MUTATES, so this test
    // snapshots every other live row's status and restores it — otherwise this file becomes
    // the cause of a neighbour's failure in the serial db lane.
    const before = new Map(
      (
        await query<{ id: string; status_state: string }>(
          `SELECT id, status_state::text AS status_state FROM activity_occurrence WHERE archived_at IS NULL`
        )
      ).map((r) => [r.id, r.status_state])
    );

    try {
      await freshenOnly([pairA, pairB]);
      const run1 = await runDedupDetectOnlyUseCase();
      expect(run1.routedToReview).toBeGreaterThan(0);

      const [routed] = await query<{ target_id: string; related_id: string }>(
        `SELECT target_id, related_id FROM llm_batch_decision
          WHERE action = 'route_to_review' AND target_id = ANY($1::uuid[])
          ORDER BY created_at DESC LIMIT 1`,
        [[pairA, pairB]]
      );
      // A null result is not a match — assert the fixture actually routed before concluding.
      expect(routed, 'run 1 routed no fixture pair — fixture problem, not a finding').toBeTruthy();
      expect((await occ(routed.target_id)).status_state).toBe('manual_candidate');

      const rejected = await rejectDedupPair(routed.target_id, routed.related_id, 'Different branch.', adminId);
      expect(rejected.ok).toBe(true);
      expect((await occ(routed.target_id)).status_state).toBe('confirmed');

      // The verdict is stored order-canonically, keyed on the PAIR.
      const stored = await query<{ occurrence_low: string; occurrence_high: string; verdict: string }>(
        `SELECT occurrence_low, occurrence_high, verdict FROM dedup_pair_adjudication
          WHERE occurrence_low = least($1::uuid,$2::uuid) AND occurrence_high = greatest($1::uuid,$2::uuid)`,
        [routed.target_id, routed.related_id]
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].verdict).toBe('not_duplicate');

      // The reject's own last_checked_at bump is UNCHANGED and still clears the watermark —
      // deliberately not touched by this unit (it is also worker/health/stale.ts's staleness
      // input). Suppression must therefore hold WITHOUT any help from the watermark.
      expect((await occ(routed.target_id)).last_checked_at).not.toBeNull();
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB_NAMES.dedup]);

      const run2 = await runDedupDetectOnlyUseCase();
      expect(await fixturePairs([pairA, pairB])).toEqual([]);
      expect((await occ(routed.target_id)).status_state).toBe('confirmed'); // NOT flipped back
      expect(run2.considered).toBeGreaterThanOrEqual(0);

      // MUTATION THAT REDDENS THIS: delete the NOT EXISTS from detectDedupCandidates.
      // Verified — run 2 re-detects the pair and re-flips the row to 'manual_candidate'.
    } finally {
      for (const [id, status] of before) {
        await query(`UPDATE activity_occurrence SET status_state = $2::status_state WHERE id = $1`, [id, status]);
      }
    }
  });

  // ── 2. THE GUARD THE OBVIOUS TEST CANNOT SEE ─────────────────────────────────────────────
  it('suppression survives the pair arriving on EITHER side of the join (role/side swap)', async () => {
    // WHY THIS IS NOT AN ARGUMENT-ORDER TEST. chooseCanonical is order-INSENSITIVE for distinct
    // ids (rank() terminates in side.id), so calling it both ways proves nothing: an ORDERED
    // implementation passes that too, because the pure function never disagrees with itself.
    // What actually varies at runtime is which occurrence is watermark-FRESH and therefore
    // lands on the JOIN's LEFT side. freshenOnly() controls exactly that, so this drives the
    // real SQL with f and r swapped.
    const lo = pairA < pairB ? pairA : pairB;
    const hi = pairA < pairB ? pairB : pairA;
    expect(lo).not.toBe(hi);

    await query(`DELETE FROM dedup_pair_adjudication WHERE occurrence_low = $1 AND occurrence_high = $2`, [lo, hi]);

    // Sanity FIRST: with no verdict stored, BOTH directions must detect the pair. Without this
    // the test could pass vacuously — e.g. if the fixtures stopped matching at all.
    await freshenOnly([lo]);
    expect(await fixturePairs([pairA, pairB]), 'fixture stopped matching with lo fresh').toHaveLength(1);
    await freshenOnly([hi]);
    expect(await fixturePairs([pairA, pairB]), 'fixture stopped matching with hi fresh').toHaveLength(1);

    await query(
      `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict, decided_by)
       VALUES ($1, $2, 'not_duplicate', $3)`,
      [lo, hi, adminId]
    );

    // f.id < r.id — an ordered lookup would coincidentally match here.
    await freshenOnly([lo]);
    expect(await fixturePairs([pairA, pairB])).toEqual([]);

    // f.id > r.id — THIS is the direction an ordered lookup misses.
    // MUTATION THAT REDDENS THIS: replace the predicate's
    //   a.occurrence_low = least(f.id, r.id) AND a.occurrence_high = greatest(f.id, r.id)
    // with the ordered
    //   a.occurrence_low = f.id AND a.occurrence_high = r.id
    // MEASURED under that mutation, and the asymmetry is the point: the `lo` assertion above
    // stays GREEN while this one fails. A test that checked only one direction — the natural
    // way to write it — would therefore certify an ordered implementation as correct. Asserting
    // the two directions separately rather than in a loop is what keeps that visible in the
    // failure output.
    await freshenOnly([hi]);
    expect(await fixturePairs([pairA, pairB])).toEqual([]);
  });

  // ── 3. PAIR-SCOPED, NOT ROW-SCOPED ───────────────────────────────────────────────────────
  it('rejecting A-vs-B leaves A-vs-C detectable (a row marker would silently lose a real duplicate)', async () => {
    // The reason a "this row is done with dedup" column is WRONG rather than merely imprecise:
    // "A is not a duplicate of B" says nothing about A and C. A row-scoped marker discards a
    // genuine duplicate with no trace — an invisible false split.
    const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const [lo, hi] = tripleA < tripleB ? [tripleA, tripleB] : [tripleB, tripleA];

    // FRESHEN ONLY tripleA, so it is the sole possible LEFT side and the detector must choose
    // its ONE best right-hand match (DISTINCT ON (f.id)) from {tripleB, tripleC}. That makes
    // the assertion below exact rather than a set-membership hedge — and exactness is what
    // gives it teeth. An earlier version of this test freshened two rows and asserted only
    // "some pair survives"; it PASSED against a row-scoped marker, i.e. it was decoration.
    await freshenOnly([tripleA]);

    // Sanity first, and non-vacuously: before any verdict, tripleA IS detectable.
    await query(`DELETE FROM dedup_pair_adjudication WHERE occurrence_low = $1 AND occurrence_high = $2`, [lo, hi]);
    expect(await fixturePairs([tripleA, tripleB, tripleC]), 'tripleA undetectable before any verdict').toHaveLength(1);

    await query(
      `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict, decided_by)
       VALUES ($1, $2, 'not_duplicate', $3)`,
      [lo, hi, adminId]
    );

    // A is judged against B. It must STILL be detectable against C — and it must be C
    // specifically, because the A-B pair is filtered out before DISTINCT ON picks a winner.
    const pairs = await fixturePairs([tripleA, tripleB, tripleC]);
    expect(pairs).toEqual([key(tripleA, tripleC)]);
    // MUTATION THAT REDDENS THIS: replace the pair predicate with a ROW-scoped exclusion, e.g.
    //   AND NOT EXISTS (SELECT 1 FROM dedup_pair_adjudication a
    //                    WHERE o.id IN (a.occurrence_low, a.occurrence_high))
    // in the `fresh` CTE. MEASURED: tripleA leaves the candidate pool entirely, `pairs` comes
    // back [] and this fails. That is the whole argument against a row marker made executable —
    // the row is not "done with dedup", it is done with ONE counterpart.
  });

  // ── 4. THE VOCABULARY IS ENFORCED IN SQL, NOT IN A COMMENT ───────────────────────────────
  it('CHECK constraints reject an unknown verdict and a non-canonical key order', async () => {
    // 0019's `action` documents its vocabulary in a comment with no constraint, and that
    // vocabulary has already drifted (it names 'skip_low_confidence', which exists in no .ts
    // file, while the code writes 'skip'). This is the guard against building a second one.
    // Assert on the ERROR CODE, never on the row contents — a value comparison in a guard like
    // this copies whatever leaked into the CI log on the day the guard finally fires.
    await expect(
      query(
        `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict)
         VALUES (least($1::uuid,$2::uuid), greatest($1::uuid,$2::uuid), 'definitely_a_duplicate')`,
        [tripleB, tripleC]
      )
    ).rejects.toMatchObject({ code: '23514' }); // check_violation

    await expect(
      query(
        `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict)
         VALUES (greatest($1::uuid,$2::uuid), least($1::uuid,$2::uuid), 'not_duplicate')`,
        [tripleB, tripleC]
      )
    ).rejects.toMatchObject({ code: '23514' });

    // And the pair key is UNIQUE — which is what lets a re-adjudication RAISE rather than
    // silently write a second row. See rejectDedupPair for why raising is the chosen behaviour.
    await query(
      `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict)
       VALUES (least($1::uuid,$2::uuid), greatest($1::uuid,$2::uuid), 'not_duplicate')`,
      [tripleB, tripleC]
    );
    await expect(
      query(
        `INSERT INTO dedup_pair_adjudication (occurrence_low, occurrence_high, verdict)
         VALUES (least($1::uuid,$2::uuid), greatest($1::uuid,$2::uuid), 'not_duplicate')`,
        [tripleB, tripleC]
      )
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    // MUTATION THAT REDDENS ALL THREE: drop the corresponding constraint from 0030.
  });

  // ── 5. THE SAME PAIR ANSWERED FROM BOTH SIDES ────────────────────────────────────────────
  it('a role swap queues the pair twice; answering BOTH succeeds and leaves ONE verdict row', async () => {
    // This is the path that overturned the first conflict-behaviour ruling. An admin
    // confidence_label edit inverts chooseCanonical's roles, so the detector routes the OTHER
    // side too and the same unordered pair sits in the queue twice. Both are legitimate queue
    // items and both must be answerable — a raising INSERT would strand the second one at
    // 'manual_candidate' forever. Suppression stops future DETECTION; it does not retract a
    // status already flipped, so this state is normal rather than broken.
    const [lo, hi] = pairA < pairB ? [pairA, pairB] : [pairB, pairA];
    await query(`DELETE FROM dedup_pair_adjudication WHERE occurrence_low = $1 AND occurrence_high = $2`, [lo, hi]);
    await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);

    // Both directions routed — exactly what step 3 of the measured sequence produces.
    for (const [t, r] of [
      [pairA, pairB],
      [pairB, pairA],
    ]) {
      await query(
        `INSERT INTO llm_batch_decision (job_name, use_case, target_id, related_id, custom_id, action)
         VALUES ($1, 'dedup', $2, $3, $4, 'route_to_review')`,
        [JOB_NAMES.dedup, t, r, `dedup-${t}`]
      );
      await query(`UPDATE activity_occurrence SET status_state = 'manual_candidate' WHERE id = $1`, [t]);
    }

    const first = await rejectDedupPair(pairA, pairB, 'first side', adminId);
    const second = await rejectDedupPair(pairB, pairA, 'second side', adminId);
    expect(first.ok).toBe(true);
    expect(second.ok, 'the second presentation of the same pair must be answerable').toBe(true);

    // ONE verdict row, not two — the order-canonical key is what makes the second answer
    // recognise the first. Assert the COUNT, never the row contents.
    const [{ n }] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dedup_pair_adjudication WHERE occurrence_low = $1 AND occurrence_high = $2`,
      [lo, hi]
    );
    expect(n).toBe('1');

    // And it is not silent: the audit distinguishes which reject created the verdict.
    const audits = await query<{ after_json: { verdictRecorded: string } }>(
      `SELECT after_json FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at ASC`,
      [adminId, 'dedup.reject_merge']
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.after_json.verdictRecorded)).toEqual(['created', 'already_recorded']);
    // MUTATION THAT REDDENS THIS: drop the ON CONFLICT clause. MEASURED — the second reject
    // throws a unique violation, `second.ok` never becomes true, and the row is stranded.
  });

  // ── 6. THE CONTINGENCY THE ORDER-CANONICAL KEY EXISTS FOR ────────────────────────────────
  it('an admin confidence_label edit CAN swap chooseCanonical roles — which is why the key is canonical', async () => {
    // The order-canonical key is not justified by "the pair arrives in both orders" (it does
    // not). It is justified by this: rank() reads confidence_label, and
    // app/admin/corrections/_lib/data.ts resolveCorrectionReport UPDATEs confidence_label from
    // a live admin surface. Demonstrated here rather than asserted in prose, because 0030's
    // header cites it as the reason — and a guard justified on false grounds is worse than an
    // unjustified one.
    const [lo, hi] = pairA < pairB ? [pairA, pairB] : [pairB, pairA];
    const side = (id: string, confidenceLabel: string) => ({
      id,
      name: 'Babytime Drop-In',
      description: null,
      sourceName: 's',
      authorityTier: 'official',
      confidenceLabel,
      createdAt: PAST,
    });

    const beforeEdit = chooseCanonical(side(lo, 'high') as never, side(hi, 'high') as never);
    const afterEdit = chooseCanonical(side(lo, 'low') as never, side(hi, 'high') as never);
    expect(beforeEdit.duplicate.id).not.toBe(afterEdit.duplicate.id);

    // And the decider propagates the swap into the decision's target/related, so a WRITE-ORDER
    // key really would move. Assert on the ids, not on the whole decision object.
    const cand = (confidenceLo: string) => ({
      left: side(lo, confidenceLo),
      right: side(hi, 'high'),
      deterministicScore: 0.9,
      startUtc: START_PAIR,
      customId: `dedup-${lo}`,
    });
    expect(decideDedupDeterministic(cand('high') as never).duplicateId).not.toBe(
      decideDedupDeterministic(cand('low') as never).duplicateId
    );
  });
});
