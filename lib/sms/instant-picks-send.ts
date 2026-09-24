// lib/sms/instant-picks-send.ts — the text an Instant Picks press sends (plan v2.0 task 5).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🔴 READ THIS BEFORE CHANGING ANYTHING IN THIS FILE: IT IS LIVE, AND IT IS A CASL SEND PATH
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// This header used to say the module "CANNOT SEND ANYTHING in any environment". That stopped
// being true on 2026-09-14: task 1 bumped CONSENT_TEXT_VERSION to v8 (83c33c3) and the Operator
// set INSTANT_PICKS_SMS_SEND_ENABLED=true in production the same day. From then on this path
// texted every subscriber who pressed the button — INCLUDING ones who had never confirmed.
//
// Four independent gates must ALL pass before anything is dispatched:
//
//   1. `instantPicksSmsSendEnabled()`  — INSTANT_PICKS_SMS_SEND_ENABLED, default false. The
//      Operator's switch. ⚠ NOT `SMS_SENDING_ENABLED`, which gates the Friday weekly send.
//   2. CONFIRMED, ACTIVE CONSENT        — `hasConfirmedActiveConsent`: status = 'active' AND
//      confirmed_timestamp set. ⛔ THE CASL GATE. See "WHY GATE 2 EXISTS" below.
//   3. `consent_text_version >= v8`    — the wording gate (plan §7): the subscriber agreed to the
//      disclosure that mentions on-demand texts. Says nothing about whether they CONFIRMED it.
//   4. the send throttle              — fail-closed, both halves (lib/sms/instant-picks-send-throttle.ts).
//
// ═══ WHY GATE 2 EXISTS — THE 2026-09-24 CASL FIX ═══
// Until this gate, the only status rule on this path was the one `findInstantPicksSubscriber`
// applies to the ON-PAGE LIST: refuse `stopped` and purged rows, SERVE `pending` and `paused`.
// That rule is right for the list — nothing leaves the page — and this module then inherited it
// as its SEND rule ("already refused one step earlier… re-asserting it would be a second copy").
// While gate 3 refused everybody that borrowed rule never mattered; once v8 shipped, a `pending`
// row stamped v8 cleared every remaining gate. Concretely, a pending row holds a working
// `/u/{token}` link whenever: a STOPPED subscriber resubmits the web form (the upsert resets them
// to `pending`, clears `confirmed_timestamp`, and deliberately KEEPS their old token, which is in
// every text they ever got); a PAUSED one resubmits likewise; or anyone else obtains the link. A
// press then texted a number whose double opt-in was incomplete — a commercial electronic message
// without confirmed express consent, which is exactly what CASL prohibits. Reproduced in prod on
// 2026-09-24 (sms_send_log send_type 'instant_picks' at 15:41:26Z against a never-confirmed row).
//
// SEND ELIGIBILITY IS NOT LIST ELIGIBILITY. The two rules answer different questions and must not
// be merged again: the list may show to anyone with a live link; the TEXT goes only to a
// subscriber whose double opt-in is complete and not paused or withdrawn — the same population
// the Friday send selects (`loadActiveSubscribers`: WHERE status = 'active').
//
// `paused` IS REFUSED TOO, deliberately. Their consent was confirmed and never withdrawn, so a
// requested text is arguably permissible — but the page they are pressing on tells them "Your SMS
// updates are paused", and "we text only the people the weekly job would text" is one rule with no
// legal read attached. Widening to paused later is one condition in `hasConfirmedActiveConsent`;
// flagged to Jon rather than decided here.
//
// ═══ WHY THE WORDING GATE (3) IS STRUCTURAL RATHER THAN REASONED ═══
// CASL treats a message sent IN RESPONSE TO A REQUEST from the recipient differently from an
// unsolicited one, and a subscriber pressing their own button on their own preferences page is
// about as clean a request as exists — which would mean v7 subscribers could receive this. That is
// a legal read, and this feature does not ship on one. Gating on the version answers the question
// with a mechanism instead of an opinion. If Jon later obtains a legal read that says v7 is fine,
// THAT is when this changes, and it changes here, once. (The same "request" argument does NOT
// rescue a pending subscriber: pressing a button is not the JOIN reply that completes the double
// opt-in, and this product's consent record treats only that reply as confirmation.)
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
import type { ConsentStatus } from './consent-transitions';
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
 * 8 IS THE WORDING THAT FIRST DISCLOSED THIS TEXT (task 1, 2026-09-14). It was written ahead of
 * that copy change so the module stayed inert until then. ⚠ It is a WORDING check only: a pending
 * subscriber who submitted the v8 form clears it without ever confirming — which is why gate 2
 * (`hasConfirmedActiveConsent`) exists and runs first.
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
   * ═══ IT MUST STAY SILENT ═══
   * The flag is off, or this subscriber has not confirmed (or is paused), or their consent
   * predates v8, or they have no phone number left after the 30-day purge. None of those is a
   * failure a parent can act on here: a pending subscriber's page already tells them to reply JOIN
   * and a paused one's already explains the pause, and a pre-v8 page says "1 message per week,
   * plus a one-time confirmation message" — so "we couldn't text you" would describe a text that
   * was never offered to them.
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
  /** Copied verbatim onto the audit row, and the thing the wording gate reads. */
  consentTextVersion: string;
  /** The CASL lifecycle state. Read by the consent gate; never returned or logged. */
  status: ConsentStatus;
  /** When they replied JOIN. NULL while pending, and cleared again by a form resubmission. */
  confirmedTimestamp: Date | null;
}

