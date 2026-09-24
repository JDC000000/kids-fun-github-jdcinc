// lib/admin/sms-preview.ts — the exact Friday text ONE subscriber would receive, on demand.
//
// Jon, 2026-09-18: "I want to see the SMSs going out to people today to see what the activities
// are." scripts/friday-preview-real-subscribers.ts already answers that from a terminal; this is
// the same answer on the admin subscriber page, for one subscriber at a time.
//
// ═══ IT IS THE SAME THREE CALLS THE SCRIPT MAKES, IN THE SAME ORDER ═══
// loadWeeklySmsDeps() → loadActiveSubscribers() → buildWeeklySms(). Nothing about selection,
// eligibility or rendering is re-expressed here, because the instant any of it is, this stops
// predicting the real job and starts predicting a second implementation that merely resembles it.
// That is also why eligibility is decided by FINDING the subscriber in loadActiveSubscribers()'s
// result rather than by a narrower `WHERE id = $1` written here: that function's WHERE clause is
// the product's live definition of "would be texted on Friday" — status, is_test, the
// `phone_number IS NOT NULL` purge rule, AND the 4-day resend-suppression window. A hand-written
// single-row query would have to restate all four and would silently drift from whichever one
// changed next.
//
// The cost of that faithfulness is loading every active subscriber to render one. At this
// product's size that is a handful of rows behind an admin click, and correctness is worth
// vastly more than the query it saves. If the subscriber base ever makes that untrue, the fix is
// a `limit`/filter pushed INTO loadActiveSubscribers where the real job also benefits — not a
// private query here.
//
// ═══ READ-ONLY, AND NOT MERELY BY INTENTION ═══
// Every function this module reaches is a reader:
//   loadWeeklySmsDeps          SELECTs listings, aliases, region hierarchy, occurrence short_refs
//   loadActiveSubscribers      one SELECT over sms_consent
//   buildWeeklySms             PURE — lib/sms/weekly-send.ts imports no database module at all
// The mutating half of the weekly job — sendWeeklySmsForSubscriber, sendWeeklySmsBulk,
// applyEmptyWeekState, markStoppedViaCarrier, dispatchSms, and the send-log writer — is not
// imported here, and tests/admin/sms-preview-logic.test.ts asserts that mechanically against this
// file's source so a future edit cannot quietly add one. Previewing therefore cannot mark a
// subscriber as sent, cannot advance consecutive_empty_weeks, cannot pause anyone, and cannot
// write a CASL audit row. Same posture as scripts/weekly-picks-diversity-probe.ts: reuse the real
// job's functions, touch none of its writes.
//
// ═══ THE PREFERENCES TOKEN IS REDACTED. IT IS A CREDENTIAL, NOT COPY. ═══
// The rendered body carries this subscriber's no-login hub link; app/u/[preferencesToken] opens
// their child's ages and household postal code with no sign-in. The admin reading this page is
// authorised to see the DATA — but a screenshot of this panel pasted into a chat hands a live
// credential to everyone who can see the paste, and that outlives the gate. So the token is
// masked, exactly as the script masks it, while the /s/ activity links stay real and clickable —
// those are what "see what the activities are" actually means. Segment and character counts are
// computed on the REAL body before masking, so the numbers reviewed are the true ones.
//
// ═══ …BUT A PREVIEW TAP IS NOT A PARENT'S CLICK (2026-09-24) ═══
// Those /s/ links carry the SUBSCRIBER's real tokens, so an admin opening one used to write an
// `sms_click_event` in that parent's name. Every /s/ link in the DISPLAYED body is therefore tagged
// `?via=preview` (markPreviewLinks), which the /s/ route verifies and redirects exactly as before
// but does not count. Applied after masking and after the counts, to the displayed body only —
// nothing that is sent is touched.
import { loadActiveSubscribers, loadWeeklySmsDeps } from '@/lib/sms/weekly-send-io';
import { RESEND_SUPPRESSION_WINDOW_DAYS } from '@/lib/sms/weekly-send-io';
import { buildWeeklySms } from '@/lib/sms/weekly-send';
import { shortLinkSecret } from '@/lib/sms/config';
import type { SmsSendLogRow, SmsSubscriberListRow } from '@/lib/admin/sms-subscribers';
import { markPreviewLinks } from '@/lib/sms/click-through';

export type SmsPreviewResult =
  /**
   * SMS_SHORT_LINK_SECRET is unset, so no link in the body could be minted for real.
   *
   * REFUSED RATHER THAN RENDERED, matching friday-preview-real-subscribers.ts, which has no
   * override for this and says why: a placeholder-minted /s/ link does not 404, it fails its HMAC
   * check and lands on /link-unavailable — a page telling the reader their link is broken. Shown
   * to an Operator about to demo this, that reads as a broken PRODUCT rather than a preview
   * artifact. A misleading preview is worse than an absent one.
   */
  | { status: 'secret_missing' }
  /** Not in this Friday's send set. `reason` says which of the job's conditions excluded them. */
  | { status: 'not_eligible'; reason: string }
  /** Eligible, but the builder produced nothing to send (today: only `geocode_failed`). */
  | { status: 'no_message'; outcome: string }
  | {
      status: 'ok';
      /**
       * The body as it would arrive, with the preferences token masked and every /s/ link tagged
       * `?via=preview` so that opening it from the admin page is not counted as the parent's click.
       */
      body: string;
      /** Counts measured on the UNMASKED body — the real ones. */
      segments: number;
      characters: number;
      outcome: string;
      areaLabel: string | null;
      pickCount: number;
      /** True when a live preferences token was found and masked out of `body`. */
      tokenRedacted: boolean;
    };

