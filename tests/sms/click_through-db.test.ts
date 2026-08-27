// tests/sms/click_through-db.test.ts — Stage D against a REAL database.
//
// The four click-through seams: resolve an occurrence short_ref, resolve a subscriber short_ref,
// recover which send a tap came from, and append the click. Between them they are the entire
// feedback loop for the Friday text — a text message reports no opens and no impressions, so a
// tap on a short link is the only signal the product ever gets back.
//
// ⚠ THE OPERATOR RUNS THIS LANE. Every statement was validated with EXPLAIN against the live
// schema (which plans without executing) and the unit lane covers the decision table with injected
// seams — but EXPLAIN shares this file's assumptions and the unit lane never touches Postgres, so
// a green run HERE is the only evidence that the SQL does what the comments claim.
//
// ═══ THIS FILE BUILDS ITS OWN CATALOGUE ROWS, AND CLEANS THEM UP ═══
// Same ephemeral per-test fixture pattern the Operator ruled on for Stage C, and the same
// source → activity_series → activity_occurrence chain, memoised at the source/series level
// because `idx_source_family_name_unique (family, name)` is real and a fixed tag collides on the
// second insert. Everything is deleted in afterAll, in FK order.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { recordSmsSend } from '@/lib/sms/send-log';
import {
  findOccurrenceIdByShortRef,
  findSubscriberIdByShortRef,
  findSendLogIdForClick,
  recordClick,
  resolveClickThrough,
  GONE_DESTINATION,
  activityPath,
} from '@/lib/sms/click-through';
import { encodeShortLink } from '@/lib/sms/short-link';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
/** Stamped on every consent/send row this suite creates, and the key its cleanup uses. */
const TEST_CONSENT_VERSION = 'test-stage-d';
const TAG = 'stage-d-db-fixture';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(8000 + seq++).padStart(4, '0')}`;

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
 * ═══ CLICK ROWS COME OUT FIRST, AND NOT BECAUSE THE FK DEMANDS IT ═══
 * 0036 gives `sms_click_event` three FKs with three different ON DELETE rules, and only one of
 * them would actually stop a careless teardown: `send_log_id` is plain NO ACTION, deliberately, so
 * that a delete against the append-only audit trail fails loudly. `subscriber_id` is SET NULL and
 * `occurrence_id` is CASCADE — so deleting consent rows or occurrences first would NOT error, it
 * would quietly mutate or silently remove click rows and leave the rest behind. Deleting clicks
 * first makes the order explicit rather than relying on which of the three fires.
 *
 * The cleanup key is `consent_text_version`, not the phone number, for the reason Stage C
 * discovered the hard way: these suites NULL `phone_number` on purpose to test the purge, so a
 * phone-keyed cleanup cannot see the rows those tests create. The number prefix is kept as a
 * second sweep for a run that crashed before stamping anything.
 */
async function cleanup(): Promise<void> {
  const testConsent = `SELECT id FROM sms_consent WHERE consent_text_version = $1`;
  await query(
    `DELETE FROM sms_click_event
      WHERE subscriber_id IN (${testConsent})
         OR send_log_id IN (SELECT id FROM sms_send_log WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (${testConsent})`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  // Second sweep for a crashed run.
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE phone_number LIKE $1)`,
    [`${PREFIX}8%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}8%`]);
  // Catalogue fixtures, in FK order. Click rows referencing these cascade, but they are already
  // gone above — this is the belt to that braces.
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

let fixtureSeriesId: string | null = null;

beforeAll(async () => {
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'stage-d-salt');
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'stage-d-short-link-secret');
  await cleanup();
  // The memo must not outlive the rows it points at — cleanup just deleted them.
  fixtureSeriesId = null;
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

async function fixtureSeries(): Promise<string> {
  if (fixtureSeriesId) return fixtureSeriesId;
  const [src] = await query<{ id: string }>(
    `INSERT INTO source (family, name) VALUES ('manual', $1) RETURNING id`,
    [TAG]
  );
  const [series] = await query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
    ['Stage D Fixture Series', src.id]
  );
  fixtureSeriesId = series.id;
  return series.id;
}

/**
 * One occurrence. `start_datetime_utc` is NOT decoration: 0004's
 * `occurrence_has_time_or_open_hours CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS
 * NOT NULL)` rejects a row without one, which is how Stage C's first live run failed.
 */