export type InstantPicksSendSubscriberLookup = (
  subscriberId: string
) => Promise<InstantPicksSendSubscriber | null>;

/**
 * May this subscriber be sent a content text at all? (Gate 2 — the CASL gate.)
 *
 * BOTH HALVES, because each covers a state the other cannot see:
 *   • `status === 'active'` refuses `pending` (never confirmed, or re-consenting after a
 *     resubmit), `paused` and `stopped`.
 *   • `confirmedTimestamp !== null` is the recorded proof of the JOIN reply. No transition today
 *     writes `active` without it, so this half should be redundant — which is exactly when a
 *     compliance gate should still check it: a hand-edited row, a future transition or a restore
 *     that sets `active` without the proof must fail closed, not open.
 *
 * Pure and exported so the SHIPPED predicate is what the tests execute, not a copy of it.
 */
export function hasConfirmedActiveConsent(
  subscriber: Pick<InstantPicksSendSubscriber, 'status' | 'confirmedTimestamp'>
): boolean {
  return subscriber.status === 'active' && subscriber.confirmedTimestamp != null;
}

/**
 * Load what the text needs, keyed on the id the route already resolved from the token.
 *
 * IT READS `status` AND `confirmed_timestamp`, AND DOES NOT TRUST THE ROUTE'S LOOKUP FOR THEM.
 * `findInstantPicksSubscriber` answers a different question — may this link see the LIST — and
 * deliberately serves `pending` and `paused` rows. This file once relied on that lookup as its
 * status check, which is how never-confirmed subscribers came to be texted (see the header). The
 * send rule is applied in `sendInstantPicksText`, as gate 2, on the values read HERE — in the same
 * read that supplies the phone number, so the number and the consent state it is judged by come
 * from one snapshot of the row.
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
    status: ConsentStatus;
    confirmed_timestamp: Date | null;
  }>(
    `SELECT id, phone_number, preferences_token, consent_text_version,
            status, confirmed_timestamp
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
    status: row.status,
    confirmedTimestamp: row.confirmed_timestamp,
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
 *   flag (no I/O) → subscriber read → CONFIRMED-CONSENT gate → wording gate → dry run → throttle
 *   → render → dispatch → log.
 * In particular the THROTTLE RUNS LAST OF THE GATES. It is the only one that WRITES, and spending
 * a subscriber's daily budget on a send that a flag or a consent gate was going to refuse
 * anyway would let a held feature quietly lock out the parents it is later enabled for — or, for a
 * pending subscriber, burn the budget they will want the moment they reply JOIN.
 * The consent gate also runs BEFORE the dry run, so a staging dry run reports `not_eligible` for a
 * pending subscriber exactly as production would, rather than `disabled` for a send that could
 * never have happened.
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

  // ── GATE 2: CONFIRMED, ACTIVE CONSENT. The CASL gate — see this file's header. ─────────────
  // Before everything that could write or dispatch. A pending subscriber has not completed the
  // double opt-in; a paused or stopped one is not being texted. SILENT (`not_eligible`), because
  // the page already tells each of them what their state is.
  if (!hasConfirmedActiveConsent(subscriber)) return held;

  // ── GATE 3: the consent WORDING. They agreed to the disclosure that mentions this text. ─────
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

  // ── GATE 4: the send throttle. FAILS CLOSED. ───────────────────────────────────────────
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
