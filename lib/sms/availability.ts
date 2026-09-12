// lib/sms/availability.ts — "may the home page offer SMS signup right now, and where does it
// point?" (TSD §9 M1 T1.3 / AC-04b, AC-12).
//
// ═══ WHY THIS LIVES IN THE SMS LIB AND NOT ON THE PAGE ═══
// It is one line of logic, and putting it here rather than inlining `smsSignupEnabled()` into
// app/page.tsx buys two things. First, the home page never learns about process.env or about
// which flag governs signup — it asks a question in its own vocabulary and renders the answer.
// Second, the question and the flag live in the same module, so a future change to what "signup
// is on" means moves them together instead of leaving a stale second reader on the front door.
//
// ═══ THE FAILURE THIS EXISTS TO PREVENT (AC-12) ═══
// app/sms/start/page.tsx calls `notFound()` unless SMS_SIGNUP_ENABLED === 'true'. Before this
// helper, nothing stopped the home page advertising a destination that 404s: the flag defaults
// to FALSE, so the DEFAULT state of the product was a front door pointing at a dead end. The
// point is not that the two surfaces read the same variable — it is that they cannot read it
// DIFFERENTLY, which is why `signupAvailable()` below delegates to `smsSignupEnabled()` rather
// than re-reading the env var with its own comparison.
import { SMS_SIGNUP_PATH, smsSignupEnabled } from './config';

/**
 * Whether the home page may offer signup, and the internal path to send a parent to.
 *
 * A DISCRIMINATED UNION, NOT `{ available: boolean; href: string }`, and that is the whole
 * safety property: in the unavailable branch there is no path to render. A caller that forgets
 * to check `available` has nothing to put in an href — it gets `null`, which is a visible bug at
 * the point of the mistake rather than a live button that 404s. The shape makes AC-12's failure
 * mode hard to express instead of merely forbidden.
 */
export type SmsSignupAvailability =
  | { readonly available: true; readonly href: typeof SMS_SIGNUP_PATH }
  | { readonly available: false; readonly href: null };

/**
 * Answer the home page's question, per request.
 *
 * PARITY WITH `smsSignupEnabled()` IS THE REQUIREMENT, not an improvement on it — hence the
 * delegation rather than a second `=== 'true'` written here. A reader that was more lenient
 * (accepting 'TRUE', '1', 'yes') would put a live CTA in front of a page that 404s; one that was
 * stricter would hide a form that works. Both are the same bug: the front door disagreeing with
 * the destination about whether signup exists.
 *
 * DELIBERATELY DOES NOT CALL `siteUrl()` / `signupUrl()`. Those throw by design when sending is
 * enabled and NEXT_PUBLIC_SITE_URL is unset or wrong, which is correct for an SMS body and
 * catastrophic on a render path — it would turn one misconfigured variable into a 500 on the
 * product's front door. This function cannot throw.
 *
 * Cheap enough to call at render: one env read, no I/O. The home page is already
 * `force-dynamic`, so this is evaluated per request and a flag flip takes effect without a
 * rebuild (TSD §4.1).
 */
export function smsSignupAvailability(): SmsSignupAvailability {
  return smsSignupEnabled()
    ? { available: true, href: SMS_SIGNUP_PATH }
    : { available: false, href: null };
}
