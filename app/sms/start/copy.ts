// app/sms/start/copy.ts — Jon's brief for the minimal landing page, quoted verbatim.
//
// ═══ WHY THIS IS NOT IN lib/sms/consent-copy.ts ═══
// That file is the natural home for SMS copy, and its own header argues the case: copy living next
// to CONSENT_TEXT_VERSION cannot be edited without seeing the version. These two strings were
// briefly placed there for exactly that reason.
//
// They were moved out because consent-copy.ts is under an explicit instruction not to be touched
// while /sms/signup awaits its own iteration. Adding two unrelated constants would have had zero
// behavioural effect on that flow — but "no behavioural change" and "no diff" are different
// promises, and the conservative reading of that instruction is the one worth honouring when the
// cost of honouring it is a small file.
//
// ⚠ NOTHING HERE IS CONSENT COPY, which is what makes the split safe rather than merely tolerable.
// A page title and a call to action are not part of the act of consenting — the same distinction
// consent-copy.ts draws at its line 24 for SUBMITTED_HEADING/SUBMITTED_BODY. The sentence a parent
// actually agrees to on this page is CONSENT_CHECKBOX_TEXT, imported from consent-copy.ts and
// shared byte-for-byte with /sms/signup. That is the string the version constant governs, and it
// has not moved.
//
// If the Operator would rather these live with the rest of the SMS copy, moving them back is two
// lines and no behaviour change.

/** Jon, 2026-08-28, verbatim. */
export const START_HEADING =
  'Fun activities for you and your kids delivered by SMS once per week.';

/**
 * Jon, 2026-09-11, verbatim — replacing his 2026-08-28 wording after a copywriter audit.
 *
 * Three changes, all his: "kids ages" gains its possessive apostrophe, "activity preferences and
 * tel number" becomes the spoken-register "what they are into and your mobile number", and the
 * sentence now ends with a full stop. The missing full stop was previously preserved BECAUSE it
 * was his; it is gone now for the same reason, not because a reviewer tidied it.
 */
export const START_CTA =
  "Enter your postal code, your kids' ages, what they are into and your mobile number. We will do the rest.";
