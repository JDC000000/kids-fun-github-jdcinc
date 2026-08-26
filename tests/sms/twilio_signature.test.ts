// tests/sms/twilio_signature.test.ts — X-Twilio-Signature verification.
//
// DIFFERENTIAL TEST against Twilio's own SDK, not against our implementation's output.
//
// lib/sms/twilio-signature.ts implements the algorithm by hand in node:crypto rather than
// calling the SDK (see that file for why). A test that only round-trips our own function would
// pass just as happily on a subtly wrong algorithm — wrong sort order, a separator between
// key and value, HMAC-SHA256 instead of SHA1 — and we would find out when every real webhook
// started failing in production. So the expected value is checked TWO independent ways:
//
//   1. against a pinned literal, so an SDK upgrade cannot silently move the goalposts, and
//   2. against `twilio`'s own getExpectedTwilioSignature, so the pinned literal is the
//      reference implementation's answer and not just a snapshot of our own.
//
// The literal below was produced by (2) on twilio 6.1.0 and verified to be reproducible; it is
// NOT transcribed from documentation.
import { describe, expect, it } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import {
  buildSignatureBase,
  expectedTwilioSignature,
  verifyTwilioSignature,
} from '@/lib/sms/twilio-signature';

const VECTOR_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const VECTOR_TOKEN = '12345';
const VECTOR_SIGNATURE = 'GvWf1cFY/Q7PnoempGyD5oXAezc=';
const VECTOR_FIELDS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
};
const VECTOR_PARAMS = new URLSearchParams(VECTOR_FIELDS);

describe('twilio signature', () => {
  it("reproduces the reference implementation's signature exactly", () => {
    expect(expectedTwilioSignature(VECTOR_TOKEN, VECTOR_URL, VECTOR_PARAMS)).toBe(VECTOR_SIGNATURE);
    // And the pinned literal really is what the official SDK computes for this input.
    expect(getExpectedTwilioSignature(VECTOR_TOKEN, VECTOR_URL, VECTOR_FIELDS)).toBe(VECTOR_SIGNATURE);
  });

  it('sorts parameters by key and appends key+value with no separators', () => {
    const base = buildSignatureBase('https://x/y', new URLSearchParams({ b: '2', a: '1' }));
    expect(base).toBe('https://x/ya1b2');
  });

  it('verifies the vector and rejects tampering with any covered part', () => {
    const ok = (over: Partial<Parameters<typeof verifyTwilioSignature>[0]> = {}) =>
      verifyTwilioSignature({
        authToken: VECTOR_TOKEN,
        url: VECTOR_URL,
        params: VECTOR_PARAMS,
        signature: VECTOR_SIGNATURE,
        ...over,
      });

    expect(ok()).toBe(true);
    // A changed body param, a changed URL, or the wrong token all break the signature.
    const tampered = new URLSearchParams(VECTOR_PARAMS);
    tampered.set('Digits', '9999');
    expect(ok({ params: tampered })).toBe(false);
    expect(ok({ url: 'https://mycompany.com/myapp.php?foo=1&bar=3' })).toBe(false);
    expect(ok({ authToken: 'not-the-token' })).toBe(false);
    expect(ok({ signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).toBe(false);
  });

  it('fails CLOSED when unconfigured — no token or no configured URL verifies nothing', () => {
    const args = { params: VECTOR_PARAMS, signature: VECTOR_SIGNATURE };
    expect(verifyTwilioSignature({ ...args, authToken: null, url: VECTOR_URL })).toBe(false);
    expect(verifyTwilioSignature({ ...args, authToken: VECTOR_TOKEN, url: null })).toBe(false);
    expect(
      verifyTwilioSignature({ authToken: VECTOR_TOKEN, url: VECTOR_URL, params: VECTOR_PARAMS, signature: null })
    ).toBe(false);
  });
});
