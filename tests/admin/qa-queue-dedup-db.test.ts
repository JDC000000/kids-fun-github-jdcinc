// tests/admin/qa-queue-dedup-db.test.ts — G-T34-6 dedup-pair review, DB round-trip.
// Skips without a DB. Proves the QA queue surfaces a flagged dedup candidate WITH its
// suspected canonical (from the recorded route_to_review llm_batch_decision), and that:
//   • "confirm merge" runs the REAL provenance-preserving merge (G-T14-3) — the duplicate
//     is archived, the canonical keeps both sources' provenance — atomically with a
//     dedup.merge audit row, and the row then leaves the queue;
//   • "reject" ("not a duplicate") confirms the candidate as a distinct listing — BOTH
//     records stay live, nothing archived — with a dedup.reject_merge audit row;
//   • a forged pair (no route_to_review decision) is refused (not_a_pair);
//   • a second action on an already-handled row is a safe no-op.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import {
  confirmDedupMerge,
  rejectDedupPair,
  QA_AUDIT_ACTIONS,
} from '@/app/admin/qa-queue/_lib/data';
import { collectReviewQueue } from './review-queue-walk';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'test_yy_dedup';

async function seedOcc(name: string, authority: string, status: string, suffix: string): Promise<string> {
  const [src] = await query<{ id: string }>(
    // terms_status='allowed': seeded canon rows are 'confirmed' and dedup review can
    // confirm a distinct dup — both require a terms-approved source under the 0021 invariant.
    `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status) VALUES ($1, $2, $3, 'auto', 'allowed') RETURNING id`,
    [FAMILY, `${name} src ${suffix}`, authority]
  );
  const [ser] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
    [`${name} series ${suffix}`, src.id]
  );
  const [occ] = await query<{ id: string }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, '2026-12-10T18:00:00Z', $3::status_state) RETURNING id`,
    [ser.id, name, status]
  );
  return occ.id;
}

async function addProv(occId: string, field: string, url: string, family: string): Promise<void> {
  await query(
    `INSERT INTO provenance (occurrence_id, field, source_url, source_family, fact_origin) VALUES ($1, $2, $3, $4, 'source')`,
    [occId, field, url, family]
  );
}

async function routeToReview(dupId: string, canonId: string): Promise<void> {
  await query(
    `INSERT INTO llm_batch_decision (job_name, use_case, target_id, related_id, custom_id, action, deterministic_score, llm_confidence, detail)
       VALUES ('llm_dedup_adjudication', 'dedup', $1, $2, $3, 'route_to_review', 0.62, 0.74, $4::jsonb)`,
    [dupId, canonId, `dedup-${dupId}`, JSON.stringify({ reason: 'Same storytime, two sources', suspectedDuplicateOf: canonId })]
  );
}

async function occRow(id: string) {
  const [row] = await query<{ status_state: string; archived_at: string | null; dedup_key: string | null }>(
    `SELECT status_state::text AS status_state, archived_at, dedup_key FROM activity_occurrence WHERE id = $1`,
    [id]
  );
  return row;
}

describe.skipIf(!hasDb)('QA queue — dedup-pair review (G-T34-6)', () => {
  let adminId = '';
  // pair 1 (merge), pair 2 (reject), plus an unrelated occurrence for the not_a_pair guard.
  let canon1 = '';
  let dup1 = '';
  let canon2 = '';
  let dup2 = '';
  let unrelated = '';

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);

    canon1 = await seedOcc('Storytime', 'official', 'confirmed', 'c1');
    dup1 = await seedOcc('Story time', 'partner', 'manual_candidate', 'd1');
    canon2 = await seedOcc('Music Circle', 'official', 'confirmed', 'c2');
    dup2 = await seedOcc('Music circle', 'partner', 'manual_candidate', 'd2');
    unrelated = await seedOcc('Coding Club', 'official', 'confirmed', 'u');

    await addProv(canon1, 'activity_name', 'https://city.example/p/1', 'official-city');
    await addProv(dup1, 'activity_name', 'https://eventbrite.example/e/1', 'eventbrite');
    await addProv(dup2, 'activity_name', 'https://eventbrite.example/e/2', 'eventbrite');

    await routeToReview(dup1, canon1);
    await routeToReview(dup2, canon2);
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    for (const id of [dup1, dup2]) if (id) await query(`DELETE FROM llm_batch_decision WHERE target_id = $1`, [id]);
    await query(
      `DELETE FROM provenance WHERE occurrence_id IN (
         SELECT o.id FROM activity_occurrence o JOIN activity_series ser ON ser.id = o.series_id
           JOIN source s ON s.id = ser.source_id WHERE s.family = $1)`,
      [FAMILY]
    );
    await query(
      `DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1))`,
      [FAMILY]
    );
    await query(`DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1)`, [FAMILY]);
    await query(`DELETE FROM source WHERE family = $1`, [FAMILY]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  it('listReviewQueue surfaces the flagged candidate WITH its suspected canonical + the "why"', async () => {
    const queue = await collectReviewQueue();
    const row = queue.find((r) => r.id === dup1);
    expect(row?.statusState).toBe('manual_candidate');
    expect(row?.dedup).toBeTruthy();
    expect(row?.dedup?.canonicalId).toBe(canon1);
    expect(row?.dedup?.canonicalName).toBe('Storytime');
    expect(row?.dedup?.canonicalAvailable).toBe(true);
    expect(row?.dedup?.reason).toBe('Same storytime, two sources');
    expect(row?.dedup?.deterministicScore).toBeCloseTo(0.62, 5);
    expect(row?.dedup?.llmConfidence).toBeCloseTo(0.74, 5);

    // A plain (non-dedup) confirmed row would not carry a pairing.
    expect(queue.find((r) => r.id === unrelated)).toBeUndefined(); // confirmed → not in queue
  });

  it('confirm merge: archives the duplicate, preserves both sources’ provenance on the canonical, audits', async () => {
    const res = await confirmDedupMerge(dup1, canon1, 'Confirmed same event.', adminId);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.provenanceMoved).toBe(1);

    const dup = await occRow(dup1);
    const canon = await occRow(canon1);
    expect(dup.archived_at).not.toBeNull(); // duplicate archived
    expect(canon.archived_at).toBeNull(); // canonical kept
    expect(canon.dedup_key).toBe(`dedup:v1:${canon1}`);

    // Canonical now carries provenance from BOTH sources (≥2 distinct families) — FR-17.
    const [{ n }] = await query<{ n: string }>(
      `SELECT count(DISTINCT source_family)::text AS n FROM provenance WHERE occurrence_id = $1`,
      [canon1]
    );
    expect(Number(n)).toBeGreaterThanOrEqual(2);

    const [audit] = await query<{ target_id: string; after_json: { archived: boolean; mergedInto: string; provenanceMoved: number } }>(
      `SELECT target_id, after_json FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, QA_AUDIT_ACTIONS.DEDUP_MERGE]
    );
    expect(audit.target_id).toBe(dup1);
    expect(audit.after_json.archived).toBe(true);
    expect(audit.after_json.mergedInto).toBe(canon1);

    // It leaves the queue.
    expect((await collectReviewQueue()).some((r) => r.id === dup1)).toBe(false);
  });

  it('confirm merge refuses a forged pair (no route_to_review decision) → not_a_pair', async () => {
    const res = await confirmDedupMerge(dup2, unrelated, null, adminId);
    expect(res).toEqual({ ok: false, reason: 'not_a_pair' });
    // dup2 untouched (still a live manual_candidate).
    expect((await occRow(dup2)).archived_at).toBeNull();
    expect((await occRow(dup2)).status_state).toBe('manual_candidate');
  });

  it('reject ("not a duplicate"): confirms the candidate, keeps BOTH live & separate, audits', async () => {
    const res = await rejectDedupPair(dup2, canon2, 'Different age group.', adminId);
    expect(res.ok).toBe(true);

    const dup = await occRow(dup2);
    const canon = await occRow(canon2);
    expect(dup.archived_at).toBeNull(); // NOT archived
    expect(dup.status_state).toBe('confirmed'); // now a trusted, distinct listing
    expect(canon.archived_at).toBeNull(); // canonical also untouched

    const [audit] = await query<{ after_json: { statusState: string; archived: boolean } }>(
      `SELECT after_json FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, QA_AUDIT_ACTIONS.DEDUP_REJECT]
    );
    expect(audit.after_json.statusState).toBe('confirmed');
    expect(audit.after_json.archived).toBe(false);

    expect((await collectReviewQueue()).some((r) => r.id === dup2)).toBe(false);
  });

  it('a second dedup action on an already-handled row is a safe no-op', async () => {
    const merged = await confirmDedupMerge(dup1, canon1, null, adminId);
    expect(merged).toEqual({ ok: false, reason: 'already_handled' });
    const rejected = await rejectDedupPair(dup2, canon2, null, adminId);
    expect(rejected).toEqual({ ok: false, reason: 'already_handled' });
  });

  it('reject refuses a forged pair (no route_to_review decision) → not_a_pair, and writes NO verdict', async () => {
    // Same guard confirmDedupMerge has always had. Without it the pair-scoped verdict could be
    // minted for two arbitrary ids posted at the action, permanently suppressing detection for
    // a pair no detector ever proposed — a silent, durable hole rather than a visible one.
    const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM dedup_pair_adjudication`);
    const res = await rejectDedupPair(dup1, unrelated, null, adminId);
    expect(res).toEqual({ ok: false, reason: 'not_a_pair' });
    const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM dedup_pair_adjudication`);
    expect(after[0].n).toBe(before[0].n);
  });
});
