// lib/admin/sms-subscribers.ts — the read model behind /admin/sms-subscribers.
//
// Server-only: uses the shared service-level pg pool via lib/db/client, the same way
// lib/admin/dashboard.ts and lib/admin/data-health.ts do. Nothing here is importable from a
// client component, and nothing here should ever be.
//
// ═══ THIS MODULE HANDLES REAL PHONE NUMBERS, WHICH MAKES TWO THINGS NON-NEGOTIABLE ═══
// 1. Its only caller is a page behind app/admin/_lib/gate.ts. There is no API route over it.
// 2. It never writes a phone number into an error, a log line or a thrown message. A failure
//    here must be diagnosable from the subscriber id alone, because ids are safe to put in
//    Sentry and numbers are not.
//
// ═══ NULL PHONE NUMBER IS NOT A BUG, IT IS THE RETENTION PROMISE ═══
// sms_consent's personal columns are all nullable so the 30-day post-stop purge can erase them
// IN PLACE, keeping the CASL consent record (status, timestamps, version) while destroying the
// personal data. So a purged row is a normal, expected row with phone_number IS NULL. That is
// surfaced as an explicit `purged` flag rather than left for the UI to infer from a null,
// because "we deleted this on purpose" and "something went wrong" must never look the same on
// an admin screen.
import { query } from '@/lib/db/client';

/** Hard cap on the list page. Raise deliberately; an unbounded admin table is a slow page. */
export const SMS_SUBSCRIBER_LIST_LIMIT = 500;

export interface SmsSubscriberListRow {
  id: string;
  /** 0034's compact alias — bigint identity, database-issued, safe to display. */
  shortRef: string;
  /** E.164, or null when the retention purge has erased it. See `purged`. */
  phoneNumber: string | null;
  /** True when the personal data has been erased by the 30-day post-stop purge. */
  purged: boolean;
  status: string;
  consentMethod: string;
  consentTimestamp: string | null;
  confirmedTimestamp: string | null;
  consecutiveEmptyWeeks: number;
  stoppedAt: string | null;
}

export interface SmsSubscriberSummary {
  total: number;
  active: number;
  pending: number;
  paused: number;
  stopped: number;
  purged: number;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Count every subscriber by status, plus how many have been purged.
 *
 * Computed from the SAME rows the table renders rather than a separate COUNT query, so the tiles
 * and the table can never disagree about what is on screen — the failure mode where a summary
 * says 12 active and the list below it shows 11 because the two ran seconds apart.
 */
export function summariseSubscribers(rows: readonly SmsSubscriberListRow[]): SmsSubscriberSummary {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    paused: rows.filter((r) => r.status === 'paused').length,
    stopped: rows.filter((r) => r.status === 'stopped').length,
    purged: rows.filter((r) => r.purged).length,
  };
}

