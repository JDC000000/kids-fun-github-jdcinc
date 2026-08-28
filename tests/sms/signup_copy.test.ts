// tests/sms/signup_copy.test.ts — the consent wording, and the sparse-area decision.
//
// WHY COPY GETS A TEST AT ALL. `sms_consent.consent_text_version` (migration 0034) is NOT NULL
// and exists so that "which wording did this subscriber agree to?" has an answer a year from now.
// That is only worth something if the required disclosures are actually IN the wording — so the
// four PIPEDA elements PRD §1.3 enumerates are asserted here rather than trusted to survive a
// future edit that was only trying to shorten a sentence.
//
// This form is also intended as the opt-in screenshot for the Twilio Toll-Free Verification
// submission, which makes the carrier-facing lines load-bearing too.
import { describe, expect, it } from 'vitest';
import { isGsm7, nonGsm7Characters } from '@/lib/sms/message';
import { PREFS_STATUS_PENDING, SUBMITTED_BODY } from '@/lib/sms/consent-copy';
import {
  PREFS_UNKNOWN_TOKEN_BODY,
  CARRIER_DISCLOSURES,
  CONSENT_CHECKBOX_TEXT,
  CONSENT_TEXT_VERSION,
  SENDER_IDENTITY,
  SUPPORT_LINE,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
  ACTIVITY_GONE_BODY,
  OUT_OF_AREA_NOTICE,
  PREFERENCES_LINK_LABEL,
  SPARSE_AREA_NOTICE,
  WHAT_HAPPENS_NEXT,
} from '@/lib/sms/consent-copy';
import {
  SPARSE_FALLBACK_REGION_IDS,
  sparseAreaNoticeFor,
  sparseRegionIdsFrom,
} from '@/lib/sms/sparse-areas';
import { SMS_INTEREST_KEYS, SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';

describe('the consent checkbox wording (PRD §1.3)', () => {
  it('names WHAT is collected — all three items', () => {
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/phone number/i);
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/postal code/i);
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/children’s approximate ages/i);
  });

  it('names WHY, and scopes the use to that one purpose', () => {
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/weekly/i);
    // "use them only to" is the purpose-specificity PRD §1.3 relies on to justify ONE checkbox
    // rather than separately bundled consents. Losing the word "only" loses that argument.
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/only to/i);
  });

  it('states it is never sold or shared with advertisers or third parties', () => {
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/never sold or shared/i);
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/advertiser/i);
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/third party/i);
  });

  it('names WHERE to see, change or delete it', () => {
    expect(CONSENT_CHECKBOX_TEXT).toMatch(/see, change or delete/i);
    expect(CONSENT_CHECKBOX_TEXT).toContain(PREFERENCES_LINK_LABEL);
  });

  it('survives the form’s split-and-reassemble render losslessly', () => {
    // SmsSignupForm splits this string on PREFERENCES_LINK_LABEL to emphasise that phrase in
    // place. If the phrase ever appeared twice, or the component reordered the halves, the
    // rendered sentence would stop being the sentence `consent_text_version` stands for.
    const parts = CONSENT_CHECKBOX_TEXT.split(PREFERENCES_LINK_LABEL);
    expect(parts).toHaveLength(2);
    expect(parts[0] + PREFERENCES_LINK_LABEL + parts[1]).toBe(CONSENT_CHECKBOX_TEXT);
  });

  it('has a version stamp that looks like one', () => {
    expect(CONSENT_TEXT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
  });
});

