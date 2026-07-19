// app/admin/corrections/_lib/data.ts — G-T34-7 correction-resolve DB model.
// SERVER-ONLY (pg service pool). Reads the open corrections queue and resolves a
// report: in ONE transaction it flips correction_report → resolved AND updates the
// underlying activity_occurrence's health (status_state) + confidence, and writes the
// admin_audit_log row — so the report, the listing, and the audit trail move together.
//
// correction_report (0006_provenance_ops.sql): status text CHECK(open|in_review|resolved),
// resolved_at (previously unused — set here), occurrence_id NOT NULL FK activity_occurrence.
import { query } from '@/lib/db/client';
import { writeAdminAudit, withAdminTransaction, ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';
import type { ResolveInput } from './vocab';

/** One open (open|in_review) report joined to its occurrence's current state, for the queue. */
export interface OpenCorrection {
  id: string;
  occurrenceId: string;
  reporter: string | null;
  issueType: string;
  note: string | null;
  status: string;
  createdAt: string;
  /** activity_occurrence.activity_name (occurrence always exists — FK NOT NULL). */
  activityName: string;
  /** The occurrence's CURRENT status_state — the resolve form defaults to this. */
  occStatusState: string;
  /** The occurrence's CURRENT confidence_label — the resolve form defaults to this. */
  occConfidenceLabel: string;
  sourceUrl: string | null;
  startDatetimeUtc: string | null;
}

interface OpenCorrectionDbRow {
  id: string;
  occurrence_id: string;
  reporter: string | null;
  issue_type: string;
  note: string | null;
  status: string;
  created_at: Date | string;
  activity_name: string;
  occ_status_state: string;
  occ_confidence_label: string;
  source_url: string | null;
  start_datetime_utc: Date | string | null;
}

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The open corrections queue — non-archived, not-yet-resolved reports, oldest first
 * (FIFO triage), joined to their occurrence for the reviewing context the admin needs.
 */
export async function listOpenCorrections(limit = 100): Promise<OpenCorrection[]> {
  const rows = await query<OpenCorrectionDbRow>(
    `SELECT
       cr.id, cr.occurrence_id, cr.reporter, cr.issue_type, cr.note, cr.status, cr.created_at,
       o.activity_name,
       o.status_state::text AS occ_status_state,
       o.confidence_label   AS occ_confidence_label,
       o.source_url,
       o.start_datetime_utc
     FROM correction_report cr
     JOIN activity_occurrence o ON o.id = cr.occurrence_id
     WHERE cr.archived_at IS NULL AND cr.status <> 'resolved'
     ORDER BY cr.created_at ASC
     LIMIT $1::int`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    occurrenceId: r.occurrence_id,
    reporter: r.reporter,
    issueType: r.issue_type,
    note: r.note,
    status: r.status,
    createdAt: iso(r.created_at)!,
    activityName: r.activity_name,
    occStatusState: r.occ_status_state,
    occConfidenceLabel: r.occ_confidence_label,
    sourceUrl: r.source_url,
    startDatetimeUtc: iso(r.start_datetime_utc),
  }));
}

/** The health states an admin can move a listing to — the live status_state enum. */
export async function getStatusStateOptions(): Promise<string[]> {
  const rows = await query<{ v: string }>(
    `SELECT unnest(enum_range(NULL::status_state))::text AS v`
  );
  return rows.map((r) => r.v);
}

export type ResolveResult =
  | {
      ok: true;
      reportId: string;
      occurrenceId: string;
      before: ResolveSnapshot;
      after: ResolveSnapshot & { resolutionNote: string | null };
    }
  | { ok: false; reason: 'not_found' | 'already_resolved' };

interface ResolveSnapshot {
  reportStatus: string;
  occStatusState: string;
  occConfidenceLabel: string;
}

/**
 * Resolve one correction report. In a single transaction:
 *   1. lock + read the report (skip if missing/archived or already resolved),
 *   2. lock + read the occurrence for the before-snapshot,
 *   3. correction_report → status='resolved', resolved_at=now(),
 *   4. activity_occurrence → status_state / confidence_label / last_checked_at=now(),
 *   5. admin_audit_log row (before/after of BOTH rows + the resolution note).
 * Invalid enum/confidence values are rejected by the DB constraints and surface as a
 * thrown error to the caller (the form only ever offers valid options).
 */
export async function resolveCorrection(
  reportId: string,
  input: ResolveInput,
  adminUserId: string
): Promise<ResolveResult> {
  return withAdminTransaction(async (client) => {
    const rep = await client.query<{ id: string; occurrence_id: string; status: string }>(
      `SELECT id, occurrence_id, status FROM correction_report
        WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
      [reportId]
    );
    if (!rep.rows[0]) return { ok: false, reason: 'not_found' } as const;
    if (rep.rows[0].status === 'resolved') return { ok: false, reason: 'already_resolved' } as const;

    const occurrenceId = rep.rows[0].occurrence_id;
    const occ = await client.query<{ status_state: string; confidence_label: string }>(
      `SELECT status_state::text AS status_state, confidence_label
         FROM activity_occurrence WHERE id = $1 FOR UPDATE`,
      [occurrenceId]
    );
    const beforeOcc = occ.rows[0];

    await client.query(
      `UPDATE correction_report SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [reportId]
    );
    await client.query(
      `UPDATE activity_occurrence
          SET status_state = $2::status_state, confidence_label = $3, last_checked_at = now()
        WHERE id = $1`,
      [occurrenceId, input.statusState, input.confidenceLabel]
    );

    const before: ResolveSnapshot = {
      reportStatus: rep.rows[0].status,
      occStatusState: beforeOcc?.status_state ?? '(unknown)',
      occConfidenceLabel: beforeOcc?.confidence_label ?? '(unknown)',
    };
    const after = {
      reportStatus: 'resolved',
      occStatusState: input.statusState,
      occConfidenceLabel: input.confidenceLabel,
      resolutionNote: input.resolutionNote,
    };

    await writeAdminAudit(
      {
        adminUserId,
        action: ADMIN_AUDIT_ACTIONS.CORRECTION_RESOLVE,
        targetTable: 'correction_report',
        targetId: reportId,
        before,
        after,
      },
      client
    );

    return { ok: true, reportId, occurrenceId, before, after } as const;
  });
}
