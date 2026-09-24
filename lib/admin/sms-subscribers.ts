// lib/admin/sms-subscribers.ts — the read model behind /admin/sms-subscribers.
//
// Server-only: uses the shared service-level pg pool via lib/db/client, the same way
// lib/admin/dashboard.ts and lib/admin/data-health.ts do. Nothing here is importable from a
// client component, and nothing here should ever be.
//
// ═══ THIS MODULE HANDLES REAL PHONE NUMBERS, WHICH MAKES TWO THINGS NON-NEGOTIABLE ═══
// 1. Its only caller is a page behind app/admin/_lib/gate.ts. There is no API route over it.
// 2. It never writes a phone number into an error, a log line or a thrown message. A failure
//    here must be diagnosable from the subscriber id alone, because ids are safe to put in
//    Sentry and numbers are not.
//
// ═══ NULL PHONE NUMBER IS NOT A BUG, IT IS THE RETENTION PROMISE ═══
// sms_consent's personal columns are all nullable so the 30-day post-stop purge can erase them
// IN PLACE, keeping the CASL consent record (status, timestamps, version) while destroying the
// personal data. So a purged row is a normal, expected row with phone_number IS NULL. That is
// surfaced as an explicit `purged` flag rather than left for the UI to infer from a null,
// because "we deleted this on purpose" and "something went wrong" must never look the same on
// an admin screen.
import { query } from '@/lib/db/client';
import { agesFromBirthYears } from '@/lib/sms/signup-validate';
import { EM_DASH } from '@/lib/admin/format';
import { REDACTED_TEXT, shouldRedact, type PersonalDataOptions } from '@/lib/admin/personal-data';

export { REDACTED_TEXT };

/** Hard cap on the list page. Raise deliberately; an unbounded admin table is a slow page. */
export const SMS_SUBSCRIBER_LIST_LIMIT = 500;

export interface SmsSubscriberListRow {
  id: string;
  /** 0034's compact alias — bigint identity, database-issued, safe to display. */
  shortRef: string;
  /** E.164, or null when the retention purge has erased it. See `purged`. */
  phoneNumber: string | null;
  /** True when the personal data has been erased by the 30-day post-stop purge. */
  purged: boolean;
  /**
   * True when the CALLER may not see personal data (a 'viewer' admin — lib/db/admin-guard.ts
   * canSeePersonalData). The query then returned NULL for phoneNumber, postalCode and birthYears
   * — the values never left the database — and `purged` / `childCount` were computed in SQL so the
   * page can still say something true without them.
   */
  redacted: boolean;
  /**
   * How many birth years are stored (null when purged/never given). Carried for the redacted view,
   * which may state "2 children" but not their ages; unredacted rows carry it too.
   */
  childCount: number | null;
  /**
   * The FULL postal code, or null when the retention purge has erased it. See `purged`.
   *
   * ═══ FULL, NOT FSA-TRUNCATED — AND THAT IS A DIFFERENT CALL FROM THE ONE NEXT DOOR ═══
   * Two neighbouring surfaces deliberately cut this to the FSA (first three characters), so the
   * deviation is stated here rather than left to look like an oversight:
   *   lib/admin/sms-engagement.ts groups BY fsa, because a household-level identifier is not a
   *     metric dimension — an aggregate keyed on a full postal code is a re-identifiable cohort.
   *   scripts/friday-preview-real-subscribers.ts prints the FSA because its output is RELAYED
   *     onward (script → agent → Operator → chat), where the value outlives the gate it was read
   *     behind and lands somewhere with no gate at all.
   * Neither reason reaches this module. This is a gated, server-rendered, noindex row about ONE
   * subscriber an admin already drilled into — on the same page that renders their full E.164
   * phone number, which is a strictly stronger identifier. Truncating the weaker one beside the
   * stronger one would buy nothing and would withhold what the console exists to answer: where
   * this subscriber is, and therefore why they were sent the picks they were sent.
   */
  postalCode: string | null;
  /**
   * One birth YEAR per child, exactly as stored — never an age. Migration 0034 holds a year on
   * purpose: a stored age is wrong the moment a birthday passes, a stored year never is.
   *
   * NULL AND EMPTY ARE DIFFERENT FACTS and are kept apart. Null on a purged row means erased;
   * empty means the parent gave no ages. Render via {@link displayChildAges}, which resolves the
   * three cases rather than letting a blank cell stand for all of them.
   */
  birthYears: number[] | null;
  /**
   * Confirmed by a JOIN that arrived at a test handset's number (migration 0042).
   *
   * SURFACED, NOT FILTERED — Operator's ruling, 2026-09-03. This list is ground truth: an admin
   * reading it should see every row that exists, with the test ones marked. Filtering them would
   * make the page disagree with the database and give no signal it was doing so. A METRIC surface
   * is the opposite case and defaults to EXCLUDING them — see lib/admin/sms-engagement.ts. Two
   * surfaces, two different right answers, and the difference is deliberate.
   */
  isTest: boolean;
  status: string;
  consentMethod: string;
  consentTimestamp: string | null;
  confirmedTimestamp: string | null;
  consecutiveEmptyWeeks: number;
  stoppedAt: string | null;
}

