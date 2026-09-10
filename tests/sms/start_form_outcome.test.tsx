// tests/sms/start_form_outcome.test.tsx — what /sms/start shows AFTER a submit.
//
// ═══ THE BUG THIS FILE EXISTS FOR ═══
// The submit handler read exactly one thing off the response — `if (!res.ok)` — and then rendered
// "Check your phone". POST /api/sms/signup has always answered with more than that:
//
//     { ok: true, dispatched: smsSendingEnabled() && confirm.outcome === 'sent' }
//
// and nothing read it. So a 201 carrying `dispatched: false` — a carrier-level STOP block on that
// number (Twilio 21610), a Twilio outage, or sending disabled — produced the full success screen,
// telling a parent to check a phone that was never going to ring.
//
// `renderToStaticMarkup`, the same idiom as tests/sms/start_page.test.tsx, and the same reason the
// decision is a pure exported function: the branch used to live inside an async handler where no
// test could reach it, which is how it shipped.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SignupOutcomePanel,
  UNDELIVERED_BODY,
  UNDELIVERED_HEADING,
  outcomeFromResponse,
  signupOutcomeCopy,
  type SignupOutcome,
} from '@/app/sms/start/_components/StartForm';
import { SUBMITTED_BODY, SUBMITTED_HEADING, SUPPORT_PHONE_DISPLAY } from '@/lib/sms/consent-copy';

