// tests/sms/waitlist_validate.test.ts — the waitlist's accept/reject surface and its send gate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWaitlistBody } from '@/lib/sms/waitlist-validate';
import { smsSendingEnabled, waitlistNotificationsEnabled } from '@/lib/sms/config';

const SPARSE = ['wvan', 'bby'];
const valid = (over: Record<string, unknown> = {}) => ({
  phone: '604 555 0123',
  postal: 'V3S 1A1', // Surrey — out of area
  consent: true,
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseWaitlistBody', () => {
  it('accepts an out-of-area opt-in and stores the FSA only', () => {
    const r = parseWaitlistBody(valid(), SPARSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toEqual({ phoneNumber: '+16045550123', regionChipId: null, areaFsa: 'V3S' });
  });

  it('accepts a sparse-municipality opt-in and stores the region, not an FSA', () => {
    const r = parseWaitlistBody(valid({ postal: 'V7V 1A1' }), SPARSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toEqual({ phoneNumber: '+16045550123', regionChipId: 'wvan', areaFsa: null });
  });

  it('🔴 RE-DERIVES the area and ignores whatever the caller claimed', () => {
    // The browser classifies as somebody types so it can offer the right thing, but a client can
    // send any pair it likes. Deriving server-side is what stops a caller enrolling a number for
    // an area it does not live in — including a covered one, which would be a way onto a list for
    // a municipality that is already served.
    const r = parseWaitlistBody(
      valid({ regionChipId: 'van', areaFsa: 'V6B', region_chip_id: 'van' }),
      SPARSE
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.regionChipId).toBeNull();
    expect(r.entry.areaFsa).toBe('V3S'); // from the postal code, not the claim
  });

  it('refuses a well-covered area, and says why rather than failing silently', () => {
    // Not the parent's mistake. We serve this area properly, so parking them on a list for
    // something they can have now would be worse than an error.
    const r = parseWaitlistBody(valid({ postal: 'V5L 1A1' }), SPARSE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].field).toBe('postal');
    expect(r.errors[0].message).toMatch(/already cover/i);
  });

  it('rejects a half-typed postal code as unparseable, not as out-of-area', () => {
    const r = parseWaitlistBody(valid({ postal: 'V3' }), SPARSE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.field === 'postal')).toBe(true);
  });

  it('requires express consent, unticked meaning no', () => {
    for (const consent of [false, undefined, 'true', 1]) {
      const r = parseWaitlistBody(valid({ consent }), SPARSE);
      expect(r.ok, JSON.stringify(consent)).toBe(false);
    }
  });

  it('🔴 reports the AREA problem before the consent problem', () => {
    // Jon's ordering ruling for the signup form, which applies here for the same reason: somebody
    // should learn we cannot serve them before being asked to agree to anything.
    const r = parseWaitlistBody({ phone: '604 555 0123', postal: 'V5L 1A1', consent: false }, SPARSE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.errors.map((e) => e.field);
    expect(fields.indexOf('postal')).toBeLessThan(fields.indexOf('consent'));
  });

  it('asks for nothing the promise does not need', () => {
    // No ages, no interests. Every field the weekly signup collects is one this message does not
    // require, and collecting it anyway would be gathering data to support a text we may never send.
    const r = parseWaitlistBody(valid(), SPARSE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.entry).sort()).toEqual(['areaFsa', 'phoneNumber', 'regionChipId']);
  });
});

describe('🔴 the send gate is independent of SMS_SENDING_ENABLED', () => {
  // THE HARD CONSTRAINT. Jon authorised building the waitlist and separately withheld authority to
  // send from it. SMS_SENDING_ENABLED is already true in production, so reusing it would have put
  // this message type live the moment the code merged — the exact outcome the instruction exists to
  // prevent. These assertions are what stop a later "simplify the flags" change collapsing them.

  it('is OFF by default', () => {
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', '');
    expect(waitlistNotificationsEnabled()).toBe(false);
  });

  it('stays OFF even when weekly-picks sending is fully ON', () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', '');
    expect(smsSendingEnabled()).toBe(true);
    expect(waitlistNotificationsEnabled()).toBe(false);
  });

  it('turns on only from its own variable', () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'false');
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', 'true');
    expect(waitlistNotificationsEnabled()).toBe(true);
  });
});

describe('🔴 the write path cannot send, by construction', () => {
  // Jon's hard constraint was not "do not call dispatch" but "do not wire up an outbound send path
  // at all" — so this asserts the STRUCTURE rather than the behaviour. A behavioural test would
  // only prove that dispatch is not reached on the paths a test happens to exercise; this proves
  // there is no call site to reach.
  //
  // Source-level rather than import-graph, deliberately: it fails on the line someone would add,
  // which is where the mistake would be made and where the reader needs the answer.
  // COMMENTS STRIPPED BEFORE MATCHING. The constraint is about CODE, and these files discuss the
  // very identifiers being banned — waitlist-store.ts explains why it does not use
  // SMS_SENDING_ENABLED, which a naive source match reads as using it. Matching prose instead of
  // code is the same mistake as grepping a symbol name and concluding about literals.
  const read = (p: string) =>
    readFileSync(join(process.cwd(), p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  const writePathModules = [
    'lib/sms/waitlist-store.ts',
    'lib/sms/waitlist-validate.ts',
    'app/api/sms/waitlist/route.ts',
  ];

  it('imports no Twilio client and names no dispatch function', () => {
    for (const mod of writePathModules) {
      const src = read(mod);
      expect(src, mod).not.toMatch(/twilio-client|dispatchSms|from ['"]twilio['"]/);
    }
  });

  it('never reads SMS_SENDING_ENABLED on this path', () => {
    // If a waitlist module ever consulted the weekly-picks flag, the two gates would have started
    // to merge — which is the failure the separate flag exists to prevent.
    for (const mod of writePathModules) {
      expect(read(mod), mod).not.toMatch(/smsSendingEnabled|SMS_SENDING_ENABLED/);
    }
  });
});
