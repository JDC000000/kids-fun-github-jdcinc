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
