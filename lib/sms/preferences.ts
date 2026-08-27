// lib/sms/preferences.ts — the no-login preferences / hub page (PRD §2.4).
//
// DRAFT (SMS pivot). Pure decisions + stubbed reads and writes, the same shape as
// lib/sms/consent-transitions.ts: `decide*` functions are total over the row they are handed, the
// database is two injected seams, and the page and route are thin transport over this.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// THIS PAGE IS NOT THE CLICK-THROUGH ROUTE, AND THE DIFFERENCE IS THE WHOLE SECURITY STORY
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// `/s/[shortId]` reads a token, resolves a public catalogue row and redirects. It reveals nothing
// and changes nothing. This page does BOTH of the things that one does not:
//
//   IT RENDERS PERSONAL DATA — a postal code and the ages of somebody's children.
//   IT MUTATES CONSENT STATE — edit, unsubscribe, delete.
//
// So "the token is the authorization" (true for both) carries far more weight here, and the
// consequences shape six decisions in this file and the route:
//
//   1. THE TOKEN IS IN THE URL, which is the weakest place to keep a credential. URLs go into
//      browser history, into `Referer` headers, into server and proxy logs, into screenshots, and
//      into whatever the parent forwards to their partner. Nothing here can stop most of that —
//      it is inherent to a no-login link in a text message, and CASL positively WANTS the
//      unsubscribe to be that frictionless. What CAN be stopped is us making it worse:
//      `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex` are
//      set on the page for exactly this. See the route/page for each.
//   2. THE LOOKUP IS EXACT-MATCH ON A UNIQUE COLUMN, so a wrong-but-well-formed token resolves to
//      NOTHING rather than to a neighbouring row. That is a property of the query, not of care,
//      and tests/sms/preferences.test.ts proves it against a store holding several subscribers.
//   3. NO ENUMERATION SURFACE. Every failure — never existed, purged, malformed — produces one
//      identical outcome. There is no "that token looked close" and no distinguishable timing
//      branch before the lookup.
//   4. MUTATIONS ARE POST-ONLY and go through their own route, so no mutation can be triggered by
//      a GET — which matters because this URL is exactly the kind of thing that gets prefetched
//      by a messaging client (the same prefetch risk round 6 flagged for CTR would otherwise be
//      unsubscribing people).
//   5. STATE TRANSITIONS ARE GUARDED BY THE CURRENT STATE, not just by holding the token. A save
//      can un-pause but can never resurrect a `stopped` subscriber — see `decideSave`.
//   6. THE PHONE NUMBER IS NEVER RENDERED OR RETURNED. It is the one field a leaked link would
//      turn into a contactable identity, and the page has no need of it.
//
// WHAT I AM NOT CONFIDENT ABOUT, flagged rather than shipped quietly: there is no rate limiting
// on this endpoint, and this branch has no infrastructure to add any. See §ah of the feasibility
// notes.

import {
  decideStop,
  type ConsentRow,
  type ConsentStatus,
} from './consent-transitions';
import {
  agesFromBirthYears,
  parseProfileFields,
  type ProfileFields,
  type SmsSignupField,
} from './signup-validate';
import { query } from '@/lib/db/client';
import { activityPath, hubClickPath } from './click-through';
import { encodeShortLink } from './short-link';

/** The `sms_consent` columns this page reads. NO phone number — see point 6 in the header. */
export interface PreferencesRow extends ConsentRow {
  postalCode: string | null;
  birthYears: number[] | null;
  categoryInterests: string[] | null;
  consecutiveEmptyWeeks: number;
  /**
   * `sms_consent.short_ref` — the subscriber half of a click-through token (PRD §2.3).
   *
   * Read here ONLY so the hub's own pick links can be minted through `/s/{token}`, which is what
   * makes a hub tap attributable at all. It is an internal counter, not personal data, and it
   * never reaches `PreferencesView`: the view carries the finished href and nothing else.
   * Nullable so a row read before 0037's backfill degrades to an unattributed link rather than
   * throwing on the one page a parent uses to unsubscribe.
   */
  shortRef: number | null;
}

