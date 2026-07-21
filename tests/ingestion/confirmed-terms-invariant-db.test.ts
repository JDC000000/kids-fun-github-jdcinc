// tests/ingestion/confirmed-terms-invariant-db.test.ts — ADVERSARIAL proof of the Round 27
// write-time invariant (incident: documents/execution/kids-fun-round27-incident-approval-
// bypass-2026-07-21.md). It attacks the invariant from EVERY real write path and confirms a
// 'confirmed' occurrence can never persist against a non-terms-approved source:
//
//   1. raw SQL INSERT                (DB trigger, bypasses ALL application code)
//   2. raw SQL UPDATE needs_review→confirmed
//   3. raw SQL series re-point of an already-confirmed row onto a pending series
//   4. the shared upsert path         (worker/core/upsert.ts upsertOccurrence)
//   5. the ingest pipeline            (worker/core/ingest.ts — app-layer cap → needs_review,
//                                      no confirmed leak, no hard error on staging review)
//   6. an admin action               (app/admin/qa-queue reviewOccurrence 'confirm')
//   7. the migration's heal backfill  (a pre-existing bad row is downgraded)
//
// …while proving the happy paths still work: 'confirmed' on an 'allowed' OR 'summarise_only'
// source succeeds, and non-'confirmed' statuses on a pending source are untouched. Skips
// without a DB. The guard is supabase/migrations/0021_confirmed_requires_terms_approval.sql.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query } from '@/lib/db/client';
import { upsertOccurrence } from '@/worker/core/upsert';
import { ingestSource } from '@/worker/core/ingest';
import type { Adapter, StructuredRecord } from '@/worker/core/adapter';
import { reviewOccurrence } from '@/app/admin/qa-queue/_lib/data';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = `r27_adv_${crypto.randomUUID().slice(0, 8)}`;
const INVARIANT = /terms-approved|approval-bypass invariant/;

/** A fully-structured, high-confidence record — would score medium/high → 'confirmed'. */
function confidentRecord(tag: string): StructuredRecord {
  return {
    sourceRecordId: `adv-${tag}-${crypto.randomUUID()}`,
    title: 'Family Public Swim',
    categoryHint: 'public_swim',
    startDatetimeUtc: '2026-09-24T18:00:00.000Z',
    costStatus: 'free',
    ageText: '6 months to 5 years',
    sourceUrl: 'https://example.org/adv',
  };
}
function confidentAdapter(record: StructuredRecord): Adapter {
  return {
    family: 'library',
    fetch: async () => [record],
    extract: (raw) => raw as StructuredRecord[],
    dedupKeys: () => ({ key: record.sourceRecordId }),
  };
}

