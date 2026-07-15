// lib/corrections/report.ts — server-side correction-report write helper.
//
// Inserts one row into `correction_report` via the shared pg pool (lib/db/client).
// A correction is a deliberate user action, but the write must still never crash the
// request that fired it: a DB hiccup resolves to { ok:false } and the caller shows its
// optimistic acknowledgement regardless. `occurrence_id` is a NOT NULL foreign key, so
// a report for an occurrence that doesn't exist (e.g. a fixture id in local dev) fails
// the FK and is reported as not-recorded rather than thrown. `status` defaults to
// 'open' and `created_at` to now() in the schema.
//
// Server-only: touches `pg`. Do not import from client/browser code.
import { query } from '@/lib/db/client';
import type { CorrectionReportWrite } from './types';

export interface CorrectionWriteResult {
  ok: boolean;
  /** The new correction_report id when the row was persisted. */
  id?: string;
}

/**
 * Write one correction report. Never throws — DB/FK hiccups resolve to { ok:false }
 * so the "Report wrong info" flow is never blocked or errored by persistence.
 */
export async function writeCorrectionReport(report: CorrectionReportWrite): Promise<CorrectionWriteResult> {
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO correction_report (occurrence_id, reporter, issue_type, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [report.occurrenceId, report.reporter ?? null, report.issueType, report.note]
    );
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    // Never load-bearing on the request path: log and report not-recorded. An FK
    // violation (occurrence doesn't exist) or a DB outage both land here.
    console.warn('[corrections] report write failed:', (err as Error)?.message ?? err);
    return { ok: false };
  }
}
