// lib/sms/instant-picks-send-throttle.ts — the rate limit on the TEXT an Instant Picks press sends.
//
// Instant Picks plan v2.0 §4.2 and §4.3, task 3. Migration 0048 admits its two scopes.
//
// ═══ WHY THIS IS A SECOND FILE AND NOT A SECOND SET OF NUMBERS IN THE FIRST ONE ═══
// lib/sms/instant-picks-throttle.ts limits the PAGE RENDER, and every sentence in its header is
// still true of that: not a paid API, reaches nobody but the presser, so a per-subscriber counter
// IS the whole limit and failing open is the kind thing to do. This file limits the SEND, and
// each of those three sentences is false of it. Two policies with opposite fail directions and
// different threat models do not belong behind one function with a parameter.
//
// ═══ 🔴 WHAT CHANGED THE THREAT MODEL — THE SINGLE MOST IMPORTANT NOTE IN THIS FILE ═══
// The preferences link IS the credential; it travels in the URL because that is how
// unsubscribe-without-logging-in works. On the page path, whoever holds a link can spend that
// subscriber's CPU and see their own screen. On the SEND path, whoever holds a link can make
// KIDS FUN PAY TO TEXT SOMEBODY ELSE'S HANDSET — repeatedly, from a toll-free number whose carrier
// reputation is the product, against a disclosed cadence of one message a week.
//
// That is not a cost control failing. It is a new capability: someone else's phone, someone else's
// bill. It is why the per-subscriber cap is 3/day rather than the page path's 20 (3/day worst case
// is ~$0.05/subscriber/day against ~$0.34 — plan §4.1 has the arithmetic), and it is why there is
// an IP half here at all.
//
// ═══ THE IP HALF, WHICH THE PAGE THROTTLE CORRECTLY DOES NOT HAVE ═══
// instant-picks-throttle.ts argues against an IP half and is right — for a page render, where the
// caller and the victim are the same person. Here they are not. The threat is one caller spraying
// MANY strangers' handsets, which is verbatim the threat 0045 built the 'ip' scope for on the
// signup path, so it gets the same answer rather than a new one.
//
// ═══ THE NUMBERS ARE `SIGNUP_THROTTLE_LIMITS`, DELIBERATELY, AND THAT IS CHECKED ═══
// 600s/3-per-day per subscriber, 30s/20-per-day per IP. They are not new numbers: they are what
// this repo already defends for the OTHER user action that causes a real text — the signup
// confirmation SMS. Reusing them means there is no new number to justify and the two send paths
// cannot drift apart.
//
// They are RESTATED here rather than imported from lib/sms/signup-store.ts, and
// tests/sms/instant_picks_send_throttle.test.ts asserts the two objects are equal so the copy
// cannot drift. That is the deliberate trade: importing the constant would drag signup-store's
// whole graph — the postal-FSA table, the token minter, the Twilio client, the send-log writer —
// into a module the Instant Picks route loads on every press, to read four integers. A test is a
// cheaper guarantee than a transitive import, and it is a STRONGER one than a comment.
//
// ═══ AND IT FAILS CLOSED — THE ONE DELIBERATE INVERSION FROM EVERY OTHER THROTTLE HERE ═══
// See `degraded` on InstantPicksSendThrottleResult. The short version: the page still renders the
// list, so refusing the text degrades one channel instead of the feature.

import { createHmac } from 'node:crypto';
import { query } from '@/lib/db/client';
import { phoneHashSalt } from './config';
import { countAttempt, explainRefusal } from './throttle';

export interface InstantPicksSendThrottleLimits {
  /** Seconds that must pass between two ALLOWED sends to the same subscriber. */
  readonly subscriberMinIntervalSeconds: number;
  /** Allowed sends per subscriber per UTC day. */
  readonly subscriberPerDay: number;
  /** Seconds that must pass between two ALLOWED sends from the same source IP. */
  readonly ipMinIntervalSeconds: number;
  /** Allowed sends per source IP per UTC day. */
  readonly ipPerDay: number;
}

