// lib/sms/click-through.ts — resolve a tapped weekly short link, and count the tap.
//
// DRAFT (SMS pivot). The other half of PRD §2.3: lib/sms/short-link.ts MINTS the token,
// lib/sms/weekly-send.ts puts it in the message, and this decides where a tap goes and whether it
// counted. Route-free and framework-free so the whole decision table is testable without a
// request; app/s/[shortId]/route.ts is the thin transport over it.
//
// Three database reads, all stubbed here (`sms_consent`, `sms_send_log` and `activity_occurrence`
// are unapplied SQL on this branch), each carrying the exact query it will issue — same posture as
// every I/O boundary on this branch.
//
// ── THE REDIRECT NEVER DEPENDS ON THE LOGGING ───────────────────────────────────────────
// A parent tapped a link because they want to see an activity. Whether our analytics write
// succeeds is our problem, not theirs, so every logging failure is swallowed and the redirect
// happens anyway — the posture `recordListingView` already takes on the detail pages.
//
// ── THE FINDING THIS FILE SURFACED: THE TOKEN CANNOT SATISFY sms_click_event ALONE ──────
// The token carries (occurrence short_ref, subscriber short_ref) — 76 bits, and there is no room
// for more. But `sms_click_event` (migration 0036) requires `send_log_id uuid NOT NULL`, and
// nothing in the token identifies which send the tap came from. So the send row has to be
// RECOVERED, by finding the subscriber's most recent weekly send whose `picks_snapshot` contains
// this occurrence. See `findSendLogIdForClick` for the query and for why the existing index makes
// it cheap. Two alternatives were rejected — see that function.

import { decodeShortLink } from './short-link';

/**
 * Where a tap goes when we cannot send it to the activity it named.
 *
 * `/search` for both failure modes, DELIBERATELY THE SAME DESTINATION for now, and flagged as
 * this round's open question:
 *
 *   THERE IS NO "THIS ACTIVITY IS NO LONGER LISTED" EXPERIENCE ON THIS SITE TODAY. I checked
 *   before choosing: `/activity/[id]` and `/preview/[id]` both call `notFound()` for a missing id,
 *   and there is no `app/not-found.tsx` anywhere in the tree — so a missing activity currently
 *   gets Next's bare default 404. There is no pattern here to reuse, and inventing a page is a
 *   product/copy decision rather than an implementation one, so it is raised rather than taken.
 *
 * The two reasons are kept as separate `ClickOutcome` values even though they resolve to the same
 * path, so giving the "gone" case its own destination later is a one-line change here and needs no
 * change in the route.
 */
export const FALLBACK_DESTINATION = '/search';

/** The canonical activity detail path. */
export function activityPath(occurrenceId: string): string {
  return `/activity/${occurrenceId}`;
}

export type ClickOutcome =
  /** Token verified, occurrence live — go to the activity. */
  | 'redirect'
  /** Malformed, tampered, wrong-length or bad-checksum token. Indistinguishable on purpose. */
  | 'invalid_token'
  /** Token verified, but no live occurrence carries that short_ref any more. */
  | 'occurrence_gone';

export interface ClickResolution {
  outcome: ClickOutcome;
  /** An app-relative path. The route makes it absolute against the request's own origin. */
  destination: string;
  /** The resolved occurrence, when there was one. */
  occurrenceId: string | null;
  /**
   * Whether an `sms_click_event` row was written.
   *
   * FALSE IS NORMAL AND NOT AN ERROR. See `resolveClickThrough` for the four ways a genuine tap
   * legitimately goes uncounted.
   */
  clickLogged: boolean;
}

/** One `sms_click_event` row (migration 0036). */
export interface SmsClickEvent {
  subscriberId: string;
  sendLogId: string;
  occurrenceId: string;
  /**
   * ALWAYS 'direct' from this route. The hub page (`/u/[preferencesToken]`, PRD §2.4) is where
   * `'hub'` clicks come from, and that route does not exist yet — so this is a constant here
   * rather than a parameter, and the day the hub page lands it passes its own value.
   */
  linkOrigin: 'direct';
}

/** `activity_occurrence.short_ref` → `id`, or null when no LIVE row carries it. */
export type OccurrenceShortRefLookup = (shortRef: number) => Promise<string | null>;
/** `sms_consent.short_ref` → `id`, or null when the row has been deleted. */
export type SubscriberShortRefLookup = (shortRef: number) => Promise<string | null>;
/** Which send produced this click, or null when it cannot be recovered. */
export type SendLogLookup = (subscriberId: string, occurrenceId: string) => Promise<string | null>;
/** Append one `sms_click_event`. */
export type ClickRecorder = (event: SmsClickEvent) => Promise<void>;

