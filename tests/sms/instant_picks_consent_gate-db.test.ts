// tests/sms/instant_picks_consent_gate-db.test.ts — the 2026-09-24 CASL fix, against a REAL database.
//
// ═══ WHY A DB LANE FILE WHEN tests/sms/instant_picks_send.test.ts ALREADY PINS THE GATE ═══
// The unit suite injects the subscriber, so it proves the GATE refuses a pending row. It cannot
// prove the LOADER hands the gate the truth: a SELECT that forgot `status`, or read
// `confirmed_timestamp` under the wrong name, would give the gate `undefined` and every unit test
// would still be green. So this file drives the real rows through the real lifecycle — signup
// (pending) → JOIN (active) → STOP → web-form resubmit (pending again, OLD LINK STILL LIVE) — with
// the real `loadInstantPicksSendSubscriber` and the real transitions, and asserts what would have
// been dispatched at each step. Only the Twilio seam, the audit writer and the throttle are
// injected, so nothing leaves the process.
//
// The resubmit step is the realistic path by which a never-(re)confirmed subscriber held a working
// `/u/{token}` link: `createPendingSubscriber` resets status to `pending` and clears
// `confirmed_timestamp`, but deliberately KEEPS `preferences_token`, which was in every text the
// subscriber ever got.
//
// Self-cleaning on a key this suite owns (`consent_text_version`), in beforeAll AND afterAll —
// the same rule tests/sms/send_log-db.test.ts states for why it is not the phone number.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { confirmSubscriber, mirrorCarrierStop } from '@/lib/sms/consent-transitions';
import { findInstantPicksSubscriber } from '@/lib/sms/instant-picks-store';
import {
  loadInstantPicksSendSubscriber,
  sendInstantPicksText,
} from '@/lib/sms/instant-picks-send';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
// Parses as consent serial 8, so the WORDING gate passes and the only thing under test is the
// consent-STATUS gate. A version with no `.vN` suffix would be refused by the wording gate and
// make every "not texted" assertion below pass for the wrong reason.
const TEST_CONSENT_VERSION = 'test-ip-consent-gate.v8';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(7200 + seq++).padStart(4, '0')}`;

function signup(phone: string): SmsSignup {
  return {
    phoneNumber: phone,
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2021],
    categoryInterests: [],
    consentMethod: 'web_form',
    consentTextVersion: TEST_CONSENT_VERSION,
  };
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (SELECT id FROM sms_consent WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}72%`]);
}