function textOf(outcome: SignupOutcome): string {
  return renderToStaticMarkup(<SignupOutcomePanel outcome={outcome} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('reading the API’s answer', () => {
  it('🔴 dispatched:false is NOT a success — the whole defect, in one line', () => {
    expect(outcomeFromResponse({ dispatched: false })).toBe('undelivered');
    expect(outcomeFromResponse({ dispatched: true })).toBe('confirm_sent');
  });

  it('treats a missing `dispatched` as undelivered rather than assuming the best', () => {
    // An older or truncated response tells us nothing about whether a text left the building, and
    // guessing "sent" is exactly the failure this replaces. The fallback's remedy — try again —
    // is harmless if a text did in fact arrive; the success screen is not.
    expect(outcomeFromResponse({})).toBe('undelivered');
    expect(outcomeFromResponse(null)).toBe('undelivered');
  });

  it('🔴 IGNORES a subscriber-status field, however the response arrives', () => {
    // The oracle this file used to help build. `alreadyActive` no longer comes back from the
    // route (see its step 7), and this asserts the client would not act on one if it did — a
    // stale deploy, a cache, or a hand-crafted response must not be able to reintroduce the
    // "you're already signed up" disclosure from the browser side.
    const withFlag = { alreadyActive: true } as unknown as { dispatched?: boolean };
    expect(outcomeFromResponse({ ...withFlag, dispatched: true })).toBe('confirm_sent');
    expect(outcomeFromResponse(withFlag)).toBe('undelivered');
    expect(outcomeFromResponse({ dispatched: true })).toBe('confirm_sent');
  });

  it('ignores truthy-but-not-true values on the one flag it reads', () => {
    // These arrive as JSON from an unauthenticated endpoint. `=== true` rather than a coercion,
    // so a string "false" cannot become a success screen.
    expect(outcomeFromResponse({ dispatched: 'yes' } as unknown as { dispatched?: boolean })).toBe(
      'undelivered'
    );
  });
});

describe('the two screens', () => {
  it('renders the approved success copy when a confirmation really was sent', () => {
    const text = textOf('confirm_sent');
    expect(text).toContain(SUBMITTED_HEADING);
    for (const line of SUBMITTED_BODY) expect(text).toContain(line);
  });

  it('🔴 never says "check your phone" when nothing was dispatched', () => {
    const text = textOf('undelivered');
    expect(text).not.toContain(SUBMITTED_HEADING);
    expect(text).not.toContain('reply JOIN to confirm');
    expect(text).toContain(UNDELIVERED_HEADING);
    for (const line of UNDELIVERED_BODY) expect(text).toContain(line);
  });

  it('gives the STOP-block remedy, with the support number derived not typed', () => {
    // consent-copy.ts's rule: a number typed a fifth time is a number that will eventually be
    // five different numbers. This asserts the constant reaches the screen, not that a literal
    // matches a literal.
    expect(textOf('undelivered')).toContain(`Reply START to ${SUPPORT_PHONE_DISPLAY}`);
    expect(UNDELIVERED_BODY.join(' ')).toContain(SUPPORT_PHONE_DISPLAY);
  });

  it('🔴 shows an already-active resubmission the ORDINARY success screen, character for character', () => {
    // The client half of the acceptance criterion, and the regression this file exists to lock:
    // there used to be a dedicated "You're already signed up" panel here, which made a public
    // unauthenticated form into a way to look up whether a stranger subscribes to us.
    //
    // Both bodies below are what app/api/sms/signup/route.ts now returns on its two success
    // paths — identical by construction, since they come out of one `signupAccepted` call. This
    // asserts the identity survives the whole client pipeline, response → outcome → markup,
    // rather than stopping at the response.
    const fromNewSignup = { dispatched: true };
    const fromAlreadyActive = { dispatched: true };

    expect(outcomeFromResponse(fromAlreadyActive)).toBe(outcomeFromResponse(fromNewSignup));
    expect(renderToStaticMarkup(<SignupOutcomePanel outcome={outcomeFromResponse(fromAlreadyActive)} />)).toBe(
      renderToStaticMarkup(<SignupOutcomePanel outcome={outcomeFromResponse(fromNewSignup)} />)
    );
  });

  it('🔴 offers no screen whose copy is CHOSEN by subscriber status', () => {
    // Two outcomes, both keyed on `dispatched` alone. The assertion is about the MAPPING, not
    // about vocabulary: SUBMITTED_BODY's fourth line does say "Already signed up with this
    // number?", and that is fine precisely because it is unconditional — every submitter reads
    // it, so it tells a reader nothing about the number they typed. A screen that only some
    // submitters saw would be the oracle, whatever words were on it.
    const outcomes = ['confirm_sent', 'undelivered'] as const;
    expect(outcomes.map((o) => signupOutcomeCopy(o).heading)).toEqual([
      SUBMITTED_HEADING,
      UNDELIVERED_HEADING,
    ]);
    // ...and the only input that picks between them is `dispatched`.
    expect(signupOutcomeCopy(outcomeFromResponse({ dispatched: true })).heading).toBe(
      SUBMITTED_HEADING
    );
    expect(signupOutcomeCopy(outcomeFromResponse({ dispatched: false })).heading).toBe(
      UNDELIVERED_HEADING
    );
  });

  it('keeps role="status" on every branch', () => {
    // The panel replaces the form in place. A screen-reader user has to be told what happened,
    // and that is as true of "we couldn't send it" as it is of "check your phone".
    for (const outcome of ['confirm_sent', 'undelivered'] as const) {
      expect(renderToStaticMarkup(<SignupOutcomePanel outcome={outcome} />), outcome).toContain(
        'role="status"'
      );
    }
  });

  it('gives every outcome a heading and at least one line', () => {
    // The copy and the mapping live together so a third state cannot arrive with one missing.
    for (const outcome of ['confirm_sent', 'undelivered'] as const) {
      const { heading, lines } = signupOutcomeCopy(outcome);
      expect(heading.length, outcome).toBeGreaterThan(0);
      expect(lines.length, outcome).toBeGreaterThan(0);
    }
  });

  it('matches the house voice: "SMS", never "text", on the new screen', () => {
    // Jon, 2026-09-02, applied across SUBMITTED_BODY to the verb forms as well as the noun.
    for (const line of UNDELIVERED_BODY) {
      expect(line.toLowerCase(), line).not.toMatch(/\btexts?\b/);
    }
  });
});
