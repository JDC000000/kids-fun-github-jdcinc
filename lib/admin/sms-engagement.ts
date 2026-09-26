// lib/admin/sms-engagement.ts — the read model behind /admin/sms-engagement.
//
// Per-subscriber engagement for REAL, phone-verified subscribers: what we sent them, what we
// offered, and what they actually tapped. Jon's framing: "I only want to track real usage as
// connected to a telephone number and events that those people take."
//
// ═══ WHY THIS IS A SEPARATE SURFACE AND NOT A RETROFIT OF /admin/operating ═══
// Those twelve metrics measure WEB product usage — anonymous cookie sessions, most of which is
// machine traffic. That is a different and still-legitimate question. Forcing them to mean
// "subscriber engagement" would lose both. This module answers only the subscriber question, and
// reads only from tables that carry a subscriber_id: sms_send_log, sms_click_event, sms_consent.
//
// ═══ ANONYMOUS WEB BROWSING IS DELIBERATELY ABSENT ═══
// analytics_event's actor is a cookie with no link to a phone number, and building that link
// would reverse a documented privacy decision (app/s/[shortId]: "NOTHING ABOUT THE SUBSCRIBER
// LEAVES THIS ROUTE") and probably exceed the consent's purpose limitation. Explicitly out of
// scope, unbuilt, and not to be added without that decision being made on its own terms.
//
// ═══ EVERY SIDE IS AGGREGATED BEFORE IT IS JOINED ═══
// One subscriber has many sends AND many clicks. Joining sms_send_log to sms_click_event on
// subscriber_id would emit sends x clicks rows per subscriber and need count(DISTINCT ...) to
// compensate — the exact Cartesian shape fixed in lib/analytics/operating.ts's getOpsSeries this
// week. Each side is grouped to one row per subscriber first, then joined.
//
// ═══ NO PHONE NUMBERS ═══
// Same rule as lib/admin/sms-subscribers.ts. short_ref identifies a subscriber here; the FSA
// (first three characters of the postal code) is the coarsest useful location and is as far as
// this module goes.
import { query } from '@/lib/db/client';
import { shouldRedact } from '@/lib/admin/personal-data';

export interface SmsEngagementRow {
  subscriberId: string;
  /** 0034's database-issued compact alias. Safe to display; a phone number is not. */
  shortRef: string;
  isTest: boolean;
  /** Forward sortation area only — never the full postal code. Null once purged, or when redacted. */
  fsa: string | null;
  /** True when the caller may not see personal data; `fsa` is then NULL regardless of the row. */
  redacted: boolean;
  status: string;
  /** Weekly messages recorded in sms_send_log, all outcomes. */
  sends: number;
  /** Sends Twilio later confirmed as delivered. */
  delivered: number;
  /** Sends that failed or were rejected — the honest denominator problem, surfaced not hidden. */
  failed: number;
  /** Total picks offered across every send, from picks_snapshot. */
  picksOffered: number;
  taps: number;
  directTaps: number;
  hubTaps: number;
  /** taps / picksOffered as a percentage, or null when nothing was ever offered. */
  tapRatePct: number | null;
  firstSendAt: string | null;
  lastSendAt: string | null;
}

export interface SmsEngagementSummary {
  subscribers: number;
  sends: number;
  picksOffered: number;
  taps: number;
  tapRatePct: number | null;
}

export interface SmsEngagementOptions {
  /**
   * Include rows marked is_test. DEFAULTS TO FALSE.
   *
   * A test handset is a real row in every other respect (migration 0042), so with one real
   * subscriber and one test handset an unfiltered dashboard would be half synthetic and say
   * nothing about it. The toggle exists for QA visibility, and defaults to the honest answer.
   */
  includeTest?: boolean;
  /**
   * REQUIRED, no default: whether the caller may see personal data (lib/db/admin-guard.ts
   * canSeePersonalData). A per-subscriber FSA is location data about one household's area, so a
   * read-only 'viewer' gets it NULLed in SQL. Anything other than an explicit `false` redacts.
   */
  redactPersonalData: boolean;
}