describe('the CASL / double-opt-in copy (PRD §1.4)', () => {
  it('tells the parent to reply JOIN — never YES', () => {
    // YES is a Twilio Advanced Opt-Out keyword and can be intercepted at the carrier layer before
    // our webhook sees it, leaving a subscriber who did everything right stuck at `pending`.
    expect(WHAT_HAPPENS_NEXT).toContain('JOIN');
    expect(WHAT_HAPPENS_NEXT).not.toMatch(/reply yes/i);
  });

  it('carries the real CASL sender identification (Jon-approved 2026-08-26)', () => {
    // These replaced a deliberate gap marker that rendered a visible draft banner while the three
    // facts did not exist. CASL's identification rules require a sender name, a mailing address
    // and a reachable contact on the page linked from every message.
    expect(SENDER_IDENTITY.legalName).toBe('Jon Cartwright');
    expect(SENDER_IDENTITY.operatingAs).toBe('KIDS FUN');
    expect(SENDER_IDENTITY.mailingAddress).toContain('2288 Adanac Street');
    expect(SENDER_IDENTITY.mailingAddress).toContain('Vancouver, BC V5L 2E8');
    expect(SENDER_IDENTITY.mailingAddress).toContain('Canada');
    expect(SENDER_IDENTITY.businessRegistration).toContain('852296375');
    expect(SENDER_IDENTITY.businessRegistration).toMatch(/sole proprietor/i);
  });

  it('writes the support number down exactly ONCE, and derives everything from it', () => {
    // Three surfaces need it (signup footer, preferences footer, the "activity gone" page). A
    // phone number typed three times is a phone number that will eventually be three different
    // numbers, so everything derives from SUPPORT_PHONE_E164.
    expect(SUPPORT_PHONE_E164).toBe('+18778357776');
    // The display form is the same digits, differently punctuated — asserted rather than assumed.
    expect(SUPPORT_PHONE_DISPLAY.replace(/[^\d+]/g, '')).toBe(SUPPORT_PHONE_E164);
    expect(SENDER_IDENTITY.supportPhone).toBe(SUPPORT_PHONE_DISPLAY);
    expect(SUPPORT_LINE).toContain(SUPPORT_PHONE_DISPLAY);
    // And it satisfies migration 0034's E.164 CHECK, like every other number this product holds.
    expect(SUPPORT_PHONE_E164).toMatch(/^\+[1-9][0-9]{7,14}$/);
  });

  it('the support contact is SMS on the SAME number, not an email or a second line', () => {
    // Jon's ruling: a subscriber's whole relationship with this product is over SMS, and an email
    // address would be inventing a channel nobody is watching.
    expect(SUPPORT_LINE).toMatch(/text us/i);
    expect(SUPPORT_LINE).toMatch(/same number/i);
    expect(SUPPORT_LINE).not.toMatch(/@/);
  });
});

describe('the "activity gone" interstitial (PRD §8 Q3)', () => {
  it('is the approved sentence, EXACTLY', () => {
    // Replaced wholesale on 2026-08-28. The previous assertion guarded Jon's own typed words; this
    // guards the Operator's words written under his explicit advance delegation ("YOU WRTIE THE ONE
    // LINE - I APPROVE YOUR WORDS"). Different provenance, same rule: not a reviewer's to polish.
    expect(ACTIVITY_GONE_BODY).toBe('That activity has been cancelled. Sorry about that.');
  });

  it('spells it "cancelled", like every other consumer surface and the status value itself', () => {
    // Survives the rewrite. The detail page renders "Cancelled" / "This occurrence was cancelled.",
    // terms says "cancelled", the CSS tokens are --kf-cancelled-*, and the occurrence status in the
    // database is the string 'cancelled'.
    expect(ACTIVITY_GONE_BODY).toContain('cancelled');
    expect(ACTIVITY_GONE_BODY).not.toMatch(/\bcanceled\b/);
  });

  it('🔴 no longer claims to carry the OLD sentence\'s shape', () => {
    // The previous guard asserted startsWith('Oops,') / 'Let us know…' / endsWith('Keep moving.').
    // Those assertions did not fail by accident — they were replaced because the author authorised
    // a new sentence, which is the one thing that was ever allowed to move them. Asserted in the
    // negative so a partial revert (restoring the old copy while keeping this file) fails loudly.
    expect(ACTIVITY_GONE_BODY).not.toContain('Oops');
    expect(ACTIVITY_GONE_BODY).not.toContain('Keep moving');
  });

  it('no longer carries a support lead-in of its own', () => {
    // "Let us know if you have any other questions" is gone from the copy, which is safe only
    // because the PAGE still renders the support contact as its own paragraph.
    //
    // ⚠ THIS FILE CANNOT ASSERT THAT, AND MUST NOT PRETEND TO. An earlier version of this test
    // added `expect(SUPPORT_LINE).toContain(SUPPORT_PHONE_DISPLAY)` and claimed it proved the
    // route survived. It did not: SUPPORT_LINE is a different constant used on other surfaces,
    // and app/activity-unavailable/page.tsx renders SUPPORT_PHONE_HREF and
    // SENDER_IDENTITY.supportPhone directly. The page could stop rendering support entirely and
    // that assertion would still pass — a test that reads as a guarantee and holds nothing.
    //
    // The real invariant is asserted where it can be, against the RENDERED page:
    //   tests/sms/click_through.test.tsx → "the interstitial the 'gone' outcome redirects to"
    // A copy constant can only speak about the copy constant, so that is all this asserts.
    expect(ACTIVITY_GONE_BODY).not.toMatch(/let us know/i);
  });
});

