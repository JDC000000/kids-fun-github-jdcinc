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
