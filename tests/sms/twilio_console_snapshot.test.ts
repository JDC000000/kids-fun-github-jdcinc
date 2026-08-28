// tests/sms/twilio_console_snapshot.test.ts — the out-of-repo compliance surface, pinned.
//
// The HELP auto-reply lives in the Twilio console, not here (PRD v3.10 — no API for it, Jon set it
// by hand). So this repo makes claims about a string it cannot read. These assertions cannot check
// the console — nothing here can — but they DO catch the failure mode that is actually likely:
// somebody changes one of OUR facts (the support number, the brand tag) and the console text,
// which nobody can see from here, silently stops matching.
import { describe, expect, it } from 'vitest';
import {
  TWILIO_HELP_RESPONSE,
  TWILIO_HELP_RESPONSE_SNAPSHOT_DATE,
  TWILIO_CONSOLE_RECHECK_TRIGGERS,
} from '@/lib/sms/twilio-console-snapshot';
import { SUPPORT_PHONE_DISPLAY, SUPPORT_PHONE_E164 } from '@/lib/sms/consent-copy';
import { assertGsm7Safe, estimateSegments } from '@/lib/sms/message';

describe('the Twilio console HELP reply', () => {
  it('is the exact text Jon recorded configuring (PRD v3.10)', () => {
    expect(TWILIO_HELP_RESPONSE).toBe(
      'KIDS FUN: Reply STOP to unsubscribe. Contact us at +1 877-835-7776 with questions. ' +
        'Msg&data rates may apply.'
    );
  });

  it('quotes the SAME support number this repo derives everywhere else', () => {
    // THE DRIFT THIS FILE EXISTS FOR. Change SUPPORT_PHONE_E164 and every surface in the repo
    // follows automatically — except the console, which no code here can reach. This is the test
    // that turns that silent divergence into a failing build.
    expect(TWILIO_HELP_RESPONSE).toContain(SUPPORT_PHONE_DISPLAY);
    expect(SUPPORT_PHONE_DISPLAY.replace(/[^\d+]/g, '')).toBe(SUPPORT_PHONE_E164);
  });

  it('carries what CTIA expects of a HELP reply', () => {
    // Program identity, a support contact, the opt-out keyword, and the rates disclosure.
    expect(TWILIO_HELP_RESPONSE.startsWith('KIDS FUN:')).toBe(true);
    expect(TWILIO_HELP_RESPONSE).toMatch(/reply stop/i);
    expect(TWILIO_HELP_RESPONSE).toMatch(/msg&data rates may apply/i);
    expect(TWILIO_HELP_RESPONSE).toMatch(/contact us/i);
  });

  it('is GSM-7 safe and one segment, like every message this product sends', () => {
    // It is configured elsewhere, but a subscriber cannot tell the difference — a curly apostrophe
    // in the console would cost real money on every HELP just as it would here.
    assertGsm7Safe(TWILIO_HELP_RESPONSE);
    const estimate = estimateSegments(TWILIO_HELP_RESPONSE);
    expect(estimate.encoding).toBe('GSM-7');
    expect(estimate.segments).toBe(1);
  });

  it('says when it was taken and when to look again', () => {
    // A snapshot with no date is a snapshot nobody can reason about the staleness of.
    expect(TWILIO_HELP_RESPONSE_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(TWILIO_CONSOLE_RECHECK_TRIGGERS.length).toBeGreaterThan(0);
    expect(TWILIO_CONSOLE_RECHECK_TRIGGERS.join(' ')).toMatch(/toll-free verification/i);
  });
});
