// lib/sms/consent-copy.ts — every word the signup form says about consent, in one versioned place.
//
// DRAFT (SMS pivot). Pure data. No React, no DOM, no I/O — so the copy is unit-testable, is
// quotable in a test that asserts the form actually renders it, and above all is VERSIONED.
//
// ── WHY THE COPY IS A MODULE AND NOT JSX ─────────────────────────────────────────────────
// `sms_consent.consent_text_version` (migration 0034) is NOT NULL, and it exists so that a CASL
// or PIPEDA question a year from now — "which wording did this subscriber actually agree to?" —
// has an answer. That promise is only worth anything if the wording and the version move
// together. Copy living inline in a component can be edited without anyone thinking about the
// version column; copy living here, next to the constant, cannot be edited without seeing it.
//
//   >>> IF YOU CHANGE WORDING A SUBSCRIBER AGREES TO, BUMP CONSENT_TEXT_VERSION. <<<
//   Not "consider bumping". The version is what a regulator would be shown.
//
//   ── WHAT THAT COVERS, made precise in round 20 because it used to read "ANY STRING IN THIS
//   ── FILE" and that is broader than what the column means.
//   `sms_consent.consent_text_version` answers ONE question: which wording did this subscriber
//   AGREE TO. So it moves for `CONSENT_CHECKBOX_TEXT` and for anything else presented as part of
//   the act of consenting — and it does NOT move for copy shown AFTER submission, which cannot be
//   part of what was agreed to.
//     • MOVES IT: the consent checkbox, the field labels and help text around it, the carrier
//       disclosures shown beside it, the sender identification block.
//     • DOES NOT MOVE IT: `SUBMITTED_HEADING` / `SUBMITTED_BODY` (the post-submit confirmation
//       page), and the preferences-page status lines — all displayed only to somebody who has
//       already consented.
//   Bumping for those would stamp two subscribers with different versions who agreed to identical
//   wording, which makes the column a WORSE answer to its own question, not a safer one. A
//   spurious bump is not conservative here; it is a false statement in an audit column.
//   Precedent: PRD v3.9 declined to bump for the /privacy wording change on the same reasoning.
//   ⚠ This narrowing was the DO's judgment call (round 20) and is one constant and one comment to
//   reverse if the Operator disagrees.
//
// ── THIS FORM IS ALSO A COMPLIANCE ARTEFACT, NOT ONLY A UI ───────────────────────────────
// Per the Operator: a screenshot of this form is intended as the opt-in evidence for the Twilio
// Canadian Toll-Free Verification submission (PRD §0, §1.5). That makes visual and verbal
// fidelity load-bearing in a way it usually is not for a draft — a reviewer reads the actual
// pixels. See CARRIER_DISCLOSURES below for the part of that which the PRD does not itself
// specify, and why it is here anyway.

/**
 * The version stamped into `sms_consent.consent_text_version` for anyone who agrees to the
 * wording in this file. Date-prefixed so it sorts, suffixed so more than one revision can land
 * on one day.
 */
export const CONSENT_TEXT_VERSION = '2026-08-26.v2';

/** What the page is, in one line, above the fields. */
export const FORM_HEADING = 'Get weekend activity picks by text';

export const FORM_INTRO =
  'One text a week, Friday afternoon, with 5–10 things to do with your kids that weekend — ' +
  'near you, and matched to their ages. Free.';

/**
 * THE CONSENT CHECKBOX. Unchecked by default, and the form cannot submit without it (PRD §1.3,
 * §1.4 — express, opt-in, unchecked-by-default).
 *
 * ONE checkbox, deliberately, and PRD §1.3 explains why: there is a single purpose here (making
 * the weekly text personal), the children's ages exist only to serve that one purpose, and
 * bundling separate consents for one purpose would be theatre rather than specificity.
 *
 * Every clause below is one of §1.3's four required disclosures. Do not delete one to shorten
 * the sentence:
 *   1. WHAT is collected — phone number, postal code, children's approximate ages.
 *   2. WHY — to text personalised weekend activity picks.
 *   3. That it is NEVER shared with advertisers or third parties.
 *   4. WHERE to see, change or delete it — the preferences page, linked.
 */
