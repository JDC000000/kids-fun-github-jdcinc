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
 *
 * ── HISTORY, BECAUSE A VERSION NUMBER NOBODY CAN RESOLVE PROVES NOTHING ─────────────────
 * Migration 0034 exists to prove "WHICH WORDING they agreed to". That is only answerable while
 * each version can be resolved back to its text. With one version ever issued, reading the
 * constant answered it; from the second onwards it does not, and rows stamped with a retired
 * version point at wording held nowhere but git.
 *
 * So each entry names the commit whose state of THIS FILE is that version, in full — a pointer
 * rather than a copy, because the version covers every string here (checkbox, labels, help text,
 * disclosures, sender identity), and a partial transcription would be worse than none.
 *
 *   2026-08-26.v2  →  this file as of commit 22acf7f (the commit immediately before the bump
 *                     below). Retired 2026-08-29.
 *   2026-08-29.v3  →  the copywriter rewrite below replaced it. Retired 2026-09-01.
 *   2026-09-01.v4  →  the max-children notice below was added to the signup form. Retired
 *                     2026-09-01.
 *   2026-09-01.v5  →  the max-children notice was added to the signup form. Retired
 *                     2026-09-01, when the consent checkbox itself was corrected.
 *   2026-09-01.v6  →  this file as of commit e85bf68 (the commit immediately before this
 *                     bump). Retired 2026-09-03.
 *   2026-09-03.v7  →  current. Jon's product-wide "always SMS, never text" ruling reached
 *                     two strings inside this version's scope: the consent checkbox and
 *                     SUPPORT_LINE.
 *
 * ⚠ THIS LIST IS NOT A DATE CUTOFF, and an audit query written as though it were will be wrong.
 * `signup-store.ts` RE-STAMPS `consent_text_version` on resubmit, deliberately — a resubmitting
 * parent agrees to whatever wording the form showed them at that moment. So a subscriber reads as
 * v2 until they next touch the form, whenever that is, and "everyone before 2026-08-29 is v2" is
 * false. The retirement dates above say when a version stopped being ISSUED, not when it stopped
 * appearing on rows.
 *   Recorded here rather than only beside the upsert that does it: the person who needs this is
 *   resolving "what did this subscriber agree to", and that question is asked at this list.
 *
 * >>> BUMPING THIS? ADD THE OUTGOING VERSION TO THE LIST ABOVE IN THE SAME COMMIT. <<<
 */
export const CONSENT_TEXT_VERSION = '2026-09-03.v7';

/** What the page is, in one line, above the fields. */
export const FORM_HEADING = 'Get kids’ weekend activities by text';

export const FORM_INTRO =
  'One text every Friday afternoon: 5–10 activities for your kids that weekend, near you and ' +
  'right for their ages. Free.';

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
/*
 * ═══ PROVENANCE: NOT THE COPYWRITER-DRAFT PATTERN THE OTHER ELEVEN STRINGS CARRY ═══
 * Recorded the way ACTIVITY_GONE_BODY's block below records its own, and for the same reason —
 * "the author typed this" and "the author delegated this and pre-approved it" carry different
 * weight for anyone deciding later whether they may touch it, and a comment that blurs them
 * misdescribes the sentence for years.
 *
 * The other eleven strings from the 2026-09-01 copywriter rewrite are Jon-approved copywriter
 * drafts. THIS ONE IS NOT, and saying "Jon approved the copywriter draft" here would be false:
 *
 *   1. The copywriter's draft read '…and kids’ approximate ages TO CHOOSE those activities…',
 *      which drops the word "only". PRD §1.3 leans on that purpose-EXCLUSIVITY to justify ONE
 *      checkbox rather than separately bundled consents, and tests/sms/signup_copy.test.ts pins
 *      it with that reasoning spelled out. So the draft was HELD rather than applied — deleting
 *      a guard that protects a compliance argument is a product-owner decision, not a copy edit.
 *   2. The implementer proposed '…to choose ONLY those activities…'. That was WRONG, and the
 *      near-miss is worth keeping: it contains the word "only" and reads as a fix, but it scopes
 *      "only" to WHICH ACTIVITIES rather than to the DATA'S PURPOSE — a different guarantee, and
 *      not the one §1.3 needs. It also fails /only to/ outright. A reviewer skimming for "does it
 *      say only?" would have passed it.
 *   3. The OPERATOR wrote the sentence below. Jon approved it directly.
 *
 * ⇒ Operator-authored, Jon-approved, recorded as his — the same mechanism as the Q5
 *   STOP-recovery sentence and ACTIVITY_GONE_BODY, which is why this is that documented pattern's
 *   second use rather than a third pattern. It is NOT the copywriter's wording.
 *
 * THE FOUR §1.3 DISCLOSURES ARE STILL ALL PRESENT — do not delete one to shorten the sentence:
 *   1. WHAT is collected — phone number, postal code, kids' approximate ages.
 *   2. WHY, and ONLY why — "using them only to choose those activities".
 *   3. That it is NEVER shared with advertisers or anyone else.
 *   4. WHERE to see, change or delete it — the preferences page, named.
 */
