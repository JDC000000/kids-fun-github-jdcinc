// lib/sms/instant-picks-send.ts — the text an Instant Picks press sends (plan v2.0 task 5).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🔴 READ THIS BEFORE CHANGING ANYTHING IN THIS FILE: IT IS DELIBERATELY INERT TODAY
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// This module is complete, tested, and CANNOT SEND ANYTHING in any environment as this commit
// stands. That is the intended state, not an unfinished one, and it is Jon's ruling (PRD v3.22,
// plan v2.0 §6 option B: "build now, hold the switch"). Three independent gates below must ALL
// pass, and gate 2 is currently impossible to satisfy anywhere:
//
//   1. `instantPicksSmsSendEnabled()`  — INSTANT_PICKS_SMS_SEND_ENABLED, default false. The
//      Operator's held switch. ⚠ NOT `SMS_SENDING_ENABLED`, which is ALREADY TRUE IN PRODUCTION
//      because it gates the Friday weekly send — reusing it would have made this live on merge.
//   2. `consent_text_version >= v8`    — the STRUCTURAL consent gate (plan §7). CONSENT_TEXT_VERSION
//      is still '2026-09-03.v7' and the frequency disclosure still reads "1 message per week, plus
//      a one-time confirmation message", so NO SUBSCRIBER ROW IN ANY ENVIRONMENT IS ON v8 AND THIS
//      GATE REFUSES EVERY SEND. Bumping it is task 1, which is HELD pending the Toll-Free
//      Verification decision — it is not this module's to do, and doing it here would ship the
//      compliance change through the back door.
//   3. the send throttle              — fail-closed, both halves (lib/sms/instant-picks-send-throttle.ts).
//
// ⚠ SO: THIS IS NOT DEAD CODE TO TIDY UP. Gate 2 refusing everything is the safety mechanism, and
// "this branch never executes, delete it" is exactly the wrong conclusion. When task 1 lands —
// new disclosure copy, CONSENT_TEXT_VERSION → v8, v7 added to the history list — new and
// resubmitting subscribers become v8 and this path starts working for them, with no edit here.
//
// ═══ WHY THE CONSENT GATE IS STRUCTURAL RATHER THAN REASONED ═══
// CASL treats a message sent IN RESPONSE TO A REQUEST from the recipient differently from an
// unsolicited one, and a subscriber pressing their own button on their own preferences page is
// about as clean a request as exists — which would mean v7 subscribers could receive this. That is
// a legal read, and this feature does not ship on one. Gating on the version costs nothing today
// (KIDS FUN has no live subscribers) and answers the question with a mechanism instead of an
// opinion. If Jon later obtains a legal read that says v7 is fine, THAT is when this changes, and
// it changes here, once.
//
// ═══ WHAT THIS WRITES ═══
// One `sms_send_log` row per dispatched text, `send_type = 'instant_picks'`, `picks_snapshot`
// NULL. Both of those are load-bearing and migration 0049's header explains each:
//   • the new send_type is NOT in `findLastWeek`'s IN-list, so an on-demand row never surfaces in
//     the "Last Friday" panel the button sits inside;
//   • `picks_snapshot` stays NULL because `sms_send_log_picks_only_weekly` enforces it AND the
//     weekly novelty filter treats "send_type = weekly" and "picks_snapshot IS NOT NULL" as the
//     same condition — an on-demand row carrying a snapshot would suppress those activities from
//     Friday's real text.
// It writes NOTHING ELSE. In particular it does not persist the list that was texted: the link
// reopens the preferences page and the parent presses the button again (Jon's D2 ruling, L1).
//
// ═══ IT DOES ITS OWN READ, LIKE lib/sms/welcome.ts, AND FOR THE SAME REASON ═══
// The selector's input type (`InstantPicksSubscriber`) carries a postal code, birth years and
// interests — and deliberately no phone number. Widening it to carry one so the route could pass
// it here would put a phone number into the type a pure selection function decides against, which
// is the property lib/sms/instant-picks-store.ts was split out to protect. So the decision layer
// stays PII-free and this step reads what it needs, keyed on the id the route already resolved.

