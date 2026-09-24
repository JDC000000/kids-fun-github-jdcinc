// lib/sms/inbound-reply-guard.ts — the two things that stop the inbound webhook's auto-reply from
// looping.
//
// ═══ THE INCIDENT (2026-09-24) ═══
// POST /api/sms/inbound answers ANY unrecognised text with "Sorry, we didn't catch that…". Our
// prod toll-free number and a QA test number both point their inbound webhooks here, so each
// one's reply was the other one's unrecognised text: ~60 messages in 39 seconds, stopped only by
// Twilio's own 14107 limit (>30 replies between one pair in 30s), which releases after 30s and is
// never tripped at all by a loop slower than one reply a second. Only our own numbers were
// involved, but the mechanism is identical against any parent's phone with an auto-responder
// (Android driving mode, carrier and business auto-replies), so there are two guards:
//
//   1. OWN NUMBER — never reply to a message FROM one of our own numbers. Pure logic, no I/O.
//   2. ONE PER SENDER PER DAY — at most one unknown-keyword reply per sender per UTC day, counted
//      in `sms_signup_throttle` under scope 'unknown_reply' (migration 0054), by the same
//      race-safe upsert every other SMS limit here uses (lib/sms/throttle.ts).
//
// Either guard alone breaks a loop between two of our numbers; only the second one bounds a loop
// with a stranger's auto-responder, which is the case that actually matters.

import { createHmac } from 'node:crypto';
import { query } from '@/lib/db/client';
import { phoneHashSalt, smsTestNumbers } from './config';
import { SUPPORT_PHONE_E164 } from './consent-copy';
import { countAttempt } from './throttle';

/** Digits only, so `+1 877-835-7776` and `+18778357776` compare equal. Same rule as config.ts. */
function digitsOf(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Is `from` one of OUR numbers? True when it is the toll-free number, the number the message
 * arrived at (`to` — whatever of ours Twilio delivered to is ours by definition), or any number
 * in SMS_TEST_NUMBERS.
 *
 * ═══ KEYING ON `From` IS SAFE HERE, UNLIKE `isTestDestination` ═══
 * config.ts is right that `From` must never decide what a message DOES — a spoofed sender could
 * then mark a real subscriber as a test row. This only ever decides to say NOTHING. The worst a
 * spoofed `From` can achieve is suppressing one "reply JOIN" hint to ourselves.
 */
export function isOwnNumber(from: string | null | undefined, to: string | null | undefined): boolean {
  const sender = digitsOf(from);
  if (sender.length === 0) return false;
  const ours = new Set<string>([digitsOf(SUPPORT_PHONE_E164), ...smsTestNumbers()]);
  const receiver = digitsOf(to);
  if (receiver.length > 0) ours.add(receiver);
  return ours.has(sender);
}

/**
 * One unknown-keyword reply per sender per UTC day.
 *
 * ⚠ UTC DAY, NOT A ROLLING 24h. `sms_signup_throttle` buckets by `window_date`, so the count
 * resets at 00:00 UTC (17:00 Pacific in summer). Worst case: two replies to one sender a few
 * minutes apart across that boundary — still a hard bound of ≤2/day on any loop, against
 * unbounded before. `minIntervalSeconds` cannot close that gap because a new day is a new row.
 */
export const UNKNOWN_REPLY_LIMITS = { perDay: 1, minIntervalSeconds: 0 } as const;

export type UnknownReplyDecision =
  | { allowed: true }
  | { allowed: false; reason: 'daily_cap' | 'no_salt' | 'db_error'; error?: unknown };

/**
 * Count one unknown-keyword reply against `from`, and say whether it may go out.
 *
 * ═══ 🔴 FAILS CLOSED ═══
 * No salt, a DB error, or migration 0054 not yet applied (a 23514 check_violation) all mean NO
 * REPLY. The trade is lopsided: a missing "reply JOIN" hint costs one confused stranger a second
 * text; an unmetered reply is the loop this file exists to prevent. That also removes any deploy-
 * order hazard — code shipped ahead of the migration is merely silent on this branch.
 * The caller reports `no_salt` / `db_error` to Sentry; `daily_cap` is normal operation.
 */
export async function checkAndRecordUnknownReply(
  from: string,
  options: { query?: typeof query } = {}
): Promise<UnknownReplyDecision> {
  const salt = phoneHashSalt();
  if (!salt) return { allowed: false, reason: 'no_salt' };
  // Hashed on DIGITS so formatting variants of one number share a counter; domain-separated from
  // every other HMAC under the same salt (phone-hash.ts uses 'sms-phone:', the send throttle
  // 'sms-instant-picks-send:').
  const subject = createHmac('sha256', salt)
    .update(`sms-unknown-reply:${digitsOf(from)}`)
    .digest('hex');
  try {
    const { allowed } = await countAttempt(
      options.query ?? query,
      'unknown_reply',
      subject,
      UNKNOWN_REPLY_LIMITS.perDay,
      UNKNOWN_REPLY_LIMITS.minIntervalSeconds
    );
    return allowed ? { allowed: true } : { allowed: false, reason: 'daily_cap' };
  } catch (error) {
    return { allowed: false, reason: 'db_error', error };
  }
}