export const CONSENT_CHECKBOX_TEXT =
  'Yes, text me weekly activity picks. I agree that KIDS FUN can store my phone number, my ' +
  'postal code and my children’s approximate ages, and use them only to choose the activities ' +
  'in that weekly text. This information is never sold or shared with advertisers or any other ' +
  'third party. I can see, change or delete everything stored about me at any time from my ' +
  'preferences page, which is linked in every message.';

/** Where clause 4's "preferences page" points. Linked from the checkbox label itself. */
export const PREFERENCES_LINK_LABEL = 'preferences page';

/**
 * What happens immediately after submit — the double opt-in, stated before they submit rather
 * than sprung on them afterwards (PRD §1.4: JOIN, not YES, because Twilio's Advanced Opt-Out
 * intercepts YES at the carrier layer before our webhook ever sees it).
 */
export const WHAT_HAPPENS_NEXT =
  'We’ll text you once to confirm. Reply JOIN to that message and you’re in — your first picks ' +
  'arrive the next Friday around 4pm.';

/**
 * CARRIER-FACING DISCLOSURES — NOT SPECIFIED BY THE PRD, ADDED HERE ON PURPOSE. FLAGGED.
 *
 * PRD §1.3/§1.4 specify the PIPEDA and CASL disclosures (above), which are about the subscriber
 * and the regulator. These four lines are about the CARRIER: message frequency, that standard
 * rates apply, how to stop, and how to get help are the elements a Toll-Free Verification
 * reviewer looks for in an opt-in screenshot, and a submission that omits them is a submission
 * that can come back. Since this form's stated purpose includes being that screenshot, leaving
 * them off would produce a form that satisfies the PRD and fails the job it was built for.
 *
 * !! OPERATOR: this is an addition beyond the PRD's literal §1.3/§1.4 list, made by the
 * !! implementer. It should be checked against the CURRENT Twilio Toll-Free Verification form
 * !! before submission rather than trusted from here — the exact expectations are Twilio's and
 * !! they change. The claim being made in this comment is only that these are the elements such
 * !! submissions are commonly rejected for missing, not that this list is authoritative.
 *
 * The support contact and mailing address that CASL §1.4 requires are not in THIS list because
 * they are sender identification rather than carrier disclosure. See SENDER_IDENTITY.
 */
export const CARRIER_DISCLOSURES: readonly string[] = [
  'Message frequency: 1 message per week, plus a one-time confirmation message.',
  'Message and data rates may apply.',
  'Reply STOP at any time to unsubscribe. Reply HELP for help.',
];

/**
 * THE SUPPORT CONTACT, AND THE ONE PLACE THE NUMBER IS WRITTEN DOWN.
 *
 * It is the KIDS FUN toll-free number itself — the same number the weekly texts come FROM, reached
 * by replying to any of them or texting it directly. No email, no second number: a subscriber's
 * whole relationship with this product is over SMS, and giving them an email address to write to
 * would be inventing a channel nobody is watching.
 *
 * WRITTEN ONCE. Three surfaces need it (the signup form's footer, the preferences page's footer,
 * and the "activity gone" interstitial's "let me know if you have any other questions"), and a
 * phone number typed three times is a phone number that will eventually be three different
 * numbers. Everything else derives from these two constants.
 *
 * NOT env config, deliberately: this is a business FACT like the mailing address below, not a
 * per-environment value. The outbound sender comes from TWILIO_MESSAGING_SERVICE_SID
 * (lib/sms/config.ts) and is a separate concern — this constant exists only to be DISPLAYED.
 */
export const SUPPORT_PHONE_E164 = '+18778357776';
/** The same number, as a human reads it. */
export const SUPPORT_PHONE_DISPLAY = '+1 877-835-7776';

/** `tel:` href for the support number, so a phone can dial or text it from a tap. */
export const SUPPORT_PHONE_HREF = `tel:${SUPPORT_PHONE_E164}`;

/**
 * The CASL sender identification (PRD §1.4), Jon-approved 2026-08-26.
 *
 * CASL's identification rules require every commercial electronic message to identify the sender
 * and give a way to reach them — and, because a text has no room for it, the rules permit that
 * identification to live one click away on a linked page. That page is the preferences/hub page
 * linked in every message, which is why this block renders there and on the signup form.
 *
 * These replaced a deliberate gap marker that rendered a visible "draft" banner on both surfaces
 * while the three facts did not exist. They exist now, so the banner is gone.
 *
 * Business registration is included even though Twilio's Toll-Free Verification API lists
 * `BusinessRegistrationNumber` as "required for all business types EXCEPT SOLE_PROPRIETOR"
 * (checked 2026-08-26 against twilio.com/docs/messaging/compliance/toll-free/api-onboarding — see
 * the round-9 notes). Jon is a sole proprietor, so it is optional there; it is stated here anyway
 * because CASL identification is better served by more precision, not less.
 */