/** Every subscriber, newest consent first. */
export async function getSmsSubscribers(): Promise<SmsSubscriberListRow[]> {
  const rows = await query<{
    id: string;
    short_ref: string | number;
    phone_number: string | null;
    status: string;
    consent_method: string;
    consent_timestamp: Date | null;
    confirmed_timestamp: Date | null;
    consecutive_empty_weeks: number;
    stopped_at: Date | null;
  }>(
    `
    SELECT
      c.id,
      c.short_ref,
      c.phone_number,
      c.status,
      c.consent_method,
      c.consent_timestamp,
      c.confirmed_timestamp,
      c.consecutive_empty_weeks,
      c.stopped_at
    FROM sms_consent c
    ORDER BY c.consent_timestamp DESC
    LIMIT $1::int
    `,
    [SMS_SUBSCRIBER_LIST_LIMIT]
  );
  return rows.map((r) => ({
    id: r.id,
    // pg returns bigint as a string to avoid precision loss; normalise either shape.
    shortRef: String(r.short_ref),
    phoneNumber: r.phone_number,
    purged: r.phone_number === null,
    status: r.status,
    consentMethod: r.consent_method,
    consentTimestamp: toIso(r.consent_timestamp),
    confirmedTimestamp: toIso(r.confirmed_timestamp),
    consecutiveEmptyWeeks: Number(r.consecutive_empty_weeks),
    stoppedAt: toIso(r.stopped_at),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PAGE 2 — ONE SUBSCRIBER'S FULL SEND HISTORY
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Jon ruled for the more complete option: show the phone_hash-keyed history too, not only the
// rows still pointed at by subscriber_id.
//
// ═══ WHY BOTH KEYS ARE NEEDED, WHICH IS NOT THE REASON IT FIRST APPEARS ═══
// The obvious story is "subscriber_id goes away when a subscriber is purged, so fall back to the
// hash." That is not what happens. There are TWO different erasures in this system:
//
//   30-day post-stop purge   UPDATEs the personal columns to NULL and KEEPS the row. So
//                            subscriber_id still resolves, and the id-linked history is intact.
//   90-day never-confirmed   DELETEs the sms_consent row. ON DELETE SET NULL then nulls
//                            subscriber_id on the log rows — but that subscriber has no page-1
//                            row to drill into either, so this page never sees them.
//
// What the hash key ACTUALLY recovers is a re-signup: the same phone number consenting again gets
// a NEW sms_consent row with a NEW id, while its earlier send_log rows still carry the old id (or
// none). Those rows are the same person, and only phone_hash says so. Asking "what happened to
// this person" and getting only the current row's slice is the incomplete answer Jon rejected.
//
// ═══ AND WHERE THE HASH COMES FROM, WHICH IS THE PART WITH A TRAP IN IT ═══
// A purged subscriber's phone_number is NULL, so phoneHash() CANNOT be recomputed for them — the
// input was destroyed on purpose. The hash is instead read back off their OWN surviving log rows
// (reachable by subscriber_id, per the first bullet above) and used to find the rest. For a
// non-purged subscriber the hash is also computed from the number directly, which catches the one
// case the first path cannot: a re-signup that has not been texted yet, so has no rows of its own
// to read a hash from.
//
// ═══ THE HASH IS NEVER RETURNED FROM THIS MODULE ═══
// SMS_PHONE_HASH_SALT is a single GLOBAL salt (lib/sms/config.ts), and phone numbers are a small
// enough keyspace that a hash under one global salt is guess-and-checkable. So it is used inside
// the query and never crosses this boundary: no field of SmsSubscriberDetail contains it, there is
// no lookup-by-number entry point, and the page has no search box. The drill-down starts from a
// row an admin already has.
import { phoneHash } from '@/lib/sms/phone-hash';

/** Hard cap on one subscriber's history. */
export const SMS_SEND_HISTORY_LIMIT = 500;

export interface SmsSendLogRow {
  id: string;
  sendType: string;
  outcome: string;
  twilioSid: string | null;
  deliveryStatus: string | null;
  createdAt: string | null;
  /** False when this row is reachable only by phone_hash — an earlier signup of the same number. */
  linkedToThisRow: boolean;
}

export interface SmsSubscriberDetail {
  subscriber: SmsSubscriberListRow;
  sends: SmsSendLogRow[];
  /** True when the retention purge has erased the personal data behind this consent record. */
  purged: boolean;
}

export async function getSmsSubscriberDetail(id: string): Promise<SmsSubscriberDetail | null> {
  const [row] = await query<{
    id: string;
    short_ref: string | number;
    phone_number: string | null;
    status: string;
    consent_method: string;
    consent_timestamp: Date | null;
    confirmed_timestamp: Date | null;
    consecutive_empty_weeks: number;
    stopped_at: Date | null;
  }>(
    `SELECT id, short_ref, phone_number, status, consent_method, consent_timestamp,
            confirmed_timestamp, consecutive_empty_weeks, stopped_at
       FROM sms_consent WHERE id = $1::uuid`,
    [id]
  );
  if (!row) return null;

  // Null when the number is purged (nothing to hash) or the salt is unset. Both are handled by
  // the query, which falls back to the hashes carried on this subscriber's own rows.
  const currentHash = row.phone_number ? phoneHash(row.phone_number) : null;

  const sends = await query<{
    id: string;
    send_type: string;
    outcome: string;
    twilio_sid: string | null;
    delivery_status: string | null;
    created_at: Date | null;
    linked: boolean;
  }>(
    `
    WITH own_hashes AS (
      SELECT DISTINCT phone_hash FROM sms_send_log WHERE subscriber_id = $1::uuid
    )
    SELECT l.id, l.send_type, l.outcome, l.twilio_sid, l.delivery_status, l.created_at,
           (l.subscriber_id = $1::uuid) AS linked
      FROM sms_send_log l
     WHERE l.subscriber_id = $1::uuid
        OR l.phone_hash IN (SELECT phone_hash FROM own_hashes)
        OR ($2::text IS NOT NULL AND l.phone_hash = $2::text)
     ORDER BY l.created_at DESC
     LIMIT $3::int
    `,
    [id, currentHash, SMS_SEND_HISTORY_LIMIT]
  );

  return {
    subscriber: {
      id: row.id,
      shortRef: String(row.short_ref),
      phoneNumber: row.phone_number,
      purged: row.phone_number === null,
      status: row.status,
      consentMethod: row.consent_method,
      consentTimestamp: toIso(row.consent_timestamp),
      confirmedTimestamp: toIso(row.confirmed_timestamp),
      consecutiveEmptyWeeks: Number(row.consecutive_empty_weeks),
      stoppedAt: toIso(row.stopped_at),
    },
    sends: sends.map((s) => ({
      id: s.id,
      sendType: s.send_type,
      outcome: s.outcome,
      twilioSid: s.twilio_sid,
      deliveryStatus: s.delivery_status,
      createdAt: toIso(s.created_at),
      linkedToThisRow: Boolean(s.linked),
    })),
    purged: row.phone_number === null,
  };
}
