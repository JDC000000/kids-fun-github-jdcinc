// tests/sms/preferences_weekly-db.test.ts — Stage C against a REAL database.
//
// The Friday job's reads and writes, and the hub page's. Between them these six seams are what
// make a subscriber's week actually happen: who gets a text, what the empty-week counter does to
// them, what they see when they follow the link in it, and what happens when they change or delete
// their data from there.
//
// ⚠ THE OPERATOR RUNS THIS LANE. Every statement was validated with EXPLAIN against the live
// schema (which plans without executing), but a green run here is the Operator's evidence.
//
// ═══ THIS FILE BUILDS ITS OWN CATALOGUE ROWS, AND CLEANS THEM UP ═══
// The local catalogue is empty after the reconciliation reset, and `findLastWeek` joins
// `activity_occurrence` for short refs. Rather than block on a catalogue load, this creates the
// minimum chain — source → activity_series → activity_occurrence — which is three inserts and the
// same pattern tests/search/postgres-repository.test.ts already uses. Every row is deleted in
// afterAll, in FK order. Given that the reset was needed partly because the db lane had been
// leaving venues behind for months, adding a suite that leaked would be a poor trade.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { recordSmsSend } from '@/lib/sms/send-log';
import { loadActiveSubscribers, applyEmptyWeekState, markStoppedViaCarrier } from '@/lib/sms/weekly-send-io';
import { findByPreferencesToken, findLastWeek, applyPreferencesChange } from '@/lib/sms/preferences';
import { mintPreferencesToken } from '@/lib/sms/preferences-token';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
/** Stamped on every row this suite creates, and the key its cleanup uses. See below. */
const TEST_CONSENT_VERSION = 'test-stage-c';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(7000 + seq++).padStart(4, '0')}`;
const TAG = 'stage-c-db-fixture';

function signup(phone: string): SmsSignup {
  return {
    phoneNumber: phone,
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2021],
    categoryInterests: ['public_swim'],
    consentMethod: 'web_form',
    consentTextVersion: TEST_CONSENT_VERSION,
  };
}

/**
 * ═══ THE CLEANUP KEY, AND WHY IT IS NOT THE PHONE NUMBER ═══
 * These suites TEST THE PURGE — they NULL `phone_number` on purpose to prove the audit trail
 * survives it. So a cleanup keyed on `phone_number LIKE '+1604555…'` cannot see exactly the rows
 * those tests create, and they leak. That is not hypothetical: an earlier version of this file did
 * precisely that and left 13 orphaned consent rows and a send-log row behind, found by reading the
 * live table rather than by any test failing.
 *
 * `consent_text_version` is the right key. It is fully under the test's control, it is NOT touched
 * by the purge (0034 clears only the personal columns), and a value this distinctive cannot
 * collide with a real signup — which stamps the live CONSENT_TEXT_VERSION.
 *
 * The number prefix is kept as a SECOND sweep, because a run that crashes before its first purge
 * leaves rows the version key would also catch, and belt-and-braces costs one statement.
 */
async function cleanup(): Promise<void> {
  // Send-log rows FIRST — the FK is ON DELETE SET NULL, so deleting consent rows first would
  // orphan them rather than fail loudly.
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (SELECT id FROM sms_consent WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  // Second sweep, for a run that crashed before stamping anything.
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE phone_number LIKE $1)`,
    [`${PREFIX}7%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}7%`]);
  // Catalogue fixtures, in FK order.
  await query(
    `DELETE FROM activity_occurrence WHERE series_id IN
       (SELECT id FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE name = $1))`,
    [TAG]
  );
  await query(
    `DELETE FROM activity_series WHERE source_id IN (SELECT id FROM source WHERE name = $1)`,
    [TAG]
  );
  await query(`DELETE FROM source WHERE name = $1`, [TAG]);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'stage-c-salt');
  // STUBBED HERE RATHER THAN RELIED ON FROM THE ENVIRONMENT. The first live run failed partly
  // because this secret was missing from .env.e2e.local — the same class of gap as Stage B's salt.
  // The Operator has since added it, but a suite that needs a secret should carry its own: an
  // ambient dependency is a failure that only appears on someone else's machine.
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'stage-c-preferences-secret');
  await cleanup();
  // The memo must not outlive the rows it points at — cleanup just deleted them.
  fixtureSeriesId = null;
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