export const SENDER_IDENTITY = {
  legalName: 'Jon Cartwright',
  operatingAs: 'KIDS FUN',
  mailingAddress: '2288 Adanac Street, Vancouver, BC V5L 2E8, Canada',
  businessRegistration: 'CRA Business Number 852296375 (sole proprietor)',
  supportPhone: SUPPORT_PHONE_DISPLAY,
} as const;

/** One-line lead-in above the identity block, so it reads as a statement rather than a data dump. */
export const SENDER_IDENTITY_LEAD = 'These messages are sent by:';

/** How to reach a human, stated in the same breath as who is sending. */
export const SUPPORT_LINE =
  `Questions? Text us at ${SUPPORT_PHONE_DISPLAY} - the same number your picks come from.`;

/**
 * The sparse-municipality warning, shown inline BEFORE submit when the typed postal code lands
 * in an area the catalogue barely covers.
 *
 * Wording is PRD §2.1 verbatim. Setting the expectation before signup is the cheapest churn
 * defence available: the alternative is a parent in West Vancouver confirming, receiving an
 * empty-week text, and reasonably concluding the product does not work.
 */
export const SPARSE_AREA_NOTICE =
  'Heads up — we’re just getting started in your area, so some weeks may have fewer picks.';

/**
 * Shown when a postal code resolves to no covered municipality at all.
 *
 * This is a REJECTION, not a warning, and the distinction is deliberate — see
 * `parseSmsSignupBody` in lib/sms/signup-validate.ts for the argument.
 */
export const OUT_OF_AREA_NOTICE =
  'We only cover Vancouver, North Vancouver, West Vancouver, Burnaby and Richmond right now, ' +
  'so we would not have anything to send you yet.';

/** Field labels + helper text, kept beside the consent copy so the whole form reads as one voice. */
export const FIELD_COPY = {
  phoneLabel: 'Mobile number',
  phoneHelp: 'Canadian mobile number. This is the only way we identify you — no account, no password.',
  postalLabel: 'Postal code',
  postalHelp: 'Used to find activities near you. We store the postal code, never a precise location.',
  childrenLabel: 'How old are your kids?',
  // Reworded in round 21 after V1 testing read it as briefly self-contradictory: "no birthdays"
  // followed immediately by "we store the year they were born" lands as a contradiction until the
  // reader works out that a YEAR is not a BIRTHDAY. Same meaning, same consent posture, same data
  // collected — the sentence now explains before it reassures, instead of the other way round.
  childrenHelp:
    'Just their age now, in years. We turn that into a birth year so the ages stay right as they ' +
    'grow up — we never ask for a birthday or a name.',
  addChild: 'Add another child',
  removeChild: 'Remove',
  interestsLabel: 'Anything they’re especially into? (optional)',
  interestsHelp: 'Leave this blank to see everything. We’ll widen it automatically on a quiet weekend.',
  submit: 'Text me weekly picks',
  submitting: 'Signing up…',
} as const;

/** What the page says once the signup has been accepted. */
export const SUBMITTED_HEADING = 'Check your phone';