describe('the carrier-facing disclosures', () => {
  const joined = CARRIER_DISCLOSURES.join(' ');

  it('states message frequency, rates, and how to stop and get help', () => {
    expect(joined).toMatch(/1 message per week/i);
    expect(joined).toMatch(/message and data rates may apply/i);
    expect(joined).toMatch(/reply stop/i);
    expect(joined).toMatch(/reply help/i);
  });

  it('mentions the one-time confirmation message, so "1 per week" is not misread as a cap', () => {
    expect(joined).toMatch(/confirmation/i);
  });
});

describe('the area notices', () => {
  it('warns about a sparse area without claiming it will improve', () => {
    expect(SPARSE_AREA_NOTICE).toMatch(/fewer picks/i);
    // Nothing on this notice may promise coverage is coming — we do not know that.
    expect(SPARSE_AREA_NOTICE).not.toMatch(/soon|shortly|coming/i);
  });

  it('names every covered municipality when rejecting an out-of-area postal', () => {
    for (const name of ['Vancouver', 'North Vancouver', 'West Vancouver', 'Burnaby', 'Richmond']) {
      expect(OUT_OF_AREA_NOTICE).toContain(name);
    }
  });
});

describe('sparseAreaNoticeFor', () => {
  it('warns only for a postal in a measured-sparse municipality', () => {
    expect(sparseAreaNoticeFor('V7V 1A1', ['wvan'])?.regionName).toBe('West Vancouver');
    expect(sparseAreaNoticeFor('V5L 1A1', ['wvan'])).toBeNull(); // Vancouver, well covered
    expect(sparseAreaNoticeFor('V7V 1A1', [])).toBeNull(); // measured, nothing thin
  });

  it('says nothing for an out-of-area postal — that is a rejection, not a warning', () => {
    // "some weeks may have fewer picks" would enormously understate "we can never serve you".
    expect(sparseAreaNoticeFor('V3S 1A1', ['wvan', 'bby'])).toBeNull();
    expect(sparseAreaNoticeFor('', ['wvan'])).toBeNull();
    expect(sparseAreaNoticeFor(null, ['wvan'])).toBeNull();
  });
});

describe('sparseRegionIdsFrom', () => {
  it('distinguishes "measured, nothing thin" from "could not measure"', () => {
    // [] and null must not collapse: treating an unavailable measurement as "nothing is thin"
    // silently withdraws the warning from the exact municipalities it exists for.
    expect(sparseRegionIdsFrom([])).toEqual([]);
    expect(sparseRegionIdsFrom(null)).toBeNull();
    expect(sparseRegionIdsFrom(undefined)).toBeNull();
  });

  it('takes the engine’s own sparse verdict rather than re-deriving a threshold', () => {
    const coverage = [
      { chipId: 'van', regionName: 'Vancouver', activityCount: 900, sparse: false },
      { chipId: 'wvan', regionName: 'West Vancouver', activityCount: 0, sparse: true },
      { chipId: 'bby', regionName: 'Burnaby', activityCount: 2, sparse: true },
    ];
    expect(sparseRegionIdsFrom(coverage)).toEqual(['wvan', 'bby']);
  });

  it('has a static fallback that errs toward warning', () => {
    // Used only when the catalogue is unreachable. Warning a well-covered area is a mild
    // over-warning; going quiet on a thin one costs a signup and then a churn.
    expect([...SPARSE_FALLBACK_REGION_IDS].sort()).toEqual(['bby', 'wvan']);
  });
});

