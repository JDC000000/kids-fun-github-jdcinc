// tests/sms/instant_picks_copy.test.ts — the Instant Picks strings (plan v1.0 task 5, v2.0 task 7).
//
// ═══ THE RULE THIS ENFORCES IS A COMPLIANCE RULE, NOT A STYLE ONE — AND IT IS NOW NARROWER ═══
// The preferences page renders `MESSAGE_FREQUENCY_DISCLOSURE` in its carrier disclosure block, a
// few centimetres below the Instant Picks button. That line is what a Toll-Free Verification
// reviewer checks the messaging behaviour against.
//
// ⚠ UPDATED 2026-09-14 — TASK 1 HAS LANDED. The disclosure now reads "1 message per week, a
// one-time confirmation message, and up to 3 more messages per day — but only when you request
// them" (Jon's wording verbatim, PRD v3.23) and CONSENT_TEXT_VERSION is v8. So ONE of the two
// reasons group A could not mention texting is gone: the button no longer contradicts the
// sentence below it.
//
// THE SECOND REASON STILL STANDS, AND IT IS WHY THIS FILE DID NOT CHANGE ITS GROUP A RULE:
// INSTANT_PICKS_SMS_SEND_ENABLED (gate 1 of three, lib/sms/instant-picks-send.ts) is still OFF,
// so a press still sends nothing. Group A promising a text would promise something the gates
// refuse to deliver — no longer false-and-contradictory, but still simply false.
// ⇒ WHEN THE OPERATOR FLIPS THAT FLAG, REVISIT GROUP A. It is Jon's copy call, made in that pass.
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
import { readFileSync } from 'node:fs';
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
    // SURFACE 1 OF 3 — the preferences page. Pinned to Jon's approved string, not to a loose
    // /1 message per week/ match, which the SUPERSEDED wording also satisfied: that regex passed
    // both before and after task 1 and so proved nothing about which sentence is on the page.
    expect(MESSAGE_FREQUENCY_DISCLOSURE).toBe(
      '1 message per week, a one-time confirmation message, and up to 3 more messages per day — but only when you request them.'
    );
  });

  it.each(ALL_STRINGS)('%s — uses no sending verb', (line) => {
    expect(line).not.toMatch(/\b(text|texts|texting|sms|message|messages|send|sends|sending|sent)\b/i);
  });

  it('the button says SHOW, not SEND', () => {
    expect(PREFS_INSTANT_BUTTON.toLowerCase()).toMatch(/show/);
  });
});

describe('SURFACE 1 OF 3 — the preferences page puts that disclosure on screen', () => {
  // The Instant Picks button lives on this page, so this is the surface where the new "up to 3
  // more messages per day" clause has to be true of observable behaviour. The disclosure block is
  // in the page's async server component (app/u/[preferencesToken]/page.tsx), which needs a token
  // and a database view to render — so this asserts the SOURCE renders from the shared constant
  // rather than from a retyped string. That is the property that matters: a retyped copy is the
  // one that can drift from the version stamped on live consent rows.
  const page = readFileSync(
    new URL('../../app/u/[preferencesToken]/page.tsx', import.meta.url),
    'utf8'
  );

  it('renders CARRIER_DISCLOSURES from the constant, never retyped', () => {
    expect(page).toContain('CARRIER_DISCLOSURES.map');
    expect(page).toMatch(/import \{[\s\S]*?CARRIER_DISCLOSURES[\s\S]*?\} from '@\/lib\/sms\/consent-copy'/);
  });

  it('does not contain a hand-typed copy of either the old or the new frequency sentence', () => {
    expect(page).not.toContain('1 message per week');
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
  it('the consent version now clears the gate — so the disclosure describes these lines', () => {
    // ⚠ THE PREMISE OF THIS GROUP CHANGED ON 2026-09-14, exactly as the old assertion predicted.
    // These sentences DO say "sent"/"send", which group A is forbidden from doing. That used to be
    // defensible because NOBODY could reach them (live version v7, below the v8 gate). Now a v8
    // subscriber clears gate 2 — and that is fine, because the wording they agreed to explicitly
    // includes "up to 3 more messages per day — but only when you request them". The lines can
    // now be reached, and the disclosure they sit beside describes them. That is the intended
    // end state, not a regression.
    expect(consentVersionSerial(CONSENT_TEXT_VERSION)!).toBeGreaterThanOrEqual(
      INSTANT_PICKS_MIN_CONSENT_SERIAL
    );
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