export interface ClickThroughDeps {
  findOccurrenceIdByShortRef?: OccurrenceShortRefLookup;
  findSubscriberIdByShortRef?: SubscriberShortRefLookup;
  findSendLogIdForClick?: SendLogLookup;
  recordClick?: ClickRecorder;
}

// ── The stubbed reads ───────────────────────────────────────────────────────────────────

/**
 * `activity_occurrence.short_ref` → `id`. STUB.
 *
 * TODO:
 *   SELECT id FROM activity_occurrence WHERE short_ref = $1 AND archived_at IS NULL
 *
 * `archived_at IS NULL` is the load-bearing clause. Catalogue rows are soft-deleted, and a link
 * minted three weeks ago can easily point at something since archived — a cancelled session, a
 * source that stopped publishing. Without it we would redirect a parent to a detail page for an
 * activity that is not happening, which is worse than telling them it is gone.
 *
 * A MISS IS AN EXPECTED OUTCOME, NOT AN ERROR. It is what `occurrence_gone` exists for. The
 * unique index from migration 0037 makes this a single index probe.
 */
export const findOccurrenceIdByShortRef: OccurrenceShortRefLookup = async () => null;

/**
 * `sms_consent.short_ref` → `id`. STUB.
 *
 * TODO:
 *   SELECT id FROM sms_consent WHERE short_ref = $1
 *
 * NO `phone_number IS NOT NULL` HERE, unlike the weekly job's loader — and the difference
 * matters. `short_ref` and `id` survive the 30-day purge (it NULLs only the personal columns), so
 * a purged subscriber's old links still attribute correctly, which is exactly what we want: the
 * click is a fact about a message we sent, and it stays countable after their data goes.
 * A miss here means the row was DELETED — the 90-day never-confirmed purge.
 */
export const findSubscriberIdByShortRef: SubscriberShortRefLookup = async () => null;

/**
 * Which send did this tap come from? STUB.
 *
 * TODO:
 *   SELECT id FROM sms_send_log
 *    WHERE subscriber_id = $1
 *      AND send_type = 'weekly'
 *      AND picks_snapshot @> $2::jsonb        -- [{"occurrence_id": "<uuid>"}]
 *    ORDER BY created_at DESC
 *    LIMIT 1
 *
 * ═══ WHY THIS QUERY EXISTS AT ALL — A REAL GAP BETWEEN THE TOKEN AND THE SCHEMA ═══
 * `sms_click_event.send_log_id` is `uuid NOT NULL` (migration 0036), but the token carries only
 * (occurrence short_ref, subscriber short_ref). Nothing in it says which SEND the tap came from,
 * so the send row has to be recovered rather than read.
 *
 * TWO ALTERNATIVES, BOTH REJECTED:
 *   • Widen the token to carry a send-log reference. It is already 76 bits / 13 characters, and a
 *     24-bit third field pushes it to ~100 bits ≈ 17 characters — undoing the shortening the whole
 *     design exists for, on every link in every message, to serve a lookup that happens only on
 *     the small fraction of links that are actually tapped.
 *   • Make `send_log_id` nullable. That is the column tying a click to the message that caused it;
 *     nullable, it stops being able to answer "which send produced this click", which is the only
 *     question CTR asks.
 * Recovering it is the cheap option and it costs nothing on the send side.
 *
 * PERFORMANCE — CHECKED, AND NO NEW INDEX IS NEEDED. This looks like it wants a GIN index on
 * `picks_snapshot`, and it does not: the query is SUBSCRIBER-SCOPED, and
 * `idx_sms_send_log_subscriber (subscriber_id, created_at DESC)` already exists (0035). One
 * subscriber accumulates ~52 weekly rows a year, so Postgres takes their rows from that btree in
 * date order and filters — the containment test runs over a few dozen rows, not the table.
 *
 * ORDER BY created_at DESC because a recurring weekly activity can legitimately appear in several
 * sends; the most recent one is the send the parent is holding in their phone.
 *
 * A MISS IS POSSIBLE AND IS NOT AN ERROR: dry-run sends write no log row at all, and a
 * pre-`picks_snapshot` row would not match. The tap still redirects; it just goes uncounted.
 */
export const findSendLogIdForClick: SendLogLookup = async () => null;

/**
 * Append one `sms_click_event`. STUB.
 *
 * TODO:
 *   INSERT INTO sms_click_event (subscriber_id, send_log_id, occurrence_id, link_origin)
 *   VALUES ($1, $2, $3, 'direct')
 *
 * NO DEDUPLICATION, DELIBERATELY, and migration 0036 says so in its own comment: there is no
 * unique index on (send_log_id, occurrence_id) because a parent tapping the same pick twice is two
 * taps. Collapsing them would turn a click LOG into a click FLAG. Any dedup a report wants is a
 * COUNT(DISTINCT ...) at read time, where the choice is visible.
 *
 * Written by the service pool — `sms_click_event` is default-deny RLS (0036), and the tapping
 * subscriber is not signed in and never touches the table directly.
 */