describe('the interest checkboxes', () => {
  it('offers only keys the catalogue actually uses', () => {
    // Every key is a `category.key` from supabase/seeds/categories_tags.sql, which is what
    // ListingRecord.primaryCategoryKey/categoryTags hold — so matchesInterests compares like
    // with like.
    const seeded = new Set([
      'open_gym', 'public_swim', 'skate', 'storytime', 'indoor_play', 'museum_venue',
      'attraction', 'festival_event', 'outdoor_park', 'class_program',
    ]);
    for (const key of SMS_INTEREST_KEYS) expect(seeded.has(key)).toBe(true);
  });

  it('deliberately does NOT offer class_program while registration content is excluded', () => {
    // The selection module inherits includeRegistration:false, so class/lesson/camp titles are
    // dropped before the interest filter runs. Offering this box would offer a near-unmatchable
    // interest. Downstream of PRD §8, which is still open — if Jon includes registration content
    // in the SMS, add it back and delete this test.
    expect(SMS_INTEREST_KEYS).not.toContain('class_program');
  });

  it('has unique keys and a label for each', () => {
    expect(new Set(SMS_INTEREST_KEYS).size).toBe(SMS_INTEREST_KEYS.length);
    for (const option of SMS_INTEREST_OPTIONS) expect(option.label.length).toBeGreaterThan(0);
  });
});

describe("the post-submit page's STOP recovery sentence (PRD §8 Q5, Jon-approved)", () => {
  it("carries Jon's sentence VERBATIM — do not smooth it", () => {
    // Asked to choose between options, he wrote the copy: "please make up that sentence and insert
    // it. Solve that problem. approved". Reproduced exactly, straight apostrophe and all.
    expect(SUBMITTED_BODY).toContain(
      "If you've texted us before and replied STOP, text START to +1 877-835-7776 first to " +
        'turn our texts back on, then try again.'
    );
  });

  it('takes the number from SUPPORT_PHONE_DISPLAY, not a fourth hand-typed copy', () => {
    // The signup footer, the preferences footer and the "activity gone" page all derive from
    // SUPPORT_PHONE_E164. A number typed a fourth time is a number that will eventually be four
    // different numbers.
    expect(SUBMITTED_BODY).toContain(SUPPORT_PHONE_DISPLAY);
    expect(SUPPORT_PHONE_DISPLAY.replace(/[^\d+]/g, '')).toBe(SUPPORT_PHONE_E164);
  });

  it('is UNCONDITIONAL — a constant, not a function of the signup outcome', () => {
    // The security half of the ruling. Showing it only on a 21610 would rebuild, in prose, the
    // exact oracle app/api/sms/signup/route.ts refuses to expose as a field: whether SOMEBODY
    // ELSE'S number is opted out. A `const string` cannot be conditional; that is the point.
    expect(typeof SUBMITTED_BODY).toBe('string');
    // And it still says the two things every reader needs, not only the opted-out one.
    expect(SUBMITTED_BODY).toContain('Reply JOIN to confirm');
    expect(SUBMITTED_BODY).toContain('check the number and try again');
  });

  it('does NOT move CONSENT_TEXT_VERSION — it is not wording anyone agreed to', () => {
    // The version answers "which wording did this subscriber AGREE to". This copy is shown only
    // AFTER submitting, so it cannot be part of that. Bumping would stamp two subscribers with
    // different versions who agreed to identical wording — a false statement in an audit column,
    // not extra safety. See this file's own header for the narrowed rule and PRD v3.9 for the
    // precedent. Pinned so the reasoning is checked rather than remembered.
    expect(CONSENT_TEXT_VERSION).toBe('2026-08-26.v2');
    expect(CONSENT_CHECKBOX_TEXT).not.toContain('texted us before'); // the consent text is untouched
  });
});

describe('the web-page strings that look reusable as SMS copy', () => {
  // WHY THIS BLOCK EXISTS. Round 14 rejected both of these as replies for the START
  // `awaiting_confirmation` case and recorded the reason as "both contain curly apostrophes".
  // Only ONE of them does. The decision was right and the stated reason was half wrong, which is
  // the third time on this branch that copy was described from memory rather than read. These
  // assertions replace the recollection.

  it('SUBMITTED_BODY really would cost double — a curly apostrophe AND an em dash', () => {
    expect(SUBMITTED_BODY).toContain('We\u2019ve');
    expect(isGsm7(SUBMITTED_BODY)).toBe(false);
    // STILL PINNED EXACTLY, not loosened to "contains something non-GSM-7". The em dash arrived
    // with the resubmission sentence (2026-08-28) and this assertion is what made that visible
    // rather than silent, which is the entire job of pinning a set instead of a count. Anything
    // added here should have to come and change this line on purpose.
    expect(nonGsm7Characters(SUBMITTED_BODY)).toEqual(['\u2019', '\u2014']);
  });

  it('PREFS_STATUS_PENDING is GSM-7 SAFE — the encoding objection never applied to it', () => {
    // Pinned in the positive so the wrong reason cannot be re-cited from the round-14 notes.
    expect(PREFS_STATUS_PENDING).not.toContain('\u2019');
    expect(isGsm7(PREFS_STATUS_PENDING)).toBe(true);
  });

  it('neither is sendable anyway, for reasons that hold for both', () => {
    // The real objection, and a better one: PRD §1.4 requires sender identification on every
    // outbound message, and a commercial message needs a free opt-out. These are page copy.
    for (const [name, copy] of [
      ['PREFS_STATUS_PENDING', PREFS_STATUS_PENDING],
      ['SUBMITTED_BODY', SUBMITTED_BODY],
    ] as const) {
      expect(copy.startsWith('KIDS FUN:'), name).toBe(false);
      expect(copy, name).not.toMatch(/reply stop/i);
    }
    // And this one points at a different message than itself: correct on a web page, where the
    // confirmation text is elsewhere; wrong sent AS that text.
    expect(PREFS_STATUS_PENDING).toContain('our confirmation text');
  });
});