/**
 * One line of last week's picks as READ — `picks_snapshot` plus the occurrence's `short_ref`.
 *
 * `occurrenceShortRef` is not in the snapshot itself (0035 stores `[{occurrence_id, rank}]`), so
 * `findLastWeek` joins for it. Nullable per pick: an occurrence archived since the send has no
 * live row to join to, and that must degrade one link rather than fail the panel.
 */
export interface PreferencesPick {
  occurrenceId: string;
  rank: number;
  occurrenceShortRef: number | null;
}

/**
 * One line of last week's picks as RENDERED. Carries the finished href and no internal reference
 * of any kind — see `PreferencesView`'s own note about what it deliberately does not contain.
 */
export interface PreferencesViewPick {
  occurrenceId: string;
  rank: number;
  /** `/s/{token}?via=hub`, or the bare activity path when no token could be minted. */
  href: string;
  /**
   * False when this link fell back to the unattributed `/activity/{id}` path. Surfaced rather
   * than hidden: an unattributed hub link is a click PRD §6 will never see, and a panel silently
   * full of them is the exact failure this round exists to end.
   */
  attributed: boolean;
}

/** What the most recent weekly attempt produced — mirrors `sms_send_log.send_type`. */
export type LastWeekKind = 'weekly' | 'empty_week' | 'pause_notice' | 'none';

export interface LastWeek {
  kind: LastWeekKind;
  picks: PreferencesPick[];
  sentAt: Date | null;
}

export interface LastWeekView {
  kind: LastWeekKind;
  picks: PreferencesViewPick[];
  sentAt: Date | null;
}

// ── The stubbed seams ───────────────────────────────────────────────────────────────────

/**
 * `sms_consent.preferences_token` → the row. STUB.
 *
 * TODO:
 *   SELECT id, status, stopped_at, postal_code, birth_years, category_interests,
 *          consecutive_empty_weeks
 *     FROM sms_consent
 *    WHERE preferences_token = $1
 *
 * UNLIKE THE SHORT LINK, THIS TOKEN IS STORED, NOT DERIVED. `decodeShortLink` verifies an HMAC
 * and needs no database to reject a forgery; this is a plain equality match against 0034's unique
 * partial index. Two consequences worth stating:
 *
 *   • THE TOKEN'S ENTROPY IS ENTIRELY A PROPERTY OF HOW IT WAS MINTED. There is no check value to
 *     fall back on. lib/sms/signup-store.ts's TODO mints it as a full HMAC-SHA256 over the row id
 *     — 256 bits, base64url — and it MUST NOT be truncated the way the short-link token
 *     deliberately is. A short link's 20-bit check protects public catalogue data; this token
 *     protects a child's age.
 *   • `phone_number IS NOT NULL` IS DELIBERATELY ABSENT. A purged-but-not-deleted row still has a
 *     token, and a subscriber who kept the link should still see an honest "you have unsubscribed
 *     and your details are gone" page rather than a dead end. The row's own `status` says what to
 *     render; the query does not need to pre-judge it.
 */
export type PreferencesLookup = (token: string) => Promise<PreferencesRow | null>;

