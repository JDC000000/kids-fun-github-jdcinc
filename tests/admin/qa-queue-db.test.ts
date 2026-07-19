// tests/admin/qa-queue-db.test.ts — G-T34-5 QA review-queue workflow, DB round-trip.
// Skips without a DB. Proves the queue lists needs_review/manual_candidate occurrences and
// that confirm/reject genuinely flip the UNDERLYING record (status_state → confirmed;
// archived_at set) — not a UI label — each atomically with a qa.* audit row, and that a
// second action on the same record is a safe no-op (already_handled).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { listReviewQueue, reviewOccurrence, QA_AUDIT_ACTIONS } from '@/app/admin/qa-queue/_lib/data';
import { REVIEW_STATES } from '@/app/admin/qa-queue/_lib/vocab';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('QA review queue (G-T34-5)', () => {
  let adminId = '';
  let sourceId = '';
  let seriesId = '';
  let needsReviewId = '';
  let manualCandidateId = '';

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);

    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, ingestion_method)
       VALUES ('test_t34p3_qa', 'QA Queue Test Source', 'official', 'auto') RETURNING id`
    );
    sourceId = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('T34P3 QA Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;
    const [a] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, 'T34P3 Needs Review', '2026-12-01T18:00:00Z', 'needs_review') RETURNING id`,
      [seriesId]
    );
    needsReviewId = a.id;
    const [b] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, 'T34P3 Manual Candidate', '2026-12-02T18:00:00Z', 'manual_candidate') RETURNING id`,
      [seriesId]
    );
    manualCandidateId = b.id;
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    for (const id of [needsReviewId, manualCandidateId]) if (id) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [id]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  it('the two review states are real status_state enum members', async () => {
    const enums = await query<{ v: string }>(`SELECT unnest(enum_range(NULL::status_state))::text AS v`);
    const values = enums.map((e) => e.v);
    for (const s of REVIEW_STATES) expect(values).toContain(s);
    expect(values).toContain('confirmed');
  });

  it('listReviewQueue surfaces both queued records with context', async () => {
    const queue = await listReviewQueue();
    const a = queue.find((r) => r.id === needsReviewId);
    const b = queue.find((r) => r.id === manualCandidateId);
    expect(a?.statusState).toBe('needs_review');
    expect(a?.sourceName).toBe('QA Queue Test Source');
    expect(a?.seriesTitle).toBe('T34P3 QA Series');
    expect(b?.statusState).toBe('manual_candidate');
  });

  it('confirm flips status_state → confirmed (record, not label) + last_checked_at + audit', async () => {
    const res = await reviewOccurrence(needsReviewId, 'confirm', 'Verified against source.', adminId);
    expect(res.ok).toBe(true);

    const [occ] = await query<{ status_state: string; last_checked_at: string | null; archived_at: string | null }>(
      `SELECT status_state::text AS status_state, last_checked_at, archived_at FROM activity_occurrence WHERE id = $1`,
      [needsReviewId]
    );
    expect(occ.status_state).toBe('confirmed');
    expect(occ.last_checked_at).not.toBeNull();
    expect(occ.archived_at).toBeNull();

    const [audit] = await query<{ target_table: string; target_id: string; before_json: { statusState: string }; after_json: { statusState: string; note: string } }>(
      `SELECT target_table, target_id, before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, QA_AUDIT_ACTIONS.CONFIRM]
    );
    expect(audit.target_table).toBe('activity_occurrence');
    expect(audit.target_id).toBe(needsReviewId);
    expect(audit.before_json.statusState).toBe('needs_review');
    expect(audit.after_json.statusState).toBe('confirmed');
    expect(audit.after_json.note).toBe('Verified against source.');

    // and it leaves the queue.
    expect((await listReviewQueue()).some((r) => r.id === needsReviewId)).toBe(false);
  });

  it('reject sets archived_at (soft-delete) + audit, and it leaves the queue', async () => {
    const res = await reviewOccurrence(manualCandidateId, 'reject', null, adminId);
    expect(res.ok).toBe(true);

    const [occ] = await query<{ status_state: string; archived_at: string | null }>(
      `SELECT status_state::text AS status_state, archived_at FROM activity_occurrence WHERE id = $1`,
      [manualCandidateId]
    );
    expect(occ.archived_at).not.toBeNull();
    // status_state is untouched on reject — the archive is the state change.
    expect(occ.status_state).toBe('manual_candidate');

    const [audit] = await query<{ after_json: { archived: boolean } }>(
      `SELECT after_json FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, QA_AUDIT_ACTIONS.REJECT]
    );
    expect(audit.after_json.archived).toBe(true);

    expect((await listReviewQueue()).some((r) => r.id === manualCandidateId)).toBe(false);
  });

  it('a second action on an already-handled record is a safe no-op', async () => {
    const confirmedAgain = await reviewOccurrence(needsReviewId, 'reject', null, adminId);
    expect(confirmedAgain).toEqual({ ok: false, reason: 'already_handled' });
    const rejectedAgain = await reviewOccurrence(manualCandidateId, 'confirm', null, adminId);
    expect(rejectedAgain).toEqual({ ok: false, reason: 'already_handled' });
  });

  it('reviewing a non-existent record returns not_found', async () => {
    const [{ id }] = await query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
    const res = await reviewOccurrence(id, 'confirm', null, adminId);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});