export const CONSENT_CHECKBOX_TEXT =
  'Yes, send me activities for my kids by SMS. I agree KIDS FUN can store my phone number, postal ' +
  'code and kids’ approximate ages, using them only to choose those activities — never sold ' +
  'or shared with advertisers or anyone else. I can view, change or delete this anytime on my ' +
  'preferences page (linked in every message).';

/** Where clause 4's "preferences page" points. Linked from the checkbox label itself. */
export const PREFERENCES_LINK_LABEL = 'preferences page';

/**
 * What happens immediately after submit — the double opt-in, stated before they submit rather
 * than sprung on them afterwards (PRD §1.4: JOIN, not YES, because Twilio's Advanced Opt-Out
 * intercepts YES at the carrier layer before our webhook ever sees it).
 */
export const WHAT_HAPPENS_NEXT =
  'We’ll text you once to confirm. Reply JOIN and you’re in — your first activities land the ' +
  'next Friday around 4pm.';

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
/**
 * The frequency statement, pulled out under its own name because it is the ONE line in this list
 * that is not true on every surface that shows the list. It describes the weekly SUBSCRIPTION.
 * Someone who is only being offered the area waitlist is not signing up for that and will receive
 * a single notification, if we ever reach their area at all. See `carrierDisclosuresFor`.
 */
export const MESSAGE_FREQUENCY_DISCLOSURE =
  '1 message per week, plus a one-time confirmation message.';

export const CARRIER_DISCLOSURES: readonly string[] = [
  MESSAGE_FREQUENCY_DISCLOSURE,
  'Message and data rates may apply.',
  'Reply STOP at any time to unsubscribe. Reply HELP for help.',
];

/**
 * THE DISCLOSURES THAT APPLY on a surface only offering the area waitlist (Jon, 2026-08-31).
 *
 * Removes the frequency line and NOTHING ELSE. That precision is the whole point of this function
 * existing rather than the caller wrapping the block in a condition:
 *
 *   - 'Message and data rates may apply.'  is still true — the waitlist notification is still SMS.
 *   - 'Reply STOP ... Reply HELP ...'      is still true, and on the waitlist state of /sms/start
 *                                          it is the ONLY place the page says how to opt out.
 *
 * Suppressing the whole block to hide one wrong sentence would therefore take the opt-out
 * instruction off the exact screen where somebody is handing over their number — and would quietly
 * undo the STOP handling that was added for waitlist rows specifically. One line is wrong here;
 * one line comes out.
 *
 * NO `CONSENT_TEXT_VERSION` BUMP accompanies this. That constant records which wording a stored
 * `sms_consent` row agreed to, and this state never creates one: it writes an `sms_area_waitlist`
 * row stamped with `WAITLIST_CONSENT_VERSION` instead. Bumping it would re-version every real
 * subscriber's consent to describe a screen they never saw.
 */
export function carrierDisclosuresFor(waitlistOnly: boolean): readonly string[] {
  if (!waitlistOnly) return CARRIER_DISCLOSURES;
  return CARRIER_DISCLOSURES.filter((line) => line !== MESSAGE_FREQUENCY_DISCLOSURE);
}

/**
 * THE LEGAL FOOTER, AS STRUCTURE RATHER THAN AS A PARAGRAPH (Jon, 2026-09-01).
 *
 * Jon approved one flowing block of footer text in place of the old lead-in + address block +
 * bulleted disclosure list. This returns it as PARTS, and the deliberate choice is that it does
 * not return a string.
 *
 * ═══ WHY NOT ONE STRING, WHICH IS WHAT WAS ASKED FOR ═══
 * Two things on this page must survive being "one flowing paragraph", and both die the moment the
 * paragraph becomes a single opaque value:
 *
 *   the support number   must stay a real `tel:` link. A parent reading this on the phone they
 *                        are signing up with taps it. Flattened into prose it is just characters.
 *   Privacy / Terms      must stay real anchors, for the same reason.
 *
 * And a third, structural: `carrierDisclosuresFor` filters the frequency sentence OUT by exact
 * value for the waitlist surface. A pre-joined string has nothing left to filter, so the waitlist
 * page would either keep a sentence that is false there or need its own hand-maintained copy —
 * which is the "quiet divergence between surfaces" this was explicitly asked not to become.
 *
 * So the flowing READING is produced by joining these parts with spaces, and the structure that
 * makes the links and the filter possible stays underneath it. Presentation changed; the data did
 * not.
 */