/** Percentage to one decimal, or null when the denominator is zero. Never NaN, never Infinity. */
function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export async function getSmsEngagement(
  options: SmsEngagementOptions
): Promise<{ rows: SmsEngagementRow[]; summary: SmsEngagementSummary }> {
  const includeTest = options.includeTest ?? false;
  const redact = shouldRedact(options);

  const rows = await query<{
    subscriber_id: string;
    short_ref: string;
    is_test: boolean;
    fsa: string | null;
    status: string;
    sends: string;
    delivered: string;
    failed: string;
    picks_offered: string;
    taps: string;
    direct_taps: string;
    hub_taps: string;
    first_send_at: string | null;
    last_send_at: string | null;
  }>(
    `
    WITH sends AS (
      SELECT
        subscriber_id,
        count(*)                                              AS sends,
        count(*) FILTER (WHERE delivery_status = 'delivered')  AS delivered,
        -- outcome <> sent counted SUCCESSES as failures: 'empty' is a delivered empty-week
        -- text and 'paused' is a delivered pause notice — both real, both successful, both
        -- permitted by the CHECK constraint alongside 'sent'. Only 'failed' and
        -- 'stopped_via_carrier' are actual failures.
        count(*) FILTER (WHERE outcome IN ('failed', 'stopped_via_carrier')
                            OR delivery_status IN ('failed', 'undelivered')) AS failed,
        -- picks_snapshot is Array<{occurrence_id, rank}> | null; a null snapshot is an
        -- empty-week send, which offered nothing rather than offering an unknown amount.
        coalesce(sum(jsonb_array_length(coalesce(picks_snapshot, '[]'::jsonb))), 0) AS picks_offered,
        min(created_at)                                       AS first_send_at,
        max(created_at)                                       AS last_send_at
      FROM sms_send_log
      -- ═══ ONLY ACTUAL WEEKLY TRAFFIC COUNTS AS A "SEND" ═══
      -- confirm_request and welcome are signup-flow messages, not weekly picks. Counting them
      -- made the dashboard read "5 subscribers · 10 sends · 0 picks offered · 0 taps" after five
      -- test signups and before a single Friday run — which reads as "we sent ten texts and got
      -- nothing back" when in fact no weekly text had been sent at all. Values verified against
      -- the sms_send_log CHECK constraint, which permits exactly:
      --   confirm_request, welcome, weekly, empty_week, pause_notice
      WHERE send_type IN ('weekly', 'empty_week', 'pause_notice')
      GROUP BY subscriber_id
    ),
    taps AS (
      SELECT
        subscriber_id,
        count(*)                                            AS taps,
        count(*) FILTER (WHERE link_origin = 'direct')       AS direct_taps,
        count(*) FILTER (WHERE link_origin = 'hub')          AS hub_taps
      FROM sms_click_event
      GROUP BY subscriber_id
    )
    SELECT
      c.id                              AS subscriber_id,
      c.short_ref::text                 AS short_ref,
      c.is_test,
      CASE WHEN $2::boolean THEN NULL
           ELSE nullif(upper(left(regexp_replace(coalesce(c.postal_code, ''), '\\s', '', 'g'), 3)), '')
      END AS fsa,
      c.status::text                    AS status,
      coalesce(s.sends, 0)::text        AS sends,
      coalesce(s.delivered, 0)::text    AS delivered,
      coalesce(s.failed, 0)::text       AS failed,
      coalesce(s.picks_offered, 0)::text AS picks_offered,
      coalesce(t.taps, 0)::text         AS taps,
      coalesce(t.direct_taps, 0)::text  AS direct_taps,
      coalesce(t.hub_taps, 0)::text     AS hub_taps,
      s.first_send_at::text             AS first_send_at,
      s.last_send_at::text              AS last_send_at
    FROM sms_consent c
    LEFT JOIN sends s ON s.subscriber_id = c.id
    LEFT JOIN taps  t ON t.subscriber_id = c.id
    WHERE ($1::boolean OR c.is_test = false)
    ORDER BY c.consent_timestamp DESC
    `,
    [includeTest, redact]
  );

  const mapped: SmsEngagementRow[] = rows.map((r) => {
    const picksOffered = Number(r.picks_offered);
    const taps = Number(r.taps);
    return {
      subscriberId: r.subscriber_id,
      shortRef: r.short_ref,
      isTest: r.is_test,
      fsa: r.fsa,
      redacted: redact,
      status: r.status,
      sends: Number(r.sends),
      delivered: Number(r.delivered),
      failed: Number(r.failed),
      picksOffered,
      taps,
      directTaps: Number(r.direct_taps),
      hubTaps: Number(r.hub_taps),
      tapRatePct: pct(taps, picksOffered),
      firstSendAt: r.first_send_at,
      lastSendAt: r.last_send_at,
    };
  });

  const totals = mapped.reduce(
    (acc, r) => ({
      sends: acc.sends + r.sends,
      picksOffered: acc.picksOffered + r.picksOffered,
      taps: acc.taps + r.taps,
    }),
    { sends: 0, picksOffered: 0, taps: 0 }
  );

  return {
    rows: mapped,
    summary: {
      subscribers: mapped.length,
      ...totals,
      tapRatePct: pct(totals.taps, totals.picksOffered),
    },
  };
}