import { query } from '@/lib/db/client';
import {
  instantPicksSmsSendEnabled,
  preferencesUrl as buildPreferencesUrl,
  smsSendingEnabled,
} from './config';
import { consentVersionSerial } from './consent-copy';
import { checkAndRecordInstantPicksSend } from './instant-picks-send-throttle';
import { renderInstantPicksMessage, type RenderedMessage } from './message';
import { recordSmsSend } from './send-log';
import { dispatchSms, type DispatchResult } from './twilio-client';

/**
 * `markStoppedViaCarrier`, imported LAZILY on the one branch that needs it.
 *
 * ═══ WHY NOT A TOP-LEVEL IMPORT, WHEN lib/sms/welcome.ts HAS ONE ═══
 * It lives in lib/sms/weekly-send-io.ts, which top-level imports the SearchEngine, the in-memory
 * and postgres listing repositories, the alias resolver and the region hierarchy. Round 12 flagged
 * that graph leaking into unrelated callers and round 16 acted on it, moving `dispatchSms` and
 * `recordSmsSend` out into their own modules for exactly this reason.
 *
 * This module is loaded by app/api/sms/instant-picks/route.ts on EVERY press, and the press that
 * matters is the page render — the send is the secondary half. Paying that graph's cold start on
 * the primary path, to reach one UPDATE statement on a branch that fires when a carrier-suppressed
 * number happens to hold a live preferences link, is the wrong trade. `welcome.ts` makes the other
 * choice legitimately: it is loaded by the inbound webhook, which is not a page render.
 *
 * A dynamic import inside the branch keeps it out of the static graph without moving anything the
 * weekly send owns — which is deliberately out of this task's scope.
 */
async function defaultMarkStoppedViaCarrier(subscriberId: string): Promise<void> {
  const { markStoppedViaCarrier } = await import('./weekly-send-io');
  return markStoppedViaCarrier(subscriberId);
}

/**
 * The consent-wording generation a subscriber must have agreed to before we may text them one of
 * these.
 *
 * ═══ A SERIAL, NOT A STRING, AND NOT `CONSENT_TEXT_VERSION` ═══
 * Comparing version strings does not order them (`'…v7' < '…v10'` is false lexically), and the date
 * prefix is re-stamped on resubmit so it says when a parent last touched the form rather than when
 * the wording was issued. `consentVersionSerial` exists for exactly this; see its doc.
 *
 * ⚠ 8 IS THE VERSION THAT DOES NOT EXIST YET. The live constant is v7. This number is written
 * ahead of the copy change on purpose — it is what makes this module inert without needing a
 * second flag, and it means task 1 enables the feature by doing its own job (bumping the version)
 * rather than by remembering to come back here.
 */
export const INSTANT_PICKS_MIN_CONSENT_SERIAL = 8;

/**
 * An error's message with anything phone-number-shaped removed.
 *
 * ═══ WHY THIS EXISTS AT ALL — IT IS NOT BELT-AND-BRACES ═══
 * `InstantPicksSendResult.error` is documented as never containing the number, and interpolating a
 * caught `err.message` breaks that promise for free. TWILIO'S OWN ERROR MESSAGES CONTAIN THE
 * RECIPIENT'S NUMBER — error 21211 is literally "The 'To' number +1604... is not a valid phone
 * number" — and lib/sms/twilio-client.ts exists partly to stop that reaching a log. It scrubs on
 * the paths it controls; this covers the path it does not, which is `dispatchSms` itself throwing
 * (it promises not to, and a promise is not a mechanism).
 *
 * A Postgres error can carry values too: a `check_violation` detail includes the offending row.
 * So this runs over every error this module reports, not only the Twilio one.
 *
 * ═══ WHAT IT MATCHES, AND WHY IT IS SHAPE-BASED RATHER THAN VALUE-BASED ═══
 * Any run of 7 or more digits, tolerating the separators a formatted number carries. Redacting
 * only THIS subscriber's exact string would miss a differently formatted rendering of the same
 * number — `+16045550123`, `(604) 555-0123` and `6045550123` are one number and three strings.
 * The cost is that a long numeric id in an error is also redacted, which is the right direction to
 * be wrong in: an unreadable diagnostic is recoverable, a leaked number is not.
 */
