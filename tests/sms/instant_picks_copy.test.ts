// tests/sms/instant_picks_copy.test.ts — the Instant Picks strings (plan v1.0 task 5, v2.0 task 7).
//
// ═══ THE RULE THIS ENFORCES IS A COMPLIANCE RULE, NOT A STYLE ONE — AND IT IS NOW NARROWER ═══
// The preferences page renders `MESSAGE_FREQUENCY_DISCLOSURE` — "1 message per week, plus a
// one-time confirmation message" — in its carrier disclosure block, a few centimetres below the
// Instant Picks button. That line is what a Toll-Free Verification reviewer checks the messaging
// behaviour against.
//
// ⚠ THE FEATURE IS NO LONGER PAGE-ONLY: Jon ruled the button also sends a text (PRD v3.22). But
// THE DISCLOSURE HAS NOT CHANGED YET — rewriting it, and bumping CONSENT_TEXT_VERSION with it, is
// task 1, HELD pending the TFV decision (plan v2.0 §6 option B). So the original rule still holds
// over everything that is ALWAYS on the page, and it holds for a second reason on top of the
// first: while the send path is held, a button promising a text would be promising something the
// three gates in lib/sms/instant-picks-send.ts refuse to deliver. False AND contradictory.
//
// ═══ TWO GROUPS, GOVERNED DIFFERENTLY ═══
//   GROUP A — always on the page. NO SENDING VERBS, for the reasons above.
//   GROUP B — the send-outcome lines. Rendered ONLY when the server reports a send was actually
//     attempted for this subscriber, which requires `consent_text_version >= v8` — i.e. they saw
//     the NEW disclosure and agreed to it. They CANNOT appear beside wording they contradict,
//     because the only way to see them is to have agreed to wording that includes them.
//
// ⚠ DO NOT "TIDY" THESE INTO ONE LIST. The split IS the rule; a single list would either forbid
// group B from ever saying "text" or permit group A to say it.
import { describe, expect, it } from 'vitest';
import {
  CARRIER_DISCLOSURES,
  CONSENT_TEXT_VERSION,
  MESSAGE_FREQUENCY_DISCLOSURE,
  PREFS_INSTANT_BODY,
  PREFS_INSTANT_BUTTON,
  PREFS_INSTANT_EMPTY,
  PREFS_INSTANT_HEADING,
  PREFS_INSTANT_INTERESTS_DROPPED,
  PREFS_INSTANT_LOADING,
  PREFS_INSTANT_SEND_DISABLED,
  PREFS_INSTANT_SEND_FAILED,
  PREFS_INSTANT_SEND_THROTTLED,
  PREFS_INSTANT_SENT,
  PREFS_INSTANT_THROTTLED,
  PREFS_INSTANT_UNAVAILABLE,
  PREFS_INSTANT_WIDENED,
  consentVersionSerial,
  instantPicksResultLine,
} from '@/lib/sms/consent-copy';
import { INSTANT_PICKS_MIN_CONSENT_SERIAL } from '@/lib/sms/instant-picks-send';

/** GROUP B — only reachable after a real send attempt. See the header. */
const SEND_OUTCOME_STRINGS = [
  PREFS_INSTANT_SENT,
  PREFS_INSTANT_SEND_THROTTLED,
  PREFS_INSTANT_SEND_FAILED,
  PREFS_INSTANT_SEND_DISABLED,
];

/** GROUP A — always on the page. */
const ALL_STRINGS = [
  PREFS_INSTANT_HEADING,
  PREFS_INSTANT_BODY,
  PREFS_INSTANT_BUTTON,
  PREFS_INSTANT_LOADING,
  PREFS_INSTANT_WIDENED,
  PREFS_INSTANT_INTERESTS_DROPPED,
  PREFS_INSTANT_EMPTY,
  PREFS_INSTANT_UNAVAILABLE,
  PREFS_INSTANT_THROTTLED,
  instantPicksResultLine(7, 'East Van'),
  instantPicksResultLine(1, null),
];

describe('instant picks copy · nothing may imply a message will be sent', () => {
  it('the disclosure this rule protects is still on the page', () => {
    // If this ever goes red the premise has changed, and the rule below should be RE-ARGUED rather
    // than deleted — not silently dropped because its anchor moved.
    expect(CARRIER_DISCLOSURES).toContain(MESSAGE_FREQUENCY_DISCLOSURE);
    expect(MESSAGE_FREQUENCY_DISCLOSURE).toMatch(/1 message per week/);
  });

  it.each(ALL_STRINGS)('%s — uses no sending verb', (line) => {
    expect(line).not.toMatch(/\b(text|texts|texting|sms|message|messages|send|sends|sending|sent)\b/i);
  });

  it('the button says SHOW, not SEND', () => {
    expect(PREFS_INSTANT_BUTTON.toLowerCase()).toMatch(/show/);
  });
});