export interface LegalFooterParts {
  /** "Sent by …, operating as … — <address>. <registration>." */
  identity: string;
  /** Split around `SENDER_IDENTITY.supportPhone` so the caller can wrap it in a tel: anchor. */
  support: string;
  /** The carrier disclosures that apply here, already filtered for the surface. */
  disclosures: readonly string[];
}

export function legalFooterParts(waitlistOnly: boolean): LegalFooterParts {
  return {
    identity:
      `Sent by ${SENDER_IDENTITY.legalName}, operating as ${SENDER_IDENTITY.operatingAs} — ` +
      `${SENDER_IDENTITY.mailingAddress}. ${SENDER_IDENTITY.businessRegistration}.`,
    support: SUPPORT_LINE,
    disclosures: carrierDisclosuresFor(waitlistOnly),
  };
}

/** The summary label for the collapsed footer disclosure. */
export const LEGAL_FOOTER_SUMMARY = 'Legal & support info';

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

/** `tel:` href for the support number, so a phone can dial it from a tap. */
export const SUPPORT_PHONE_HREF = `tel:${SUPPORT_PHONE_E164}`;

/**
 * `sms:` href for the same number, for links whose LABEL invites a message rather than a call.
 *
 * ═══ WHY A SECOND CONSTANT AND NOT A CHANGE TO THE ONE ABOVE ═══
 * SUPPORT_PHONE_HREF has four call sites. Three render the bare number inside a CASL sender-
 * identification footer (/u, /sms/start, /sms/signup), where a dialable number is the correct
 * and expected behaviour. Only app/activity-unavailable invites a message. Repointing the shared
 * constant would silently convert three phone links into message links to fix one.
 *
 * NO CONSENT_TEXT_VERSION BUMP: that version records the wording a subscriber AGREES TO. An href
 * is not wording and appears in no consent sentence — same reasoning that already applies to
 * SUPPORT_PHONE_HREF sitting in this file un-versioned.
 *
 * `sms:+1...` with the E.164 number is the standard form (RFC 5724). On a device with no SMS
 * handler the link simply does nothing, which is the documented behaviour and deliberately not
 * worked around.
 */
export const SUPPORT_SMS_HREF = `sms:${SUPPORT_PHONE_E164}`;

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
export const SUPPORT_LINE = `Support: ${SUPPORT_PHONE_DISPLAY} (same number the SMS comes from).`;

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
  // NOT "Canadian": normalizePhoneE164 accepts any valid NANP number by design, and said so in
  // its own comment while this line claimed otherwise. Corrected 2026-08-29 alongside the error
  // message (22acf7f) — this was the more prominent half of the same false claim, since every
  // visitor reads the help text and only a failing visitor sees the error.
  //   THIS CHANGE IS WHY CONSENT_TEXT_VERSION MOVED: this file's own rule counts help text around
  //   the consent act as wording a subscriber agrees to.
  phoneHelp: 'Your 10-digit mobile number — no account or password needed.',
  postalLabel: 'Postal code',
  postalHelp:
    'Finds activities near you. We only store the postal code, never your exact location.',
  childrenLabel: 'How old are your kids?',
  // Reworded in round 21 after V1 testing read it as briefly self-contradictory: "no birthdays"
  // followed immediately by "we store the year they were born" lands as a contradiction until the
  // reader works out that a YEAR is not a BIRTHDAY. Same meaning, same consent posture, same data
  // collected — the sentence now explains before it reassures, instead of the other way round.
  childrenHelp:
    'Just their age in years — we convert it to a birth year so it stays right as they grow. ' +
    'No birthdays or names needed.',
  addChild: '+ Add a child',
  removeChild: 'Remove',
  interestsLabel: 'What are your kids into? (optional)',
  interestsHelp:
    'Leave blank to see everything — we’ll widen it automatically on a quiet weekend.',
  submit: 'Text me kids’ activities',
  submitting: 'Signing up…',
} as const;