export const findByPreferencesToken: PreferencesLookup = async (token) => {
  // A PLAIN EQUALITY MATCH against 0034's unique partial index. Unlike the short link there is no
  // check value to fall back on — this token's entire security is that it was minted at full width
  // (lib/sms/preferences-token.ts). `looksLikePreferencesToken` is not applied here: the caller
  // already rejects impossible shapes, and re-testing would only change WHICH lookup misses.
  //
  // NO `phone_number IS NOT NULL` CLAUSE, deliberately. A purged-but-not-deleted row still has a
  // token, and a subscriber who kept the link should still get an honest "you have unsubscribed
  // and your details are gone" page rather than a dead end. The row's own `status` says what to
  // render; the query does not pre-judge it.
  const rows = await query<{
    id: string;
    status: ConsentStatus;
    stopped_at: Date | null;
    postal_code: string | null;
    birth_years: number[] | null;
    category_interests: string[] | null;
    consecutive_empty_weeks: number;
    short_ref: string | number | null;
  }>(
    `SELECT id, status, stopped_at, postal_code, birth_years, category_interests,
            consecutive_empty_weeks, short_ref
       FROM sms_consent
      WHERE preferences_token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    stoppedAt: row.stopped_at,
    postalCode: row.postal_code,
    birthYears: row.birth_years,
    categoryInterests: row.category_interests,
    consecutiveEmptyWeeks: row.consecutive_empty_weeks,
    shortRef: row.short_ref == null ? null : Number(row.short_ref),
  };
};

/**
 * The subscriber's most recent weekly attempt, for the "last week's picks" panel. STUB.
 *
 * TODO:
 *   SELECT send_type, picks_snapshot, created_at
 *     FROM sms_send_log
 *    WHERE subscriber_id = $1
 *      AND send_type IN ('weekly','empty_week','pause_notice')
 *    ORDER BY created_at DESC
 *    LIMIT 1
 *
 * …then, for a 'weekly' row, ONE more read to turn the snapshot into linkable picks:
 *
 *   SELECT id, short_ref FROM activity_occurrence
 *    WHERE id = ANY($1::uuid[]) AND archived_at IS NULL
 *
 * WHY THE SECOND READ EXISTS. `picks_snapshot` stores `[{occurrence_id, rank}]` and nothing else
 * (0035), but a hub link has to be minted from the occurrence's `short_ref` (0037) — so it is
 * joined for. `LEFT`-join semantics, effectively: a pick whose occurrence has since been archived
 * comes back with `occurrenceShortRef: null` and degrades to an unattributed link rather than
 * dropping out of the panel. The snapshot is the record of what we SENT, and it must still list a
 * pick that has since been cancelled.
 *
 * `= ANY($1)` over a handful of ids on the primary key — one probe per pick, at most ten.
 *
 * ALL THREE SEND TYPES, not just 'weekly' — PRD §2.4 asks for the empty and paused states too, and
 * they are the states a subscriber most needs explained. A parent whose last text said "nothing
 * this week" should land here and see that reflected, not a blank panel that reads like a bug.
 *
 * Uses `idx_sms_send_log_subscriber (subscriber_id, created_at DESC)` from 0035 — the third
 * consumer of that index, after the novelty window and the click-through's send-log recovery.
 */
export type LastWeekLookup = (subscriberId: string) => Promise<LastWeek>;

export const findLastWeek: LastWeekLookup = async (subscriberId) => {
  const rows = await query<{
    send_type: LastWeekKind;
    picks_snapshot: Array<{ occurrence_id: string; rank: number }> | null;
    created_at: Date;
  }>(
    // ALL THREE SEND TYPES, not just 'weekly' — PRD §2.4 asks for the empty and paused states too,
    // and they are the states a subscriber most needs explained. A parent whose last text said
    // "nothing this week" should land here and see that reflected, not a blank panel reading as a
    // bug. Uses idx_sms_send_log_subscriber (subscriber_id, created_at DESC) from 0035.
    `SELECT send_type, picks_snapshot, created_at
       FROM sms_send_log
      WHERE subscriber_id = $1
        AND send_type IN ('weekly','empty_week','pause_notice')
      ORDER BY created_at DESC
      LIMIT 1`,
    [subscriberId]
  );
  const row = rows[0];
  if (!row) return { kind: 'none', picks: [], sentAt: null };

  const snapshot = row.picks_snapshot ?? [];
  if (snapshot.length === 0) {
    return { kind: row.send_type, picks: [], sentAt: row.created_at };
  }

  // ── The second read: the snapshot holds ids, a hub link needs short_refs ──
  // `picks_snapshot` stores [{occurrence_id, rank}] and nothing else (0035), but a hub link is
  // minted from the occurrence's short_ref (0037). LEFT-JOIN SEMANTICS BY CONSTRUCTION: a pick
  // whose occurrence has since been archived simply does not come back from this query, and its
  // `occurrenceShortRef` stays null — so it keeps its place in the panel and degrades to an
  // unattributed link. The snapshot is the record of what we SENT, and it must still list a pick
  // that has since been cancelled.
  const ids = snapshot.map((p) => p.occurrence_id).filter((id) => typeof id === 'string');
  const refRows = ids.length
    ? await query<{ id: string; short_ref: string | number }>(
        `SELECT id, short_ref FROM activity_occurrence
          WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [ids]
      )
    : [];
  const refs = new Map(refRows.map((r) => [r.id, Number(r.short_ref)]));

  return {
    kind: row.send_type,
    // Rank order, because the panel reads top to bottom the way the text did.
    picks: [...snapshot]
      .filter((p) => p && typeof p.occurrence_id === 'string')
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((p) => ({
        occurrenceId: p.occurrence_id,
        rank: p.rank,
        occurrenceShortRef: refs.get(p.occurrence_id) ?? null,
      })),
    sentAt: row.created_at,
  };
};

