// lib/sms/waitlist-validate.ts — the whole accept/reject surface for an area-waitlist opt-in.
//
// PURE, and the browser calls this directly for the same reason the signup form does: one
// definition of what we accept, so the client and the API can never disagree about who is eligible
// or what an error says.
//
// ⚠ SMALLER THAN parseSmsSignupBody ON PURPOSE. A waitlist opt-in collects a phone number, an area,
// and consent — no ages, no interests, no postal code beyond the FSA. Every field the weekly signup
// asks for is a field this promise does not need, and asking for it anyway would be collecting data
// to support a message we may never send.
import { normalizePhoneE164 } from './signup-validate';
import { classifyPostalCoverage } from './area-coverage';

export interface WaitlistFieldError {
  field?: 'phone' | 'postal' | 'consent';
  message: string;
}

export interface WaitlistEntry {
  /** E.164. */
  phoneNumber: string;
  /** Scenario A — a covered-but-sparse municipality. Exactly one of these two is set. */
  regionChipId: string | null;
  /** Scenario B — the 3-char FSA of an uncovered postal code. */
  areaFsa: string | null;
}

export type WaitlistParseResult =
  | { ok: true; entry: WaitlistEntry }
  | { ok: false; errors: WaitlistFieldError[] };

/**
 * Validate a waitlist opt-in.
 *
 * ⚠ THE AREA IS RE-DERIVED HERE FROM THE POSTAL CODE, NEVER TAKEN FROM THE CALLER. The browser
 * classifies as somebody types so it can offer the right thing, but a client could send any
 * region/FSA pair it liked. Deriving server-side means a caller cannot enrol a number for an area
 * it does not live in — including a COVERED one, which would otherwise be a way to get onto a list
 * for a municipality that is already served.
 *
 * The sparse set must be measured by the caller (lib/sms/sparse-measure.ts), never hardcoded, for
 * the same reason the notice is measured: a municipality that fills out should stop offering a
 * waitlist without anybody editing a list.
 */
export function parseWaitlistBody(
  raw: unknown,
  sparseRegionIds: readonly string[]
): WaitlistParseResult {
  const errors: WaitlistFieldError[] = [];
  const body = (raw ?? {}) as Record<string, unknown>;

  let phoneNumber: string | null = null;
  if (typeof body.phone !== 'string' || body.phone.trim().length === 0) {
    errors.push({ message: 'a mobile number is required', field: 'phone' });
  } else {
    phoneNumber = normalizePhoneE164(body.phone);
    if (!phoneNumber) {
      errors.push({ message: 'that does not look like a 10-digit mobile number', field: 'phone' });
    }
  }

  let regionChipId: string | null = null;
  let areaFsa: string | null = null;
  if (typeof body.postal !== 'string' || body.postal.trim().length === 0) {
    errors.push({ message: 'a postal code is required', field: 'postal' });
  } else {
    const coverage = classifyPostalCoverage(body.postal, sparseRegionIds);
    switch (coverage.kind) {
      case 'sparse':
        regionChipId = coverage.regionId;
        break;
      case 'out_of_area':
        areaFsa = coverage.fsa;
        break;
      case 'covered':
        // Not an error the parent caused, and not something to silently accept either: we serve
        // this area properly, so the honest answer is to send them to the ordinary signup rather
        // than park them on a list for something they can have now.
        errors.push({
          message: 'we already cover your area — you can sign up for the weekly text now',
          field: 'postal',
        });
        break;
      case 'unknown':
        errors.push({ message: 'that does not look like a Canadian postal code', field: 'postal' });
        break;
    }
  }

  // Express consent, checked LAST so a parent learns about their area before being asked to agree
  // to anything — the same ordering Jon ruled for the signup form.
  if (body.consent !== true) {
    errors.push({ message: 'please tick the box so we can text you once', field: 'consent' });
  }

  if (errors.length > 0 || !phoneNumber) return { ok: false, errors };
  return { ok: true, entry: { phoneNumber, regionChipId, areaFsa } };
}