describe('the preferences fallback page (V1 testing, round 21)', () => {
  it('tells someone with a broken link that STOP still works', () => {
    // THE FINDING: this page IS the CASL unsubscribe path, and somebody landing on the fallback
    // has just been told their link does not work. For a person trying to stop the texts that
    // reads as a dead end — the one place a broken link could look like a trapped subscription.
    expect(PREFS_UNKNOWN_TOKEN_BODY).toMatch(/replying STOP/i);
    expect(PREFS_UNKNOWN_TOKEN_BODY).toMatch(/always works/i);
  });

  it('frames STOP as INDEPENDENT of the link, which is the load-bearing part', () => {
    // Texting STOP never depended on this page: Twilio's Advanced Opt-Out handles it at the
    // carrier layer before our webhook runs. The sentence has to say the backup works EVEN IF
    // this link does not, or it just reads as one more thing to try.
    expect(PREFS_UNKNOWN_TOKEN_BODY).toMatch(/even if this link does not/i);
  });

  it('still offers the way back in, for the other kind of visitor', () => {
    // The same page serves someone whose subscription was deleted and who wants to return. The
    // opt-out reminder must not crowd that out.
    expect(PREFS_UNKNOWN_TOKEN_BODY).toMatch(/sign up again/i);
  });
});

describe('the resubmission warning (post-launch item 1)', () => {
  // An active subscriber who signs up again is reset to `pending` and stops receiving texts until
  // they reply JOIN. Nothing said so, which made a working product look like a broken one.

  it('tells a resubmitter the status resets AND what to do about it', () => {
    expect(SUBMITTED_BODY).toContain('resubmitting will reset your status to pending');
    // The remedy matters more than the warning: a warning with no action is just bad news.
    expect(SUBMITTED_BODY).toContain('reply JOIN again');
  });

  it('🔴 is UNCONDITIONAL — one string, so it CANNOT become an oracle', () => {
    // The security property, asserted structurally rather than trusted to review. Because the
    // sentence is part of a single exported constant with no interpolation of subscriber state,
    // there is no branch anywhere that could show it only to numbers it actually happened to —
    // which would let the form answer "is SOMEONE ELSE'S number already active?".
    expect(typeof SUBMITTED_BODY).toBe('string');
    // No placeholder survived into the shipped string.
    expect(SUBMITTED_BODY).not.toMatch(/\$\{|\[\[|%s|undefined|\bnull\b/);
  });

  it('does NOT mention the discarded preferences — Jon scoped it to the status reset', () => {
    // A resubmission also replaces saved preferences. Deliberately unmentioned: the status reset
    // is the loss with a remedy attached, and a second one with no remedy would only make the
    // sentence longer and vaguer. If this ever needs to change it is a scope decision, not copy
    // polish, so it fails here first.
    expect(SUBMITTED_BODY).not.toMatch(/preference|interests|replaced|overwrit/i);
  });

  it('is not accidentally sendable as a text', () => {
    // Same guard the rest of this file applies to page copy: no sender ID, no opt-out, and now
    // demonstrably not GSM-7 clean.
    expect(SUBMITTED_BODY.startsWith('KIDS FUN:')).toBe(false);
    expect(isGsm7(SUBMITTED_BODY)).toBe(false);
  });
});
