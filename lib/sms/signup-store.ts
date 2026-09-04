// lib/sms/signup-store.ts — persisting a signup, and asking for confirmation.
//
// DRAFT (SMS pivot). Both functions here are REAL: `createPendingSubscriber` issues the upsert
// against `sms_consent` (migration 0034, applied by the Operator) and `sendConfirmationRequest`
// renders, dispatches and logs the confirmation text. tests/sms/signup_persistence-db.test.ts
// exercises the store against a real database.
//
// WHAT IS REAL ALREADY: the validated `SmsSignup` (lib/sms/signup-validate.ts) is exactly the
// column set of one pending `sms_consent` row, so filling these in is mechanical rather than
// archaeological. Read the SQL in each TODO before implementing — the non-obvious parts are
// written out.

import { createHmac } from 'node:crypto';
import { query } from '@/lib/db/client';
import { areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { phoneHashSalt, smsSendingEnabled } from './config';
import { renderConfirmRequestMessage } from './message';
import { phoneHash } from './phone-hash';
import { mintPreferencesToken } from './preferences-token';
import { redactPhone } from './redact';
import type { SmsSignup } from './signup-validate';
import { dispatchSms, type DispatchResult } from './twilio-client';
import { recordSmsSend } from './send-log';

export type SignupWriteOutcome =
  | 'created'
  | 'reactivated'
  /**
   * The number is ALREADY an active subscriber, and NOTHING WAS WRITTEN.
   *
   * Not a variant of 'reactivated'. On this outcome the upsert's DO UPDATE branch was skipped
   * outright, so the row keeps its status, its confirmed_timestamp, its consent stamp and its
   * stored preferences — see the guard on `createPendingSubscriber`, which explains why an
   * already-confirmed number is the one case that must not be re-consented by an unauthenticated
   * form post.
   *
   * `subscriberId` is null here BY DESIGN even though the row plainly exists: no confirmation is
   * sent on this path and no audit row is written, so nothing downstream has any use for the id,
   * and handing one back would be the start of leaking it.
   */
  | 'already_active'
  | 'dry_run'
  | 'error';

export interface SignupWriteResult {
  outcome: SignupWriteOutcome;
  /** Populated once implemented. Never returned to the browser — see the route. */
  subscriberId: string | null;
  error?: string;
  /**
   * Was this number ALREADY an active subscriber before this write? (Jon's ruling, 2026-08-28.)
   *
   * The upsert resets an active row to 'pending' and clears `confirmed_timestamp`, which is correct
   * CASL behaviour — re-consent that skipped the double opt-in would not be double opt-in — but it
   * happens silently. This flag is what lets a surface say so.
   *
   * ⚠ IT IS NOT AUTOMATICALLY SAFE TO RETURN TO THE BROWSER. See the disclosure note on the route.
   */
  wasActive?: boolean;
  /**
   * Did this write REPLACE stored preferences with different ones? Postal code, children's ages or
   * interests differing from what was already on the row.
   *
   * Separate from `wasActive` because they are different losses and a resubmitting parent can
   * suffer either, both, or neither: a PENDING subscriber who resubmits loses saved preferences
   * without any status change, and an ACTIVE one who resubmits identical details loses only the
   * confirmation. Live reproduction 2026-08-28: a hub save of four interests plus a new postal code
   * and age was silently reverted by one later signup submission.
   */
  preferencesReplaced?: boolean;
}

export interface SignupWriteOptions {
  /** Defaults to !smsSendingEnabled() — a real write requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
  /** Injected for tests; defaults to the shared pool in lib/db/client.ts. */
  query?: typeof query;
}

/**
 * Create (or revive) the pending `sms_consent` row for one signup.
 *
 * AN UPSERT, NOT AN INSERT:
 *
 *   INSERT INTO sms_consent
 *     (phone_number, postal_code, birth_years, category_interests,
 *      status, consent_method, consent_timestamp, consent_text_version, preferences_token)
 *   VALUES ($1, $2, $3, $4, 'pending', $5, now(), $6, $7)
 *   ON CONFLICT (phone_number) DO UPDATE SET
 *     postal_code          = EXCLUDED.postal_code,
 *     birth_years          = EXCLUDED.birth_years,
 *     category_interests   = EXCLUDED.category_interests,
 *     status               = 'pending',
 *     consent_method       = EXCLUDED.consent_method,
 *     consent_timestamp    = now(),
 *     consent_text_version = EXCLUDED.consent_text_version,
 *     confirmed_timestamp  = NULL,
 *     stopped_at           = NULL,
 *     consecutive_empty_weeks = 0
 *   RETURNING id, short_ref;
 *
 * WHY AN UPSERT — the part that is easy to get wrong. `sms_consent` has a UNIQUE index on
 * phone_number (migration 0034), so a plain INSERT raises 23505 for anyone who has submitted
 * this form before: a parent correcting a typo in their postal code, a stopped subscriber
 * signing up again, or someone who simply tapped submit twice. All three are legitimate and none
 * is an error a form should show. Consent is per NUMBER, not per row.
 *
 * RE-STAMPING consent_timestamp AND consent_text_version IS THE POINT, not incidental. This is a
 * fresh act of express consent against whatever wording is on the page today, and the CASL record
 * must say so. Clearing confirmed_timestamp and stopped_at, and resetting the empty-week counter,
 * put the row back at the start of the lifecycle — a resubmission means they have to reply JOIN
 * again, which is correct: re-consent that skipped the double opt-in would not be double opt-in.
 *
 * ⛔ WITH ONE EXCEPTION, AND IT IS THE WHOLE REASON THIS FUNCTION WAS TOUCHED AGAIN: ⛔
 * ═══ AN `active` ROW IS LEFT COMPLETELY ALONE. `WHERE sms_consent.status <> 'active'`. ═══
 *
 * The paragraph above is right about a PENDING or STOPPED row and was wrong about an ACTIVE one,
 * and the difference is who is standing at the keyboard. This endpoint is unauthenticated and the
 * caller has not proved they hold the number they typed. For a number nobody has confirmed, the
 * worst a stranger's submission can do is cost that handset one confirmation SMS. For a number
 * that IS confirmed, the same submission used to:
 *
 *   • knock a working subscriber back to `pending` and clear `confirmed_timestamp`, so their
 *     Friday picks stopped until they noticed a text they did not ask for and replied JOIN;
 *   • overwrite their postal code, their children's ages and their interests with whatever the
 *     submitter typed — reproduced live on 2026-08-28, where a hub save of four interests plus a
 *     new postal code was reverted by one later form post;
 *   • re-stamp `consent_timestamp`/`consent_text_version`, i.e. write a CASL record asserting a
 *     fresh act of express consent by a person who did nothing;
 *   • and fire another confirmation SMS at them, every single time, with no throttle anywhere.
 *
 * None of that is re-consent. The double opt-in for this number is ALREADY COMPLETE — they
 * replied JOIN, we have `confirmed_timestamp` to prove it, and it has not been revoked — so there
 * is nothing a second confirmation would establish that the first one did not. The honest
 * behaviour is to change nothing and say so, which is `outcome: 'already_active'`.
 *
 * NOT A NARROWER FIX (e.g. "keep the status but still save the preferences"), deliberately. We
 * cannot tell the subscriber from a stranger here, so writing ANY of the submitted fields onto a
 * confirmed row lets an anonymous caller edit somebody else's subscription. The real subscriber
 * already has an authenticated path for exactly this: the `/u/{preferencesToken}` hub link that
 * ships in every message (PRD §2.4). Sending them there costs one screen; the alternative costs
 * them their data.
 *
 * ⚠ AND IT IS A DISCLOSURE, WHICH IS A REAL COST AND WAS TAKEN KNOWINGLY. Reporting
 * 'already_active' tells an unauthenticated caller that a number they typed is a subscriber —
 * exactly the oracle consent-copy.ts's SUBMITTED_BODY note refuses to build out of conditional
 * copy. That refusal was the right default while the alternative was "say nothing and behave
 * identically"; it is not the right answer when behaving identically means texting a stranger's
 * handset on demand and silently unsubscribing them. Jon authorised the trade on 2026-09-04.
 * What limits the damage is the throttle below: enumeration costs 5 numbers per 10 minutes per
 * IP, not thousands.
 *
 * WHAT MUST NOT HAPPEN HERE: this must never write `status = 'active'`. Only a JOIN reply may do
 * that (lib/sms/consent-transitions.ts), because the whole value of the double opt-in is that
 * nobody can subscribe a phone number they do not hold.
 *
 * IT ALSO MINTS `preferences_token` — an HMAC over the new row's id with SMS_PREFERENCES_SECRET
 * (see lib/sms/preferences-token.ts), in a second statement because the id does not exist until
 * the first one returns.
 *
 * THE `sms_send_log` ROW FOR THE CONFIRMATION REQUEST IS NOT WRITTEN HERE. An earlier draft of
 * this comment listed it as part of this function's job, which would have produced TWO audit rows
 * for one message once both halves were implemented: `sendConfirmationRequest` below now writes
 * it, on the send it actually performed and with that send's real outcome. A row written here
 * could only ever have claimed 'sent' before anything was sent.
 */
export async function createPendingSubscriber(
  signup: SmsSignup,
  options: SignupWriteOptions = {}
): Promise<SignupWriteResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  if (dryRun) return { outcome: 'dry_run', subscriberId: null };

  const run = options.query ?? query;

  try {
    // ONE STATEMENT. The upsert and the "was this new?" answer come back together, because doing
    // it as a SELECT-then-INSERT would race two simultaneous submissions of the same number
    // straight into the UNIQUE index — which is exactly the collision the upsert exists to absorb.
    //
    // `xmax = 0` IS THE STANDARD POSTGRES TRICK for "did this row come from the INSERT or the
    // UPDATE branch". On a freshly inserted tuple the xmax system column is 0; on one updated by
    // ON CONFLICT it carries the updating transaction. It is not pretty and it is not in the
    // documentation as an API, but the alternative — a second round trip, or a RETURNING that
    // cannot tell the branches apart — is worse. Asserted directly in the db-lane test.
    const rows = await run<{
      id: string;
      short_ref: string | number;
      inserted: boolean;
      prior_status: string | null;
      preferences_replaced: boolean | null;
    }>(
      // THE `prior` CTE READS THE ROW AS IT WAS BEFORE THIS STATEMENT, so the upsert reports what
      // it overwrote without a second round trip and WITHOUT THE RACE a separate SELECT would have.
      // Every sub-statement of one statement sees the same snapshot, so `prior` cannot observe this
      // upsert's own effect — which a preceding `SELECT ... ; INSERT ...` pair could not guarantee.
      // RETURNING alone cannot do this: it reflects the row AFTER the update.
      `WITH prior AS (
         SELECT status, postal_code, birth_years, category_interests
           FROM sms_consent WHERE phone_number = $1
       )
       INSERT INTO sms_consent
         (phone_number, postal_code, birth_years, category_interests,
          status, consent_method, consent_timestamp, consent_text_version)
       VALUES ($1, $2, $3, $4, 'pending', $5, now(), $6)
       ON CONFLICT (phone_number) DO UPDATE SET
         postal_code             = EXCLUDED.postal_code,
         birth_years             = EXCLUDED.birth_years,
         category_interests      = EXCLUDED.category_interests,
         status                  = 'pending',
         consent_method          = EXCLUDED.consent_method,
         consent_timestamp       = now(),
         consent_text_version    = EXCLUDED.consent_text_version,
         confirmed_timestamp     = NULL,
         stopped_at              = NULL,
         consecutive_empty_weeks = 0
       -- ⛔ THE ONE ROW THIS STATEMENT REFUSES TO TOUCH. See the doc comment above for why an
       -- already-confirmed subscriber must not be re-consented, re-preferenced or re-texted by an
       -- unauthenticated form post. A false WHERE here skips the conflict action ENTIRELY — the
       -- row is not updated and, crucially, NOT RETURNED, which is what the empty-rows branch
       -- below reads as 'already_active'. Putting the guard here rather than wrapping every SET
       -- in a CASE keeps it impossible to add a fourth column later and forget to exempt it.
       WHERE sms_consent.status <> 'active'
       RETURNING id, short_ref, (xmax = 0) AS inserted,
                 (SELECT status FROM prior) AS prior_status,
                 (SELECT postal_code FROM prior) IS DISTINCT FROM $2
                   OR (SELECT birth_years FROM prior) IS DISTINCT FROM $3
                   OR (SELECT category_interests FROM prior) IS DISTINCT FROM $4
                   AS preferences_replaced`,
      [
        signup.phoneNumber,
        signup.postalCode,
        signup.birthYears,
        signup.categoryInterests,
        signup.consentMethod,
        signup.consentTextVersion,
      ]
    );

    const row = rows[0];
    if (!row) {
      // ═══ NO ROW NOW MEANS EXACTLY ONE THING, AND IT IS NOT AN ERROR ═══
      // It used to be unreachable ("an upsert always returns its row"), and the branch existed
      // only so a silent undefined could not become a confident `subscriberId: null`. Adding
      // `WHERE sms_consent.status <> 'active'` to the conflict action gave it a second,
      // DETERMINISTIC meaning, and it is worth stating why no third one is possible:
      //
      //   • the INSERT branch always inserts and always returns;
      //   • the conflict branch with a non-active row always updates and always returns;
      //   • the conflict branch with an ACTIVE row is skipped and returns nothing.
      //
      // So zero rows ⟺ "this number is already an active subscriber, and we deliberately left it
      // untouched". Reporting that as an error would 503 a request that succeeded at exactly what
      // it was supposed to do.
      return { outcome: 'already_active', subscriberId: null, wasActive: true, preferencesReplaced: false };
    }

    // ── The preferences token, minted from the id the database just assigned ──
    // SECOND STATEMENT, and it has to be: the token is an HMAC over the row id, and the id does
    // not exist until the insert has run. Generating a uuid client-side to get one round trip
    // would break the upsert — on the conflict branch the row keeps its ORIGINAL id, so a token
    // computed from a locally-invented one would be wrong for the row it landed on.
    //
    // `WHERE preferences_token IS NULL` so a returning subscriber KEEPS THE LINK THEY HAVE. Their
    // old messages still carry it, and re-minting would silently break every one of them.
    const token = mintPreferencesToken(row.id);
    if (token) {
      await run(
        `UPDATE sms_consent SET preferences_token = $2
          WHERE id = $1 AND preferences_token IS NULL`,
        [row.id, token]
      );
    }

    return {
      outcome: row.inserted ? 'created' : 'reactivated',
      // BOTH GUARDED ON `!row.inserted`, and that is not defensive tidiness. On the INSERT branch
      // the `prior` CTE is EMPTY, so every `IS DISTINCT FROM` against it answers TRUE — a brand-new
      // signup would otherwise report that it had replaced preferences it never had.
      wasActive: !row.inserted && row.prior_status === 'active',
      preferencesReplaced: !row.inserted && row.preferences_replaced === true,
      subscriberId: row.id,
    };
  } catch (err) {
    // NEVER LET THE NUMBER REACH THE ERROR STRING. Postgres echoes the offending values back on a
    // constraint violation — `Key (phone_number)=(+1604...) already exists` — and this result is
    // returned to a route that reports failures. Same discipline as lib/sms/weekly-send-io.ts.
    return {
      outcome: 'error',
      subscriberId: null,
      error: `write failed: ${redactSqlError(err, signup.phoneNumber)}`,
    };
  }
}

