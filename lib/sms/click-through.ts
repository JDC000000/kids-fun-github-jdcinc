// lib/sms/click-through.ts — resolve a tapped weekly short link, and count the tap.
//
// DRAFT (SMS pivot). The other half of PRD §2.3: lib/sms/short-link.ts MINTS the token,
// lib/sms/weekly-send.ts puts it in the message, and this decides where a tap goes and whether it
// counted. Route-free and framework-free so the whole decision table is testable without a
// request; app/s/[shortId]/route.ts is the thin transport over it.
//
// Three database reads and one write, all REAL as of Stage D (migrations 0034-0037 applied by the
// Operator). Each remains an injectable seam, so the whole decision table below is still testable
// without a database; tests/sms/click_through-db.test.ts exercises the seams themselves.
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

import { query } from '@/lib/db/client';
import { decodeShortLink } from './short-link';

/**
 * Where a tap goes when the token itself does not verify — malformed, tampered, wrong length, bad
 * checksum. Generic on purpose: we do not know what they were trying to reach, and the destination
 * still says nothing about WHICH way the token failed.
 *
 * ═══ THIS WAS '/search' UNTIL 2026-09-11, AND THAT WAS A SILENT DEAD END ═══
 * The old comment here called /search "the honest 'go find something to do' answer". It was honest
 * about the TOKEN and silent about everything else: a parent who tapped a link in a text landed on
 * an unfiltered results page with no heading, no explanation and no sign that anything had gone
 * wrong. A mobile audit walked /s/badcode and reported it as a blank page — which is the same
 * verdict round 9 reached about sending the `occurrence_gone` outcome to /search, for the same
 * reason, and fixed there and not here. This closes the other half.
 *
 * WHY IT MATTERS MORE THAN THE OUTCOME'S SHARE OF TRAFFIC SUGGESTS. The short link is how a beta
 * parent FIRST opens this product — there is no app, no bookmark and no account, so the text
 * message is the front door. `invalid_token` is also not a rare, adversarial outcome: it is what a
 * messaging app truncating a link produces, what a link scanner rewriting one produces, and what
 * copy-pasting a link into another app produces. The failure mode was "first impression is a blank
 * page", not "a prober sees a blank page".
 *
 * ═══ DOES A THIRD DESTINATION WIDEN THE ORACLE? NO — IT IS THE SAME TWO-WAY SPLIT ═══
 * Worth stating explicitly, because GONE_DESTINATION's comment below spends a long section
 * accepting an oracle and this looks like it enlarges it. It does not:
 *   • BEFORE: invalid → /search, gone → /activity-unavailable. Two destinations, distinguishable.
 *   • AFTER:  invalid → /link-unavailable, gone → /activity-unavailable. Two destinations, equally
 *     distinguishable, and not one bit more.
 * The observable partition of the outcome space is UNCHANGED. Only the copy on one side of it
 * changed. In particular the property round 6 actually protected is untouched: `decodeShortLink`
 * still returns null for malformed AND for checksum-failed, both still resolve to `invalid_token`,
 * and both still land here — so there is still no "warmer/colder" signal inside the space of
 * failing tokens, and a prober still cannot tell they were one character away.
 *
 * WHAT THE PAGE MAY NOT SAY, AND WHY THE COPY IS CAREFUL ABOUT IT. "This link has expired" is the
 * obvious sentence and it is FALSE: these tokens carry no timestamp and no validity window (see
 * lib/sms/short-link.ts — 76 bits, all of them spent on two short_refs and a check), so nothing
 * about them can expire. See LINK_UNAVAILABLE_BODY in consent-copy.ts for the wording and for why
 * inventing an expiry would repeat exactly the mistake GONE_DESTINATION refuses when it declines
 * to tell a parent whose link was mangled that an activity was cancelled.
 *
 * IT STILL CARRIES NOTHING — no token, no short_ref, no query string, same as GONE_DESTINATION.
 * The page itself offers the onward step to /search that the old redirect performed silently, so
 * nobody loses the "go find something to do" answer; they now get told why they are being offered
 * it. Kept as a CONSTANT, and still the single source of this path, so the route, the tests and
 * the preview scripts cannot drift apart.
 */
export const FALLBACK_DESTINATION = '/link-unavailable';

