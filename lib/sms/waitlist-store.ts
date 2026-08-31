// lib/sms/waitlist-store.ts — writing an area-waitlist opt-in, and nothing else.
//
// ⛔ THIS MODULE CANNOT SEND ANYTHING, BY CONSTRUCTION. It does not import the Twilio client and
// has no dispatch path. Jon authorised BUILDING the waitlist and separately withheld authority to
// send from it until the Operator rechecks the Twilio filing — so the write side and the send side
// are different modules, and the write side has no way to reach a phone even by mistake.
//   The composed message lives in waitlist-copy.ts; whatever eventually dispatches it must gate on
//   `waitlistNotificationsEnabled()`, which is separate from SMS_SENDING_ENABLED for that reason.
import { query } from '@/lib/db/client';
import { redactPhone } from './redact';
import { WAITLIST_CONSENT_VERSION } from './waitlist-copy';
import type { WaitlistEntry } from './waitlist-validate';

export type WaitlistWriteOutcome = 'added' | 'already_waiting' | 'error';

export interface WaitlistWriteResult {
  outcome: WaitlistWriteOutcome;
  id: string | null;
  error?: string;
}

/**
 * Record an opt-in. Idempotent per (number, area).
 *
 * ── WHAT THE UPSERT DOES AND DOES NOT TOUCH ─────────────────────────────────────────────
 * A repeat opt-in is a fresh act of consent, so `consent_timestamp` and the version are
 * re-stamped — the same reasoning sms_consent uses, and for the same audit reason: the record
 * should say what they most recently agreed to, and to which wording.
 *
 * `unsubscribed_at` is CLEARED, because opting in again after opting out is a deliberate act and
 * the row should reflect their current wish.
 *
 * ⚠ `notified_at` IS NEVER TOUCHED. The promise is ONE message. If we have already sent it,
 * re-opting-in must not re-arm a second — and a bug that reset this would be invisible until
 * somebody received the same "we've reached your area" text twice, months apart.
 */
export async function addToWaitlist(entry: WaitlistEntry): Promise<WaitlistWriteResult> {
  try {
    const rows = await query<{ id: string; inserted: boolean }>(
      `INSERT INTO sms_area_waitlist
         (phone_number, region_chip_id, area_fsa, waitlist_consent_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number, coalesce(region_chip_id, area_fsa)) DO UPDATE
         SET waitlist_consent_version = EXCLUDED.waitlist_consent_version,
             consent_timestamp        = now(),
             unsubscribed_at          = NULL
       RETURNING id, (xmax = 0) AS inserted`,
      [entry.phoneNumber, entry.regionChipId, entry.areaFsa, WAITLIST_CONSENT_VERSION]
    );

    const row = rows[0];
    if (!row) return { outcome: 'error', id: null, error: 'waitlist upsert returned no row' };
    return { outcome: row.inserted ? 'added' : 'already_waiting', id: row.id };
  } catch (cause) {
    // The number must never reach an error string: Postgres quotes the offending value on a
    // constraint violation, and this result is returned to a route that reports failures.
    // Same guarantee signup-store.ts makes, for the same reason.
    return {
      outcome: 'error',
      id: null,
      error: `waitlist write failed for ${redactPhone(entry.phoneNumber)}`,
      };
  }
}
