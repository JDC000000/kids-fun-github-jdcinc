// tests/sms/instant_picks_message.test.ts — the on-demand digest's body (plan v2.0 task 4).
//
// ═══ WHAT THIS FILE IS ACTUALLY DEFENDING ═══
// Not the wording — that is PROVISIONAL and awaits Jon's approval (see the block above
// `INSTANT_PICKS_MESSAGE_LINE` in lib/sms/message.ts). What is defended is the ARITHMETIC around
// it, because that is the part a copy edit breaks silently:
//
//   • a second segment doubles the cost of EVERY press, forever, and nothing fails;
//   • one non-GSM-7 character — an en dash, a curly apostrophe, an ellipsis — drops the whole
//     message to UCS-2 at 70 characters per segment, which here means 3 segments instead of 1;
//   • the link is 67 characters, not the ~18 the PRD's illustrative `kidsfun.ca/u/8fJ2q` examples
//     suggest, so anyone budgeting from those budgets wrong by ~49.
//
// ⚠ IF A FUTURE COPY CHANGE TURNS THIS RED, THE ANSWER IS A SHORTER SENTENCE, NOT A BIGGER
// EXPECTED NUMBER. That is the whole reason the numbers are pinned rather than reported.
import { describe, expect, it } from 'vitest';
import {
  INSTANT_PICKS_MESSAGE_LINE,
  assertGsm7Safe,
  estimateSegments,
  renderInstantPicksMessage,
} from '@/lib/sms/message';
import { PRODUCTION_ORIGIN } from '@/lib/sms/config';

/**
 * The REAL link width, built the way the real one is built rather than typed as a guess.
 *
 * `preferencesUrl()` returns `${siteUrl()}/u/${token}` and the token is a 43-character base64url
 * HMAC (lib/sms/preferences-token.ts). Composing it from `PRODUCTION_ORIGIN` means a domain change
 * moves this measurement with it instead of leaving a test that passes against a stale budget.
 */
const REAL_TOKEN = 'a'.repeat(43);
const REAL_LINK = `${PRODUCTION_ORIGIN}/u/${REAL_TOKEN}`;

describe('instant picks message · the segment budget', () => {
  it('the link this is budgeted against is the real 67-character one', () => {
    // The premise of every number below. If this moves, the headroom below moves with it.
    expect(REAL_LINK).toHaveLength(67);
  });

  it('is ONE segment against the real link', () => {
    const message = renderInstantPicksMessage({ preferencesUrl: REAL_LINK });
    expect(message.segments).toBe(1);
    expect(message.encoding).toBe('GSM-7');
  });

  it('has real headroom rather than passing by a character', () => {
    // A one-segment message that is 159 septets long is one word from being two, and "it passes"
    // would not have said so. 160 is the GSM-7 single-segment ceiling.
    const message = renderInstantPicksMessage({ preferencesUrl: REAL_LINK });
    expect(message.characters).toBeLessThanOrEqual(150);
    expect(160 - message.characters).toBeGreaterThanOrEqual(10);
  });

  it('is GSM-7 safe — the wall, not the estimate', () => {
    expect(() => assertGsm7Safe(renderInstantPicksMessage({ preferencesUrl: REAL_LINK }).body))
      .not.toThrow();
    // And the sentence on its own, so a diff that only touches the copy constant fails HERE with
    // the offending character named, rather than at the composed-body assertion above.
    expect(() => assertGsm7Safe(INSTANT_PICKS_MESSAGE_LINE)).not.toThrow();
  });

  it('an inline activity list would NOT fit — the measurement behind Jon’s D3 ruling', () => {
    // Not a test of our code; a test of the premise the shape rests on. Three names and venues
    // appended to this body cross into a second segment, i.e. double the bill on every press. If
    // this ever goes green-by-accident (because the sentence shrank enormously), the ruling is
    // still the ruling — but somebody should know the arithmetic changed.
    const withList = renderInstantPicksMessage({ preferencesUrl: REAL_LINK }).body +
      '\nSplash Time (Trout Lake CC)\nToddler Gym (Hillcrest CC)\nLego Club (Mount Pleasant CC)';
    expect(estimateSegments(withList).segments).toBeGreaterThan(1);
  });
});

describe('instant picks message · what the body must contain', () => {
  const body = renderInstantPicksMessage({ preferencesUrl: REAL_LINK }).body;

  it('carries sender identification and a working opt-out — both CASL §1.4 requirements', () => {
    expect(body.startsWith('KIDS FUN:')).toBe(true);
    expect(body).toContain('Reply STOP to end');
  });

  it('carries the preferences link, which is the entire payload', () => {
    // This link is simultaneously the CASL unsubscribe path, the PIPEDA access mechanism and the
    // only actionable thing in the message. A body that rendered without it must not be sent, and
    // `loadInstantPicksSendSubscriber` refuses a row with no token for exactly this reason.
    expect(body).toContain(REAL_LINK);
  });

  it('puts the link at the start of its own line, so handsets linkify it', () => {
    expect(body.split('\n').some((line) => line === REAL_LINK)).toBe(true);
  });

  it('names no activity, no venue, no age and no area', () => {
    // Jon's D3 ruling is short-text-plus-link. The renderer takes no picks and no subscriber data
    // at all, so this is structurally true — asserted anyway, because "add the top pick's name,
    // it's friendlier" is the edit that would quietly make the message personal data AND two
    // segments in the same commit.
    expect(renderInstantPicksMessage.length).toBe(1);
    const [, ...rest] = body.split('\n');
    expect(rest.join('\n')).toBe(`${REAL_LINK}\nReply STOP to end`);
  });

  it('does not promise the SAME list — the link reopens the page, D2/L1', () => {
    // Nothing is persisted, so the second press may legitimately return a different list. Copy
    // that said "here it is again" would be a false sentence about a feature that is
    // render-and-discard by design.
    expect(body.toLowerCase()).not.toMatch(/same list|again below|as shown|the list you/);
  });
});