async function subscriber(): Promise<{ id: string; phone: string }> {
  const phone = nextPhone();
  const created = await createPendingSubscriber(signup(phone), { dryRun: false });
  return { id: created.subscriberId as string, phone };
}

const activate = (id: string) =>
  query(`UPDATE sms_consent SET status='active', confirmed_timestamp=now() WHERE id=$1`, [id]);

/**
 * The source + series every fixture occurrence hangs off, created ONCE per run.
 *
 * ═══ WHY MEMOISED, WHICH IS THE SECOND HALF OF A TWO-PART BUG ═══
 * This used to insert a fresh source on every call, with `TAG` as a FIXED name — and
 * `idx_source_family_name_unique (family, name)` is real. So the second call collided, always,
 * independently of anything else. The first live run showed two failures and it was natural to
 * read them as one root cause (an aborted first call leaving a committed source behind); they are
 * genuinely two defects, and fixing only the CHECK below would have turned two failures into one.
 *
 * Sharing one series across occurrences is also the truer shape: a series HAS many occurrences,
 * which is exactly what `findLastWeek` reads back. Cleanup still keys on the fixed `TAG`, and now
 * has exactly one source row to find.
 */
let fixtureSeriesId: string | null = null;

async function fixtureSeries(): Promise<string> {
  if (fixtureSeriesId) return fixtureSeriesId;
  const [src] = await query<{ id: string }>(
    `INSERT INTO source (family, name) VALUES ('manual', $1) RETURNING id`,
    [TAG]
  );
  const [series] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
    ['Stage C Fixture Series', src.id]
  );
  fixtureSeriesId = series.id;
  return series.id;
}

/**
 * One live occurrence, returning its id and short_ref.
 *
 * ═══ `start_datetime_utc` IS NOT OPTIONAL ═══
 * `occurrence_has_time_or_open_hours CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS
 * NOT NULL)` is a real, pre-existing constraint: an occurrence is either a dated session or an
 * open-hours listing, and the schema refuses to hold one that is neither. The original helper
 * supplied neither and threw on its first call.
 *
 * A DATED SESSION rather than open hours, because that is the shape these tests are about — a
 * weekly pick with a day on it. `end_datetime_utc` is set too: not required by the CHECK, but an
 * hour-long session is the realistic row, and a fixture that is legal-but-impossible is how a test
 * ends up passing against data the product could never produce.
 */
async function occurrence(): Promise<{ id: string; shortRef: number }> {
  const seriesId = await fixtureSeries();
  const start = new Date('2026-08-29T17:00:00Z'); // the Saturday of the branch's canonical weekend
  const end = new Date('2026-08-29T18:00:00Z');
  const [occ] = await query<{ id: string; short_ref: string | number }>(
    `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, end_datetime_utc)
     VALUES ($1, $2, $3, $4)
     RETURNING id, short_ref`,
    [seriesId, 'Stage C Fixture Occurrence', start, end]
  );
  return { id: occ.id, shortRef: Number(occ.short_ref) };
}