/**
 * Where a tap goes when the token VERIFIED but the activity has since been archived (PRD §8 Q3,
 * Jon-approved 2026-08-26). Round 6 kept `occurrence_gone` as a distinct outcome precisely so this
 * would be a one-line change when the copy existed; it now is.
 *
 * ═══ DOES SPLITTING THE DESTINATIONS REOPEN ROUND 6'S ENUMERATION CONCERN? ═══
 * Partly yes, and it is worth being exact about which part, because the answer is not "no".
 *
 * WHAT ROUND 6 PROTECTED, AND STILL DOES. The concern was distinguishing MALFORMED from
 * CHECKSUM-FAILED — telling a prober they were one character away and turning a 20-bit check into
 * a guided search. That distinction is UNCHANGED: `decodeShortLink` returns null for both, both
 * are `invalid_token`, both land on FALLBACK_DESTINATION. There is still no "warmer/colder" signal
 * inside the space of failing tokens. (That destination stopped being /search on 2026-09-11 and
 * became a page that explains itself; the two failing halves still cannot be told apart, which is
 * the only part this section was ever about.)
 *
 * WHAT IS NEWLY VISIBLE. A prober can now tell "my token PASSED the HMAC but named no live
 * activity" from "my token did not pass". That is a validity ORACLE that did not exist before, and
 * it is a real change rather than a technicality.
 *
 * WHY IT IS ACCEPTABLE, stated so the tradeoff is on the record rather than assumed:
 *   • IT DOES NOT COMPOUND. The check is an HMAC over each payload independently, so learning that
 *     one forged token verified reveals nothing about the secret and does not make the next
 *     forgery cheaper. The oracle answers one question, once, per attempt — it does not narrow
 *     the search space the way a "you were close" signal would.
 *   • THE ATTEMPT RATE IS THE REAL BOUND, and it is unchanged. ~1 in 2^20 random tokens verify,
 *     and this only tells them which ones did — something they could already infer from a
 *     successful redirect whenever the short_ref happened to be live.
 *   • THE PRIZE IS SMALL. A verified forgery reaches public catalogue data (or this page) and can
 *     write one bogus `sms_click_event`. It cannot read a subscriber, mutate anything, or reach
 *     the preferences page, which is a different token entirely.
 *
 * WHAT THE ALTERNATIVES COST, since "keep them identical" was available:
 *   • Send BOTH here. A parent whose link was mangled by their messaging app would be told an
 *     activity was CANCELLED when nothing was — inventing a fact to protect a 20-bit check. This
 *     project does not trade honesty for that.
 *   • Send both to /search, i.e. round 6's status quo. That is what Jon's ruling changed — and
 *     /search stopped being either outcome's destination on 2026-09-11, so this alternative no
 *     longer exists to return to.
 * So: the oracle is accepted, deliberately, and named here so nobody has to rediscover it.
 *
 * THE REDIRECT CARRIES NOTHING — no occurrence id, no short_ref, no query string. This URL lands
 * in browser history like any other, and it must not record WHICH activity was gone for WHOM.
 */
export const GONE_DESTINATION = '/activity-unavailable';

/** The canonical activity detail path. */
export function activityPath(occurrenceId: string): string {
  return `/activity/${occurrenceId}`;
}

/**
 * Which surface a tap came from (`sms_click_event.link_origin`, migration 0036).
 *
 * 'direct' — the link was in the text message itself and pointed straight at the activity.
 * 'hub'    — the link was on the preferences/hub page's "last week's picks" list (PRD §2.4).
 *
 * 0036's own comment says why it is recorded at click time: it "is not derivable after the fact
 * from anything else on the row, and it is the only way to answer whether the hub page earns its
 * keep." PRD §6 splits the MVP click-through metric on exactly this column.
 */
export type LinkOrigin = 'direct' | 'hub';