/**
 * The production limits — `SIGNUP_THROTTLE_LIMITS`' four numbers, for this file's header's reason.
 *
 * PER SUBSCRIBER: one every ten minutes, three a day. Three is not a timid ceiling, and the plan
 * gives three independent reasons it is the right one (§4.2). The one that settles it: THE
 * SELECTOR'S WINDOW IS THE WEEKEND and is pinned there on purpose, so a fourth press in one day
 * returns a near-identical list. The cap is not rationing anything a parent can actually use.
 *
 * PER IP: thirty seconds apart, twenty a day. The daily cap is the one that bites; thirty seconds
 * only stops a script burning the whole day's budget in one burst. IF A REAL SHARED-NAT COMPLAINT
 * EVER ARRIVES, THIS IS THE NUMBER TO RAISE — not the per-subscriber limits, which are what
 * protect people.
 */
export const INSTANT_PICKS_SEND_THROTTLE_LIMITS: InstantPicksSendThrottleLimits = {
  subscriberMinIntervalSeconds: 600,
  subscriberPerDay: 3,
  ipMinIntervalSeconds: 30,
  ipPerDay: 20,
};

/** Which limit refused, for logs and metrics. NEVER returned to the caller — see the route. */
export type InstantPicksSendThrottleReason =
  | 'subscriber_interval'
  | 'subscriber_daily'
  | 'ip_interval'
  | 'ip_daily';

export interface InstantPicksSendThrottleResult {
  allowed: boolean;
  /** Null when allowed. */
  reason: InstantPicksSendThrottleReason | null;
  /** Whole seconds until the refused limit next admits a send. At least 1 when refused, else 0. */
  retryAfterSeconds: number;
  /**
   * The check could not run — and unlike every other throttle in this repo, THE SEND WAS REFUSED.
   *
   * ═══ 🔴 FAIL CLOSED. THIS IS THE ONE PLACE THAT INVERSION IS CORRECT, AND HERE IS WHY ═══
   * The signup throttle and the Instant Picks PAGE throttle both fail open, both give a good
   * reason, and both reasons are about the same trade: a counter that is unreachable must not
   * convert an infrastructure blip into "nobody can use the product". Weigh that same trade with
   * MONEY and A THIRD PARTY'S HANDSET on the scale and it flips. A page render that fails open
   * costs CPU. A SEND that fails open costs money and texts somebody, unmetered, until a human
   * notices — from a toll-free number that is in carrier verification.
   *
   * ═══ AND THE FALLBACK IS GENUINELY GRACEFUL, WHICH IS WHAT MAKES THIS SAFE RATHER THAN HARSH ═══
   * THE PAGE STILL RENDERS THE LIST. A parent whose text was refused because the counter was
   * unreachable still gets exactly what they pressed the button for, on the screen in front of
   * them, plus one honest sentence. Failing closed here degrades ONE CHANNEL of a two-channel
   * answer; failing open risks an unbounded bill. That asymmetry is the whole argument, and it is
   * why this direction does not generalise back to the other two throttles.
   *
   * ⚠ STILL NOISY. The caller captures this to Sentry. "The send limiter has been refusing
   * everything since Tuesday" and "the send limiter has been allowing everything since Tuesday"
   * are both things to find out from an alert rather than from a bill or a complaint.
   *
   * ⚠ `degraded: true` DOES NOT ALWAYS MEAN REFUSED — see `ipSubject` below for the one
   * partial-degradation case that is reported and allowed, and why.
   */
  degraded: boolean;
}

export interface InstantPicksSendThrottleInput {
  /** The `sms_consent.id` the text would go to. Hashed before it goes near the database. */
  subscriberId: string;
  /** The caller's IP, or null when the request carried no usable one. Hashed the same way. */
  ipAddress: string | null;
}

export interface InstantPicksSendThrottleOptions {
  limits?: InstantPicksSendThrottleLimits;
  /** Injected for tests; defaults to the shared pool in lib/db/client.ts. */
  query?: typeof query;
}

/**
 * HMAC a throttle subject.
 *
 * SHARES `SMS_PHONE_HASH_SALT`, DOMAIN-SEPARATED — the argument lib/sms/signup-store.ts and
 * lib/sms/instant-picks-throttle.ts both make, unchanged: an eighth secret would mean this feature
 * could not ship until somebody provisioned it, and a throttle that is inert because a variable is
 * missing is the failure it exists to prevent. The two prefixes below are distinct from
 * `sms-instant-picks:` (the page counter) as well as from each other, so a subscriber's page
 * presses and their sends can never be counted against the same row.
 *
 * Null when there is no salt, which means "cannot throttle" — and on this path that is a refusal.
 */
function sendSubjectHash(domain: string, value: string): string | null {
  const salt = phoneHashSalt();
  if (!salt) return null;
  return createHmac('sha256', salt).update(`${domain}${value}`).digest('hex');
}