export interface SmsSubscriberSummary {
  total: number;
  active: number;
  pending: number;
  paused: number;
  stopped: number;
  purged: number;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// RENDERING A PERSONAL COLUMN, WHERE "EMPTY" HAS THREE DIFFERENT MEANINGS
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// phone_number established the rule this section generalises: a null personal column is not one
// fact, and an admin screen that prints one blank cell for all of them is lying by omission.
// There are three, and they need three different words:
//
//   purged   the 30-day post-stop retention purge erased it ON PURPOSE. lib/retention/sms.ts
//            NULLs phone_number, postal_code, birth_years and category_interests in the SAME
//            statement, which is why the existing `purged` flag (derived from phone_number)
//            is authoritative for these two new columns as well and no second probe is needed.
//   absent   the subscriber never gave it. Nothing was lost; nothing is wrong.
//   present  a value.
//
// Resolved here, once, as pure functions over the read model, rather than as a conditional
// repeated in each page's JSX — two pages rendering the same tri-state from two hand-written
// ternaries is exactly how they drift into disagreeing about what a blank cell means.
export interface PersonalDisplay {
  /** The text to print. */
  text: string;
  /** True when `text` EXPLAINS an absence rather than stating a value, so the UI can grey it. */
  muted: boolean;
}

/** What to print in a postal-code cell. Full value — see {@link SmsSubscriberListRow.postalCode}. */
export function displayPostalCode(
  row: Pick<SmsSubscriberListRow, 'purged' | 'postalCode' | 'redacted'>
): PersonalDisplay {
  if (row.purged) return { text: 'purged', muted: true };
  if (row.redacted) return { text: REDACTED_TEXT, muted: true };
  if (!row.postalCode) return { text: EM_DASH, muted: true };
  return { text: row.postalCode, muted: false };
}

/**
 * What to print in a child-ages cell, at `now`.
 *
 * ═══ THE AGE MATH IS BORROWED, NOT REWRITTEN, AND THAT IS THE WHOLE POINT ═══
 * `agesFromBirthYears` (lib/sms/signup-validate.ts) is the SAME function the no-login preferences
 * hub and the welcome text use — the two surfaces that show a PARENT their own numbers. It reads
 * the current year in America/Vancouver rather than UTC, so it does not disagree with itself on
 * the evening of December 31st. Reimplementing `currentYear - birthYear` here would work all year
 * and then be wrong for one evening, on the one screen used to answer "why did they get that?".
 *
 * It also means this page states the age the PICKER used and the age the parent was shown. A
 * range like "4–5" would be defensible in the abstract — we hold a year, not a month — but it
 * would put a third, different number on a third screen, and `ageBandsFromBirthYears` does not
 * band on a range either. PRD §1.2 accepts the imprecision in exchange for never asking a parent
 * for a minor's date of birth; it must not be "fixed" here by inventing a month.
 *
 * A year that cannot become a plausible age is shown RAW rather than dropped. The shared helper
 * discards it (a parent should not read "age -1"), but an admin is precisely the reader who needs
 * to see that the row holds something unreadable — hiding it here would erase the only signal.
 *
 * ═══ THAT APPLIES PER-YEAR, NOT ONLY WHEN EVERY YEAR IS BAD (QA N1, 2026-09-18) ═══
 * The first version of this function only honoured the rule above when the helper returned
 * NOTHING, so a household stored as [2021, 3000] rendered a confident, unmuted "5" and the second
 * child simply vanished. That is the worse half of the bug, not the lesser one: an all-bad row at
 * least looks wrong, whereas a partially-bad row looks perfectly normal and silently under-reports
 * how many children we hold. It also contradicted this very comment, which is how QA found it.
 *
 * The dropped COUNT is derived as `stored.length - ages.length`. `agesFromBirthYears` maps then
 * filters, so that subtraction is exact — and, deliberately, it does not restate the helper's
 * ">= 0" predicate here. Re-deriving WHICH years were rejected would mean owning a second copy of
 * that rule, which is the drift this module keeps refusing to introduce. The parenthetical prints
 * every stored year verbatim instead, which tells an admin strictly more and duplicates nothing.
 *
 * Left UNMUTED: the cell now states a real age as well as flagging a problem, and `muted` means
 * "this text explains an absence". Greying it would de-emphasise the one row worth looking at.
 */
export function displayChildAges(
  row: Pick<SmsSubscriberListRow, 'purged' | 'birthYears' | 'redacted' | 'childCount'>,
  now: Date
): PersonalDisplay {
  if (row.purged) return { text: 'purged', muted: true };
  if (row.redacted) {
    // A count is not an age. It lets a viewer see that the row is populated without learning a
    // single child's age or birth year.
    const n = row.childCount ?? 0;
    if (n === 0) return { text: EM_DASH, muted: true };
    return { text: `${n} ${n === 1 ? 'child' : 'children'} · ${REDACTED_TEXT}`, muted: true };
  }
  const stored = row.birthYears ?? [];
  if (stored.length === 0) return { text: EM_DASH, muted: true };
  const ages = agesFromBirthYears(stored, now);
  // Nothing survived: there is no age to state, so the whole cell is the explanation.
  if (ages.length === 0) return { text: `unreadable (${stored.join(', ')})`, muted: true };
  const dropped = stored.length - ages.length;
  if (dropped > 0) {
    return {
      text: `${ages.join(', ')} · ${dropped} unreadable (stored ${stored.join(', ')})`,
      muted: false,
    };
  }
  return { text: ages.join(', '), muted: false };
}

/**
 * Count every subscriber by status, plus how many have been purged.
 *
 * Computed from the SAME rows the table renders rather than a separate COUNT query, so the tiles
 * and the table can never disagree about what is on screen — the failure mode where a summary
 * says 12 active and the list below it shows 11 because the two ran seconds apart.
 */
export function summariseSubscribers(rows: readonly SmsSubscriberListRow[]): SmsSubscriberSummary {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    paused: rows.filter((r) => r.status === 'paused').length,
    stopped: rows.filter((r) => r.status === 'stopped').length,
    purged: rows.filter((r) => r.purged).length,
  };
}