/**
 * Shown IN PLACE OF the "+ Add a child" button once the cap is reached, on both the signup form
 * and the preferences page.
 *
 * The button already disappeared at the cap; nothing explained why, so the control simply vanished
 * mid-task. This says what happened.
 *
 * TAKES THE LIMIT AS AN ARGUMENT rather than importing MAX_CHILDREN, for two reasons: this module
 * is deliberately dependency-free pure data (see the file header), and a hardcoded "8" here would
 * be a second source of truth that stops matching the validator the day anyone changes it. The
 * caller passes the real constant.
 */
export function maxChildrenNotice(max: number): string {
  return `You’ve reached the max — ${max} kids.`;
}

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
/**
 * ═══ AN ARRAY, NOT A STRING — AND EVERY ITEM RENDERS FOR EVERYONE ═══
 * Jon approved this as a bullet list (2026-09-02). It is `readonly string[]` so each bullet is a
 * real <li>, which a screen reader announces as "list, 4 items" and can navigate item by item;
 * one <p> with visual bullet characters would read as a single run-on paragraph.
 *
 * ⚠ ALL FOUR ITEMS ARE UNCONDITIONAL. THIS IS A SECURITY PROPERTY, NOT A COPY CHOICE.
 * Items 3 and 4 describe states — "you replied STOP before", "this number is already signed up" —
 * that the store layer CAN determine (`createPendingSubscriber` returns `wasActive` and
 * `preferencesReplaced`). Rendering either one conditionally would rebuild exactly the oracle
 * app/api/sms/signup/route.ts deliberately refuses to expose: anyone could type a stranger's
 * number and read its prior state off which bullets appeared. A conditional bullet leaks the same
 * fact as a conditional JSON field and is far easier to ship without noticing.
 *   So every item is written to be true and useful for everyone, and costs a first-time signup
 *   three lines it does not need. The store flags stay — correct and useful for diagnostics — but
 *   NOTHING here may branch on them. Restructuring this as a list did not change that.
 *
 * ═══ SCOPE OF ITEM 4: THE STATUS RESET ONLY ═══
 * Jon's earlier ruling, carried forward. A resubmission ALSO replaces saved preferences, and that
 * is deliberately not mentioned: the status reset is the one with an action attached ("reply
 * JOIN"), and a second loss with no remedy only makes the line longer and vaguer.
 *
 * ═══ NO CONSENT_TEXT_VERSION BUMP ═══
 * Checked against this file's own rule rather than assumed, because that rule is loud enough to
 * invite a reflexive bump. Line 24: the version does NOT move for SUBMITTED_BODY. It answers
 * "which wording did this subscriber AGREE TO", and this is shown AFTER submission, so it cannot
 * be part of what was agreed to. Restructuring it changes nothing about that.
 *
 * ═══ "SMS", NOT "TEXT" (Jon, 2026-09-02) ═══
 * Applied across every item, not just the first — the old wording used "text" as both noun and
 * verb ("text START to ...", "turn our texts back on"), so the substitution had to reach the verb
 * forms too, which now read "reply". There is no remaining occurrence of "text" in this constant.
 *
 * NOT SMS COPY, so the punctuation costs nothing on the wire. It does mean these strings carry
 * non-GSM-7 characters; signup_copy.test.ts pins that set exactly, re-derived against this
 * wording rather than carried over.
 */
export const SUBMITTED_BODY: readonly string[] = [
  'We\u2019ve sent you one SMS \u2014 reply JOIN to confirm. Your first picks arrive Friday around 4pm.',
  'Nothing after a few minutes? Double-check your number and try again.',
  `Replied STOP to us before? Reply START to ${SUPPORT_PHONE_DISPLAY} first, then try again.`,
  'Already signed up with this number? Resubmitting resets you to pending \u2014 reply JOIN again to keep your picks coming.',
];

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE PREFERENCES / HUB PAGE (PRD §2.4)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// LIVES HERE RATHER THAN IN THE PAGE, for the same reason the signup copy does: this page carries
// the CASL footer and the unsubscribe wording, and both are things a regulator reads. It also
// SHARES `SENDER_IDENTITY` and `CARRIER_DISCLOSURES` with the signup form rather than restating
// them — the legal sender name, mailing address and support contact are the same facts on both
// surfaces, and two hand-written copies would eventually be two different addresses.

export const PREFS_HEADING = 'Your KIDS FUN SMS';

