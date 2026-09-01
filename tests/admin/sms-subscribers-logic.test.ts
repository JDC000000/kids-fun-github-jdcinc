// tests/admin/sms-subscribers-logic.test.ts — the pure parts of the SMS subscriber console, plus
// the structural guarantee that keeps real phone numbers off the wire.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  summariseSubscribers,
  type SmsSubscriberListRow,
} from '@/lib/admin/sms-subscribers';

function row(over: Partial<SmsSubscriberListRow> = {}): SmsSubscriberListRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    shortRef: '1',
    phoneNumber: '+16045550123',
    purged: false,
    status: 'active',
    consentMethod: 'web_form',
    consentTimestamp: '2026-08-01T00:00:00.000Z',
    confirmedTimestamp: '2026-08-01T00:05:00.000Z',
    consecutiveEmptyWeeks: 0,
    stoppedAt: null,
    ...over,
  };
}

describe('the summary counts what the table below it is actually showing', () => {
  it('counts each status', () => {
    const s = summariseSubscribers([
      row({ status: 'active' }),
      row({ status: 'active' }),
      row({ status: 'pending' }),
      row({ status: 'paused' }),
      row({ status: 'stopped', stoppedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    expect(s).toMatchObject({ total: 5, active: 2, pending: 1, paused: 1, stopped: 1 });
  });

  it('🔴 counts purged INDEPENDENTLY of status — the two are different questions', () => {
    // A purged row keeps its consent record and its 'stopped' status; only the personal columns
    // are erased. Folding "purged" into a status count would hide either one behind the other.
    const s = summariseSubscribers([
      row({ status: 'stopped', purged: true, phoneNumber: null }),
      row({ status: 'stopped', purged: false }),
    ]);
    expect(s.stopped).toBe(2);
    expect(s.purged).toBe(1);
  });

  it('is empty-safe', () => {
    expect(summariseSubscribers([])).toEqual({
      total: 0, active: 0, pending: 0, paused: 0, stopped: 0, purged: 0,
    });
  });
});

describe('🔴 the page stays server-only, which is what keeps numbers out of the browser', () => {
  // COMMENTS STRIPPED FIRST. The page's own header explains why it must not be a client
  // component, quoting the directive to do so — so a naive match finds the prose and fails on a
  // correct file. (This test caught exactly that on its first run.) The assertion has to be about
  // the CODE, not about whether anyone described the rule.
  const raw = readFileSync('app/admin/sms-subscribers/page.tsx', 'utf8');
  const page = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it("has no 'use client' directive", () => {
    // Not style policing. A client component would ship the rendered rows — real phone numbers —
    // into the browser bundle and into reach of any client-side analytics or error capture added
    // later. Server-only is the guarantee that survives someone wiring one up.
    expect(page).not.toMatch(/['"]use client['"]/);
  });

  it('pulls its data from the server-only module, not an API route', () => {
    expect(page).toContain("from '@/lib/admin/sms-subscribers'");
    expect(page).not.toMatch(/fetch\(/);
  });

  it('is gated by the shared admin choke point and 404s when refused', () => {
    expect(page).toContain('resolveAdminAccess');
    expect(page).toContain('notFound()');
  });
});