/**
 * The personal columns, NULLed in SQL when the redact parameter is true — so for a redacted caller
 * the values never leave the database. `purged` and `child_count` are computed from the real
 * columns first, so the row can still say "purged" / "2 children" truthfully. Shared by the list
 * and the detail query so the two cannot disagree about what a viewer gets.
 */
function personalColumnsSql(redactParam: string): string {
  return `
      CASE WHEN ${redactParam} THEN NULL ELSE c.phone_number END AS phone_number,
      CASE WHEN ${redactParam} THEN NULL ELSE c.postal_code END AS postal_code,
      CASE WHEN ${redactParam} THEN NULL ELSE c.birth_years END AS birth_years,
      (c.phone_number IS NULL) AS purged,
      cardinality(c.birth_years) AS child_count`;
}

/** Every subscriber, newest consent first. */
export async function getSmsSubscribers(opts: PersonalDataOptions): Promise<SmsSubscriberListRow[]> {
  const redact = shouldRedact(opts);
  const rows = await query<{
    id: string;
    short_ref: string | number;
    phone_number: string | null;
    postal_code: string | null;
    birth_years: number[] | null;
    purged: boolean;
    child_count: number | null;
    status: string;
    consent_method: string;
    is_test: boolean;
    consent_timestamp: Date | null;
    confirmed_timestamp: Date | null;
    consecutive_empty_weeks: number;
    stopped_at: Date | null;
  }>(
    `
    SELECT
      c.id,
      c.short_ref,${personalColumnsSql('$2::boolean')},
      c.is_test,
      c.status,
      c.consent_method,
      c.consent_timestamp,
      c.confirmed_timestamp,
      c.consecutive_empty_weeks,
      c.stopped_at
    FROM sms_consent c
    ORDER BY c.consent_timestamp DESC
    LIMIT $1::int
    `,
    [SMS_SUBSCRIBER_LIST_LIMIT, redact]
  );
  return rows.map((r) => ({
    id: r.id,
    // pg returns bigint as a string to avoid precision loss; normalise either shape.
    shortRef: String(r.short_ref),
    phoneNumber: r.phone_number,
    purged: r.purged,
    redacted: redact,
    childCount: r.child_count === null ? null : Number(r.child_count),
    postalCode: r.postal_code,
    birthYears: r.birth_years,
    isTest: r.is_test,
    status: r.status,
    consentMethod: r.consent_method,
    consentTimestamp: toIso(r.consent_timestamp),
    confirmedTimestamp: toIso(r.confirmed_timestamp),
    consecutiveEmptyWeeks: Number(r.consecutive_empty_weeks),
    stoppedAt: toIso(r.stopped_at),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PAGE 2 — ONE SUBSCRIBER'S FULL SEND HISTORY
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Jon ruled for the more complete option: show the phone_hash-keyed history too, not only the
// rows still pointed at by subscriber_id.
//
// ═══ WHY BOTH KEYS ARE NEEDED, WHICH IS NOT THE REASON IT FIRST APPEARS ═══
// The obvious story is "subscriber_id goes away when a subscriber is purged, so fall back to the
// hash." That is not what happens. There are TWO different erasures in this system:
//
//   30-day post-stop purge   UPDATEs the personal columns to NULL and KEEPS the row. So
//                            subscriber_id still resolves, and the id-linked history is intact.
//   90-day never-confirmed   DELETEs the sms_consent row. ON DELETE SET NULL then nulls
//                            subscriber_id on the log rows — but that subscriber has no page-1
//                            row to drill into either, so this page never sees them.
//
// What the hash key ACTUALLY recovers is a re-signup: the same phone number consenting again gets
// a NEW sms_consent row with a NEW id, while its earlier send_log rows still carry the old id (or
// none). Those rows are the same person, and only phone_hash says so. Asking "what happened to
// this person" and getting only the current row's slice is the incomplete answer Jon rejected.
//
// ═══ AND WHERE THE HASH COMES FROM, WHICH IS THE PART WITH A TRAP IN IT ═══
// A purged subscriber's phone_number is NULL, so phoneHash() CANNOT be recomputed for them — the
// input was destroyed on purpose. The hash is instead read back off their OWN surviving log rows
// (reachable by subscriber_id, per the first bullet above) and used to find the rest. For a
// non-purged subscriber the hash is also computed from the number directly, which catches the one
// case the first path cannot: a re-signup that has not been texted yet, so has no rows of its own
// to read a hash from.
//
// ═══ THE HASH IS NEVER RETURNED FROM THIS MODULE ═══
// SMS_PHONE_HASH_SALT is a single GLOBAL salt (lib/sms/config.ts), and phone numbers are a small
// enough keyspace that a hash under one global salt is guess-and-checkable. So it is used inside
// the query and never crosses this boundary: no field of SmsSubscriberDetail contains it, there is
// no lookup-by-number entry point, and the page has no search box. The drill-down starts from a
// row an admin already has.
import { phoneHash } from '@/lib/sms/phone-hash';

/** Hard cap on one subscriber's history. */
export const SMS_SEND_HISTORY_LIMIT = 500;

export interface SmsSendLogRow {
  id: string;
  sendType: string;
  outcome: string;
  twilioSid: string | null;
  deliveryStatus: string | null;
  createdAt: string | null;
  /** False when this row is reachable only by phone_hash — an earlier signup of the same number. */
  linkedToThisRow: boolean;
}

export interface SmsSubscriberDetail {
  subscriber: SmsSubscriberListRow;
  sends: SmsSendLogRow[];
  /** True when the retention purge has erased the personal data behind this consent record. */
  purged: boolean;
}

export async function getSmsSubscriberDetail(
  id: string,
  opts: PersonalDataOptions
): Promise<SmsSubscriberDetail | null> {
  const redact = shouldRedact(opts);
  const [row] = await query<{
    id: string;
    short_ref: string | number;
    phone_number: string | null;
    postal_code: string | null;
    birth_years: number[] | null;
    purged: boolean;
    child_count: number | null;
    status: string;
    consent_method: string;
    is_test: boolean;
    consent_timestamp: Date | null;
    confirmed_timestamp: Date | null;
    consecutive_empty_weeks: number;
    stopped_at: Date | null;
  }>(
    `SELECT c.id, c.short_ref, c.is_test, c.status, c.consent_method, c.consent_timestamp,
            c.confirmed_timestamp, c.consecutive_empty_weeks, c.stopped_at,${personalColumnsSql('$2::boolean')}
       FROM sms_consent c WHERE c.id = $1::uuid`,
    [id, redact]
  );
  if (!row) return null;

  // Null when the number is purged (nothing to hash) or the salt is unset. Both are handled by
  // the query, which falls back to the hashes carried on this subscriber's own rows.
  //
  // For a REDACTED caller the row above does not carry the number, so it is read separately,
  // hashed immediately and never returned — it reaches no caller, no render and no log. The send
  // HISTORY a viewer sees is therefore the same one an admin sees.
  const phoneForHash = redact ? await readPhoneForHashOnly(id) : row.phone_number;
  const currentHash = phoneForHash ? phoneHash(phoneForHash) : null;

  const sends = await query<{
    id: string;
    send_type: string;
    outcome: string;
    twilio_sid: string | null;
    delivery_status: string | null;
    created_at: Date | null;
    linked: boolean;
  }>(
    `
    WITH own_hashes AS (
      SELECT DISTINCT phone_hash FROM sms_send_log WHERE subscriber_id = $1::uuid
    )
    SELECT l.id, l.send_type, l.outcome, l.twilio_sid, l.delivery_status, l.created_at,
           (l.subscriber_id = $1::uuid) AS linked
      FROM sms_send_log l
     WHERE l.subscriber_id = $1::uuid
        OR l.phone_hash IN (SELECT phone_hash FROM own_hashes)
        OR ($2::text IS NOT NULL AND l.phone_hash = $2::text)
     ORDER BY l.created_at DESC
     LIMIT $3::int
    `,
    [id, currentHash, SMS_SEND_HISTORY_LIMIT]
  );

  return {
    subscriber: {
      id: row.id,
      shortRef: String(row.short_ref),
      phoneNumber: row.phone_number,
      purged: row.purged,
      redacted: redact,
      childCount: row.child_count === null ? null : Number(row.child_count),
      postalCode: row.postal_code,
      birthYears: row.birth_years,
      isTest: row.is_test,
      status: row.status,
      consentMethod: row.consent_method,
      consentTimestamp: toIso(row.consent_timestamp),
      confirmedTimestamp: toIso(row.confirmed_timestamp),
      consecutiveEmptyWeeks: Number(row.consecutive_empty_weeks),
      stoppedAt: toIso(row.stopped_at),
    },
    sends: sends.map((s) => ({
      id: s.id,
      sendType: s.send_type,
      outcome: s.outcome,
      twilioSid: s.twilio_sid,
      deliveryStatus: s.delivery_status,
      createdAt: toIso(s.created_at),
      linkedToThisRow: Boolean(s.linked),
    })),
    purged: row.purged,
  };
}

/** See getSmsSubscriberDetail: the number, for hashing only. Never returned from this module. */
async function readPhoneForHashOnly(id: string): Promise<string | null> {
  const [r] = await query<{ phone_number: string | null }>(
    `SELECT phone_number FROM sms_consent WHERE id = $1::uuid`,
    [id]
  );
  return r?.phone_number ?? null;
}