async function occurrence(archived = false): Promise<{ id: string; shortRef: number }> {
  const seriesId = await fixtureSeries();
  const [occ] = await query<{ id: string; short_ref: string | number }>(
    `INSERT INTO activity_occurrence
       (series_id, activity_name, start_datetime_utc, end_datetime_utc, archived_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, short_ref`,
    [
      seriesId,
      'Stage D Fixture Occurrence',
      new Date('2026-08-29T17:00:00Z'),
      new Date('2026-08-29T18:00:00Z'),
      archived ? new Date('2026-08-20T00:00:00Z') : null,
    ]
  );
  return { id: occ.id, shortRef: Number(occ.short_ref) };
}

async function subscriber(): Promise<{ id: string; shortRef: number; phone: string }> {
  const phone = nextPhone();
  const created = await createPendingSubscriber(signup(phone), { dryRun: false });
  const id = created.subscriberId as string;
  const [row] = await query<{ short_ref: string | number }>(
    `SELECT short_ref FROM sms_consent WHERE id = $1`,
    [id]
  );
  return { id, shortRef: Number(row.short_ref), phone };
}

/**
 * A real weekly send row carrying `picks_snapshot`, written through the real writer.
 *
 * `recordSmsSend` returns void, so the id has to be read back — and the read-back is keyed on a
 * unique marker in `twilio_sid`, NOT on `ORDER BY created_at DESC`. That matters: one test below
 * deliberately creates two sends for the same subscriber and asserts which one the ordering
 * picks, and a helper that ALSO depended on that ordering would make a real ordering bug and a
 * helper artefact indistinguishable. (`idx_sms_send_log_twilio_sid` is partial, not unique, so a
 * synthetic value here collides with nothing.)
 */
async function weeklySend(
  sub: { id: string; phone: string },
  occurrenceIds: string[]
): Promise<string> {
  const marker = `SM_stage_d_${seq++}`;
  await recordSmsSend({
    subscriberId: sub.id,
    phoneNumber: sub.phone,
    sendType: 'weekly',
    outcome: 'sent',
    picksSnapshot: occurrenceIds.map((occurrence_id, i) => ({ occurrence_id, rank: i + 1 })),
    twilioSid: marker,
    consentTextVersion: TEST_CONSENT_VERSION,
  });
  const [row] = await query<{ id: string }>(`SELECT id FROM sms_send_log WHERE twilio_sid = $1`, [
    marker,
  ]);
  return row.id;
}

const clickRows = (sendLogId: string) =>
  query<{ id: string; subscriber_id: string | null; occurrence_id: string; link_origin: string }>(
    `SELECT id, subscriber_id, occurrence_id, link_origin FROM sms_click_event
      WHERE send_log_id = $1`,
    [sendLogId]
  );

describe('findOccurrenceIdByShortRef', () => {
  it('resolves a live occurrence by its short_ref', async () => {
    const occ = await occurrence();
    expect(await findOccurrenceIdByShortRef(occ.shortRef)).toBe(occ.id);
  });

  it('returns null for an ARCHIVED occurrence — the load-bearing clause', async () => {
    // The whole reason `archived_at IS NULL` is in the query: a link minted three weeks ago can
    // point at a cancelled session, and redirecting a parent to it is worse than saying it is gone.
    const occ = await occurrence(true);
    expect(await findOccurrenceIdByShortRef(occ.shortRef)).toBeNull();
  });

  it('archiving an already-resolvable occurrence flips it to null', async () => {
    // The same row, before and after — so the previous test cannot pass for some reason other than
    // archived_at (a bad insert, say).
    const occ = await occurrence();
    expect(await findOccurrenceIdByShortRef(occ.shortRef)).toBe(occ.id);
    await query(`UPDATE activity_occurrence SET archived_at = now() WHERE id = $1`, [occ.id]);
    expect(await findOccurrenceIdByShortRef(occ.shortRef)).toBeNull();
  });

  it('returns null for a short_ref no row carries', async () => {
    expect(await findOccurrenceIdByShortRef(2_000_000_000)).toBeNull();
  });
});

