// The resend-suppression window's bounds — the half of tests/sms/weekly_recency_suppression-db.test.ts
// that does not need a database.
//
// WHY A TEST FOR ONE NUMBER. The window sits between two failure modes that point in opposite
// directions, and only one of them is loud:
//   · TOO SHORT and it fails to absorb a same-week immediate send, which is the duplicate message
//     it exists to prevent. Visible — somebody gets two texts and says so.
//   · TOO LONG and it swallows the seven-day Friday-to-Friday cadence itself. SILENT — the batch
//     selects nobody, `sendWeeklySmsBulk` returns its normal "an empty batch is a normal Friday"
//     result, and the product stops texting anyone while every run reports success.
// The second is the one worth a guard, because nothing else in the system would notice it. This is
// the same shape as the failure 0039's header warns about for the retention job: "a job that runs
// and silently purges nothing would reproduce the exact bug this migration exists to fix."
import { describe, expect, it } from 'vitest';
import { RESEND_SUPPRESSION_WINDOW_DAYS } from '@/lib/sms/weekly-send-io';

/** Friday to Friday. The cadence the window must never reach. */
const WEEKLY_CADENCE_DAYS = 7;

describe('RESEND_SUPPRESSION_WINDOW_DAYS', () => {
  it('is strictly shorter than the weekly cadence, so it can never mute the Friday send', () => {
    expect(RESEND_SUPPRESSION_WINDOW_DAYS).toBeLessThan(WEEKLY_CADENCE_DAYS);
  });

  it('keeps at least a day of headroom, so a send running late still goes out', () => {
    // A batch that starts late, retries, or straddles midnight must not land inside the window of
    // the send seven days before it. Equality alone would leave no margin for either.
    expect(WEEKLY_CADENCE_DAYS - RESEND_SUPPRESSION_WINDOW_DAYS).toBeGreaterThanOrEqual(1);
  });

  it('is long enough to cover a signup anywhere in the back half of the week', () => {
    // The motivating case: an immediate first send on a Thursday evening must still be suppressing
    // the Friday batch the next afternoon. Anything below 2 fails to span even that one night.
    expect(RESEND_SUPPRESSION_WINDOW_DAYS).toBeGreaterThanOrEqual(2);
  });
});
