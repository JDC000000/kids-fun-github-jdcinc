// lib/sms/waitlist-copy.ts — every word the AREA WAITLIST says, kept apart from consent-copy.ts.
//
// ═══ WHY THIS IS A SEPARATE FILE FROM consent-copy.ts ═══
// Not tidiness. `consent-copy.ts` is the wording of ONE promise — a weekly text, double opt-in,
// stamped into `sms_consent.consent_text_version`. The waitlist is a DIFFERENT promise to a
// DIFFERENT audience: one message, once, if we ever reach them, to somebody who has not agreed to
// the weekly text at all.
//
// Putting both in one file would put both under one version constant, and no later audit could say
// which promise a given row referred to. Two purposes, two files, two versions.
//
//   >>> A ROW IN sms_area_waitlist IS NOT A SUBSCRIBER. <<<
//   Nothing here may be reused to justify sending a weekly pick.

/**
 * Stamped into `sms_area_waitlist.waitlist_consent_version`. Independent of
 * CONSENT_TEXT_VERSION — they version different promises and must be free to move separately.
 *
 * ── HISTORY ─────────────────────────────────────────────────────────────────────────────
 * Same discipline as consent-copy.ts's block: an entry per version, naming the commit whose state
 * of this file IS that version, so a stamped row can always be resolved back to what it agreed to.
 *
 *   2026-08-31.v1  →  current (first issue).
 *
 * >>> BUMPING THIS? ADD THE OUTGOING VERSION TO THE LIST ABOVE IN THE SAME COMMIT. <<<
 */
export const WAITLIST_CONSENT_VERSION = '2026-08-31.v1';

/**
 * The opt-in a parent ticks. Express consent, unchecked by default, single-purpose.
 *
 * Jon ruled no confirmation SMS at signup (2026-08-31), so THIS SENTENCE is the entire consent
 * record — there is no second act to lean on. It therefore has to be exact about the three things
 * a CASL reviewer would ask: what we store, what we will send, and that nothing else follows.
 */
export const WAITLIST_CONSENT_TEXT =
  'Text me once if KIDS FUN reaches my area. I agree that KIDS FUN can store my phone number and ' +
  'my area to send that one message. This is not a signup for the weekly texts, and I will get ' +
  'nothing else unless I choose to sign up.';

/** Scenario A — a covered municipality we serve thinly. Signup stays available. */
export const WAITLIST_SPARSE_CTA =
  'Or we can text you once when your area fills out, instead of signing up now.';

/** Scenario B — no covered municipality at all. This is the only thing on offer. */
export const WAITLIST_OUT_OF_AREA_CTA =
  'We can text you once when we reach your area — one message, and nothing until then.';

export const WAITLIST_SUBMIT = 'Text me when you reach my area';
export const WAITLIST_DONE_HEADING = 'We have your number';
export const WAITLIST_DONE_BODY =
  'We will text you once when we reach your area. Nothing before then, and nothing else after ' +
  'unless you choose to sign up.';

/**
 * ═══ THE NOTIFICATION ITSELF — AND THE BAR IT HAS TO CLEAR ═══
 * Jon's condition on skipping the confirmation SMS (2026-08-31): this message must be fully
 * intelligible IN ISOLATION, to somebody who does not remember opting in, possibly months later.
 * That is the trade — no confirmation step at signup means this one message carries the entire
 * burden of explaining itself.
 *
 * So it is built to answer, in order, the three questions such a person actually has:
 *   1. WHO IS THIS?          — "KIDS FUN:" leads, matching every other message this product sends.
 *   2. WHY AM I GETTING IT?  — "You asked us to text you when we reached {area}" states the cause,
 *                              not just the offer. Without this the message is indistinguishable
 *                              from cold spam, which is precisely the failure double opt-in would
 *                              otherwise have prevented.
 *   3. HOW DO I STOP?        — "Reply STOP" last, where this product always puts it.
 *
 * It also honours the promise the opt-in made: it points at signup rather than assuming consent,
 * because these people never agreed to the weekly text. Replying JOIN would do nothing for them —
 * they have no `sms_consent` row for the inbound handler to confirm — so the message must not
 * suggest it.
 */
export function renderWaitlistNotification(areaLabel: string, signupUrl: string): string {
  return (
    `KIDS FUN: You asked to hear when we reached ${areaLabel}. We have. ` +
    `Weekly kid activity picks: ${signupUrl} Reply STOP to opt out.`
  );
}