/**
 * Count one send against one subscriber and one IP, and say whether it is allowed — ATOMICALLY.
 *
 * The race safety is `countAttempt`'s, not this function's: see lib/sms/throttle.ts for why the
 * decision and the write have to be one statement.
 *
 * ═══ ORDER: SUBSCRIBER FIRST, THEN IP ═══
 * The per-subscriber limit is the one that protects a specific handset, so it refuses first and
 * its budget is never spent on a send the IP limit was going to refuse anyway. The reverse order
 * would let a noisy shared NAT consume one person's allowance. Same ordering, same reason, as
 * `checkAndRecordSignupAttempt`.
 *
 * NEVER THROWS. A throttle that can 500 the preferences page is worse than a text not going out —
 * and the caller has a list to render either way.
 */
export async function checkAndRecordInstantPicksSend(
  input: InstantPicksSendThrottleInput,
  options: InstantPicksSendThrottleOptions = {}
): Promise<InstantPicksSendThrottleResult> {
  const limits = options.limits ?? INSTANT_PICKS_SEND_THROTTLE_LIMITS;
  const run = options.query ?? query;

  const subscriberSubject = sendSubjectHash('sms-instant-picks-send:', input.subscriberId);
  if (!subscriberSubject) {
    // NO SALT ⇒ NOTHING WAS COUNTED AT ALL ⇒ REFUSE. Inventing a subject (an unsalted digest, a
    // constant) would produce a counter that either throttles nobody or throttles everybody
    // together, and the first of those is indistinguishable from no limit.
    return { allowed: false, reason: null, retryAfterSeconds: 0, degraded: true };
  }
  const ipSubject = input.ipAddress
    ? sendSubjectHash('sms-instant-picks-send-ip:', input.ipAddress)
    : null;

  try {
    const subscriber = await countAttempt(
      run,
      'instant_picks_sms',
      subscriberSubject,
      limits.subscriberPerDay,
      limits.subscriberMinIntervalSeconds
    );
    if (!subscriber.allowed) {
      const why = await explainRefusal(
        run,
        'instant_picks_sms',
        subscriberSubject,
        limits.subscriberPerDay,
        limits.subscriberMinIntervalSeconds
      );
      return {
        allowed: false,
        reason: why.daily ? 'subscriber_daily' : 'subscriber_interval',
        retryAfterSeconds: why.retryAfterSeconds,
        degraded: false,
      };
    }

    if (!ipSubject) {
      /*
       * ═══ THE ONE CASE THAT IS DEGRADED AND STILL ALLOWED, STATED PLAINLY BECAUSE IT LOOKS LIKE
       *     A HOLE IN "FAIL CLOSED" ═══
       * There is no IP to count — either the request carried no usable forwarded-for header, or
       * (already handled above) there is no salt. This is NOT the "cannot reach the counter" case
       * the fail-closed rule is about: the counter was reached, and THE HALF THAT PROTECTS A
       * SPECIFIC HANDSET ALREADY RAN AND PASSED. Every victim is still bounded to three texts a
       * day by the check above; what is lost is the bound on how many DIFFERENT handsets one
       * caller can reach.
       *
       * Refusing here instead would mean: any deployment that stops forwarding a client IP silently
       * stops sending altogether — an infrastructure change turning off a feature with no error.
       * And it would be INCONSISTENT WITH THE OTHER REAL-SEND PATH: `checkAndRecordSignupAttempt`
       * meets exactly this state, on exactly this threat model, and degrades-but-allows.
       * Diverging from it here would mean two answers to one question.
       *
       * So: allowed, and REPORTED. A deployment where every request arrives without a
       * forwarded-for header is a misconfiguration worth seeing, not a quietly weaker throttle.
       */
      return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
    }

    const ip = await countAttempt(
      run, 'instant_picks_sms_ip', ipSubject, limits.ipPerDay, limits.ipMinIntervalSeconds
    );
    if (!ip.allowed) {
      const why = await explainRefusal(
        run, 'instant_picks_sms_ip', ipSubject, limits.ipPerDay, limits.ipMinIntervalSeconds
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
    // FAIL CLOSED, LOUDLY. See `degraded` above for why this direction and not the other. Nothing
    // from the error is carried out of here.
    return { allowed: false, reason: null, retryAfterSeconds: 0, degraded: true };
  }
}