beforeAll(async () => {
  // A token is minted only when a secret is configured, and the send loader refuses a row
  // without one — so without this every assertion below would be "no token", not "not consented".
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'ip-consent-gate-secret');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

/** Every seam that could leave the process, stubbed; the loader is the REAL one. */
function liveSendDeps() {
  return {
    enabled: true, // INSTANT_PICKS_SMS_SEND_ENABLED — true in production since 2026-09-14
    dryRun: false, // SMS_SENDING_ENABLED — true in production
    dispatch: vi.fn(async () => ({ outcome: 'sent' as const, twilioSid: 'SMtest', errorCode: null })),
    record: vi.fn(async () => {}),
    checkThrottle: vi.fn(async () => ({
      allowed: true, reason: null, retryAfterSeconds: 0, degraded: false,
    })),
    markStopped: vi.fn(async () => {}),
  };
}

async function tokenFor(id: string): Promise<string> {
  const rows = await query<{ preferences_token: string }>(
    `SELECT preferences_token FROM sms_consent WHERE id = $1`,
    [id]
  );
  return rows[0].preferences_token;
}

describe('⛔ CASL · a PENDING subscriber is never texted by an Instant Picks press (real rows)', () => {
  it('the real loader reads status and confirmed_timestamp — pending, NULL', async () => {
    const phone = nextPhone();
    const created = await createPendingSubscriber(signup(phone), { dryRun: false });
    expect(created.outcome).toBe('created');

    const loaded = await loadInstantPicksSendSubscriber(created.subscriberId as string);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('pending');
    expect(loaded!.confirmedTimestamp).toBeNull();
  });

  it('new signup, never replied JOIN: list is served, TEXT is not', async () => {
    const phone = nextPhone();
    const created = await createPendingSubscriber(signup(phone), { dryRun: false });
    const id = created.subscriberId as string;

    // The list half: a pending row with a live link IS served — that rule is intentionally unchanged.
    const found = await findInstantPicksSubscriber(await tokenFor(id));
    expect(found.outcome).toBe('found');

    const d = liveSendDeps();
    const result = await sendInstantPicksText(id, d);
    expect(result.status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    expect(d.checkThrottle).not.toHaveBeenCalled();
  });

  it('after JOIN the same subscriber IS texted — the gate opens on confirmation, not on anything else', async () => {
    const phone = nextPhone();
    const created = await createPendingSubscriber(signup(phone), { dryRun: false });
    const id = created.subscriberId as string;

    const joined = await confirmSubscriber(phone, { dryRun: false });
    expect(joined.outcome).toBe('applied');

    const loaded = await loadInstantPicksSendSubscriber(id);
    expect(loaded!.status).toBe('active');
    expect(loaded!.confirmedTimestamp).toBeInstanceOf(Date);

    const d = liveSendDeps();
    const result = await sendInstantPicksText(id, d);
    expect(result.status).toBe('sent');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledWith(phone, expect.anything(), { dryRun: false });
    expect(d.record).toHaveBeenCalledTimes(1);
  });

  it('🔴 STOP → web-form resubmit: the OLD link still works, and the press must NOT text them until they JOIN again', async () => {
    // The concrete path by which a real subscriber held a live link while pending.
    const phone = nextPhone();
    const first = await createPendingSubscriber(signup(phone), { dryRun: false });
    const id = first.subscriberId as string;
    expect((await confirmSubscriber(phone, { dryRun: false })).outcome).toBe('applied');
    const oldToken = await tokenFor(id);

    expect((await mirrorCarrierStop(phone, { dryRun: false })).outcome).toBe('applied');
    // Stopped: the link resolves to nothing at all.
    expect((await findInstantPicksSubscriber(oldToken)).outcome).toBe('not_found');

    // They fill in the web form again. Same row, reset to pending, token KEPT.
    const again = await createPendingSubscriber(signup(phone), { dryRun: false });
    expect(again.outcome).toBe('reactivated');
    expect(again.subscriberId).toBe(id);
    expect(await tokenFor(id)).toBe(oldToken);

    // The old link from their old texts now resolves again...
    expect((await findInstantPicksSubscriber(oldToken)).outcome).toBe('found');
    const loaded = await loadInstantPicksSendSubscriber(id);
    expect(loaded!.status).toBe('pending');
    expect(loaded!.confirmedTimestamp).toBeNull();
    expect(loaded!.consentTextVersion).toBe(TEST_CONSENT_VERSION); // v8 — wording gate passes

    // ...and before this fix, this is where the text went out.
    const d = liveSendDeps();
    const result = await sendInstantPicksText(id, d);
    expect(result.status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();

    // Re-confirming restores the text — the gate tracks the double opt-in, not the row's history.
    expect((await confirmSubscriber(phone, { dryRun: false })).outcome).toBe('applied');
    const d2 = liveSendDeps();
    expect((await sendInstantPicksText(id, d2)).status).toBe('sent');
    expect(d2.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a PAUSED subscriber is not texted either (list still served)', async () => {
    const phone = nextPhone();
    const created = await createPendingSubscriber(signup(phone), { dryRun: false });
    const id = created.subscriberId as string;
    expect((await confirmSubscriber(phone, { dryRun: false })).outcome).toBe('applied');
    // The weekly job's auto-pause, reproduced with the same guarded UPDATE shape it uses.
    await query(`UPDATE sms_consent SET status = 'paused' WHERE id = $1 AND status = 'active'`, [id]);

    expect((await findInstantPicksSubscriber(await tokenFor(id))).outcome).toBe('found');
    const d = liveSendDeps();
    expect((await sendInstantPicksText(id, d)).status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});