/** One decided write against `sms_consent`. */
export type PreferencesChange =
  | {
      kind: 'save';
      subscriberId: string;
      postalCode: string;
      birthYears: number[];
      categoryInterests: string[];
      /** Always 0 — a save is a fresh start (PRD §2.4). */
      consecutiveEmptyWeeks: 0;
      /** 'active' when un-pausing, otherwise the status is left exactly as it was. */
      status: ConsentStatus | null;
    }
  | { kind: 'unsubscribe'; subscriberId: string; stoppedAt: 'set' | 'leave' }
  | { kind: 'delete'; subscriberId: string };

export type PreferencesWriter = (change: PreferencesChange, now: Date) => Promise<void>;

/**
 * Apply a decided change. STUB.
 *
 * TODO — three statements, one per `kind`:
 *
 *   save:
 *     UPDATE sms_consent
 *        SET postal_code = $2, birth_years = $3, category_interests = $4,
 *            consecutive_empty_weeks = 0
 *          , status = 'active'            -- ONLY when change.status is set; see decideSave
 *      WHERE id = $1
 *
 *   unsubscribe:
 *     UPDATE sms_consent
 *        SET status = 'stopped', stopped_at = COALESCE(stopped_at, now())
 *      WHERE id = $1
 *     (COALESCE, never a bare now() — re-stamping would push the 30-day purge deadline out. Same
 *      rule as the carrier-STOP mirror; see `decideWebUnsubscribe`.)
 *
 *   delete:
 *     UPDATE sms_consent
 *        SET status = 'stopped', stopped_at = COALESCE(stopped_at, now()),
 *            phone_number = NULL, postal_code = NULL, birth_years = NULL,
 *            category_interests = NULL
 *      WHERE id = $1
 *     (The row SURVIVES with its id, short_ref and consent metadata — that is what keeps
 *      sms_send_log's FK and the CASL audit trail intact. See `decideDelete`.)
 */
export const applyPreferencesChange: PreferencesWriter = async (change, now) => {
  if (change.kind === 'save') {
    // `status = 'active'` ONLY when the decision asked for it (un-pausing). Otherwise the status
    // is left exactly as it was — a save must not resurrect a stopped subscriber.
    const sets = [
      'postal_code = $2',
      'birth_years = $3',
      'category_interests = $4',
      'consecutive_empty_weeks = 0',
    ];
    const params: unknown[] = [
      change.subscriberId,
      change.postalCode,
      change.birthYears,
      change.categoryInterests,
    ];
    if (change.status) sets.push('status = $' + (params.push(change.status) + 0));
    await query(`UPDATE sms_consent SET ${sets.join(', ')} WHERE id = $1`, params);
    return;
  }

  if (change.kind === 'unsubscribe') {
    // COALESCE, never a bare now(): re-stamping would push the 30-day purge deadline out. Same
    // rule as the carrier-STOP mirror. `stoppedAt: 'leave'` means they were already stopped, so
    // the COALESCE is doing the work either way — but the decision still says which it intended.
    await query(
      `UPDATE sms_consent
          SET status = 'stopped', stopped_at = COALESCE(stopped_at, $2)
        WHERE id = $1`,
      [change.subscriberId, now]
    );
    return;
  }

  // ── delete ──
  // THE ROW SURVIVES. Its id, short_ref, consent timestamps and consent_text_version stay, because
  // sms_send_log's FK points at it and the CASL audit trail is the thing that must outlive the
  // personal data. What goes is everything that identifies a person: the number, the postal code,
  // the children's ages, the interests. This is the same shape migration 0034's scheduled purge
  // performs — an explicit request just runs it early (PRD §1.3, Operator-approved).
  await query(
    `UPDATE sms_consent
        SET status = 'stopped',
            stopped_at = COALESCE(stopped_at, $2),
            phone_number = NULL,
            postal_code = NULL,
            birth_years = NULL,
            category_interests = NULL
      WHERE id = $1`,
    [change.subscriberId, now]
  );
};