/** Shown when the subscription is live. */
export const PREFS_STATUS_ACTIVE =
  'You’re getting kids’ activities every Friday afternoon.';

/**
 * Shown when the subscriber has been auto-paused after three empty weeks.
 *
 * Deliberately echoes the pause-notice SMS (lib/sms/message.ts `renderPauseNoticeMessage`) rather
 * than inventing a second explanation: a parent arriving here has just read that text, and being
 * told a different story by the link inside it is how a product stops sounding like one thing.
 */
export const PREFS_STATUS_PAUSED =
  'Your SMS updates are paused — we haven’t found matches near you in a few weeks. ' +
  'Update your area or interests below and save to start them again.';

/** Shown when they are still waiting to reply JOIN. */
export const PREFS_STATUS_PENDING =
  'Almost there — reply JOIN to our confirmation SMS and your kids’ activities will start.';

/** Shown once they have unsubscribed. */
export const PREFS_STATUS_STOPPED = 'You’ve unsubscribed. We’re not sending you anything.';

/** Shown when the 30-day purge has already run and there is nothing left to show or edit. */
export const PREFS_PURGED =
  'Everything we stored about you has been deleted — there’s nothing left here to change.';

export const PREFS_LAST_WEEK_HEADING = 'Last Friday';
export const PREFS_LAST_WEEK_NONE = 'We haven’t sent you an SMS yet.';
export const PREFS_LAST_WEEK_EMPTY =
  'Nothing near your kids matched last week, so we said so rather than padding the list.';

export const PREFS_EDIT_HEADING = 'What we use to find your kids’ activities';

/**
 * The children field's label ON THE PREFERENCES PAGE ONLY (Jon, 2026-09-12, verbatim:
 * "We use your kids age to find relevant activities").
 *
 * ── WHY THIS IS A SEPARATE CONSTANT AND NOT AN EDIT TO `FIELD_COPY.childrenHelp` ──────────
 * `FIELD_COPY` is rendered by THREE surfaces: this page, `/sms/signup` and `/sms/start`. The
 * first is shown only to somebody who has already consented; the other two are the consent act
 * itself. Editing `FIELD_COPY` to satisfy a preferences-page request would therefore have:
 *   1. silently reworded the SIGNUP form, which nobody asked for, and
 *   2. required a CONSENT_TEXT_VERSION bump under this file's own rule ("field labels and help
 *      text around it" MOVES IT), stamping every future subscriber with a new version for a
 *      change made to a different page, and
 *   3. altered the signup form's pixels — which are the opt-in evidence for the Twilio Canadian
 *      Toll-Free Verification submission (see this file's header).
 * Scoping the new wording here keeps the consent artefact and its version untouched. Per the
 * header's own carve-out, preferences-page copy shown after consent does NOT move the version,
 * so this constant is correctly version-free.
 *
 * ⚠ VERBATIM, INCLUDING "kids age". Jon supplied this exact string and the instruction was not
 * to adjust it. Note the rest of this file uses a curly apostrophe for the possessive ("kids’
 * ages", "kids’ activities"); this line has no apostrophe at all. Left as given deliberately —
 * flagged for a copy decision rather than silently corrected, because changing a string a human
 * dictated is not a typo fix.
 *
 * It replaces BOTH halves of what this section used to say (`FIELD_COPY.childrenLabel` +
 * `FIELD_COPY.childrenHelp`), so it is rendered as the fieldset's `<legend>`: the group of age
 * inputs keeps a real accessible name, which simply deleting the label would have cost.
 */
export const PREFS_CHILDREN_LABEL = 'We use your kids age to find relevant activities';
export const PREFS_SAVE = 'Save changes';
export const PREFS_SAVING = 'Saving…';
export const PREFS_SAVED = 'Saved — your next Friday SMS will use these.';

export const PREFS_UNSUBSCRIBE_HEADING = 'Stop the SMS';