export const recordClick: ClickRecorder = async () => {};

// ── The resolution ──────────────────────────────────────────────────────────────────────

/**
 * Decide where a tapped short link goes, and count the tap if it can be counted.
 *
 * NEVER THROWS. This is a public, unauthenticated endpoint reached from a text message; the worst
 * a garbage path segment may do is send someone to /search.
 *
 * ── FAILING CLOSED, AND WHY BOTH FAILURES LOOK IDENTICAL ────────────────────────────────
 * A malformed token and a token whose HMAC check fails resolve to exactly the same
 * `invalid_token` outcome and the same destination. `decodeShortLink` already refuses to
 * distinguish them (it returns null for both), and this preserves that: an endpoint that answered
 * differently for "not base62" and "checksum wrong" would confirm to a prober when they were one
 * character away, turning a 20-bit check into a guided search.
 *
 * ── FOUR WAYS A GENUINE TAP GOES UNCOUNTED, ALL NORMAL ──────────────────────────────────
 *   1. The occurrence has been archived  → `occurrence_gone`. `sms_click_event.occurrence_id` is
 *      NOT NULL and FK-constrained to a live row, so there is literally no row to write. This is a
 *      SCHEMA FACT, not a policy choice: the insert would fail.
 *   2. The subscriber row was deleted    → the 90-day never-confirmed purge.
 *   3. No matching send log              → a dry-run send writes no log row.
 *   4. The insert itself failed          → swallowed; the parent still gets their activity.
 * In all four the redirect is unaffected. `clickLogged: false` reports it honestly rather than
 * pretending.
 *
 * CTR CONSEQUENCE, STATED SO IT IS NOT DISCOVERED LATER: case 1 means taps on since-archived
 * activities never appear in the numerator of `sms_click_event / sms_send_log sent`. That is
 * arguably correct — a tap that reached no content is not a click-THROUGH — but it does mean CTR
 * is measured against links that still resolve, and a week with heavy archiving will read low.
 */
export async function resolveClickThrough(
  token: string | null | undefined,
  deps: ClickThroughDeps = {}
): Promise<ClickResolution> {
  const findOccurrence = deps.findOccurrenceIdByShortRef ?? findOccurrenceIdByShortRef;
  const findSubscriber = deps.findSubscriberIdByShortRef ?? findSubscriberIdByShortRef;
  const findSendLog = deps.findSendLogIdForClick ?? findSendLogIdForClick;
  const record = deps.recordClick ?? recordClick;

  // 1. Verify. Malformed and tampered are one outcome — see the header.
  let refs: ReturnType<typeof decodeShortLink>;
  try {
    refs = decodeShortLink(token);
  } catch {
    // decodeShortLink is documented never to throw, but this route is public and unauthenticated:
    // a defect there must not become a 500 here.
    refs = null;
  }
  if (!refs) {
    return {
      outcome: 'invalid_token',
      destination: FALLBACK_DESTINATION,
      occurrenceId: null,
      clickLogged: false,
    };
  }

  // 2. Resolve the activity. A miss is expected — links outlive listings.
  let occurrenceId: string | null;
  try {
    occurrenceId = await findOccurrence(refs.occurrenceShortRef);
  } catch {
    // A read failure is not the parent's problem, and it is not evidence the activity is gone —
    // but we have nowhere to send them either, so it degrades to the same honest fallback.
    occurrenceId = null;
  }
  if (!occurrenceId) {
    return {
      outcome: 'occurrence_gone',
      destination: FALLBACK_DESTINATION,
      occurrenceId: null,
      clickLogged: false,
    };
  }

  // 3. Count the tap. BEST-EFFORT: everything below is wrapped, and nothing it does can change
  //    where the parent ends up.
  let clickLogged = false;
  try {
    const subscriberId = await findSubscriber(refs.subscriberShortRef);
    if (subscriberId) {
      const sendLogId = await findSendLog(subscriberId, occurrenceId);
      if (sendLogId) {
        await record({ subscriberId, sendLogId, occurrenceId, linkOrigin: 'direct' });
        clickLogged = true;
      }
    }
  } catch {
    // Swallowed on purpose. See the header: the redirect never depends on the logging.
    clickLogged = false;
  }

  return {
    outcome: 'redirect',
    destination: activityPath(occurrenceId),
    occurrenceId,
    clickLogged,
  };
}