/**
 * How a hub-page link declares itself: `/s/{token}?via=hub`.
 *
 * ═══ WHY A QUERY PARAMETER AND NOT THE TOKEN ═══
 * The token is (occurrence short_ref, subscriber short_ref) plus a 20-bit check — 76 bits with no
 * room, and widening it would undo the shortening the whole design exists for. Worse, it would
 * make the SAME (occurrence, subscriber) pair mint TWO different tokens depending on where the
 * link was going, breaking the determinism that lets a link stay valid across sends.
 *
 * ═══ IT IS SPOOFABLE, AND THE BLAST RADIUS IS ONE COLUMN OF ONE ANALYTICS ROW ═══
 * Anyone can append `?via=hub` to a link they were texted. What that changes:
 *   • `sms_click_event.link_origin` on the row that tap writes. That is the entire effect.
 * What it cannot change, because the token is a separate, independently verified path segment and
 * the query string is not part of the signed payload:
 *   • whether the token verifies, so a forgery is no more likely to be honoured;
 *   • which occurrence or subscriber it resolves to, so attribution stays correct;
 *   • the redirect destination;
 *   • whether a click row is written at all — that still needs a live occurrence, a live
 *     subscriber row and a recoverable send log, none of which this touches.
 * It reaches no consent state, no PII, and not the preferences token, which is a different token
 * on a different route. The only party who can do it at scale is somebody who already holds valid
 * tokens — a subscriber, skewing a statistic about themselves, with nothing to gain.
 *
 * The honest residual: PRD §6's direct-vs-hub split informs a V1 build/don't-build decision about
 * the hub page, so sustained deliberate spoofing could in principle nudge it. That requires effort
 * by someone holding valid tokens to influence a decision they cannot see. Named, not defended
 * against.
 *
 * ═══ THE PART THAT IS NOT MERELY COSMETIC: THE VALUE IS MAPPED, NEVER PASSED THROUGH ═══
 * `parseLinkOrigin` maps an untrusted string onto the union and defaults everything else to
 * 'direct'. If the raw parameter were handed to the INSERT instead, a junk value would violate
 * 0036's `CHECK (link_origin IN ('direct','hub'))` and kill the click write — silently, since the
 * recorder's failure is swallowed by design. Mapping makes that unreachable.
 */
export const LINK_ORIGIN_PARAM = 'via';

/**
 * The permitted values, as a SET rather than an object literal.
 *
 * ── THIS WAS WRITTEN AS AN OBJECT FIRST, AND THE OBJECT WAS WRONG ───────────────────────
 * `const VALUES: Record<string, LinkOrigin> = { hub: 'hub', direct: 'direct' }` followed by
 * `VALUES[raw]` reads correctly and is not: an object literal inherits from `Object.prototype`,
 * so `VALUES['constructor']` is the `Object` FUNCTION and `VALUES['__proto__']` is the prototype.
 * `?via=constructor` on this public, unauthenticated route therefore returned a function where the
 * type says `LinkOrigin`, which would then have been bound into the `sms_click_event` insert
 * against a NOT NULL CHECK-constrained column — defeating the exact "mapped, never passed through"
 * guarantee documented above, in the one implementation of it that does not hold.
 * Caught by tests/sms/click_through.test.tsx, which lists those keys in its junk set on purpose.
 *
 * A Set has no such inherited keys. Anything not literally in it is 'direct'.
 */
const LINK_ORIGINS: ReadonlySet<string> = new Set<LinkOrigin>(['direct', 'hub']);

/** Map an untrusted query value onto the union. Anything unrecognised is 'direct'. */
export function parseLinkOrigin(raw: string | null | undefined): LinkOrigin {
  return raw && LINK_ORIGINS.has(raw) ? (raw as LinkOrigin) : 'direct';
}

/**
 * The hub page's link to one pick: an app-relative `/s/{token}?via=hub`.
 *
 * RELATIVE, not absolute, for the same reason app/s/[shortId]/route.ts resolves its redirect
 * against the request's own origin rather than NEXT_PUBLIC_SITE_URL: a parent may be on a preview
 * or staging host, and an absolute link would bounce them to production mid-tap and lose the click.
 * `shortLinkUrl()` stays the absolute minter for links that go INTO a text message, where there is
 * no request origin to inherit.
 */
export function hubClickPath(token: string): string {
  return `/s/${token}?${LINK_ORIGIN_PARAM}=hub`;
}