/**
 * ⚠ THIS SENTENCE PROMISES A JOB THAT, AS OF 2026-09-01, HAS NO IMPLEMENTATION IN THIS REPO.
 *
 * "Everything we store about you is deleted 30 days later" describes the 30-day post-stop purge:
 * an UPDATE-to-NULL over `sms_consent`'s four personal columns for rows whose `stopped_at` is
 * older than 30 days. The SCHEMA is built for it — nullable personal columns, and
 * `idx_sms_consent_stopped_at` whose own comment calls it "the 30-day post-stop purge sweep".
 *
 * The job is not missing by oversight. 0034's header says so out loud, lines 54-55:
 *   "(The purge JOB itself is out of scope for this migration — the schema just has to make it
 *    expressible, which is what stopped_at and these nullables do.)"
 *
 * WHAT IS ACTUALLY WRONG IS THE HANDOFF. That deferral was never closed, and this consumer-facing
 * sentence went live promising the behaviour in the meantime. Searched 2026-09-01 and found no
 * implementation: nothing NULLs those columns outside tests and the EXPLICIT user-initiated delete
 * (`applyPreferencesChange`, which does work); `PURGEABLE_TABLES` is ['analytics_event',
 * 'correction_report'] and `sms_consent` has no `retained_until` so the generic purge cannot target
 * it; `global_job_schedule` seeds only 'corrections_retention'; the retention run routes and
 * worker/core cover corrections and analytics only.
 *
 * ⚠ CONFIRMED AGAINST PRODUCTION 2026-09-01. This started as an absence claim about the repo,
 * which would have been survivable — 0012 enables pg_cron, so a schedule added via the Supabase
 * dashboard appears in no migration and is invisible from here. The Operator ran it:
 *     SELECT jobname, schedule, command FROM cron.job;   →  ZERO ROWS
 * There is no scheduled purge in production. So this is no longer "we cannot find the job"; it is
 * "the job does not exist", and this sentence is currently telling a person something untrue about
 * their own personal data. That is a PIPEDA question, not a backlog item, and it is live.
 *
 * DO NOT DELETE THIS COMMENT ON THE STRENGTH OF THE SCHEMA OR THE INDEX LOOKING RIGHT — they look
 * right now and did throughout. Delete it when a purge actually runs, and not before.
 *
 * The 90-day never-confirmed purge (a row DELETE, per 0034 lines 56-59, indexed by
 * `idx_sms_consent_pending_since`) appears equally unbuilt and has the same status.
 *
 * Recorded HERE, beside the promise, rather than only in a ticket: this finding was raised three
 * times through relays and dropped three times. The sentence is the thing that has to carry it.
 */
export const PREFS_UNSUBSCRIBE_BODY =
  'You’ll stop getting activities straight away. Everything we store about you is deleted ' +
  '30 days later.';
export const PREFS_UNSUBSCRIBE = 'Unsubscribe';
/**
 * Summary for the collapsed explanation beneath the Unsubscribe button (Jon, 2026-09-12:
 * "STOP THE SMS simplify have an UNSUBSCRIBE button. The details you'll stop getting activities
 * straight away etc can be minimized/hidden/toggle").
 *
 * The body text is NOT removed and NOT conditionally rendered — it stays in the DOM inside a
 * closed <details>, so curl/view-source/archival tooling and assistive tech still reach it. Only
 * what is painted by default changes. That distinction is the same one the legal block on this
 * page relies on, and it is what keeps a CASL-relevant statement disclosed while collapsed.
 */
export const PREFS_UNSUBSCRIBE_DETAILS_SUMMARY = 'What happens when you unsubscribe';
export const PREFS_UNSUBSCRIBED = 'Done — you won’t get any more SMS from us.';

export const PREFS_DELETE_HEADING = 'Delete my data';

/**
 * The delete control's copy states what actually happens, and it is deliberately DIFFERENT from
 * the unsubscribe copy above: unsubscribe stops the texts and lets the ordinary 30-day retention
 * clock run; this erases now.
 *
 * See `decideDelete` in lib/sms/preferences.ts for why immediate rather than 30 days, and for the
 * fact that it is a reading of §1.3's intent that needs confirming.
 *
 * SIMPLIFIED (Jon, 2026-09-12): the body used to end "It can't be undone — you'd have to sign up
 * again from scratch." Dropped, not lost — the two-step confirm control right below this text
 * already says the same thing in the moment it matters ("Yes, delete it all" / "Cancel"), so the
 * body's job is just to state what happens, not to also carry the warning a second time.
 */
export const PREFS_DELETE_BODY =
  'This unsubscribes you and immediately erases your phone number, postal code, kids’ ages and ' +
  'interests.';
export const PREFS_DELETE = 'Delete everything';
/** Summary for the collapsed explanation beneath the Delete button. Same reasoning as
 *  PREFS_UNSUBSCRIBE_DETAILS_SUMMARY above; the two-step confirm is unchanged and still carries
 *  the warning at the moment it matters. */