// ── Reading ─────────────────────────────────────────────────────────────────────────────

/** What the page renders. Deliberately contains no phone number and no internal id. */
export interface PreferencesView {
  status: ConsentStatus;
  postalCode: string | null;
  /** Ages recomputed from stored birth years, so what they see matches what the picker used. */
  childAges: number[];
  categoryInterests: string[];
  consecutiveEmptyWeeks: number;
  lastWeek: LastWeekView;
  /** True once the 30-day purge has run: the row exists, the personal columns do not. */
  purged: boolean;
}

export type PreferencesResolution =
  | { outcome: 'found'; subscriberId: string; view: PreferencesView }
  /** Never existed, deleted, or malformed. ONE outcome — see point 3 in the header. */
  | { outcome: 'not_found' };

/**
 * Turn last week's picks into hub links that a tap can actually be attributed to.
 *
 * ═══ WHY THIS EXISTS: THE HUB WAS LINKING PAST ITS OWN INSTRUMENTATION ═══
 * The panel linked straight to `/activity/{id}`, bypassing the short-link route entirely. Two
 * consequences, both real:
 *   1. `sms_click_event.link_origin = 'hub'` could NEVER be written — PRD §6's MVP metric splits
 *      click-through by exactly that column, and the hub bucket was empty by construction. The
 *      question "does the hub page earn its keep" was unanswerable, permanently.
 *   2. A raw link to a since-ARCHIVED occurrence hits the detail page's bare `notFound()`. Going
 *      through `/s/{token}` means the same tap now lands on the round-9 "activity unavailable"
 *      interstitial instead — on the one page whose entire purpose is being the safe place to
 *      deal with your subscription.
 *
 * ═══ IT DEGRADES TO THE OLD LINK RATHER THAN TO NO LINK ═══
 * Three things can stop a token being minted, and none of them may cost a parent the pick:
 *   • the subscriber row has no `short_ref` (a row read before 0037's backfill);
 *   • the occurrence has no live row to take a `short_ref` from — archived since the send;
 *   • `SMS_SHORT_LINK_SECRET` is unset, which is `encodeShortLink`'s documented throw.
 * Each falls back to `activityPath`, and `attributed: false` says so, so an unattributed panel is
 * visible in a test rather than showing up as a permanently flat metric months later.
 */
export function hubPickLinks(
  subscriberShortRef: number | null,
  picks: readonly PreferencesPick[]
): PreferencesViewPick[] {
  return picks.map((pick) => {
    const unattributed = {
      occurrenceId: pick.occurrenceId,
      rank: pick.rank,
      href: activityPath(pick.occurrenceId),
      attributed: false,
    };
    if (subscriberShortRef == null || pick.occurrenceShortRef == null) return unattributed;
    try {
      return {
        occurrenceId: pick.occurrenceId,
        rank: pick.rank,
        href: hubClickPath(encodeShortLink(pick.occurrenceShortRef, subscriberShortRef)),
        attributed: true,
      };
    } catch {
      // A missing secret or an out-of-range ref. `encodeShortLink` throws rather than truncating,
      // deliberately — a truncated ref would point at the WRONG activity — so the honest fallback
      // is the unattributed link, not a guessed token.
      return unattributed;
    }
  });
}

/** Ages to display, recomputed from the stored birth years at render time (PRD §1.2). */
export function childAgesFrom(birthYears: number[] | null, now: Date): number[] {
  // Delegates to the conversion that lives beside its own inverse in signup-validate.ts. This used
  // to be a second implementation reading the local year a different way (Intl directly rather
  // than localIsoDate) — two ways of asking what year it is in Vancouver, which is one more than
  // is safe on December 31st.
  return agesFromBirthYears(birthYears, now);
}