describe('findSubscriberIdByShortRef', () => {
  it('resolves a subscriber by its short_ref', async () => {
    const sub = await subscriber();
    expect(await findSubscriberIdByShortRef(sub.shortRef)).toBe(sub.id);
  });

  it('STILL resolves after the 30-day purge NULLs the personal columns', async () => {
    // The documented property, and the reason this query has no `phone_number IS NOT NULL`: a
    // click is a fact about a message we sent, and it stays countable after their data goes.
    const sub = await subscriber();
    await query(
      `UPDATE sms_consent
          SET phone_number = NULL, postal_code = NULL, birth_years = NULL,
              category_interests = NULL
        WHERE id = $1`,
      [sub.id]
    );
    expect(await findSubscriberIdByShortRef(sub.shortRef)).toBe(sub.id);
  });

  it('STILL resolves a stopped subscriber — no status predicate', async () => {
    // Somebody who texted STOP can still tap a link from a message sent while they were active.
    const sub = await subscriber();
    await query(`UPDATE sms_consent SET status = 'stopped', stopped_at = now() WHERE id = $1`, [
      sub.id,
    ]);
    expect(await findSubscriberIdByShortRef(sub.shortRef)).toBe(sub.id);
  });

  it('returns null once the row is DELETED — the 90-day never-confirmed purge', async () => {
    const sub = await subscriber();
    await query(`DELETE FROM sms_consent WHERE id = $1`, [sub.id]);
    expect(await findSubscriberIdByShortRef(sub.shortRef)).toBeNull();
  });

  it('returns null for a short_ref no row carries', async () => {
    expect(await findSubscriberIdByShortRef(2_000_000_000)).toBeNull();
  });
});

describe('findSendLogIdForClick', () => {
  it('recovers the send whose picks_snapshot contains this occurrence', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    expect(await findSendLogIdForClick(sub.id, occ.id)).toBe(sendId);
  });

  it('matches an occurrence at any rank, not just the first', async () => {
    // Containment names only `occurrence_id`, so `rank` is not part of the test.
    const sub = await subscriber();
    const [a, b, c] = [await occurrence(), await occurrence(), await occurrence()];
    const sendId = await weeklySend(sub, [a.id, b.id, c.id]);
    expect(await findSendLogIdForClick(sub.id, c.id)).toBe(sendId);
  });

  it('returns null when the snapshot does not contain the occurrence', async () => {
    const sub = await subscriber();
    const inSend = await occurrence();
    const other = await occurrence();
    await weeklySend(sub, [inSend.id]);
    expect(await findSendLogIdForClick(sub.id, other.id)).toBeNull();
  });

  it('returns the MOST RECENT send when a recurring activity appears in several', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const older = await weeklySend(sub, [occ.id]);
    await query(`UPDATE sms_send_log SET created_at = now() - interval '7 days' WHERE id = $1`, [
      older,
    ]);
    const newer = await weeklySend(sub, [occ.id]);
    expect(await findSendLogIdForClick(sub.id, occ.id)).toBe(newer);
  });

  it('is SUBSCRIBER-SCOPED — another subscriber’s send never matches', async () => {
    const mine = await subscriber();
    const theirs = await subscriber();
    const occ = await occurrence();
    await weeklySend(theirs, [occ.id]);
    expect(await findSendLogIdForClick(mine.id, occ.id)).toBeNull();
  });

  it('ignores a non-weekly row, which carries no snapshot at all', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    await recordSmsSend({
      subscriberId: sub.id,
      phoneNumber: sub.phone,
      sendType: 'empty_week',
      outcome: 'empty',
      picksSnapshot: null,
      twilioSid: null,
      consentTextVersion: TEST_CONSENT_VERSION,
    });
    expect(await findSendLogIdForClick(sub.id, occ.id)).toBeNull();
  });

  /**
   * ═══ THE PREDICATE THE CURRENT WRITER CAN NEVER EXERCISE ═══
   * weekly-send-io.ts passes `picksSnapshot: null` on its 'failed' and 'stopped_via_carrier'
   * branches, so `recordSmsSend` cannot produce the row this test needs — it is written with raw
   * SQL on purpose. 0035's CHECK permits it (it constrains send_type, not outcome), so the only
   * thing standing between us and this row is one module's discipline.
   *
   * The failure it pins is not "a stray row matches": it is that `ORDER BY created_at DESC` would
   * make the UNDELIVERED row WIN over the real earlier send carrying the same activity — a phantom
   * click on a message nobody received AND a missing click on the message they actually tapped.
   * Hence the assertion is not `toBeNull()` but `toBe(delivered)`.
   */
  it('EXCLUDES a weekly row whose send failed, even though it is the most recent', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const delivered = await weeklySend(sub, [occ.id]);
    await query(
      `UPDATE sms_send_log SET created_at = now() - interval '7 days' WHERE id = $1`,
      [delivered]
    );
    await query(
      `INSERT INTO sms_send_log
         (subscriber_id, phone_hash, send_type, picks_snapshot, outcome, consent_text_version)
       VALUES ($1, 'stage-d-fake-hash', 'weekly', $2::jsonb, 'failed', $3)`,
      [sub.id, JSON.stringify([{ occurrence_id: occ.id, rank: 1 }]), TEST_CONSENT_VERSION]
    );
    expect(await findSendLogIdForClick(sub.id, occ.id)).toBe(delivered);
  });
});

