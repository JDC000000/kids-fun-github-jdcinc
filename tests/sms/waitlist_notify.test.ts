// tests/sms/waitlist_notify.test.ts — composing the one waitlist text, and proving the gate holds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  areaLabelFor,
  composeWaitlistNotifications,
  notifyWaitlistFor,
  type WaitlistRecipient,
} from '@/lib/sms/waitlist-notify';

vi.mock('@/lib/db/client', () => ({
  query: vi.fn(async () => [
    { id: 'r1', phoneNumber: '+16045550123', regionChipId: 'wvan', areaFsa: null },
    { id: 'r2', phoneNumber: '+16045550124', regionChipId: null, areaFsa: 'V3S' },
  ]),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

const recipient = (over: Partial<WaitlistRecipient> = {}): WaitlistRecipient => ({
  id: 'r1',
  phoneNumber: '+16045550123',
  regionChipId: 'wvan',
  areaFsa: null,
  ...over,
});

describe('areaLabelFor', () => {
  it('names a municipality by its real name', () => {
    expect(areaLabelFor(recipient())).toBe('West Vancouver');
  });

  it('🔴 never prints a raw FSA at a parent', () => {
    // "V3S" means nothing to somebody reading a text, and printing it reads as a database leaking
    // into a message. The FSA is how WE find them, not how they think about where they live.
    const label = areaLabelFor(recipient({ regionChipId: null, areaFsa: 'V3S' }));
    expect(label).toBe('your area');
    expect(label).not.toContain('V3S');
  });
});

describe('composeWaitlistNotifications', () => {
  it('builds one message per recipient, addressed to their own area', () => {
    const staged = composeWaitlistNotifications(
      [recipient(), recipient({ id: 'r2', regionChipId: null, areaFsa: 'V3S' })],
      'https://kidsfunapp.ca/sms/start'
    );
    expect(staged).toHaveLength(2);
    expect(staged[0].body).toContain('West Vancouver');
    expect(staged[1].body).toContain('your area');
    expect(staged[1].body).not.toContain('V3S');
  });
});

describe('🔴 the gate holds — nothing dispatches until it is opened', () => {
  // The hard constraint, tested at the only place it can actually be violated. A structural test
  // proved the WRITE path has no send call site; this proves the SEND path does not fire.

  // NEXT_PUBLIC_SITE_URL is stubbed because notifyWaitlistFor builds the signup link, and
  // siteUrl()'s fail-loud guard (05a5b56) THROWS when sending is enabled without it. That guard
  // firing here is it working: these tests turn SMS_SENDING_ENABLED on to prove the waitlist gate
  // ignores it, which is exactly the condition the guard watches for.
  function recordingClient() {
    const sent: unknown[] = [];
    return {
      sent,
      client: {
        messages: {
          create: async (payload: unknown) => {
            sent.push(payload);
            return { sid: 'SM_test', status: 'queued' };
          },
        },
      } as never,
    };
  }

  it('composes everything and sends NOTHING while the gate is shut', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    // ⚠ EVERYTHING ELSE IS MADE SENDABLE ON PURPOSE. Without a messaging service dispatchSms
    // refuses before it reaches the client, so "nothing was sent" would be true whether the gate
    // held or not — the assertion would pass for a reason unrelated to what it claims to prove.
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG_test');
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', '');
    const { sent, client } = recordingClient();
    const r = await notifyWaitlistFor('wvan', { client });

    expect(r.permitted).toBe(false);
    expect(r.staged).toHaveLength(2); // the pipeline ran in full
    expect(r.results.every((x) => x.outcome === 'dry_run')).toBe(true);
    expect(sent).toHaveLength(0); // and the Twilio client was never called
  });

  it('🔴 stays shut even when weekly-picks sending is fully ON', async () => {
    // The failure this whole design exists to prevent: SMS_SENDING_ENABLED is already true in
    // production, so a gate that consulted it would have been open the moment the code merged.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG_test'); // sendable in every respect but the gate
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', '');
    const { sent, client } = recordingClient();
    const r = await notifyWaitlistFor('wvan', { client });

    expect(r.permitted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('dispatches only when its OWN flag is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    vi.stubEnv('SMS_WAITLIST_NOTIFICATIONS_ENABLED', 'true');
    // dispatchSms refuses without a messaging service, before it ever reaches the client — so
    // without this the test would pass for the WRONG reason: nothing sent because nothing could
    // send, rather than because the gate was shut.
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG_test');
    const { sent, client } = recordingClient();
    const r = await notifyWaitlistFor('wvan', { client });

    expect(r.permitted).toBe(true);
    expect(sent).toHaveLength(2);
  });
});
