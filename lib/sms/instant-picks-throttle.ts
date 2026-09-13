// lib/sms/instant-picks-throttle.ts — the rate limit on the Instant Picks button.
//
// ═══ WHAT THIS PROTECTS, STATED ACCURATELY ═══
// NOT a paid API. A press runs an in-memory scan over the catalogue `getServerSearchEngine()`
// already keeps warm, plus a postal lookup from a static table — no Mapbox call, no AI call, no
// per-press vendor cost. What is actually being protected is server CPU and basic button-mashing.
//
// That lowers the stakes but does not remove them: the preferences link is in the URL, so anyone
// holding the link can press the button.
//
// ⚠ AND THEREFORE — SAID PLAINLY SO NOBODY MISTAKES IT LATER — THIS IS A COST CONTROL, NOT A
// SECURITY CONTROL. A per-subscriber limit does not stop someone who has the link; it stops a
// script from spinning. That the link IS the authorization is already true of the whole page (it
// is how unsubscribe-without-logging-in works), so this changes nothing about that posture — but
// nobody should read this file and conclude the limit is protecting data.
//
// ═══ ONE PER MINUTE, TWENTY PER DAY ═══
// A minute is invisible to a real parent — nobody meaningfully re-rolls a list faster than that —
// and it stops a script cold. The daily cap is the backstop for the caller who is patient.
//
// ═══ NO IP HALF, DELIBERATELY ═══
// The signup throttle counts IP as well as phone because its threat is one caller spraying MANY
// strangers' numbers — the victim is someone other than the attacker, so a per-number limit alone
// leaves a hole. There is no equivalent here: a press costs one subscriber's own CPU and reaches
// nobody else, so the per-subscriber counter IS the whole limit. Adding an IP scope would throttle
// a school or a shared NAT out of a harmless button for no threat it closes.

import { createHmac } from 'node:crypto';
import { query } from '@/lib/db/client';
import { phoneHashSalt } from './config';
import { countAttempt, explainRefusal } from './throttle';

export interface InstantPicksThrottleLimits {
  /** Seconds that must pass between two ALLOWED presses by the same subscriber. */
  readonly minIntervalSeconds: number;
  /** Allowed presses per subscriber per UTC day. */
  readonly perDay: number;
}

/** The production limits. See this file's header for why these two numbers. */
export const INSTANT_PICKS_THROTTLE_LIMITS: InstantPicksThrottleLimits = {
  minIntervalSeconds: 60,
  perDay: 20,
};

/** Which limit refused, for logs and metrics. NEVER returned to the caller — see the route. */
export type InstantPicksThrottleReason = 'interval' | 'daily';

export interface InstantPicksThrottleResult {
  allowed: boolean;
  /** Null when allowed. */
  reason: InstantPicksThrottleReason | null;
  /** Whole seconds until the refused limit next admits a press. At least 1 when refused, else 0. */
  retryAfterSeconds: number;
  /**
   * The check could not run, and the press was LET THROUGH.
   *
   * ═══ FAIL OPEN, AND BE NOISY ABOUT IT — COPIED FROM THE SIGNUP THROTTLE ON PURPOSE ═══
   * A throttle that fails CLOSED converts "the counter table is unreachable" into "the button is
   * broken for everyone", and the ways it becomes unreachable are a database outage — in which
   * case the token lookup one line earlier has already failed the request anyway, so failing
   * closed here buys nothing — or migration 0046 not being applied yet, which is a deploy-ordering
   * state rather than an attack. Either way, refusing real parents is the worse outcome for a
   * limiter whose whole job is stopping a script from spinning.
   * ⚠ SO THE ROUTE CAPTURES THIS TO SENTRY. "The instant-picks limit has been inert since Tuesday"
   * is not a thing to find out from a bill.
   */
  degraded: boolean;
}

export interface InstantPicksThrottleOptions {
  limits?: InstantPicksThrottleLimits;
  /** Injected for tests; defaults to the shared pool in lib/db/client.ts. */
  query?: typeof query;
}

/**
 * HMAC the throttle's subject.
 *
 * ═══ WHY THE SUBSCRIBER ID IS HASHED RATHER THAN STORED RAW ═══
 * It is an internal uuid, not personal data, so this is not a privacy fix in the sense the 'phone'
 * and 'ip' scopes are. It is about KEEPING THE COUNTER JOIN-FREE. Migration 0045's argument for
 * why this table is not `sms_send_log` is "different lifetime, different purpose" — the counter is
 * swept, the consent row is not. Writing a live `sms_consent.id` into it would put a working
 * foreign key between the two and quietly make the throttle table a directory of subscribers.
 * A hash counts exactly as well and joins to nothing.
 *
 * SHARES `SMS_PHONE_HASH_SALT`, DOMAIN-SEPARATED — the same argument lib/sms/signup-store.ts makes
 * for `sms-signup-ip:`. An eighth secret would mean this feature could not ship until somebody
 * provisioned it, and the `sms-instant-picks:` prefix keeps the families from colliding under one
 * salt.
 *
 * Null when there is no salt, which means "cannot throttle" — the caller degrades openly rather
 * than inventing a subject, because an unsalted or constant subject produces a table that either
 * throttles nobody or throttles everybody together.
 */
function instantPicksSubjectHash(subscriberId: string): string | null {
  const salt = phoneHashSalt();
  if (!salt) return null;
  return createHmac('sha256', salt).update(`sms-instant-picks:${subscriberId}`).digest('hex');
}

/**
 * Count one press against one subscriber, and say whether it is allowed — ATOMICALLY.
 *
 * The race safety is `countAttempt`'s, not this function's: see lib/sms/throttle.ts for why the
 * decision and the write have to be one statement.
 *
 * NEVER THROWS. A throttle that can 500 the button is worse than the button being pressed twice.
 */
export async function checkAndRecordInstantPicks(
  subscriberId: string,
  options: InstantPicksThrottleOptions = {}
): Promise<InstantPicksThrottleResult> {
  const limits = options.limits ?? INSTANT_PICKS_THROTTLE_LIMITS;
  const run = options.query ?? query;

  const subject = instantPicksSubjectHash(subscriberId);
  if (!subject) {
    return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
  }

  try {
    const attempt = await countAttempt(
      run, 'instant_picks', subject, limits.perDay, limits.minIntervalSeconds
    );
    if (attempt.allowed) {
      return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: false };
    }
    const why = await explainRefusal(
      run, 'instant_picks', subject, limits.perDay, limits.minIntervalSeconds
    );
    return {
      allowed: false,
      reason: why.daily ? 'daily' : 'interval',
      retryAfterSeconds: why.retryAfterSeconds,
      degraded: false,
    };
  } catch {
    // FAIL OPEN, LOUDLY. See `degraded` above for why this direction and not the other. Nothing
    // from the error is carried out of here.
    return { allowed: true, reason: null, retryAfterSeconds: 0, degraded: true };
  }
}
