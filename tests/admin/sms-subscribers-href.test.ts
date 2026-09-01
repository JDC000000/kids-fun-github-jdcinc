// tests/admin/sms-subscribers-href.test.ts — the drill-down link must carry the interim admin
// token, or it 404s the token holder on arrival.
import { describe, expect, it } from 'vitest';
import { adminHref } from '@/app/admin/sms-subscribers/_lib/href';

describe('adminHref keeps a token-authorised admin authorised', () => {
  it('🔴 carries ?token= forward', () => {
    // The gate accepts EITHER a session OR this shared secret. Drop it and the next page's gate
    // sees nothing and fail-closes to 404 — mid-task, with no explanation.
    expect(adminHref('/admin/sms-subscribers/abc', { token: 's3cret' })).toBe(
      '/admin/sms-subscribers/abc?token=s3cret'
    );
  });

  it('adds nothing for a session-authorised admin, who has no token', () => {
    expect(adminHref('/admin/sms-subscribers', {})).toBe('/admin/sms-subscribers');
  });

  it('url-encodes, and takes the first value when Next hands over an array', () => {
    expect(adminHref('/x', { token: 'a b&c' })).toBe('/x?token=a%20b%26c');
    expect(adminHref('/x', { token: ['one', 'two'] })).toBe('/x?token=one');
  });
});

describe('🔴 page 2 never exposes the phone hash', () => {
  const raw = require('node:fs').readFileSync(
    'app/admin/sms-subscribers/[id]/page.tsx',
    'utf8'
  ) as string;
  // Comments stripped BEFORE matching — the file's own header discusses phone_hash at length while
  // explaining why it must never render. Matching the prose instead of the code is a mistake this
  // repo has now made twice; it is not making it a third time.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('renders no hash and offers no lookup-by-number affordance', () => {
    // One global salt + a small keyspace means a displayed hash is guess-and-checkable by anyone
    // who can read this page.
    expect(code).not.toMatch(/phoneHash|phone_hash/);
    expect(code).not.toMatch(/<input/);
    expect(code).not.toMatch(/type="search"/);
  });

  it('stays a Server Component', () => {
    expect(code).not.toMatch(/['"]use client['"]/);
  });
});