function scrubDigits(message: string): string {
  return message.replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted]');
}

/** An error's message, scrubbed — or a stable fallback when there is nothing usable. */
function safeDetail(err: unknown): string {
  const raw = (err as Error)?.message;
  return typeof raw === 'string' && raw.length > 0 ? scrubDigits(raw) : 'unknown error';
}

export type InstantPicksSendStatus =
  /** Dispatched, and an `sms_send_log` row written. */
  | 'sent'
  /** The send throttle refused, or could not run and therefore refused. The list still renders. */
  | 'throttled'
  /** Rendered and NOT dispatched, because `SMS_SENDING_ENABLED` is false. Nothing written. */
  | 'disabled'
  /** Tried and did not go: Twilio failed, or the read failed. The list still renders. */
  | 'failed'
  /**
   * NO SEND WAS ATTEMPTED, and nothing about it should be said to the subscriber.
   *
   * ═══ THIS IS THE STATE EVERY DEPLOYMENT IS IN TODAY, AND IT MUST STAY SILENT ═══
   * The flag is off, or this subscriber's consent predates v8, or they have no phone number left
   * after the 30-day purge. None of those is a failure a parent can act on, and — this is the part
   * that matters — the page they are looking at still says "1 message per week, plus a one-time
   * confirmation message". Rendering "we couldn't text you" would tell them about a text that was
   * never offered, on a page whose own legal block says no such text exists.
   *
   * So the UI renders NOTHING for this status and the page behaves exactly as it did before this
   * feature was built. That equivalence is asserted in tests/sms/instant_picks_route.test.ts.
   */
  | 'not_eligible';

export interface InstantPicksSendResult {
  status: InstantPicksSendStatus;
  /** Segment count of the message that was built, for cost visibility. 0 when nothing was built. */
  segments: number;
  /**
   * The send path could not do its job and said so — a refusal that was NOT a real limit being
   * hit, or a dispatch that failed. The caller raises this to Sentry.
   *
   * SEPARATE FROM `status` because 'throttled' is ambiguous on its own: a subscriber who pressed
   * four times today and a counter table that is unreachable produce the same status and require
   * completely different responses from an operator. One is the system working.
   */
  degraded: boolean;
  /** Never contains the number or the body. */
  error?: string;
}

/** The `sms_consent` columns a send needs — precisely the ones the selector's type refuses. */
export interface InstantPicksSendSubscriber {
  id: string;
  /** E.164. The only field here that is a phone number; never returned or logged. */
  phoneNumber: string;
  preferencesToken: string;
  /** Copied verbatim onto the audit row, and the thing the consent gate reads. */
  consentTextVersion: string;
}

export type InstantPicksSendSubscriberLookup = (
  subscriberId: string
) => Promise<InstantPicksSendSubscriber | null>;

/**
 * Load what the text needs, keyed on the id the route already resolved from the token.
 *
 * NO `status` CLAUSE, and that is not an oversight: `findInstantPicksSubscriber` has already
 * refused `stopped` and purged rows one step earlier in the same request, and re-asserting it here
 * would be a second, drifting copy of a rule that is enforced where it belongs.
 *
 * NO PHONE NUMBER MEANS NO SEND. Migration 0034's 30-day purge NULLs the personal columns in place
 * rather than deleting the row, so a purged subscriber still HAS a row and `dispatchSms` would be
 * handed `null` as a recipient. The type says `phoneNumber: string`; this is the line that keeps
 * that true.
 *
 * NO TOKEN MEANS NO SEND EITHER, and unlike the welcome text this one cannot degrade around it.
 * `renderWelcomeMessage` still has a sentence without its link; this message IS the link, and a
 * commercial text with no working unsubscribe path must not be sent (PRD §1.4, and
 * `preferencesUrl()`'s own standing rule).
 */
export const loadInstantPicksSendSubscriber: InstantPicksSendSubscriberLookup = async (
  subscriberId
) => {
  const rows = await query<{
    id: string;
    phone_number: string | null;
    preferences_token: string | null;
    consent_text_version: string;
  }>(
    `SELECT id, phone_number, preferences_token, consent_text_version
       FROM sms_consent
      WHERE id = $1`,
    [subscriberId]
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.phone_number) return null;
  if (!row.preferences_token) return null;

  return {
    id: row.id,
    phoneNumber: row.phone_number,
    preferencesToken: row.preferences_token,
    consentTextVersion: row.consent_text_version,
  };
};

