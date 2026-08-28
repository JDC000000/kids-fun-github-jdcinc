// lib/sms/phone-hash.ts — the durable identity in the CASL audit trail.
//
// DRAFT (SMS pivot), Stage B. Construction approved by the Operator: HMAC-SHA256 over the E.164
// number with `SMS_PHONE_HASH_SALT`, matching what migration 0035's own comments already assumed.
//
// ═══ WHAT THIS IS FOR, WHICH IS NOT WHAT A HASH IS USUALLY FOR ═══
// `sms_send_log.phone_hash` is NOT NULL on every row, including rows whose subscriber still
// exists. It is the ONLY identifier that survives migration 0034's 30-day purge, which NULLs
// `sms_consent.phone_number` in place and leaves `sms_send_log.subscriber_id` pointing at a row
// with no number in it.
//
// So the question it answers is exactly one question, and it is the question CASL asks:
// **"somebody complains about a text sent to +1604…; what did you send them, when, and under which
// consent wording?"** Without this column that is unanswerable a month after they unsubscribe —
// which is precisely when a complaint arrives.
//
// ═══ WHY A SALTED HMAC AND NOT A BARE DIGEST ═══
// The space of Canadian mobile numbers is about 10^10 and a bare SHA-256 of every one of them is
// minutes of work on a laptop. An unsalted hash column would be a phone-number list with extra
// steps. The salt is what makes the column non-reversible in practice, which is what lets it be
// retained indefinitely after the rest of the row is purged.
//
// THE SALT IS A REAL SECRET. It is not a config value with a sensible default, and there is
// deliberately no fallback: see `phoneHash`.
//
// ═══ WHY THE VERSION COLUMN EXISTS — ROUND 2'S FINDING, AND IT STILL BITES ═══
// `phone_hash_version` records WHICH salt generation produced a hash. Without it, rotating the
// salt silently makes every historical hash unmatchable: the lookup for a complaint returns
// nothing, no error is raised anywhere, and the audit trail appears empty rather than broken. With
// it, a rotation is a fact you can see and search across.

import { createHmac } from 'node:crypto';
import { phoneHashSalt } from './config';

/**
 * The salt generation in force for rows written today.
 *
 * BUMP THIS AND THE SALT TOGETHER, never one alone. Rows written before a rotation keep their old
 * version, so a complaint about an old number is answered by hashing it under the salt that
 * version names — which is why rotation needs a documented map of version → salt, not just a new
 * environment variable. There is one generation so far.
 */
export const PHONE_HASH_VERSION = 1;

/**
 * Hash an E.164 number for the audit trail, or null when no salt is configured.
 *
 * ═══ NULL RATHER THAN A FALLBACK, AND THIS ONE MATTERS MORE THAN THE USUAL FAIL-CLOSED ═══
 * There is no default salt and there must never be one. A hard-coded or empty salt would produce
 * a column that LOOKS like a protected identifier and is actually a reversible phone-number list —
 * and it would look correct in every test, because the shape is identical. The failure has to be
 * visible, so it is: `recordSmsSend` refuses to write a row it cannot hash.
 *
 * ⚠ THE CONSEQUENCE, STATED SO IT IS NOT DISCOVERED LATER: with no salt configured there is NO
 * CASL AUDIT TRAIL. Messages still send — the log write is best-effort at every call site, by
 * design, because losing an audit row must not cost a parent their text — so the failure is quiet
 * unless somebody is watching for it. Provisioning this secret is a launch requirement, not a
 * nice-to-have.
 *
 * DOMAIN-SEPARATED, like the preferences token: even if this salt were ever reused elsewhere, the
 * two hash families could not collide.
 */
export function phoneHash(e164: string): string | null {
  const salt = phoneHashSalt();
  if (!salt) return null;
  return createHmac('sha256', salt).update(`sms-phone:${e164}`).digest('hex');
}

/** Thrown when a row cannot be written because the salt is missing. Greppable on purpose. */
export class MissingPhoneHashSaltError extends Error {
  constructor() {
    // NO NUMBER IN THE MESSAGE. This propagates into caller error strings and log lines.
    super('SMS_PHONE_HASH_SALT is not configured — refusing to write an sms_send_log row');
    this.name = 'MissingPhoneHashSaltError';
  }
}
