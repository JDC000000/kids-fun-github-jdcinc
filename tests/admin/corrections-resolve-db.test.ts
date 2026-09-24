// tests/admin/corrections-resolve-db.test.ts — G-T34-7 resolve workflow, DB round-trip.
// Proves resolving one report atomically: flips correction_report → resolved (+resolved_at),
// updates the underlying occurrence's status_state + confidence_label (+last_checked_at),
// and writes a CORRECTION_RESOLVE audit row with before/after. Skips without a DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { listOpenCorrections, resolveCorrection, getStatusStateOptions } from '@/app/admin/corrections/_lib/data';
import { ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('correction resolve workflow (G-T34-7)', () => {
  let adminId = '';
  let sourceId = '';
  let seriesId = '';
  let occurrenceId = '';
  let reportId = '';

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);

    const [src] = await query<{ id: string }>(
      // terms_status='allowed': resolving a correction can set the occurrence to
      // 'confirmed', which the 0021 write-time invariant allows only for a terms-approved
      // source (in production, needs_review rows an admin confirms trace to approved sources).
      `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status)
       VALUES ('test_t34p2_corr', 'Corrections Test Source', 'official', 'auto', 'allowed') RETURNING id`
    );
    sourceId = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('T34P2 Corr Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
       VALUES ($1, 'T34P2 Corr Listing', '2026-12-01T18:00:00Z', 'needs_review', 'unscored') RETURNING id`,
      [seriesId]
    );
    occurrenceId = occ.id;
    const [rep] = await query<{ id: string }>(
      `INSERT INTO correction_report (occurrence_id, reporter, issue_type, note)
       VALUES ($1, 'anon-test', 'wrong_time', 'Time looks wrong') RETURNING id`,
      [occurrenceId]
    );
    reportId = rep.id;
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    if (occurrenceId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [occurrenceId]);
    if (occurrenceId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occurrenceId]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  it('getStatusStateOptions returns the full status_state enum', async () => {
    const opts = await getStatusStateOptions();
    expect(opts).toContain('confirmed');
    expect(opts).toContain('manual_candidate');
    expect(opts).toContain('needs_review');
    expect(opts.length).toBe(16);
  });

  it('listOpenCorrections includes the open report with its occurrence context', async () => {
    const open = await listOpenCorrections({ redactPersonalData: false });
    const row = open.find((c) => c.id === reportId);
    expect(row).toBeDefined();
    expect(row!.occStatusState).toBe('needs_review');
    expect(row!.occConfidenceLabel).toBe('unscored');
    expect(row!.activityName).toBe('T34P2 Corr Listing');
  });

  it('resolveCorrection flips the report AND updates the occurrence, atomically + audited', async () => {
    const result = await resolveCorrection(
      reportId,
      { statusState: 'confirmed', confidenceLabel: 'high', resolutionNote: 'Verified with venue.' },
      adminId
    );
    expect(result.ok).toBe(true);

    const [rep] = await query<{ status: string; resolved_at: string | null }>(
      `SELECT status, resolved_at FROM correction_report WHERE id = $1`,
      [reportId]
    );
    expect(rep.status).toBe('resolved');
    expect(rep.resolved_at).not.toBeNull();

    const [occ] = await query<{ status_state: string; confidence_label: string; last_checked_at: string | null }>(
      `SELECT status_state::text AS status_state, confidence_label, last_checked_at
         FROM activity_occurrence WHERE id = $1`,
      [occurrenceId]
    );
    expect(occ.status_state).toBe('confirmed');
    expect(occ.confidence_label).toBe('high');
    expect(occ.last_checked_at).not.toBeNull();

    const [audit] = await query<{
      target_table: string;
      target_id: string;
      before_json: { occStatusState: string };
      after_json: { occStatusState: string; resolutionNote: string };
    }>(
      `SELECT target_table, target_id, before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, ADMIN_AUDIT_ACTIONS.CORRECTION_RESOLVE]
    );
    expect(audit.target_table).toBe('correction_report');
    expect(audit.target_id).toBe(reportId);
    expect(audit.before_json.occStatusState).toBe('needs_review');
    expect(audit.after_json.occStatusState).toBe('confirmed');
    expect(audit.after_json.resolutionNote).toBe('Verified with venue.');
  });

  it('a second resolve is a no-op (already_resolved) and the queue no longer shows it', async () => {
    const again = await resolveCorrection(reportId, { statusState: 'stale', confidenceLabel: 'low', resolutionNote: null }, adminId);
    expect(again).toEqual({ ok: false, reason: 'already_resolved' });
    const open = await listOpenCorrections({ redactPersonalData: false });
    expect(open.some((c) => c.id === reportId)).toBe(false);
  });

  it('resolving a non-existent report returns not_found', async () => {
    const [{ id }] = await query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
    const res = await resolveCorrection(id, { statusState: 'confirmed', confidenceLabel: 'high', resolutionNote: null }, adminId);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});