export const PREFS_DELETE_DETAILS_SUMMARY = 'What gets deleted';
export const PREFS_DELETE_CONFIRM = 'Yes, delete it all';
export const PREFS_DELETE_CANCEL = 'Cancel';
export const PREFS_DELETED = 'Deleted — nothing about you is stored any more.';

/**
 * What an unrecognised token gets.
 *
 * ONE MESSAGE FOR EVERY REASON — never existed, already deleted, mistyped, truncated by a
 * messaging app. Distinguishing them would tell a prober which of their guesses was close, and
 * would tell anyone holding an old link whether that person is still a subscriber. Neither is
 * information we owe, and the second is information about somebody else.
 */
export const PREFS_UNKNOWN_TOKEN_HEADING = 'This link isn’t working';
export const PREFS_UNKNOWN_TOKEN_BODY =
  'It may be incomplete, or belong to a subscription that’s since been deleted. ' +
  'You can sign up again any time. ' +
  // THE INDEPENDENT BACKUP OPT-OUT, added in round 21 after V1 testing. This page is the CASL
  // unsubscribe path, and somebody arriving here has just been told their link does not work —
  // which, for a person trying to stop the texts, reads as a dead end. Texting STOP never depended
  // on this link: it is handled at the carrier layer by Twilio's Advanced Opt-Out before our
  // webhook runs. Saying so costs one sentence and removes the one situation where a broken link
  // could look like a trapped subscription.
  'Trying to stop the SMS? Replying STOP to any message always works, even if this ' +
  'link doesn’t.';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE "ACTIVITY GONE" INTERSTITIAL (PRD §8 Q3, Jon-approved 2026-08-26)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Where a tapped weekly link goes when the token verified but the activity has since been
// archived — a cancelled session, a source that stopped publishing. Round 6 built the distinct
// `occurrence_gone` outcome and sent it to /search because no such page existed; this is that
// page's copy, and the outcome now has somewhere of its own to go.

/**
 * ═══ PROVENANCE CHANGED ON 2026-08-28. READ THIS BEFORE EDITING. ═══
 * These are NOT Jon's typed words any more, and the comment that used to say so would now be
 * false. They are the OPERATOR'S words, written under Jon's explicit advance delegation:
 *
 *     "NO - YOU WRTIE THE ONE LINE - I APPROVE YOUR WORDS"   — Jon, verbatim, typo preserved
 *
 * That is a different thing from the old note and it is written down as a different thing,
 * because "the author typed this" and "the author delegated this and pre-approved it" carry
 * different weight for anyone deciding later whether they may touch it. The answer is the same
 * either way — they may not — but the reason is not, and a comment that overstates who typed a
 * sentence is the kind of thing that survives for years.
 *
 * Same mechanism as the Q5 STOP-recovery sentence above: Operator-authored, Jon-approved,
 * recorded as his. This file now contains both patterns, deliberately.
 *
 * ── THE HISTORY THAT LED HERE, KEPT BECAUSE THE GUARD IS THE POINT ──────────────────────
 * Round 22: V1 testing flagged the first person ("me") as off-voice. The change was correctly
 * REFUSED as a routine copy-polish item, because the sentence was the product owner's own. Jon
 * then changed it himself — "-we APPROVED". A tone note could not move these words; the author
 * could.
 *
 * 2026-08-28, post-launch: Jon raised the page again with two complaints — off-brand tone, and
 * "canceled" vs "cancelled". They were deliberately NOT treated the same way. The spelling was
 * applied (a specific substitution named by the author, and the last consumer-facing "canceled"
 * in a product that says "cancelled" everywhere, including the database status value). The TONE
 * REWRITE WAS REFUSED, on the round-22 precedent: naming a problem is not the act of writing the
 * replacement, and a rewrite drafted by a reviewer would have failed for exactly the reason the
 * "me"/"us" polish failed, however much better it read.
 *   That refusal is what produced this sentence. Asked for his words, Jon delegated authorship
 *   instead — which is the one move that clears the bar without him typing anything. The guard
 *   was not bypassed; it was satisfied.
 *
 * ⚠ THE SPELLING FIX IS SUPERSEDED, NOT LAYERED. The whole sentence was replaced, so ab6b4c3's
 * one-letter change no longer exists as such — "cancelled" survives only because the new sentence
 * happens to use the same word. Do not read the two commits as cumulative.
 *
 * ⚠ AND THE SUPPORT LINE IS NOT LOST. The old sentence carried "Let us know if you have any other
 * questions", which is gone. Nothing is dropped: app/activity-unavailable/page.tsx already renders
 * the support contact as its own paragraph directly beneath this one, so the removed clause was a
 * lead-in to something still on the page, not the only route to it.
 */