/**
 * A database error, with the subscriber's number taken out of it.
 *
 * Postgres constraint violations quote the offending value: a UNIQUE violation on
 * `phone_number` produces `Key (phone_number)=(+16045550123) already exists`. That string reaches
 * a route's error handling and, from there, a log line.
 *
 * BOTH the code and a scrubbed message, because the code alone is often not enough to act on and
 * the message alone is not safe. The scrub matches the exact E.164 string we hold — a backstop,
 * named as one, exactly like `scrubNumber` in lib/sms/weekly-send-io.ts.
 */
function redactSqlError(err: unknown, phoneNumber: string): string {
  const code = (err as { code?: string })?.code;
  const raw = (err as Error)?.message ?? 'unknown error';
  const scrubbed =
    phoneNumber && raw.includes(phoneNumber)
      ? raw.split(phoneNumber).join(redactPhone(phoneNumber))
      : raw;
  return code ? `[${code}] ${scrubbed}` : scrubbed;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE SIGNUP THROTTLE (migration 0045)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// POST /api/sms/signup had no rate limiting anywhere. Every submission dispatched a confirmation
// SMS to the number typed into the form, and nothing stopped the same number being submitted
// again immediately, or a thousand times. That makes a public form a remote control for somebody
// else's handset, and the person it costs never touched the site.
//
// TWO LIMITS, AND THEY ANSWER DIFFERENT QUESTIONS:
//   • PER NUMBER  — protects ONE handset from repeated confirmation texts. This is the half that
//     actually stops the harm, and it is the half that cannot be evaded, because the number is
//     the thing the text is sent to.
//   • PER IP      — defence in depth against ONE caller spraying MANY different numbers, which
//     the per-number limit cannot see at all. Weaker on purpose and never trusted alone: it
//     derives from a forwarded-for header the client can influence, and a shared NAT (a school, a
//     library, a mobile carrier) puts real families behind one address. Hence limits that a
//     household could not plausibly hit and an attacker cannot ignore.

/** Every knob the throttle has, in one place. Exported so tests set limits instead of waiting. */
export interface SignupThrottleLimits {
  /** Seconds that must pass between two ALLOWED signups for the same phone number. */
  readonly phoneMinIntervalSeconds: number;
  /** Allowed signups per phone number per UTC day. */
  readonly phonePerDay: number;
  /** Seconds that must pass between two ALLOWED signups from the same IP. */
  readonly ipMinIntervalSeconds: number;
  /** Allowed signups per IP per UTC day. */
  readonly ipPerDay: number;
}

/**
 * The production limits.
 *
 * PER NUMBER: one every ten minutes, three a day. A parent who did not get the text is asked to
 * wait ten minutes; an attacker gets three texts a day out of a handset instead of unlimited.
 *
 * PER IP: thirty seconds apart, twenty a day. The daily cap is the one that bites — thirty seconds
 * only exists so a script cannot burn the whole day's budget in one burst. Twenty distinct signups
 * from a single address in a day is far outside anything a household or a school produces for a
 * product this size, and it bounds a spraying attacker to twenty strangers' phones per address
 * rather than an unbounded number. IF A REAL SHARED-NAT COMPLAINT EVER ARRIVES, THIS NUMBER IS
 * THE THING TO RAISE — not the per-number limits, which are what protect people.
 */
export const SIGNUP_THROTTLE_LIMITS: SignupThrottleLimits = {
  phoneMinIntervalSeconds: 600,
  phonePerDay: 3,
  ipMinIntervalSeconds: 30,
  ipPerDay: 20,
};

/** Which limit refused, for logs and metrics. NEVER returned to the caller — see the route. */
export type SignupThrottleReason = 'phone_interval' | 'phone_daily' | 'ip_interval' | 'ip_daily';

export interface SignupThrottleResult {
  allowed: boolean;
  /** Null when allowed. */
  reason: SignupThrottleReason | null;
  /** Whole seconds until the refused limit next admits a request. At least 1 when refused, else 0. */
  retryAfterSeconds: number;
  /**
   * The check could not run, and the request was LET THROUGH.
   *
   * ═══ FAIL OPEN, WHICH IS THE OPPOSITE OF THIS MODULE'S USUAL POSTURE, ON PURPOSE ═══
   * `createPendingSubscriber` 503s on a failed write and `phoneHash` refuses to invent a value,
   * both fail-closed. This one goes the other way, for a reason specific to what it is: a
   * throttle that fails closed converts "the counter table is unreachable" into "nobody in Metro
   * Vancouver can sign up", and the two ways it can be unreachable are a database outage — in
   * which case `createPendingSubscriber` is about to 503 anyway, so failing closed here buys
   * nothing — and migration 0045 not being applied yet, which is a deploy-ordering state, not an
   * attack.
   * ⚠ SO IT IS NOISY RATHER THAN SILENT. The route captures this to Sentry, because "the abuse
   * throttle has been inert since Tuesday" is not a thing to find out from a complaint.
   */
  degraded: boolean;
}

export interface SignupThrottleInput {
  /** E.164, as validated. Hashed before it goes anywhere near the database. */
  phoneNumber: string;
  /** The caller's IP, or null when the request carried no usable one. Hashed the same way. */
  ipAddress: string | null;
}

export interface SignupThrottleOptions extends SignupWriteOptions {
  limits?: SignupThrottleLimits;
}

/**
 * HMAC the throttle's IP subject.
 *
 * SHARES `SMS_PHONE_HASH_SALT` WITH THE AUDIT TRAIL, DOMAIN-SEPARATED. Adding an eighth secret
 * would mean this fix could not ship until somebody provisioned it in production, and a throttle
 * that is inert because a variable is missing is exactly the failure it exists to prevent. The
 * `sms-signup-ip:` prefix mirrors `phoneHash`'s own `sms-phone:` so the two families cannot
 * collide even under one salt — the same argument lib/sms/phone-hash.ts already makes for
 * separating itself from the preferences token.
 *
 * Null when there is no IP, and null when there is no salt — both mean "cannot throttle by IP",
 * and the caller degrades to the per-number limit rather than inventing a subject.
 */
function signupIpHash(ip: string | null): string | null {
  if (!ip) return null;
  const salt = phoneHashSalt();
  if (!salt) return null;
  return createHmac('sha256', salt).update(`sms-signup-ip:${ip}`).digest('hex');
}

/**
 * Count one signup attempt against one subject, and say whether it is allowed — ATOMICALLY.
 *
 * ═══ THE DECISION AND THE WRITE ARE ONE STATEMENT, AND THAT IS THE WHOLE POINT ═══
 * The readable implementation is `SELECT count(...)` then `INSERT`, and it does not work: two
 * concurrent POSTs both take their snapshot before either writes, both see the same count, and
 * both are allowed. Serverless is precisely where fifty simultaneous requests are one line of
 * shell, so a check-then-write throttle throttles only polite callers. Putting the INSERT in a
 * CTE of the SELECT does not help either — same snapshot, same race.
 *
 * `ON CONFLICT ... DO UPDATE` takes a ROW LOCK on the conflicting row, so the second request
 * blocks until the first commits and then re-evaluates its `WHERE` against the row the first one
 * just wrote. One round trip, no window.
 *
 * ZERO ROWS RETURNED ⟺ REFUSED. When the `WHERE` is false the conflict action is skipped
 * entirely: nothing is updated and nothing is returned. That also means A REFUSED ATTEMPT DOES
 * NOT MOVE `last_attempt_at`, so hammering cannot extend a caller's own lockout — which matters
 * because the caller retrying three times in a minute is usually a parent who did not get the
 * text, not an attacker.
 */
async function countAttempt(
  run: typeof query,
  scope: 'phone' | 'ip',
  subjectHash: string,
  perDay: number,
  minIntervalSeconds: number
): Promise<{ allowed: boolean; attempts: number }> {
  const rows = await run<{ attempts: number }>(
    `INSERT INTO sms_signup_throttle (scope, subject_hash)
          VALUES ($1, $2)
     ON CONFLICT (scope, subject_hash, window_date) DO UPDATE
            SET attempts        = sms_signup_throttle.attempts + 1,
                last_attempt_at = now()
          WHERE sms_signup_throttle.attempts < $3
            AND sms_signup_throttle.last_attempt_at <= now() - make_interval(secs => $4::int)
      RETURNING attempts`,
    [scope, subjectHash, perDay, minIntervalSeconds]
  );
  const row = rows[0];
  return { allowed: Boolean(row), attempts: row?.attempts ?? 0 };
}

/**
 * WHY the refused subject was refused, and for how long. Read-only, and only on the refused path.
 *
 * A second query rather than more RETURNING, because there is nothing to return: the whole point
 * of the statement above is that it touches no row when it refuses. This one runs at most once
 * per rejected request, which is the request we are least worried about the cost of.
 *
 * Falls back to the minimum interval if the row has vanished between the two statements (a
 * retention sweep at midnight, essentially), rather than reporting a confident zero.
 */
async function explainRefusal(
  run: typeof query,
  scope: 'phone' | 'ip',
  subjectHash: string,
  perDay: number,
  minIntervalSeconds: number
): Promise<{ daily: boolean; retryAfterSeconds: number }> {
  const rows = await run<{ attempts: number; since_last: number }>(
    `SELECT attempts, extract(epoch FROM now() - last_attempt_at)::int AS since_last
       FROM sms_signup_throttle
      WHERE scope = $1 AND subject_hash = $2
        AND window_date = (now() AT TIME ZONE 'UTC')::date`,
    [scope, subjectHash]
  );
  const row = rows[0];
  if (!row) return { daily: false, retryAfterSeconds: minIntervalSeconds };
  if (row.attempts >= perDay) {
    // Until the UTC day rolls over, which is when the counter's bucket changes.
    const now = new Date();
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    );
    return { daily: true, retryAfterSeconds: Math.max(1, Math.ceil((midnightUtc - now.getTime()) / 1000)) };
  }
  return {
    daily: false,
    retryAfterSeconds: Math.max(1, minIntervalSeconds - Math.max(0, row.since_last)),
  };
}