/**
 * Why a subscriber is not in this Friday's send set, in the same order
 * `loadActiveSubscribers` excludes them, so the answer matches the reason.
 *
 * Derived from rows the detail page has ALREADY loaded rather than by re-querying: the caller
 * holds the consent row and the send history, which between them cover every condition in that
 * WHERE clause. Stated as the narrowest true sentence — an admin reading "not eligible" with no
 * reason will go looking for a bug that is not there.
 */
export function ineligibilityReason(
  row: Pick<SmsSubscriberListRow, 'status' | 'isTest' | 'purged'>,
  sends: readonly Pick<SmsSendLogRow, 'sendType' | 'createdAt'>[],
  now: Date
): string {
  if (row.purged) {
    return 'their personal data was erased by the 30-day retention purge, so there is nobody left to text';
  }
  if (row.status !== 'active') {
    return `their status is "${row.status}", and only active subscribers are sent to`;
  }
  if (row.isTest) {
    return 'they are marked as a test handset, which the weekly job excludes';
  }
  const cutoffMs = now.getTime() - RESEND_SUPPRESSION_WINDOW_DAYS * 86_400_000;
  const recent = sends.some(
    (s) =>
      s.sendType === 'weekly' &&
      s.createdAt !== null &&
      Number.isFinite(new Date(s.createdAt).getTime()) &&
      new Date(s.createdAt).getTime() > cutoffMs
  );
  if (recent) {
    return `they were already sent a weekly text within the last ${RESEND_SUPPRESSION_WINDOW_DAYS} days, so the resend guard is holding them back`;
  }
  return 'the weekly job did not include them in this run’s active set';
}

/**
 * Mask a subscriber's preferences token wherever it appears in a message body.
 *
 * Replaced with a run of '#' OF THE SAME LENGTH, not a short label: the segment and character
 * counts shown beside the body describe the real message, and a mask of a different length would
 * make the body on screen wrap differently from the one that gets delivered.
 */
export function redactPreferencesToken(body: string, token: string | null | undefined): string {
  if (!token) return body;
  return body.split(token).join('#'.repeat(token.length));
}

/** One run of a displayed preview body: plain text, or a (preview-tagged) link. */
export interface PreviewBodyPart {
  text: string;
  /** Present only for an http(s) /s/ link that ALREADY carries `?via=preview`. */
  href?: string;
}

/** An absolute http(s) short link that has been tagged by markPreviewLinks — nothing else. */
const TAGGED_PREVIEW_LINK = /(https?:\/\/[^\s/]+(?:\/[^\s]*)?\/s\/[0-9A-Za-z]+\?via=preview)/g;

/**
 * Split a DISPLAYED preview body into text and clickable links, for the admin page.
 *
 * Only links that are http(s), are /s/ short links, and ALREADY carry `?via=preview` become
 * anchors. An untagged link can therefore never be made clickable here: the one way to click
 * through from the preview is the way that is not counted as the parent's tap.
 */
export function splitPreviewLinks(body: string): PreviewBodyPart[] {
  const parts: PreviewBodyPart[] = [];
  let last = 0;
  for (const m of body.matchAll(TAGGED_PREVIEW_LINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: body.slice(last, at) });
    parts.push({ text: m[0], href: m[0] });
    last = at + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** The exact weekly text this subscriber would receive, or why they would receive none. */
export async function previewWeeklySmsForSubscriber(
  subscriberId: string,
  now: Date
): Promise<SmsPreviewResult> {
  if (!shortLinkSecret()) return { status: 'secret_missing' };

  const [deps, actives] = await Promise.all([loadWeeklySmsDeps(), loadActiveSubscribers()]);
  const active = actives.find((a) => a.subscriber.id === subscriberId);
  // `reason` is filled in by the caller via ineligibilityReason(); this module cannot see the
  // consent row, and inventing a vaguer sentence here would just have to be overwritten.
  if (!active) return { status: 'not_eligible', reason: '' };

  // `subscriber` ONLY. `active.phoneNumber` is deliberately never read, never logged, never
  // rendered — the number travels BESIDE the subscriber precisely so this is a visible choice.
  const { subscriber } = active;
  const plan = buildWeeklySms({
    engine: deps.engine,
    now,
    occurrenceShortRefs: deps.occurrenceShortRefs,
    subscriber,
  });

  if (!plan.message) return { status: 'no_message', outcome: plan.outcome };

  const token = subscriber.preferencesToken;
  const masked = redactPreferencesToken(plan.message.body, token);
  const body = markPreviewLinks(masked);
  return {
    status: 'ok',
    body,
    segments: plan.message.segments,
    characters: plan.message.characters,
    outcome: plan.outcome,
    areaLabel: plan.areaLabel,
    pickCount: plan.picks?.picks.length ?? 0,
    tokenRedacted: Boolean(token) && masked !== plan.message.body,
  };
}
