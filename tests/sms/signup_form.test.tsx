// tests/sms/signup_form.test.tsx — what the signup form actually renders.
//
// `renderToStaticMarkup`, the same idiom the rest of this repo's component tests use (no
// @testing-library dependency). That renders the INITIAL state, which is exactly the state that
// matters most here: a screenshot of this form is intended as opt-in evidence for the Twilio
// Toll-Free Verification submission, and "unchecked by default" is a claim about the initial
// render specifically.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SmsSignupForm, withoutFieldError } from '@/app/sms/signup/_components/SmsSignupForm';
import {
  CONSENT_CHECKBOX_TEXT,
  FIELD_COPY,
  SPARSE_AREA_NOTICE,
  WHAT_HAPPENS_NEXT,
} from '@/lib/sms/consent-copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';

/** react-dom/server escapes text; compare against the same escaping. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const html = renderToStaticMarkup(<SmsSignupForm sparseRegionIds={['wvan', 'bby']} />);

describe('the consent control', () => {
  it('is UNCHECKED on first render — the whole basis of express opt-in consent', () => {
    // PRD §1.3/§1.4: unchecked-by-default, express. A pre-ticked box is not consent under CASL,
    // and it is the single thing a Toll-Free Verification reviewer looks hardest at in an opt-in
    // screenshot. React omits the attribute entirely when a checkbox is unchecked.
    const consentInput = html.match(/<input[^>]*name="consent"[^>]*>/)?.[0];
    expect(consentInput).toBeTruthy();
    expect(consentInput).not.toContain('checked');
  });

  it('renders the consent sentence VERBATIM, split and reassembled without loss', () => {
    // The component splits this string to emphasise "preferences page" in place. If it ever
    // reordered or dropped a clause, `consent_text_version` would point at wording no parent saw.
    const withoutTags = html.replace(/<[^>]+>/g, '');
    expect(withoutTags).toContain(esc(CONSENT_CHECKBOX_TEXT));
  });

  it('does not disable the submit button while consent is unticked', () => {
    // Deliberate: a dead button explains nothing. Submitting unticked produces a real, focused
    // error instead. (The validator rejects it — tests/sms/signup_validate.test.ts.)
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(submit).toBeTruthy();
    expect(submit).not.toContain('disabled');
  });
});

describe('the fields', () => {
  it('renders phone, postal and one child row, each labelled', () => {
    expect(html).toContain('for="kf-sms-phone"');
    expect(html).toContain('for="kf-sms-postal"');
    expect(html).toContain(esc(FIELD_COPY.phoneLabel));
    expect(html).toContain(esc(FIELD_COPY.postalLabel));
    expect(html).toContain(esc(FIELD_COPY.childrenLabel));
    // Exactly one child row initially, and no Remove control for it — one child is the minimum
    // a signup can mean, so the last row must not be removable.
    expect(html.match(/name="phone"/g) ?? []).toHaveLength(1);
    expect(html).toContain('Child 1');
    expect(html).not.toContain('Child 2');
    expect(html).not.toContain(esc(FIELD_COPY.removeChild));
    expect(html).toContain(esc(FIELD_COPY.addChild));
  });

  it('asks for an AGE, not a birthday — and says why the year is stored', () => {
    // PRD §1.2: one plain "how old now" number per child, no birthdate, no month. The helper text
    // is what makes the stored birth-year honest rather than a surprise.
    expect(html).toContain(esc(FIELD_COPY.childrenHelp));
    // A bounded whole-number field, 0–18 — not a date picker and not a free text box.
    expect(html).toMatch(/type="number"/);
    expect(html).toMatch(/min="0"/);
    expect(html).toMatch(/max="18"/);
    // NO control anywhere on this form may collect a date or a birth field. Asserted on the
    // INPUTS rather than on the prose, because the helper copy legitimately mentions birthdays —
    // it is the sentence promising we do not ask for one ("no birthdays, no names").
    expect(html).not.toMatch(/type="date"/);
    expect(html).not.toMatch(/<input[^>]*(name|id)="[^"]*birth/i);
    expect(html).not.toMatch(/type="month"/);
    // And the promise itself is on the page. The WORDING changed in round 21 (V1 testing read
    // "no birthdays, no names... we store the year they were born" as briefly self-contradictory),
    // so this asserts the PROMISE rather than one phrasing of it: whatever the sentence says, it
    // still has to rule out both a birthday and a name.
    // Reworded 2026-09-01 to 'No birthdays or names needed.' Same promise, asserted as the two
    // things it must still rule out rather than as one phrasing of them.
    expect(html.toLowerCase()).toContain('no birthdays or names needed');
    // Explains BEFORE it reassures — the birth year is accounted for by the time the promise
    // lands, which is what stopped it reading as a contradiction.
    expect(FIELD_COPY.childrenHelp.indexOf('birth year')).toBeLessThan(
      FIELD_COPY.childrenHelp.indexOf('No birthdays')
    );
    // What is COLLECTED is unchanged: an age now, converted to a year. Not a new promise.
    expect(FIELD_COPY.childrenHelp.toLowerCase()).toContain('age in years');
  });

  it('renders every interest checkbox, all unchecked, and says they are optional', () => {
    for (const option of SMS_INTEREST_OPTIONS) {
      expect(html).toContain(`value="${option.key}"`);
      expect(html).toContain(esc(option.label));
    }
    expect(html).toContain(esc(FIELD_COPY.interestsLabel));
    expect(html).toMatch(/optional/i);
    const interestInputs = html.match(/<input[^>]*name="interests"[^>]*>/g) ?? [];
    expect(interestInputs).toHaveLength(SMS_INTEREST_OPTIONS.length);
    for (const input of interestInputs) expect(input).not.toContain('checked');
  });

  it('does NOT offer a "classes and programs" interest', () => {
    // See lib/sms/interests.ts — it would be near-unmatchable while includeRegistration is false.
    expect(html).not.toContain('value="class_program"');
  });
});

describe('what the form tells a parent before they submit', () => {
  it('explains the double opt-in — one text, reply JOIN', () => {
    expect(html).toContain(esc(WHAT_HAPPENS_NEXT));
    expect(html).toContain('JOIN');
  });

  it('shows NO sparse-area notice before a postal code has been typed', () => {
    // The warning is a response to what they entered. Showing it on an empty field would tell
    // every parent in Vancouver that their area is thin.
    expect(html).not.toContain(esc(SPARSE_AREA_NOTICE));
  });

  it('leaks no internal identifier to the reader', () => {
    // Same rule as the map-fallback copy (BUG-007): env-var names and internal ids never reach a
    // parent. This page is also going in front of a carrier reviewer.
    expect(html).not.toContain('SMS_SIGNUP_ENABLED');
    expect(html).not.toContain('SMS_SENDING_ENABLED');
    expect(html).not.toContain('sms_consent');
    expect(html).not.toContain('TWILIO');
  });
});

describe('V1 testing fixes (round 21)', () => {
  it('marks NOTHING invalid when there is no error', () => {
    // `aria-invalid={... || undefined}` rather than `{false}`: React omits an undefined attribute
    // entirely, so a clean form does not announce every untouched control as checked-and-valid.
    expect(html).not.toMatch(/aria-invalid/);
  });

  it('every field still points at its help text when nothing is wrong', () => {
    // The describedby fallback, which the helper must not have dropped while adding aria-invalid.
    expect(html).toContain('aria-describedby="kf-sms-phone-help"');
    expect(html).toContain('aria-describedby="kf-sms-postal-help"');
  });
});


describe('the stale field error (post-launch item 5)', () => {
  // THE BUG: errors were cleared only at the top of `submit`, so correcting a rejected postal code
  // left "we don't cover that area" sitting under a covered one until a second submit. It read as
  // intermittent because resubmitting fixes it — whether anyone ever saw it depended only on
  // whether they read the page before pressing again.
  const errs = [
    { field: 'postal' as const, message: 'out of area' },
    { field: 'phone' as const, message: 'bad phone' },
    { message: 'network' },
  ];

  it('drops only the corrected field, leaving the other errors standing', () => {
    // "Show all errors at once" is Jon's ruling (PRD §8 item 2). Fixing one field must not clear
    // the list, or a parent fixes the postal code and believes they are done.
    const after = withoutFieldError(errs, 'postal');
    expect(after.map((e) => e.field)).toEqual(['phone', undefined]);
  });

  it('leaves the general error alone — it is not owned by any field', () => {
    // A network failure is not answered by editing a postal code, so nothing a parent types
    // should make it disappear.
    expect(withoutFieldError(errs, 'postal').some((e) => !e.field)).toBe(true);
    expect(withoutFieldError(errs, 'phone').some((e) => !e.field)).toBe(true);
  });

  it('🔴 returns the SAME array when the field has no error — not an equal one', () => {
    // Identity, asserted with toBe rather than toEqual. This is what stops a re-render on every
    // keystroke in a field that has nothing wrong with it, which is every field, most of the time.
    // A `.filter()` that always allocates would satisfy every other assertion in this block.
    expect(withoutFieldError(errs, 'children')).toBe(errs);
    expect(withoutFieldError([], 'postal')).toEqual([]);
  });

  it('is not fooled into clearing a DIFFERENT field with a similar name', () => {
    expect(withoutFieldError(errs, 'phone').map((e) => e.field)).toEqual(['postal', undefined]);
  });
});