/**
 * The one call the signup route makes before it writes anything or sends anything.
 *
 * ═══ ORDER: NUMBER FIRST, THEN IP ═══
 * The per-number limit is the one that protects a person, so it is the one that gets to refuse
 * first and the one whose budget is never spent on a request the IP limit was going to refuse
 * anyway. The reverse order would let a noisy shared NAT consume a specific handset's allowance.
 *
 * ═══ NO SALT ⇒ NO THROTTLE, AND IT SAYS SO ═══
 * Both subjects are HMACs under SMS_PHONE_HASH_SALT. Without it there is no subject to count
 * against, and inventing one (an unsalted digest, a constant) would produce a table that looks
 * populated and either throttles nobody or throttles everybody together. So it degrades openly:
 * `degraded: true`, allowed, and the route raises it. That salt is already a hard requirement for
 * the CASL audit trail (lib/sms/phone-hash.ts), so this is a second reason it must be set, not a
 * new one.
 *
 * ═══ DRY RUN ⇒ NOTHING TO THROTTLE ═══
 * Same `dryRun` semantics as the rest of this module. With sending disabled no text can reach
 * anyone and no consent row is written, so there is no abuse to prevent — and the throttle must
 * not be the one thing in the signup path that needs a database in an environment that has none.
 *
 * NEVER THROWS. A throttle that can 500 a signup is worse than the abuse it prevents.
 */