describe('recordClick', () => {
  it('appends a row with all four columns', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    await recordClick({
      subscriberId: sub.id,
      sendLogId: sendId,
      occurrenceId: occ.id,
      linkOrigin: 'direct',
    });
    const rows = await clickRows(sendId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subscriber_id: sub.id,
      occurrence_id: occ.id,
      link_origin: 'direct',
    });
  });

  it("persists link_origin 'hub' — PRD §6's direct-vs-hub split depends on it", async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    await recordClick({
      subscriberId: sub.id,
      sendLogId: sendId,
      occurrenceId: occ.id,
      linkOrigin: 'hub',
    });
    expect((await clickRows(sendId))[0].link_origin).toBe('hub');
  });

  it('does NOT deduplicate — two taps on the same pick are two rows', async () => {
    // 0036 leaves (send_log_id, occurrence_id) non-unique deliberately; a unique index here would
    // turn a click LOG into a click FLAG.
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    const event = {
      subscriberId: sub.id,
      sendLogId: sendId,
      occurrenceId: occ.id,
      linkOrigin: 'direct' as const,
    };
    await recordClick(event);
    await recordClick(event);
    expect(await clickRows(sendId)).toHaveLength(2);
  });

  it('a purged subscriber keeps the click but loses the attribution (ON DELETE SET NULL)', async () => {
    // 0036's stated bargain: the aggregate engagement record must survive a deletion, the
    // attribution need not. Worth pinning because it is the one FK of the three that silently
    // MUTATES rather than erroring or cascading.
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    await recordClick({
      subscriberId: sub.id,
      sendLogId: sendId,
      occurrenceId: occ.id,
      linkOrigin: 'direct',
    });
    await query(`DELETE FROM sms_consent WHERE id = $1`, [sub.id]);
    const rows = await clickRows(sendId);
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriber_id).toBeNull();
  });
});

describe('resolveClickThrough with the REAL seams end to end', () => {
  it('a genuine tap redirects to the activity AND writes exactly one click row', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    const token = encodeShortLink(occ.shortRef, sub.shortRef);

    const result = await resolveClickThrough(token, { linkOrigin: 'hub' });

    expect(result.outcome).toBe('redirect');
    expect(result.destination).toBe(activityPath(occ.id));
    expect(result.clickLogged).toBe(true);
    const rows = await clickRows(sendId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_id: occ.id, link_origin: 'hub' });
  });

  it('an archived activity sends them to /activity-unavailable and writes nothing', async () => {
    const sub = await subscriber();
    const occ = await occurrence();
    const sendId = await weeklySend(sub, [occ.id]);
    await query(`UPDATE activity_occurrence SET archived_at = now() WHERE id = $1`, [occ.id]);

    const result = await resolveClickThrough(encodeShortLink(occ.shortRef, sub.shortRef));

    expect(result.outcome).toBe('occurrence_gone');
    expect(result.destination).toBe(GONE_DESTINATION);
    expect(result.clickLogged).toBe(false);
    expect(await clickRows(sendId)).toHaveLength(0);
  });

  it('no recoverable send still REDIRECTS, just uncounted — the dry-run case', async () => {
    // A dry-run send writes no log row at all, which is exactly the state this reproduces.
    const sub = await subscriber();
    const occ = await occurrence();

    const result = await resolveClickThrough(encodeShortLink(occ.shortRef, sub.shortRef));

    expect(result.outcome).toBe('redirect');
    expect(result.destination).toBe(activityPath(occ.id));
    expect(result.clickLogged).toBe(false);
  });
});
