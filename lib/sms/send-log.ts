// lib/sms/send-log.ts — append one `sms_send_log` row: the per-subscriber watermark AND the
// CASL audit trail (migration 0035).
//
// DRAFT (SMS pivot). REAL — the INSERT below runs against `sms_send_log` (migration 0035, applied
// by the Operator), and tests/sms/send_log-db.test.ts exercises it against a real database. Four
// of its columns are easy to get wrong; they are documented on `recordSmsSend`.
//
// ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────────────────
// It lived in lib/sms/weekly-send-io.ts, which top-level imports the SearchEngine, the postgres
// listing repository, the alias resolver and the pg pool. Three unrelated features write to this
// table — the Friday job, the signup confirmation and the JOIN welcome — and the latter two were
// inheriting that entire graph for no reason but where the function happened to live (flagged in
// round 12, acted on in round 16 when making the Twilio dispatch real would have added an HTTP
// client to the same pile).
//
// STAGE B MADE IT REAL. The INSERT below is the query this file has carried as a TODO since it
// was written; the only thing that had to be designed was `phone_hash`, and the Operator approved
// that construction (see lib/sms/phone-hash.ts).
//
// MOVING ONLY THE TWILIO HALF WOULD HAVE FIXED NOTHING: every caller pairs a dispatch with a log
// write, so leaving `recordSmsSend` behind would have left them all importing weekly-send-io
// anyway. weekly-send-io re-exports both, so nothing that already imported them changed.

import { query } from '@/lib/db/client';
import { MissingPhoneHashSaltError, PHONE_HASH_VERSION, phoneHash } from './phone-hash';

export type SendLogOutcome = 'sent' | 'empty' | 'paused' | 'stopped_via_carrier' | 'failed';
/**
 * The `sms_send_log.send_type` values.
 *
 * ⚠ MIRRORS A DATABASE CHECK CONSTRAINT (0035, widened by 0049). Adding a member here is not
 * enough — the column's `CHECK (send_type IN (...))` has to admit it too.
 *
 * ⚠ `'instant_picks'` IS NOT IN `findLastWeek`'s IN-LIST, AND THAT IS NOT AN OMISSION. The "Last
 * Friday" panel (lib/sms/preferences.ts) shows messages WE decided to send; the Instant Picks
 * button sits inside that panel and its rows record a message the SUBSCRIBER asked for. Adding the
 * value there would show a parent their own button press as though we had texted them unprompted.
 * See migration 0049's header and tests/sms/instant_picks_send_log_invariants.test.ts.
 */
export type SendLogType =
  | 'confirm_request'
  | 'welcome'
  | 'weekly'
  | 'empty_week'
  | 'pause_notice'
  /** The on-demand digest a subscriber requested from their preferences page. Migration 0049. */
  | 'instant_picks';

export interface RecordSendInput {
  /**
   * The subscriber this message went to, when there is one.
   *
   * NULLABLE, and 0035 makes the column nullable for the same reason: the audit trail outlives the
   * subscriber row (`ON DELETE SET NULL`), and a confirmation request can be sent before the
   * caller has the id. A row with no `subscriber_id` is still findable by `phone_hash`, which is
   * the only way anyone will ever search this table.
   */
  subscriberId: string | null;
  /**
   * The E.164 number this message was sent to. HASHED HERE AND NEVER STORED IN THE CLEAR.
   *
   * ⚠ THIS IS THE ONE PLACE A PHONE NUMBER ENTERS THIS MODULE, and it is deliberate rather than an
   * erosion of the branch's PII discipline. `phone_hash` is NOT NULL and is the only identifier
   * that survives the purge, so the number has to reach the writer somehow. The alternatives were
   * worse: hashing in SQL would send the salt to the database on every insert, and looking the
   * number up by `subscriber_id` would cost a query per send AND fail for exactly the rows that
   * need the hash most — the purged ones.
   *
   * It goes IN and never comes back: nothing this function returns or throws contains it, and
   * every caller already holds it because it just dispatched to it.
   */
  phoneNumber: string;
  sendType: SendLogType;
  outcome: SendLogOutcome;
  picksSnapshot: Array<{ occurrence_id: string; rank: number }> | null;
  twilioSid: string | null;
  consentTextVersion: string;
}

/**
 * Append one `sms_send_log` row — the per-subscriber watermark AND the CASL audit trail.
 *
 * FOUR COLUMNS ARE EASY TO GET WRONG, and each is load-bearing:
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
export async function recordSmsSend(input: RecordSendInput): Promise<void> {
  // ── The hash first, because a row we cannot identify is worse than no row ──
  // `phone_hash` is NOT NULL and it is the ONLY identifier that survives the 30-day purge. If it
  // cannot be computed we refuse rather than inventing something that fits the column: a
  // placeholder would produce an audit trail that looks complete and answers no question at all.
  const hash = phoneHash(input.phoneNumber);
  if (!hash) throw new MissingPhoneHashSaltError();

  await query(
    `INSERT INTO sms_send_log
       (subscriber_id, phone_hash, phone_hash_version, send_type,
        picks_snapshot, outcome, twilio_sid, consent_text_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      // NULLABLE BY DESIGN (0035, ON DELETE SET NULL): the audit trail outlives the subscriber
      // row. A confirmation request sent before the row id is known writes null here and is still
      // findable by hash, which is the only way anyone will ever search it.
      input.subscriberId ?? null,
      hash,
      PHONE_HASH_VERSION,
      input.sendType,
      // Weekly sends only — 0035's CHECK rejects a snapshot on any other send_type. Stringified
      // rather than passed as an object so `null` stays SQL NULL instead of the JSON string
      // "null", which would satisfy the CHECK's IS NULL test... but not actually be null.
      input.picksSnapshot ? JSON.stringify(input.picksSnapshot) : null,
      input.outcome,
      input.twilioSid,
      // COPIED, NEVER JOINED. A join would report today's wording for a message sent under last
      // year's, which is precisely the fact an audit is asking about.
      input.consentTextVersion,
    ]
  );
}
