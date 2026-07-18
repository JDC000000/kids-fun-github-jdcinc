// lib/email/send-log.ts — read/write the weekly_email_send watermark + audit log.
//
// This is a SYSTEM job that spans all users, so it uses the service pool
// (lib/db/client.ts, DATABASE_URL — bypasses RLS by design) rather than
// withUserContext (which is for user-facing, owner-scoped CRUD). weekly_email_send
// is default-deny RLS (0017), so only this service-role path can touch it. Every
// query still filters by an explicit user_id.
import { query } from '@/lib/db/client';

/**
 * The user's last REAL send timestamp (the digest watermark), or null if never
 * sent. Dry-run records are excluded so a verification run never advances the
 * real watermark.
 */
export async function getLastSentAt(userId: string): Promise<Date | null> {
  const rows = await query<{ last: Date | string | null }>(
    `SELECT max(sent_at) AS last FROM weekly_email_send WHERE user_id = $1 AND dry_run = false`,
    [userId]
  );
  const last = rows[0]?.last ?? null;
  return last ? new Date(last) : null;
}

export interface RecordSendInput {
  userId: string;
  activityCount: number;
  resendId?: string | null;
  dryRun?: boolean;
}

/** Append a send record (the CASL audit trail + watermark advance for real sends). */
export async function recordWeeklySend(input: RecordSendInput): Promise<void> {
  await query(
    `INSERT INTO weekly_email_send (user_id, activity_count, resend_id, dry_run)
       VALUES ($1, $2, $3, $4)`,
    [input.userId, input.activityCount, input.resendId ?? null, input.dryRun ?? false]
  );
}
