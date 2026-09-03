// tests/admin/sms-engagement-page.test.ts — the properties of the engagement page that are not
// visible from the rendered output, and would fail silently if lost.
import { describe, expect, it } from 'vitest';

const page = require('node:fs').readFileSync('app/admin/sms-engagement/page.tsx', 'utf8') as string;
const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the SMS engagement page', () => {
  it("🔴 has no 'use client' directive anywhere", () => {
    // The read model sits beside code that handles real phone numbers. A client boundary here
    // would start shipping subscriber data to a browser, where a global analytics or
    // error-capture call could pick it up. Server-only is the guarantee that survives someone
    // adding one of those later.
    expect(code).not.toMatch(/['"]use client['"]/);
  });

  it('🔴 is behind the shared admin gate and 404s rather than advertising itself', () => {
    expect(code).toMatch(/resolveAdminAccess\(/);
    expect(code).toMatch(/notFound\(\)/);
  });

  it('🔴 defaults to EXCLUDING test handsets — the toggle must be opt-in', () => {
    // getSmsEngagement() with no argument excludes them. If this ever became
    // `includeTest: true` by default, every number on the page would silently include a test
    // handset and nothing would say so.
    expect(code).toMatch(/searchParams\.includeTest === '1'/);
    expect(code).not.toMatch(/includeTest:\s*true\b/);
  });

  it('🔴 renders no phone number field at all', () => {
    // The read model does not expose one; this asserts the page never starts asking for it.
    expect(code).not.toMatch(/phoneNumber|phone_number/);
  });

  it('shows an em dash rather than 0% when nothing was ever offered', () => {
    // 0/0 is "we have never sent this person a pick", not "they ignored everything". Printing 0%
    // would be a false statement about a real person's behaviour.
    expect(code).toMatch(/pct === null \? '—'/);
  });
});