export interface InstantPicksSendOptions {
  /** The caller's IP, for the throttle's IP half. Null when the request carried no usable one. */
  ipAddress?: string | null;
  /** Defaults to `!smsSendingEnabled()` — a real dispatch requires opting in explicitly. */
  dryRun?: boolean;
  /** Defaults to `instantPicksSmsSendEnabled()`. Injected only so tests can exercise the far side. */
  enabled?: boolean;
  /** Injected for tests; defaults to the real loader above. */
  loadSubscriber?: InstantPicksSendSubscriberLookup;
  /** Injected for tests; defaults to the shared send throttle. */
  checkThrottle?: typeof checkAndRecordInstantPicksSend;
  /** Injected for tests; defaults to the shared Twilio seam. */
  dispatch?: typeof dispatchSms;
  /** Injected for tests; defaults to the shared send-log writer. */
  record?: typeof recordSmsSend;
  /** Injected for tests; defaults to the shared carrier-opt-out writer in weekly-send-io. */
  markStopped?: (subscriberId: string) => Promise<void>;
}

/**
 * Build and (unless held, refused or dry-run) send one on-demand digest.
 *
 * NEVER THROWS. The caller is a route whose PRIMARY job is rendering a list to a parent, and this
 * is the secondary half. A failure here must degrade to "no text, here is your list" and never to
 * a 500 — which is also why the route calls this AFTER it has a result in hand.
 *
 * ═══ THE ORDER OF THE CHECKS IS THE DESIGN, NOT AN ACCIDENT ═══
 * Cheapest and most absolute first, so a held deployment does no work at all:
 *   flag (no I/O) → subscriber read → consent gate → dry run → throttle → render → dispatch → log.
 * In particular the THROTTLE RUNS LAST OF THE GATES. It is the only one that WRITES, and spending
 * a subscriber's daily budget on a send that a flag or a consent version was going to refuse
 * anyway would let a held feature quietly lock out the parents it is later enabled for.
 */