/**
 * ═══ THE LAST SENTENCE IS JON'S OWN WORDING, INSERTED VERBATIM (PRD §8 Q5, v3.15) ═══
 * Asked to choose between options, he wrote the copy instead: *"please make up that sentence and
 * insert it. Solve that problem. approved"* — and the Operator authored the sentence below, which
 * is reproduced exactly rather than smoothed.
 *
 * WHAT IT SOLVES. Twilio error 21610 on the confirmation send means the number signing up has
 * ALREADY blocked our sender — usually because they texted STOP at some point in the past. The
 * text is undeliverable and always will be until they text START themselves. Before this, the page
 * said "check your phone" and nothing ever arrived. Round 12 flagged it; this closes it.
 *
 * ═══ IT IS SHOWN TO EVERYONE, AND THAT IS A SECURITY DECISION, NOT LAZINESS ═══
 * The obvious implementation is to show it only when the dispatch actually returned 21610. That
 * would be a real regression: app/api/sms/signup/route.ts deliberately never surfaces `errorCode`
 * or the dispatch outcome to an unauthenticated caller, precisely so the form cannot be used to
 * probe whether SOMEONE ELSE'S number is opted out. Making this copy conditional would rebuild
 * that oracle out of a paragraph instead of a JSON field, and would be harder to notice.
 *
 * So the sentence is written to be true and useful for everyone who reads it, and it costs a
 * reader who does not need it one sentence.
 *
 * ═══ `SUPPORT_PHONE_DISPLAY`, NOT A FOURTH HAND-TYPED NUMBER ═══
 * The signup footer, the preferences footer and the "activity gone" page all derive from
 * `SUPPORT_PHONE_E164`. A number typed a fourth time is a number that will eventually be four
 * different numbers.
 *
 * ═══ NOT SMS COPY — no GSM-7 guard applies ═══
 * This is HTML shown in a browser. It never goes near a Twilio message body, so segment cost and
 * the GSM-7 alphabet are irrelevant to it, which is why it can keep the curly apostrophe in
 * "We've" that would be a real cost in a text. tests/sms/signup_copy.test.ts asserts exactly that
 * — that this string is NOT GSM-7 clean and is not sendable — so the distinction is checked
 * rather than assumed.
 *
 * ⚠ ONE INCONSISTENCY LEFT DELIBERATELY IN PLACE: Jon's sentence uses a STRAIGHT apostrophe in
 * "you've" while the sentence above it uses a curly one in "We've". Left exactly as authored,
 * because "insert verbatim" is the instruction and a one-character typographic edit to approved
 * copy is still an edit to approved copy. Flagged rather than normalised; it is a one-character
 * change in either direction if anyone wants them to match, and there is no encoding cost either
 * way on a web page.
 */
export const SUBMITTED_BODY =
  'We’ve sent you one text. Reply JOIN to confirm, and your first picks arrive Friday around ' +
  '4pm. If it does not arrive in a few minutes, check the number and try again. ' +
  `If you've texted us before and replied STOP, text START to ${SUPPORT_PHONE_DISPLAY} first to ` +
  'turn our texts back on, then try again.';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE PREFERENCES / HUB PAGE (PRD §2.4)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// LIVES HERE RATHER THAN IN THE PAGE, for the same reason the signup copy does: this page carries
// the CASL footer and the unsubscribe wording, and both are things a regulator reads. It also
// SHARES `SENDER_IDENTITY` and `CARRIER_DISCLOSURES` with the signup form rather than restating
// them — the legal sender name, mailing address and support contact are the same facts on both
// surfaces, and two hand-written copies would eventually be two different addresses.

export const PREFS_HEADING = 'Your KIDS FUN texts';

/** Shown when the subscription is live. */
export const PREFS_STATUS_ACTIVE =
  'You are getting weekly picks every Friday afternoon.';

/**
 * Shown when the subscriber has been auto-paused after three empty weeks.
 *
 * Deliberately echoes the pause-notice SMS (lib/sms/message.ts `renderPauseNoticeMessage`) rather
 * than inventing a second explanation: a parent arriving here has just read that text, and being
 * told a different story by the link inside it is how a product stops sounding like one thing.
 */
export const PREFS_STATUS_PAUSED =
  'Your texts are paused. We could not find matches near you for a few weeks. ' +
  'Update your area or interests below and save, and they will start again.';

/** Shown when they are still waiting to reply JOIN. */
export const PREFS_STATUS_PENDING =
  'Almost there. Reply JOIN to our confirmation text and your weekly picks will start.';

/** Shown once they have unsubscribed. */
export const PREFS_STATUS_STOPPED =
  'You have unsubscribed. We are not sending you anything.';

/** Shown when the 30-day purge has already run and there is nothing left to show or edit. */
export const PREFS_PURGED =
  'Everything we stored about you has been deleted. There is nothing left here to change.';

export const PREFS_LAST_WEEK_HEADING = 'Last Friday';
export const PREFS_LAST_WEEK_NONE = 'We have not sent you a weekly text yet.';
export const PREFS_LAST_WEEK_EMPTY =
  'Nothing near you matched last week, so we said so rather than padding the list.';

export const PREFS_EDIT_HEADING = 'What we use to pick';
export const PREFS_SAVE = 'Save changes';
export const PREFS_SAVING = 'Saving...';
export const PREFS_SAVED = 'Saved. Your next Friday text will use these.';