describe('loadActiveSubscribers', () => {
  it('returns only ACTIVE subscribers, with the number beside the subscriber not on it', async () => {
    const active = await subscriber();
    await activate(active.id);
    const pending = await subscriber(); // never confirmed

    const rows = await loadActiveSubscribers();
    const mine = rows.filter((r) => r.phoneNumber.startsWith(`${PREFIX}7`));
    expect(mine.map((r) => r.subscriber.id)).toContain(active.id);
    expect(mine.map((r) => r.subscriber.id)).not.toContain(pending.id);

    const row = mine.find((r) => r.subscriber.id === active.id)!;
    expect(row.phoneNumber).toBe(active.phone);
    // The pure builder never sees a phone number — the type keeps it out.
    expect(Object.keys(row.subscriber)).not.toContain('phoneNumber');
    expect(row.subscriber.shortRef).toBeGreaterThan(0);
    expect(row.subscriber.preferencesToken).toBe(mintPreferencesToken(active.id));
  });

  it('🔴 EXCLUDES a purged row even if its status was left active', async () => {
    // `phone_number IS NOT NULL` is the load-bearing clause: the 30-day purge NULLs the personal
    // columns in place, so a purged subscriber still HAS a row. Trusting status alone would select
    // someone with no number and no postal code.
    const s = await subscriber();
    await activate(s.id);
    await query(
      `UPDATE sms_consent SET phone_number=NULL, postal_code=NULL, birth_years=NULL WHERE id=$1`,
      [s.id]
    );
    const rows = await loadActiveSubscribers();
    expect(rows.map((r) => r.subscriber.id)).not.toContain(s.id);
  });

  it('honours `limit` deterministically', async () => {
    // ORDER BY id, so a limit-capped first live run sends to exactly the first N and stops rather
    // than to N-ish depending on how the query planner felt.
    const a = await subscriber();
    const b = await subscriber();
    await activate(a.id);
    await activate(b.id);
    const one = await loadActiveSubscribers(1);
    expect(one).toHaveLength(1);
    const all = await loadActiveSubscribers();
    expect(all[0].subscriber.id).toBe(one[0].subscriber.id); // same first row both times
  });
});

