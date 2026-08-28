// tests/sms/redact.test.ts — redactPhone's actual output.
//
// CONSOLIDATED IN ROUND 17 TO HAVE ONE HOME, AND THAT HOME HAD NO TEST. A QA pass proved it:
// changing `phone.slice(-4)` to `phone.slice(-6)` — a real privacy regression, six digits in every
// log line instead of four — passed the entire 376-test suite undetected.
//
// Giving a rule one home makes it editable in one place. That is only an improvement if something
// checks what the rule says.
import { describe, expect, it } from 'vitest';
import { redactPhone } from '@/lib/sms/redact';

describe('redactPhone', () => {
  it('exposes the LAST FOUR digits and nothing else', () => {
    // The mutation the QA pass used. `slice(-6)` fails here.
    expect(redactPhone('+16045550123')).toBe('****0123');
    expect(redactPhone('+18778357776')).toBe('****7776');
  });

  it('never reveals the country code, the area code or the exchange', () => {
    const masked = redactPhone('+16045550123');
    expect(masked).not.toContain('604'); // area code
    expect(masked).not.toContain('555'); // exchange
    expect(masked).not.toContain('+1');
    expect(masked.replace(/\*/g, '')).toHaveLength(4);
  });

  it('redacts a four-character input ENTIRELY rather than echoing it', () => {
    // Unreachable for an E.164 number, which is why it is here: a malformed or truncated value
    // must not fall through into a log verbatim just because it was short.
    expect(redactPhone('0123')).toBe('****');
    expect(redactPhone('123')).toBe('****');
    expect(redactPhone('1')).toBe('****');
  });

  it('handles the empty string', () => {
    expect(redactPhone('')).toBe('****');
  });

  it('a five-character input exposes only its last four', () => {
    // The boundary either side of the `<= 4` branch, asserted rather than assumed.
    expect(redactPhone('01234')).toBe('****1234');
  });

  it('output is always exactly four asterisks plus at most four digits', () => {
    for (const input of ['', '1', '0123', '01234', '+16045550123', '+441632960000']) {
      expect(redactPhone(input), input).toMatch(/^\*{4}\d{0,4}$/);
    }
  });
});