export interface PreferencesDeps {
  findByToken?: PreferencesLookup;
  findLastWeek?: LastWeekLookup;
  applyChange?: PreferencesWriter;
}

/**
 * Resolve a preferences token to what the page should render. NEVER THROWS.
 *
 * A read failure is reported as `not_found` rather than surfacing as an error, deliberately: this
 * is a public endpoint and the distinction between "no such token" and "the database is down" is
 * information a prober would like and a parent cannot use.
 */
export async function resolvePreferences(
  token: string | null | undefined,
  now: Date,
  deps: PreferencesDeps = {}
): Promise<PreferencesResolution> {
  const find = deps.findByToken ?? findByPreferencesToken;
  const lastWeekOf = deps.findLastWeek ?? findLastWeek;

  // A syntactically impossible token is rejected before it reaches the database — but it produces
  // the SAME outcome as a token that simply is not there, so nothing is learned from the
  // difference.
  if (!token || token.length < 16 || token.length > 256) return { outcome: 'not_found' };

  let row: PreferencesRow | null;
  try {
    row = await find(token);
  } catch {
    return { outcome: 'not_found' };
  }
  if (!row) return { outcome: 'not_found' };

  let lastWeek: LastWeek;
  try {
    lastWeek = await lastWeekOf(row.id);
  } catch {
    // The picks panel is a nicety; the unsubscribe control is not. A failure to load last week
    // must not take the whole page — and therefore the CASL controls — down with it.
    lastWeek = { kind: 'none', picks: [], sentAt: null };
  }

  return {
    outcome: 'found',
    subscriberId: row.id,
    view: {
      status: row.status,
      postalCode: row.postalCode,
      childAges: childAgesFrom(row.birthYears, now),
      categoryInterests: row.categoryInterests ?? [],
      consecutiveEmptyWeeks: row.consecutiveEmptyWeeks,
      // Minted HERE rather than in the page, so `PreferencesView` keeps its stated property of
      // carrying no internal reference: `short_ref` goes in, a finished href comes out.
      lastWeek: { ...lastWeek, picks: hubPickLinks(row.shortRef, lastWeek.picks) },
      purged: row.postalCode == null && row.birthYears == null,
    },
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────

export type PreferencesOutcome =
  | 'applied'
  | 'not_found'
  | 'already_in_state'
  /** The row exists but is in a state this action may not act on. See `decideSave`. */
  | 'not_permitted'
  | 'invalid'
  | 'error';

export interface PreferencesResult {
  outcome: PreferencesOutcome;
  change: PreferencesChange | null;
  error?: string;
  field?: SmsSignupField;
}

/**
 * A save: new postal code, ages and interests, plus the two side effects §2.4 requires.
 *
 * ── THE UN-PAUSE IS THE POINT, AND IT IS ALSO THE RISK ──────────────────────────────────
 * §2.4: "Saving resets the empty-week counter and un-pauses if paused." That is the ONLY way a
 * paused subscriber resumes without signing up again, so it has to work. But "un-pause on save"
 * must not generalise into "any save reactivates", because two other states must never be
 * reactivated by an edit:
 *
 *   STOPPED — they opted out. Silently resurrecting them because they opened an old link and hit
 *             Save would be re-subscribing someone who withdrew consent: the CASL violation this
 *             whole design exists to avoid. `not_permitted`.
 *   PENDING — they never replied JOIN. Activating here would bypass the double opt-in exactly the
 *             way START-on-a-pending-row would (round 5's `awaiting_confirmation` finding). Their
 *             edits are saved, but the status is untouched — they still have to confirm.
 *
 * So `status` on the change is set ONLY for a paused row, and is null (leave alone) otherwise.
 * The counter reset is unconditional for any row that may be saved: a subscriber who just told us
 * where they live and how old their kids are has given us new reason to look, and holding three
 * old strikes against them would pause them on a stale judgement.
 */
export function decideSave(
  row: PreferencesRow | null,
  fields: ProfileFields
): { outcome: PreferencesOutcome; change: PreferencesChange | null } {
  if (!row) return { outcome: 'not_found', change: null };
  if (row.status === 'stopped') return { outcome: 'not_permitted', change: null };

  return {
    outcome: 'applied',
    change: {
      kind: 'save',
      subscriberId: row.id,
      postalCode: fields.postalCode,
      birthYears: fields.birthYears,
      categoryInterests: fields.categoryInterests,
      consecutiveEmptyWeeks: 0,
      // Only a PAUSED row is reactivated. 'pending' keeps its edits and keeps waiting for JOIN.
      status: row.status === 'paused' ? 'active' : null,
    },
  };
}

/**
 * The preferences page's unsubscribe (PRD §2.4, §2.5 path 2).
 *
 * ═══ IS THIS THE SAME TRANSITION AS A STOP TEXT? SAME DESTINATION, DIFFERENT JOURNEY. ═══
 *
 * It REUSES `decideStop` — the same pure decision the carrier mirror uses — because the target
 * state is identical in every column: `status = 'stopped'`, `stopped_at` stamped once and never
 * re-stamped, the 30-day purge clock started. Forking that decision would mean two places that
 * both have to remember not to re-stamp `stopped_at`, and one of them would eventually forget.
 *
 * But it is a SEPARATE ENTRY POINT rather than a call to `mirrorCarrierStop`, because that
 * function's own contract is not true here. Its documentation says, correctly: "Twilio has ALREADY
 * suppressed the number by the time this runs... This write is not what stops the messages."
 * Reading that comment on a web unsubscribe would be actively misleading — here NOTHING has
 * suppressed anything, and OUR WRITE IS THE ENTIRE MECHANISM. The Friday job's
 * `WHERE status = 'active'` is what stops the texts.
 *
 * ── ONE CONSEQUENCE WORTH KNOWING: TWILIO WILL NOT KNOW ─────────────────────────────────
 * A carrier STOP puts the number on Twilio's suppression list, which is a second, independent
 * barrier — even a buggy send job cannot text them. A web unsubscribe has no such backstop: our
 * `status` column is the only thing standing between that person and next Friday. Propagating the
 * opt-out to Twilio's list would restore the belt-and-braces, and it is a real API call this
 * branch cannot make. Flagged in the notes (§ai) rather than assumed.
 *
 * ── AND ONE GAP: THE DATABASE CANNOT SAY WHICH PATH WAS USED ────────────────────────────
 * `sms_consent` has no column recording HOW someone left — `consent_method` records how they
 * joined. So after the fact, a web unsubscribe and a STOP text are indistinguishable in the data.
 * That is fine for operating the product and is a genuine hole for a complaint investigation
 * ("they say they never texted STOP" — correct, they clicked). Also flagged rather than fixed:
 * adding a column is a migration, and this one is not mine to decide.
 */
export function decideWebUnsubscribe(row: PreferencesRow | null): {
  outcome: PreferencesOutcome;
  change: PreferencesChange | null;
} {
  const decision = decideStop(row);
  if (decision.outcome === 'no_such_subscriber') return { outcome: 'not_found', change: null };
  if (decision.outcome === 'already_in_state') {
    // Already stopped. Reporting it rather than writing keeps the purge deadline where it is, and
    // the page can honestly say "you are already unsubscribed" instead of pretending to act.
    return { outcome: 'already_in_state', change: null };
  }
  if (decision.outcome !== 'applied') return { outcome: 'error', change: null };
  return {
    outcome: 'applied',
    change: { kind: 'unsubscribe', subscriberId: decision.subscriberId, stoppedAt: 'set' },
  };
}

/**
 * "Delete my data" — distinct from unsubscribe, and IMMEDIATE.
 *
 * ═══ A DELIBERATE READING OF §1.3, FLAGGED BECAUSE IT GOES BEYOND ITS LITERAL TEXT ═══
 *
 * §1.3 says profile fields are purged "30 days later" on `stopped`, "via STOP **or explicit delete
 * request**", with the grace window justified as protection "in case of accidental unsubscribe".
 * Read literally, pressing "Delete my data" would stop the texts and then keep the data for a
 * month — and tell the person so.
 *
 * That reasoning does not transfer. The grace window guards against an ACCIDENT, and an explicit,
 * confirmed delete request is the one case that is definitionally not accidental. Holding a
 * child's age for thirty days after their parent deliberately asked us to erase it, for our own
 * complaint-resolution convenience, is the weaker position under PIPEDA and the harder one to
 * explain.
 *
 * SO: the accident risk is handled where it belongs — at the interaction, with a two-step
 * confirmation in the UI — and the deletion is immediate. That is a stronger guard than a timer,
 * because it stops the mistake instead of giving you a month to notice it.
 *
 * NOTHING IS LOST BY DOING IT NOW. The row survives with its id, short_ref, consent timestamps and
 * consent_text_version; `sms_send_log` keeps `phone_hash` + `phone_hash_version` and was designed
 * in round 1 precisely so the CASL audit trail outlives the subscriber's personal data. The
 * complaint-resolution capability the grace window was protecting is already protected by that.
 *
 * >>> This is the implementer reading §1.3's INTENT over its letter, and it should be confirmed.
 * >>> Reverting to the literal 30-day behaviour is a one-line change: emit an `unsubscribe` change
 * >>> here instead of a `delete` one, and let the purge job do it.
 */
export function decideDelete(row: PreferencesRow | null): {
  outcome: PreferencesOutcome;
  change: PreferencesChange | null;
} {
  if (!row) return { outcome: 'not_found', change: null };
  // Idempotent: a second delete on an already-purged row is a success with nothing to do, not an
  // error and not a second stopped_at stamp.
  if (row.status === 'stopped' && row.postalCode == null && row.birthYears == null) {
    return { outcome: 'already_in_state', change: null };
  }
  return { outcome: 'applied', change: { kind: 'delete', subscriberId: row.id } };
}

// ── The I/O wrapper ─────────────────────────────────────────────────────────────────────

export type PreferencesAction = 'save' | 'unsubscribe' | 'delete';

export interface PreferencesActionInput {
  token: string | null | undefined;
  action: PreferencesAction;
  /** Raw request body; only read for `save`. */
  body?: Record<string, unknown>;
  now: Date;
}

/**
 * Perform one preferences action. NEVER THROWS.
 *
 * Every path that cannot identify the subscriber returns the SAME `not_found`, whatever the
 * reason — no token, malformed token, unknown token, read failure. See header point 3.
 */
export async function performPreferencesAction(
  input: PreferencesActionInput,
  deps: PreferencesDeps = {}
): Promise<PreferencesResult> {
  const find = deps.findByToken ?? findByPreferencesToken;
  const write = deps.applyChange ?? applyPreferencesChange;

  if (!input.token || input.token.length < 16 || input.token.length > 256) {
    return { outcome: 'not_found', change: null };
  }

  let row: PreferencesRow | null;
  try {
    row = await find(input.token);
  } catch {
    return { outcome: 'not_found', change: null };
  }

  // IDENTITY BEFORE INPUT. Established by a test: validating the body first meant an unknown
  // token plus a malformed body answered `invalid`, which is both a confusing thing to tell
  // someone whose link does not work ("that postal code is out of area" — for a subscription that
  // does not exist) and a second code path where an unrecognised caller gets a different reply
  // depending on what they sent. One check, first, for every action.
  if (!row) return { outcome: 'not_found', change: null };

  let decided: { outcome: PreferencesOutcome; change: PreferencesChange | null };
  if (input.action === 'save') {
    // VALIDATED WITH THE SAME PARSER THE SIGNUP FORM USES — not a second copy. A rule that is
    // enforced at signup and not on edit is a rule that does not exist.
    const parsed = parseProfileFields(input.body ?? {}, { now: input.now });
    if (!parsed.ok) {
      return { outcome: 'invalid', change: null, error: parsed.error, field: parsed.field };
    }
    decided = decideSave(row, parsed.value);
  } else if (input.action === 'unsubscribe') {
    decided = decideWebUnsubscribe(row);
  } else {
    decided = decideDelete(row);
  }

  if (decided.outcome !== 'applied' || !decided.change) {
    return { outcome: decided.outcome, change: null };
  }

  try {
    await write(decided.change, input.now);
  } catch {
    // The message never names the subscriber or echoes the token.
    return { outcome: 'error', change: decided.change, error: 'could not save that just now' };
  }

  return { outcome: 'applied', change: decided.change };
}