export async function sendInstantPicksText(
  subscriberId: string,
  options: InstantPicksSendOptions = {}
): Promise<InstantPicksSendResult> {
  const held = { status: 'not_eligible' as const, segments: 0, degraded: false };

  // ── GATE 1: the Operator's switch. No database, no render, no log. ──────────────────────
  const enabled = options.enabled ?? instantPicksSmsSendEnabled();
  if (!enabled) return held;

  let subscriber: InstantPicksSendSubscriber | null;
  try {
    subscriber = await (options.loadSubscriber ?? loadInstantPicksSendSubscriber)(subscriberId);
  } catch (err) {
    // A read failure is a FAILURE, not an ineligibility — the difference matters to whoever is
    // reading the logs, and 'not_eligible' is silent by design so it would hide this.
    return {
      status: 'failed',
      segments: 0,
      degraded: true,
      error: `lookup failed: ${safeDetail(err)}`,
    };
  }
  // No row, no number, or no token. All three mean "there is nobody here to text", and none of
  // them is something to explain to the person looking at the page.
  if (!subscriber) return held;

  // ── GATE 2: the structural consent gate. See this file's header — refuses everything today. ──
  const serial = consentVersionSerial(subscriber.consentTextVersion);
  if (serial === null || serial < INSTANT_PICKS_MIN_CONSENT_SERIAL) return held;

  const dryRun = options.dryRun ?? !smsSendingEnabled();

  // ── A dry run builds the message and stops. ────────────────────────────────────────────
  // BUILT, NOT SKIPPED: the same discipline lib/sms/signup-store.ts states — a verification run in
  // an unconfigured environment must still exercise the template, so a body that would not render
  // fails there rather than in front of a parent.
  // NO THROTTLE WRITE: with sending off, no text can reach anyone and there is no abuse to
  // prevent, so this must not be the one thing in the path that needs a database in an environment
  // that has none. `checkAndRecordSignupAttempt` takes the same early exit for the same reason.
  // NOTHING IS LOGGED: `sms_send_log` records messages that were SENT and has no `dry_run` column,
  // deliberately (migration 0035).
  const message: RenderedMessage = renderInstantPicksMessage({
    preferencesUrl: buildPreferencesUrl(subscriber.preferencesToken),
  });
  if (dryRun) return { status: 'disabled', segments: message.segments, degraded: false };

  // ── GATE 3: the send throttle. FAILS CLOSED. ───────────────────────────────────────────
  const throttle = await (options.checkThrottle ?? checkAndRecordInstantPicksSend)({
    subscriberId: subscriber.id,
    ipAddress: options.ipAddress ?? null,
  });
  if (!throttle.allowed) {
    return {
      status: 'throttled',
      segments: message.segments,
      // `degraded` here means "it refused because it could not check", not "a real limit was hit".
      // The caller raises only the former: a parent hitting 3/day is the system working.
      degraded: throttle.degraded,
      error: throttle.degraded ? 'send throttle could not run; refused' : undefined,
    };
  }

  let dispatched: DispatchResult;
  try {
    dispatched = await (options.dispatch ?? dispatchSms)(subscriber.phoneNumber, message, {
      dryRun: false,
    });
  } catch (err) {
    return {
      status: 'failed',
      segments: message.segments,
      degraded: true,
      error: `dispatch threw: ${safeDetail(err)}`,
    };
  }

  const failed = dispatched.outcome !== 'sent';

  // ── A CARRIER OPT-OUT MUST CHANGE THE SUBSCRIBER'S STATE, NOT JUST THE LOG ──────────────
  // Twilio error 21610 means this number has told the carrier not to hear from us. PRD §2.2 step 6
  // makes this a send-time safeguard INDEPENDENT of the inbound webhook, and "independent" means
  // EVERY send path honours it — this is now the third, alongside the weekly job and the welcome.
  // Without it, a preferences link held by somebody who opted out at the carrier would leave them
  // 'active' forever while the identical Twilio code one branch over stopped them properly.
  // BEFORE the log write, matching weekly-send-io's ordering: the state change protects the
  // subscriber, the audit row records what happened.
  if (dispatched.outcome === 'stopped_via_carrier') {
    try {
      await (options.markStopped ?? defaultMarkStoppedViaCarrier)(subscriber.id);
    } catch {
      // Best-effort. The 21610 is still logged below, so the fact is not lost when the write is.
    }
  }

  try {
    await (options.record ?? recordSmsSend)({
      subscriberId: subscriber.id,
      phoneNumber: subscriber.phoneNumber,
      sendType: 'instant_picks',
      outcome:
        dispatched.outcome === 'stopped_via_carrier'
          ? 'stopped_via_carrier'
          : failed
            ? 'failed'
            : 'sent',
      // ⚠ ALWAYS NULL, AND NEVER "helpfully" POPULATED WITH WHAT WAS SELECTED. Migration 0035's
      // `sms_send_log_picks_only_weekly` CHECK rejects it outright, and the weekly novelty filter
      // would silently break if that CHECK were widened to allow it — a Wednesday press would
      // suppress those activities from Friday's real text. See migration 0049's header.
      picksSnapshot: null,
      twilioSid: dispatched.twilioSid,
      consentTextVersion: subscriber.consentTextVersion,
    });
  } catch (err) {
    // The text has already gone. Losing the audit row is bad — it is the CASL record — and it is
    // still not worth converting into a failed page render for the parent. Reported instead.
    return {
      status: failed ? 'failed' : 'sent',
      segments: message.segments,
      degraded: true,
      error: `send-log write failed: ${safeDetail(err)}`,
    };
  }

  if (failed) {
    return {
      status: 'failed',
      segments: message.segments,
      degraded: true,
      // `dispatched.error` is already scrubbed by lib/sms/twilio-client.ts, which reports the
      // error CODE and discards Twilio's message for exactly this reason. Scrubbed again anyway:
      // this module's promise should not depend on another module keeping its own.
      error: scrubDigits(dispatched.error ?? `dispatch outcome: ${dispatched.outcome}`),
    };
  }
  return { status: 'sent', segments: message.segments, degraded: false };
}