// ── ADMIN PREVIEW TAPS ARE NOT CLICKS (2026-09-24) ───────────────────────────────────────
//
// /admin/sms-subscribers/[id]?preview=1 renders the exact Friday text a subscriber would receive,
// and its /s/ links are that SUBSCRIBER's real tokens. Before this, an admin who opened one of those
// links to check the activity wrote an `sms_click_event` attributed to the subscriber — inventing
// engagement the parent never had, in the very table PRD §6's click-through metric is computed from.
//
// The fix marks every link in a preview body with `?via=preview` (previewClickUrl, applied by
// lib/admin/sms-preview.ts), and the /s/ route, on seeing that marker, still verifies the token and
// still redirects to the same place — but COUNTS NOTHING: no `sms_click_event`, and not even the
// subscriber/send-log reads that exist only to build one.
//
// ═══ 'preview' IS DELIBERATELY NOT A LinkOrigin ═══
// LinkOrigin is the value WRITTEN to `sms_click_event.link_origin` (CHECK 'direct' | 'hub'). A
// preview tap writes no row, so it has no origin; making 'preview' a member of the union would
// invite a future edit to record it, and 0036's CHECK would then silently eat the click. It is a
// separate, boolean decision: isPreviewTap().
//
// ═══ SPOOFABLE, AND THE BLAST RADIUS IS "THE TAPPER'S OWN CLICK IS NOT COUNTED" ═══
// Anyone can append `?via=preview` to a link. What that changes, exhaustively:
//   • no `sms_click_event` row for THAT request — an undercount of one tap on that token;
//   • a 60-second cookie, scoped to that one activity's path on THAT browser, which makes the
//     activity page skip its own `listing_viewed` for that browser (see PREVIEW_HOP_COOKIE).
// What it cannot change — same argument as `?via=hub` above, because the query string is not part
// of the signed payload: whether the token verifies, which occurrence it resolves to, the redirect
// destination (no query string survives into Location), or anything about any other request,
// browser or subscriber. It writes nothing and reads no subscriber data. The only party who could
// use it to skew a metric is someone holding valid tokens, and the only skew available is to make
// their own taps disappear. Pinned by tests/sms/click_through_preview.test.ts.

/** The `?via=` value that marks a tap from an admin preview. EXACT match only (case-sensitive). */
export const PREVIEW_VIA_VALUE = 'preview';

/** Is this request an admin-preview tap? Only the exact value counts; everything else is a real tap. */
export function isPreviewTap(raw: string | null | undefined): boolean {
  return raw === PREVIEW_VIA_VALUE;
}

/**
 * Tag every /s/ short link in a message body as a preview tap: `…/s/{token}` → `…/s/{token}?via=preview`.
 *
 * Applied ONLY to the admin preview's DISPLAYED body (lib/admin/sms-preview.ts), after the counts
 * have been measured on the real body — never to anything that is sent. Matches the path shape
 * shortLinkUrl() mints (`/s/` + base62), so it is indifferent to which origin minted the link.
 */
export function markPreviewLinks(body: string): string {
  return body.replace(/(\/s\/[0-9A-Za-z]+)(?![0-9A-Za-z?])/g, `$1?${LINK_ORIGIN_PARAM}=${PREVIEW_VIA_VALUE}`);
}

/**
 * The cookie a preview tap leaves so the activity page it lands on skips its own `listing_viewed`.
 *
 * WHY A COOKIE AND NOT A QUERY PARAMETER ON THE REDIRECT: the Location header must stay free of
 * any tagging (see the route) — and a `?via=preview` on /activity/{id} would be a SHAREABLE switch
 * that suppressed analytics for every visitor who followed a pasted link. A cookie can only ever
 * affect the browser that made the preview tap. It is scoped to the one destination path, lives 60
 * seconds, is HttpOnly and carries no data but '1'.
 */
export const PREVIEW_HOP_COOKIE = 'kf_preview_hop';
export const PREVIEW_HOP_COOKIE_MAX_AGE_S = 60;

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
   * Which surface the tap came from. Was hardcoded to `'direct'` in round 6, with a comment
   * saying the hub page "does not exist yet — so this is a constant here rather than a parameter,
   * and the day the hub page lands it passes its own value." The hub page landed in round 8 and
   * nothing came back for it, which meant PRD §6's direct-vs-hub split could never show a single
   * hub click. It is now the parameter that comment promised.
   */
  linkOrigin: LinkOrigin;
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

export interface ClickThroughOptions extends ClickThroughDeps {
  /**
   * Which surface this tap came from. Defaults to 'direct', which is both the common case and the
   * safe one: a hub link that lost its parameter is recorded as what it certainly is — a real tap
   * — under the origin that under-counts the hub rather than inventing credit for it.
   */
  linkOrigin?: LinkOrigin;
  /**
   * Whether to count this tap at all. Defaults to TRUE — every real tap is counted. FALSE only for
   * an admin-preview tap (isPreviewTap): the token is still verified and the redirect is identical,
   * but no subscriber or send-log is looked up and no `sms_click_event` is written.
   */
  countClick?: boolean;
}

// ── The reads and the write ─────────────────────────────────────────────────────────────