export async function checkAndRecordSignupAttempt(
  input: SignupThrottleInput,
  options: SignupThrottleOptions = {}
): Promise<SignupThrottleResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  if (dryRun) return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: false };

  const limits = options.limits ?? SIGNUP_THROTTLE_LIMITS;
  const run = options.query ?? query;

  const phoneSubject = phoneHash(input.phoneNumber);
  if (!phoneSubject) {
    return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
  }
  const ipSubject = signupIpHash(input.ipAddress);

  try {
    const phone = await countAttempt(
      run, 'phone', phoneSubject, limits.phonePerDay, limits.phoneMinIntervalSeconds
    );
    if (!phone.allowed) {
      const why = await explainRefusal(
        run, 'phone', phoneSubject, limits.phonePerDay, limits.phoneMinIntervalSeconds
      );
      return {
        allowed: false,
        reason: why.daily ? 'phone_daily' : 'phone_interval',
        retryAfterSeconds: why.retryAfterSeconds,
        degraded: false,
      };
    }

    // No IP to count against — the per-number limit above already ran, and it is the half that
    // protects a handset. Degrading to it is a real reduction in cover, not a no-op, so it is
    // reported: a deployment where every request arrives without a forwarded-for header is a
    // misconfiguration worth seeing rather than a quietly weaker throttle.
    if (!ipSubject) {
      return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
    }

    const ip = await countAttempt(
      run, 'ip', ipSubject, limits.ipPerDay, limits.ipMinIntervalSeconds
    );
    if (!ip.allowed) {
      const why = await explainRefusal(
        run, 'ip', ipSubject, limits.ipPerDay, limits.ipMinIntervalSeconds
      );
      return {
        allowed: false,
        reason: why.daily ? 'ip_daily' : 'ip_interval',
        retryAfterSeconds: why.retryAfterSeconds,
        degraded: false,
      };
    }

    return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: false };
  } catch {
    // FAIL OPEN, LOUDLY. See `degraded` on SignupThrottleResult for why this direction and not
    // the other. Nothing from the error is carried out of here: it would contain the number.
    return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
  }
}