describe.skipIf(!hasDb)('Round 27 — confirmed-requires-terms-approval write invariant', () => {
  // One source per terms_status, each with its own series. Names are unique per run.
  let pendingSourceId = '';
  let pendingSeriesId = '';
  let allowedSourceId = '';
  let allowedSeriesId = '';
  let summariseSourceId = '';
  let summariseSeriesId = '';
  let adminId = '';

  async function mkSource(termsStatus: string): Promise<string> {
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, terms_status)
       VALUES ($1, $2, 'official', $3) RETURNING id`,
      [FAMILY, `${termsStatus} ${crypto.randomUUID()}`, termsStatus]
    );
    return s.id;
  }
  async function mkSeries(sourceId: string): Promise<string> {
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`series ${crypto.randomUUID()}`, sourceId]
    );
    return ser.id;
  }
  /** Raw INSERT of an occurrence with an arbitrary status; returns the promise so callers assert on it. */
  function rawInsertOccurrence(seriesId: string, status: string) {
    return query(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, now() + interval '5 days', $3::status_state) RETURNING id`,
      [seriesId, `adv ${status}`, status]
    );
  }

  beforeAll(async () => {
    pendingSourceId = await mkSource('pending');
    pendingSeriesId = await mkSeries(pendingSourceId);
    allowedSourceId = await mkSource('allowed');
    allowedSeriesId = await mkSeries(allowedSourceId);
    summariseSourceId = await mkSource('summarise_only');
    summariseSeriesId = await mkSeries(summariseSourceId);

    const [admin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
  });

  afterAll(async () => {
    // No ON DELETE CASCADE on occurrence/source children — delete inner-out, scoped to FAMILY.
    const occFilter = `SELECT o.id FROM activity_occurrence o
      JOIN activity_series ser ON ser.id = o.series_id
      JOIN source s ON s.id = ser.source_id WHERE s.family = $1`;
    await query(`DELETE FROM provenance WHERE occurrence_id IN (${occFilter})`, [FAMILY]);
    await query(`DELETE FROM occurrence_category_tag WHERE occurrence_id IN (${occFilter})`, [FAMILY]);
    await query(`DELETE FROM occurrence_age WHERE occurrence_id IN (${occFilter})`, [FAMILY]);
    await query(
      `DELETE FROM activity_occurrence WHERE series_id IN (
         SELECT ser.id FROM activity_series ser JOIN source s ON s.id = ser.source_id WHERE s.family = $1)`,
      [FAMILY]
    );
    await query(
      `DELETE FROM source_check_run WHERE source_id IN (SELECT id FROM source WHERE family = $1)`,
      [FAMILY]
    );
    await query(
      `DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE family = $1)`,
      [FAMILY]
    );
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    await query(`DELETE FROM source WHERE family = $1`, [FAMILY]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  // ── 1–3: raw SQL (structural DB trigger, bypasses all application code) ──────────────
  it('REJECTS a raw INSERT of a confirmed occurrence on a pending source', async () => {
    await expect(rawInsertOccurrence(pendingSeriesId, 'confirmed')).rejects.toThrow(INVARIANT);
  });

  it('REJECTS a raw UPDATE flipping needs_review → confirmed on a pending source', async () => {
    const [row] = await rawInsertOccurrence(pendingSeriesId, 'needs_review');
    const id = (row as { id: string }).id;
    await expect(
      query(`UPDATE activity_occurrence SET status_state = 'confirmed' WHERE id = $1`, [id])
    ).rejects.toThrow(INVARIANT);
    // And it genuinely did not change — still needs_review.
    const [after] = await query<{ status_state: string }>(
      `SELECT status_state::text AS status_state FROM activity_occurrence WHERE id = $1`,
      [id]
    );
    expect(after.status_state).toBe('needs_review');
  });

  it('REJECTS re-pointing an already-confirmed row onto a pending series (no status change)', async () => {
    // A legitimately-confirmed row on the allowed source…
    const [row] = await rawInsertOccurrence(allowedSeriesId, 'confirmed');
    const id = (row as { id: string }).id;
    // …cannot be quietly re-parented to the pending source while staying confirmed.
    await expect(
      query(`UPDATE activity_occurrence SET series_id = $1 WHERE id = $2`, [pendingSeriesId, id])
    ).rejects.toThrow(INVARIANT);
  });

  // ── 4: the shared upsert path every real ingest and test routes through ─────────────
  it('REJECTS upsertOccurrence({ statusState: confirmed }) on a pending source', async () => {
    await expect(
      upsertOccurrence(getPool(), pendingSeriesId, confidentRecord('upsert'), { statusState: 'confirmed' })
    ).rejects.toThrow(INVARIANT);
  });

  // ── 5: the ingest pipeline — app-layer cap → needs_review, no confirmed leak ─────────
  it('the ingest pipeline HOLDS a would-be-confirmed record at needs_review for a pending source', async () => {
    const rec = confidentRecord('ingest-pending');
    const summary = await ingestSource(getPool(), confidentAdapter(rec), pendingSourceId);

    // No hard error: staging review of a pending source is allowed to RUN…
    expect(summary.errors).toEqual([]);
    expect(summary.occurrencesUpserted).toBeGreaterThan(0);

    const [occ] = await query<{ status_state: string; confidence_label: string }>(
      `SELECT o.status_state::text AS status_state, o.confidence_label
         FROM activity_occurrence o
         JOIN activity_series ser ON ser.id = o.series_id
        WHERE ser.source_id = $1 AND o.source_record_id = $2`,
      [pendingSourceId, rec.sourceRecordId]
    );
    // …but the record is HELD at needs_review even though its confidence would confirm it.
    expect(occ.status_state).toBe('needs_review');
    expect(['medium', 'high']).toContain(occ.confidence_label);
  });

  it('the SAME record on an allowed source DOES surface as confirmed (A/B control)', async () => {
    const rec = confidentRecord('ingest-allowed');
    const summary = await ingestSource(getPool(), confidentAdapter(rec), allowedSourceId);
    expect(summary.errors).toEqual([]);

    const [occ] = await query<{ status_state: string; confidence_label: string }>(
      `SELECT o.status_state::text AS status_state, o.confidence_label
         FROM activity_occurrence o
         JOIN activity_series ser ON ser.id = o.series_id
        WHERE ser.source_id = $1 AND o.source_record_id = $2`,
      [allowedSourceId, rec.sourceRecordId]
    );
    expect(occ.status_state).toBe('confirmed');
    expect(['medium', 'high']).toContain(occ.confidence_label);
  });

  // ── 6: an admin action that sets status_state ───────────────────────────────────────
  it('REJECTS an admin qa-queue confirm of a pending-source occurrence', async () => {
    const [row] = await rawInsertOccurrence(pendingSeriesId, 'needs_review');
    const id = (row as { id: string }).id;
    // reviewOccurrence('confirm') runs UPDATE … status_state='confirmed' in a tx; the guard
    // makes it throw and the transaction rolls back — the admin lane cannot bypass the rule.
    await expect(reviewOccurrence(id, 'confirm', 'try to confirm', adminId)).rejects.toThrow(INVARIANT);
    const [after] = await query<{ status_state: string }>(
      `SELECT status_state::text AS status_state FROM activity_occurrence WHERE id = $1`,
      [id]
    );
    expect(after.status_state).toBe('needs_review'); // rolled back, unchanged
  });

  // ── 7: the migration's self-heal backfill downgrades a PRE-EXISTING bad row ──────────
  it('the heal backfill downgrades a pre-existing confirmed-on-pending row to needs_review', async () => {
    // Simulate the incident: with the guard temporarily disabled (as when a stray test run
    // wrote directly), plant a confirmed row on the pending source, then re-enable the guard.
    let plantedId = '';
    try {
      await query(`ALTER TABLE activity_occurrence DISABLE TRIGGER activity_occurrence_confirmed_terms_guard`);
      const [row] = await rawInsertOccurrence(pendingSeriesId, 'confirmed');
      plantedId = (row as { id: string }).id;
    } finally {
      await query(`ALTER TABLE activity_occurrence ENABLE TRIGGER activity_occurrence_confirmed_terms_guard`);
    }

    // Exactly the migration's heal statement (0021) — idempotent, scoped to violations.
    await query(
      `UPDATE activity_occurrence o SET status_state = 'needs_review'
        WHERE o.status_state = 'confirmed'
          AND o.series_id IN (
            SELECT ser.id FROM activity_series ser JOIN source s ON s.id = ser.source_id
             WHERE s.terms_status NOT IN ('allowed', 'summarise_only'))`
    );

    const [healed] = await query<{ status_state: string }>(
      `SELECT status_state::text AS status_state FROM activity_occurrence WHERE id = $1`,
      [plantedId]
    );
    expect(healed.status_state).toBe('needs_review');
  });

  // ── happy paths + scope: prove we didn't over-block ─────────────────────────────────
  it('ALLOWS a confirmed occurrence on an allowed source', async () => {
    const [row] = await rawInsertOccurrence(allowedSeriesId, 'confirmed');
    expect((row as { id: string }).id).toBeTruthy();
  });

  it('ALLOWS a confirmed occurrence on a summarise_only source (approved set matches terms-gate)', async () => {
    const [row] = await rawInsertOccurrence(summariseSeriesId, 'confirmed');
    expect((row as { id: string }).id).toBeTruthy();
  });

  it('ALLOWS non-confirmed statuses on a pending source (only confirmed is gated)', async () => {
    for (const status of ['needs_review', 'manual_candidate', 'cancelled', 'seasonal_active']) {
      const [row] = await rawInsertOccurrence(pendingSeriesId, status);
      expect((row as { id: string }).id).toBeTruthy();
    }
  });
});