/**
 * `activity_occurrence.short_ref` → `id`.
 *
 * `archived_at IS NULL` is the load-bearing clause. Catalogue rows are soft-deleted, and a link
 * minted three weeks ago can easily point at something since archived — a cancelled session, a
 * source that stopped publishing. Without it we would redirect a parent to a detail page for an
 * activity that is not happening, which is worse than telling them it is gone.
 *
 * A MISS IS AN EXPECTED OUTCOME, NOT AN ERROR. It is what `occurrence_gone` exists for.
 *
 * PLAN: `idx_activity_occurrence_short_ref` (0037) is UNIQUE and non-partial, so this is one index
 * probe followed by a recheck of `archived_at` on the single candidate row.
 */
export const findOccurrenceIdByShortRef: OccurrenceShortRefLookup = async (shortRef) => {
  const rows = await query<{ id: string }>(
    `SELECT id FROM activity_occurrence WHERE short_ref = $1::bigint AND archived_at IS NULL`,
    [shortRef]
  );
  return rows[0]?.id ?? null;
};

/**
 * `sms_consent.short_ref` → `id`.
 *
 * NO `phone_number IS NOT NULL` HERE, unlike the weekly job's loader — and the difference
 * matters. `short_ref` and `id` survive the 30-day purge (it NULLs only the personal columns), so
 * a purged subscriber's old links still attribute correctly, which is exactly what we want: the
 * click is a fact about a message we sent, and it stays countable after their data goes.
 * A miss here means the row was DELETED — the 90-day never-confirmed purge.
 *
 * NO STATUS PREDICATE EITHER, for the same reason. Somebody who has since paused or texted STOP
 * can still tap a link in a message we sent them while they were active, and that tap is a real
 * click on a real send. Filtering by status would silently under-count engagement at exactly the
 * moment we most want to see it.
 *
 * THE SELECT LIST IS ONE COLUMN, deliberately. This row holds a phone number, a postal code and
 * children's birth years; the caller needs an id to write an analytics row and nothing else, so
 * nothing else is read. Same posture as `findSubscriberByPhone` in consent-transitions.ts.
 */
export const findSubscriberIdByShortRef: SubscriberShortRefLookup = async (shortRef) => {
  const rows = await query<{ id: string }>(
    `SELECT id FROM sms_consent WHERE short_ref = $1::bigint`,
    [shortRef]
  );
  return rows[0]?.id ?? null;
};

/**
 * Which send did this tap come from?
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
 * ═══ TWO REDUNDANT-LOOKING PREDICATES, AND ONLY ONE OF THEM IS REALLY REDUNDANT ═══
 * Worth separating, because "the schema guarantees it" and "the current writer happens to do it"
 * are very different kinds of safe:
 *
 *   `send_type = 'weekly'` IS SCHEMA-GUARANTEED. 0035's CHECK `sms_send_log_picks_only_weekly`
 *   says `picks_snapshot IS NULL OR send_type = 'weekly'`, and a row that satisfies the
 *   containment test below necessarily has a non-null snapshot. Kept for legibility only.
 *
 *   `outcome = 'sent'` IS NOT. The schema permits a weekly row with a picks snapshot and ANY
 *   outcome; what actually prevents one today is a WRITER-SIDE invariant in another module —
 *   weekly-send-io.ts passes `picksSnapshot: null` on both its 'failed' and 'stopped_via_carrier'
 *   branches. That invariant is entirely reasonable and entirely unenforced, and if it ever
 *   changed (snapshotting what we WOULD have sent is a plausible future want) this query would
 *   start attributing clicks to messages that were never delivered — and `ORDER BY created_at
 *   DESC` means the undelivered row would WIN over the successful earlier send carrying the same
 *   activity. That is silent CTR corruption in both directions: a phantom click on a failed send,
 *   a missing one on a real send. One predicate closes it. It is not redundancy, it is refusing
 *   to depend on a distant module's discipline for a correctness property.
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
export const findSendLogIdForClick: SendLogLookup = async (subscriberId, occurrenceId) => {
  const rows = await query<{ id: string }>(
    `SELECT id
       FROM sms_send_log
      WHERE subscriber_id = $1
        AND send_type = 'weekly'
        AND outcome = 'sent'
        AND picks_snapshot @> $2::jsonb
      ORDER BY created_at DESC
      LIMIT 1`,
    // `[{"occurrence_id": "<uuid>"}]` — jsonb array containment, which asks "does some element of
    // picks_snapshot contain this object". It matches the writer's `[{occurrence_id, rank}]`
    // elements without naming `rank`, so it does not care what rank the pick held.
    [subscriberId, JSON.stringify([{ occurrence_id: occurrenceId }])]
  );
  return rows[0]?.id ?? null;
};

/**
 * Append one `sms_click_event`.
 *
 * `link_origin` IS A BOUND PARAMETER, NOT AN INTERPOLATED STRING, and it arrives already mapped
 * onto the `LinkOrigin` union — see `parseLinkOrigin`. 0036's CHECK constrains this column, so a
 * raw query-string value reaching here would fail the insert, and this recorder's failures are
 * swallowed by design: the click would vanish with no error anywhere.
 *
 * NO DEDUPLICATION, DELIBERATELY, and migration 0036 says so in its own comment: there is no
 * unique index on (send_log_id, occurrence_id) because a parent tapping the same pick twice is two
 * taps. Collapsing them would turn a click LOG into a click FLAG. Any dedup a report wants is a
 * COUNT(DISTINCT ...) at read time, where the choice is visible.
 *
 * NOTHING IS REDACTED FROM ERRORS HERE, unlike signup-store.ts — and that is a decision, not an
 * omission. Every parameter on this path is a uuid or a two-value enum; the phone number, postal
 * code and birth years never come near it, which is why `findSubscriberIdByShortRef` reads one
 * column. There is nothing for a driver error to leak. (In practice nothing sees these errors at
 * all — `resolveClickThrough` swallows them so the redirect still happens.)
 *
 * Written by the service pool — `sms_click_event` is default-deny RLS (0036), and the tapping
 * subscriber is not signed in and never touches the table directly.
 */