export type ConfirmationSendOutcome = 'sent' | 'dry_run' | 'error';

export interface ConfirmationSendResult {
  outcome: ConfirmationSendOutcome;
  twilioSid: string | null;
  /** Segment count of the message that was built, for cost visibility. Populated on a dry run. */
  segments: number;
  /**
   * Twilio's numeric code when it gave one.
   *
   * Surfaced rather than folded into `error` because ONE of these codes means something the
   * generic failure path does not: 21610 is the carrier telling us this number has opted out.
   * See the note on `sendConfirmationRequest`.
   */
  errorCode: number | null;
  /** Never contains the number or the body. */
  error?: string;
}

export interface ConfirmationSendOptions extends SignupWriteOptions {
  /**
   * The id `createPendingSubscriber` just returned, for the audit row.
   *
   * NULLABLE, and legitimately so for a dry run, which writes no row and needs no id. Now that
   * the store is real, a `created`/`reactivated` write always carries one, and a failed write
   * never reaches here — the route 503s first.
   */
  subscriberId?: string | null;
  /** Injected for tests; defaults to the shared Twilio seam in weekly-send-io. */
  dispatch?: typeof dispatchSms;
  /** Injected for tests; defaults to the shared send-log writer in weekly-send-io. */
  record?: typeof recordSmsSend;
}

