// tests/sms/form_a11y.test.ts — the ARIA attributes an errored field carries.
//
// V1 testing found `aria-invalid` missing across EVERY error state on the signup form. The fields
// already pointed at their error with `aria-describedby` and the error node already had
// `role="alert"`, so a screen reader read the message but never announced that the field the user
// was standing in was the broken one.
//
// The rule lives in a helper rather than in four hand-rolled ternaries — which is both why it
// could go missing from all four at once, and why it is testable at all: the form's error state
// only exists after a submit event, and this repo's vitest runs in a `node` environment with no
// DOM library, so a rendered-markup test cannot reach it.
import { describe, expect, it } from 'vitest';
import { fieldA11y } from '@/lib/sms/form-a11y';

const IDS = { errorId: 'kf-sms-postal-err', helpId: 'kf-sms-postal-help' };

describe('fieldA11y', () => {
  it('marks the errored field invalid and points at its error', () => {
    expect(fieldA11y('postal', 'postal', IDS)).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'kf-sms-postal-err',
    });
  });

  it('OMITS aria-invalid entirely on a field that is fine', () => {
    // `undefined`, not `false` — React drops an undefined attribute, so a clean form announces
    // nothing. `aria-invalid="false"` on every control is technically correct and practically
    // noise: it describes the state of things the user has not touched.
    const clean = fieldA11y('postal', 'phone', IDS);
    expect(clean['aria-invalid']).toBeUndefined();
    expect(Object.values(clean)).not.toContain(false);
  });

  it('keeps pointing at help text once the error clears', () => {
    // The description must not vanish when the error does.
    expect(fieldA11y('postal', undefined, IDS)['aria-describedby']).toBe('kf-sms-postal-help');
    expect(fieldA11y('postal', 'phone', IDS)['aria-describedby']).toBe('kf-sms-postal-help');
  });

  it('describes nothing when a field has neither an error nor help text', () => {
    // The consent checkbox and the child rows have no permanent help text of their own.
    expect(fieldA11y('consent', undefined, { errorId: 'kf-sms-consent-err' })).toEqual({
      'aria-invalid': undefined,
      'aria-describedby': undefined,
    });
  });

  it('marks EVERY field the error names — which is how one fieldset error marks every row', () => {
    // The children error belongs to the fieldset, not to one row. There is no way to know which
    // age was rejected, so every row carries it; guessing one would be worse than marking the group.
    const ids = { errorId: 'kf-sms-children-err' };
    for (const row of [0, 1, 2]) {
      const a11y = fieldA11y('children', 'children', ids);
      expect(a11y['aria-invalid'], `row ${row}`).toBe(true);
      expect(a11y['aria-describedby'], `row ${row}`).toBe('kf-sms-children-err');
    }
  });

  it('is exhaustive over the form\'s four errorable fields', () => {
    // If a fifth field ever gains an error, this is where the omission shows up.
    for (const field of ['phone', 'postal', 'children', 'consent']) {
      expect(fieldA11y(field, field, { errorId: `kf-sms-${field}-err` })['aria-invalid'], field).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// FOCUS MANAGEMENT ON A FAILED SUBMIT (/sms/start)
//
// role="alert" already announces the messages, so the gap this closes is not "are they told" but
// "what happens next": without it focus stays on the submit button and a keyboard or screen-reader
// user has to hunt back up the form for the field to fix.
//
// WHAT THIS FILE CAN AND CANNOT GUARD, stated plainly. vitest runs `node` here with no DOM, so the
// behaviour itself — focus actually landing on #kf-start-postal — CANNOT be asserted in this lane;
// the header comment above says the same about aria-invalid. It was verified manually in a real
// browser against a production build:
//   submit empty            -> document.activeElement === #kf-start-postal, 4 alerts rendered
//   type into phone after   -> activeElement STAYS #kf-start-phone, phone error clears (4 -> 3)
//   submit again            -> focus returns to #kf-start-postal
// What IS guarded below is the one design property whose loss would be silent and would make the
// feature actively worse than not having it.
describe('start form: focus moves to the first problem, and only on submit', () => {
  const src = require('node:fs').readFileSync(
    'app/sms/start/_components/StartForm.tsx',
    'utf8'
  ) as string;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const effect = code.slice(code.indexOf('useEffect('), code.indexOf('const errorFor'));

  it('🔴 the focus effect does NOT key on `errors` — that would steal focus mid-typing', () => {
    // THE REGRESSION THIS EXISTS FOR. clearFieldError() calls setErrors as the parent types, so an
    // effect keyed on `errors` re-runs on every keystroke that fixes a field and yanks focus back
    // to the first invalid control — out of the field they are currently in. That is worse than no
    // focus management at all, and it would pass every other check: the errors still render, the
    // announcements still fire, and the initial focus still lands correctly.
    expect(effect).toMatch(/\}, \[errorSeq\]\)/);
    expect(effect).not.toMatch(/\}, \[errors\]\)/);
  });

  it('🔴 the sequence is bumped on every path that sets errors from a submit', () => {
    // Three: local validation failure, a non-ok API response, and a network throw. Miss one and
    // focus silently stops moving for that class of failure only — the network case is the easiest
    // to forget and the hardest to notice, since it needs a failing request to observe.
    // Five: three on the main form (local validation, non-ok response, network throw) and two on
    // the waitlist form, which lives INSIDE the same <form> and so is reached by the same effect.
    // The waitlist path was found by this test failing — it has the identical gap and would have
    // left the page half-fixed, with no way for a later reader to tell whether that was a decision
    // or an oversight.
    const submit = code.slice(code.indexOf('async function submitWaitlist'), code.indexOf('if (waitlistDone)'));
    expect(submit.match(/setErrorSeq\(/g) ?? []).toHaveLength(5);
  });

  it('🔴 both error paragraphs are programmatically focusable', () => {
    // The interests error has no aria-invalid control to land on, so the message itself is the
    // fallback target; tabIndex={-1} makes it focusable without putting it in the tab order.
    // Without this the fallback silently does nothing.
    const paras = code.match(/className="kf-start__error"[^>]*role="alert"[^>]*/g) ?? [];
    expect(paras.length).toBeGreaterThanOrEqual(2);
    for (const p of paras) expect(p).toMatch(/tabIndex=\{-1\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE CHILD-COUNT CAP SAYS SO (user-testing rec #4, 2026-09-02).
// Hiding the "add another child" button at MAX_CHILDREN is correct and, alone, is a control
// vanishing mid-interaction with no explanation. /sms/signup already rendered this notice; like
// the cap guard itself, it did not carry over when /sms/start was written.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('start form: reaching the child cap is explained, not just enforced', () => {
  const code = (require('node:fs').readFileSync('app/sms/start/_components/StartForm.tsx', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('🔴 renders the notice on the NEGATED guard, so it appears exactly when the button does not', () => {
    // The pair is the point: `canAddAnotherChild` shows the button, `!canAddAnotherChild` shows
    // the notice. If these ever drift apart there is a state with neither — which is the defect
    // this fixes — or one with both, which is incoherent.
    expect(code).toMatch(/\{!canAddAnotherChild\(children\.length\) && \(/);
    expect(code).toMatch(/\{canAddAnotherChild\(children\.length\) && \(/);
    expect(code).toMatch(/maxChildrenNotice\(MAX_CHILDREN\)/);
  });

  it('🔴 announces it as status, not alert — a limit is not an error', () => {
    const block = code.slice(code.indexOf('!canAddAnotherChild'), code.indexOf('!canAddAnotherChild') + 220);
    expect(block).toContain('role="status"');
    expect(block).not.toContain('role="alert"');
  });

  it('🔴 takes the number from MAX_CHILDREN, never a literal — the validator owns the limit', () => {
    // A hardcoded 8 in the copy is how the message eventually says something the server does not
    // enforce. Same reasoning the cap guard above already records for itself.
    expect(code).not.toMatch(/maxChildrenNotice\(\s*\d+\s*\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// BLUR-TIME VALIDATION (user-testing rec #2/#3, built 2026-09-03).
// The recommendations claimed no client-side validation existed. It did, and it worked — the
// reports were an artifact of submit clicks that never landed on a below-fold button. The REAL
// gap, once that was discounted, is that the first signal arrives only at submit.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('start form: fields report themselves on blur, without nagging or grabbing focus', () => {
  const raw = require('node:fs').readFileSync('app/sms/start/_components/StartForm.tsx', 'utf8') as string;
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = code.slice(code.indexOf('function validateOnBlur'), code.indexOf('const err = ('));

  it('🔴 does NOT bump errorSeq — blur must not move the caret', () => {
    // errorSeq drives the focus effect. Bumping it here would drag focus to the first invalid
    // field every time you left ANY field, which is worse than the gap this closes. This is the
    // one mistake that would still look correct in a screenshot.
    expect(fn).not.toMatch(/setErrorSeq/);
  });

  it('🔴 returns early on an empty field — tabbing through is not an error', () => {
    expect(fn).toMatch(/if \(raw\.trim\(\)\.length === 0\) return;/);
  });

  it('🔴 reuses parseSmsSignupBody rather than a second regex', () => {
    // A client-side pattern is a second definition of "valid", and the day it drifts the field
    // goes green for something the API rejects. One validator, asked about one field.
    expect(fn).toMatch(/parseSmsSignupBody\(body\(\)/);
    expect(fn).not.toMatch(/RegExp|\.test\(|\/\^/);
  });

  it('🔴 touches only the blurred field, never the whole error set', () => {
    // setErrors(parsed.errors) here would light up consent and children too, the instant you
    // left the postal box — reporting problems for fields the parent has not reached yet.
    expect(fn).toMatch(/withoutFieldError\(cur, field\)/);
    expect(fn).not.toMatch(/setErrors\(parsed\.errors\)/);
  });

  it('both fields are actually wired to it', () => {
    expect(code).toMatch(/onBlur=\{\(\) => validateOnBlur\('postal'\)\}/);
    expect(code).toMatch(/onBlur=\{\(\) => validateOnBlur\('phone'\)\}/);
  });
});