export const recordClick: ClickRecorder = async (event) => {
  await query(
    `INSERT INTO sms_click_event (subscriber_id, send_log_id, occurrence_id, link_origin)
     VALUES ($1, $2, $3, $4)`,
    [event.subscriberId, event.sendLogId, event.occurrenceId, event.linkOrigin]
  );
};

// ── The resolution ──────────────────────────────────────────────────────────────────────

/**
 * Decide where a tapped short link goes, and count the tap if it can be counted.
 *
 * NEVER THROWS. This is a public, unauthenticated endpoint reached from a text message; the worst
 * a garbage path segment may do is send someone to a static interstitial that explains that their
 * link did not work (FALLBACK_DESTINATION) — no body, no stack trace, no echo of the input.
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
  options: ClickThroughOptions = {}
): Promise<ClickResolution> {
  const findOccurrence = options.findOccurrenceIdByShortRef ?? findOccurrenceIdByShortRef;
  const findSubscriber = options.findSubscriberIdByShortRef ?? findSubscriberIdByShortRef;
  const findSendLog = options.findSendLogIdForClick ?? findSendLogIdForClick;
  const record = options.recordClick ?? recordClick;
  const linkOrigin = options.linkOrigin ?? 'direct';

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
    // A read failure is not the parent's problem, and it is NOT evidence the activity is gone —
    // but we have nowhere to send them either, so it takes the same branch. Worth knowing: this
    // means a database outage tells a handful of parents an activity was cancelled when it was
    // not. The alternative is a bare error page, which is worse for them and no more truthful
    // about what happened. Flagged in the round-9 notes rather than hidden.
    occurrenceId = null;
  }
  if (!occurrenceId) {
    return {
      outcome: 'occurrence_gone',
      destination: GONE_DESTINATION,
      occurrenceId: null,
      clickLogged: false,
    };
  }

  // 3. Count the tap. BEST-EFFORT: everything below is wrapped, and nothing it does can change
  //    where the parent ends up. Skipped entirely for an admin-preview tap (countClick: false) —
  //    not even the subscriber lookup runs, because it exists only to build the row.
  let clickLogged = false;
  if (options.countClick !== false) {
    try {
      const subscriberId = await findSubscriber(refs.subscriberShortRef);
      if (subscriberId) {
        const sendLogId = await findSendLog(subscriberId, occurrenceId);
        if (sendLogId) {
          await record({ subscriberId, sendLogId, occurrenceId, linkOrigin });
          clickLogged = true;
        }
      }
    } catch {
      // Swallowed on purpose. See the header: the redirect never depends on the logging.
      clickLogged = false;
    }
  }

  return {
    outcome: 'redirect',
    destination: activityPath(occurrenceId),
    occurrenceId,
    clickLogged,
  };
}