/**
 * Send the one confirmation text (PRD §1.4, §2.1, §2.6).
 *
 * ── THE MESSAGE, AND WHY IT WAS BUILT BEFORE THE DISPATCH ───────────────────────────────
 * THE MESSAGE IS REAL. `renderConfirmRequestMessage` produces §2.6's approved copy, goes through
 * the same GSM-7 wall as every other template (tests/sms/weekly_send.test.ts), and is built on
 * EVERY path including a dry run — so a verification run in an unconfigured environment renders
 * and costs the exact message a live run would send, and dispatches none of it. Until now this
 * body existed only as the comment below, which is precisely how a message escapes the encoding
 * guard: round 11 found a real bug in that guard by implementing a template against it.
 *
 * `dispatchSms` and `recordSmsSend` are shared with the weekly path (lib/sms/twilio-client.ts and
 * lib/sms/send-log.ts) rather than reimplemented here: one Twilio call site, one `sms_send_log`
 * writer. Both are real; whether anything is actually dispatched is governed by
 * SMS_SENDING_ENABLED, which is deliberately unset.
 *
 * ── THE ONE DETAIL THAT IS NOT BOILERPLATE ──────────────────────────────────────────────
 * JOIN, NOT YES. Twilio's Advanced Opt-Out treats YES (with START and UNSTOP) as a carrier-level
 * resubscribe keyword and can intercept the reply before our webhook ever sees it, which would
 * leave a subscriber who did everything right sitting at `pending` forever. See
 * lib/sms/keywords.ts, and `renderConfirmRequestMessage` for the copy itself.
 *
 * EXACTLY ONE MESSAGE. This is a wrong-number and express-consent check, not a drip: a second
 * "did you get our text?" text to a number that has not consented is itself the CASL problem the
 * confirmation exists to avoid. PRD §2.1 puts the reminder in V1, gated on real drop-off data.
 *
 * FAILURE IS NOT A FAILED SIGNUP. The row is already written and already pending; a Twilio error
 * here means the confirmation did not arrive, which the parent can resolve by resubmitting the
 * form or texting START. The route must not tell them the signup failed — see its own comment.
 *
 * ── A 21610 HERE MEANS SOMETHING THE ROUTE CANNOT FIX, AND SHOULD BE READ ───────────────
 * On the weekly path, Twilio error 21610 means an active subscriber opted out at the carrier and
 * we mark them stopped. On THIS path it means something else: the number signing up has ALREADY
 * blocked our sender, so the confirmation text is undeliverable and always will be until they
 * text START or UNSTOP to us themselves — which nothing on the form tells them to do, and which
 * we cannot do on their behalf. The form will say "check your phone" and no message will ever
 * arrive. This function reports the code (`errorCode`) rather than flattening it into a generic
 * failure so that case is at least visible; the product answer to it is flagged, not invented.
 *
 * ── AND SO THIS PATH DELIBERATELY DOES **NOT** CALL `markStoppedViaCarrier` ──────────────
 * Stated outright rather than left to be inferred from the paragraph above. The weekly path and
 * the JOIN welcome both DO call it on a 21610 (round 17 fixed `welcome.ts` for exactly that), so
 * the omission here looks like the same bug and is not one:
 *
 *   • THE ROW IS `pending`, NOT `active`. It was created moments ago by this signup and has never
 *     been confirmed. `loadActiveSubscribers` selects `WHERE status = 'active'`, so nothing will
 *     text this number again on its own — the repeated-rejection failure that makes the weekly
 *     path's write necessary cannot happen here.
 *   • MARKING THEM STOPPED WOULD START THE PURGE CLOCK ON A SIGNUP THEY JUST MADE. `status =
 *     'stopped'` stamps `stopped_at`, and migration 0034's 30-day purge keys off it. So we would
 *     begin deleting the postal code and children's ages a parent gave us thirty seconds earlier,
 *     with express consent, because of a CARRIER state they can clear themselves by texting START.
 *   • IT WOULD ALSO OVERWRITE A FRESH CASL CONSENT RECORD with a status that says the opposite of
 *     what just happened. They did not opt out. They opted IN, to a number that was already
 *     blocked.
 *
 * The honest end state is a `pending` row that never confirms and is purged after 90 days — which
 * is exactly what the schema already does for any signup that never replies JOIN.
 *
 * NEVER THROWS, and nothing it returns carries the number or the body.
 */
