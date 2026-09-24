// tests/admin/sms-subscribers-detail-page.test.ts — source-level properties of the subscriber
// detail page (app/admin/sms-subscribers/[id]/page.tsx) that would fail silently if lost.
//
// (Until 2026-09-24 this file was sms-subscribers-href.test.ts and also pinned adminHref(), which
// copied the interim `?token=` admin secret into drill-down links. That helper and the token are
// gone; tests/compliance/admin-no-url-credentials.test.ts now pins that no admin link carries one.)
import { describe, expect, it } from 'vitest';

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