describe('instant picks copy · the four states say four different things', () => {
  it('“nothing on” and “cannot check” are not the same sentence', () => {
    // The distinction the route and the selector both work to preserve. Collapsing it in the copy
    // would throw it away at the last possible moment.
    expect(PREFS_INSTANT_EMPTY).not.toBe(PREFS_INSTANT_UNAVAILABLE);
    expect(PREFS_INSTANT_UNAVAILABLE.toLowerCase()).toMatch(/can.t check/);
  });

  it('the throttle line names no limit and no number', () => {
    expect(PREFS_INSTANT_THROTTLED).not.toMatch(/\d/);
    expect(PREFS_INSTANT_THROTTLED.toLowerCase()).not.toMatch(/limit|day|minute|too many/);
  });

  it('every state is a whole sentence, not a fragment or a code', () => {
    for (const line of ALL_STRINGS) {
      expect(line.length).toBeGreaterThan(3);
      expect(line).not.toMatch(/_|\bERR|\bnull\b|undefined/);
    }
  });
});

describe('instant picks copy · the result line', () => {
  it('is singular for one and plural for more', () => {
    expect(instantPicksResultLine(1, 'East Van')).toMatch(/\b1 thing\b/);
    expect(instantPicksResultLine(7, 'East Van')).toMatch(/\b7 things\b/);
  });

  it('names the area when there is one and stays grammatical when there is not', () => {
    expect(instantPicksResultLine(7, 'East Van')).toContain('East Van');
    expect(instantPicksResultLine(7, null)).not.toMatch(/near\s*\./);
    expect(instantPicksResultLine(7, null)).toMatch(/\.$/);
  });

  it('says WHICH weekend it is talking about', () => {
    // The window is the weekend, not today, and the copy has to carry that or the list reads as a
    // broken "what's on now". See lib/sms/instant-picks.ts.
    expect(instantPicksResultLine(7, 'East Van')).toMatch(/weekend/i);
    expect(PREFS_INSTANT_BUTTON).toMatch(/weekend/i);
  });
});

describe('instant picks copy · GROUP B — the send-outcome lines', () => {
  it('cannot be shown to anyone today, which is what makes them safe to write now', () => {
    // ⚠ THE PREMISE OF THIS WHOLE GROUP. These sentences DO say "sent"/"send", which group A is
    // forbidden from doing, and that is only defensible because the server cannot report a send
    // outcome for a subscriber below consent v8 — and the live version is v7. If this assertion
    // ever flips, task 1 has landed: the disclosure now describes these texts, and GROUP A should
    // be REVISITED in that same pass rather than left silently cautious.
    expect(consentVersionSerial(CONSENT_TEXT_VERSION)!).toBeLessThan(INSTANT_PICKS_MIN_CONSENT_SERIAL);
  });

  it.each(SEND_OUTCOME_STRINGS)('%s — is a whole sentence, not a code', (line) => {
    expect(line.length).toBeGreaterThan(10);
    expect(line).not.toMatch(/_|\bERR|\bnull\b|undefined/);
    expect(line).toMatch(/[.!]$/);
  });

  it('the three non-success lines all say the list is still there', () => {
    // The entire argument for letting the send fail closed (plan §4.3) is that the parent still
    // gets what they pressed the button for. Copy that only reported the failure would make a
    // working answer read as a broken one.
    for (const line of [
      PREFS_INSTANT_SEND_THROTTLED,
      PREFS_INSTANT_SEND_FAILED,
      PREFS_INSTANT_SEND_DISABLED,
    ]) {
      expect(line.toLowerCase()).toMatch(/below/);
    }
  });

  it('the throttled line names no limit and no number, like its page-path twin', () => {
    expect(PREFS_INSTANT_SEND_THROTTLED).not.toMatch(/\d/);
    expect(PREFS_INSTANT_SEND_THROTTLED.toLowerCase()).not.toMatch(/limit|per day|too many/);
  });

  it('they say four different things', () => {
    expect(new Set(SEND_OUTCOME_STRINGS).size).toBe(SEND_OUTCOME_STRINGS.length);
  });

  it('none of them leaks an environment variable or an internal state name', () => {
    for (const line of SEND_OUTCOME_STRINGS) {
      expect(line).not.toMatch(/ENABLED|flag|throttle|Twilio|consent_text_version|v8/i);
    }
  });

  it('and they are NOT in group A — the split is the rule', () => {
    // A future edit that appended these to ALL_STRINGS would make the group A assertion fail
    // rather than silently weaken it, but this says the intent out loud.
    for (const line of SEND_OUTCOME_STRINGS) {
      expect(ALL_STRINGS).not.toContain(line);
    }
  });
});