export async function sendConfirmationRequest(
  signup: SmsSignup,
  options: ConfirmationSendOptions = {}
): Promise<ConfirmationSendResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  const send = options.dispatch ?? dispatchSms;
  const log = options.record ?? recordSmsSend;

  // The area is resolved through `areaLabelForPostal` — the SAME resolver the welcome text uses
  // (lib/sms/welcome.ts) and the same FSA table the weekly send geocodes against. One postal code
  // must not be able to produce two different area names in two consecutive messages, which is
  // exactly what a second lookup here would eventually do. Note that `signup.regionId` already
  // holds the resolved municipality; going back through the postal code keeps this call identical
  // to the welcome text's, and tests/sms/confirm_request.test.ts pins that the two agree.
  const message = renderConfirmRequestMessage(areaLabelForPostal(signup.postalCode));

  let dispatched: DispatchResult;
  try {
    dispatched = await send(signup.phoneNumber, message, { dryRun });
  } catch (err) {
    return {
      outcome: 'error',
      twilioSid: null,
      segments: message.segments,
      errorCode: null,
      error: `dispatch threw: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }

  // A dry run stops here — nothing dispatched, nothing recorded. `sms_send_log` is a record of
  // messages that were SENT (migration 0035 has no `dry_run` column, by design), so a staging
  // run must not leave a CASL audit row claiming a parent was texted.
  if (dispatched.outcome === 'dry_run') {
    return { outcome: 'dry_run', twilioSid: null, segments: message.segments, errorCode: null };
  }

  const failed = dispatched.outcome !== 'sent';

  // The audit row for the FIRST message, which is the one a CASL complaint is most likely to be
  // about: it went to a number that had not yet confirmed. Written with the outcome that actually
  // happened, including a failed attempt — "we tried and Twilio refused" is a materially different
  // answer from "no record", and only one of them is true.
  if (options.subscriberId) {
    try {
      await log({
        subscriberId: options.subscriberId,
        phoneNumber: signup.phoneNumber,
        sendType: 'confirm_request',
        outcome:
          dispatched.outcome === 'stopped_via_carrier'
            ? 'stopped_via_carrier'
            : failed
              ? 'failed'
              : 'sent',
        // Weekly sends only — migration 0035's CHECK rejects a snapshot on any other send_type.
        picksSnapshot: null,
        twilioSid: dispatched.twilioSid,
        // The wording THEY agreed to, carried on the validated signup. Copied, never joined.
        consentTextVersion: signup.consentTextVersion,
      });
    } catch {
      // The message may already have gone. Losing the audit row is bad; turning it into a failed
      // signup, after the consent row was written and the text was sent, would be worse.
    }
  }

  if (failed) {
    return {
      outcome: 'error',
      twilioSid: dispatched.twilioSid,
      segments: message.segments,
      errorCode: dispatched.errorCode,
      error: dispatched.error ?? `dispatch outcome: ${dispatched.outcome}`,
    };
  }
  return {
    outcome: 'sent',
    twilioSid: dispatched.twilioSid,
    segments: message.segments,
    errorCode: null,
  };
}
