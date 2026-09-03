// tests/sms/test_destination.test.ts — "did this arrive at a test handset's number?"
//
// The question is about `To` — one of OUR numbers — and never about `From`. Keying on the sender
// would be wrong in both directions: a real parent texting the test number would be treated as
// real, and anyone could aim traffic at a number we do not control to influence the answer.
import { afterEach, describe, expect, it } from 'vitest';
import { isTestDestination, smsTestNumbers } from '../../lib/sms/config';

const ORIGINAL = process.env.SMS_TEST_NUMBERS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SMS_TEST_NUMBERS;
  else process.env.SMS_TEST_NUMBERS = ORIGINAL;
});

describe('isTestDestination', () => {
  it('🔴 UNSET means nothing is a test number — the safe direction', () => {
    // With nothing configured, no row is ever marked, so no subscriber is ever silently dropped
    // from the Friday send. The failure mode of a typo is a test handset getting a real text,
    // which is visible; the opposite would be a real parent never hearing from us again.
    delete process.env.SMS_TEST_NUMBERS;
    expect(smsTestNumbers()).toEqual([]);
    expect(isTestDestination('+17784047122')).toBe(false);
  });

  it('matches regardless of formatting on either side', () => {
    process.env.SMS_TEST_NUMBERS = '+1 (778) 404-7122';
    for (const form of ['+17784047122', '17784047122', '+1 778 404 7122', '1-778-404-7122']) {
      expect(isTestDestination(form), form).toBe(true);
    }
  });

  it('does not match a different number', () => {
    process.env.SMS_TEST_NUMBERS = '+17784047122';
    expect(isTestDestination('+16045550199')).toBe(false);
    expect(isTestDestination('+18778357776')).toBe(false);
  });

  it('handles several test numbers, and blank/absent input', () => {
    process.env.SMS_TEST_NUMBERS = '+17784047122, +16045550100';
    expect(isTestDestination('+16045550100')).toBe(true);
    expect(isTestDestination('')).toBe(false);
    expect(isTestDestination(null)).toBe(false);
    expect(isTestDestination(undefined)).toBe(false);
  });
});

describe('🔴 the inbound route asks about To, never From', () => {
  const code = (require('node:fs').readFileSync('app/api/sms/inbound/route.ts', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('derives the test flag from the To parameter', () => {
    expect(code).toMatch(/const to = \(params\.get\('To'\) \?\? ''\)\.trim\(\);/);
    expect(code).toMatch(/const markTest = isTestDestination\(to\);/);
  });

  it('🔴 never derives it from the sender', () => {
    // isTestDestination(from) would compile, run, and be wrong in a way no type checks.
    expect(code).not.toMatch(/isTestDestination\(\s*from\s*\)/);
  });
});