describe('applyEmptyWeekState', () => {
  it('advances the counter and can pause', async () => {
    const s = await subscriber();
    await activate(s.id);
    await applyEmptyWeekState(s.id, { consecutiveEmptyWeeks: 3, status: 'paused', pausedNow: true, message: 'pause_notice' });
    const [row] = await query<{ consecutive_empty_weeks: number; status: string }>(
      `SELECT consecutive_empty_weeks, status FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(row.consecutive_empty_weeks).toBe(3);
    expect(row.status).toBe('paused');
  });

  it('🔴 REFUSES to resurrect someone who STOPPED mid-run', async () => {
    // The race the `AND status = 'active'` guard exists for: between loading the batch and writing
    // this row back, an inbound STOP webhook can land. Without the guard the Friday job would
    // quietly set them back to active or paused and text them next week.
    const s = await subscriber();
    await activate(s.id);
    await query(`UPDATE sms_consent SET status='stopped', stopped_at=now() WHERE id=$1`, [s.id]);
    await applyEmptyWeekState(s.id, { consecutiveEmptyWeeks: 1, status: 'active', pausedNow: false, message: 'empty_week' });
    const [row] = await query<{ status: string; consecutive_empty_weeks: number }>(
      `SELECT status, consecutive_empty_weeks FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(row.status).toBe('stopped'); // the inbound path wins
    expect(row.consecutive_empty_weeks).toBe(0); // and nothing else moved either
  });
});

describe('markStoppedViaCarrier', () => {
  it('stops them and stamps the purge clock once', async () => {
    const s = await subscriber();
    await activate(s.id);
    await markStoppedViaCarrier(s.id);
    const [first] = await query<{ status: string; stopped_at: Date }>(
      `SELECT status, stopped_at FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(first.status).toBe('stopped');

    // A second 21610 must NOT push the 30-day purge deadline out — a retention promise quietly
    // extended by a retry is the bug COALESCE prevents.
    await markStoppedViaCarrier(s.id);
    const [second] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(new Date(second.stopped_at).getTime()).toBe(new Date(first.stopped_at).getTime());
  });

  it('records the carrier verdict even from a PAUSED row', async () => {
    // Deliberately unguarded, unlike applyEmptyWeekState: the carrier has suppressed this number,
    // which is true whatever our row says. Refusing would leave us disagreeing with Twilio.
    const s = await subscriber();
    await query(`UPDATE sms_consent SET status='paused' WHERE id=$1`, [s.id]);
    await markStoppedViaCarrier(s.id);
    const [row] = await query<{ status: string }>(`SELECT status FROM sms_consent WHERE id=$1`, [s.id]);
    expect(row.status).toBe('stopped');
  });
});

describe('findByPreferencesToken', () => {
  it('resolves the token minted at signup', async () => {
    const s = await subscriber();
    const row = await findByPreferencesToken(mintPreferencesToken(s.id)!);
    expect(row?.id).toBe(s.id);
    expect(row?.postalCode).toBe('V5L 1A1');
    expect(row?.birthYears).toEqual([2021]);
    expect(row?.shortRef).toBeGreaterThan(0);
  });

  it('still resolves a PURGED row, so the honest page can render', async () => {
    // No `phone_number IS NOT NULL` clause on purpose: somebody who kept the link deserves "your
    // details are gone" rather than "this link is broken".
    const s = await subscriber();
    await query(
      `UPDATE sms_consent SET status='stopped', stopped_at=now(), phone_number=NULL,
                              postal_code=NULL, birth_years=NULL WHERE id=$1`,
      [s.id]
    );
    const row = await findByPreferencesToken(mintPreferencesToken(s.id)!);
    expect(row?.id).toBe(s.id);
    expect(row?.postalCode).toBeNull();
  });

  it('finds nothing for a token nobody holds', async () => {
    expect(await findByPreferencesToken('A'.repeat(43))).toBeNull();
  });
});

describe('findLastWeek', () => {
  it('reports the most recent attempt, whatever kind it was', async () => {
    const s = await subscriber();
    await recordSmsSend({
      subscriberId: s.id, phoneNumber: s.phone, sendType: 'empty_week', outcome: 'empty',
      picksSnapshot: null, twilioSid: 'SM_c_1', consentTextVersion: TEST_CONSENT_VERSION,
    });
    const week = await findLastWeek(s.id);
    // PRD §2.4 wants the empty and paused states shown too — they are the states a subscriber most
    // needs explained, and a blank panel reads as a bug.
    expect(week.kind).toBe('empty_week');
    expect(week.picks).toEqual([]);
    expect(week.sentAt).toBeInstanceOf(Date);
  });

  it('joins the catalogue for short refs, in rank order', async () => {
    const s = await subscriber();
    const occ = await occurrence();
    await recordSmsSend({
      subscriberId: s.id, phoneNumber: s.phone, sendType: 'weekly', outcome: 'sent',
      picksSnapshot: [{ occurrence_id: occ.id, rank: 1 }],
      twilioSid: 'SM_c_2', consentTextVersion: TEST_CONSENT_VERSION,
    });
    const week = await findLastWeek(s.id);
    expect(week.kind).toBe('weekly');
    // 'Stage C Fixture Occurrence' is the occurrence() helper's own activity_name (above) — the
    // fix this pins: the hub panel used to show "Activity 1" here regardless of what was sent.
    expect(week.picks).toEqual([
      {
        occurrenceId: occ.id,
        rank: 1,
        occurrenceShortRef: occ.shortRef,
        activityName: 'Stage C Fixture Occurrence',
      },
    ]);
  });

  it('🔴 KEEPS an archived pick in the panel, unattributed', async () => {
    // The snapshot is the record of what we SENT. A pick cancelled since must still be listed —
    // it just loses its attributed link and degrades to a plain activity link (round 15).
    const s = await subscriber();
    const occ = await occurrence();
    await query(`UPDATE activity_occurrence SET archived_at = now() WHERE id = $1`, [occ.id]);
    await recordSmsSend({
      subscriberId: s.id, phoneNumber: s.phone, sendType: 'weekly', outcome: 'sent',
      picksSnapshot: [{ occurrence_id: occ.id, rank: 1 }],
      twilioSid: 'SM_c_3', consentTextVersion: TEST_CONSENT_VERSION,
    });
    const week = await findLastWeek(s.id);
    expect(week.picks).toHaveLength(1);
    expect(week.picks[0].occurrenceShortRef).toBeNull();
    // Degrades in step with the ref — an archived occurrence has no live row to name itself
    // from either, so the page falls back to "Activity {rank}" rather than showing a stale name.
    expect(week.picks[0].activityName).toBeNull();
  });

  it('reports "none" for a subscriber who has never been sent anything', async () => {
    const s = await subscriber();
    expect(await findLastWeek(s.id)).toEqual({ kind: 'none', picks: [], sentAt: null });
  });
});

describe('applyPreferencesChange', () => {
  it('saves the three editable fields and resets the empty-week counter', async () => {
    const s = await subscriber();
    await query(`UPDATE sms_consent SET consecutive_empty_weeks=2 WHERE id=$1`, [s.id]);
    await applyPreferencesChange(
      {
        kind: 'save', subscriberId: s.id, postalCode: 'V7L 1A1',
        birthYears: [2015], categoryInterests: ['skate'], consecutiveEmptyWeeks: 0, status: null,
      },
      new Date()
    );
    const [row] = await query<Record<string, unknown>>(
      `SELECT postal_code, birth_years, category_interests, consecutive_empty_weeks, status
         FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(row.postal_code).toBe('V7L 1A1');
    expect(row.birth_years).toEqual([2015]);
    expect(row.category_interests).toEqual(['skate']);
    expect(row.consecutive_empty_weeks).toBe(0);
    expect(row.status).toBe('pending'); // status: null means leave it exactly as it was
  });

  it('un-pauses only when the decision asked for it', async () => {
    const s = await subscriber();
    await query(`UPDATE sms_consent SET status='paused', consecutive_empty_weeks=3 WHERE id=$1`, [s.id]);
    await applyPreferencesChange(
      {
        kind: 'save', subscriberId: s.id, postalCode: 'V5L 1A1',
        birthYears: [2021], categoryInterests: [], consecutiveEmptyWeeks: 0, status: 'active',
      },
      new Date()
    );
    const [row] = await query<{ status: string }>(`SELECT status FROM sms_consent WHERE id=$1`, [s.id]);
    expect(row.status).toBe('active');
  });

  it('unsubscribes without re-stamping an existing purge clock', async () => {
    const s = await subscriber();
    await applyPreferencesChange({ kind: 'unsubscribe', subscriberId: s.id, stoppedAt: 'set' }, new Date());
    const [first] = await query<{ status: string; stopped_at: Date }>(
      `SELECT status, stopped_at FROM sms_consent WHERE id=$1`, [s.id]
    );
    expect(first.status).toBe('stopped');
    await applyPreferencesChange(
      { kind: 'unsubscribe', subscriberId: s.id, stoppedAt: 'leave' },
      new Date(Date.now() + 60_000)
    );
    const [second] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id=$1`, [s.id]
    );
    expect(new Date(second.stopped_at).getTime()).toBe(new Date(first.stopped_at).getTime());
  });

  it('🔴 DELETE clears the personal data and KEEPS the audit row', async () => {
    // The row survives with its id, short_ref and consent metadata, because sms_send_log's FK
    // points at it and the CASL trail must outlive the personal data. This is the same shape the
    // scheduled purge performs; an explicit request just runs it early.
    const s = await subscriber();
    await recordSmsSend({
      subscriberId: s.id, phoneNumber: s.phone, sendType: 'welcome', outcome: 'sent',
      picksSnapshot: null, twilioSid: 'SM_c_del', consentTextVersion: TEST_CONSENT_VERSION,
    });

    await applyPreferencesChange({ kind: 'delete', subscriberId: s.id }, new Date());

    const [row] = await query<Record<string, unknown>>(
      `SELECT status, phone_number, postal_code, birth_years, category_interests,
              short_ref, consent_text_version, stopped_at
         FROM sms_consent WHERE id=$1`,
      [s.id]
    );
    expect(row.status).toBe('stopped');
    expect(row.phone_number).toBeNull();
    expect(row.postal_code).toBeNull();
    expect(row.birth_years).toBeNull();
    expect(row.category_interests).toBeNull();
    // Kept: the row itself, its short_ref, and which wording they consented to.
    expect(Number(row.short_ref)).toBeGreaterThan(0);
    expect(row.consent_text_version).toBe(TEST_CONSENT_VERSION);
    expect(row.stopped_at).not.toBeNull();

    // And the send row is still there, still attributed, still answerable by hash.
    const [log] = await query<{ subscriber_id: string; phone_hash: string }>(
      `SELECT subscriber_id, phone_hash FROM sms_send_log WHERE twilio_sid=$1`, ['SM_c_del']
    );
    expect(log.subscriber_id).toBe(s.id);
    expect(log.phone_hash).toBeTruthy();
  });
});
