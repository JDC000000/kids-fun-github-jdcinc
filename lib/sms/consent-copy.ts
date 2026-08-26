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
//   >>> IF YOU CHANGE ANY STRING IN THIS FILE, BUMP CONSENT_TEXT_VERSION. <<<
//   Not "consider bumping". The version is what a regulator would be shown.
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
export const CONSENT_TEXT_VERSION = '2026-08-26.v1';

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
 * The support contact and mailing address that CASL §1.4 requires are deliberately NOT here:
 * they are real-world facts nobody on the build side may invent. See MISSING_SENDER_IDENTITY.
 */
export const CARRIER_DISCLOSURES: readonly string[] = [
  'Message frequency: 1 message per week, plus a one-time confirmation message.',
  'Message and data rates may apply.',
  'Reply STOP at any time to unsubscribe. Reply HELP for help.',
];

/**
 * !! NOT COPY — A GAP MARKER. CASL's identification rules require a legal sender name, a mailing
 * !! address and a reachable support contact, and PRD §1.4 puts them in the preferences-page
 * !! footer, checked at the sign-off gate before this form sees real traffic. None of the three
 * !! is invented here, because inventing a business address is worse than lacking one. The form
 * !! renders this marker so a reviewer LOOKING AT THE PAGE sees the hole rather than having to
 * !! know to look for it — the same reason /terms renders its visible draft banner.
 */
export const MISSING_SENDER_IDENTITY =
  'Draft — the legal sender name, mailing address and support contact required by CASL are not ' +
  'filled in yet and must be added before this form is shown to real traffic.';

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
  childrenHelp:
    'Just their age now, in years — no birthdays, no names. We store the year they were born so ' +
    'the ages stay right as they grow up.',
  addChild: 'Add another child',
  removeChild: 'Remove',
  interestsLabel: 'Anything they’re especially into? (optional)',
  interestsHelp: 'Leave this blank to see everything. We’ll widen it automatically on a quiet weekend.',
  submit: 'Text me weekly picks',
  submitting: 'Signing up…',
} as const;

/** What the page says once the signup has been accepted. */
export const SUBMITTED_HEADING = 'Check your phone';
export const SUBMITTED_BODY =
  'We’ve sent you one text. Reply JOIN to confirm, and your first picks arrive Friday around ' +
  '4pm. If it does not arrive in a few minutes, check the number and try again.';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE PREFERENCES / HUB PAGE (PRD §2.4)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// LIVES HERE RATHER THAN IN THE PAGE, for the same reason the signup copy does: this page carries
// the CASL footer and the unsubscribe wording, and both are things a regulator reads. It also
// SHARES `MISSING_SENDER_IDENTITY` and `CARRIER_DISCLOSURES` with the signup form rather than
// restating them — the legal sender name, mailing address and support contact are the same three
// missing facts on both surfaces, and two hand-written copies would be two things to remember to
// fill in.

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
  'You can sign up again any time.';