export const ACTIVITY_GONE_BODY = 'That activity is not listed any more. Sorry about that.';

/**
 * "Let us know if you have any other questions" needs somewhere to be let known. It points at the
 * SAME support contact as everything else — see SUPPORT_PHONE_E164 for why the number is written
 * down exactly once.
 */
export const ACTIVITY_GONE_HEADING = 'That one is gone';
export const ACTIVITY_GONE_ONWARD = 'See what else is on this weekend';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * THE LINK THAT DID NOT VERIFY — /link-unavailable (mobile audit, 2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * `occurrence_gone` got the copy above and its own page in round 9. `invalid_token` — the OTHER
 * failing outcome, and the one a mangled text message actually produces — was left redirecting to
 * a bare `/search`, where a parent lands on an unfiltered results page with nothing telling them
 * their link failed. FALLBACK_DESTINATION's old comment called that "the honest 'go find something
 * to do' answer"; a mobile audit found it reads as a broken product, which is the same conclusion
 * round 9 reached about sending the GONE outcome there. See lib/sms/click-through.ts.
 *
 * ⚠ AUTHORSHIP — THESE ARE NOT JON'S WORDS AND NOT OPERATOR-UNDER-DELEGATION EITHER ⚠
 * ACTIVITY_GONE_BODY above carries a long note about who may write parent-facing copy on these
 * interstitials, and the answer there was "the author, or someone he explicitly delegated to". No
 * such delegation exists for THIS page: these three strings were drafted by the implementer to
 * close a live defect, and they are marked as such rather than quietly inheriting the approval
 * that sentence earned. THEY ARE A PLACEHOLDER WITH A REAL BAR: they must match the product's
 * voice and must not assert anything false (see below), and Jon may replace them freely — that is
 * the expected next step, not a concession. What they must not do is be left as they are while
 * being described as approved.
 *
 * ═══ WHY IT DOES NOT SAY "EXPIRED", WHICH IS THE OBVIOUS WORD AND IS FALSE ═══
 * These tokens DO NOT EXPIRE. `encodeShortLink` is deterministic over (occurrence short_ref,
 * subscriber short_ref) plus a 20-bit HMAC check — there is no timestamp in the 76 bits and no
 * validity window anywhere in lib/sms/short-link.ts. A token that fails is a token that was never
 * minted, or was altered after it was: truncated by a messaging app, broken across a line by a
 * mail client, retyped by hand, mangled by a link scanner, or forged.
 *   Saying "this link has expired" would invent a mechanism the product does not have — the same
 *   mistake GONE_DESTINATION's comment refuses when it declines to tell a parent whose link was
 *   mangled that an activity was CANCELLED. The honest sentence is that the link did not work and
 *   that links get damaged in transit, which is true of every case above.
 *
 * ═══ AND WHY IT DOES NOT BLAME THE PARENT ═══
 * The overwhelmingly likely cause is a link that lost characters on its way through somebody
 * else's software. "That link didn't work" states what happened without implying they typed it
 * wrong — the same posture as the body above, where a cancelled session is "a fact about the
 * world, not a mistake the reader made" (activity-unavailable.css).
 */
export const LINK_UNAVAILABLE_HEADING = 'That link didn’t work';

/**
 * The body. One sentence on what happened, one on what to do, and no cause invented.
 *
 * "cut short or changed" covers every real case — truncation, a line break, a link scanner
 * rewriting it — without claiming which one. "the original text" is the one action that actually
 * recovers a working link, since the link is still valid if it arrives intact: nothing has
 * expired, so the same link tapped from the real message still resolves.
 */
export const LINK_UNAVAILABLE_BODY =
  'Links in a text can get cut short or changed on the way. ' +
  'Try tapping it again in the original text — it should still work.';

/**
 * The onward step, for when the original text is gone or the link is genuinely dead.
 *
 * ⚠ THE LABEL AND THE LINK HAVE TO AGREE. This says "this weekend", so the page links to
 * `/search?when=weekend` and NOT to a bare `/search`. That is the whole defect this page exists to
 * fix, in miniature: an unfiltered results page is not what "see what's on this weekend" promised,
 * and shipping the explanation while leaving the reader on the same unexplained page would be a
 * fix in name only. See app/link-unavailable/page.tsx.
 */
export const LINK_UNAVAILABLE_ONWARD = 'Or see what’s on this weekend';
