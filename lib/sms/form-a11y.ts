// lib/sms/form-a11y.ts — the accessibility attributes an errored form field carries.
//
// DRAFT (SMS pivot). Pure: a field name and the current error in, ARIA attributes out. Extracted
// in round 21 when V1 testing found `aria-invalid` missing across every error state on the signup
// form — the fields already pointed at their error with `aria-describedby` and the error node
// already had `role="alert"`, so a screen reader read the message but never announced that the
// field the user was standing in was the broken one.
//
// A HELPER RATHER THAN A FOURTH HAND-ROLLED TERNARY. The same conditional was written out four
// times in the form, once per field, which is how one of them ends up subtly different from the
// others — and it is the reason `aria-invalid` could go missing from all four without anything
// noticing. It is also why this is testable at all: the form's error state only exists after a
// submit event, and this repo's vitest runs in a `node` environment with no DOM library, so a
// rendered-markup test cannot reach it. The rule can be tested even where the render cannot.

/** Which control an error belongs to. Mirrors `SmsSignupField` in lib/sms/signup-validate.ts. */
export type ErroredField = string | undefined;

export interface FieldA11y {
  /**
   * `true` when this field is the errored one, and ABSENT otherwise.
   *
   * `undefined` rather than `false` on purpose: React omits an undefined attribute entirely, so a
   * clean form announces nothing. `aria-invalid="false"` on every field is technically correct and
   * practically noise — it tells a screen reader user about the state of controls they have not
   * touched.
   */
  'aria-invalid': true | undefined;
  /**
   * The error node when this field is errored, its help text otherwise, or absent when it has
   * neither. Fields with permanent help text keep pointing at it so the description does not
   * vanish once the error clears.
   */
  'aria-describedby': string | undefined;
}

/**
 * The ARIA pair for one field.
 *
 * `errorId` and `helpId` are passed rather than derived, because the form's ids are its own
 * business and two of its fields (consent, children) have no help text to fall back to.
 */
export function fieldA11y(
  field: string,
  erroredField: ErroredField,
  ids: { errorId: string; helpId?: string }
): FieldA11y {
  const errored = erroredField === field;
  return {
    'aria-invalid': errored || undefined,
    'aria-describedby': errored ? ids.errorId : ids.helpId,
  };
}
