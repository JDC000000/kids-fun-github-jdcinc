// tests/sms/instant_picks_copy.test.ts — the Instant Picks strings (plan v1.0, task 5).
//
// ═══ THE RULE THIS ENFORCES IS A COMPLIANCE RULE, NOT A STYLE ONE ═══
// The preferences page renders `MESSAGE_FREQUENCY_DISCLOSURE` — "1 message per week, plus a
// one-time confirmation message" — in its carrier disclosure block, a few centimetres below the
// Instant Picks button. That line is what a Toll-Free Verification reviewer checks the messaging
// behaviour against. So no string on this button may imply a text is coming: the contradiction
// would be visible in a single screenshot of the page.
//
// Page-only was decided for exactly that reason rather than as a preference, and copy is where the
// decision would erode first — "we'll send you the list" is an easy sentence to write and reads as
// friendlier than the truth. Hence a test rather than a comment.
import { describe, expect, it } from 'vitest';
import {
  CARRIER_DISCLOSURES,
  MESSAGE_FREQUENCY_DISCLOSURE,
  PREFS_INSTANT_BODY,
  PREFS_INSTANT_BUTTON,
  PREFS_INSTANT_EMPTY,
  PREFS_INSTANT_HEADING,
  PREFS_INSTANT_INTERESTS_DROPPED,
  PREFS_INSTANT_LOADING,
  PREFS_INSTANT_THROTTLED,
  PREFS_INSTANT_UNAVAILABLE,
  PREFS_INSTANT_WIDENED,
  instantPicksResultLine,
} from '@/lib/sms/consent-copy';

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
