// lib/sms/send-log.ts — append one `sms_send_log` row: the per-subscriber watermark AND the
// CASL audit trail (migration 0035).
//
// DRAFT (SMS pivot). Still a STUB — `sms_send_log` is unapplied SQL and this branch holds no write
// credentials — but it carries the exact INSERT it will issue and the four columns that are easy
// to get wrong.
//
// ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────────────────
// It lived in lib/sms/weekly-send-io.ts, which top-level imports the SearchEngine, the postgres
// listing repository, the alias resolver and the pg pool. Three unrelated features write to this
// table — the Friday job, the signup confirmation and the JOIN welcome — and the latter two were
// inheriting that entire graph for no reason but where the function happened to live (flagged in
// round 12, acted on in round 16 when making the Twilio dispatch real would have added an HTTP
// client to the same pile).
//
// MOVING ONLY THE TWILIO HALF WOULD HAVE FIXED NOTHING: every caller pairs a dispatch with a log
// write, so leaving `recordSmsSend` behind would have left them all importing weekly-send-io
// anyway. weekly-send-io re-exports both, so nothing that already imported them changed.

export type SendLogOutcome = 'sent' | 'empty' | 'paused' | 'stopped_via_carrier' | 'failed';
export type SendLogType = 'confirm_request' | 'welcome' | 'weekly' | 'empty_week' | 'pause_notice';

export interface RecordSendInput {
  subscriberId: string;
  sendType: SendLogType;
  outcome: SendLogOutcome;
  picksSnapshot: Array<{ occurrence_id: string; rank: number }> | null;
  twilioSid: string | null;
  consentTextVersion: string;
}

/**
 * Append one `sms_send_log` row — the per-subscriber watermark AND the CASL audit trail. STUB.
 *
 * TODO:
 *   INSERT INTO sms_send_log
 *     (subscriber_id, phone_hash, phone_hash_version, send_type, picks_snapshot,
 *      outcome, twilio_sid, consent_text_version)
 *   VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
 *
 * GET THESE FOUR RIGHT — a future implementation copies this shape verbatim:
 *
 *   phone_hash          NOT NULL on EVERY row, including rows whose subscriber still exists.
 *                       Populating it only after a purge would leave the pre-purge history
 *                       unsearchable by number, which is the only way anyone will ever search it
 *                       (migration 0035). Salted with SMS_PHONE_HASH_SALT.
 *   phone_hash_version  The salt generation that produced it. Without it, rotating the salt
 *                       silently makes every historical hash unmatchable, with no error anywhere.
 *   picks_snapshot      Weekly sends ONLY — migration 0035 has a CHECK enforcing it, so passing
 *                       an array on an 'empty_week' row fails the insert. `picksSnapshot()`
 *                       already returns null for every non-'picks' plan.
 *   consent_text_version  The wording in force AT SEND TIME, COPIED not joined. A join would
 *                       report today's wording for a message sent under last year's, which is
 *                       precisely the fact an audit is asking about.
 *
 * DRY RUNS DO NOT REACH HERE AT ALL. `weekly_email_send` carries a `dry_run` column and records
 * both; this table has no such column by design (migration 0035 defines it as a record of
 * messages that were SENT), so the orchestrator simply does not call this on a dry run. Same net
 * effect as the email job's watermark rule — a verification run never moves real state.
 */
export async function recordSmsSend(_input: RecordSendInput): Promise<void> {
  // Draft scaffold: sms_send_log is unapplied SQL.
}