export const PREFS_UNSUBSCRIBE_HEADING = 'Stop the texts';
export const PREFS_UNSUBSCRIBE_BODY =
  'You will stop getting weekly picks straight away. Everything we store about you is deleted ' +
  '30 days later.';
export const PREFS_UNSUBSCRIBE = 'Unsubscribe';
export const PREFS_UNSUBSCRIBED = 'Done. You will not get any more texts from us.';

export const PREFS_DELETE_HEADING = 'Delete my data';

/**
 * The delete control's copy states what actually happens, and it is deliberately DIFFERENT from
 * the unsubscribe copy above: unsubscribe stops the texts and lets the ordinary 30-day retention
 * clock run; this erases now.
 *
 * See `decideDelete` in lib/sms/preferences.ts for why immediate rather than 30 days, and for the
 * fact that it is a reading of §1.3's intent that needs confirming.
 */
export const PREFS_DELETE_BODY =
  'This unsubscribes you and erases your phone number, postal code, children\'s ages and ' +
  'interests immediately. It cannot be undone - you would have to sign up again from scratch.';
export const PREFS_DELETE = 'Delete everything';
export const PREFS_DELETE_CONFIRM = 'Yes, delete it all';
export const PREFS_DELETE_CANCEL = 'Cancel';
export const PREFS_DELETED = 'Deleted. Nothing about you is stored any more.';

/**
 * What an unrecognised token gets.
 *
 * ONE MESSAGE FOR EVERY REASON — never existed, already deleted, mistyped, truncated by a
 * messaging app. Distinguishing them would tell a prober which of their guesses was close, and
 * would tell anyone holding an old link whether that person is still a subscriber. Neither is
 * information we owe, and the second is information about somebody else.
 */
export const PREFS_UNKNOWN_TOKEN_HEADING = 'This link is not working';
export const PREFS_UNKNOWN_TOKEN_BODY =
  'It may be incomplete, or it may belong to a subscription that has since been deleted. ' +
  'You can sign up again any time. ' +
  // THE INDEPENDENT BACKUP OPT-OUT, added in round 21 after V1 testing. This page is the CASL
  // unsubscribe path, and somebody arriving here has just been told their link does not work —
  // which, for a person trying to stop the texts, reads as a dead end. Texting STOP never depended
  // on this link: it is handled at the carrier layer by Twilio's Advanced Opt-Out before our
  // webhook runs. Saying so costs one sentence and removes the one situation where a broken link
  // could look like a trapped subscription.
  'If you are trying to stop the texts, replying STOP to any message always works, even if this ' +
  'link does not.';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE "ACTIVITY GONE" INTERSTITIAL (PRD §8 Q3, Jon-approved 2026-08-26)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Where a tapped weekly link goes when the token verified but the activity has since been
// archived — a cancelled session, a source that stopped publishing. Round 6 built the distinct
// `occurrence_gone` outcome and sent it to /search because no such page existed; this is that
// page's copy, and the outcome now has somewhere of its own to go.

/**
 * Jon's wording, VERBATIM. Do not smooth it — the voice is the point, and it is the one piece of
 * copy on this branch written by the product owner rather than drafted and approved.
 *
 * ── "me" BECAME "us" IN ROUND 22, AND THE GUARD DID ITS JOB ─────────────────────────────
 * V1 testing flagged the first person as off-voice: everything else in the product says "we", and
 * a lone "me" implies one person behind the number. It was correctly NOT changed when it came
 * through as a routine copy-polish item, because this sentence is the product owner's own and this
 * comment said so. JON THEN CHANGED IT HIMSELF — "-we APPROVED", his own suggested phrasing — so
 * the edit is his, not ours. That is the whole distinction the guard exists to enforce, and it
 * held: a tone note could not move these words, and the author could.
 *
 * One word. Nothing else in the sentence was touched.
 */
export const ACTIVITY_GONE_BODY =
  "Oops, looks like that's been canceled! Let us know if you have any other questions. Keep moving.";

/**
 * "Let us know if you have any other questions" needs somewhere to be let known. It points at the
 * SAME support contact as everything else — see SUPPORT_PHONE_E164 for why the number is written
 * down exactly once.
 */
export const ACTIVITY_GONE_HEADING = 'That one is gone';
export const ACTIVITY_GONE_ONWARD = 'See what else is on this weekend';
