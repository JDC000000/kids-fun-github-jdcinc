// tests/sms/weekly_send_consent-db.test.ts — the P6 weekly consent assertion, against a REAL database.
//
// ═══ WHY A DB LANE FILE WHEN tests/sms/weekly_send_consent.test.ts ALREADY PINS THE RULE ═══
// The unit suite injects the consent row, so it proves the RULE refuses a pending subscriber. It
// cannot prove the LOADER hands the rule the truth: a SELECT that read the wrong column, or a row
// shape the driver returns differently (a timestamptz as a string, say), would sail through every
// unit test. So this file drives real rows through the real lifecycle with the real
// `loadWeeklySendConsent` and the real transitions, and asserts what `sendWeeklySmsForSubscriber`
// would have dispatched at each step. ONLY THE TWILIO SEAM is injected (a spy): the audit write,
// the empty-week write and the carrier-stop write are the REAL ones, so "a refusal writes nothing"
// is read back from Postgres rather than inferred from a stub (QA of 2d67293, F9).
//
// It also reproduces the latent path found while scoping P6: pending → STOP → START leaves a row
// `active` with no `confirmed_timestamp`. Before P6 the Friday loader selected it.
//
// Self-cleaning on a key this suite owns (`consent_text_version`) and its own number range, in
// beforeAll AND afterAll — the same rule tests/sms/instant_picks_consent_gate-db.test.ts states.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import {
  confirmSubscriber,
  mirrorCarrierStart,
  mirrorCarrierStop,
} from '@/lib/sms/consent-transitions';
import {
  loadActiveSubscribers,
  loadWeeklySendConsent,
  sendWeeklySmsForSubscriber,
  type WeeklySmsDeps,
} from '@/lib/sms/weekly-send-io';
import type { SmsSubscriber } from '@/lib/sms/weekly-send';
import type { SmsSignup } from '@/lib/sms/signup-validate';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';

const PREFIX = '+1604555';
const TEST_CONSENT_VERSION = 'test-weekly-consent-gate.v8';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(7300 + seq++).padStart(4, '0')}`;
const NOW = new Date('2026-08-28T23:00:00Z'); // Friday

/** An empty catalogue: an allowed subscriber gets an empty-week text, which is enough to see a dispatch. */
const DEPS: WeeklySmsDeps = {
  engine: new SearchEngine({
    repository: new InMemoryListingRepository([]),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
    fixtureBacked: true,
  }),
  occurrenceShortRefs: new Map(),
};

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

/** What a caller with its OWN row lookup would hand the send (probe P6) — no status check at all. */
function subscriberFor(id: string): SmsSubscriber {
  return {
    id,
    shortRef: 1,
    postalCode: 'V5L 1A1',
    birthYears: [2021],
    categoryInterests: [],
    consecutiveEmptyWeeks: 0,
    preferencesToken: 'tok',
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
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}73%`]);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'weekly-consent-gate-secret');
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'weekly-consent-gate-link-secret');
  // The real audit writer hashes the number; an allowed send in this file really writes its row.
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'weekly-consent-gate-salt');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

/** What a send could change about a subscriber, read straight from Postgres. */
async function snapshot(id: string) {
  const [row] = await query<{ status: string | null; confirmed: Date | null; weeks: number | null }>(
    `SELECT status, confirmed_timestamp AS confirmed, consecutive_empty_weeks AS weeks
       FROM sms_consent WHERE id = $1`,
    [id]
  );
  const [log] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sms_send_log WHERE subscriber_id = $1`,
    [id]
  );
  return { row: row ?? null, sendLogRows: Number(log.n) };
}

/** The send with ONLY the Twilio seam stubbed; the consent loader and all three writes are REAL. */
async function weeklySend(id: string, phone: string) {
  const seams = {
    dispatch: vi.fn(async () => ({ outcome: 'sent' as const, twilioSid: 'SMtest', errorCode: null })),
  };
  const before = await snapshot(id);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await sendWeeklySmsForSubscriber(subscriberFor(id), phone, {
    now: NOW,
    dryRun: false,
    deps: DEPS,
    loadRecentlySent: async () => ({ occurrenceIds: new Set(), seriesIds: new Set(), seriesResolved: true }),
    ...seams,
  });
  const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]));
  warn.mockRestore();
  error.mockRestore();
  const after = await snapshot(id);
  return { result, seams, logged, before, after };
}

async function created(phone: string): Promise<string> {
  const c = await createPendingSubscriber(signup(phone), { dryRun: false });
  expect(c.outcome).toBe('created');
  return c.subscriberId as string;
}

async function activeIds(): Promise<Set<string>> {
  return new Set((await loadActiveSubscribers()).map((a) => a.subscriber.id));
}

describe('⛔ P6 · the weekly send checks consent against the real row', () => {
  it('the real loader reads status, confirmed_timestamp and the number', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    const row = await loadWeeklySendConsent(id);
    expect(row).toEqual({ status: 'pending', confirmedTimestamp: null, phoneNumber: phone });

    expect((await confirmSubscriber(phone, { dryRun: false })).outcome).toBe('applied');
    const joined = await loadWeeklySendConsent(id);
    expect(joined!.status).toBe('active');
    expect(joined!.confirmedTimestamp).toBeInstanceOf(Date);

    expect(await loadWeeklySendConsent('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('PENDING (never replied JOIN), handed over by a caller with its own lookup: refused, nothing sent', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    const { result, seams, logged, before, after } = await weeklySend(id, phone);
    expect(result.status).toBe('refused_consent');
    expect(seams.dispatch).not.toHaveBeenCalled();
    // Read back from Postgres: no audit row, no counter move, no status change.
    expect(after).toEqual(before);
    expect(after.sendLogRows).toBe(0);
    expect(logged).toEqual([expect.stringContaining('reason=status_pending')]);
  });

  it('after JOIN: allowed, and dispatched to exactly that number', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    expect((await confirmSubscriber(phone, { dryRun: false })).outcome).toBe('applied');
    const { result, seams, before, after } = await weeklySend(id, phone);
    expect(result.status).not.toBe('refused_consent');
    expect(seams.dispatch).toHaveBeenCalledTimes(1);
    expect(seams.dispatch).toHaveBeenCalledWith(phone, expect.anything(), { dryRun: false });
    // The control for every "nothing written" assertion in this file: an ALLOWED send really
    // writes its audit row through the same real writer.
    expect(after.sendLogRows).toBe(before.sendLogRows + 1);
    expect((await activeIds()).has(id)).toBe(true);
  });

  it('PAUSED (confirmed, system-paused after empty weeks): refused, and not selected by the loader', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    await confirmSubscriber(phone, { dryRun: false });
    await query(`UPDATE sms_consent SET status = 'paused' WHERE id = $1`, [id]);
    const { result, seams, logged, before, after } = await weeklySend(id, phone);
    expect(result.status).toBe('refused_consent');
    expect(seams.dispatch).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(logged).toEqual([expect.stringContaining('reason=status_paused')]);
    expect((await activeIds()).has(id)).toBe(false);
  });

  it('STOPPED: refused', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    await confirmSubscriber(phone, { dryRun: false });
    expect((await mirrorCarrierStop(phone, { dryRun: false })).outcome).toBe('applied');
    const { result, seams, before, after } = await weeklySend(id, phone);
    expect(result.status).toBe('refused_consent');
    expect(seams.dispatch).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });

  it('PURGED (number NULLed in place): refused', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    await confirmSubscriber(phone, { dryRun: false });
    await mirrorCarrierStop(phone, { dryRun: false });
    await query(
      `UPDATE sms_consent SET phone_number = NULL, postal_code = NULL, birth_years = NULL,
              category_interests = NULL WHERE id = $1`,
      [id]
    );
    const { result, logged } = await weeklySend(id, phone);
    expect(result.status).toBe('refused_consent');
    expect(logged).toEqual([expect.stringContaining('reason=purged')]);
  });

  it('an ACTIVE, confirmed id paired with SOMEONE ELSE’S number: refused', async () => {
    const phone = nextPhone();
    const other = nextPhone();
    const id = await created(phone);
    await confirmSubscriber(phone, { dryRun: false });
    const { result, seams, logged, before, after } = await weeklySend(id, other);
    expect(result.status).toBe('refused_consent');
    expect(seams.dispatch).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(logged).toEqual([expect.stringContaining('reason=number_mismatch')]);
    expect(logged.join('\n')).not.toMatch(/\+[1-9]\d{7,14}/);
  });
});

describe('⛔ P6 · pending → STOP → START is active but never confirmed (the latent path)', () => {
  it('the transitions really produce it, the Friday loader no longer selects it, and the send refuses it', async () => {
    const phone = nextPhone();
    const id = await created(phone);
    expect((await mirrorCarrierStop(phone, { dryRun: false })).outcome).toBe('applied');
    expect((await mirrorCarrierStart(phone, { dryRun: false })).outcome).toBe('applied');

    // The state itself — reproduced, not assumed.
    const rows = await query<{ status: string; confirmed_timestamp: Date | null }>(
      `SELECT status, confirmed_timestamp FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(rows[0]).toEqual({ status: 'active', confirmed_timestamp: null });

    // Layer 1: `AND c.confirmed_timestamp IS NOT NULL` keeps it out of the Friday batch.
    expect((await activeIds()).has(id)).toBe(false);

    // Layer 2: handed over directly anyway, the send refuses it — loudly.
    const { result, seams, logged, before, after } = await weeklySend(id, phone);
    expect(result.status).toBe('refused_consent');
    expect(seams.dispatch).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(after.sendLogRows).toBe(0);
    expect(logged).toEqual([expect.stringContaining('reason=active_unconfirmed')]);
  });
});
